import assert from "node:assert/strict";
import { profileCardBorderState, profileChromeActionState, profileChromeTarget } from "../manager/src/profile-card-state.js";

assert.equal(profileCardBorderState({ connected: true, working: true, settling: false, rendererUnresponsive: false, networkState: "failed", rendererError: "", connectionInterrupted: false }), "working", "live tool activity must override a stale failed network generation");
assert.equal(profileCardBorderState({ connected: true, working: false, settling: false, rendererUnresponsive: false, networkState: "failed", rendererError: "", connectionInterrupted: false }), "idle", "a connected idle profile must not stay red because of an old failed request");
assert.equal(profileCardBorderState({ connected: true, working: true, settling: false, rendererUnresponsive: true, networkState: "generating", rendererError: "", connectionInterrupted: false }), "error", "a genuinely unresponsive renderer must remain red even if its last activity was working");
assert.equal(profileCardBorderState({ connected: true, working: false, settling: true, rendererUnresponsive: false, networkState: "failed", rendererError: "", connectionInterrupted: false }), "working", "a live settling turn must use the working border instead of a stale failed network record");

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

console.log("✓ Profile card state smoke test passed");
