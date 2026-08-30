export function isTerminalChatNetworkState(networkState) {
  return networkState === "completed" || networkState === "failed";
}

export function isRecoverableAbortedChatNetworkFailure({ networkState, networkError, networkCompletedAt, responseReady = false, nowMs = Date.now(), graceMs = 120000 }) {
  if (networkState !== "failed" || responseReady) return false;
  if (!/net::ERR_ABORTED/i.test(String(networkError || ""))) return false;
  const completedAtMs = Date.parse(String(networkCompletedAt || ""));
  if (!Number.isFinite(completedAtMs)) return false;
  return Math.max(0, Number(nowMs) - completedAtMs) < Math.max(1000, Number(graceMs) || 120000);
}

export function shouldShowChatBusy({ networkState, tabBusy, responseCurrent, responseBusy, responseReady = false, responseLoading = false, streamBusy, canonicalBusy }) {
  const verifiedComplete = Boolean(
    responseCurrent
    && responseReady
    && !responseLoading
    && !responseBusy
    && !streamBusy
    && !canonicalBusy
    && networkState !== "generating"
  );
  if (verifiedComplete) return false;
  if (tabBusy || streamBusy || canonicalBusy) return true;
  if (isTerminalChatNetworkState(networkState)) return false;
  return networkState === "generating" || Boolean(responseCurrent && responseBusy);
}

export function shouldShowChatSettling({ networkState, tabSettling, responseCurrent, responseIncomplete }) {
  if (tabSettling) return true;
  if (isTerminalChatNetworkState(networkState)) return false;
  return Boolean(responseCurrent && responseIncomplete);
}

export function canAcceptNextChatMessage(status) {
  return !shouldShowChatBusy(status) && !shouldShowChatSettling(status);
}

export function canVerifyRepoTaskUse({ responseCurrent, responseReady, responseBusy, responseIncomplete, awaitingAssistant, tabBusy, tabSettling, canonicalBusy, streamBusy }) {
  return Boolean(
    responseCurrent
    && responseReady
    && !responseBusy
    && !responseIncomplete
    && !awaitingAssistant
    && !tabBusy
    && !tabSettling
    && !canonicalBusy
    && !streamBusy
  );
}

export function isRetryableChatTurnBusyError(error) {
  const message = String(error?.message || error || "");
  return /Đoạn chat (?:này )?(?:đang xử lý|vẫn đang hoàn tất)|Profile này đang gửi một yêu cầu khác|chờ network ACK trước khi gửi tiếp/i.test(message);
}
