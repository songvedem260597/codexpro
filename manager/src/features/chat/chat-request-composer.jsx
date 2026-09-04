import React, { useCallback, useEffect, useRef, useState } from "react";
import { formatFileSize } from "../../file-size.js";

function SendDebugEvidence({ evidence }) {
  if (!evidence) return null;
  const rows = [
    ["Attempt", evidence.attemptId || "—"],
    ["Submission", evidence.state || "—"],
    ["Path", evidence.path || "—"],
    ["Path attempted", evidence.pathAttempted?.join(" → ") || "—"],
    ["Network ACK", evidence.networkAck ? "yes" : "no"],
    ["Endpoint", evidence.endpoint || "—"],
    ["HTTP", evidence.statusCode || "—"],
    ["Fallback", evidence.fallbackReason || "—"],
    ["Enter error", evidence.trustedEnterError || "—"],
    ["Click error", evidence.trustedClickError || "—"],
    ["Error", evidence.message || "—"]
  ];
  return (
    <details className="send-debug-evidence">
      <summary>Debug Evidence <span>{evidence.networkAck ? "network ACK" : evidence.state || "attempt"}</span></summary>
      <div className="send-debug-grid">
        {rows.map(([label, value]) => <div className="send-debug-row" key={label}><strong>{label}</strong><code>{String(value)}</code></div>)}
      </div>
      {evidence.evidence?.length > 0 && (
        <ol className="send-debug-timeline">
          {evidence.evidence.map((item, index) => (
            <li key={`${item.observed_at || index}-${item.endpoint || index}`}>
              <time>{item.observed_at ? new Date(item.observed_at).toLocaleTimeString("vi-VN") : "—"}</time>
              <code>{item.phase || "event"}</code>
              <span>{item.endpoint || "unknown endpoint"}{item.status_code ? ` · HTTP ${item.status_code}` : ""}{item.error ? ` · ${item.error}` : ""}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

export function ChatRequestComposer({
  profileId,
  initialDraft,
  draftResetVersion,
  attachments,
  placeholder,
  disabled,
  attachmentDisabled,
  canSendBase,
  sending,
  rolloverCreating,
  selectedBusy,
  selectedSettling,
  isNewChat,
  sendError,
  sendEvidence,
  canOpenChrome,
  onPaste,
  onChooseAttachments,
  onOpenAttachmentPreview,
  onRemoveAttachment,
  onClearSendError,
  onDraftSnapshot,
  onDraftActivityChange,
  onClose,
  onOpenChrome,
  onSend
}) {
  const [draft, setDraft] = useState(() => String(initialDraft || ""));
  const draftRef = useRef(String(initialDraft || ""));
  const sendingRef = useRef(false);

  const updateDraft = useCallback((nextDraft) => {
    const normalized = String(nextDraft || "");
    draftRef.current = normalized;
    setDraft(normalized);
    onDraftSnapshot(normalized);
    onDraftActivityChange(Boolean(normalized.trim()));
  }, [onDraftActivityChange, onDraftSnapshot]);

  useEffect(() => {
    updateDraft(initialDraft);
  }, [profileId, draftResetVersion]);

  const canSend = canSendBase && Boolean(draft.trim() || attachments.length);

  const submit = useCallback(async () => {
    if (!canSend || sendingRef.current) return;
    const submittedDraft = draft;
    sendingRef.current = true;
    try {
      const submitted = await onSend(submittedDraft);
      if (submitted && draftRef.current === submittedDraft) updateDraft("");
    } finally {
      sendingRef.current = false;
    }
  }, [canSend, draft, onSend, updateDraft]);

  return (
    <>
      <label className="request-label" htmlFor={`request-${profileId}`}>Nhắn tiếp</label>
      <div className="request-composer">
        <textarea
          id={`request-${profileId}`}
          value={draft}
          maxLength={20000}
          placeholder={placeholder}
          onPaste={onPaste}
          onChange={(event) => {
            updateDraft(event.target.value);
            if (sendError) onClearSendError();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent?.isComposing || event.repeat) return;
            if (!canSend) return;
            event.preventDefault();
            void submit();
          }}
          disabled={disabled}
        />
        {attachments.length > 0 && (
          <div className="request-files">
            {attachments.map((file) => (
              <div className="request-file" key={file.path} title={file.path} role="button" tabIndex={0} aria-label={`Xem trước ${file.name}`} onClick={() => void onOpenAttachmentPreview(file)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void onOpenAttachmentPreview(file); } }}>
                {file.previewDataUrl
                  ? <img className="request-file-image" src={file.previewDataUrl} alt="" />
                  : <span className="request-file-icon">▤</span>}
                <span className="request-file-copy"><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small></span>
                <button type="button" aria-label={`Bỏ ${file.name}`} onClick={(event) => { event.stopPropagation(); onRemoveAttachment(file.path); }} disabled={sending}>×</button>
              </div>
            ))}
          </div>
        )}
        <div className="request-composer-toolbar">
          <button type="button" className="attach-button" aria-label="Thêm file" title="Thêm file" onClick={onChooseAttachments} disabled={attachmentDisabled || attachments.length >= 4}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M20.5 11.5 11 21a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.6l-10 10a2 2 0 1 1-2.9-2.8l9.6-9.6" />
            </svg>
          </button>
          <span>{attachments.length ? `${attachments.length}/4 file · ${formatFileSize(attachments.reduce((total, file) => total + file.size, 0))}` : `${draft.length.toLocaleString("vi-VN")}/20.000 · TXT, PDF, mã nguồn, Office, ảnh…`}</span>
        </div>
      </div>
      {sendError && <div className="request-send-error">{sendError}</div>}
      <SendDebugEvidence evidence={sendEvidence} />
      <div className="request-card-foot">
        {selectedBusy && <span>Đang nhận phản hồi</span>}
        <div className="request-card-actions">
          <button type="button" className="button secondary" onClick={onClose}>Đóng</button>
          <button type="button" className="button secondary" onClick={onOpenChrome} disabled={!canOpenChrome}>Mở Chrome</button>
          <button type="button" className="button primary" onClick={() => void submit()} disabled={!canSend}>{sending ? (isNewChat ? "Đang tạo chat…" : attachments.length ? "Đang tải file + gửi…" : "Đang gửi…") : rolloverCreating ? "Đang chuyển chat…" : selectedBusy || selectedSettling ? "Gửi thêm" : isNewChat ? "Tạo chat + gửi" : "Gửi tin nhắn"}</button>
        </div>
      </div>
    </>
  );
}
