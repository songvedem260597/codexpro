const WORKING_BORDER_SELECTOR = ".profile-list .browser-profile.is-working, .profile-layout-preview .profile-layout-preview-item.is-working";
const SYNCED_ANIMATION_NAMES = new Set(["profile-border-shine", "worker-border-beam-move"]);

export function synchronizeWorkerBorderAnimations(root = document) {
  if (!root || typeof root.querySelectorAll !== "function") return 0;
  let synchronized = 0;
  for (const element of root.querySelectorAll(WORKING_BORDER_SELECTOR)) {
    if (typeof element.getAnimations !== "function") continue;
    for (const animation of element.getAnimations({ subtree: true })) {
      if (!SYNCED_ANIMATION_NAMES.has(String(animation?.animationName || ""))) continue;
      if (animation.startTime !== 0) animation.startTime = 0;
      synchronized += 1;
    }
  }
  return synchronized;
}

export { SYNCED_ANIMATION_NAMES, WORKING_BORDER_SELECTOR };
