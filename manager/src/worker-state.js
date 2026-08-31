export function workerSupports(worker, capability) {
  const expected = String(capability || "").trim().toLowerCase();
  return Boolean(expected && Array.isArray(worker?.capabilities) && worker.capabilities.includes(expected));
}

export function workerVisualState(worker) {
  if (!worker?.connected || worker?.activity === "offline") return "hung";
  if (["queued", "working", "settling"].includes(String(worker?.activity || ""))) return "working";
  if (worker?.activity === "failed" || worker?.last_error) return "hung";
  return "idle";
}

export function workerNeedsExtensionUpdate(worker, versionAtLeast) {
  if (worker?.worker_type !== "browser" || !workerSupports(worker, "reload-extension")) return false;
  const currentVersion = String(worker?.browser?.extension_version || "");
  return typeof versionAtLeast === "function" ? !versionAtLeast(currentVersion) : false;
}

export function workerChromeActionsVisible(worker) {
  return worker?.worker_type === "browser" && workerSupports(worker, "open-browser");
}
