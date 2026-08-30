import React from "react";

const LEVEL_LABELS = { info: "INFO", warn: "CẢNH BÁO", error: "LỖI" };

export function diagnosticTime(value) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) return "--";
  return new Date(parsed).toLocaleString("vi-VN", { hour12: false });
}

export function logRendererDiagnostic(api, level, category, message, details = {}) {
  try {
    api?.logDiagnostic?.({
      level,
      source: "renderer",
      category,
      action: details?.action || "",
      message,
      details
    });
  } catch {
    // Diagnostic logging must never affect the UI action being observed.
  }
}

export function DiagnosticLogView({ data, filters, busy, selected, onFilters, onRefresh, onClear, onSelect, onCopy }) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const summary = data?.summary || { total: 0, info: 0, warn: 0, error: 0 };
  const sourceOptions = ["all", ...new Set(["renderer", "mcp", ...(data?.sources || [])])];
  const categoryOptions = ["all", ...new Set(["runtime", "status", "projects", "profile", "chat", "network", "tool", "transport", ...(data?.categories || [])])];

  return (
    <div className="diagnostic-view">
      <section className="diagnostic-summary-grid" aria-label="Tóm tắt log 24 giờ">
        <article><span>Tổng log</span><strong>{summary.total || 0}</strong><small>trong {data?.queried_hours || filters.hours} giờ</small></article>
        <article className="is-error"><span>Lỗi</span><strong>{summary.error || 0}</strong><small>cần ưu tiên điều tra</small></article>
        <article className="is-warn"><span>Cảnh báo</span><strong>{summary.warn || 0}</strong><small>có thể tự phục hồi</small></article>
        <article className="is-info"><span>Thông tin</span><strong>{summary.info || 0}</strong><small>MCP / runtime bình thường</small></article>
      </section>

      <section className="diagnostic-panel">
        <div className="diagnostic-toolbar">
          <input
            className="diagnostic-search"
            value={filters.query}
            onChange={(event) => onFilters({ query: event.target.value })}
            placeholder="Tìm lỗi, action, profile, task..."
            aria-label="Tìm trong nhật ký"
          />
          <select value={filters.level} onChange={(event) => onFilters({ level: event.target.value })} aria-label="Lọc mức log">
            <option value="all">Tất cả mức</option>
            <option value="error">Lỗi</option>
            <option value="warn">Cảnh báo</option>
            <option value="info">Info</option>
          </select>
          <select value={filters.source} onChange={(event) => onFilters({ source: event.target.value })} aria-label="Lọc nguồn log">
            {sourceOptions.map((value) => <option key={value} value={value}>{value === "all" ? "Tất cả nguồn" : value}</option>)}
          </select>
          <select value={filters.category} onChange={(event) => onFilters({ category: event.target.value })} aria-label="Lọc nhóm log">
            {categoryOptions.map((value) => <option key={value} value={value}>{value === "all" ? "Tất cả nhóm" : value}</option>)}
          </select>
          <select value={filters.hours} onChange={(event) => onFilters({ hours: Number(event.target.value) })} aria-label="Khoảng thời gian log">
            <option value={1}>1 giờ</option>
            <option value={6}>6 giờ</option>
            <option value={12}>12 giờ</option>
            <option value={24}>24 giờ</option>
          </select>
          <button className="button secondary diagnostic-refresh" type="button" onClick={onRefresh} disabled={busy}>{busy ? "Đang tải…" : "Làm mới"}</button>
          <button className="button danger-quiet" type="button" onClick={onClear} disabled={busy || !summary.total}>Xóa log</button>
        </div>

        <div className="diagnostic-retention-note">
          <span>Chỉ lưu tối đa 24 giờ</span>
          <small>{data?.checked_at ? `Cập nhật ${diagnosticTime(data.checked_at)}` : "Chưa tải log"}</small>
        </div>

        <div className="diagnostic-table" role="table" aria-label="Nhật ký chẩn đoán CodexPro">
          <div className="diagnostic-row diagnostic-head" role="row">
            <span>Thời gian</span><span>Mức</span><span>Nguồn / nhóm</span><span>Action</span><span>Nội dung</span><span>Thời lượng</span>
          </div>
          {!entries.length && <div className="diagnostic-empty">Không có log phù hợp trong khoảng thời gian đã chọn.</div>}
          {entries.map((entry, index) => {
            const key = `${entry.timestamp || "log"}:${entry.source || ""}:${entry.action || ""}:${index}`;
            const active = selected === entry;
            return (
              <button className={`diagnostic-row diagnostic-entry is-${entry.level || "info"} ${active ? "is-selected" : ""}`} type="button" role="row" key={key} onClick={() => onSelect(active ? null : entry)}>
                <span className="diagnostic-time">{diagnosticTime(entry.timestamp)}</span>
                <span><b className={`diagnostic-level is-${entry.level || "info"}`}>{LEVEL_LABELS[entry.level] || "INFO"}</b></span>
                <span className="diagnostic-source"><strong>{entry.source || "manager"}</strong><small>{entry.category || "runtime"}</small></span>
                <span className="diagnostic-action">{entry.action || "—"}</span>
                <span className="diagnostic-message">{entry.message || "—"}</span>
                <span className="diagnostic-duration">{Number.isFinite(Number(entry.duration_ms)) ? `${Number(entry.duration_ms)} ms` : "—"}</span>
              </button>
            );
          })}
        </div>

        {selected && (
          <div className="diagnostic-detail">
            <div className="diagnostic-detail-head">
              <div><b>{LEVEL_LABELS[selected.level] || "INFO"} · {selected.source || "manager"}</b><span>{diagnosticTime(selected.timestamp)} · {selected.category || "runtime"}</span></div>
              <button className="button secondary" type="button" onClick={() => onCopy(selected)}>Copy chi tiết</button>
            </div>
            <strong>{selected.message || "Không có message"}</strong>
            <pre>{JSON.stringify({ action: selected.action || "", duration_ms: selected.duration_ms ?? null, details: selected.details || {} }, null, 2)}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
