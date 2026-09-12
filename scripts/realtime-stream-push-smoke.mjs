import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mergeBrowserExtensionStreamBatch } from "../dist/browserExtensionBridge.js";
import { createBrowserWindowStreamTarget } from "../manager/electron/browser-window-stream-target.mjs";

const [extensionSource, bridgeSource, httpSource, managerMainSource, managerRendererSource] = await Promise.all([
  readFile(new URL("../chrome-extension/service-worker.js", import.meta.url), "utf8"),
  readFile(new URL("../src/browserExtensionBridge.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/http.ts", import.meta.url), "utf8"),
  readFile(new URL("../manager/electron/main.mjs", import.meta.url), "utf8"),
  readFile(new URL("../manager/src/hooks/use-runtime-status.js", import.meta.url), "utf8")
]);

assert.match(extensionSource, /realtimeStreamPushInFlight/, "extension stream uploads must be single-flight");
assert.match(extensionSource, /finally\s*\{[\s\S]*?realtimeStreamPushInFlight\s*=\s*false[\s\S]*?pendingRealtimeStreamTabs\.size[\s\S]*?scheduleRealtimeStreamPush/, "updates received during an in-flight upload must be flushed afterwards");
assert.match(extensionSource, /REALTIME_STREAM_PUSH_TIMEOUT_MS[\s\S]*?AbortController[\s\S]*?signal:\s*requestController\.signal/, "a hung extension stream upload must be aborted so later updates can recover");
assert.match(httpSource, /streamBackpressured[\s\S]*?res\.on\("drain"/, "browser SSE must stop flushing while the response is backpressured");
assert.match(httpSource, /pendingStreamUpdates\s*=\s*new Map/, "browser SSE must retain only the latest pending revision per tab");
assert.match(managerMainSource, /createBrowserStreamIpcCoordinator[\s\S]*?codexpro:browser-stream-ack/, "Electron IPC must gate browser stream sends behind renderer acknowledgement");
assert.match(managerMainSource, /streamReloadResumeTimer[\s\S]*?setTimeout\(resumeBrowserStreamAfterReload, 2_500\)[\s\S]*?did-start-loading[\s\S]*?did-stop-loading/, "renderer reload pause must have a finite resume path so streaming cannot remain paused forever");
assert.match(managerMainSource, /createBrowserWindowStreamTarget\(win\)[\s\S]*?const \{ webContents \} = streamTarget;[\s\S]*?const stopStream = \(\) => \{[\s\S]*?if \(!webContents\.isDestroyed\(\)\)/, "stream teardown must use the cached WebContents after BrowserWindow closed destroys the wrapper");
let browserWindowDestroyed = false;
let webContentsGetterReads = 0;
const sentAfterDestroy = [];
const cachedWebContents = { isDestroyed: () => browserWindowDestroyed, send: (...args) => sentAfterDestroy.push(args) };
const fakeBrowserWindow = {
  get webContents() {
    webContentsGetterReads += 1;
    if (browserWindowDestroyed) throw new TypeError("Object has been destroyed");
    return cachedWebContents;
  },
  isDestroyed: () => browserWindowDestroyed
};
const streamTarget = createBrowserWindowStreamTarget(fakeBrowserWindow);
browserWindowDestroyed = true;
assert.doesNotThrow(() => streamTarget.send("codexpro:test", { ok: true }), "teardown must never dereference BrowserWindow.webContents after destruction");
assert.equal(streamTarget.send("codexpro:test", { ok: true }), false);
assert.equal(webContentsGetterReads, 1, "WebContents must be captured exactly once while BrowserWindow is alive");
assert.equal(sentAfterDestroy.length, 0);
assert.match(extensionSource, /if\(now-previous<FLIGHT_RECORDER_INCIDENT_COOLDOWN_MS\)return null;/, "flight recorder cooldown must cover rate-limit incidents, not only generic CDP incidents");
assert.doesNotMatch(extensionSource, /if\(reason==='cdp'&&now-previous<FLIGHT_RECORDER_INCIDENT_COOLDOWN_MS\)/, "429 incidents must not bypass the recorder cooldown");
assert.match(bridgeSource, /duplicateBrowserRateLimitIncident[\s\S]*?RATE_LIMIT_INCIDENT_DEDUPE_MS/, "browser bridge must defensively deduplicate 429 incidents from old or noisy workers");
assert.match(managerMainSource, /pendingProfilePayload[\s\S]*?queueProfilePayload[\s\S]*?setTimeout\(flushProfilePayload, 100\)/, "Manager must keep only the newest pending full profile snapshot before Electron IPC");
assert.match(managerMainSource, /flushProfilePayload[\s\S]*?codexpro:browser-profiles/, "coalesced profile snapshots must still reach the renderer");
assert.match(managerRendererSource, /pendingBrowserStreamUpdates[\s\S]*?requestAnimationFrame/, "renderer stream state updates must be coalesced to animation frames");
assert.match(managerRendererSource, /setRequestResponses[\s\S]*?browserStreamAckFrame[\s\S]*?requestAnimationFrame[\s\S]*?ackBrowserStream/, "renderer must ACK only after the rAF application boundary");

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
