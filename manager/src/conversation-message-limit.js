export const CHATGPT_CONVERSATION_MESSAGE_LIMIT = 18;

function normalizedCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

export function conversationTotalMessageCount(source) {
  const reportedTotal = normalizedCount(source?.totalMessageCount ?? source?.total_message_count);
  if (reportedTotal > 0) return reportedTotal;

  const messages = Array.isArray(source?.messages)
    ? source.messages.filter((message) => String(message?.text || "").trim() || (Array.isArray(message?.images) && message.images.length))
    : [];
  const assistantCount = normalizedCount(source?.messageCount ?? source?.message_count);
  if (!assistantCount) return messages.length;

  const trailingUser = messages.at(-1)?.role === "user" ? 1 : 0;
  return Math.max(messages.length, assistantCount * 2 + trailingUser);
}

export function shouldRolloverConversation(source, limit = CHATGPT_CONVERSATION_MESSAGE_LIMIT) {
  const normalizedLimit = normalizedCount(limit);
  return normalizedLimit > 0 && conversationTotalMessageCount(source) >= normalizedLimit;
}
