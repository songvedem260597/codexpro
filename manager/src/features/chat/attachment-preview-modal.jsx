import React from "react";
import { formatFileSize } from "../../file-size.js";

export function AttachmentPreviewModal({ preview, onClose }) {
  if (!preview) return null;

  return (
    <div
      className="modal-backdrop attachment-lightbox-backdrop"
      tabIndex={-1}
      autoFocus
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={`Xem trước ${preview.name || "file"}`}>
        <div className="attachment-lightbox-head">
          <div>
            <strong title={preview.name || ""}>{preview.name || "File đính kèm"}</strong>
            <span>{[preview.mimeType, formatFileSize(Number(preview.size) || 0)].filter(Boolean).join(" · ")}{preview.truncated ? " · chỉ hiển thị phần đầu" : ""}</span>
          </div>
          <button type="button" aria-label="Đóng xem trước" onClick={onClose}>×</button>
        </div>
        <div className={`attachment-lightbox-body is-${preview.loading ? "loading" : preview.kind || "unsupported"}`}>
          {preview.loading ? (
            <div className="attachment-preview-state"><span className="typing-dots"><i /><i /><i /></span><span>Đang mở file…</span></div>
          ) : preview.kind === "image" ? (
            <img src={preview.dataUrl} alt={preview.name || "Ảnh đính kèm"} />
          ) : preview.kind === "text" ? (
            <pre>{preview.text || "(File không có nội dung văn bản.)"}</pre>
          ) : (
            <div className="attachment-preview-state is-error"><strong>Không thể xem trước file này</strong><span>{preview.error || "CodexPro hiện hỗ trợ lightbox cho ảnh và file văn bản."}</span></div>
          )}
        </div>
      </div>
    </div>
  );
}
