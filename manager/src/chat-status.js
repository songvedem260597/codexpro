export function isTerminalChatNetworkState(networkState) {
  return networkState === "completed" || networkState === "failed";
}

export function shouldShowChatBusy({ networkState, tabBusy, responseCurrent, responseBusy }) {
  if (isTerminalChatNetworkState(networkState)) return false;
  return networkState === "generating" || Boolean(tabBusy || (responseCurrent && responseBusy));
}

export function shouldShowChatSettling({ networkState, tabSettling, responseCurrent, responseIncomplete }) {
  if (isTerminalChatNetworkState(networkState)) return false;
  return Boolean(tabSettling || (responseCurrent && responseIncomplete));
}
