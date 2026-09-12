export function conversationIdFromTabUrl(value) {
  try {
    return new URL(String(value || "")).pathname.match(/^\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
  } catch {
    return "";
  }
}

export function boundConversationTab(profile, conversationId, requestedId = 0) {
  const expectedConversationId = String(conversationId || "").trim();
  const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
  const requestedTabId = Number(requestedId);
  const exactRequested = Number.isInteger(requestedTabId)
    ? tabs.find((tab) => Number(tab?.id) === requestedTabId && conversationIdFromTabUrl(tab?.url) === expectedConversationId)
    : null;
  return exactRequested || tabs.find((tab) => conversationIdFromTabUrl(tab?.url) === expectedConversationId) || null;
}
