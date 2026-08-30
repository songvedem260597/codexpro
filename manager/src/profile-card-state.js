export function profileCardBorderState({ connected, working, settling, rendererUnresponsive, networkState, rendererError, connectionInterrupted }) {
  if (!connected || rendererUnresponsive) return "error";
  if (working || settling) return "working";
  if (rendererError || connectionInterrupted) return "error";
  return "idle";
}

export function profileChromeTarget(profile) {
  const chatgptTabs = Array.isArray(profile?.chatgpt_tabs) ? profile.chatgpt_tabs : [];
  const conversationTabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
  const tabs = chatgptTabs.length ? chatgptTabs : conversationTabs;
  return tabs.find((tab) => tab?.active) || tabs[0] || null;
}

export function profileChromeActionState({ profile, busy, rendererUnresponsive }) {
  const target = profileChromeTarget(profile);
  const open = Boolean(profile?.connected && target);
  if (rendererUnresponsive) {
    return {
      target,
      disabled: Boolean(busy) || !open,
      label: "Khôi phục tab",
      title: "Đóng tab renderer bị treo và mở lại đúng conversation trong một tab mới"
    };
  }
  return {
    target,
    disabled: Boolean(busy) || !open,
    label: open ? "Đi tới Chrome" : "Chưa mở",
    title: open ? "Đưa profile Chrome đang mở lên trước" : "Profile chưa có tab ChatGPT đang mở"
  };
}
