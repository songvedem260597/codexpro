export function profileCardBorderState({ connected, working, settling, rendererUnresponsive, networkState, rendererError, connectionInterrupted }) {
  if (!connected || rendererUnresponsive) return "error";
  if (working || settling) return "working";
  if (rendererError || connectionInterrupted) return "error";
  return "idle";
}

export function profileTabFailureState({ connected, working, settling, tab }) {
  const networkState = String(tab?.network_state || "").toLowerCase();
  const rendererUnresponsive = Boolean(connected && tab?.renderer_unresponsive);
  const transportFailure = Boolean(
    tab?.message_delivery_timed_out
    || networkState === "failed"
    || tab?.network_error
  );
  return {
    rendererUnresponsive,
    recoveryRequired: Boolean(rendererUnresponsive || (connected && !working && !settling && transportFailure))
  };
}

export function profileChromeTarget(profile) {
  const chatgptTabs = Array.isArray(profile?.chatgpt_tabs) ? profile.chatgpt_tabs : [];
  const conversationTabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
  const tabs = chatgptTabs.length ? chatgptTabs : conversationTabs;
  return tabs.find((tab) => tab?.active) || tabs[0] || null;
}

export function profileChromeActionState({ profile, busy, rendererUnresponsive }) {
  const target = profileChromeTarget(profile);
  const connected = Boolean(profile?.connected);
  const open = Boolean(connected && target);
  if (rendererUnresponsive) {
    return {
      target,
      disabled: Boolean(busy) || !open,
      label: "Khôi phục tab",
      title: "Đóng tab renderer bị treo và tạo một chat ChatGPT mới"
    };
  }
  return {
    target,
    disabled: Boolean(busy) || !connected,
    label: open ? "Mở Chrome" : "Mở ChatGPT",
    title: open ? "Đưa profile Chrome đang mở lên trước" : "Mở một tab ChatGPT mới trong đúng Chrome profile"
  };
}
