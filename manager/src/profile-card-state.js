function latestProfileLifecycleEvent(profile) {
  const history = Array.isArray(profile?.lifecycle_events)
    ? profile.lifecycle_events.filter((event) => event && typeof event === "object" && !Array.isArray(event))
    : [];
  const direct = profile?.lifecycle_event && typeof profile.lifecycle_event === "object" && !Array.isArray(profile.lifecycle_event)
    ? profile.lifecycle_event
    : null;
  const events = direct ? [...history, direct] : history;
  if (!events.length) return null;
  return events.reduce((latest, event) => {
    const latestAt = Date.parse(String(latest?.at || ""));
    const eventAt = Date.parse(String(event?.at || ""));
    if (!Number.isFinite(eventAt)) return latest;
    if (!Number.isFinite(latestAt) || eventAt >= latestAt) return event;
    return latest;
  }, events[0]);
}

export function profileConnectionState(profile, { lifecycleGraceMs = 30_000 } = {}) {
  if (profile?.connected !== false) return "connected";
  const event = latestProfileLifecycleEvent(profile);
  if (!event) return "disconnected";

  const type = String(event.type || "");
  const reason = String(event.reason || "");
  const closeEvidence = type === "window_removed"
    || (type === "window_close_requested" && reason === "browser_control_close_profile")
    || (type === "tab_removed" && event.is_window_closing === true);
  if (!closeEvidence) return "disconnected";

  const eventAt = Date.parse(String(event.at || ""));
  const lastSeenAt = Date.parse(String(profile?.last_seen || ""));
  if (!Number.isFinite(eventAt) || !Number.isFinite(lastSeenAt)) {
    return reason === "browser_control_close_profile" ? "stopped" : "disconnected";
  }
  return Math.abs(lastSeenAt - eventAt) <= Math.max(0, lifecycleGraceMs) ? "stopped" : "disconnected";
}

export function profileCardBorderState({ connected, stopped = false, working, settling, rendererUnresponsive, networkState, rendererError, connectionInterrupted }) {
  if (stopped) return "stopped";
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
