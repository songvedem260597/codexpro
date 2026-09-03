import assert from "node:assert/strict";
import fs from "node:fs";
import { profileCardBorderState, profileChromeActionState, profileChromeTarget, profileConnectionState, profileTabFailureState } from "../manager/src/profile-card-state.js";

const managerSource = fs.readFileSync(new URL("../manager/src/main.jsx", import.meta.url), "utf8");
assert.match(managerSource, /profileTabFailureState\(\{ connected: profile\.connected, working, settling, tab: liveTab \}\)/, "profile cards must centralize renderer/transport failure classification");
assert.match(managerSource, /profileChromeActionState\(\{ profile, busy, rendererUnresponsive: tabFailureState\.recoveryRequired \}\)/, "transport recovery may be offered without painting the profile as renderer-hung");

const stoppedAt = "2026-09-03T01:00:00.000Z";
assert.equal(profileConnectionState({ connected: false, last_seen: stoppedAt, lifecycle_event: { type: "window_removed", reason: "external_or_chrome", at: stoppedAt } }), "stopped", "a disconnected profile whose final lifecycle event closes Chrome must be shown as stopped");
assert.equal(profileConnectionState({ connected: false, last_seen: "2026-09-03T01:05:00.000Z", lifecycle_event: { type: "window_removed", reason: "external_or_chrome", at: stoppedAt } }), "disconnected", "an old Chrome-close event must not hide a later heartbeat failure");
assert.equal(profileConnectionState({ connected: false, last_seen: stoppedAt, lifecycle_event: { type: "tab_removed", reason: "external_or_chrome", is_window_closing: true, at: stoppedAt } }), "stopped", "a last-window tab removal is valid stopped evidence");
assert.equal(profileConnectionState({ connected: false, last_seen: stoppedAt }), "disconnected", "heartbeat loss without close evidence must remain disconnected");
assert.equal(profileCardBorderState({ connected: false, stopped: true }), "stopped", "stopped profiles must use a neutral card state instead of an error state");
assert.match(managerSource, /profile-stopped[\s\S]*?ĐÃ TẮT/, "profile UI must render a dedicated stopped badge");
assert.match(managerSource, /Profile Chrome đã tắt[\s\S]*?Mất heartbeat extension/, "profile metadata must distinguish stopped Chrome from heartbeat loss");
assert.match(managerSource, /ProfileSummaryItem state="stopped"[\s\S]*?label="đã tắt"/, "overview summary must count stopped profiles separately");

assert.equal(profileCardBorderState({ connected: true, working: true, settling: false, rendererUnresponsive: false, networkState: "failed", rendererError: "", connectionInterrupted: false }), "working", "live tool activity must override a stale failed network generation");
assert.equal(profileCardBorderState({ connected: true, working: false, settling: false, rendererUnresponsive: false, networkState: "failed", rendererError: "", connectionInterrupted: false }), "idle", "a connected idle profile must not stay red because of an old failed request");
assert.equal(profileCardBorderState({ connected: true, working: true, settling: false, rendererUnresponsive: true, networkState: "generating", rendererError: "", connectionInterrupted: false }), "error", "a genuinely unresponsive renderer must remain red even if its last activity was working");
assert.equal(profileCardBorderState({ connected: true, working: false, settling: true, rendererUnresponsive: false, networkState: "failed", rendererError: "", connectionInterrupted: false }), "working", "a live settling turn must use the working border instead of a stale failed network record");
assert.deepEqual(profileTabFailureState({ connected: true, working: true, settling: false, tab: { network_state: "failed", network_error: "net::ERR_FAILED", message_delivery_timed_out: true, renderer_unresponsive: false } }), {
  rendererUnresponsive: false,
  recoveryRequired: false
}, "stale transport failure flags must not turn an actively working profile into a hung renderer");
assert.deepEqual(profileTabFailureState({ connected: true, working: false, settling: false, tab: { network_state: "failed", network_error: "net::ERR_FAILED", renderer_unresponsive: false } }), {
  rendererUnresponsive: false,
  recoveryRequired: true
}, "an idle profile with a current transport failure must still offer recovery");
assert.deepEqual(profileTabFailureState({ connected: true, working: true, settling: false, tab: { renderer_unresponsive: true } }), {
  rendererUnresponsive: true,
  recoveryRequired: true
}, "an explicit renderer hang must stay a hard error even when the last activity says working");

const newChatProfile = {
  connected: true,
  chatgpt_tabs: [{ id: 71, title: "ChatGPT", url: "https://chatgpt.com/", active: true }],
  conversation_tabs: []
};
assert.equal(profileChromeTarget(newChatProfile)?.id, 71, "an open ChatGPT new-tab page must remain a valid profile target without a conversation id");
assert.deepEqual(profileChromeActionState({ profile: newChatProfile, busy: "", rendererUnresponsive: false }), {
  target: newChatProfile.chatgpt_tabs[0],
  disabled: false,
  label: "Mở Chrome",
  title: "Đưa profile Chrome đang mở lên trước"
}, "an already-open profile must not be presented as unopened");
assert.deepEqual(profileChromeActionState({ profile: { connected: true, chatgpt_tabs: [], conversation_tabs: [] }, busy: "", rendererUnresponsive: false }), {
  target: null,
  disabled: false,
  label: "Mở ChatGPT",
  title: "Mở một tab ChatGPT mới trong đúng Chrome profile"
}, "an online profile without a ChatGPT tab must remain actionable");
assert.deepEqual(profileChromeActionState({ profile: newChatProfile, busy: "", rendererUnresponsive: true }), {
  target: newChatProfile.chatgpt_tabs[0],
  disabled: false,
  label: "Khôi phục tab",
  title: "Đóng tab renderer bị treo và tạo một chat ChatGPT mới"
}, "a hung profile must offer a fresh chat instead of reopening the broken conversation");

console.log("✓ Profile card state smoke test passed");
