import fs from "node:fs";
import path from "node:path";

const DEFAULT_LAYOUT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_LAYOUT_ENTRY_MAX_BYTES = 32 * 1024;
const DEFAULT_AUDIT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_AUDIT_ENTRY_MAX_BYTES = 48 * 1024;

export function createManagerChatDiagnostics({
  home,
  diagnostic,
  now = () => new Date().toISOString(),
  layoutMaxBytes = DEFAULT_LAYOUT_MAX_BYTES,
  layoutEntryMaxBytes = DEFAULT_LAYOUT_ENTRY_MAX_BYTES,
  auditMaxBytes = DEFAULT_AUDIT_MAX_BYTES,
  auditEntryMaxBytes = DEFAULT_AUDIT_ENTRY_MAX_BYTES
}) {
  const managerChatLayoutLogFile = path.join(home, "manager-chat-layout.jsonl");
  const managerChatLayoutPreviousLogFile = path.join(home, "manager-chat-layout.previous.jsonl");
  const managerChatResponseAuditLogFile = path.join(home, "manager-chat-response-audit.jsonl");
  const managerChatResponseAuditPreviousLogFile = path.join(home, "manager-chat-response-audit.previous.jsonl");
  let managerChatLayoutLogWrite = Promise.resolve();
  let managerChatResponseAuditLogWrite = Promise.resolve();
  const responseAuditDiagnosticState = new Map();

  function appendRotatingJsonLine({ payload, currentFile, previousFile, maxBytes, maxEntryBytes, onError }) {
    let line = "";
    try {
      line = JSON.stringify({ loggedAt: now(), ...(payload && typeof payload === "object" ? payload : {}) });
    } catch {
      return Promise.resolve();
    }
    if (Buffer.byteLength(line, "utf8") > maxEntryBytes) return Promise.resolve();
    return fs.promises.mkdir(home, { recursive: true }).then(async () => {
      try {
        const stat = await fs.promises.stat(currentFile);
        if (stat.size >= maxBytes) {
          await fs.promises.rm(previousFile, { force: true });
          await fs.promises.rename(currentFile, previousFile);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await fs.promises.appendFile(currentFile, line + "\n", "utf8");
    }).catch(onError);
  }

  function appendManagerChatLayoutLog(payload) {
    managerChatLayoutLogWrite = managerChatLayoutLogWrite.then(() => appendRotatingJsonLine({
      payload,
      currentFile: managerChatLayoutLogFile,
      previousFile: managerChatLayoutPreviousLogFile,
      maxBytes: layoutMaxBytes,
      maxEntryBytes: layoutEntryMaxBytes,
      onError: (error) => {
        console.error("[manager-chat-layout]", error?.message || error);
        diagnostic("error", "manager", "logging", `Không ghi được chat layout log: ${error?.message || String(error)}`, { action: "write-chat-layout-log", error });
      }
    }));
  }

  function appendManagerChatResponseAuditLog(payload) {
    managerChatResponseAuditLogWrite = managerChatResponseAuditLogWrite.then(() => appendRotatingJsonLine({
      payload,
      currentFile: managerChatResponseAuditLogFile,
      previousFile: managerChatResponseAuditPreviousLogFile,
      maxBytes: auditMaxBytes,
      maxEntryBytes: auditEntryMaxBytes,
      onError: (error) => {
        console.error("[manager-chat-response-audit]", error?.message || error);
        diagnostic("error", "manager", "logging", `Không ghi được response audit log: ${error?.message || String(error)}`, { action: "write-chat-response-audit-log", error });
      }
    }));
  }

  function responseAuditFingerprintSummary(value) {
    if (!value || typeof value !== "object") return null;
    return {
      fingerprint: String(value.fingerprint || ""),
      length: Number(value.length) || 0
    };
  }

  function recordChatResponseAuditDiagnostic(payload) {
    const record = payload && typeof payload === "object" ? payload : {};
    const comparison = String(record.comparison || "");
    const profileId = String(record.profileId || "");
    const conversationId = String(record.conversationId || "");
    if (!profileId || !conversationId || !comparison) return;
    const key = `${profileId}:${conversationId}`;
    const previous = responseAuditDiagnosticState.get(key);
    responseAuditDiagnosticState.set(key, comparison);
    if (previous === comparison) return;
    if (comparison === "match") {
      if (previous && previous !== "match") {
        diagnostic("info", "renderer", "chat-audit", "Nội dung Manager đã khớp lại với nguồn ChatGPT", {
          action: "chat-response-audit-recovered",
          profile_id: profileId,
          conversation_id: conversationId,
          request_id: String(record.requestId || ""),
          previous_comparison: previous,
          fetch_mode: String(record.fetchMode || ""),
          selected_source: String(record.selectedSource || ""),
          comparison_basis: String(record.comparisonBasis || "")
        });
      }
      return;
    }
    const terminal = ["completed", "failed", "cancelled"].includes(String(record.networkState || "").toLowerCase());
    const actionable = [
      "missing_in_manager_state",
      "manager_state_mismatch",
      "missing_in_manager_ui",
      "manager_ui_mismatch"
    ].includes(comparison) || (terminal && ["source_unavailable", "source_missing_latest_assistant"].includes(comparison));
    if (!actionable) return;
    const basis = record?.sources?.chatgptDom?.available
      ? record.sources.chatgptDom
      : record?.sources?.canonical?.available
        ? record.sources.canonical
        : record?.sources?.networkStream || {};
    diagnostic(comparison.includes("missing_in_manager") || comparison.includes("mismatch") ? "error" : "warn", "renderer", "chat-audit", `Sai lệch phản hồi ChatGPT: ${comparison}`, {
      action: "chat-response-audit-mismatch",
      profile_id: profileId,
      conversation_id: conversationId,
      request_id: String(record.requestId || ""),
      comparison,
      fetch_mode: String(record.fetchMode || ""),
      network_state: String(record.networkState || ""),
      selected_source: String(record.selectedSource || ""),
      comparison_basis: String(record.comparisonBasis || ""),
      source_message_count: Number(basis?.messageCount) || 0,
      manager_state_message_count: Number(record?.managerState?.messageCount) || 0,
      manager_ui_message_count: Number(record?.managerUi?.messageCount) || 0,
      expected_assistant: responseAuditFingerprintSummary(basis?.assistantAfterLatestUser || basis?.latestAssistant),
      manager_state_assistant: responseAuditFingerprintSummary(record?.managerState?.assistantAfterLatestUser || record?.managerState?.latestAssistant),
      manager_ui_assistant: responseAuditFingerprintSummary(record?.managerUi?.assistantAfterLatestUser || record?.managerUi?.latestAssistant)
    });
  }

  async function flush() {
    await Promise.all([managerChatLayoutLogWrite, managerChatResponseAuditLogWrite]);
  }

  return {
    appendManagerChatLayoutLog,
    appendManagerChatResponseAuditLog,
    recordChatResponseAuditDiagnostic,
    flush
  };
}
