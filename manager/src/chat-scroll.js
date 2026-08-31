export function responseDistanceFromBottom(container) {
  if (!container) return Infinity;
  return Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
}

export function responseScrollMetrics(container) {
  if (!container) return null;
  return {
    scrollTop: Math.round(container.scrollTop),
    scrollHeight: Math.round(container.scrollHeight),
    clientHeight: Math.round(container.clientHeight),
    distanceFromBottom: Math.round(responseDistanceFromBottom(container))
  };
}

export function responseTurnAnchorScrollTop(container, anchor, viewportRatio = 0.42) {
  if (!container || !anchor) return 0;
  const containerRect = container.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const anchorCenterInContent = anchorRect.top - containerRect.top + container.scrollTop + (anchorRect.height / 2);
  const desiredCenter = container.clientHeight * Math.max(0.2, Math.min(0.7, viewportRatio));
  const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
  return Math.max(0, Math.min(maximum, Math.round(anchorCenterInContent - desiredCenter)));
}

export function scrollResponseToTurnAnchor(container, anchor, viewportRatio = 0.42) {
  if (!container || !anchor) return null;
  container.scrollTop = responseTurnAnchorScrollTop(container, anchor, viewportRatio);
  return responseScrollMetrics(container);
}

export function handleResponseWheel(profileId, container, deltaY, lockedProfiles, threshold = 18) {
  if (deltaY < 0) {
    lockedProfiles.set(profileId, true);
    return;
  }
  if (deltaY > 0 && responseDistanceFromBottom(container) <= threshold) lockedProfiles.delete(profileId);
}

export function recordResponseScroll(profileId, container, lockedProfiles, positions, threshold = 18) {
  positions.set(profileId, container.scrollTop);
  if (responseDistanceFromBottom(container) <= threshold) lockedProfiles.delete(profileId);
}

export function scheduleResponseAutoResume({ profileId, lockedProfiles, timers, resume, delay = 5000, windowObject = window }) {
  if (!profileId || !lockedProfiles || !timers) return 0;
  lockedProfiles.set(profileId, true);
  const previousTimer = timers.get(profileId);
  if (previousTimer) windowObject.clearTimeout(previousTimer);
  timers.delete(profileId);
  // Scroll ownership belongs to the reader. It is released only when
  // recordResponseScroll observes the bottom threshold again or the reader
  // explicitly chooses to return to the latest message.
  return 0;
}

export function cancelResponseAutoResume(profileId, timers, windowObject = window) {
  const timer = timers?.get(profileId);
  if (!timer) return false;
  windowObject.clearTimeout(timer);
  timers.delete(profileId);
  return true;
}

export function installResponseAutoPin({
  panel,
  getContainer,
  isLocked,
  scrollToBottom,
  windowObject = window,
  MutationObserverClass = MutationObserver,
  ResizeObserverClass = ResizeObserver
}) {
  if (!panel) return () => {};
  let animationFrame = 0;
  const pendingCauses = new Set();
  const observedSizes = new WeakSet();
  const resizeObserver = new ResizeObserverClass(() => schedule("resize"));
  const observeSizes = () => {
    const container = getContainer();
    if (!container) return;
    for (const element of [container, ...container.children]) {
      if (observedSizes.has(element)) continue;
      observedSizes.add(element);
      resizeObserver.observe(element);
    }
  };
  const pin = () => {
    const cause = [...pendingCauses].join("+") || "unknown";
    pendingCauses.clear();
    observeSizes();
    if (!isLocked()) scrollToBottom(cause);
  };
  function schedule(cause = "unknown") {
    pendingCauses.add(cause);
    windowObject.cancelAnimationFrame(animationFrame);
    animationFrame = windowObject.requestAnimationFrame(pin);
  }
  const mutationObserver = new MutationObserverClass(() => {
    observeSizes();
    schedule("mutation");
  });
  mutationObserver.observe(panel, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "data-layout-sending", "data-layout-busy", "data-layout-settling", "data-layout-stream", "data-layout-network-state", "data-layout-message-count"]
  });
  observeSizes();
  schedule("attach");
  return () => {
    windowObject.cancelAnimationFrame(animationFrame);
    mutationObserver.disconnect();
    resizeObserver.disconnect();
  };
}
