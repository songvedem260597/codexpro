import assert from "node:assert/strict";

import { createResponseCacheSaveQueue } from "../src/chat-response-cache-save-queue.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timerApi = {
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer)
};

const saved = [];
let active = 0;
let maxActive = 0;
const queue = createResponseCacheSaveQueue({
  save: async (entry) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(15);
    saved.push(entry);
    active -= 1;
  },
  coalesceMs: 10,
  flushTimeoutMs: 500,
  ...timerApi
});

for (let revision = 1; revision <= 40; revision += 1) {
  queue.enqueue("profile-a:conv-a", { conversationId: "conv-a", revision, text: `revision-${revision}` });
}
const burstFlush = await queue.flush({ reason: "burst", timeoutMs: 1000 });
assert.equal(burstFlush.flushed, true);
assert.equal(burstFlush.received, 40);
assert.equal(burstFlush.coalesced, 39, "burst revisions for one conversation must collapse to the newest pending snapshot");
assert.equal(burstFlush.completed, 1, "collapsed burst must produce one IPC save");
assert.equal(saved.length, 1);
assert.equal(saved[0].revision, 40);
assert.equal(maxActive, 1, "save queue must allow only one in-flight IPC save");

saved.length = 0;
queue.enqueue("profile-a:conv-a", { conversationId: "conv-a", revision: 41, text: "a-41" });
queue.enqueue("profile-a:conv-b", { conversationId: "conv-b", revision: 1, text: "b-1" });
queue.enqueue("profile-a:conv-a", { conversationId: "conv-a", revision: 42, text: "a-42" });
const multiFlush = await queue.flush({ reason: "conversation-change", timeoutMs: 1000 });
assert.equal(multiFlush.flushed, true);
assert.deepEqual(saved.map((entry) => [entry.conversationId, entry.revision]), [["conv-a", 42], ["conv-b", 1]], "multiple conversations keep their own newest pending snapshot");
assert.equal(maxActive, 1);

let failureObserved = 0;
let failOnce = true;
const failingQueue = createResponseCacheSaveQueue({
  save: async (entry) => {
    await sleep(5);
    if (failOnce) {
      failOnce = false;
      throw new Error("synthetic IPC failure");
    }
    saved.push(entry);
  },
  coalesceMs: 5,
  ...timerApi
});
failingQueue.enqueue("profile-e:conv-error", { revision: 1 }, { onError: () => { failureObserved += 1; } });
await failingQueue.flush({ reason: "first-failure", timeoutMs: 500 });
assert.equal(failureObserved, 1);
assert.equal(failingQueue.stats().failed, 1);
failingQueue.enqueue("profile-e:conv-error", { revision: 2 });
const recovered = await failingQueue.flush({ reason: "retry", timeoutMs: 500 });
assert.equal(recovered.flushed, true);
assert.equal(recovered.completed, 1);
assert.equal(recovered.failed, 1);

const slowQueue = createResponseCacheSaveQueue({
  save: async () => sleep(80),
  coalesceMs: 0,
  ...timerApi
});
slowQueue.enqueue("profile-s:conv-slow", { revision: 1 }, { immediate: true });
const timed = await slowQueue.flush({ reason: "bounded", timeoutMs: 10 });
assert.equal(timed.flushed, false);
assert.equal(timed.timedOut, true, "renderer flush must have a finite timeout");
const drained = await slowQueue.flush({ reason: "final", timeoutMs: 500 });
assert.equal(drained.flushed, true, "later final flush must wait for the in-flight save");
assert.equal(drained.inFlight, 0);
assert.equal(drained.pending, 0);

const metrics = queue.stats();
assert.equal(typeof metrics.lastPayloadBytes, "number");
assert.equal(Object.values(metrics).some((value) => typeof value === "string" && value.includes("revision-40")), false, "metrics must not expose chat content");

console.log("chat-response-cache-save-queue-smoke: ok");
