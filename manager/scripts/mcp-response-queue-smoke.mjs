import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMcpResponseQueue } from "../electron/mcp-response-queue.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

const events = [];
const queue = createMcpResponseQueue({
  maxConcurrent: 2,
  maxBackgroundConcurrent: 1,
  onEvent: (event) => events.push(event)
});

let duplicateExecutions = 0;
const duplicateGate = deferred();
const duplicateFirst = queue.run("profile-a:chat-a:canonical", async () => {
  duplicateExecutions += 1;
  return duplicateGate.promise;
}, { priority: "background" });
const duplicateSecond = queue.run("profile-a:chat-a:canonical", async () => {
  duplicateExecutions += 1;
  return "must-not-run";
}, { priority: "interactive" });
assert.strictEqual(duplicateFirst, duplicateSecond, "duplicate response reads must share the exact same promise");
await flush();
assert.equal(duplicateExecutions, 1, "duplicate response reads must execute only once");

const interactiveGate = deferred();
const startOrder = [];
const interactiveFirst = queue.run("profile-b:chat-b:canonical", async () => {
  startOrder.push("interactive-first");
  return interactiveGate.promise;
}, { priority: "interactive" });
await flush();
assert.deepEqual(startOrder, ["interactive-first"], "interactive work should use the reserved foreground slot immediately");

const backgroundQueued = queue.run("profile-c:chat-c:canonical", async () => {
  startOrder.push("background-queued");
  return "background-result";
}, { priority: "background" });
const interactiveQueued = queue.run("profile-d:chat-d:canonical", async () => {
  startOrder.push("interactive-queued");
  return "interactive-result";
}, { priority: "interactive" });
await flush();
assert.deepEqual(startOrder, ["interactive-first"], "no third request may bypass the global concurrency cap");

interactiveGate.resolve("interactive-first-result");
assert.equal(await interactiveFirst, "interactive-first-result");
await flush();
assert.deepEqual(startOrder, ["interactive-first", "interactive-queued"], "queued interactive work must run before background polling");

duplicateGate.resolve("shared-result");
assert.equal(await duplicateFirst, "shared-result");
assert.equal(await duplicateSecond, "shared-result");
assert.equal(await interactiveQueued, "interactive-result");
await flush();
assert.equal(await backgroundQueued, "background-result");
assert.equal(queue.snapshot().active, 0, "queue must release every active slot after completion");
assert.equal(queue.snapshot().queued, 0, "queue must drain every pending request");
assert.ok(events.some((event) => event.type === "coalesced" && event.requested_priority === "interactive"), "queue telemetry must record duplicate coalescing and foreground demand");
assert.ok(events.every((event) => (event.active ?? 0) <= 2), "queue telemetry must prove the global cap");
assert.ok(events.every((event) => (event.backgroundActive ?? 0) <= 1), "queue telemetry must prove the background cap");

const managerMain = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
const managerUi = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
assert.match(managerMain, /createMcpResponseQueue\([\s\S]*?maxConcurrent:\s*2[\s\S]*?maxBackgroundConcurrent:\s*1/, "Manager must reserve MCP capacity for the foreground chat");
assert.match(managerMain, /responseQueue\.run\([\s\S]*?responseQueueKey[\s\S]*?priority/, "every profile response read must enter the keyed MCP queue");
assert.match(managerMain, /queue_wait_ms[\s\S]*?queue_active_at_enqueue[\s\S]*?queue_queued_at_enqueue[\s\S]*?queue_coalesced/, "response diagnostics must retain queue pressure evidence");
assert.match(managerUi, /getProfileResponse\(\{[\s\S]*?priority:\s*profile\.profile_id === chatProfileId \? "interactive" : "background"/, "the open chat must receive foreground response priority");

console.log("✓ MCP response queue coalescing, limits, priority, and diagnostics smoke test passed");
