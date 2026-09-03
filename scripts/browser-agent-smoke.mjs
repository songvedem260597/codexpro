import assert from "node:assert/strict";
import "./connector-verification-smoke.mjs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canAcceptNextChatMessage, canVerifyRepoTaskUse, isRepoTaskCompletionCurrent, isRetryableChatTurnBusyError, shouldShowChatBusy, shouldShowChatSettling } from "../manager/src/chat-status.js";
import { cacheableTranscriptMessages, completedResponseNeedsDomFallback, discardProvisionalAssistantAfterLatestUser, isNetworkStreamCurrentGeneration, materializeTranscriptMessages, mergeNetworkStreamTranscript, mergeProgressiveResponseText, replaceCanonicalTranscript, transcriptAwaitingAssistant, trimRecentTranscriptMessages } from "../manager/src/chat-transcript.js";
import { projectSelectionChanged } from "../manager/src/chat-project.js";
import { buildChatResponseAuditRecord, responseAuditTextFingerprint } from "../manager/src/chat-response-audit.js";
import { CHATGPT_CONVERSATION_MESSAGE_LIMIT, conversationTotalMessageCount, shouldRolloverConversation } from "../manager/src/conversation-message-limit.js";
import { LONG_TASK_WATCHDOG_AFTER_MS, longRunningChatWatchdogCandidate } from "../manager/src/long-task-watchdog.js";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

assert.equal(CHATGPT_CONVERSATION_MESSAGE_LIMIT, 18, "ChatGPT conversations must roll over inside the requested 15-20 message safety range");
assert.equal(conversationTotalMessageCount({ totalMessageCount: 18, messageCount: 9, messages: [] }), 18, "the canonical total must win over the assistant-only response count");
assert.equal(conversationTotalMessageCount({ messageCount: 9, messages: [{ role: "user", text: "latest" }, { role: "assistant", text: "latest reply" }] }), 18, "legacy assistant counts must conservatively reconstruct the total conversation size");
assert.equal(shouldRolloverConversation({ totalMessageCount: 17 }), false, "a conversation below the safety limit must stay on the current ChatGPT tab");
assert.equal(shouldRolloverConversation({ totalMessageCount: 18 }), true, "a conversation at the safety limit must move the next request to a new ChatGPT tab");
assert.equal(shouldRolloverConversation({ totalMessageCount: 18 }, 0), false, "an invalid disabled limit must never create rollover loops");

const longTaskProfile = {
  profile_id: "chrome-long-task",
  connected: true,
  activity: "working",
  current_task_id: "cpt_1234567890abcdef12345678",
  current_task_title: "Build dự án rất lâu",
  conversation_tabs: [{ id: 77, active: true, busy: true, network_state: "generating", network_last_started_at: "2026-09-01T00:00:00.000Z", url: "https://chatgpt.com/c/12345678-abcd-1234-abcd-1234567890ab" }]
};
const longTaskJobs = [{ job_id: longTaskProfile.current_task_id, worker_id: longTaskProfile.profile_id, status: "running", started_at: "2026-09-01T00:00:00.000Z" }];
assert.equal(LONG_TASK_WATCHDOG_AFTER_MS, 30 * 60 * 1000, "long ChatGPT task checks must start only after 30 minutes");
assert.equal(longRunningChatWatchdogCandidate(longTaskProfile, longTaskJobs, Date.parse("2026-09-01T00:29:59.000Z")), null, "a 29-minute task must never be reloaded");
assert.deepEqual(longRunningChatWatchdogCandidate(longTaskProfile, longTaskJobs, Date.parse("2026-09-01T00:30:00.000Z")), {
  profileId: "chrome-long-task",
  taskId: "cpt_1234567890abcdef12345678",
  title: "Build dự án rất lâu",
  conversationId: "12345678-abcd-1234-abcd-1234567890ab",
  targetId: 77,
  startedAt: "2026-09-01T00:00:00.000Z",
  phase: "health",
  hardFailure: false,
  failureReason: "",
  networkState: "generating",
  networkError: "",
  connectionInterrupted: false,
  messageDeliveryTimedOut: false,
  rendererUnresponsive: false,
  attemptKey: "chrome-long-task:cpt_1234567890abcdef12345678:2026-09-01T00:00:00.000Z:health",
  ageMs: LONG_TASK_WATCHDOG_AFTER_MS
}, "a 30-minute running task must produce one stable audit identity");
const interruptedLongTask = longRunningChatWatchdogCandidate({
  ...longTaskProfile,
  conversation_tabs: [{ ...longTaskProfile.conversation_tabs[0], busy: false, network_state: "failed", network_error: "net::ERR_FAILED", connection_interrupted: true }]
}, longTaskJobs, Date.parse("2026-09-01T00:40:00.000Z"));
assert.equal(interruptedLongTask?.phase, "recovery", "a later interrupted transport must get a distinct one-shot recovery phase");
assert.equal(interruptedLongTask?.hardFailure, true, "an interrupted long task must require recovery even when the renderer still answers");
assert.match(interruptedLongTask?.attemptKey || "", /:recovery$/, "the recovery attempt must not be deduplicated by the earlier healthy 30-minute check");
assert.equal(longRunningChatWatchdogCandidate({ ...longTaskProfile, activity: "idle" }, [{ ...longTaskJobs[0], status: "completed" }], Date.parse("2026-09-01T01:00:00.000Z")), null, "a completed task must never be reloaded by the long-task watchdog");
assert.equal(longRunningChatWatchdogCandidate({ ...longTaskProfile, conversation_tabs: [{ ...longTaskProfile.conversation_tabs[0], long_task_watchdog_hung: true }] }, longTaskJobs, Date.parse("2026-09-01T01:00:00.000Z")), null, "a watchdog-hung conversation must remain terminal and never be audited again");

assert.equal(shouldShowChatSettling({ networkState: "completed", tabSettling: false, responseCurrent: true, responseIncomplete: true }), false, "completed network state must clear stale DOM settling");
assert.equal(shouldShowChatSettling({ networkState: "failed", tabSettling: true, responseCurrent: true, responseIncomplete: true }), true, "fresh tab settling must override a terminal network request");
assert.equal(shouldShowChatSettling({ networkState: "generating", tabSettling: true, responseCurrent: true, responseIncomplete: true }), true, "active generation may remain settling");
assert.equal(shouldShowChatBusy({ networkState: "completed", tabBusy: false, responseCurrent: true, responseBusy: true }), false, "completed network state must clear stale DOM busy state");
assert.equal(shouldShowChatBusy({ networkState: "completed", tabBusy: false, responseCurrent: true, responseBusy: true, canonicalBusy: true }), true, "canonical generation must keep the turn busy between tool-call network segments");
assert.equal(shouldShowChatBusy({ networkState: "completed", tabBusy: false, responseCurrent: true, responseBusy: true, streamBusy: true }), true, "a live tool stream must remain busy after the initial generation request completes");
assert.equal(shouldShowChatBusy({ networkState: "failed", tabBusy: true, responseCurrent: true, responseBusy: true }), true, "fresh tab busy state must override a terminal network request");
assert.equal(shouldShowChatBusy({ networkState: "generating", tabBusy: false, responseCurrent: true, responseBusy: false }), true, "generating network state must remain busy");
assert.equal(canAcceptNextChatMessage({ networkState: "completed", tabBusy: false, tabSettling: true, responseCurrent: true, responseBusy: false, responseIncomplete: false }), false, "a visibly settling turn must reject the next message so ChatGPT cannot steer the old turn");
assert.equal(shouldShowChatSettling({ networkState: "completed", networkCompletedAt: "2026-08-30T10:37:30.000Z", nowMs: Date.parse("2026-08-30T10:37:35.000Z"), tabSettling: false, responseCurrent: true, responseIncomplete: false, responseReady: false, awaitingAssistant: true }), true, "a freshly completed transport must keep settling while the latest user still has no verified final assistant response");
assert.equal(canAcceptNextChatMessage({ networkState: "completed", networkCompletedAt: "2026-08-30T10:37:30.000Z", nowMs: Date.parse("2026-08-30T10:37:35.000Z"), tabBusy: false, tabSettling: false, responseCurrent: true, responseBusy: false, responseReady: false, responseIncomplete: false, awaitingAssistant: true }), false, "a freshly completed transport with an unverified latest assistant must reject the next user message instead of mixing turns");
assert.equal(shouldShowChatSettling({ networkState: "completed", networkCompletedAt: "2026-08-30T10:37:30.000Z", nowMs: Date.parse("2026-08-30T10:38:00.000Z"), tabSettling: false, responseCurrent: true, responseIncomplete: false, responseReady: false, awaitingAssistant: true, finalityPending: true }), false, "opening an old idle chat must not revive a stale settling state");
assert.equal(canAcceptNextChatMessage({ networkState: "completed", networkCompletedAt: "2026-08-30T10:37:30.000Z", nowMs: Date.parse("2026-08-30T10:38:00.000Z"), tabBusy: false, tabSettling: false, responseCurrent: true, responseBusy: false, responseReady: false, responseIncomplete: false, awaitingAssistant: true, finalityPending: true }), true, "an old idle chat must accept the next message instead of staying locked as settling");
assert.equal(canAcceptNextChatMessage({ networkState: "completed", tabBusy: false, tabSettling: false, responseCurrent: true, responseBusy: false, responseReady: true, responseIncomplete: false, awaitingAssistant: false }), true, "a fully completed and verified turn may accept the next message");
assert.equal(canVerifyRepoTaskUse({ responseCurrent: true, responseReady: false, responseBusy: true, responseIncomplete: true, awaitingAssistant: true, tabBusy: false, tabSettling: false, canonicalBusy: true, streamBusy: false }), false, "repo verification must not retry while canonical generation is still active");
assert.equal(canVerifyRepoTaskUse({ responseCurrent: true, responseReady: true, responseBusy: false, responseIncomplete: false, awaitingAssistant: false, tabBusy: false, tabSettling: false, canonicalBusy: false, streamBusy: false }), true, "repo verification may run only after the final assistant response is settled");
assert.equal(isRepoTaskCompletionCurrent({ networkCompletedAt: "2026-08-30T10:37:26.000Z", repoTaskDispatchedAt: "2026-08-30T10:37:27.000Z" }), false, "a completion from the previous attempt must not verify a freshly retried task");
assert.equal(isRepoTaskCompletionCurrent({ networkCompletedAt: "2026-08-30T10:37:28.000Z", repoTaskDispatchedAt: "2026-08-30T10:37:27.000Z" }), true, "a completion after the retry dispatch may verify the reused task");
assert.equal(canVerifyRepoTaskUse({ responseCurrent: true, responseReady: true, responseBusy: false, responseIncomplete: false, awaitingAssistant: false, tabBusy: false, tabSettling: false, canonicalBusy: false, streamBusy: false, networkCompletedAt: "2026-08-30T10:37:26.000Z", repoTaskDispatchedAt: "2026-08-30T10:37:27.000Z" }), false, "settled DOM from an older attempt must not trigger task rollover");
assert.equal(isRetryableChatTurnBusyError(new Error("Đoạn chat vẫn đang hoàn tất lượt trước.")), true, "a fresh worker busy guard must be retried after the turn settles");
assert.equal(isRetryableChatTurnBusyError(new Error("Đoạn chat này đang xử lý yêu cầu khác.")), true, "a network busy race must be retried after the turn settles");
assert.equal(isRetryableChatTurnBusyError(new Error("Profile này đang gửi một yêu cầu khác. Hãy chờ network ACK trước khi gửi tiếp.")), true, "a profile-level send race must be retried without showing a false verification error");
assert.equal(isRetryableChatTurnBusyError(new Error("SEND_UNCERTAIN")), false, "an uncertain submission must never be retried as a harmless busy race");
assert.equal(projectSelectionChanged("C:\\repo\\one", "C:\\repo\\two"), true, "switching workspace must isolate the next request in a new ChatGPT conversation");
assert.equal(projectSelectionChanged("C:\\Repo\\One\\", "c:\\repo\\one"), false, "the same Windows workspace must not create a redundant ChatGPT conversation");

const cachedTranscript = materializeTranscriptMessages({
  conversationId: "conversation-1",
  text: "Phản hồi cũ vẫn phải còn",
  messages: []
}, "conversation-1");
assert.equal(cachedTranscript.length, 1, "a cached response must become a transcript message before optimistic send");
assert.equal(cachedTranscript[0].role, "assistant");
const newerCachedTranscript = materializeTranscriptMessages({
  conversationId: "conversation-1",
  text: "Phản hồi mới chưa vào canonical",
  messages: cachedTranscript
}, "conversation-1");
assert.equal(newerCachedTranscript.length, 2, "a newer cached response must not be hidden just because an older assistant message exists");
assert.equal(mergeProgressiveResponseText("Phần phản hồi đã nhận", ""), "Phần phản hồi đã nhận", "an empty post-reload snapshot must not erase the response checkpoint");
assert.equal(mergeProgressiveResponseText("Phần phản hồi đã nhận", "Phần phản hồi"), "Phần phản hồi đã nhận", "a shorter post-reload snapshot must not regress visible response text");
assert.equal(mergeProgressiveResponseText("Phần phản hồi", "Phần phản hồi đã nhận đủ"), "Phần phản hồi đã nhận đủ", "a longer cumulative response must extend the saved checkpoint");
assert.equal(mergeProgressiveResponseText("Phần một - phần hai đầy đủ", "phần hai đầy đủ - phần ba"), "Phần một - phần hai đầy đủ - phần ba", "an overlapping later fragment must append only its missing tail");
assert.equal(completedResponseNeedsDomFallback({ response_ready: true, canonical_available: false, network_state: "completed", text: "Đ", messages: [{ role: "user", text: "Làm task" }, { role: "assistant", text: "Đ" }] }), true, "a one-character DOM placeholder without canonical proof must trigger recovery");
assert.equal(completedResponseNeedsDomFallback({ response_ready: true, canonical_available: false, network_state: "completed", text: "OK", messages: [{ role: "user", text: "Reply OK" }, { role: "assistant", text: "OK" }] }), true, "a two-character unverified DOM response must remain recoverable");
assert.equal(completedResponseNeedsDomFallback({ response_ready: true, canonical_available: true, network_state: "completed", text: "OK", messages: [{ role: "user", text: "Reply OK" }, { role: "assistant", text: "OK" }] }), false, "a short response is valid once canonical confirms it");

