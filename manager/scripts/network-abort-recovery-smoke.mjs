import assert from "node:assert/strict";
import { isRecoverableAbortedChatNetworkFailure, shouldShowChatBusy } from "../src/chat-status.js";

const completedAt = "2026-08-29T14:36:32.673Z";
const completedAtMs = Date.parse(completedAt);

assert.equal(isRecoverableAbortedChatNetworkFailure({
  networkState: "failed",
  networkError: "net::ERR_ABORTED",
  networkCompletedAt: completedAt,
  responseReady: false,
  nowMs: completedAtMs + 30_000
}), true, "a fresh ERR_ABORTED must be treated as recoverable while canonical completion may still arrive");

assert.equal(isRecoverableAbortedChatNetworkFailure({
  networkState: "failed",
  networkError: "net::ERR_ABORTED",
  networkCompletedAt: completedAt,
  responseReady: true,
  nowMs: completedAtMs + 30_000
}), false, "a canonical-ready response must stop the ERR_ABORTED recovery state");

assert.equal(isRecoverableAbortedChatNetworkFailure({
  networkState: "failed",
  networkError: "net::ERR_FAILED",
  networkCompletedAt: completedAt,
  responseReady: false,
  nowMs: completedAtMs + 30_000
}), false, "unrelated network failures must remain terminal");

assert.equal(isRecoverableAbortedChatNetworkFailure({
  networkState: "failed",
  networkError: "net::ERR_ABORTED",
  networkCompletedAt: completedAt,
  responseReady: false,
  nowMs: completedAtMs + 121_000
}), false, "ERR_ABORTED recovery must expire instead of waiting forever");

assert.equal(shouldShowChatBusy({
  networkState: "idle",
  tabBusy: true,
  responseCurrent: true,
  responseBusy: false,
  responseReady: true,
  responseLoading: false,
  canonicalBusy: false,
  streamBusy: false
}), false, "verified DOM completion must override a stale tab busy flag");

assert.equal(shouldShowChatBusy({
  networkState: "generating",
  tabBusy: true,
  responseCurrent: true,
  responseBusy: false,
  responseReady: true,
  responseLoading: false,
  canonicalBusy: false,
  streamBusy: false
}), true, "an actively generating network turn must not be hidden by an older ready response");

assert.equal(shouldShowChatBusy({
  networkState: "idle",
  tabBusy: true,
  responseCurrent: true,
  responseBusy: false,
  responseReady: true,
  responseLoading: true,
  canonicalBusy: false,
  streamBusy: false
}), true, "a locally loading next turn must keep the chat busy even if the previous response was ready");

console.log("✓ ChatGPT ERR_ABORTED and stale-busy recovery smoke test passed");
