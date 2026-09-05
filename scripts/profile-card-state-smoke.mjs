import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { profileCardBorderState, profileChromeActionState, profileChromeTarget, profileTabFailureState, profileTaskSummaryState } from "../manager/src/profile-card-state.js";

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

assert.deepEqual(profileTaskSummaryState({
  profile: { current_task_title: "Sửa tên task hiện tại" },
  cachedTitle: "Cài bản Frontline v2.2 mới",
  working: true,
  settling: false
}), {
  label: "Task hiện tại",
  title: "Sửa tên task hiện tại"
}, "an authoritative current task title must win over the cached previous title");
assert.deepEqual(profileTaskSummaryState({
  profile: { current_task_title: "" },
  cachedTitle: "Cài bản Frontline v2.2 mới",
  working: true,
  settling: false
}), {
  label: "Task hiện tại",
  title: ""
}, "a working profile without an authoritative task title must not promote a stale cached title to current task");
assert.deepEqual(profileTaskSummaryState({
  profile: { current_task_title: "" },
  cachedTitle: "Cài bản Frontline v2.2 mới",
  working: false,
  settling: true
}), {
  label: "Task hiện tại",
  title: ""
}, "a settling profile must not promote a stale cached title to current task");
assert.deepEqual(profileTaskSummaryState({
  profile: { current_task_title: "" },
  cachedTitle: "Cài bản Frontline v2.2 mới",
  working: false,
  settling: false
}), {
  label: "Task gần nhất",
  title: "Cài bản Frontline v2.2 mới"
}, "an idle profile may still show the cached title as the most recent task");

const extractedBrowserProfilesUrl = new URL("../manager/src/features/profiles/browser-profiles-section.jsx", import.meta.url);
const profileCardUiUrl = existsSync(extractedBrowserProfilesUrl)
  ? extractedBrowserProfilesUrl
  : new URL("../manager/src/main.jsx", import.meta.url);
const profileCardUiSource = readFileSync(profileCardUiUrl, "utf8");
assert.match(profileCardUiSource, /profileTaskSummaryState/, "profile card UI must use the guarded task summary helper");
assert.doesNotMatch(
  profileCardUiSource,
  /current_task_title\s*\|\|\s*(?:profileTaskLabels|taskLabels)\[/,
  "profile card UI must not fall back from an empty live task title directly to a cached previous title"
);

console.log("✓ Profile card state smoke test passed");