const optimisticTranscript = [...cachedTranscript, { id: "optimistic-user-1", role: "user", text: "Yêu cầu mới", pending: true, submissionState: "pending", createdAt: "2026-08-29T00:00:00.000Z" }];
assert.deepEqual(cacheableTranscriptMessages(optimisticTranscript), cachedTranscript, "an outgoing message without a send result must never be persisted as confirmed chat history");
assert.deepEqual(cacheableTranscriptMessages([...cachedTranscript, { id: "optimistic-user-legacy", role: "user", text: "Tin giả từ cache cũ" }]), cachedTranscript, "legacy optimistic bubbles without send evidence must be removed during cache migration");
const generatedImageTranscript = trimRecentTranscriptMessages([
  { id: "image-user", role: "user", text: "Tạo ảnh chân dung" },
  { id: "image-assistant", role: "assistant", text: "", images: [{ id: "generated-1", dataUrl: "data:image/jpeg;base64,preview" }] }
]);
assert.deepEqual(generatedImageTranscript.map((message) => message.id), ["image-user", "image-assistant"], "an image-only assistant turn must remain visible in the transcript");
assert.deepEqual(cacheableTranscriptMessages(generatedImageTranscript), [{ id: "image-user", role: "user", text: "Tạo ảnh chân dung" }], "generated image data URLs must stay runtime-only and never bloat the transcript cache");
const firstStreamTranscript = mergeNetworkStreamTranscript(optimisticTranscript, {
  conversationId: "conversation-1",
  text: "Đang xử lý"
});
const updatedStreamTranscript = mergeNetworkStreamTranscript(firstStreamTranscript, {
  conversationId: "conversation-1",
  text: "Đã xử lý gần xong"
});
assert.equal(updatedStreamTranscript.filter((message) => message.id === "network-stream-assistant:conversation-1").length, 1, "network events must update one live response instead of flooding the transcript");
assert.equal(updatedStreamTranscript.at(-1).text, "Đã xử lý gần xong");
assert.equal(updatedStreamTranscript.at(-1).provisional, true, "network stream text must remain explicitly provisional until ChatGPT exposes a final response");
assert.ok(updatedStreamTranscript.some((message) => message.text === "Phản hồi cũ vẫn phải còn"), "network streaming must preserve the previous response");
assert.ok(updatedStreamTranscript.some((message) => message.text === "Yêu cầu mới"), "network streaming must preserve the optimistic user message");
assert.deepEqual(replaceCanonicalTranscript(updatedStreamTranscript, []), updatedStreamTranscript, "an empty transient canonical read must not erase the visible transcript");
const laggingCanonicalTranscript = replaceCanonicalTranscript(updatedStreamTranscript, [{ id: "canonical-1", role: "assistant", text: "Canonical" }], { nowMs: Date.parse("2026-08-29T00:01:00.000Z") });
assert.deepEqual(laggingCanonicalTranscript.map((message) => message.text), ["Canonical", "Yêu cầu mới"], "a populated but lagging canonical read must preserve a just-submitted optimistic user message");
const legacyOrphanTranscript = replaceCanonicalTranscript([
  { id: "canonical-old", role: "assistant", text: "Canonical" },
  { id: "optimistic-user-legacy", role: "user", text: "Tin chỉ tồn tại trong Manager" }
], [{ id: "canonical-old", role: "assistant", text: "Canonical" }]);
assert.deepEqual(legacyOrphanTranscript.map((message) => message.text), ["Canonical"], "a legacy optimistic bubble missing send evidence must not survive authoritative canonical reconciliation");
const expiredSubmittedTranscript = replaceCanonicalTranscript([
  { id: "canonical-old", role: "assistant", text: "Canonical" },
  { id: "optimistic-user-expired", role: "user", text: "Tin không bao giờ tới ChatGPT", submissionState: "submitted", createdAt: "2026-08-29T00:00:00.000Z" }
], [{ id: "canonical-old", role: "assistant", text: "Canonical" }], { nowMs: Date.parse("2026-08-29T00:11:00.000Z") });
assert.deepEqual(expiredSubmittedTranscript.map((message) => message.text), ["Canonical"], "a submitted optimistic bubble must expire when ChatGPT never materializes it");
const materializedCanonicalTranscript = replaceCanonicalTranscript(updatedStreamTranscript, [
  { id: "canonical-user-1", role: "user", text: "  Yêu cầu\u00a0mới  " },
  { id: "canonical-assistant-1", role: "assistant", text: "Đã nhận" }
]);
assert.deepEqual(materializedCanonicalTranscript.map((message) => message.id), ["optimistic-user-1", "network-stream-assistant:conversation-1"], "canonical materialization must preserve user and assistant identities so React does not remount the active turn");
assert.equal(materializedCanonicalTranscript.at(-1).text, "Đã nhận", "a final canonical response must replace rather than merge an unrelated progress fragment");
assert.notEqual(materializedCanonicalTranscript.at(-1).provisional, true, "canonical finalization must clear the provisional stream marker");
const reloadRegressedTranscript = replaceCanonicalTranscript([
  { id: "checkpoint-user", role: "user", text: "Sửa lỗi reload" },
  { id: "checkpoint-assistant", role: "assistant", text: "Phần phản hồi đã được lưu trước reload" }
], [
  { id: "reload-user", role: "user", text: "Sửa lỗi reload" },
  { id: "reload-assistant", role: "assistant", text: "Phần phản hồi" }
]);
assert.equal(reloadRegressedTranscript.at(-1).id, "checkpoint-assistant", "post-reload canonical updates must keep the existing assistant DOM identity");
assert.equal(reloadRegressedTranscript.at(-1).text, "Phần phản hồi đã được lưu trước reload", "a shorter post-reload assistant must not erase the saved response");
const reloadExtendedTranscript = replaceCanonicalTranscript(reloadRegressedTranscript, [
  { id: "reload-user-2", role: "user", text: "Sửa lỗi reload" },
  { id: "reload-assistant-2", role: "assistant", text: "Phần phản hồi đã được lưu trước reload và đây là phần nối thêm" }
]);
assert.equal(reloadExtendedTranscript.at(-1).text, "Phần phản hồi đã được lưu trước reload và đây là phần nối thêm", "later ChatGPT content must extend the saved response without sending another user message");
const previousCompleteTranscript = [
  { id: "previous-user-1", role: "user", text: "Yêu cầu cũ" },
  { id: "previous-assistant-1", role: "assistant", text: "Phản hồi cũ phải còn" },
  { id: "optimistic-user-2", role: "user", text: "Yêu cầu đang xử lý", submissionState: "submitted", createdAt: "2026-08-29T00:00:00.000Z" },
  { id: "network-stream-assistant:conversation-1", role: "assistant", text: "Đang gọi tool", provisional: true, endTurn: false }
];
const partialCanonicalTranscript = replaceCanonicalTranscript(previousCompleteTranscript, [
  { id: "canonical-user-1", role: "user", text: "Yêu cầu cũ" },
  { id: "canonical-assistant-1", role: "assistant", text: "Phản hồi cũ phải còn" },
  { id: "canonical-user-2", role: "user", text: "Yêu cầu đang xử lý" }
], { nowMs: Date.parse("2026-08-29T00:01:00.000Z") });
assert.deepEqual(partialCanonicalTranscript, previousCompleteTranscript, "a canonical snapshot ending at the latest user must not erase prior or streaming assistant responses while ChatGPT is still working");
assert.equal(transcriptAwaitingAssistant(partialCanonicalTranscript), true, "a live stream fragment must not count as the final response for the latest user");
assert.equal(completedResponseNeedsDomFallback({ network_state: "completed", response_ready: false, messages: partialCanonicalTranscript }), true, "a completed request with only a provisional assistant must recover canonical/DOM final content");
assert.equal(completedResponseNeedsDomFallback({ network_state: "generating", busy: true, response_ready: false, messages: partialCanonicalTranscript }), false, "live generation must keep streaming without unnecessary DOM fallback reads");
const terminalTranscript = discardProvisionalAssistantAfterLatestUser(partialCanonicalTranscript, { includeUnverified: true });
assert.deepEqual(terminalTranscript.map((message) => message.id), ["previous-user-1", "previous-assistant-1", "optimistic-user-2"], "terminal cleanup must keep prior verified exchanges and the latest user while removing the false progress response");
const missingLatestResponse = [
  { id: "cached-user", role: "user", text: "Yêu cầu cũ" },
  { id: "cached-assistant", role: "assistant", text: "Phản hồi cũ" },
  { id: "optimistic-user-latest", role: "user", text: "Yêu cầu mới đang thiếu response" }
];
assert.equal(transcriptAwaitingAssistant(missingLatestResponse), true, "a cache ending at the newest user must be treated as incomplete even when network tracking is idle");
const recoveredLatestResponse = replaceCanonicalTranscript(missingLatestResponse, [
  { id: "canonical-user-old", role: "user", text: "Yêu cầu cũ" },
  { id: "canonical-assistant-old", role: "assistant", text: "Phản hồi cũ" },
  { id: "canonical-user-latest", role: "user", text: "Yêu cầu mới đang thiếu response" },
  { id: "canonical-assistant-latest", role: "assistant", text: "Response mới phải được nối vào" }
]);
assert.equal(recoveredLatestResponse.at(-1).text, "Response mới phải được nối vào", "canonical recovery must append the missing latest response after the newest user");
assert.equal(transcriptAwaitingAssistant(recoveredLatestResponse), false, "canonical recovery must close the previously incomplete latest exchange");
assert.equal(completedResponseNeedsDomFallback({ network_state: "completed", response_ready: false, messages: missingLatestResponse }), true, "a completed request whose canonical transcript still ends at the user must fall back to the live DOM");
assert.equal(completedResponseNeedsDomFallback({ network_state: "idle", canonical_available: true, response_ready: false, messages: missingLatestResponse }), true, "an expired network record must not suppress DOM recovery when the canonical transcript still ends at the newest user");
assert.equal(completedResponseNeedsDomFallback({ network_state: "idle", canonical_available: false, response_ready: false, messages: [] }), true, "a transient canonical miss must fall back to the live DOM while Manager is still awaiting the latest assistant response");
assert.equal(completedResponseNeedsDomFallback({ network_state: "completed", response_ready: true, messages: recoveredLatestResponse }), false, "a completed canonical response must not trigger a redundant DOM read");
const fourExchanges = [1, 2, 3, 4].flatMap((turn) => [
  { id: `user-${turn}`, role: "user", text: `User ${turn}` },
  { id: `assistant-${turn}`, role: "assistant", text: `Assistant ${turn}` }
]);
const recentThreeExchanges = replaceCanonicalTranscript([], fourExchanges);
assert.deepEqual(recentThreeExchanges.map((message) => message.id), ["user-2", "assistant-2", "user-3", "assistant-3", "user-4", "assistant-4"], "Manager transcript must keep only the three most recent user/assistant exchanges");
const consecutiveUserFollowups = replaceCanonicalTranscript([], [
  { id: "user-1", role: "user", text: "Yêu cầu trước" },
  { id: "assistant-1", role: "assistant", text: "Phản hồi trước phải còn" },
  { id: "user-2", role: "user", text: "Sửa thêm phần A" },
  { id: "user-3", role: "user", text: "Sửa thêm phần B" },
  { id: "user-4", role: "user", text: "Sửa thêm phần C" }
]);
assert.deepEqual(consecutiveUserFollowups.map((message) => message.id), ["user-1", "assistant-1", "user-2", "user-3", "user-4"], "consecutive user follow-ups before one assistant response must count as one open exchange and must not evict prior responses");
const fragmentedAssistantTurns = replaceCanonicalTranscript([], [
  { id: "fragment-user-1", role: "user", text: "Turn one" },
  { id: "fragment-assistant-1a", role: "assistant", text: "Tool progress" },
  { id: "fragment-assistant-1b", role: "assistant", text: "Final one" },
  { id: "fragment-user-2", role: "user", text: "Turn two" },
  { id: "fragment-assistant-2a", role: "assistant", text: "Draft two" },
  { id: "fragment-assistant-2b", role: "assistant", text: "Final two" }
]);
assert.deepEqual(fragmentedAssistantTurns.map((message) => message.id), ["fragment-user-1", "fragment-assistant-1b", "fragment-user-2", "fragment-assistant-2b"], "each exchange must keep only the latest visible assistant response instead of rendering internal assistant fragments");
assert.equal(isNetworkStreamCurrentGeneration({ networkStartedAt: "2026-08-29T14:00:10.000Z", streamUpdatedAt: "2026-08-29T14:00:09.999Z" }), false, "a stream from the previous generation must never be appended after a new optimistic user message");
assert.equal(isNetworkStreamCurrentGeneration({ networkStartedAt: "2026-08-29T14:00:10.000Z", streamUpdatedAt: "2026-08-29T14:00:10.001Z" }), true, "a stream updated by the current generation may be rendered live");
const auditSource = {
  selected_source: "chatgpt_dom",
  chatgpt_dom: {
    source: "chatgpt_dom",
    available: true,
    message_count: 4,
    latest_user: { fingerprint: responseAuditTextFingerprint("Yêu cầu mới"), length: 12, preview: "Yêu cầu mới" },
    latest_assistant: { fingerprint: responseAuditTextFingerprint("Phản hồi mới"), length: 13, preview: "Phản hồi mới" },
    assistant_after_latest_user: { fingerprint: responseAuditTextFingerprint("Phản hồi mới"), length: 13, preview: "Phản hồi mới" }
  }
};
const missingManagerResponseAudit = buildChatResponseAuditRecord({
  profileId: "profile-1",
  conversationId: "conversation-1",
  sourceAudit: auditSource,
  managerMessages: [{ role: "user", text: "Yêu cầu mới" }],
  renderedMessages: [{ role: "user", fingerprint: responseAuditTextFingerprint("Yêu cầu mới") }]
});
assert.equal(missingManagerResponseAudit.comparison, "missing_in_manager_state", "audit must identify a ChatGPT DOM response lost before Manager state");
const missingRenderedResponseAudit = buildChatResponseAuditRecord({
  profileId: "profile-1",
  conversationId: "conversation-1",
  sourceAudit: auditSource,
  managerMessages: [{ role: "user", text: "Yêu cầu mới" }, { role: "assistant", text: "Phản hồi mới" }],
  renderedMessages: [{ role: "user", fingerprint: responseAuditTextFingerprint("Yêu cầu mới") }]
});
assert.equal(missingRenderedResponseAudit.comparison, "missing_in_manager_ui", "audit must distinguish a response held in state but missing from the rendered transcript");
const matchingResponseAudit = buildChatResponseAuditRecord({
  profileId: "profile-1",
  conversationId: "conversation-1",
  sourceAudit: auditSource,
  managerMessages: [{ role: "user", text: "Yêu cầu mới" }, { role: "assistant", text: "Phản hồi mới" }],
  renderedMessages: [
    { role: "user", fingerprint: responseAuditTextFingerprint("Yêu cầu mới") },
    { role: "assistant", fingerprint: responseAuditTextFingerprint("Phản hồi mới") }
  ]
});
assert.equal(matchingResponseAudit.comparison, "match", "audit must confirm the ChatGPT DOM response reaches the Manager UI unchanged");
const [browserOps, worker, server, httpSource, bridge, managerMain, managerPreload, managerUi, managerStyles, managerDiagnosticView, managerAppDropdown, managerChatScroll, manifestText, connectorInstaller, popupHtml, popupJs] = await Promise.all([
  readFile(join(root, "src", "browserOps.ts"), "utf8"),
  readFile(join(root, "chrome-extension", "service-worker.js"), "utf8"),
  readFile(join(root, "src", "server.ts"), "utf8"),
  readFile(join(root, "src", "http.ts"), "utf8"),
  readFile(join(root, "src", "browserExtensionBridge.ts"), "utf8"),
  readFile(join(root, "manager", "electron", "main.mjs"), "utf8"),
  readFile(join(root, "manager", "electron", "preload.cjs"), "utf8"),
  readFile(join(root, "manager", "src", "main.jsx"), "utf8"),
  readFile(join(root, "manager", "src", "styles.css"), "utf8"),
  readFile(join(root, "manager", "src", "diagnostic-log-view.jsx"), "utf8"),
  readFile(join(root, "manager", "src", "app-dropdown.jsx"), "utf8"),
  readFile(join(root, "manager", "src", "chat-scroll.js"), "utf8"),
  readFile(join(root, "chrome-extension", "manifest.json"), "utf8"),
  readFile(join(root, "chrome-extension", "connector-installer.js"), "utf8"),
  readFile(join(root, "chrome-extension", "popup.html"), "utf8"),
  readFile(join(root, "chrome-extension", "popup.js"), "utf8")
]);

