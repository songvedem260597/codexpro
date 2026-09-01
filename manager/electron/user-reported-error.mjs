import { createHash } from "node:crypto";

const MAX_REPORT_TEXT = 4000;
const MAX_REPORT_EXCERPT = 1800;
const LOG_ATTACHMENT_PATTERN = /(?:^|[._-])(?:error|errors|exception|traceback|stack|crash|failure|failed|debug|diagnostic|log)(?:[._-]|$)|\.(?:log|trace|err)$/i;
const PLANNING_ERROR_PATTERN = /(?:thêm|bổ sung|tạo|xây dựng|viết|giải thích|hướng dẫn|phân loại|nhận biết|implement|add|create|document|describe)[\s\S]{0,180}(?:xử lý lỗi|lỗi|error handling|exception handling|errors?)/i;

const ERROR_SIGNALS = [
  { id: "technical-exception", confidence: "high", pattern: /\b(?:typeerror|referenceerror|syntaxerror|rangeerror|assertionerror|exception|traceback|stack\s*trace|panic|fatal\s+error|segmentation\s+fault)\b/i },
  { id: "structured-error-log", confidence: "high", pattern: /(?:^|\n)\s*(?:\[[^\]]*error[^\]]*\]|error|exception|fatal|panic)\s*[:\-]/im },
  { id: "http-error-status", confidence: "high", pattern: /\b(?:http\/?\s*|status(?:\s+code)?\s*[:=]?\s*)[45]\d{2}\b/i },
  { id: "observed-broken-behavior", confidence: "high", pattern: /(?:không|ko)\s+(?:chạy|hoạt động|mở|hiện|kết nối|phản hồi|gửi|cập nhật|đóng|xóa|nhận)|vẫn\s+(?:báo|hiện|lỗi|không)|báo\s+(?:sai|rảnh|lỗi)|(?:bị|đang)\s+(?:treo|crash|lỗi)|mất\s+kết\s+nối|không\s+phản\s+hồi/i },
  { id: "runtime-failure", confidence: "high", pattern: /\b(?:failed|failure|crash(?:ed|es|ing)?|timeout|timed\s*out|unresponsive|broken)\b/i },
  { id: "explicit-user-error", confidence: "medium", pattern: /(?:^|[\s.,;:!?])(lỗi|bug|error)(?=$|[\s.,;:!?])/i }
];

function attachmentName(value) {
  const raw = String(value?.name || value?.path || value || "").trim();
  return raw.split(/[\\/]/).pop().slice(0, 260);
}

function normalizeIncidentSignature(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/gi, "<timestamp>")
    .replace(/\b\d{1,2}[/:.-]\d{1,2}[/:.-]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/g, "<timestamp>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<id>")
    .replace(/\b(?:request|req|trace|task|tab|profile|process|pid|job|run)[\s#:=_-]*[a-z0-9._-]{4,}\b/gi, (match) => `${match.split(/[\s#:=_-]/, 1)[0]} <id>`)
    .replace(/\b\d{2,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REPORT_TEXT);
}

function reportSummary(text, attachmentNames) {
  const firstLine = String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  if (firstLine) return firstLine.slice(0, 260);
  return attachmentNames.length ? `File log đính kèm: ${attachmentNames.join(", ")}`.slice(0, 260) : "Lỗi do người dùng báo";
}

export function classifyUserReportedError(input = {}) {
  const text = String(input?.text || input?.request || "").trim().slice(0, MAX_REPORT_TEXT);
  const attachments = Array.isArray(input?.attachments)
    ? input.attachments
    : Array.isArray(input?.attachment_names)
      ? input.attachment_names
      : [];
  const attachmentNames = attachments.map(attachmentName).filter(Boolean).slice(0, 10);
  const logAttachmentNames = attachmentNames.filter((name) => LOG_ATTACHMENT_PATTERN.test(name));
  const matchedSignals = ERROR_SIGNALS.filter((signal) => signal.pattern.test(text));
  if (logAttachmentNames.length) matchedSignals.push({ id: "log-attachment", confidence: "high" });
  const hasHighConfidenceSignal = matchedSignals.some((signal) => signal.confidence === "high");
  const planningOnly = PLANNING_ERROR_PATTERN.test(text) && !hasHighConfidenceSignal && !logAttachmentNames.length;
  const isError = matchedSignals.length > 0 && !planningOnly;
  if (!isError) {
    return {
      is_error: false,
      classification: "not_error",
      detection_confidence: "none",
      detection_signals: [],
      incident_fingerprint: "",
      summary: "",
      excerpt: "",
      attachment_names: attachmentNames
    };
  }
  const normalized = normalizeIncidentSignature(`${text}\n${logAttachmentNames.join(" ")}`) || "user-reported-error";
  const fingerprint = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 24);
  return {
    is_error: true,
    classification: "user_discovered_error",
    detection_confidence: hasHighConfidenceSignal || logAttachmentNames.length ? "high" : "medium",
    detection_signals: [...new Set(matchedSignals.map((signal) => signal.id))],
    incident_fingerprint: fingerprint,
    summary: reportSummary(text, logAttachmentNames),
    excerpt: text.slice(0, MAX_REPORT_EXCERPT),
    attachment_names: attachmentNames
  };
}

export { normalizeIncidentSignature };
