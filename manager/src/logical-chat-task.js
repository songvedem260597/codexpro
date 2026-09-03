const TASK_ID_PATTERN = /^cpt_[a-f0-9]{24}$/;
const ACTIVE_TASK_STATUSES = new Set(["prepared", "running"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);

function normalizedTaskId(value) {
  const taskId = String(value || "").trim();
  return TASK_ID_PATTERN.test(taskId) ? taskId : "";
}

function normalizedStatus(value) {
  return String(value || "").trim().toLowerCase();
}

export function acceptsLogicalTaskAdjustment({ profileId, conversationId, workerJob, profile, tab } = {}) {
  const taskId = normalizedTaskId(workerJob?.job_id ?? workerJob?.jobId);
  const status = normalizedStatus(workerJob?.status);
  if (!taskId || String(workerJob?.worker_id ?? workerJob?.workerId ?? "") !== String(profileId || "")) return false;
  if (!ACTIVE_TASK_STATUSES.has(status)) return false;

  const boundTaskId = normalizedTaskId(profile?.current_task_id);
  const boundConversationId = String(profile?.current_task_conversation_id || "").trim();
  if (status === "running" && boundTaskId && boundTaskId !== taskId) return false;
  if (boundTaskId === taskId && boundConversationId && boundConversationId !== String(conversationId || "")) return false;

  const networkState = normalizedStatus(tab?.network_state);
  const stillProcessing = Boolean(tab?.busy
    || tab?.settling
    || tab?.canonical_busy
    || tab?.network_stream_in_progress
    || ["generating", "pending", "streaming"].includes(networkState));
  if (tab?.response_ready === true && !stillProcessing) return false;
  return status === "running" || stillProcessing;
}

export function activeLogicalTaskAdjustment({ profileId, conversationId, taskInProgress, response, profile, jobs } = {}) {
  const selectedConversationId = String(conversationId || "").trim();
  if (!selectedConversationId || taskInProgress !== true) return null;

  const responseTaskId = String(response?.conversationId || "") === selectedConversationId
    ? normalizedTaskId(response?.repoTaskId)
    : "";
  const profileTaskId = String(profile?.current_task_conversation_id || "") === selectedConversationId
    ? normalizedTaskId(profile?.current_task_id)
    : "";
  const taskId = responseTaskId || profileTaskId;
  if (!taskId) return null;

  const job = (Array.isArray(jobs) ? jobs : []).find((item) => normalizedTaskId(item?.job_id ?? item?.jobId) === taskId);
  const jobStatus = normalizedStatus(job?.status);
  const workerId = String(job?.worker_id ?? job?.workerId ?? "").trim();
  if (job && workerId && profileId && workerId !== String(profileId)) return null;
  if (job && !ACTIVE_TASK_STATUSES.has(jobStatus)) return null;

  const rememberedStatus = normalizedStatus(response?.logicalTaskStatus);
  if (!job && TERMINAL_TASK_STATUSES.has(rememberedStatus)) return null;
  return { taskId, status: jobStatus || (rememberedStatus === "prepared" ? "prepared" : "pending") };
}
