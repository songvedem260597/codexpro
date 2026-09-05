import React from "react";

export function WorkerUpdateConfirmModal({ open, reloadCount, deferredUpdateCount, workerVersion, onClose, onConfirm }) {
  if (!open) return null;

  return (
    <div className="modal-backdrop worker-update-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="worker-update-dialog" role="dialog" aria-modal="true" aria-labelledby="worker-update-title">
        <div className="worker-update-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
            <path d="M5 17v2h14v-2" />
          </svg>
        </div>
        <div className="worker-update-copy">
          <p className="eyebrow">WORKER UPDATE</p>
          <h2 id="worker-update-title">Cập nhật CodexPro Worker</h2>
          <p>Cập nhật <strong>{reloadCount} worker đang rảnh</strong> lên phiên bản <code>{workerVersion}</code>.</p>
          {deferredUpdateCount > 0 && <p className="worker-update-note">{deferredUpdateCount} worker đang làm việc sẽ được giữ nguyên để không gián đoạn task.</p>}
        </div>
        <div className="worker-update-actions">
          <button type="button" className="button ghost" onClick={onClose}>Hủy</button>
          <button type="button" className="button primary" onClick={onConfirm}>Cập nhật worker</button>
        </div>
      </div>
    </div>
  );
}