const connectorMatcherSource = connectorInstaller.slice(
  connectorInstaller.indexOf("function connectorActionLabelMatches"),
  connectorInstaller.indexOf("function installedConnectorAction")
);
const connectorActionLabelMatches = new Function(`${connectorMatcherSource}; return connectorActionLabelMatches;`)();
assert.equal(connectorActionLabelMatches("actions for codexpro", "", true), true, "legacy connector action aria must remain recognized");
assert.equal(connectorActionLabelMatches("", "codexpro allow all", true), true, "current ChatGPT CodexPro permission-row text must be recognized");
assert.equal(connectorActionLabelMatches("", "codexpro conversation", false), false, "non-interactive conversation text must not be mistaken for an installed connector row");

const probeChatActivitySource = worker.slice(worker.indexOf("function probeChatActivityPage()"), worker.indexOf("async function chatDomActivityState"));
const tabPolicySource = worker.slice(worker.indexOf("function isChatGptTabUrl"), worker.indexOf("async function probeChatGptTabHealth"));
const planChatTabCleanup = Function("MAX_CHATGPT_TABS", "CHAT_TAB_HEALTH_FAILURES_TO_CLOSE", "conversationIdFromUrl", `${tabPolicySource}; return planChatTabCleanup;`)(6, 2, value => {
  try { return new URL(String(value || "")).pathname.match(/^\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || ""; } catch { return ""; }
});
const tabPolicyPlan = planChatTabCleanup([
  { id: 1, url: "https://chatgpt.com/c/recent-chat", active: true, last_accessed: 900 },
  { id: 2, url: "https://chatgpt.com/c/busy-chat", busy: true, last_accessed: 100 },
  { id: 3, url: "https://chatgpt.com/c/pinned-chat", pinned: true, last_accessed: 50 },
  { id: 4, url: "https://chatgpt.com/c/unreachable-chat", health_failures: 2, last_accessed: 200 },
  { id: 5, url: "https://chatgpt.com/#settings/Plugins", last_accessed: 300 },
  { id: 6, url: "https://chatgpt.com/c/old-chat", last_accessed: 400 },
  { id: 7, url: "https://chatgpt.com/c/recent-two", last_accessed: 500 },
  { id: 8, url: "https://example.com/", last_accessed: 1 }
], { maxTabs: 5, recentConversationIds: ["recent-chat", "recent-two"] });
assert.deepEqual(tabPolicyPlan.close_ids, [4, 5], "tab policy must close unreachable tabs first, then the oldest disposable ChatGPT tab until the cap is met");
assert.equal(tabPolicyPlan.reasons[4], "codexpro_unreachable");
assert.equal(tabPolicyPlan.reasons[5], "tab_limit");
assert.ok(!tabPolicyPlan.close_ids.includes(1) && !tabPolicyPlan.close_ids.includes(2) && !tabPolicyPlan.close_ids.includes(3), "tab policy must protect active, busy, and pinned tabs");
const runChatActivityProbe = ({ assistantText, controls = [], turnControls = [], includeLatestUser = true }) => {
  const assistantNode = { innerText: assistantText, textContent: assistantText };
  const userNode = { innerText: "latest user", textContent: "latest user" };
  const userTurn = {
    querySelector(selector) { return selector === '[data-message-author-role="user"]' ? userNode : null; },
    querySelectorAll: () => []
  };
  const assistantTurn = {
    querySelector(selector) { return selector === '[data-message-author-role="assistant"]' ? assistantNode : null; },
    querySelectorAll: (selector) => selector === 'button,[role="button"],summary' ? turnControls : []
  };
  const conversationTurns = includeLatestUser ? [userTurn, assistantTurn] : [assistantTurn];
  return Function("document", "getComputedStyle", `${probeChatActivitySource}; return probeChatActivityPage();`)(
    {
      querySelectorAll(selector) {
        if (selector === 'button,[role="button"]') return controls;
        if (selector === '[data-message-author-role="assistant"]') return [assistantNode];
        if (selector === '[data-testid^="conversation-turn-"]') return conversationTurns;
        return [];
      },
      body: { innerText: assistantText, textContent: assistantText }
    },
    () => ({ display: "block", visibility: "visible" })
  );
};
const visibleStopControl = {
  getBoundingClientRect: () => ({ width: 20, height: 20 }),
  getAttribute: (name) => name === "data-testid" ? "stop-button" : "",
  innerText: "",
  textContent: ""
};
const visibleCalledToolControl = {
  getBoundingClientRect: () => ({ width: 100, height: 20 }),
  getAttribute: () => "",
  innerText: "Called tool",
  textContent: "Called tool"
};
const domToolActivity = runChatActivityProbe({
  assistantText: "Khi connector hồi, tao sẽ tiếp tục ngay từ Bước 2.",
  controls: [visibleStopControl, visibleCalledToolControl],
  turnControls: [visibleCalledToolControl]
});
assert.equal(domToolActivity.busy, true, "a visible stop control must keep a tool turn busy after the initial request completes");
assert.equal(domToolActivity.source, "dom_tool", "visible ChatGPT tool calls must be classified separately from generic DOM settling");
assert.equal(domToolActivity.activity_text, "CodexPro đang gọi tool", "DOM tool status must not reuse stale assistant prose as live activity");
const domGenericActivity = runChatActivityProbe({ assistantText: "Phản hồi tạm chưa hoàn tất", controls: [visibleStopControl] });
assert.equal(domGenericActivity.source, "dom_stop");
assert.equal(domGenericActivity.response_ready, false, "a visible stop control must keep the current turn unfinished");
assert.equal(domGenericActivity.activity_text, "ChatGPT đang tiếp tục xử lý", "generic DOM work must use a stable status instead of assistant response text");
const domCompletedActivity = runChatActivityProbe({ assistantText: "Đã hoàn tất phản hồi.", controls: [] });
assert.equal(domCompletedActivity.busy, false, "a finished assistant turn must not remain busy when the stop control is gone");
assert.equal(domCompletedActivity.response_ready, true, "a finished text response after the latest user must become authoritative completion evidence");
assert.equal(domCompletedActivity.source, "dom_response_ready", "finished text responses must be distinguishable from stale generic DOM state");

assert.match(server, /task_title:[\s\S]*?words >= 4 && words <= 6/, "begin_repo_task must require a clear 4-6 word AI-generated task title");
assert.match(server, /task_kind: z\.enum\(\["general", "code"\]\)/, "every profile task must declare whether it needs coding context");
assert.match(server, /args\.task_kind === "code" \? await readGlobalRulesSnapshot\(\) : undefined[\s\S]*?args\.task_kind === "code" \? await requireCodexGraphForWorkspace/, "only code tasks may load global rules and CodexGraph");
assert.match(server, /proof\.taskKind === "general"[\s\S]*?global_rules_loaded: false[\s\S]*?codexgraph_active: false/, "general tasks must retain their title without loading coding context");
assert.match(server, /task_title_source: "ai"/, "repo task results must identify the AI task-title source");
assert.match(server, /title: "Register Profile Task"[\s\S]*?Registering the CodexPro task[\s\S]*?CodexPro task registered/, "the universal task-title call must not be mislabeled as a repo lock");
assert.match(server, /task_id:[\s\S]*?optional\(\)[\s\S]*?task_title:[\s\S]*?task_kind:[\s\S]*?root:[\s\S]*?optional\(\)/, "direct profile ChatGPT tasks must begin with an AI title, task kind, and a server-generated id");
assert.match(bridge, /browser-profile-tasks\.json/, "profile task titles must survive a runtime restart");
assert.match(bridge, /function inferProfileTaskConversationId\(profileId: string\)[\s\S]*?codexActivity[\s\S]*?network_stream_in_progress[\s\S]*?startedAt/, "begin_repo_task must bind the AI task to the most relevant working ChatGPT conversation");
assert.match(bridge, /task_conversation_id: entry\.taskConversationId[\s\S]*?current_task_conversation_id: profileTaskConversationIds\.get\(profile\.id\)/, "task conversation bindings must persist and be exposed to Manager after restart");
assert.match(bridge, /profileTaskConversationCandidateLog[\s\S]*?task_conversation_binding_source:[\s\S]*?task_conversation_candidates:/, "task registration diagnostics must preserve candidate-tab evidence for wrong-tab investigations");
assert.match(bridge, /profile-task-events\.jsonl/, "missing task titles must leave persistent profile/session diagnostics");
assert.match(bridge, /connector_profile_bound:[\s\S]*?connector_update_required:/, "Manager profile summaries must expose connector/profile identity state");
assert.match(bridge, /loadBrowserProfileTasks\(\)/, "profile task titles must load when the bridge starts");
assert.match(bridge, /persistBrowserProfileTasks\(\)/, "AI task titles must persist after begin_repo_task");
assert.match(bridge, /LONG_TASK_AUDIT_COMMAND_TIMEOUT_MS = 125_000[\s\S]*?action === "audit_long_running_chat"[\s\S]*?LONG_TASK_AUDIT_COMMAND_TIMEOUT_MS/, "the extension bridge must allow the bounded reload, replacement, and probe sequence to finish");
assert.ok(managerUi.includes('working || settling ? "Task hi\\u1ec7n t\\u1ea1i" : "Task g\\u1ea7n nh\\u1ea5t"'), "Manager must retain the last AI task title after completion");
assert.match(managerMain, /const MANAGER_VERSION = app\.getVersion\(\)/, "MCP client metadata must use the packaged Manager version");
assert.match(managerUi, /CodexPro Manager \{managerPackage\.version\}/, "Manager footer must use package.json instead of a stale hard-coded version");
assert.doesNotMatch(managerUi, /CodexPro Manager 0\.2\.\d+/, "Manager UI must not hard-code a release version");
assert.match(managerDiagnosticView, /function DiagnosticDropdown[\s\S]*?<AppDropdown[\s\S]*?ariaLabel=\{ariaLabel\}/, "Diagnostic filters must use the shared custom dropdown instead of clipped native selects");
assert.match(managerAppDropdown, /aria-haspopup="listbox"[\s\S]*?role="listbox"[\s\S]*?role="option"/, "The shared dropdown must expose accessible listbox semantics");
assert.doesNotMatch(managerDiagnosticView, /<select\b/, "Diagnostic toolbar must not regress to native select controls");
assert.match(managerStyles, /\.diagnostic-toolbar \{[^}]*grid-template-columns: minmax\(240px, 1fr\) auto[\s\S]*?\.diagnostic-filter-row \{[^}]*repeat\(4, minmax\(0, 1fr\)\)/, "Diagnostic toolbar must reserve a full row for four unclipped filters");
assert.match(managerMain, /function diagnosticIpcHandle[\s\S]*?envelopeError[\s\S]*?durationMs >= Number\(options\.slowMs\)[\s\S]*?catch \(error\)/, "Manager IPC diagnostics must capture envelope failures, slow operations, and thrown errors centrally");
for (const action of ["control-server", "setup-profile", "recover-profile-chat", "reload-profiles", "save-manager-settings", "send-profile-request", "get-profile-response", "get-repo-task-status", "inspect-project"]) {
  assert.match(managerMain, new RegExp(`action: \\"${action}\\"`), `important Manager action ${action} must be covered by persistent diagnostics`);
}
assert.match(managerMain, /uncaughtExceptionMonitor[\s\S]*?render-process-gone[\s\S]*?child-process-gone/, "Manager must persist main-process, renderer, and child-process failures");
assert.match(managerMain, /routinePollingAction[\s\S]*?browser_control:list_profiles[\s\S]*?browser_control:get_chat_response[\s\S]*?durationMs >= 2_000/, "routine MCP polling must only be persisted when it becomes slow");
assert.match(managerMain, /MANAGER_RUN_ID[\s\S]*?manager_run_id:[\s\S]*?manager_version:[\s\S]*?process_id:/, "every Manager diagnostic must carry run, version, and process correlation context");
assert.match(managerMain, /function recordBrowserProfileTransitions[\s\S]*?profile-state-transition[\s\S]*?mất heartbeat[\s\S]*?renderer không phản hồi[\s\S]*?Connection interrupted[\s\S]*?Message delivery timed out[\s\S]*?generation chuyển sang trạng thái lỗi[\s\S]*?chưa có task title/, "profile diagnostics must persist heartbeat, renderer, delivery, network, and missing-task-title state transitions");
assert.match(managerMain, /function recordChatResponseAuditDiagnostic[\s\S]*?chat-response-audit-mismatch[\s\S]*?expected_assistant[\s\S]*?manager_state_assistant[\s\S]*?manager_ui_assistant/, "response diagnostics must compare ChatGPT source, Manager state, and rendered UI fingerprints");
assert.match(managerMain, /action: "send-profile-request"[\s\S]*?repo_task_id[\s\S]*?submission_state[\s\S]*?generation_state[\s\S]*?manager_preflight_ms/, "send diagnostics must correlate task, submission, network, and Manager timing evidence");
assert.match(managerMain, /action: "get-profile-response"[\s\S]*?network_state[\s\S]*?response_ready[\s\S]*?dom_error[\s\S]*?canonical_available/, "response diagnostics must retain network, readiness, DOM, and canonical evidence");
assert.match(managerMain, /action: "get-repo-task-status"[\s\S]*?task_title[\s\S]*?task_kind[\s\S]*?verified/, "task verification diagnostics must retain the required title and classification");
assert.match(managerMain, /manager-started[\s\S]*?platform:[\s\S]*?electron_version:[\s\S]*?chrome_version:/, "incident logs must identify the runtime that produced them");
assert.match(managerMain, /function expectedRuntimeBuildId[\s\S]*?dist[\s\S]*?http\.js[\s\S]*?function activeRuntimeProfiles[\s\S]*?network_state[\s\S]*?generating/, "Manager startup must identify every profile with active task or generation evidence");
assert.match(managerMain, /function scheduleRuntimeFreshnessRetry[\s\S]*?runtimeFreshnessPromise = null[\s\S]*?ensureFreshRuntimeAfterManagerStart/, "a deferred runtime refresh must retry without leaving the startup freshness promise permanently cached");
assert.match(managerMain, /function ensureFreshRuntimeAfterManagerStart[\s\S]*?managerSmokeMode[\s\S]*?CODEXPRO_MANAGER_SMOKE_ALLOW_RUNTIME_RESTART[\s\S]*?runtime-build-refresh-skipped/, "Manager smoke must never restart the production runtime unless an integration test explicitly opts in");
assert.match(managerMain, /function ensureFreshRuntimeAfterManagerStart[\s\S]*?listBrowserProfilesThroughMcp[\s\S]*?runtime-build-refresh-profile-check-failed[\s\S]*?runtime-build-refresh-deferred[\s\S]*?activeProfiles\.length[\s\S]*?controlServer\("restart"\)[\s\S]*?runtime-build-refreshed/, "Manager startup must defer stale-runtime restart until profile evidence proves every task is idle, then verify the replacement build");
assert.match(managerMain, /createWindow\(\);[\s\S]{0,180}?void ensureFreshRuntimeAfterManagerStart\(\)/, "Manager startup must run the runtime freshness check after opening the UI, allowing non-blocking cache warm-up in between");
assert.match(server, /managerPrepared && !preparedOwner && !gateProfileId[\s\S]*?repo_task_owner_missing[\s\S]*?REPO_TASK_NOT_PREPARED/, "a Manager task must never start without a resolvable owning Chrome profile");
assert.match(managerMain, /did-fail-load[\s\S]*?preload-error[\s\S]*?console-message[\s\S]*?renderer-console/, "Electron page, preload, and renderer console failures must enter persistent diagnostics");
assert.match(managerUi, /GENERIC_TOOL_ACTIVITY_TEXT = "Codex Pro đang sử dụng công cụ"/, "Manager must collapse CodexPro tool calls to one generic activity label");
assert.match(managerUi, /function repoTaskEvidenceSummary[\s\S]*?GENERAL · không tải Rules\/CodexGraph[\s\S]*?CODE · Rules[\s\S]*?CodexGraph \$\{symbols\} symbols \/ \$\{relationships\} edges/, "Manager must distinguish title-only GENERAL evidence from CODE Rules/CodexGraph evidence");

for (const action of ["trusted_click", "hover", "scroll", "wait_for", "inspect_element", "evaluate", "batch"]) {
  assert.match(browserOps, new RegExp(`\\| \\"${action}\\"`), `dedicated browser action ${action} must be exposed`);
  assert.match(server, new RegExp(`\\"${action}\\"`), `browser_control schema must expose ${action}`);
}

assert.match(browserOps, /const CDP_SESSION_IDLE_MS = 30_000/);
assert.match(browserOps, /const persistentClients = new Map/);
assert.match(browserOps, /existing\?\.client\.isOpen\(\)/);
assert.match(browserOps, /action === "batch"/);
assert.match(browserOps, /Browser wait_for timed out/);
assert.match(browserOps, /Input\.dispatchMouseEvent/);
assert.match(browserOps, /private readonly listeners = new Map/);
assert.match(browserOps, /Timed out connecting to the Chrome tab[\s\S]*?socket\.close\(\)/, "a timed-out CDP connection must close its half-open socket");
assert.match(browserOps, /typeof message\.method === "string"/);
assert.match(browserOps, /Network\.requestWillBeSent/);
assert.match(browserOps, /Runtime\.consoleAPICalled/);
assert.match(browserOps, /withCdpTrace/);
assert.match(browserOps, /sanitizedTraceUrl/);
assert.match(browserOps, /url\.searchParams\.set\(key, "<redacted>"\)/, "CDP trace must redact query values");
assert.match(browserOps, /const targetMutationTails = new Map/);
assert.match(browserOps, /serializeTargetMutation/);
assert.match(browserOps, /semanticSnapshotExpression/);
assert.match(browserOps, /__codexproSemanticRegistry/);
assert.match(browserOps, /MutationObserver/);
const dedicatedBatch = browserOps.slice(browserOps.indexOf('if (action === "batch")'), browserOps.indexOf('if (action === "snapshot")'));
assert.match(dedicatedBatch, /executeResolved/);
assert.doesNotMatch(dedicatedBatch, /runBrowserControl/, "dedicated batch must not resolve the target/client again per step");

assert.match(worker, /const DEBUGGER_SESSION_IDLE_MS = 30000/);
assert.match(worker, /const debuggerSessionsByTab = new Map\(\)/);
assert.match(worker, /async function acquireDebuggerTab/);
assert.match(worker, /function releaseDebuggerTab/);
assert.match(worker, /persistent_debugger:true/);
assert.match(worker, /if\(action==='batch'\)/);
assert.match(worker, /if\(action==='wait_for'\)/);
assert.match(worker, /if\(action==='inspect_element'\)/);
assert.match(worker, /if\(action==='evaluate'\)/);
assert.match(worker, /WORKER_BUSY:/, "extension reload must refuse while a worker is generating");
assert.match(worker, /reconcileChatNetworkCompletion/, "canonical/stream completion must reconcile stuck network state");
assert.match(worker, /networkStream\.completed/, "stream completion must end a generation without waiting for CDP loadingFinished");
assert.match(worker, /network_stream_activity_text:visibleNetworkStreamActivityText/, "worker responses must expose only currently live CodexPro tool activity separately from assistant text");
assert.match(worker, /network_stream_in_progress:networkStreamInProgress/, "worker responses must expose whether the tool stream is still open");
assert.match(worker, /streamBusy\?\(streamActivity\|\|'Codex Pro đang sử dụng công cụ'\)/, "profile status must prefer generic live tool activity over stale DOM activity");
assert.match(worker, /probeCanonicalCompletion/, "tracker timeout must verify canonical response before reporting failure");
assert.match(worker, /function probeChatActivityPage/, "profile status must supplement network state with a lightweight DOM activity probe");
assert.match(worker, /if\(!Number\.isInteger\(tabId\)\)return \{available:false,busy:false,source:'',activity_text:''\};/, "DOM activity probing must also run for ChatGPT tabs that have not received a /c/ conversation URL yet");
assert.doesNotMatch(worker, /if\(!Number\.isInteger\(tabId\)\|\|!conversationId\)/, "a new/root ChatGPT tab must not be forced idle just because it has no conversation id yet");
assert.match(worker, /const domActivityRelevant=Boolean\(conversationId\|\|networkState\.busy\|\|canonicalActivity\.busy\|\|cachedDomActivity\?\.busy\|\|networkObservedAt>0&&Date\.now\(\)-networkObservedAt<DOM_ACTIVITY_RECENT_NETWORK_MS\)/, "guest chats without a /c/ id must receive DOM probes only while recent or busy");
assert.match(worker, /const shouldProbeDom=Boolean\(domActivityRelevant&&\(tab\.active\|\|networkState\.busy\|\|canonicalActivity\.busy\|\|cachedDomActivity\?\.busy/, "idle background ChatGPT tabs must not receive unconditional DOM probes");
assert.match(worker, /if\(generationEndpoint==='\/unauth-mweb\/conversation\/prepare'\)chatCanonicalActivityByTab\.delete\(details\.tabId\)/, "completed guest prepares must release the canonical busy flag and defer continuing activity to the DOM probe");
assert.match(worker, /for\(const tabId of chatDomActivityByTab\.keys\(\)\)if\(!liveTabIds\.has\(tabId\)\)chatDomActivityByTab\.delete\(tabId\)/, "closed tabs must be pruned from the DOM activity cache");
assert.match(worker, /value\.includes\('settings'\)\|\|value\.includes\('cai dat'\)/, "connector setup must recognize Vietnamese Settings");
assert.match(worker, /value\.includes\('connection'\)\|\|value\.includes\('ket noi'\)/, "connector setup must recognize Vietnamese Connection");
assert.match(connectorInstaller, /aria === 'thao tac voi plugin'/, "connector migration must recognize the Vietnamese plugin-actions label");
assert.match(connectorInstaller, /connectorConnectionStatus\(connectionText\) === 'connected'/, "connector setup must require a positive connection state instead of matching disconnected");
assert.match(worker, /testId==='stop-button'/, "DOM activity probe must recognize ChatGPT's stop control");
assert.match(worker, /const domToolBusy=Boolean\(domActivity\.busy&&domActivity\.source==='dom_tool'\)/, "DOM tool calls must remain working after the initial network request completes");
assert.match(worker, /busy:hungAudit\?false:networkBusy\|\|domImageBusy\|\|domToolBusy\|\|canonicalBusy/, "profile status must treat image generation, canonical generation, and active DOM tool calls as working unless the one-shot watchdog marked the tab hung");
assert.match(worker, /settling:hungAudit\?false:!networkBusy&&!domImageBusy&&!domToolBusy&&!canonicalBusy&&domActivity\.busy/, "only non-image, non-tool, non-canonical DOM activity may use the finalizing state, and hung tabs must stop settling");
assert.match(worker, /activity_text:hungAudit\?'Tab bị treo · watchdog đã dừng retry':streamBusy\?/, "active ChatGPT work must expose one concise network-or-DOM activity line while watchdog-hung tabs show a terminal warning");
assert.match(worker, /connector_server_fingerprint:String\(stored\.connectorServerFingerprint\|\|''\)/, "worker heartbeats must report the connector URL fingerprint");
assert.match(worker, /const token=endpoint\.searchParams\.get\('codexpro_token'\)[\s\S]*?headers\.authorization=`Bearer \$\{token\}`/, "connector verification must preserve token auth even when an intermediary drops the MCP query token");
assert.match(worker, /Tool activity proves that some CodexPro definition is callable[\s\S]*?return false/, "tool activity alone must not falsely verify a profile-bound connector");
assert.match(worker, /scheduleDomActivityRefresh/, "DOM settling must refresh until ChatGPT becomes idle");
assert.match(worker, /async function recentConversationList[\s\S]*?promiseWithTimeout\([\s\S]*?fetchRecentConversationsPage[\s\S]*?DOM_ACTION_TIMEOUT_MS/, "a hung active renderer must not block the extension poll loop and heartbeat");
assert.match(worker, /const heartbeat=setInterval\([\s\S]*?profileInfo\(\)[\s\S]*?\/register[\s\S]*?10000\);[\s\S]*?finally\{clearInterval\(heartbeat\);polling=false;\}/, "profile heartbeat must continue independently while tab and DOM probes are slow");
assert.match(worker, /const heartbeat=setInterval\([\s\S]*?tabInventory\(\)[\s\S]*?tab_inventory[\s\S]*?\/register/, "heartbeat must reconcile lightweight tab inventory even when the full poll loop is blocked");
assert.match(worker, /chrome\.tabs\.onRemoved\.addListener\([\s\S]*?scheduleRealtimeProfilePush\(0\)/, "closing the last ChatGPT tab must immediately clear the Manager profile snapshot");
assert.match(worker, /if\(action==='recover_chat_tab'\)[\s\S]*?WORKER_BUSY:[\s\S]*?replaceUnresponsiveChatTab/, "manual tab recovery must refuse active generations and replace only an idle renderer");
const longTaskAuditSource = worker.slice(worker.indexOf("if(action==='audit_long_running_chat')"), worker.indexOf("if(action==='recover_chat_tab')"));
assert.match(longTaskAuditSource, /claimLongTaskAudit[\s\S]*?preflight[\s\S]*?chrome\.tabs\.reload\(tab\.id\)[\s\S]*?waitForLongTaskRenderer[\s\S]*?status=reloadProbe\.responsive\?'responsive_after_reload':'hung'/, "the 30-minute audit must preflight, reload exactly once only when needed, and then stop");
assert.equal((longTaskAuditSource.match(/chrome\.tabs\.reload\(/g) || []).length, 1, "a long-task audit must contain exactly one tab reload");
assert.equal((longTaskAuditSource.match(/replaceUnresponsiveChatTab\(/g) || []).length, 0, "a watchdog-detected hung renderer must stop instead of opening replacement tabs");
assert.match(longTaskAuditSource, /already_attempted:true[\s\S]*?status:'hung'[\s\S]*?retry_allowed:false/, "repeated audits must be deduplicated and an unresponsive tab must be marked hung with retries disabled");
assert.match(worker, /LONG_TASK_AUDIT_STORAGE_KEY[\s\S]*?chrome\.storage\.local/, "the one-shot audit marker must survive extension and Manager restarts");
assert.match(worker, /long_task_watchdog_hung:Boolean\(hungAudit\)/, "profile snapshots must retain the watchdog's hung marker");
assert.match(worker, /recentConversationCache=\{at:0,items:\[\]\}[\s\S]*?long_task_watchdog_hung:Boolean\(hungAudit\)/, "hung conversation markers must invalidate and repopulate the recent-conversation cache");
assert.match(worker, /function stopChatGenerationPage[\s\S]*?testId==='stop-button'[\s\S]*?stopControl\.click\(\)/, "task stop must click only ChatGPT's visible stop-generation control");
assert.match(worker, /if\(action==='stop_chat_generation'\)[\s\S]*?stopChatGenerationPage[\s\S]*?stopped:Boolean\(result\.stopped\)/, "worker must expose a bounded stop-generation command");
assert.match(server, /"stop_chat_generation"/, "browser_control schema must expose stop_chat_generation");
assert.match(server, /"audit_long_running_chat"/, "browser_control schema must expose the one-shot long-task audit");
assert.match(server, /task_id: args\.task_id[\s\S]*?started_at: args\.started_at[\s\S]*?attempt_key: args\.attempt_key/, "browser_control must forward the persistent one-shot audit identity to the extension");
assert.match(worker, /async function replaceUnresponsiveChatTab[\s\S]*?chrome\.tabs\.create[\s\S]*?waitForTab[\s\S]*?removeTabWithReason\(replacedTabId,'renderer_replacement_completed'\)/, "renderer recovery must load a replacement before closing the exact stuck tab");
assert.match(worker, /dom_replaced=true[\s\S]*?recovery_tab_id/, "stale-response reload recovery must escalate to replacing a renderer that stays unresponsive");
assert.match(worker, /conversation\|steer_turn/, "ChatGPT steer_turn must be tracked as a generation request");
assert.match(worker, /const staleActivity=Boolean\(injected\.result\.busy\)/, "canonical completion must recover a tab whose DOM is still stuck busy");
assert.match(worker, /chatDomActivityState\(tab\.id,conversationId,\{maxAgeMs:750\}\)/, "worker send must reuse only a sub-second DOM activity probe before submitting");
assert.match(worker, /num_turns=6/, "canonical transcript reads must request only the three most recent user/assistant exchanges");
assert.doesNotMatch(worker, /num_turns=40/, "canonical transcript reads must not fetch the old 20-exchange window");
assert.match(worker, /Array\.isArray\(payload\?\.messages\)/, "canonical transcript reads must parse the bounded messages payload directly");
assert.match(worker, /function canonicalResponseSupersedesDom[\s\S]*?if\(domHasResponse&&!canonicalHasResponse\)return false/, "a lagging canonical snapshot must not erase a newer assistant response already rendered in the DOM");
assert.match(worker, /const canonicalGenerationMatches=canonicalMatchesCurrentGeneration[\s\S]*?const currentCanonical=canonical\.ok&&!canonicalGenerationMatches/, "response reads must gate canonical content by the current generation");
assert.match(worker, /short_dom_response_unverified/, "an unverified one-character DOM placeholder must be diagnosed instead of finalized");
assert.match(worker, /function withResponseAudit[\s\S]*?chatgpt_dom[\s\S]*?canonical_api[\s\S]*?network_stream/, "worker response reads must preserve separate ChatGPT DOM, canonical, and network fingerprints");
assert.doesNotMatch(worker, /canonical\.response_ready\|\|canonical\.busy\|\|canonicalText\.length>domTextBeforeMerge\.length/, "canonical busy state alone must never overwrite a newer DOM transcript");
assert.match(worker, /browserElementActionPage/);
assert.match(worker, /__codexproSemanticRegistry/);
assert.match(worker, /subscribeDebuggerEvents/);
assert.match(worker, /withExtensionCdpTrace/);
assert.match(worker, /url\.searchParams\.set\(key,'<redacted>'\)/, "extension trace must redact query values");
assert.match(worker, /serializeBrowserTabMutation/);
assert.match(worker, /Page\.captureScreenshot/);
assert.doesNotMatch(worker, /chrome\.tabs\.captureVisibleTab/, "extension screenshots must not activate/capture the foreground tab");
assert.doesNotMatch(worker, /composer_html|connector_debug/, "generic snapshots must not contain ChatGPT-specific diagnostics");
assert.match(worker, /chatNetworkPostWaitersByTab/, "attachment upload waits must subscribe to network events");
const attachmentWait = worker.slice(worker.indexOf("async function waitForAttachmentUploadNetwork"), worker.indexOf("function shouldUseTrustedClickFallback"));
assert.doesNotMatch(attachmentWait, /setTimeout\(resolve,100\)/, "attachment upload waits must not poll every 100 ms");
const extensionBatch = worker.slice(worker.indexOf("if(action==='batch')"), worker.indexOf("if(action==='snapshot')"));
assert.match(extensionBatch, /executeOnTab/);
assert.doesNotMatch(extensionBatch, /await execute\(/, "extension batch must not resolve the tab again per step");
assert.doesNotMatch(worker, /if\(action==='press'\)\{\s*const target=\{tabId:tab\.id\};await chrome\.debugger\.attach/, "press must not attach/detach a fresh debugger session per action");

const openProfileChat = managerMain.slice(managerMain.indexOf("async function openProfileChat"), managerMain.indexOf("async function reloadChromeProfiles"));
assert.match(openProfileChat, /if \(!resolvedTargetId\)[\s\S]*?action: "open_tab"[\s\S]*?url: conversationId \? `https:\/\/chatgpt\.com\/c\/\$\{conversationId\}` : "https:\/\/chatgpt\.com\/"/, "Manager must create a ChatGPT tab in the selected online profile when none is open");
assert.match(openProfileChat, /action: "activate_tab"[\s\S]*?}, 32000\)/, "Manager must wait longer than the 25-second extension bridge command timeout");
assert.match(openProfileChat, /catch \(error\) \{[\s\S]*?else \{\s*activationError = error;\s*\}[\s\S]*?focusChromeWindow\(title/, "a delayed non-stale activate acknowledgement must still verify whether Chrome actually opened");
assert.match(openProfileChat, /activation_acknowledgement_delayed: Boolean\(activationError\)/, "open-profile diagnostics must expose delayed activation acknowledgements");
assert.match(openProfileChat, /session = await timedOpenPhase\("mcp_session_open_ms"[\s\S]*?const callBrowserControl = \(args, timeoutMs\) => localMcpToolInSession\(session, "browser_control", args, timeoutMs\)/, "open-profile must reuse one MCP session instead of reinitializing transport for every browser command");
assert.match(openProfileChat, /let navigation = null[\s\S]*?navigation = await timedOpenPhase\("navigate_ms"[\s\S]*?callBrowserControl[\s\S]*?target_conversation_id: staleTargetRecovered \? "" : targetConversationId[\s\S]*?navigation,\s*activation:/, "open-profile results must preserve timed navigation evidence and clear a stale conversation after fresh-chat fallback");
assert.match(openProfileChat, /open_phase_timings:[\s\S]*?mcp_session:[\s\S]*?total_ms:/, "open-profile diagnostics must expose a phase breakdown including MCP session timing and total latency");
assert.match(openProfileChat, /finally \{[\s\S]*?if \(session\) void closeLocalMcpSession\(session\)/, "open-profile must release its reused MCP session without adding close latency to the foreground critical path");
assert.match(managerMain, /codexpro:open-profile-chat[\s\S]*?logSuccess: true[\s\S]*?selection_reason:[\s\S]*?activation_target_id:[\s\S]*?window_focus:/, "every successful open-profile request must persist the requested target and actual activation evidence");
assert.match(managerUi, /action: "profile-tab-open-selection"[\s\S]*?tab_candidates:[\s\S]*?action: "profile-tab-open-result"[\s\S]*?activation_target_id:[\s\S]*?action: "profile-tab-open-error"/, "renderer diagnostics must capture tab candidates, selection reason, activation result, and failures");
assert.match(managerUi, /className="button primary profile-chat"[\s\S]*?disabled=\{!profile\.connected \|\| !connectorInstalled\}[\s\S]*?CodexPro sẽ tự mở tab ChatGPT khi gửi/, "an online prepared profile must allow opening the composer before a ChatGPT tab exists");
assert.match(managerUi, /const noChatGpt = profile\.connected && profile\.activity === "no_chatgpt"[\s\S]*?CHROME CHẠY NỀN[\s\S]*?CHƯA MỞ CHATGPT/, "a connected background profile without ChatGPT tabs must not be labeled idle");
assert.match(managerUi, /profile\.chatgpt_tab_count[\s\S]*?tab ChatGPT/, "profile metadata must show ChatGPT tab count instead of every Chrome tab");
assert.match(managerMain, /async function recoverProfileChatTab[\s\S]*?action: "recover_chat_tab"[\s\S]*?60000/, "Manager must expose the bounded replace-tab recovery command");
assert.match(managerMain, /async function auditLongRunningProfileChat[\s\S]*?action: "audit_long_running_chat"[\s\S]*?attempt_key:[\s\S]*?135000/, "Manager must route one-shot 30-minute audits through a timeout that covers one reload, one replacement, and both bounded probes");
assert.match(managerMain, /codexpro:audit-long-running-profile-chat[\s\S]*?auditLongRunningProfileChat\(payload\)/, "Manager IPC must expose long-task audits to the renderer");
assert.match(managerPreload, /auditLongRunningProfileChat: \(payload\) => invoke\("codexpro:audit-long-running-profile-chat", payload\)/, "preload must expose auditLongRunningProfileChat");
assert.match(managerUi, /longRunningChatWatchdogCandidate[\s\S]*?api\.auditLongRunningProfileChat[\s\S]*?long-task-watchdog-hung[\s\S]*?NEW_CHAT_TARGET/, "a hung long-running task must be warned once and force the next task onto a fresh conversation");
assert.match(managerMain, /async function stopProfileTask[\s\S]*?action: "stop_chat_generation"[\s\S]*?15000/, "Manager must route task stop through the bounded MCP command");
assert.match(managerMain, /codexpro:stop-profile-task[\s\S]*?stopProfileTask\(payload\)/, "Manager IPC must expose task stop to the renderer");
assert.match(managerPreload, /stopProfileTask: \(payload\) => invoke\("codexpro:stop-profile-task", payload\)/, "preload must expose stopProfileTask");
assert.match(managerUi, /async function stopControlTask[\s\S]*?api\.stopProfileTask[\s\S]*?onStop=\{\(task\) => void stopControlTask\(task\)\}/, "Control Center must wire task stop from UI to preload");

assert.match(server, /steps: z\.array\(z\.object/);
assert.match(server, /timeout_ms: z\.number\(\)\.int\(\)\.min\(100\)\.max\(60000\)/);
assert.match(server, /steps: Array\.isArray\(args\.steps\)/);
for (const locator of ["ref", "role", "name", "placeholder", "label", "test_id", "nth"]) assert.match(server, new RegExp(`${locator}:`));
assert.match(server, /trace_ms/);
assert.match(server, /delta:/);

assert.match(bridge, /subscribeBrowserExtensionProfiles/);
assert.match(bridge, /const chatgptTabSummaries = chatgptTabs[\s\S]*?chatgpt_tabs: chatgptTabSummaries/, "profile summaries must retain an open ChatGPT tab even when its URL has no conversation id yet");
assert.match(bridge, /Array\.isArray\(body\.tab_inventory\)[\s\S]*?existingTabsById[\s\S]*?profile\.tabs = body\.tab_inventory/, "lightweight heartbeat inventory must remove stale tabs while preserving enriched state for tabs that still exist");
assert.match(bridge, /const observedCodexProToolActivity = conversationSummaries\.some/, "bridge must retain live CodexPro tool activity as diagnostics");
assert.match(bridge, /const connectorInstalled = profile\.connectorInstalled && connectorProfileBound/, "profile summaries must require the installed connector fingerprint to match the Chrome profile");
assert.match(bridge, /CodexPro đang gọi tool qua connector cũ chưa gắn đúng profile/, "profile summaries must explain activity from an old unbound connector");
assert.match(bridge, /function pruneExpiredProfiles/);
assert.match(bridge, /profileWorkspaceRoots\.delete\(id\)[\s\S]*?profileWorkspaceBindings\.delete\(id\)/, "expired extension profiles must release workspace maps");
assert.match(bridge, /const PROFILE_TTL_MS = 3 \* 60_000[\s\S]*?const PROFILE_RETENTION_MS = 24 \* 60 \* 60_000/, "normal Chrome heartbeat expiry must tolerate MV3 suspension and macOS sleep while retaining offline metadata for a day");
assert.match(bridge, /const visibleProfiles = \[\.\.\.state\.profiles\.values\(\)\][\s\S]*?browserProfileRetentionState\(profile, now\)\.visible/, "source Chrome profiles without a live heartbeat must remain visible as offline cards instead of disappearing");
assert.match(bridge, /function scheduleProfileExpiryNotification[\s\S]*?browserProfileRetentionState\(profile, now\)\.nextTransitionAt[\s\S]*?scheduleProfileNotification\(state\)/, "the bridge must publish both heartbeat-offline and final-retention transitions");
assert.match(bridge, /if \(state\.activeProfileId && !visibleProfiles\.some[\s\S]*?browserProfileRetentionState\(profile, now\)\.connected[\s\S]*?state\.activeProfileId = undefined/, "an offline active profile must release active ownership without removing its card");
assert.match(bridge, /const \{ connected \} = browserProfileRetentionState\(profile, now\)[\s\S]*?connected,/, "the Manager must receive retained source profiles with an explicit offline state after heartbeat expiry");
assert.match(bridge, /const PROFILE_RECONNECT_WAIT_MS = 45_000/, "a retained Chrome profile must get a bounded reconnect window");
assert.match(bridge, /const waitingForReconnect = Date\.now\(\) - profile\.lastSeen > PROFILE_TTL_MS/, "a stale heartbeat must enter reconnect mode instead of being rejected immediately");
assert.match(bridge, /function markCommandDispatched[\s\S]*?pending\.waitingForReconnect = false[\s\S]*?pending\.timeoutMs/, "a reconnected profile must receive the full action timeout after command dispatch");
assert.match(bridge, /waitingForReconnect \? PROFILE_RECONNECT_WAIT_MS : timeoutMs/, "a stale profile command must wait only for the bounded reconnect deadline");
assert.match(bridge, /bridgeErrorEnvelope/);
assert.match(bridge, /code: String\(envelope\.code/);
assert.match(server, /function errorEnvelope/);
assert.match(server, /structuredContent: \{ error: errorEnvelope\(error\) \}/);
assert.match(httpSource, /app\.get\("\/browser-events"/);
assert.match(httpSource, /text\/event-stream/);
assert.match(managerMain, /startBrowserProfileEventStream/);
assert.match(managerMain, /async function waitForRuntimeBuild\([\s\S]*?Date\.now\(\) \+ timeoutMs[\s\S]*?setTimeout\(resolve, 750\)[\s\S]*?runtimeBaseStatus\(\{ forceRefresh: true \}\)/, "Manager must wait for a restarted runtime to expose its new build before reporting failure");
assert.match(managerMain, /restartAttempt = await controlServer\("restart"\)[\s\S]*?waitForRuntimeBuild\(expectedBuildId, restartAttempt\)/, "runtime freshness checks must verify the restarted build across the bounded startup window");
assert.match(managerMain, /Promise\.allSettled\(\[[\s\S]*?status[\s\S]*?--porcelain=v2[\s\S]*?log[\s\S]*?remote[\s\S]*?get-url/, "project summaries must collect independent Git metadata concurrently");
assert.match(managerMain, /branch\.upstream[\s\S]*?list-projects phase breakdown[\s\S]*?discovery_ms[\s\S]*?summaries_ms/, "project discovery must reuse porcelain branch metadata and log phase timings");
assert.match(managerMain, /SCHEDULED_TASK_CACHE_MS[\s\S]*?scheduledTaskCache[\s\S]*?scheduledTaskPromise[\s\S]*?async function scheduledTask\(options = \{\}\)/, "Manager must cache and coalesce scheduled task reads");
assert.match(managerMain, /scheduledTask\(\{ forceRefresh \}\)[\s\S]*?scheduledTask\(\{ forceRefresh: true \}\)/, "forced runtime checks and restarts must bypass stale scheduled task data");
assert.match(managerMain, /latestBrowserProfileStream[\s\S]*?cachedBrowserProfileForSend/, "Manager must cache the live browser profile stream for latency-sensitive sends");
assert.match(managerMain, /latestBrowserProfileStream = \{ connected: true, checkedAt:[\s\S]*?profiles: payload\.profiles \}/, "browser-events payloads must refresh the send-side profile cache");
assert.match(managerMain, /latestBrowserProfileStream = \{ \.\.\.latestBrowserProfileStream, connected: false \}/, "a broken browser event stream must disable the send-side cache");
assert.match(managerMain, /selectedConversationTab\?\.busy \|\| selectedNetworkState === "generating"/, "Manager backend must reject active network generations");
assert.doesNotMatch(managerMain, /selectedConversationTab\?\.busy \|\| selectedConversationTab\?\.settling/, "Manager backend must leave cached DOM settling decisions to the worker's fresh probe");
const sendProfileRequestSource = managerMain.slice(managerMain.indexOf("async function sendProfileRequestUnlocked"), managerMain.indexOf("async function sendProfileRequest(payload)"));
assert.match(sendProfileRequestSource, /profileHadChatGptTab[\s\S]*?action: "send_chat_request"[\s\S]*?chatgpt_tab_auto_opened: !profileHadChatGptTab && Boolean\(result\?\.target_id\)/, "send diagnostics must prove when the worker auto-opened a missing ChatGPT tab");
assert.doesNotMatch(sendProfileRequestSource, /if \(!profile\?\.connected\) throw/, "Manager must not reject a retained profile before the bridge can wait for reconnection");
assert.match(sendProfileRequestSource, /localMcpToolInSession\(session, "browser_control", \{ action: "list_profiles" \}\)[\s\S]*?setTimeout\(resolve, 120\)[\s\S]*?refreshedProfiles = await localMcpToolInSession\(session, "browser_control", \{ action: "list_profiles" \}\)/, "Manager must refresh a possibly stale profile on the same MCP session without a full runtime scan");
assert.doesNotMatch(sendProfileRequestSource, /await listProjects\(\)/, "chat send preflight must not rescan every known project");
assert.match(sendProfileRequestSource, /const streamedProfile = cachedBrowserProfileForSend\(profileId\)/, "chat send must prefer the realtime SSE profile snapshot");
assert.match(sendProfileRequestSource, /streamedProfile \? Promise\.resolve\(null\) : localMcpToolInSession\(session, "browser_control", \{ action: "list_profiles" \}\)/, "chat send must skip list_profiles while a live SSE profile snapshot is available");
assert.match(sendProfileRequestSource, /profilePreflightSource = "list-profiles-refresh"/, "chat send must retain list_profiles as the reconnect fallback");
assert.match(sendProfileRequestSource, /runtimeConnectionForSend\(\)[\s\S]*?fast MCP connect failed; falling back to full runtime health/, "chat send must try cached/direct MCP config before the expensive health fallback");
assert.doesNotMatch(sendProfileRequestSource, /const base = await readyRuntimeBaseStatus\(\)/, "healthy chat sends must not unconditionally run the full runtime health scan");
assert.match(sendProfileRequestSource, /workspaceSelectSkipped[\s\S]*?if \(!workspaceSelectSkipped\)/, "Manager must skip redundant workspace selection when the profile is already scoped correctly");
assert.match(sendProfileRequestSource, /action: "select_workspace"[\s\S]*?}, 75000\)/, "workspace selection must allow the bounded reconnect window");
assert.match(sendProfileRequestSource, /isCodexProWorkspaceRequest[\s\S]*?config\?\.root[\s\S]*?codexProWorkspaceExpanded = isCodexProWorkspaceRequest\(base\.config\)[\s\S]*?requestScope = codexProWorkspaceExpanded \? "all_allowed" : requestedScope/, "selecting the active CodexPro workspace must automatically expand the task to all configured allowed roots");
assert.match(sendProfileRequestSource, /workspaceSelectSkipped = \(!codexProWorkspaceExpanded && requestScope === "all_allowed"\)/, "generic all_allowed requests must stay unbound while a CodexPro-expanded request keeps CodexPro as its main workspace");
assert.match(sendProfileRequestSource, /Workspace chính đã được CodexPro Manager chọn[\s\S]*?TẤT CẢ VÙNG ĐƯỢC CẤP QUYỀN[\s\S]*?all_allowed[\s\S]*?DeepSeek Harness/, "CodexPro workspace requests must carry all allowed regions so the agent can inspect external reference source such as DeepSeek Harness");
assert.match(sendProfileRequestSource, /codexpro_workspace_expanded_scope: codexProWorkspaceExpanded/, "send diagnostics must expose when the CodexPro workspace was expanded to all allowed roots");
assert.match(sendProfileRequestSource, /localMcpToolInSession\(session, "prepare_repo_task", \{[\s\S]*?profile_id: profileId[\s\S]*?task_id: taskId[\s\S]*?requestScope === "workspace" \? \{ root: initialWorkspaceRoot \} : \{\}[\s\S]*?scope: requestScope[\s\S]*?preparedTask\?\.prepared !== true[\s\S]*?action: "send_chat_request"/, "Manager must prepare workspace tasks with an exact root while leaving all_allowed task roots unbound");
assert.match(sendProfileRequestSource, /task_kind[\s\S]*?<general hoặc code>[\s\S]*?task_kind=general chỉ ghi title[\s\S]*?task_kind=code mới nạp rule, chạy CodexGraph/, "Manager must require titles for all tasks while reserving Rules/CodexGraph for code tasks");
assert.match(sendProfileRequestSource, /Không được mặc định dùng workspace CodexPro hiện tại\/default/, "all_allowed prompt must force the AI to choose the actual target instead of defaulting to CodexPro's current workspace");
assert.doesNotMatch(sendProfileRequestSource, /root:\\"\$\{initialWorkspaceRoot\.replace\([\s\S]{0,120}?scope:\\"all_allowed/, "all_allowed prompt must not hardcode the Manager default workspace root");
assert.match(sendProfileRequestSource, /action: "send_chat_request"[\s\S]*?}, 235000\)/, "chat submission must preserve the action timeout after a reconnect wait");
const managerSendUiSource = managerUi.slice(managerUi.indexOf("async function sendRequest(profile"), managerUi.indexOf("async function rolloverFullConversation"));
assert.match(managerSendUiSource, /draftOverride !== null \? draftOverride : \(requestDraftsRef\.current\[profile\.profile_id\][\s\S]*?api\.sendProfileRequest/, "Manager send must read the composer snapshot without subscribing the full chat modal to every keystroke");
assert.match(managerUi, /const submitted = await onSend\(draft\);\s*if \(submitted\) updateDraft\(""\)/, "the local composer must clear its draft only after a confirmed submission");
assert.match(managerSendUiSource, /scope: allAllowedScope \? "all_allowed" : "workspace"[\s\S]*?workspaceCandidates: allAllowedScope \? projects\.map/, "all_allowed sends must preserve scope and provide known workspace candidates to the backend");
assert.match(managerSendUiSource, /restoreSubmittedInputs\(\)[\s\S]*?Trạng thái gửi chưa chắc chắn[\s\S]*?return false/, "an uncertain submission must preserve the local composer draft instead of silently clearing it");
assert.match(managerSendUiSource, /shouldRolloverConversation\(currentResponse\)[\s\S]*?continuation_reason: "message_limit"[\s\S]*?rolloverFullConversation\(profile, conversationId,[\s\S]*?rollover_attachments: attachments/, "a settled conversation at the 18-message safety limit must roll the pending request and attachments into a fresh ChatGPT tab");
assert.match(managerSendUiSource, /conversation-message-limit-rollover[\s\S]*?message_limit:[\s\S]*?message_count:/, "automatic message-limit rollover must leave a diagnostic trail with the configured and observed counts");
assert.match(managerSendUiSource, /requestedTab\?\.long_task_watchdog_hung \|\| requestedConversation\?\.long_task_watchdog_hung[\s\S]*?conversationId = forcedNewChat \? NEW_CHAT_TARGET[\s\S]*?long-task-watchdog-force-new-chat/, "new work must never be sent back into a conversation marked hung by the one-shot watchdog, even after its tab was closed");
assert.match(managerUi, /totalMessageCount: protectAuthoritativeSnapshot[\s\S]*?contentAvailable[\s\S]*?result\.total_message_count/, "Manager response state must retain ChatGPT's complete user-plus-assistant message count, including the protected canonical snapshot");
assert.match(managerUi, /const cacheEntry = \{[\s\S]*?totalMessageCount: Number\(response\?\.totalMessageCount\)[\s\S]*?saveChatResponseCache\(cacheEntry\)/, "the complete conversation count must survive Manager cache hydration");
assert.match(managerMain, /function normalizeChatCacheEntry[\s\S]*?totalMessageCount: Math\.max\(0, Math\.floor\(Number\(value\?\.totalMessageCount\)/, "the Electron cache must normalize the persisted complete conversation count");
assert.match(managerSendUiSource, /CONVERSATION_LIMIT_REACHED:[\s\S]*?rolloverFullConversation\(profile, conversationId,[\s\S]*?rollover_attachments: attachments/, "a terminal full-conversation banner must roll the pending user request and attachments into a new chat");
const conversationRolloverSource = managerUi.slice(managerUi.indexOf("async function rolloverFullConversation"), managerUi.indexOf("async function verifyRepoTaskUse"));
assert.match(conversationRolloverSource, /newChat: true[\s\S]*?text: handoffText[\s\S]*?attachments:/, "conversation rollover must create a fresh ChatGPT chat and send the preserved context once");
assert.match(conversationRolloverSource, /rolloverAllAllowed[\s\S]*?scope: rolloverAllAllowed \? "all_allowed" : "workspace"[\s\S]*?workspaceCandidates: rolloverAllAllowed \? projects\.map/, "conversation rollover must not collapse all_allowed back to a locked workspace");
assert.match(conversationRolloverSource, /rolloverWorkspaceExpanded[\s\S]*?repoTaskRequest\?\.scope === "workspace"[\s\S]*?!rolloverWorkspaceExpanded/, "a CodexPro workspace that was backend-expanded to all_allowed must keep CodexPro as the preferred root across conversation rollover");
assert.match(managerUi, /continueAllAllowed[\s\S]*?scope: continueAllAllowed \? "all_allowed" : "workspace"[\s\S]*?workspaceCandidates: continueAllAllowed \? projects\.map/, "continue-response resend must preserve all_allowed scope");
assert.match(conversationRolloverSource, /previousAttempt\?\.status === "creating" \|\| previousAttempt\?\.status === "done"/, "conversation rollover must deduplicate repeated terminal-banner observations");
assert.match(managerUi, /function buildConversationRolloverPrompt\([\s\S]*?Bối cảnh gần nhất từ chat trước:[\s\S]*?Tiếp tục từ đúng việc còn dang dở/, "the new chat handoff must preserve recent conversation context instead of restarting blindly");
assert.match(worker, /ATTACHMENT_UPLOAD_QUIET_FALLBACK_MS = 2500/, "attachment upload fallback must not impose the old 12 second wait");
assert.match(worker, /Date\.now\(\)\+400,Date\.now\(\)\+400/, "attachment preview stability should use the shorter verified window");
assert.match(worker, /const maxAgeMs=.*DOM_ACTIVITY_PROBE_CACHE_MS/, "DOM activity probes must support a bounded freshness override for send preflight reuse");
assert.match(worker, /image-gen-loading-state/, "ChatGPT image generation must have a dedicated DOM loading signal");
assert.match(worker, /Generated image:/, "a completed generated image must be recognized as a final response");
assert.match(worker, /ChatGPT đang tạo ảnh/, "image generation must expose a dedicated activity label instead of generic processing");
assert.match(worker, /image_response_ready/, "image completion evidence must propagate through profile and response state");
assert.match(worker, /response_ready:Boolean\(domActivity\.response_ready\)/, "generic DOM completion evidence must propagate through profile state");
assert.match(worker, /reconcileChatNetworkCompletion\(tab\.id,conversationId,domActivity\.image_response_ready\?'dom_image':'dom_response'\)/, "finished DOM responses must reconcile stale generation state for both image and text turns");
assert.match(worker, /canonicalActivity\.busy&&!domActivity\.response_ready/, "finished DOM responses must suppress stale canonical busy state even when canonical reads are rate-limited");
assert.match(worker, /networkStream\.in_progress&&!domActivity\.response_ready/, "finished DOM responses must suppress a stale network stream");
assert.match(worker, /response_kind:imageResponseReady\|\|imageGenerationLoading\?'image':'text'/, "DOM response reads must classify image generations without requiring assistant text");
assert.match(worker, /domResponseReady\?\{canonical_busy:false,canonical_response_ready:true,network_stream_in_progress:false,response_ready:true,response_kind:imageResponseReady\?'image':String\(domResult\.response_kind\|\|'text'\)\}/, "completed DOM responses must clear stale canonical and stream busy flags returned to Manager");
assert.match(worker, /Promise\.all\(\[[\s\S]*?timedSendPhase\('network_capture_probe_ms',\(\)=>chatNetworkStreamCapture\(tab\.id,targetConversationId\)\)[\s\S]*?timedSendPhase\('network_state_ms',\(\)=>chatRequestState\(tab\.id,conversationId\)\)[\s\S]*?chatDomActivityState\(tab\.id,conversationId,\{maxAgeMs:750\}\)[\s\S]*?chatAttachmentOwnership\(tab\.id,targetConversationId\)/, "send preflight checks must run in parallel, time each phase, and reuse only a sub-second DOM probe");
const workerSendSource = worker.slice(worker.indexOf("if(action==='send_chat_request')"), worker.indexOf("if(action==='rename_chat')"));
assert.doesNotMatch(workerSendSource, /chatDomActivityState\(tab\.id,conversationId,\{fresh:true\}\)/, "send must not force a duplicate DOM activity probe immediately after list_profiles");
assert.match(workerSendSource, /if\(domActivity\.busy\)\{[\s\S]*?probeCanonicalActivity\(tab\.id,targetConversationId,true\)[\s\S]*?canonical\?\.response_ready&&!canonical\.busy[\s\S]*?send_preflight_canonical/, "send must clear any stale DOM busy guard when canonical proves the previous turn completed");
assert.match(workerSendSource, /waitForChatSubmitLifecycle\(tab\.id,submitStartedAt-100[\s\S]*?Math\.min\(1800[\s\S]*?resultForSubmitLifecycle\(earlyLifecycleEvidence,submitResult\)/, "healthy existing-chat sends must accept bounded submit-lifecycle evidence instead of waiting for generation start");
assert.doesNotMatch(workerSendSource, /Math\.min\(6000,remainingCommandMs\(\)-500\)/, "healthy sends must not retain the old six-second pre-fallback generation wait");
assert.match(managerMain, /send_submit_lifecycle_ack_ms[\s\S]*?send_extension_total_ms[\s\S]*?bridge_extension_roundtrip_ms[\s\S]*?submission_ack_source/, "Manager diagnostics must persist the send-phase and bridge timing breakdown for latency analysis");
assert.match(managerMain, /codexpro:browser-profiles/);
assert.match(managerPreload, /onBrowserProfiles/);
assert.match(managerPreload, /recoverProfileChat/);
assert.match(managerPreload, /invokeResult/);
assert.match(managerUi, /SendDebugEvidence/);
assert.match(managerUi, /network_evidence/);
assert.match(managerUi, /REALTIME_WATCHDOG_MS = 30000/);
assert.match(managerUi, /PROJECT_REFRESH_MS = 5 \* 60 \* 1000/, "project discovery must not run every status watchdog tick");
assert.match(managerMain, /app\.requestSingleInstanceLock\(\)/, "normal Manager launches must hold a single-instance lock");
assert.match(managerMain, /REPO_SCAN_CACHE_MS = 10 \* 60 \* 1000/, "repo discovery must use a durable cache");
assert.match(managerMain, /GIT_SUMMARY_CACHE_MS = 2 \* 60 \* 1000/, "project Git summaries must be cached independently");
assert.match(managerUi, /api\.onBrowserProfiles/);
assert.doesNotMatch(managerUi, /REALTIME_POLL_MS = 1000/, "Manager must not poll status every second");
assert.match(managerUi, /responseScrollLocked/, "manual transcript scrolling must lock auto-scroll");
assert.match(managerUi, /rendererUnresponsive\s*\?\s*recoverProfileTab\(profile\)\s*:\s*openProfile\(profile, \{ focusOnly: true \}\)/, "the profile card must recover an unresponsive conversation or focus the already-open Chrome tab without navigating it");
assert.match(managerUi, /responseScrollLocked\.current\.get\(chatProfileId\)/, "stream updates must respect the manual scroll lock");
assert.match(managerUi, /responseScrollLocked\.current\.delete\(profile\.profile_id\)/, "sending a new message must resume auto-scroll");
assert.match(managerUi, /const positionOpenChatViewport = useCallback\([\s\S]*?maintainResponsePosition\(profileId, cause\)[\s\S]*?modal\.scrollTop = modal\.scrollHeight/, "opening Chat must keep the outer modal at the real bottom without blindly forcing the transcript itself to the bottom");
assert.match(managerUi, /const openChatTurnActive = useMemo\([\s\S]*?openTab\?\.busy[\s\S]*?networkStreamInProgress[\s\S]*?openChatAwaitingAssistant/, "opening Chat must derive whether the selected response is still active from both tab and transcript evidence");
assert.match(managerUi, /const restoreOpenResponseTurnAnchor = useCallback\([\s\S]*?chat-transcript-message\.is-user[\s\S]*?responseTurnAnchors\.current\.set/, "reopening an active response must reconstruct its latest-user turn anchor from rendered transcript state");
assert.match(managerUi, /useLayoutEffect\(\(\) => \{[\s\S]*?openChatTurnActive\) restoreOpenResponseTurnAnchor\(chatProfileId\)[\s\S]*?maintainResponsePosition/, "an active reopened response must restore the turn anchor before positioning the transcript");
assert.match(managerUi, /function openChat\(profile\)[\s\S]*?responseScrollPositions\.current\.delete\(profile\.profile_id\)[\s\S]*?positionOpenChatViewport\(profile\.profile_id[\s\S]*?hydrateCachedResponse\(profile, conversationId\)\.finally/, "opening Chat must hydrate the cached transcript and re-evaluate the appropriate active-turn or bottom position");
assert.match(managerUi, /function changeProjectForProfile\(profile, root\)[\s\S]*?requestTargetsRef\.current[\s\S]*?NEW_CHAT_TARGET[\s\S]*?setRequestResponses[\s\S]*?conversationId: NEW_CHAT_TARGET/, "changing project must detach the new task from the previous project's conversation and transcript");
assert.match(managerUi, /openChatAwaitingAssistant[\s\S]*?pollLatestResponse[\s\S]*?completedResponseNeedsDomFallback\(canonical\)[\s\S]*?loadResponse\(profile, conversationId, true, true\)/, "Manager must fall back to the live DOM when network completion arrives before canonical contains the newest response");
assert.match(managerUi, /tab\.connection_interrupted[\s\S]*?connectionRecoveryReads[\s\S]*?loadResponse\(profile, conversationId, true, true, true\)/, "Manager must automatically recover the exact chat when ChatGPT reports an interrupted connection");
assert.match(worker, /connection_interrupted:Boolean\(domActivity\.connection_interrupted\)/, "profile status must expose interrupted ChatGPT renderers to Manager");
assert.match(worker, /const reloadAllowed=shouldReloadChatRecovery\([\s\S]*?if\(stale&&reloadAllowed\)[\s\S]*?chrome\.tabs\.reload\(tab\.id\)/, "response reload must pass through the guarded recovery decision");
assert.match(worker, /if\(networkBusy\)return false/, "active generation or tool traffic must block an early response reload");
assert.match(longTaskAuditSource, /preflight[\s\S]*?active_without_reload[\s\S]*?chrome\.tabs\.reload/, "the 30-minute watchdog must probe a healthy active task without reloading it");
assert.match(worker, /waitForLongTaskRenderer[\s\S]*?network_state==='failed'[\s\S]*?connection_interrupted/, "a living DOM with an interrupted or failed transport must not count as recovered");
assert.match(worker, /rendererHealthy=Boolean\(\(activity\.available\|\|canonical\.ok\|\|networkState\.busy\)&&!hardFailure\)/, "live generation network traffic must prevent a destructive reload even when DOM and canonical probes are temporarily unavailable");
assert.match(managerUi, /responsive_after_reload[\s\S]*?text: "tiếp tục"[\s\S]*?previousTaskId: recoveryTaskId[\s\S]*?long-task-watchdog-resume-done/, "an interrupted task must reload once and send one continuation in the original conversation while preserving its Task ID");
assert.match(managerUi, /text: "tiếp tục"[\s\S]*?oneShotRecovery: true/, "the synthetic continuation send must disable the generic send path's renderer replacement retry");
assert.match(managerMain, /action: "send_chat_request"[\s\S]*?one_shot_recovery: payload\?\.oneShotRecovery === true/, "Manager must forward the one-shot recovery boundary to browser_control");
assert.match(server, /one_shot_recovery: z\.boolean\(\)\.optional\(\)[\s\S]*?one_shot_recovery: args\.one_shot_recovery/, "browser_control must preserve the one-shot recovery flag through its schema and extension bridge");
assert.match(worker, /const oneShotRecovery=Boolean\(args\.one_shot_recovery\)[\s\S]*?for\(let prepareAttempt=0;prepareAttempt<\(oneShotRecovery\?1:2\);prepareAttempt\+=1\)/, "one-shot continuation must stop after the first renderer preparation failure");
assert.match(managerUi, /long-task-watchdog-hung[\s\S]*?long_task_watchdog_hung: true[\s\S]*?Watchdog đã dừng, không retry thêm/, "a renderer that stays hung after reload must stop and warn instead of retrying or opening a tab");
assert.match(managerUi, /if \(!managerSettings\.autoRecovery\) return;[\s\S]*?longRunningChatWatchdogCandidate\(profile, jobs\)[\s\S]*?continue;/, "generic auto-recovery must not race the one-shot watchdog for tasks running over 30 minutes");
assert.match(managerMain, /ChatGPT báo Connection interrupted[\s\S]*?incident_fingerprint: `chat-connection-interrupted:/, "Connection interrupted transitions must be persisted with a repeat-count fingerprint");
assert.match(worker, /connection interrupted[\s\S]*?waiting for the complete answer/i, "the tab health probe must detect ChatGPT's English interrupted-connection banner");
assert.match(worker, /kết nối bị gián đoạn[\s\S]*?đang chờ câu trả lời hoàn chỉnh/i, "the tab health probe must detect ChatGPT's Vietnamese interrupted-connection banner");
assert.match(worker, /dom_reload_deferred=true/, "unsafe reload attempts must keep the checkpoint and wait for a later poll");
assert.match(worker, /mergeChatRecoveryResponse\(recoveryCheckpoint,domResult\)/, "a reloaded response must merge into the pre-reload checkpoint");
assert.match(worker, /!rendererRefreshed\|\|domResult\.connection_interrupted[\s\S]*?replaceUnresponsiveChatTab\(tab,`https:\/\/chatgpt\.com\/c\/\$\{conversationId\}`\)/, "a chat that remains interrupted after reload must be replaced at the same conversation URL");
assert.match(bridge, /connection_interrupted:\s*tab\.connection_interrupted\s*===\s*true/, "the extension bridge must preserve interrupted-response state for Manager recovery");
assert.match(worker, /message delivery timed out\\\.\\s\*please try again/i, "ChatGPT's delivery-timeout banner must trigger renderer recovery");
assert.match(worker, /messageDeliveryTimedOut\?'message_delivery_timeout'/, "delivery timeout recovery must be distinguishable in diagnostics");
assert.doesNotMatch(worker, /text:'tiếp tục'/, "recovery must merge later UI/canonical content rather than sending a synthetic continuation message");
assert.doesNotMatch(worker, /claimTimedOutContinuation/, "timeout recovery must not retain the obsolete automatic continuation path");
assert.match(bridge, /message_delivery_timed_out:\s*tab\.message_delivery_timed_out\s*===\s*true/, "the extension bridge must preserve delivery-timeout diagnostics");
assert.match(worker, /args\.read_dom===false&&args\.canonical_only!==true[\s\S]*?args\.canonical_only===true[\s\S]*?canonical_available:true/, "worker must expose authenticated canonical response reads without querying transcript DOM");
assert.match(managerMain, /read_dom: payload\?\.canonicalOnly === true \|\| payload\?\.readDom !== false,[\s\S]*?canonical_only: payload\?\.canonicalOnly === true/, "Manager canonical recovery must remain compatible with a server process that has not restarted yet");
assert.match(server, /read_dom: args\.read_dom,[\s\S]*?canonical_only: args\.canonical_only,[\s\S]*?recover_stale_dom: args\.recover_stale_dom/, "browser_control must forward canonical_only to the extension instead of silently falling back to DOM");
assert.match(managerUi, /authoritativeResponseSnapshots[\s\S]*?resultResponseSource === "canonical_api"[\s\S]*?protectAuthoritativeSnapshot[\s\S]*?resultResponseSource === "chatgpt_dom"[\s\S]*?replaceCanonicalTranscript\(nextMessages, authoritativeSnapshot\.messages\)/, "a delayed short DOM read must not replace a completed canonical transcript from the same network generation");
assert.match(managerUi, /hasStrongerNetworkStreamEvidence\(responseAudit[\s\S]*?responseEvidencePending[\s\S]*?network_stream_ahead_of_dom/, "a short DOM false-final must remain provisional when the same-generation network transcript contains materially more assistant text");
assert.match(managerUi, /showLiveStreamTail \? "ChatGPT · đang phản hồi" : "ChatGPT"/, "partial assistant text must be visibly labeled as still responding");
assert.match(server, /responseHasStrongerNetworkStreamEvidence\(result[\s\S]*?!responseHasStrongerNetworkStreamEvidence\(result\)[\s\S]*?\? "completed"/, "durable browser jobs must not finalize while stronger network response evidence contradicts a short DOM final");
assert.match(managerUi, /cachedResponseIsFresh\([\s\S]*?network_last_completed_at/, "Chat reopening must compare the persisted response against the latest network completion before re-reading transcript content");
assert.match(managerUi, /cachedResponseIsFresh\([\s\S]*?cached\?\.responseReady !== true/, "an unverified cached assistant fragment must never be accepted as the final ChatGPT response");
assert.match(managerUi, /fastResult\?\.network_stream_available && fastResult\?\.network_stream_in_progress === true/, "only a currently running network stream may suppress canonical/DOM recovery");
assert.match(managerPreload, /getChatResponseCache[\s\S]*?saveChatResponseCache/, "Manager preload must expose persistent chat-response cache access");
assert.match(managerPreload, /logChatLayout[\s\S]*?codexpro:log-chat-layout/, "Manager preload must expose fire-and-forget chat layout tracing");
assert.match(managerPreload, /logChatResponseAudit[\s\S]*?codexpro:log-chat-response-audit/, "Manager preload must expose response comparison tracing");
assert.match(managerMain, /manager-chat-layout\.jsonl[\s\S]*?appendManagerChatLayoutLog[\s\S]*?codexpro:log-chat-layout/, "Manager must persist bounded chat layout traces");
assert.match(managerMain, /manager-chat-response-audit\.jsonl[\s\S]*?appendManagerChatResponseAuditLog[\s\S]*?codexpro:log-chat-response-audit/, "Manager must persist bounded ChatGPT-to-Manager response comparison logs");
assert.match(managerMain, /manager-chat-cache\.json[\s\S]*?MAX_CHAT_CACHE_ENTRIES = 30/, "Manager must persist a bounded local response cache instead of rebuilding every transcript on open");
assert.match(managerUi, /currentResponse\?\.repoTaskId && canVerifyRepoTaskUse\(/, "CodexPro verification must wait for a canonical-ready settled response");
assert.match(managerMain, /const previousTaskId = String\(payload\?\.previousTaskId[\s\S]*?const taskId = previousTaskId \|\| `cpt_/, "task-title retry and chat rollover must preserve the original prepared task id");
assert.match(managerMain, /repo_task_id_reused: taskIdReused[\s\S]*?repo_task_dispatched_at: taskDispatchedAt/, "Manager send results must expose task-id reuse and the attempt dispatch boundary");
assert.match(managerUi, /repoTaskDispatchedAt: currentResponse\.repoTaskDispatchedAt/, "renderer task verification must compare network completion with the active send-attempt boundary");
assert.match(managerUi, /repoTaskDispatchedAt: String\(result\?\.repo_task_dispatched_at[\s\S]*?repoTaskDispatchedAt: String\(created\?\.repo_task_dispatched_at[\s\S]*?repoTaskDispatchedAt: String\(retried\?\.repo_task_dispatched_at/, "initial sends, retries, and chat rollovers must all retain their dispatch boundary");
assert.match(managerUi, /String\(created\?\.repo_task_id \|\| ""\) !== taskId[\s\S]*?String\(retried\?\.repo_task_id \|\| ""\) !== taskId/, "renderer must reject any retry or rollover that unexpectedly replaces the prepared task id");
assert.match(managerUi, /action: "repo-task-title-rollover"[\s\S]*?task_id_reused:[\s\S]*?action: "repo-task-title-retry"[\s\S]*?task_id_reused:/, "retry diagnostics must record task-id continuity for both same-chat and new-chat recovery");
assert.match(managerUi, /ChatGPT vẫn đang xử lý hoặc hoàn tất lượt trước/, "send must reject attempts that would steer the active turn");
assert.match(managerUi, /setRequestSendEvidence\(\(current\) => \(\{ \.\.\.current, \[profile\.profile_id\]: null \}\)\)/, "opening Chrome must clear stale send evidence");
assert.match(managerUi, /heartbeat\|offline\|did not reconnect[\s\S]*?refreshStatus\(\)/, "a final heartbeat failure must immediately reconcile the visible profile status");
assert.match(managerUi, /isRetryableChatTurnBusyError\(err\)/, "CodexPro verification must distinguish a harmless busy race from an uncertain send");
assert.match(managerUi, /repoTaskVerificationReads\.current\.set\(verificationKey, Date\.now\(\) \+ REPO_TASK_VERIFICATION_RETRY_MS\)/, "a blocked verification retry must be released after a cooldown");
assert.match(managerUi, /repoTaskStatus: "waiting", loading: false/, "a rejected verification retry must return to waiting instead of remaining stuck on retrying");
assert.match(managerStyles, /\.chat-response-head strong \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/, "long response headlines must remain one line and end with an ellipsis");
assert.match(managerUi, /className="chat-response-send-state"[\s\S]*?Đang gửi tin nhắn[\s\S]*?className="typing-dots"/, "the send indicator must render inline inside the response header");
assert.match(managerStyles, /\.chat-response-send-state \{[^}]*inline-flex;[^}]*white-space: nowrap;/, "the inline send indicator must stay compact on the response status row");
assert.match(managerStyles, /\.chat-modal \{[^}]*height: 94vh;[^}]*overflow-anchor: none;[^}]*scrollbar-gutter: stable;/, "chat modal geometry must stay fixed while send state, attachments, and evidence change");
assert.match(managerStyles, /\.latest-response \{[^}]*overflow-anchor: none;[^}]*scrollbar-gutter: stable;[^}]*scroll-behavior: auto;/, "realtime transcript updates must not repeatedly animate or re-anchor the chat viewport");
assert.match(managerUi, /const openChatScrollKey = useMemo\([\s\S]*?lastMessage[\s\S]*?visibleText[\s\S]*?contentKey[\s\S]*?turnKey/, "chat auto-scroll must follow visible transcript content and the explicit turn lifecycle");
assert.match(managerUi, /useLayoutEffect\(\(\) => \{[\s\S]*?openChatScrollKey[\s\S]*?maintainResponsePosition\(chatProfileId,\s*"layout-effect:open-chat-scroll-key"\)/, "the active turn anchor must settle before paint to avoid a visible second jump");
const sendRequestSource = managerUi.slice(managerUi.indexOf("async function sendRequest(profile)"), managerUi.indexOf("async function rolloverFullConversation"));
assert.doesNotMatch(sendRequestSource, /requestAnimationFrame\(\(\) => scrollResponseToBottom/, "sendRequest must not schedule a duplicate transcript scroll");
assert.match(managerUi, /responseTurnActive[\s\S]*?is-response-runway/, "an active send must reserve a half-height response runway before stream content arrives");
assert.ok(managerUi.indexOf("const selectedSettling =") < managerUi.indexOf("const responseTurnActive ="), "response cage activity must be derived only after busy/settling state is initialized");
assert.match(managerUi, /logChatLayout[\s\S]*?MutationObserver[\s\S]*?ResizeObserver/, "Manager chat must trace intermittent DOM and height changes behind layout jumps");
assert.match(managerStyles, /\.chat-transcript-message\.is-response-cage \{[^}]*min-height: 108px;[^}]*padding-bottom: 24px;/, "the reserved response cage must keep enough vertical space to prevent transcript jumps");
assert.match(managerStyles, /\.chat-transcript-message\.is-response-runway \{[^}]*--chat-response-runway-height/, "the newest turn must keep a half-height runway below the sent message");
assert.match(managerStyles, /\.chat-transcript-message \{[^}]*flex: 0 0 auto;/, "response runway must never shrink older messages and overlap their content");
assert.match(managerUi, /installResponseAutoPin[\s\S]*?chatResponseRef[\s\S]*?maintainResponsePosition/, "Manager must maintain the active turn anchor after async DOM and layout changes");
assert.match(managerUi, /responseTurnAnchors/, "Manager must retain the active turn identity while optimistic messages become canonical");
assert.match(managerChatScroll, /scrollResponseToTurnAnchor/, "chat scrolling must expose a stable viewport anchor instead of only forcing the bottom");
assert.match(managerStyles, /\.chat-transcript\.has-turn-anchor::after/, "an anchored turn must reserve enough space below it to remain near the viewport center");
assert.match(managerChatScroll, /handleResponseWheel[\s\S]*?deltaY < 0[\s\S]*?recordResponseScroll[\s\S]*?responseDistanceFromBottom/, "only explicit upward user input may pause auto-scroll; layout-driven scroll events must not lock it");
assert.doesNotMatch(managerStyles, /\.message-send-indicator\s*\{/, "the old standalone send status panel must be removed");
assert.match(managerUi, /className="toast-icon"[\s\S]*?<svg viewBox="0 0 24 24"/, "success toasts must use the custom vector status icon");
assert.match(managerStyles, /\.toast-message \{[^}]*font-family: var\(--app-font-family,[^}]*font-weight: var\(--weight-semibold\)/, "toast typography must match the Manager interface");
assert.doesNotMatch(managerUi, /RESPONSE_AUTO_SCROLL_RESUME_MS/, "manual transcript scrolling must not auto-resume on a timer");
assert.match(managerUi, /networkState === "generating" \|\| tab\.busy \|\| tab\.settling/, "Manager must keep polling canonical and tool activity after the initial generation request completes");
assert.match(worker, /shouldProbeCanonical[\s\S]*?probeCanonicalActivity/, "worker heartbeat must proactively probe canonical state for recent or sticky turns");
assert.match(worker, /baseline_user_id[\s\S]*?canonicalMatchesCurrentGeneration/, "canonical completion must be tied to the current user generation instead of an older response");
assert.match(managerUi, /canonicalBusy \|\| networkStreamInProgress \|\| \(!networkTerminal && result\.busy\)/, "Manager must not clear canonical busy merely because one network segment completed");
assert.match(managerUi, /network_stream_activity_text/, "Manager must render live network tool activity without exposing raw tool payloads");

const manifest = JSON.parse(manifestText);
const canonicalReaderSource = worker.slice(worker.indexOf("function readCanonicalConversationPage"), worker.indexOf("function canonicalResponseSupersedesDom"));
assert.match(canonicalReaderSource, /message\.role==='user'\|\|message\.end_turn===true/, "canonical transcript reads must exclude internal assistant progress fragments");
assert.doesNotMatch(canonicalReaderSource, /status==='finished_successfully'/, "finished_successfully progress nodes must not be mistaken for an end-turn response");
const responseReaderSource = worker.slice(worker.indexOf("if(action==='get_chat_response')"), worker.indexOf("if(action==='open_tab')"));
const networkStreamCaptureSource = worker.slice(worker.indexOf("async function chatNetworkStreamCapture"), worker.indexOf("async function reconcileChatNetworkCompletion"));
assert.doesNotMatch(networkStreamCaptureSource, /const installed=await ensureChatNetworkStreamCapture/, "response polling must not synchronously reinstall the document-start stream capture");
assert.match(networkStreamCaptureSource, /NETWORK_STREAM_READ_TIMEOUT_MS/, "response polling must bound its auxiliary stream read instead of waiting for the generic DOM timeout");
assert.match(responseReaderSource, /const networkOnly=args\.read_dom===false&&args\.canonical_only!==true/, "network-only response polling must have an explicit fast path");
assert.match(responseReaderSource, /shouldProbeCanonical&&networkOnly[\s\S]*?void probeCanonicalCompletion\(tab\.id,conversationId,false\)\.catch/, "network-only response polling must move slow canonical completion probing off the blocking path");
assert.match(responseReaderSource, /response_phase_timings[\s\S]*?extension_total_ms/, "response reads must return extension phase timings for slow-load investigations");
assert.match(responseReaderSource, /find_tab_ms[\s\S]*?network_state_ms[\s\S]*?network_stream_ms[\s\S]*?canonical_read_ms[\s\S]*?dom_read_ms/, "response timing telemetry must separate tab lookup, network, canonical, and DOM phases");
assert.match(bridge, /bridge_phase_timings[\s\S]*?queue_wait_ms[\s\S]*?extension_roundtrip_ms[\s\S]*?bridge_total_ms/, "browser bridge results must expose queue and extension round-trip timings");
assert.match(managerMain, /manager_phase_timings[\s\S]*?runtime_base_ms[\s\S]*?local_mcp_ms[\s\S]*?manager_total_ms/, "Manager response reads must expose runtime and local-MCP timings");
assert.match(managerMain, /const responseProfileId = String\(result\?\.profile_id[\s\S]*?responseConversationId[\s\S]*?RESPONSE_OWNERSHIP_MISMATCH[\s\S]*?response_profile_id:[\s\S]*?response_conversation_id:/, "Manager must reject a browser response unless its profile and conversation match the exact request");
assert.match(managerMain, /codexpro:get-profile-response[\s\S]*?slowMs:\s*2_000[\s\S]*?response_phase_timings[\s\S]*?bridge_phase_timings[\s\S]*?manager_phase_timings/, "slow response diagnostics must record all phase timing groups from two seconds onward");
assert.match(responseReaderSource, /const networkStreamLive=Boolean\(effectiveNetworkBusy&&networkStream\.available\)/, "closed network streams must be hidden after the request becomes terminal");
assert.match(worker, /response_ready:responseReady,response_source:'chatgpt_dom'/, "DOM fallback must explicitly mark only settled latest-assistant content as ready");
assert.match(worker, /const turnNodes=Array\.from\(document\.querySelectorAll\('\[data-testid\^="conversation-turn-"\]'\)\)/, "DOM transcript reads must include image-only ChatGPT conversation turns without an assistant role node");
assert.match(worker, /const images=await generatedImagesFor\(turn\)/, "image-only turns must collect generated image previews into assistant transcript messages");
assert.match(worker, /data_url:dataUrl/, "generated image previews must be returned to Manager as renderable image data");
assert.match(worker, /if\(domActivity\.busy\)\{[\s\S]*?probeCanonicalActivity\(tab\.id,targetConversationId,true\)[\s\S]*?canonicalCompleted[\s\S]*?send_preflight_canonical/, "send preflight must clear a stale DOM busy guard when canonical proves the previous turn completed");
assert.equal(manifest.version, "0.5.110");
assert.match(worker, /const assistantContentFor=assistantMessage=>[\s\S]*?fullLength>bestLength\+24\?assistantMessage:best/, "DOM transcript reads must reject a one-token markdown descendant when the full assistant wrapper contains the complete response");
assert.match(responseReaderSource, /if\(canonicalResponseSupersedesDom\(currentCanonical,domResult\)\)/, "a current canonical response must replace a shorter stale DOM response even when the DOM incorrectly marks itself ready");
assert.doesNotMatch(responseReaderSource, /if\(!domResult\.response_ready&&canonicalResponseSupersedesDom/, "DOM response_ready must not prevent canonical stale-response correction");
assert.match(worker, /const MAX_CHATGPT_TABS = 3[\s\S]*?const MAC_MAX_CHATGPT_TABS = 1/, "worker must keep the normal three-tab cap while forcing macOS profiles to one ChatGPT tab");
assert.match(worker, /CHAT_TAB_HEALTH_FAILURES_TO_CLOSE = 2/, "worker must require consecutive failed CodexPro probes before closing an unhealthy tab");
assert.match(worker, /cleanupChatGptTabs\(tabs,recentConversations\)[\s\S]*?if\(tabCleanup\.closed_count\)tabs=await tabList\(\)/, "polling must clean tabs and refresh the heartbeat snapshot after closures");
assert.match(worker, /current\.active&&!allowActiveIdle[\s\S]*?current\.pinned\|\|current\.audible[\s\S]*?pendingConversationByTab\.has\(tabId\)[\s\S]*?chatAttachmentOwnershipByTab\.has\(tabId\)[\s\S]*?browserMutationTailsByTab\.has\(tabId\)[\s\S]*?networkState\.busy\|\|canonicalActivity\.busy\|\|domActivity\?\.busy/, "worker must only relax active-tab protection for macOS single-tab replacement while re-checking all live work signals");
assert.match(worker, /value==='codexpro'\|\|value\.startsWith\('codexpro '\)/, "worker must open a Settings plugin row whose accessible name includes the permission summary");
assert.match(connectorInstaller, /value === 'codexpro' \|\| value\.startsWith\('codexpro '\)/, "connector installer must recognize ChatGPT's CodexPro Allow all row");
assert.match(connectorInstaller, /function connectorCheckEvidence[\s\S]*?codexpro_candidate_count[\s\S]*?match_text[\s\S]*?match_aria/, "connector checks must return bounded selector evidence for false-positive and false-negative investigations");
assert.match(connectorInstaller, /installed: true, diagnostic: connectorCheckEvidence\(connectorAction\)[\s\S]*?installed: false, definition_state: 'missing', diagnostic: connectorCheckEvidence\(\)/, "connector checks must preserve selector evidence for both installed and missing results");
assert.match(worker, /value\.includes\('settings'\)\|\|value\.includes\('cai dat'\)/, "worker setup must recognize localized Settings dialogs");
assert.match(worker, /value\.includes\('connection'\)\|\|value\.includes\('ket noi'\)/, "worker setup must recognize localized Connection details");
assert.match(worker, /CODEXPRO_SETUP_EVIDENCE/, "worker setup failures must preserve bounded selector evidence for Manager diagnostics");
assert.match(connectorInstaller, /value\.includes\('settings'\) \|\| value\.includes\('cai dat'\)/, "connector installer must recognize Vietnamese Settings");
assert.match(connectorInstaller, /hasConnectionMarker = value => value\.includes\('connection'\) \|\| value\.includes\('ket noi'\)/, "connector installer must recognize Vietnamese Connection labels");
assert.match(connectorInstaller, /value\.includes\('them codexpro vao chatgpt'\)/, "connector installer must recognize the Vietnamese CodexPro consent heading");
assert.match(connectorInstaller, /value\.includes\('cac quyen nay se luon duoc tuan thu'\)/, "connector installer must recognize the Vietnamese consent permission copy");
assert.match(connectorInstaller, /CONNECT_CONSENT_NOT_FOUND[\s\S]*?CODEXPRO_SETUP_EVIDENCE/, "connector installer must preserve bounded evidence when the consent dialog is missing");
assert.match(popupHtml, /class="brand-icon"[\s\S]*?<svg/, "extension popup must use a real brand icon instead of a text-only heading");
assert.match(popupHtml, /id="activeState"[\s\S]*?Profile đang ACTIVE/, "the active profile must render as a compact status instead of a redundant action button");
assert.match(popupJs, /button\.hidden=isActive[\s\S]*?activeState\.hidden=!isActive/, "the activate action must disappear after the profile becomes active");
assert.match(popupJs, /installButton\.hidden=true/, "the reinstall action must disappear when CodexPro is already ready");
assert.doesNotMatch(popupHtml + popupJs, /CÀI LẠI \/ KIỂM TRA LẠI/, "the ready popup must not keep a redundant reinstall button");
assert.match(popupHtml, /id="workerToggle"[\s\S]*?role="switch"/, "the popup must expose an accessible worker connection toggle");
assert.match(popupJs, /workerEnabled[\s\S]*?BRIDGE}\/register[\s\S]*?enabled:false/, "disabling a worker must immediately publish a hidden profile state to the Bridge");
assert.match(worker, /if\(!profile\.enabled\)[\s\S]*?setTimeout\(resolve,2000\)[\s\S]*?continue/, "a disabled extension must stop polling the Bridge");
assert.match(bridge, /enabled: boolean[\s\S]*?profile\.enabled = source\.enabled !== false[\s\S]*?profile\.enabled && browserProfileRetentionState\(profile, now\)\.visible/, "disabled profiles must be retained internally but excluded while enabled source profiles survive temporary heartbeat loss");
assert.match(managerMain, new RegExp(`const WORKER_EXTENSION_VERSION = "${manifest.version.replace(/\\./g, "\\\\.")}";`), "Manager backend worker target must match the packaged extension version");
assert.match(managerMain, /confirmationDeadline[\s\S]*?versionAtLeast\(profile\.extension_version\)/, "worker update must wait for a heartbeat confirming the new extension version");
assert.match(managerMain, /profile\.connector_update_required \|\| profile\.connector_profile_bound === false[\s\S]*?action: "setup_chatgpt"[\s\S]*?profile\.connector_installed && profile\.connector_profile_bound/, "Manager send preflight must rebind an old connector before dispatching a task");
assert.match(managerMain, /function profileDiagnosticSnapshot[\s\S]*?connector_installed[\s\S]*?connector_profile_bound[\s\S]*?connector_checked_at/, "profile transition diagnostics must retain connector verification state");
assert.match(managerMain, /CodexPro connector bị hạ xuống chưa xác minh[\s\S]*?CodexPro connector đã được xác minh[\s\S]*?CodexPro connector không còn khớp profile/, "Manager must log connector verification and binding transitions");
assert.match(managerMain, /codexpro:check-profile[\s\S]*?result\?\.installed \?\? result\?\.connector_installed[\s\S]*?connector_check_diagnostic/, "connector checks must log the actual installed result and selector evidence");
assert.match(managerUi, /connectorUpdateRequired[\s\S]*?"Cập nhật CodexPro"[\s\S]*?connectorMissingConfirmed[\s\S]*?"Thêm CodexPro"[\s\S]*?"Kiểm tra CodexPro"/, "unverified profiles must check before setup while outdated connectors retain an explicit update action");
assert.doesNotMatch(managerUi, /window\.confirm\(/, "worker update must use the CodexPro confirmation dialog instead of the native Windows prompt");
assert.match(managerUi, /className="worker-update-dialog"[\s\S]*?Cập nhật CodexPro Worker[\s\S]*?Cập nhật worker/, "Manager must render the custom worker update confirmation dialog");
assert.match(managerUi, /Đã update thành công.*result\.version/, "Manager must only announce update success after the backend confirms the target version");
assert.ok(manifest.permissions.includes("debugger"));

console.log("✓ Browser agent persistent-session/batch/wait smoke test passed");
