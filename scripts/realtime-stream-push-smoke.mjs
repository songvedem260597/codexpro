import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mergeBrowserExtensionStreamBatch } from "../dist/browserExtensionBridge.js";

const [extensionSource, httpSource, managerMainSource, managerRendererSource] = await Promise.all([
  readFile(new URL("../chrome-extension/service-worker.js", import.meta.url), "utf8"),
  readFile(new URL("../src/http.ts", import.meta.url), "utf8"),
  readFile(new URL("../manager/electron/main.mjs", import.meta.url), "utf8"),
  readFile(new URL("../manager/src/main.jsx", import.meta.url), "utf8")
]);

assert.match(extensionSource, /realtimeStreamPushInFlight/, "extension stream uploads must be single-flight");
assert.match(extensionSource, /finally\s*\{[\s\S]*?realtimeStreamPushInFlight\s*=\s*false[\s\S]*?pendingRealtimeStreamTabs\.size[\s\S]*?scheduleRealtimeStreamPush/, "updates received during an in-flight upload must be flushed afterwards");
assert.match(extensionSource, /REALTIME_STREAM_PUSH_TIMEOUT_MS[\s\S]*?AbortController[\s\S]*?signal:\s*requestController\.signal/, "a hung extension stream upload must be aborted so later updates can recover");
assert.match(httpSource, /streamBackpressured[\s\S]*?res\.on\("drain"/, "browser SSE must stop flushing while the response is backpressured");
assert.match(httpSource, /pendingStreamUpdates\s*=\s*new Map/, "browser SSE must retain only the latest pending revision per tab");
assert.match(managerMainSource, /pendingStreamUpdates\s*=\s*new Map[\s\S]*?codexpro:browser-stream/, "Electron IPC must coalesce browser stream updates before sending them to the renderer");
assert.match(managerRendererSource, /pendingBrowserStreamUpdates[\s\S]*?requestAnimationFrame/, "renderer stream state updates must be coalesced to animation frames");

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

const stalePreviousRecord = mergeBrowserExtensionStreamBatch(profileId, tabs, [{
  tab_id: tabId,
  conversation_id: conversationId,
  record_id: 1,
  revision: 99,
  text: "STALE previous turn",
  event_count: 99,
  updated_at: "2026-09-02T07:31:00.010Z",
  in_progress: false,
  error: "",
  activity_text: ""
}]);
assert.equal(stalePreviousRecord.changed, false, "an older stream record must not overwrite the active newer record");
assert.equal(tabs[0].network_stream_record_id, 2);
assert.equal(tabs[0].network_stream_text, "Lượt mới");
assert.equal(tabs[0].busy, true, "a delayed settled event from an old record must not clear the current busy state");

const nextConversationId = "conversation-stream-5678";
tabs[0].url = `https://chatgpt.com/c/${nextConversationId}`;
const staleOldConversation = mergeBrowserExtensionStreamBatch(profileId, tabs, [{
  tab_id: tabId,
  conversation_id: conversationId,
  record_id: 3,
  revision: 1,
  text: "STALE old conversation",
  event_count: 1,
  updated_at: "2026-09-02T07:32:00.000Z",
  in_progress: false,
  error: "",
  activity_text: ""
}]);
assert.equal(staleOldConversation.changed, false, "a stream from the previous conversation must not leak into a navigated tab");
assert.equal(tabs[0].network_stream_text, "Lượt mới");

const reloadedConversation = mergeBrowserExtensionStreamBatch(profileId, tabs, [{
  tab_id: tabId,
  conversation_id: nextConversationId,
  record_id: 1,
  revision: 1,
  text: "Sau reload",
  event_count: 1,
  updated_at: "2026-09-02T07:32:00.010Z",
  in_progress: true,
  error: "",
  activity_text: ""
}]);
assert.equal(reloadedConversation.changed, true, "a new conversation must be allowed to restart its document-local record counter");
assert.equal(tabs[0].network_stream_conversation_id, nextConversationId);
assert.equal(tabs[0].network_stream_record_id, 1);
assert.equal(tabs[0].network_stream_text, "Sau reload");

console.log("✓ Realtime stream push merge smoke test passed");
