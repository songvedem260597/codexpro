const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9-]{8,160}$/;

export function conversationIdFromUrl(url) {
  return String(url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
}

export function availableConversationIdsForProfile(profile) {
  return new Set([
    ...(Array.isArray(profile?.recent_conversations) ? profile.recent_conversations : [])
      .map((conversation) => String(conversation?.id || "").trim()),
    ...(Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [])
      .map((tab) => conversationIdFromUrl(tab?.url))
  ].filter((id) => CONVERSATION_ID_PATTERN.test(id)));
}

export function conversationBelongsToProfile(profile, conversationId) {
  const normalized = String(conversationId || "").trim();
  return CONVERSATION_ID_PATTERN.test(normalized)
    && availableConversationIdsForProfile(profile).has(normalized);
}

export function isConversationUnavailableError(value) {
  return String(value?.message || value || "").includes("Đoạn chat không còn thuộc 3 chat gần nhất của profile này.");
}
