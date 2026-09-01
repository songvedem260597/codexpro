function clean(value, maxLength = 160) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function workspaceLabel(value) {
  const normalized = clean(value, 2048).replace(/\\+/g, "/").replace(/\/+$/, "");
  return clean(normalized.split("/").filter(Boolean).at(-1), 100);
}

function taskLabel(task = {}) {
  const title = clean(task.task_title || task.title || task.task_id || "Task đang chạy", 120);
  const workspace = workspaceLabel(task.workspace || task.current_workspace_root || task.root);
  return workspace ? `“${title}” (${workspace})` : `“${title}”`;
}

export function createInterruptionAlertTracker() {
  const apiWorkers = new Map();

  return {
    observeApiWorker(update = {}) {
      const workerId = clean(update.local_worker_id, 96);
      if (!workerId) return null;
      const previous = apiWorkers.get(workerId);
      const activity = clean(update.activity || "idle", 24).toLowerCase();
      const title = clean(update.task_title || previous?.title || update.last_request || "Task API worker", 120);
      const workspace = clean(update.current_workspace_root || update.root || previous?.workspace, 2048);
      apiWorkers.set(workerId, { activity, title, workspace, task_id: clean(update.job_id || previous?.task_id, 80) });
      if (previous?.activity !== "working" || activity !== "failed") return null;
      return {
        title: "CodexPro · Task bị gián đoạn",
        body: `${taskLabel({ title, workspace })} · Task chưa hoàn thành; API worker ${workerId} đã dừng. Code có thể đang sửa dở/chưa commit; mở Điều phối để kiểm tra.`,
        task_status: "unfinished"
      };
    },

    observeRuntimeHealth(event = {}, activeTasks = []) {
      if (event?.details?.transition !== "offline") return null;
      const label = clean(event?.details?.probe_label || event?.details?.probe_target || "CodexPro runtime", 120);
      const tasks = [
        ...(Array.isArray(activeTasks) ? activeTasks : []),
        ...[...apiWorkers.values()].filter((state) => state.activity === "working")
      ].filter((task, index, all) => {
        const key = `${clean(task.task_id)}:${clean(task.task_title || task.title)}:${clean(task.workspace || task.current_workspace_root)}`;
        return all.findIndex((candidate) => `${clean(candidate.task_id)}:${clean(candidate.task_title || candidate.title)}:${clean(candidate.workspace || candidate.current_workspace_root)}` === key) === index;
      });
      const taskSummary = tasks.slice(0, 2).map(taskLabel).join("; ");
      const more = tasks.length > 2 ? ` và ${tasks.length - 2} task khác` : "";
      return {
        title: "CodexPro · Mất kết nối",
        body: taskSummary
          ? `${label} offline khi đang làm ${taskSummary}${more}. Task chưa hoàn thành; code có thể đang làm dở/chưa commit.`
          : `${label} đang offline. Mở Manager để kiểm tra.`,
        ...(taskSummary ? { task_status: "unfinished" } : {})
      };
    }
  };
}
