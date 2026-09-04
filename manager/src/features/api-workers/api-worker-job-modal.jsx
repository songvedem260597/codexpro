import React, { useEffect, useState } from "react";
import { WorkerIcon, WorkingBadge } from "../../components/worker-ui.jsx";
import { formatFileSize } from "../../file-size.js";
import { LatestMessagePanel } from "../../latest-message-panel.jsx";
import { ALL_ALLOWED_WORKSPACES, ProjectDropdown } from "../../project-dropdown.jsx";

const api = window.codexpro;

function apiJobId() {
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);
  return `cpt_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function ApiWorkerJobModal({ worker, projects, customImages, attachments, onChooseAttachments, onOpenAttachmentPreview, onRemoveAttachment, onClearAttachments, onPaste, onCopyResponse, onClose, onStarted, onError }) {
  const [root, setRoot] = useState(projects[0]?.root || "");
  const [request, setRequest] = useState("");
  const [lastRequest, setLastRequest] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!root && projects[0]?.root) setRoot(projects[0].root);
  }, [projects, root]);

  if (!worker) return null;
  const processing = worker.activity === "working";
  const working = sending || processing;
  const allAllowedScope = root === ALL_ALLOWED_WORKSPACES;
  const displayedRequest = lastRequest || worker.last_request || "";
  const valid = Boolean(root && (request.trim() || attachments.length) && worker.connected && !working);

  const submit = async () => {
    if (!valid) return;
    setSending(true);
    try {
      await api.sendWorkerRequest({
        workerId: worker.worker_id,
        task_id: apiJobId(),
        task_kind: "code",
        scope: allAllowedScope ? "all_allowed" : "workspace",
        root: allAllowedScope ? "" : root,
        workspaceCandidates: allAllowedScope ? projects.map((project) => project.root) : [],
        text: request.trim(),
        attachments
      });
      setLastRequest(request.trim() || `Đã gửi ${attachments.length} file`);
      setRequest("");
      onClearAttachments();
      onStarted();
    } catch (error) {
      onError(error);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-backdrop chat-modal-backdrop" role="dialog" aria-modal="true" aria-label="Chạy API worker" onMouseDown={(event) => event.target === event.currentTarget && !sending && onClose()}>
      <div className="modal chat-modal api-job-modal">
        <div className="modal-head chat-modal-head">
          <div className="chat-modal-profile">
            <WorkerIcon state={working ? "working" : worker.connected ? "idle" : "hung"} customImages={customImages} />
            <div>
              <p className="eyebrow">API WORKER · {worker.provider}</p>
              <div className="profile-title"><strong>{worker.label}</strong>{working ? <WorkingBadge /> : worker.connected ? <span className="badge connected">ĐANG RẢNH</span> : <span className="badge profile-hung">MẤT KẾT NỐI</span>}</div>
              <code>{worker.worker_id} · {worker.model}</code>
            </div>
          </div>
          <button type="button" aria-label="Đóng job" onClick={onClose}><span aria-hidden="true">×</span></button>
        </div>

        <article className={`request-card chat-popup-card ${worker.connected ? "is-online" : "is-offline"}`}>
          <label className="request-label">Chọn repo và đường dẫn</label>
          <ProjectDropdown value={root} projects={projects} onChange={setRoot} disabled={working} />
          {!projects.length && !allAllowedScope && <div className="request-send-error">Chưa có workspace đã lưu. Chọn “Tất cả vùng được cấp quyền” để CodexPro tự tìm.</div>}

          <label className="request-label request-section-label">Tin nhắn gần nhất</label>
          <LatestMessagePanel
            working={processing}
            headline={sending ? "Đang gửi tin nhắn…" : processing ? "CodexPro đang xử lý…" : ""}
            title={worker.current_task_title || worker.last_task_title || ""}
            requestText={displayedRequest}
            responseText={worker.stream_text || worker.last_result || ""}
            error={worker.last_error || ""}
            emptyText="Gửi yêu cầu đầu tiên để bắt đầu job trong repo đã chọn."
            phase={worker.stream_phase || ""}
            toolStatus={worker.stream_tool_status || ""}
            turnId={worker.current_task_id || worker.last_task_id || ""}
            revision={worker.stream_revision || 0}
            onCopyResponse={onCopyResponse}
          />

          <label className="request-label" htmlFor="api-job-request">Nhắn tiếp</label>
          <div className="request-composer">
            <textarea
              id="api-job-request"
              value={request}
              maxLength={20000}
              placeholder="Nhập file hoặc tin nhắn"
              onPaste={onPaste}
              onChange={(event) => setRequest(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent?.isComposing || event.repeat || !valid || sending) return;
                event.preventDefault();
                void submit();
              }}
              disabled={working}
            />
            {attachments.length > 0 && <div className="request-files">{attachments.map((file) => <div className="request-file" key={file.path} title={file.path} role="button" tabIndex={0} aria-label={`Xem trước ${file.name}`} onClick={() => void onOpenAttachmentPreview(file)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void onOpenAttachmentPreview(file); } }}>{file.previewDataUrl ? <img className="request-file-image" src={file.previewDataUrl} alt="" /> : <span className="request-file-icon">▤</span>}<span className="request-file-copy"><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small></span><button type="button" aria-label={`Bỏ ${file.name}`} onClick={(event) => { event.stopPropagation(); onRemoveAttachment(file.path); }} disabled={working}>×</button></div>)}</div>}
            <div className="request-composer-toolbar">
              <button type="button" className="attach-button" aria-label="Thêm file" title="Thêm file" onClick={onChooseAttachments} disabled={working || attachments.length >= 4}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20.5 11.5 11 21a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.6l-10 10a2 2 0 1 1-2.9-2.8l9.6-9.6" /></svg></button>
              <span>{attachments.length ? `${attachments.length}/4 file · ${formatFileSize(attachments.reduce((total, file) => total + file.size, 0))}` : `${request.length.toLocaleString("vi-VN")}/20.000 · TXT, PDF, mã nguồn, Office, ảnh…`}</span>
            </div>
          </div>

          <div className="request-card-foot">
            <span>AI tự đặt title 4–6 từ; Rules, AGENTS, CodexGraph và tool call đều đi qua MCP.</span>
            <div className="request-card-actions">
              <button type="button" className="button secondary" onClick={onClose}>Đóng</button>
              <button type="button" className="button primary" disabled={!valid} onClick={() => void submit()}>{working ? "Đang xử lý…" : attachments.length ? "Tải file + gửi" : "Gửi yêu cầu"}</button>
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}
