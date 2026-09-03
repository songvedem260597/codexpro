export const CHATGPT_CONVERSATION_MESSAGE_LIMIT = 5;
export const CHATGPT_CONVERSATION_FAST_MESSAGE_LIMIT = 10;
export const CHATGPT_CONVERSATION_FAST_ACTIVITY_MS = 10 * 60 * 1000;

function normalizedCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

function usableMessages(source) {
  return Array.isArray(source?.messages)
    ? source.messages.filter((message) => String(message?.text || "").trim() || (Array.isArray(message?.images) && message.images.length))
    : [];
}

function parsedTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function conversationTotalMessageCount(source) {
  const reportedTotal = normalizedCount(source?.totalMessageCount ?? source?.total_message_count);
  if (reportedTotal > 0) return reportedTotal;

  const messages = usableMessages(source);
  const assistantCount = normalizedCount(source?.messageCount ?? source?.message_count);
  if (!assistantCount) return messages.length;

  const trailingUser = messages.at(-1)?.role === "user" ? 1 : 0;
  return Math.max(messages.length, assistantCount * 2 + trailingUser);
}

export function conversationCompletedTaskCount(source) {
  if (Object.prototype.hasOwnProperty.call(source || {}, "logicalTaskCount")
    || Object.prototype.hasOwnProperty.call(source || {}, "logical_task_count")) {
    return normalizedCount(source?.logicalTaskCount ?? source?.logical_task_count);
  }
  const assistantCount = normalizedCount(source?.messageCount ?? source?.message_count);
  if (assistantCount > 0) return assistantCount;
  return usableMessages(source).filter((message) => message?.role === "assistant").length;
}

export function logicalTaskTracking(source) {
  const reportedIds = source?.completedLogicalTaskIds ?? source?.completed_logical_task_ids;
  const completedLogicalTaskIds = [...new Set((Array.isArray(reportedIds) ? reportedIds : [])
    .map((taskId) => String(taskId || "").trim())
    .filter((taskId) => /^cpt_[a-f0-9]{24}$/.test(taskId)))]
    .slice(-20);
  return {
    logicalTaskCount: conversationCompletedTaskCount(source),
    completedLogicalTaskIds
  };
}

export function recordCompletedLogicalTask(source, taskId, status) {
  const current = logicalTaskTracking(source);
  const normalizedTaskId = String(taskId || "").trim();
  if (String(status || "").trim().toLowerCase() !== "completed"
    || !/^cpt_[a-f0-9]{24}$/.test(normalizedTaskId)
    || current.completedLogicalTaskIds.includes(normalizedTaskId)) return current;
  return {
    logicalTaskCount: current.logicalTaskCount + 1,
    completedLogicalTaskIds: [...current.completedLogicalTaskIds, normalizedTaskId].slice(-20)
  };
}

export function conversationTaskInProgress(source) {
  if (source?.taskInProgress === true) return true;
  const networkState = String(source?.networkState ?? source?.network_state ?? "").trim().toLowerCase();
  if (["generating", "pending", "streaming"].includes(networkState)) return true;
  if (source?.busy || source?.loading || source?.transcriptLoading || source?.incomplete || source?.finalityPending || source?.canonicalBusy || source?.networkStreamInProgress) return true;
  return usableMessages(source).at(-1)?.role === "user";
}

export function shouldQualifyFastMessageLimit(source, nowMs = Date.now()) {
  if (conversationCompletedTaskCount(source) < CHATGPT_CONVERSATION_MESSAGE_LIMIT) return false;
  if (source?.fastMessageLimitQualified === true || source?.fast_message_limit_qualified === true) return true;
  const activityStartedAt = parsedTimestamp(source?.activityStartedAt ?? source?.activity_started_at);
  const currentTime = Number(nowMs);
  return Boolean(activityStartedAt
    && Number.isFinite(currentTime)
    && currentTime >= activityStartedAt
    && currentTime - activityStartedAt < CHATGPT_CONVERSATION_FAST_ACTIVITY_MS);
}

export function conversationMessageLimit(source, nowMs = Date.now()) {
  return shouldQualifyFastMessageLimit(source, nowMs)
    ? CHATGPT_CONVERSATION_FAST_MESSAGE_LIMIT
    : CHATGPT_CONVERSATION_MESSAGE_LIMIT;
}

export function shouldRolloverConversation(source, limit, nowMs = Date.now()) {
  const normalizedLimit = limit === undefined
    ? conversationMessageLimit(source, nowMs)
    : normalizedCount(limit);
  return normalizedLimit > 0
    && !conversationTaskInProgress(source)
    && conversationCompletedTaskCount(source) >= normalizedLimit;
}
