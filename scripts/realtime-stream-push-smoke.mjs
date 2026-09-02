import assert from "node:assert/strict";
import { mergeBrowserExtensionStreamBatch } from "../dist/browserExtensionBridge.js";

const profileId = "stream-smoke-profile";
const conversationId = "conversation-stream-1234";
const tabId = 404;
const tabs = [{
  id: tabId,
  title: "Realtime stream smoke",
  url: `https://chatgpt.com/c/${conversationId}`,
  active: true,
  busy: false,
  network_state: "idle",
  busy_source: ""
}];

const first = mergeBrowserExtensionStreamBatch(profileId, tabs, [{
  tab_id: tabId,
  conversation_id: conversationId,
  record_id: 1,
  revision: 1,
  text: "Xin",
  event_count: 1,
  updated_at: "2026-09-02T07:30:00.000Z",
  in_progress: true,
  error: "",
  activity_text: "Codex Pro đang sử dụng công cụ"
}]);
assert.equal(first.changed, true);
assert.equal(first.updates.length, 1);
assert.equal(first.updates[0].profile_id, profileId);
assert.equal(first.updates[0].text, "Xin");
assert.equal(first.updates[0].revision, 1);
assert.equal(first.updates[0].activity_text, "Codex Pro đang sử dụng công cụ");
assert.equal(tabs[0].busy, true, "live stream push should mark the tab busy");
assert.equal(tabs[0].network_state, "generating");
assert.equal(tabs[0].busy_source, "network_stream_push");

const duplicate = mergeBrowserExtensionStreamBatch(profileId, tabs, [{
  tab_id: tabId,
  conversation_id: conversationId,
  record_id: 1,
  revision: 1,
  text: "STALE",
  event_count: 1,
  updated_at: "2026-09-02T07:30:00.010Z",
  in_progress: true,
  error: ""
}]);
assert.equal(duplicate.changed, false, "duplicate revisions must be ignored");
assert.equal(duplicate.updates.length, 0);
assert.equal(tabs[0].network_stream_text, "Xin", "ignored duplicate must not overwrite the accepted stream text");

const settled = mergeBrowserExtensionStreamBatch(profileId, tabs, [{
  tab_id: tabId,
  conversation_id: conversationId,
  record_id: 1,
  revision: 2,
  text: "Xin chào",
  event_count: 2,
  updated_at: "2026-09-02T07:30:00.020Z",
  in_progress: false,
  error: "",
  activity_text: ""
}]);
assert.equal(settled.changed, true);
assert.equal(settled.updates.at(-1)?.text, "Xin chào");
assert.equal(settled.updates.at(-1)?.in_progress, false);
assert.equal(tabs[0].busy, false, "terminal push should release busy state that was owned by realtime streaming");
assert.equal(tabs[0].network_state, "completed");
assert.equal(tabs[0].busy_source, "");
assert.equal(tabs[0].network_stream_activity_text, "");

const nextRecord = mergeBrowserExtensionStreamBatch(profileId, tabs, [{
  tab_id: tabId,
  conversation_id: conversationId,
  record_id: 2,
  revision: 1,
  text: "Lượt mới",
  event_count: 1,
  updated_at: "2026-09-02T07:31:00.000Z",
  in_progress: true,
  error: "",
  activity_text: ""
}]);
assert.equal(nextRecord.changed, true, "a new stream record must accept revision 1 even after a higher revision on the previous record");
assert.equal(tabs[0].network_stream_record_id, 2);
assert.equal(tabs[0].network_stream_revision, 1);
assert.equal(tabs[0].network_stream_text, "Lượt mới");

console.log("✓ Realtime stream push merge smoke test passed");
