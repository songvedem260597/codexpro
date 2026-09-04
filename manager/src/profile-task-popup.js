const RESUMABLE_TASK_STATUSES = new Set(["prepared", "running", "failed", "cancelled", "blocked"]);

function normalizedStatus(job) {
  return String(job?.status || "").trim().toLowerCase();
}

export function profileWorkerIsIdleForTaskResume(profile) {
  if (!profile?.connected || String(profile.activity || "") !== "idle") return false;
  const tabs = Array.isArray(profile.conversation_tabs) ? profile.conversation_tabs : [];
  return !tabs.some((tab) => tab?.busy === true || tab?.settling === true || tab?.renderer_unresponsive === true || String(tab?.network_state || "") === "generating");
}

export function profileTaskCanResume(job, workerIdle) {
  if (!workerIdle || job?.completion_confirmed === true) return false;
  return RESUMABLE_TASK_STATUSES.has(normalizedStatus(job));
}

export function profileTaskStatusLabel(job) {
  const status = normalizedStatus(job);
  const execution = String(job?.execution_state || job?.last_progress_stage || "").trim().toLowerCase();
  if (status === "completed") return "Hoàn thành";
  if (execution === "verifying") return "Đang xác minh";
  if (execution === "stalled") return "Bị treo";
  if (execution === "error") return "Có lỗi";
  if (status === "blocked" || execution === "blocked") return "Bị chặn";
  if (status === "failed") return "Thất bại";
  if (status === "cancelled") return "Chưa hoàn thành";
  if (status === "prepared") return "Chưa bắt đầu";
  if (status === "running") return "Chưa hoàn thành";
  return status || "Không rõ";
}

export function profileTaskProgress(job) {
  const explicit = Number(job?.progress_percent);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, Math.round(explicit)));
  const completed = Array.isArray(job?.completed_parts) ? job.completed_parts.length : 0;
  const remaining = Array.isArray(job?.remaining_parts) ? job.remaining_parts.length : 0;
  if (completed + remaining > 0) return Math.round((completed / (completed + remaining)) * 100);
  return normalizedStatus(job) === "completed" ? 100 : 0;
}

export function profileTaskJobsForWorker(jobs, profileId, currentTaskId = "") {
  const workerId = String(profileId || "").trim();
  const currentId = String(currentTaskId || "").trim();
  const rank = (job) => {
    const taskId = String(job?.job_id || job?.jobId || "");
    if (currentId && taskId === currentId) return -1;
    const status = normalizedStatus(job);
    if (status === "running") return 0;
    if (status === "prepared") return 1;
    if (status === "blocked") return 2;
    if (status === "failed") return 3;
    if (status === "cancelled") return 4;
    if (status === "completed") return 5;
    return 6;
  };
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => String(job?.worker_id || job?.workerId || "") === workerId)
    .sort((left, right) => {
      const rankDiff = rank(left) - rank(right);
      if (rankDiff) return rankDiff;
      if (normalizedStatus(left) === "prepared") {
        return Date.parse(String(left?.fifo_queued_at || left?.prepared_at || left?.updated_at || ""))
          - Date.parse(String(right?.fifo_queued_at || right?.prepared_at || right?.updated_at || ""));
      }
      return Date.parse(String(right?.updated_at || right?.updatedAt || right?.finished_at || "")) - Date.parse(String(left?.updated_at || left?.updatedAt || left?.finished_at || ""));
    });
}

export function profileTaskLastReason(job) {
  return String(job?.blocked_reason || job?.last_progress_reason || job?.error || job?.summary || "").trim();
}
