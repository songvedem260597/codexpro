import React from "react";

const CodeGraphView = React.lazy(() => import("../../code-graph-view.jsx").then((module) => ({ default: module.CodeGraphView })));

export function InspectionModal({ inspection, onClose }) {
  if (!inspection) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal codexgraph-modal">
        <div className="modal-head">
          <div><p className="eyebrow">MCP INSPECTION</p><h2>{inspection.project.name}</h2></div>
          <button type="button" aria-label="Đóng kiểm tra workspace" onClick={onClose}>×</button>
        </div>
        <div className="inspection-grid">
          <div><small>Workspace ID</small><code>{inspection.result.workspace_id || "—"}</code></div>
          <div><small>Root</small><code>{inspection.result.root || inspection.project.root}</code></div>
        </div>
        <React.Suspense fallback={<div className="codexgraph-loading">Đang tải Code Graph…</div>}>
          <CodeGraphView graphData={inspection.result.codexgraph} />
        </React.Suspense>
        <details className="codexgraph-raw-details">
          <summary>Chi tiết workspace / Git / cây dự án</summary>
          <h3>Git status</h3>
          <pre>{inspection.result.git_status || "Working tree sạch hoặc không có dữ liệu."}</pre>
          <h3>Cây dự án</h3>
          <pre>{inspection.result.tree || inspection.result.tree_text || "CodexPro đã mở workspace thành công."}</pre>
        </details>
      </div>
    </div>
  );
}
