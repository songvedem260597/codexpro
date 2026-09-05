export function conversationIdFromProfileTab(tab) {
  return String(tab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
}

export function isConversationOutsideRecentWindowError(error) {
  const message = String(error?.message || error || "");
  return message.includes("Đoạn chat không còn thuộc 3 chat gần nhất của profile này.");
}

export function nextValidConversationTarget(profile, excludedConversationId = "") {
  const excluded = String(excludedConversationId || "");
  const valid = (value) => /^[A-Za-z0-9-]{8,160}$/.test(String(value || "")) && String(value) !== excluded;
  const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
  const active = tabs.find((tab) => tab?.active && valid(conversationIdFromProfileTab(tab)));
  if (active) return conversationIdFromProfileTab(active);
  const open = tabs.find((tab) => valid(conversationIdFromProfileTab(tab)));
  if (open) return conversationIdFromProfileTab(open);
  const recent = (Array.isArray(profile?.recent_conversations) ? profile.recent_conversations : []).find((chat) => valid(chat?.id));
  return String(recent?.id || "");
}
