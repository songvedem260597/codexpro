export function isTerminalChatNetworkState(networkState) {
  return networkState === "completed" || networkState === "failed";
}

export function shouldShowChatBusy({ networkState, tabBusy, responseCurrent, responseBusy, streamBusy }) {
  if (tabBusy || streamBusy) return true;
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

export function isRetryableChatTurnBusyError(error) {
  const message = String(error?.message || error || "");
  return /Đoạn chat (?:này )?(?:đang xử lý|vẫn đang hoàn tất)|Profile này đang gửi một yêu cầu khác|chờ network ACK trước khi gửi tiếp/i.test(message);
}
