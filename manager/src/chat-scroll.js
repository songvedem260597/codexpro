export function responseDistanceFromBottom(container) {
  if (!container) return Infinity;
  return Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
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
  const observedSizes = new WeakSet();
  const resizeObserver = new ResizeObserverClass(() => schedule());
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
    observeSizes();
    if (!isLocked()) scrollToBottom();
  };
  function schedule() {
    windowObject.cancelAnimationFrame(animationFrame);
    animationFrame = windowObject.requestAnimationFrame(pin);
  }
  const mutationObserver = new MutationObserverClass(() => {
    observeSizes();
    schedule();
  });
  mutationObserver.observe(panel, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "data-layout-sending", "data-layout-busy", "data-layout-settling", "data-layout-stream", "data-layout-network-state", "data-layout-message-count"]
  });
  observeSizes();
  schedule();
  return () => {
    windowObject.cancelAnimationFrame(animationFrame);
    mutationObserver.disconnect();
    resizeObserver.disconnect();
  };
}
