import assert from "node:assert/strict";
import { profileCardBorderState } from "../manager/src/profile-card-state.js";

assert.equal(profileCardBorderState({ connected: true, working: true, settling: false, rendererUnresponsive: false, networkState: "failed", rendererError: "", connectionInterrupted: false }), "working", "live tool activity must override a stale failed network generation");
assert.equal(profileCardBorderState({ connected: true, working: false, settling: false, rendererUnresponsive: false, networkState: "failed", rendererError: "", connectionInterrupted: false }), "idle", "a connected idle profile must not stay red because of an old failed request");
assert.equal(profileCardBorderState({ connected: true, working: true, settling: false, rendererUnresponsive: true, networkState: "generating", rendererError: "", connectionInterrupted: false }), "error", "a genuinely unresponsive renderer must remain red even if its last activity was working");
assert.equal(profileCardBorderState({ connected: true, working: false, settling: true, rendererUnresponsive: false, networkState: "failed", rendererError: "", connectionInterrupted: false }), "working", "a live settling turn must use the working border instead of a stale failed network record");

console.log("✓ Profile card state smoke test passed");
