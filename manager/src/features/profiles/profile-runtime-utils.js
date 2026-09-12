export const WORKER_EXTENSION_VERSION = "0.5.135";

export function extensionReady(version, targetVersion = WORKER_EXTENSION_VERSION) {
  const parts = String(version || "").split(".").map(Number);
  const target = targetVersion.split(".").map(Number);
  for (let index = 0; index < target.length; index += 1) {
    const current = Number.isFinite(parts[index]) ? parts[index] : 0;
    if (current !== target[index]) return current > target[index];
  }
  return true;
}

export function profileVisibleInWorkerList(profile) {
  return Boolean(profile?.connected)
    && (Number(profile?.tab_count || 0) > 0 || Boolean(profile?.connector_installed));
}

export function profileSafeForWorkerUpdate(profile) {
  const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
  const hasBusyTab = tabs.some((tab) => tab?.busy || tab?.settling || String(tab?.network_state || "") === "generating");
  return ["idle", "no_chatgpt"].includes(profile?.activity) && Number(profile?.busy_request_count || 0) === 0 && !hasBusyTab;
}
