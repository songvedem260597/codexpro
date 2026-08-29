export function isTerminalChatNetworkState(networkState) {
  return networkState === "completed" || networkState === "failed";
}

export function shouldShowChatBusy({ networkState, tabBusy, responseCurrent, responseBusy }) {
  if (tabBusy) return true;
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
