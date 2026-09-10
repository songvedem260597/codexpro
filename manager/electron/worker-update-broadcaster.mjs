export function createWorkerUpdateBroadcaster(options = {}) {
  const BrowserWindow = options.BrowserWindow;
  const Notification = options.Notification;
  const interruptionAlertTracker = options.interruptionAlertTracker;
  const readManagerSettings = options.readManagerSettings;
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const pendingWorkerUpdates = new Map();
  let workerUpdateFlushTimer = null;

  function showManagerNotification(payload) {
    if (!Notification.isSupported()) return false;
    const title = String(payload?.title || "CodexPro").trim().slice(0, 120) || "CodexPro";
    const body = String(payload?.body || "").trim().slice(0, 500);
    new Notification({ title, body, silent: payload?.silent === true }).show();
    return true;
  }

  function flushWorkerUpdates() {
    workerUpdateFlushTimer = null;
    const updates = [...pendingWorkerUpdates.values()];
    pendingWorkerUpdates.clear();
    if (!updates.length) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      for (const update of updates) win.webContents.send("codexpro:worker-update", update);
    }
  }

  function queueWorkerUpdate(update) {
    const localWorkerId = String(update?.local_worker_id || "").trim();
    if (!localWorkerId) return;
    const interruptionAlert = interruptionAlertTracker.observeApiWorker(update);
    if (interruptionAlert && readManagerSettings().taskNotifications !== false) showManagerNotification(interruptionAlert);
    const activity = String(update?.activity || "idle");
    pendingWorkerUpdates.set(`api:${localWorkerId}`, {
      worker_id: `api:${localWorkerId}`,
      activity,
      current_task_id: activity === "working" ? String(update?.job_id || "") : "",
      current_task_title: activity === "working" ? String(update?.task_title || "") : "",
      current_workspace_root: activity === "working" ? String(update?.current_workspace_root || "") : "",
      last_task_id: String(update?.job_id || ""),
      last_task_title: String(update?.task_title || ""),
      last_request: String(update?.last_request || ""),
      last_result: String(update?.result?.text || ""),
      last_error: String(update?.error || ""),
      stream_text: String(update?.stream_text || ""),
      stream_revision: Math.max(0, Number(update?.stream_revision) || 0),
      stream_phase: String(update?.stream_phase || ""),
      stream_updated_at: String(update?.stream_updated_at || ""),
      stream_tool_status: String(update?.stream_tool_status || ""),
      workflow_id: String(update?.workflow_id || ""),
      workflow_version: String(update?.workflow_version || ""),
      workflow_evidence: String(update?.workflow_evidence || ""),
      started_at: String(update?.started_at || ""),
      finished_at: String(update?.finished_at || ""),
      usage: update?.result?.usage
    });
    if (!workerUpdateFlushTimer) workerUpdateFlushTimer = setTimeoutImpl(flushWorkerUpdates, 40);
  }

  return {
    queueWorkerUpdate,
    showManagerNotification
  };
}
