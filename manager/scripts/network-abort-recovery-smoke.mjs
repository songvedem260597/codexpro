import assert from "node:assert/strict";
import { isRecoverableAbortedChatNetworkFailure } from "../src/chat-status.js";

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

console.log("✓ ChatGPT ERR_ABORTED canonical-recovery smoke test passed");
