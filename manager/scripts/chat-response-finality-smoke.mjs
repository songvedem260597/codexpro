import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { confirmChatResponseFinality } from "../src/chat-response-finality.js";
import { canAcceptNextChatMessage, shouldShowChatSettling } from "../src/chat-status.js";

const fragmentSignature = JSON.stringify(["user:1", "assistant:1", "52:fragment", ""]);
const fullSignature = JSON.stringify(["user:1", "assistant:1", "1755:full", ""]);

const firstFragment = confirmChatResponseFinality(null, {
  ready: true,
  source: "chatgpt_dom",
  signature: fragmentSignature,
  nowMs: 1_000,
  stabilityMs: 2_500
});
assert.equal(firstFragment.confirmed, false, "the first DOM final candidate must stay provisional");
assert.equal(firstFragment.reason, "candidate_started");

const stillFragment = confirmChatResponseFinality(firstFragment.candidate, {
  ready: true,
  source: "chatgpt_dom",
  signature: fragmentSignature,
  nowMs: 2_000,
  stabilityMs: 2_500
});
assert.equal(stillFragment.confirmed, false, "an unchanged DOM fragment inside the stability window must remain provisional");

const grewResponse = confirmChatResponseFinality(stillFragment.candidate, {
  ready: true,
  source: "chatgpt_dom",
  signature: fullSignature,
  nowMs: 2_200,
  stabilityMs: 2_500
});
assert.equal(grewResponse.confirmed, false, "a response that grows after a false final must restart the stability window");
assert.equal(grewResponse.reason, "candidate_started");
assert.equal(grewResponse.candidate.firstSeenAt, 2_200);

const stableFullResponse = confirmChatResponseFinality(grewResponse.candidate, {
  ready: true,
  source: "chatgpt_dom",
  signature: fullSignature,
  nowMs: 4_800,
  stabilityMs: 2_500
});
assert.equal(stableFullResponse.confirmed, true, "the complete DOM response may become final only after it stays unchanged long enough");
assert.equal(stableFullResponse.reason, "candidate_stable");

const authoritative = confirmChatResponseFinality(null, {
  ready: true,
  source: "canonical_api",
  signature: fullSignature,
  nowMs: 1_000,
  stabilityMs: 2_500
});
assert.equal(authoritative.confirmed, true, "authoritative response sources must not be delayed by the DOM stability guard");

assert.equal(shouldShowChatSettling({
  networkState: "completed",
  networkCompletedAt: "2026-08-30T10:37:30.000Z",
  nowMs: Date.parse("2026-08-30T10:37:35.000Z"),
  tabSettling: false,
  responseCurrent: true,
  responseIncomplete: false,
  responseReady: false,
  awaitingAssistant: false,
  finalityPending: true
}), true, "a provisional DOM final from a freshly completed turn must remain visibly settling");

assert.equal(shouldShowChatSettling({
  networkState: "completed",
  networkCompletedAt: "2026-08-30T10:37:30.000Z",
  nowMs: Date.parse("2026-08-30T10:38:00.000Z"),
  tabSettling: false,
  responseCurrent: true,
  responseIncomplete: false,
  responseReady: false,
  awaitingAssistant: false,
  finalityPending: true
}), false, "an old idle chat must not be shown as settling just because DOM finality is being rechecked");

assert.equal(canAcceptNextChatMessage({
  networkState: "completed",
  networkCompletedAt: "2026-08-30T10:37:30.000Z",
  nowMs: Date.parse("2026-08-30T10:37:35.000Z"),
  tabBusy: false,
  tabSettling: false,
  responseCurrent: true,
  responseBusy: false,
  responseReady: false,
  responseLoading: false,
  responseIncomplete: false,
  awaitingAssistant: false,
  finalityPending: true,
  canonicalBusy: false,
  streamBusy: false
}), false, "the composer must stay locked while DOM finality is being confirmed for the fresh turn");

const here = fileURLToPath(new URL(".", import.meta.url));
const mainSource = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
assert.match(mainSource, /if \(currentResponse\?\.finalityPending\)[\s\S]*?loadResponse\(profile, conversationId, true, true, false, false\)/, "finality polling must re-read the DOM rather than canonical-only state");
assert.match(mainSource, /finalityPending: currentResponse\?\.finalityPending/, "the send guard must receive finalityPending");
assert.match(mainSource, /shouldShowChatSettling\(\{[\s\S]*?finalityPending: responseCurrent && response\?\.finalityPending/, "the visible settling state must receive finalityPending");
assert.match(mainSource, /canAcceptNextChatMessage\(\{[\s\S]*?finalityPending: responseCurrent && response\?\.finalityPending/, "turn readiness must receive finalityPending");

console.log(`chat response finality smoke passed (${here})`);
