import assert from "node:assert/strict";

import { createBrowserStreamIpcCoordinator } from "../electron/browser-stream-ipc.mjs";
import { mergeNetworkStreamTranscript } from "../src/chat-transcript.js";

function createFakeTimers() {
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout(callback) {
      const id = ++nextId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fireNext() {
      const next = timers.entries().next().value;
      if (!next) return false;
      const [id, callback] = next;
      timers.delete(id);
      callback();
      return true;
    },
    size() {
      return timers.size;
    }
  };
}

function streamUpdate(revision, { profileId = "profile-a", conversationId = "conversation-a", recordId = 1 } = {}) {
  return {
    profile_id: profileId,
    conversation_id: conversationId,
    tab_id: 123,
    record_id: recordId,
    revision,
    event_count: revision,
    updated_at: new Date(1_700_000_000_000 + revision).toISOString(),
    in_progress: revision < 2_000,
    text: `prefix:${"x".repeat(Math.min(200_000, revision * 100))}`
  };
}

const timers = createFakeTimers();
const sent = [];
const coordinator = createBrowserStreamIpcCoordinator({
  send: (payload) => sent.push(payload),
  ackTimeoutMs: 5_000,
  setTimeoutFn: timers.setTimeout,
  clearTimeoutFn: timers.clearTimeout
});

for (let revision = 1; revision <= 1_000; revision += 1) coordinator.queue([streamUpdate(revision)]);
assert.equal(sent.length, 1, "producer revisions must not become one IPC send per revision while ACK is delayed");
assert.equal(coordinator.state().inFlightSequence, sent[0].sequence);
assert.equal(coordinator.state().inFlightUpdates[0].revision, 1, "first revision may be the single in-flight batch");
assert.equal(coordinator.state().pendingKeys, 1, "one active profile/conversation must retain one pending key");
assert.equal(coordinator.state().pending.get("profile-a:conversation-a")?.revision, 1_000, "pending state must retain the latest revision only");
assert.equal(coordinator.metrics().maxInFlight, 1, "MAX_IN_FLIGHT_BATCHES must remain one");

const sequence1 = sent[0].sequence;
assert.equal(coordinator.acknowledge(sequence1), true);
assert.equal(sent.length, 2, "one ACK may release exactly one newest pending batch");
assert.equal(sent[1].updates[0].revision, 1_000);
const sequence2 = sent[1].sequence;

for (let revision = 1_001; revision <= 2_000; revision += 1) coordinator.queue([streamUpdate(revision)]);
assert.equal(sent.length, 2, "producer rate must remain decoupled from main IPC send rate while second batch is in flight");
assert.equal(coordinator.state().pendingKeys, 1);
assert.equal(coordinator.state().pending.get("profile-a:conversation-a")?.revision, 2_000);
assert.equal(coordinator.acknowledge(sequence1), false, "stale ACK must be ignored");
assert.equal(coordinator.acknowledge(sequence1), false, "duplicate stale ACK must remain harmless");
assert.equal(sent.length, 2);
assert.equal(coordinator.acknowledge(sequence2), true);
assert.equal(sent.length, 3);
assert.equal(sent[2].updates[0].revision, 2_000, "final pending revision must be preserved exactly");
assert.equal(sent[2].updates[0].text.length, 200_007, "final full response text must be preserved");

coordinator.queue([streamUpdate(2_001, { conversationId: "conversation-b" })]);
coordinator.queue([streamUpdate(2_002, { conversationId: "conversation-c" })]);
coordinator.queue([streamUpdate(2_003, { conversationId: "conversation-d" })]);
assert.ok(coordinator.state().pendingKeys <= 3, "pending keys must be bounded by active profile/conversation keys");

let transcript = [{ id: "user-1", role: "user", text: "continue" }];
transcript = mergeNetworkStreamTranscript(transcript, { conversationId: "conversation-a", text: sent[1].updates[0].text });
transcript = mergeNetworkStreamTranscript(transcript, { conversationId: "conversation-a", text: sent[2].updates[0].text });
assert.equal(transcript.filter((message) => message.id === "network-stream-assistant:conversation-a").length, 1, "progressive renderer transcript must keep one provisional assistant");
assert.equal(transcript.find((message) => message.id === "network-stream-assistant:conversation-a")?.text.length, 200_007, "progressive renderer transcript must advance to the latest full text");

