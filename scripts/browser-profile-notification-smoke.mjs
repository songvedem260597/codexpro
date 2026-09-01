import assert from "node:assert/strict";
import { browserProfileNotificationSignature } from "../dist/browserExtensionBridge.js";

const base = [{
  profile_id: "profile-a",
  connected: true,
  last_seen: "2026-09-01T12:00:00.000Z",
  activity: "idle",
  conversation_tabs: [{ id: 1, busy: false }]
}];
const heartbeatOnly = [{ ...base[0], last_seen: "2026-09-01T12:00:10.000Z" }];
const working = [{ ...heartbeatOnly[0], activity: "working" }];

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
  browserProfileNotificationSignature([]),
  "profile expiry/removal must publish a new profile payload"
);

console.log("✓ Browser profile heartbeat publication coalescing smoke test passed");
