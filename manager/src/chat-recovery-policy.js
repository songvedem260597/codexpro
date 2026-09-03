export const CHAT_HISTORY_RATE_LIMIT_ROLLOVER_THRESHOLD = 3;

const ACTIVE_TASK_STATUSES = new Set(["prepared", "running"]);
const TASK_ID_PATTERN = /^cpt_[a-f0-9]{24}$/;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9-]{8,160}$/;

export function chatHistoryRateLimitRecoveryCandidate({ profile, jobs = [], response } = {}) {
  if (!profile?.connected || response?.canonicalRateLimited !== true) return null;
  if (Number(response?.canonicalRateLimitCount) < CHAT_HISTORY_RATE_LIMIT_ROLLOVER_THRESHOLD) return null;

  const conversationId = String(response?.conversationId || "").trim();
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) return null;
  const responseTaskId = String(response?.repoTaskId || "").trim();
  const boundTaskId = String(profile?.current_task_id || "").trim();
  const boundConversationId = String(profile?.current_task_conversation_id || "").trim();
  const taskId = TASK_ID_PATTERN.test(responseTaskId)
    ? responseTaskId
    : boundConversationId === conversationId && TASK_ID_PATTERN.test(boundTaskId)
      ? boundTaskId
      : "";
  if (!taskId) return null;

  const job = (Array.isArray(jobs) ? jobs : []).find((item) => String(item?.job_id || item?.jobId || "") === taskId);
  if (job) {
    if (String(job?.worker_id || job?.workerId || "") !== String(profile.profile_id || "")) return null;
    if (!ACTIVE_TASK_STATUSES.has(String(job?.status || "").toLowerCase())) return null;
  } else if (profile.activity !== "working" && response?.busy !== true && response?.sendUncertain !== true) {
    return null;
  }

  if (response?.awaitingAssistant !== true && response?.busy !== true && response?.sendUncertain !== true) return null;
  return {
    profileId: String(profile.profile_id || ""),
    conversationId,
    taskId,
    reason: "chatgpt_history_rate_limited"
  };
}
