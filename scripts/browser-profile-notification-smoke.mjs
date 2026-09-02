import assert from "node:assert/strict";
import { browserProfileNotificationSignature, browserProfileRetentionState } from "../dist/browserExtensionBridge.js";

const base = [{
  profile_id: "profile-a",
  connected: true,
  last_seen: "2026-09-01T12:00:00.000Z",
  activity: "idle",
  conversation_tabs: [{ id: 1, busy: false }]
}];
const heartbeatOnly = [{ ...base[0], last_seen: "2026-09-01T12:00:10.000Z" }];
const working = [{ ...heartbeatOnly[0], activity: "working" }];
const offline = [{ ...heartbeatOnly[0], connected: false }];

assert.equal(
  browserProfileNotificationSignature(base),
  browserProfileNotificationSignature(heartbeatOnly),
  "heartbeat-only last_seen changes must not publish another renderer profile payload"
);
assert.notEqual(
  browserProfileNotificationSignature(base),
  browserProfileNotificationSignature(working),
  "meaningful profile state changes must still publish immediately"
);
assert.notEqual(
  browserProfileNotificationSignature(base),
  browserProfileNotificationSignature(offline),
  "heartbeat expiry must publish an offline-state transition without requiring profile removal"
);
assert.notEqual(
  browserProfileNotificationSignature(base),
  browserProfileNotificationSignature([]),
  "final profile retention expiry/removal must still publish a new profile payload"
);

const lastSeen = Date.parse("2026-09-01T12:00:00.000Z");
assert.deepEqual(
  browserProfileRetentionState({ lastSeen, headless: false }, lastSeen + 3 * 60_000 + 1),
  { connected: false, visible: true, nextTransitionAt: lastSeen + 24 * 60 * 60_000 },
  "a normal Chrome profile must become offline after heartbeat expiry without disappearing from Manager"
);
assert.deepEqual(
  browserProfileRetentionState({ lastSeen, headless: false }, lastSeen + 24 * 60 * 60_000 + 1),
  { connected: false, visible: false, nextTransitionAt: null },
  "a normal Chrome profile may only leave Manager after the full retention window"
);
assert.deepEqual(
  browserProfileRetentionState({ lastSeen, headless: true }, lastSeen + 3 * 60_000 + 1),
  { connected: false, visible: false, nextTransitionAt: null },
  "a stopped headless worker must still expire promptly instead of leaving a duplicate offline card"
);

console.log("✓ Browser profile heartbeat publication coalescing smoke test passed");
