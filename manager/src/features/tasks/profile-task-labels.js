export const PROFILE_TASK_LABELS_STORAGE_KEY = "codexpro.profileTaskLabels.v2";

export function loadProfileTaskLabels(storage = window.localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(PROFILE_TASK_LABELS_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function persistProfileTaskLabels(labels, storage = window.localStorage) {
  try {
    storage.setItem(PROFILE_TASK_LABELS_STORAGE_KEY, JSON.stringify(labels || {}));
  } catch {
    // Convenience UI only; storage failure must not affect request sending.
  }
}
