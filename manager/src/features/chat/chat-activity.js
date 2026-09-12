export const GENERIC_TOOL_ACTIVITY_TEXT = "Codex Pro đang sử dụng công cụ";

export function codexProToolActivityLabel(text) {
  return /^Codex\s*Pro đang\b/i.test(String(text || "").trim());
}

function looksLikeToolArgumentPayload(text, { requireCodexHint = true } = {}) {
  const source = String(text || "").trim().replace(/\\"/g, '"');
  if (!source || source.length > 12000 || !source.startsWith("{") || !source.endsWith("}")) return false;
  try {
    const payload = JSON.parse(source);
    if (!payload || Array.isArray(payload) || typeof payload !== "object") return false;
    const keys = Object.keys(payload);
    if (!keys.length) return false;
    const codexHint = JSON.stringify(payload).toLowerCase().includes("codexpro");
    const toolKeys = new Set(["action", "args", "browser", "command", "cwd", "path", "paths", "profile_id", "query", "root", "scope", "selector", "target_id", "task_id", "task_kind", "task_title", "text", "url", "workspace_id"]);
    return (!requireCodexHint || codexHint) && keys.every((key) => toolKeys.has(key));
  } catch {
    return false;
  }
}

export function toolActivityFromText(text, { collapseArgumentPayload = false } = {}) {
  const source = String(text || "").trim();
  if (!source) return null;
  if (collapseArgumentPayload && looksLikeToolArgumentPayload(source, { requireCodexHint: false })) return GENERIC_TOOL_ACTIVITY_TEXT;
  const normalized = source.replace(/\\"/g, '"');
  if (normalized.includes("/CodexPro/") && normalized.includes("args")) return GENERIC_TOOL_ACTIVITY_TEXT;
  if (looksLikeToolArgumentPayload(normalized)) return GENERIC_TOOL_ACTIVITY_TEXT;
  return null;
}

export function compactToolActivityMessages(messages, { collapseArgumentPayloads = false } = {}) {
  const output = [];
  let pendingActivity = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    const activity = message?.role === "assistant" ? toolActivityFromText(message.text, { collapseArgumentPayload: collapseArgumentPayloads }) : null;
    if (activity) {
      pendingActivity = { ...message, id: "codexpro-live-tool-activity", text: GENERIC_TOOL_ACTIVITY_TEXT, toolActivity: true };
      continue;
    }
    if (pendingActivity) {
      output.push(pendingActivity);
      pendingActivity = null;
    }
    output.push(message);
  }
  if (pendingActivity) output.push(pendingActivity);
  return output;
}

export function sendDebugEvidence(result = {}, error = null) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  const source = result && typeof result === "object" ? result : {};
  const field = (name) => source[name] ?? details[name];
  const evidence = Array.isArray(source.network_evidence)
    ? source.network_evidence.slice(-12)
    : Array.isArray(details.network_evidence)
      ? details.network_evidence.slice(-12)
      : [];
  return {
    recordedAt: new Date().toISOString(),
    attemptId: String(source.attempt_id || details.attempt_id || details.command_id || ""),
    state: String(source.submission_state || (error ? "failed" : "")),
    path: String(source.submitted_by || source.submit_path || details.submitted_by || details.stage || ""),
    pathAttempted: Array.isArray(source.path_attempted) ? source.path_attempted : [],
    networkAck: source.network_acknowledged === true,
    endpoint: String(source.network_generation_endpoint || details.network_generation_endpoint || ""),
    statusCode: Number(source.network_status_code || details.network_status_code) || 0,
    message: String(source.error || error?.message || details.message || ""),
    code: String(error?.code || details.code || ""),
    trustedEnterError: String(source.trusted_enter_error || details.trusted_enter_error || ""),
    trustedClickError: String(source.trusted_click_error || details.trusted_click_error || ""),
    fallbackReason: String(source.fallback_reason || details.fallback_reason || ""),
    request_payload_sha256: String(field("request_payload_sha256") || ""),
    request_payload_length: Number(field("request_payload_length")) || 0,
    target_id: Number(field("target_id")) || 0,
    find_tab_ms: Number(field("find_tab_ms")) || 0,
    binding_hit: field("binding_hit") === true,
    binding_validation_ms: Number(field("binding_validation_ms")) || 0,
    tab_activation_ms: Number(field("tab_activation_ms")) || 0,
    prepare_ms: Number(field("prepare_ms")) || 0,
    prepare_transport: String(field("prepare_transport") || ""),
    prepare_step_ms: field("prepare_step_ms") && typeof field("prepare_step_ms") === "object" ? field("prepare_step_ms") : null,
    send_button_selector: String(field("send_button_selector") || ""),
    send_button_hit_test: field("send_button_hit_test") === true,
    trusted_click_ms: Number(field("trusted_click_ms")) || 0,
    send_button_actually_clicked: field("send_button_actually_clicked") === true,
    composer_present_after_click: field("composer_present_after_click") === true,
    composer_matches_payload_after_click: field("composer_matches_payload_after_click") === true,
    matching_user_message_after_click: field("matching_user_message_after_click") === true,
    generation_ack_ms: Number(field("generation_ack_ms")) || 0,
    generation_endpoint: String(field("generation_endpoint") || source.network_generation_endpoint || details.network_generation_endpoint || ""),
    retry_click_count: Number(field("retry_click_count")) || 0,
    evidence
  };
}