const timeoutTimers = createFakeTimers();
const timeoutSent = [];
const timeoutCoordinator = createBrowserStreamIpcCoordinator({
  send: (payload) => timeoutSent.push(payload),
  ackTimeoutMs: 1_000,
  setTimeoutFn: timeoutTimers.setTimeout,
  clearTimeoutFn: timeoutTimers.clearTimeout
});
timeoutCoordinator.queue([streamUpdate(1)]);
for (let revision = 2; revision <= 100; revision += 1) timeoutCoordinator.queue([streamUpdate(revision)]);
const timedOutSequence = timeoutSent[0].sequence;
assert.equal(timeoutTimers.fireNext(), true, "ACK timeout must be armed");
assert.equal(timeoutSent.length, 2, "timeout recovery may send one latest replacement batch only");
assert.equal(timeoutSent[1].updates.length, 1);
assert.equal(timeoutSent[1].updates[0].revision, 100, "timeout recovery must resume from latest pending revision, not history");
assert.equal(timeoutCoordinator.acknowledge(timedOutSequence), false, "late ACK for timed-out sequence must be ignored");
assert.equal(timeoutCoordinator.metrics().timeouts, 1);
assert.equal(timeoutCoordinator.metrics().maxInFlight, 1);

const resetTimers = createFakeTimers();
const resetSent = [];
const resetCoordinator = createBrowserStreamIpcCoordinator({
  send: (payload) => resetSent.push(payload),
  setTimeoutFn: resetTimers.setTimeout,
  clearTimeoutFn: resetTimers.clearTimeout
});
resetCoordinator.queue([streamUpdate(1)]);
resetCoordinator.queue([streamUpdate(2)]);
const resetSequence = resetSent[0].sequence;
resetCoordinator.pause({ requeueInFlight: true });
assert.equal(resetCoordinator.state().inFlightSequence, 0, "renderer reload must clear in-flight state");
assert.equal(resetCoordinator.state().pendingKeys, 1, "renderer reload must retain only the newest pending key");
assert.equal(resetCoordinator.state().pending.get("profile-a:conversation-a")?.revision, 2, "renderer reload must retain the newest revision, not the old in-flight revision");
assert.equal(resetCoordinator.acknowledge(resetSequence), false, "ACK from pre-reload renderer state must be ignored");
assert.equal(resetTimers.size(), 0, "renderer pause must clear ACK timeout");
resetCoordinator.queue([streamUpdate(3)]);
assert.equal(resetSent.length, 1, "paused renderer must not receive stream IPC");
assert.equal(resetCoordinator.state().pending.get("profile-a:conversation-a")?.revision, 3, "updates during reload must collapse to the newest revision");
resetCoordinator.resume();
assert.equal(resetSent.at(-1).updates[0].revision, 3, "streaming must resume from the latest revision after renderer reload");
resetCoordinator.destroy();
assert.equal(resetCoordinator.state().inFlightSequence, 0, "destroyed renderer must clear in-flight state");
assert.equal(resetCoordinator.state().pendingKeys, 0, "destroyed renderer must clear pending state");
const sendsBeforeDestroyedQueue = resetSent.length;
resetCoordinator.queue([streamUpdate(4)]);
assert.equal(resetSent.length, sendsBeforeDestroyedQueue, "destroyed renderer must not receive new IPC batches");

const metrics = coordinator.metrics();
console.log(JSON.stringify({
  regression: "browser-stream-ipc-backpressure",
  SOURCE_STREAM_EVENTS: metrics.sourceEvents,
  MAIN_SEND_COUNT: metrics.sends,
  MAX_IN_FLIGHT_BATCHES: metrics.maxInFlight,
  MAX_PENDING_STREAM_KEYS: metrics.maxPendingKeys,
  STREAM_PAYLOAD_BYTES: metrics.payloadBytes,
  FINAL_REVISION: sent[2].updates[0].revision,
  FINAL_REVISION_PRESERVED: sent[2].updates[0].text.length === 200_007
}, null, 2));

console.log("browser-stream-ipc-backpressure-smoke: ok");
