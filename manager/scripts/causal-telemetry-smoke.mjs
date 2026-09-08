import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import { createMcpCausalTelemetry } from "../electron/mcp-causal-telemetry.mjs";

const managerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let now = 1_000;
const mcp = createMcpCausalTelemetry({ now: () => now });
const freshness = mcp.begin("runtime_freshness_list_profiles", { runtime_freshness_iteration_id: "rf-1" });
assert.equal(mcp.counters().MCP_INITIALIZE_IN_FLIGHT, 1);
assert.equal(mcp.counters().MCP_SESSIONS_IN_FLIGHT, 1);
assert.deepEqual(mcp.counters().MCP_SESSIONS_IN_FLIGHT_BY_CALLER, { runtime_freshness_list_profiles: 1 });
const response = mcp.begin("get_profile_response", { response_read_id: "rr-1" });
assert.equal(mcp.counters().MCP_INITIALIZE_IN_FLIGHT, 2);
assert.equal(mcp.counters().MCP_SESSIONS_IN_FLIGHT, 2);
assert.equal(mcp.snapshot(response).response_read_id, "rr-1");
assert.equal(mcp.snapshot(freshness).runtime_freshness_iteration_id, "rf-1");
now += 25;
mcp.markInitialized(freshness);
assert.equal(mcp.counters().MCP_INITIALIZE_IN_FLIGHT, 1);
assert.equal(mcp.counters().MCP_SESSIONS_IN_FLIGHT, 2);
now += 25;
mcp.markToolCompleted(freshness);
mcp.markCloseStarted(freshness);
now += 25;
mcp.markCloseCompleted(freshness);
assert.equal(mcp.counters().MCP_SESSIONS_IN_FLIGHT, 1);
assert.deepEqual(mcp.counters().MCP_SESSIONS_IN_FLIGHT_BY_CALLER, { get_profile_response: 1 });
now += 25;
mcp.markCloseCompleted(response);
assert.equal(mcp.counters().MCP_INITIALIZE_IN_FLIGHT, 0);
assert.equal(mcp.counters().MCP_SESSIONS_IN_FLIGHT, 0);
assert.deepEqual(mcp.counters().MCP_SESSIONS_IN_FLIGHT_BY_CALLER, {});

const vite = await createServer({
  root: managerDir,
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true }
});
try {
  const sessionModule = await vite.ssrLoadModule("/src/hooks/use-chat-session.js");
  let canonicalNow = 10_000;
  const events = [];
  let release;
  const coordinator = sessionModule.createCanonicalResponseReadCoordinator({ now: () => canonicalNow, maxCooldownMs: 60_000 });
  const read = () => new Promise((resolve) => { release = resolve; });
  const first = coordinator.run("profile-a:conversation-a", read, {
    canonical_attempt_id: "ca-1",
    profile_id: "profile-a",
    conversation_id: "conversation-a",
    trigger: "generating",
    onEvent: (event) => events.push(event)
  });
  const overlap = coordinator.run("profile-a:conversation-a", read, {
    canonical_attempt_id: "ca-2",
    profile_id: "profile-a",
    conversation_id: "conversation-a",
    trigger: "generating",
    onEvent: (event) => events.push(event)
  });
  assert.equal(first, overlap, "telemetry must not change canonical in-flight coalescing");
  assert.equal(events.at(-1)?.canonical_attempt_id, "ca-2");
  assert.equal(events.at(-1)?.coalesced, true);
  await Promise.resolve();
  release({ canonical_rate_limited: true, canonical_retry_after_ms: 5_000, text: "rate" });
  await first;
  const rateEvent = events.find((event) => event.canonical_attempt_id === "ca-1");
  assert.equal(rateEvent?.http_status, 429);
  assert.equal(rateEvent?.backoff_remaining_ms, 5_000);
  assert.equal(rateEvent?.response_bytes, 4);

  const deferred = await coordinator.run("profile-a:conversation-a", async () => ({ canonical_available: true, text: "should-not-run" }), {
    canonical_attempt_id: "ca-3",
    profile_id: "profile-a",
    conversation_id: "conversation-a",
    trigger: "network_recovery",
    onEvent: (event) => events.push(event)
  });
  assert.equal(deferred.canonical_poll_deferred, true, "telemetry must not change canonical cooldown semantics");
  const deferredEvent = events.find((event) => event.canonical_attempt_id === "ca-3");
  assert.equal(deferredEvent?.http_status, 429);
  assert.equal(deferredEvent?.backoff_remaining_ms, 5_000);

  canonicalNow += 5_000;
  const resumed = await coordinator.run("profile-a:conversation-a", async () => ({ canonical_available: true, text: "hello" }), {
    canonical_attempt_id: "ca-4",
    profile_id: "profile-a",
    conversation_id: "conversation-a",
    trigger: "completion",
    onEvent: (event) => events.push(event)
  });
  assert.equal(resumed.canonical_available, true);
  const resumedEvent = events.find((event) => event.canonical_attempt_id === "ca-4");
  assert.equal(resumedEvent?.http_status, 200);
  assert.equal(resumedEvent?.response_bytes, 5);
  assert.equal(resumedEvent?.coalesced, false);
} finally {
  await vite.close();
}

const mainSource = fs.readFileSync(path.join(managerDir, "electron", "main.mjs"), "utf8");
for (const caller of [
  "runtime_freshness_list_profiles",
  "runtime_freshness_worker_history",
  "get_profile_response",
  "status_list_profiles",
  "status_worker_history"
]) {
  assert.ok(mainSource.includes(`caller: "${caller}"`), `missing MCP causal caller tag: ${caller}`);
}
assert.match(mainSource, /runtimeFreshnessIterationId[\s\S]*runtime_freshness_list_profiles[\s\S]*runtimeFreshnessIterationId[\s\S]*runtime_freshness_worker_history[\s\S]*runtimeFreshnessIterationId/);
assert.match(mainSource, /caller: "get_profile_response"[\s\S]*response_read_id: String\(payload\?\.responseReadId \|\| ""\)/);

const diagnosticSource = fs.readFileSync(path.join(managerDir, "electron", "diagnostic-log.mjs"), "utf8");
assert.match(diagnosticSource, /pending_records:[\s\S]*pending_bytes:[\s\S]*oldest_pending_age_ms:/);
assert.match(diagnosticSource, /enqueuedAtMs: Date\.now\(\)/);

console.log("causal telemetry smoke: ok");
