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
  maxConcurrent: 3,
  maxBackgroundConcurrent: 2,
  onEvent: (event) => events.push(event)
});

const laneAGate = deferred();
let duplicateExecutions = 0;
const laneAFirst = queue.run("profile-a:chat-a:canonical", async () => {
  duplicateExecutions += 1;
  return laneAGate.promise;
}, { priority: "background", lane: "profile-a" });
const laneADuplicate = queue.run("profile-a:chat-a:canonical", async () => {
  duplicateExecutions += 1;
  return "must-not-run";
}, { priority: "interactive", lane: "profile-a" });
assert.strictEqual(laneAFirst, laneADuplicate, "duplicate response reads must share the exact same promise");
await flush();
assert.equal(duplicateExecutions, 1, "duplicate response reads must execute only once");

const laneBGate = deferred();
const laneB = queue.run("profile-b:chat-b:canonical", () => laneBGate.promise, { priority: "background", lane: "profile-b" });
const interactiveGate = deferred();
const interactive = queue.run("profile-c:chat-c:network", () => interactiveGate.promise, { priority: "interactive", lane: "profile-c" });
await flush();
assert.equal(queue.snapshot().active, 3, "two background profiles plus one foreground profile should use all three response slots");
assert.equal(queue.snapshot().backgroundActive, 2, "background polling should use two parallel lanes");

let sameLaneStarted = false;
const sameLaneInteractive = queue.run("profile-a:chat-a:network", async () => {
  sameLaneStarted = true;
  return "same-lane-result";
}, { priority: "interactive", lane: "profile-a" });
let extraBackgroundStarted = false;
const extraBackground = queue.run("profile-d:chat-d:canonical", async () => {
  extraBackgroundStarted = true;
  return "profile-d-result";
}, { priority: "background", lane: "profile-d" });
await flush();
assert.equal(sameLaneStarted, false, "a profile must never receive overlapping response commands from different response modes");
assert.equal(extraBackgroundStarted, false, "background polling must respect its two-lane cap");

interactiveGate.resolve("interactive-result");
assert.equal(await interactive, "interactive-result");
await flush();
assert.equal(sameLaneStarted, false, "foreground demand for a busy lane must wait for that lane instead of overlapping Chrome commands");
assert.equal(extraBackgroundStarted, false, "free foreground capacity must remain reserved while both background lanes are occupied");

laneBGate.resolve("lane-b-result");
assert.equal(await laneB, "lane-b-result");
await flush();
assert.equal(extraBackgroundStarted, true, "another profile should use a newly-free background lane without waiting for unrelated profiles");
assert.equal(await extraBackground, "profile-d-result");

laneAGate.resolve("shared-result");
assert.equal(await laneAFirst, "shared-result");
assert.equal(await laneADuplicate, "shared-result");
await flush();
assert.equal(sameLaneStarted, true, "queued interactive work should start as soon as its own profile lane is free");
assert.equal(await sameLaneInteractive, "same-lane-result");
assert.equal(queue.snapshot().active, 0, "queue must release every active slot after completion");
assert.equal(queue.snapshot().queued, 0, "queue must drain every pending request");
assert.ok(events.some((event) => event.type === "coalesced" && event.requested_priority === "interactive"), "queue telemetry must record duplicate coalescing and foreground demand");
assert.ok(events.every((event) => (event.active ?? 0) <= 3), "queue telemetry must prove the global cap");
assert.ok(events.every((event) => (event.backgroundActive ?? 0) <= 2), "queue telemetry must prove the background cap");
assert.ok(events.some((event) => event.lane === "profile-a"), "queue telemetry must include the per-profile lane");

const managerMain = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
const managerUi = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
assert.match(managerMain, /createMcpResponseQueue\([\s\S]*?maxConcurrent:\s*3[\s\S]*?maxBackgroundConcurrent:\s*2/, "Manager must allow two background profiles while reserving a third slot for foreground chat");
assert.match(managerMain, /responseQueue\.run\([\s\S]*?responseQueueKey[\s\S]*?priority,\s*lane:\s*profileId/, "every profile response read must use a keyed per-profile lane");
assert.match(managerMain, /queue_wait_ms[\s\S]*?queue_active_at_enqueue[\s\S]*?queue_queued_at_enqueue[\s\S]*?queue_coalesced/, "response diagnostics must retain queue pressure evidence");
assert.match(managerUi, /getProfileResponse\(\{[\s\S]*?priority:\s*profile\.profile_id === chatProfileId \? "interactive" : "background"/, "the open chat must receive foreground response priority");

console.log("✓ MCP response queue parallel profile lanes, coalescing, priority, and diagnostics smoke test passed");
