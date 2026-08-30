import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendDiagnosticLog, readDiagnosticLogs } from "../electron/diagnostic-log.mjs";
import {
  createRuntimeHealthDiagnosticTracker,
  safeHealthEndpoint
} from "../electron/runtime-health-diagnostic.mjs";

assert.equal(
  safeHealthEndpoint("https://user:pass@example.test/mcp?codexpro_token=secret#fragment"),
  "https://example.test/healthz",
  "diagnostic endpoints must never retain credentials, query tokens, or fragments"
);
assert.equal(safeHealthEndpoint("file:///secret"), "");

const tracker = createRuntimeHealthDiagnosticTracker({ repeatFailureMs: 30_000, repeatSlowMs: 60_000 });
const base = {
  target: "local",
  label: "Local MCP",
  base: "http://127.0.0.1:8793?token=secret",
  healthCycleId: "health_cycle_fixture",
  processes: [{ pid: 101, name: "node.exe" }, { ProcessId: 202, Name: "cloudflared.exe" }],
  slowMs: 1_000
};

assert.equal(tracker.observe({ ...base, observedAt: 1_000, result: { ok: true, status: 200, latency: 20 } }), null);

const offline = tracker.observe({
  ...base,
  observedAt: 2_000,
  result: {
    ok: false,
    status: 0,
    latency: 5_507,
    timeout_ms: 5_500,
    timed_out: true,
    error_name: "TimeoutError",
    error_code: "23",
    error: "The operation was aborted due to timeout"
  }
});
assert.equal(offline.level, "warn");
assert.equal(offline.category, "health");
assert.equal(offline.details.action, "health-probe-offline");
assert.equal(offline.details.health_cycle_id, "health_cycle_fixture");
assert.equal(offline.details.endpoint, "http://127.0.0.1:8793/healthz");
assert.equal(offline.details.timed_out, true);
assert.deepEqual(offline.details.process_ids, [101, 202]);

const diagnosticRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-health-diagnostic-"));
try {
  await appendDiagnosticLog(diagnosticRoot, { ...offline, action: offline.details.action });
  const persisted = await readDiagnosticLogs(diagnosticRoot, { hours: 24, category: "health" });
  assert.equal(persisted.entries.length, 1, "health incidents must be persisted in the Manager diagnostic log");
  assert.equal(persisted.entries[0].action, "health-probe-offline");
  assert.equal(persisted.entries[0].details.health_cycle_id, "health_cycle_fixture");
  assert.equal(persisted.entries[0].details.endpoint, "http://127.0.0.1:8793/healthz");
  assert.ok(!JSON.stringify(persisted).includes("secret"), "persisted health logs must not leak endpoint credentials");
} finally {
  await fs.rm(diagnosticRoot, { recursive: true, force: true });
}

assert.equal(
  tracker.observe({ ...base, observedAt: 10_000, result: { ok: false, latency: 5_500, timed_out: true } }),
  null,
  "repeat failures inside the throttle window should not flood the log"
);

const persistent = tracker.observe({ ...base, observedAt: 32_100, result: { ok: false, latency: 5_500, timed_out: true } });
assert.equal(persistent.details.action, "health-probe-still-offline");

const recovered = tracker.observe({ ...base, observedAt: 33_000, result: { ok: true, status: 200, latency: 42 } });
assert.equal(recovered.level, "info");
assert.equal(recovered.details.action, "health-probe-recovered");
assert.equal(recovered.details.previous_ok, false);

const slow = tracker.observe({ ...base, observedAt: 100_000, result: { ok: true, status: 200, latency: 1_400 } });
assert.equal(slow.details.action, "health-probe-slow");
assert.equal(slow.details.latency_ms, 1_400);

assert.equal(
  tracker.observe({ ...base, target: "tunnel", configured: false, observedAt: 101_000, result: { ok: false } }),
  null,
  "an intentionally disabled tunnel is not a health incident"
);

console.log("✓ runtime health diagnostic transition/redaction smoke test passed");
