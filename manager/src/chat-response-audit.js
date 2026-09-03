const AUDIT_PREVIEW_CHARS = 180;

export function normalizeResponseAuditText(value) {
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

export function responseAuditTextFingerprint(value) {
  const normalized = normalizeResponseAuditText(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${normalized.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function summarizeText(value) {
  const normalized = normalizeResponseAuditText(value);
  if (!normalized) return null;
  return {
    fingerprint: responseAuditTextFingerprint(normalized),
    length: normalized.length,
    preview: normalized.slice(-AUDIT_PREVIEW_CHARS)
  };
}

export function summarizeResponseAuditMessages(messages) {
  const usable = (Array.isArray(messages) ? messages : [])
    .filter((message) => ["user", "assistant"].includes(message?.role) && normalizeResponseAuditText(message?.text));
  const latestUserIndex = usable.findLastIndex((message) => message.role === "user");
  const assistantAfterLatestUser = latestUserIndex >= 0
    ? usable.slice(latestUserIndex + 1).findLast((message) => message.role === "assistant")
    : usable.findLast((message) => message.role === "assistant");
  return {
    messageCount: usable.length,
    latestUser: summarizeText(usable.findLast((message) => message.role === "user")?.text),
    latestAssistant: summarizeText(usable.findLast((message) => message.role === "assistant")?.text),
    assistantAfterLatestUser: summarizeText(assistantAfterLatestUser?.text)
  };
}

function normalizeSourceSummary(source) {
  if (!source || typeof source !== "object") return { available: false };
  return {
    available: source.available === true,
    source: String(source.source || ""),
    responseReady: source.response_ready === true,
    busy: source.busy === true,
    messageCount: Number(source.message_count) || 0,
    latestUser: source.latest_user || null,
    latestAssistant: source.latest_assistant || null,
    assistantAfterLatestUser: source.assistant_after_latest_user || null,
    error: String(source.error || "").slice(0, 500)
  };
}

function renderedSummary(messages) {
  const normalized = (Array.isArray(messages) ? messages : [])
    .filter((message) => ["user", "assistant"].includes(message?.role));
  const latestUserIndex = normalized.findLastIndex((message) => message.role === "user");
  const assistantAfterLatestUser = latestUserIndex >= 0
    ? normalized.slice(latestUserIndex + 1).findLast((message) => message.role === "assistant")
    : normalized.findLast((message) => message.role === "assistant");
  return {
    messageCount: normalized.length,
    latestUser: normalized.findLast((message) => message.role === "user") || null,
    latestAssistant: normalized.findLast((message) => message.role === "assistant") || null,
    assistantAfterLatestUser: assistantAfterLatestUser || null
  };
}

function fingerprintsMatch(left, right) {
  return Boolean(left?.fingerprint && right?.fingerprint && left.fingerprint === right.fingerprint);
}

export function buildChatResponseAuditRecord({ profileId, conversationId, requestId, fetchMode, sourceAudit, managerMessages, renderedMessages, networkState, networkStartedAt, networkCompletedAt }) {
  const chatgptDom = normalizeSourceSummary(sourceAudit?.chatgpt_dom);
  const canonical = normalizeSourceSummary(sourceAudit?.canonical_api);
  const networkStream = normalizeSourceSummary(sourceAudit?.network_stream);
  const selectedSource = String(sourceAudit?.selected_source || "");
  const selectedBasis = selectedSource.startsWith("network_stream") ? networkStream : selectedSource === "canonical_api" ? canonical : selectedSource === "chatgpt_dom" ? chatgptDom : null;
  const basis = selectedBasis?.available ? selectedBasis : chatgptDom.available ? chatgptDom : canonical.available ? canonical : networkStream;
  const basisName = basis === chatgptDom ? "chatgpt_dom" : basis === canonical ? "canonical_api" : basis === networkStream && networkStream.available ? "network_stream" : "none";
  const managerState = summarizeResponseAuditMessages(managerMessages);
  const managerUi = renderedSummary(renderedMessages);
  const expected = basis.assistantAfterLatestUser || (!basis.latestUser ? basis.latestAssistant : null);
  const stateAssistant = managerState.assistantAfterLatestUser || (!managerState.latestUser ? managerState.latestAssistant : null);
  const uiAssistant = managerUi.assistantAfterLatestUser || (!managerUi.latestUser ? managerUi.latestAssistant : null);

  let comparison = "match";
  if (!basis.available) comparison = "source_unavailable";
  else if (!expected) comparison = "source_missing_latest_assistant";
  else if (!stateAssistant) comparison = "missing_in_manager_state";
  else if (!fingerprintsMatch(expected, stateAssistant)) comparison = "manager_state_mismatch";
  else if (!uiAssistant) comparison = "missing_in_manager_ui";
  else if (uiAssistant.fingerprint !== expected.fingerprint) comparison = "manager_ui_mismatch";

  return {
    schemaVersion: 1,
    at: new Date().toISOString(),
    profileId: String(profileId || ""),
    conversationId: String(conversationId || ""),
    requestId: String(requestId || ""),
    fetchMode: String(fetchMode || ""),
    networkState: String(networkState || ""),
    networkStartedAt: String(networkStartedAt || ""),
    networkCompletedAt: String(networkCompletedAt || ""),
    selectedSource: String(sourceAudit?.selected_source || ""),
    comparisonBasis: basisName,
    comparison,
    sources: { chatgptDom, canonical, networkStream },
    managerState,
    managerUi
  };
}
