import React, { useEffect, useRef, useState } from "react";

const LEVEL_LABELS = { info: "INFO", warn: "CẢNH BÁO", error: "LỖI" };
const SOURCE_LABELS = { manager: "Manager", renderer: "Giao diện", mcp: "MCP", worker: "Worker", electron: "Electron" };
const DIAGNOSTIC_RENDER_BATCH = 180;

const CATEGORY_LABELS = {
  runtime: "Runtime",
  status: "Trạng thái",
  projects: "Dự án",
  profile: "Chrome profile",
  chat: "Đoạn chat",
  network: "Kết nối",
  tool: "MCP tool",
  transport: "MCP transport",
  settings: "Cài đặt",
  window: "Cửa sổ"
};

function DiagnosticDropdown({ value, options, onChange, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const selected = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    const close = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  return (
    <div className={`diagnostic-filter ${open ? "is-open" : ""}`} ref={root}>
      <button
        type="button"
        className="diagnostic-filter-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (["ArrowDown", "Enter", " "].includes(event.key) && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={`diagnostic-filter-dot is-${selected?.tone || "neutral"}`} aria-hidden="true" />
        <span className="diagnostic-filter-label">{selected?.label || "Chọn bộ lọc"}</span>
        {Number.isFinite(Number(selected?.count)) && <span className="diagnostic-filter-count">{Number(selected.count)}</span>}
        <svg className="diagnostic-filter-chevron" aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="diagnostic-filter-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`diagnostic-filter-option ${option.value === value ? "is-selected" : ""}`}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className={`diagnostic-filter-dot is-${option.tone || "neutral"}`} aria-hidden="true" />
              <span className="diagnostic-filter-option-copy">
                <strong>{option.label}</strong>
                {option.hint && <small>{option.hint}</small>}
              </span>
              {Number.isFinite(Number(option.count)) && <span className="diagnostic-filter-option-count">{Number(option.count)}</span>}
              {option.value === value && <span className="diagnostic-filter-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  const [visibleCount, setVisibleCount] = useState(DIAGNOSTIC_RENDER_BATCH);
  const visibleEntries = entries.slice(0, visibleCount);
  const summary = data?.summary || { total: 0, info: 0, warn: 0, error: 0 };

  useEffect(() => {
    setVisibleCount(DIAGNOSTIC_RENDER_BATCH);
  }, [data?.checked_at, filters.level, filters.source, filters.category, filters.hours, filters.query]);
  const available = data?.available || { levels: summary, sources: {}, categories: {} };
  const availableTotal = Object.values(available.levels || {}).reduce((total, count) => total + (Number(count) || 0), 0);
  const sourceOptions = ["all", ...new Set(["renderer", "mcp", ...(data?.sources || [])])];
  const categoryOptions = ["all", ...new Set(["runtime", "status", "projects", "profile", "chat", "network", "tool", "transport", ...(data?.categories || [])])];
  const levelOptions = [
    { value: "all", label: "Tất cả mức", hint: "Hiển thị toàn bộ mức độ", tone: "neutral", count: availableTotal },
    { value: "error", label: "Lỗi", hint: "Cần điều tra ngay", tone: "error", count: available.levels?.error || 0 },
    { value: "warn", label: "Cảnh báo", hint: "Có thể tự phục hồi", tone: "warn", count: available.levels?.warn || 0 },
    { value: "info", label: "Thông tin", hint: "Hoạt động bình thường", tone: "info", count: available.levels?.info || 0 }
  ];
  const sourceFilterOptions = sourceOptions.map((item) => ({
    value: item,
    label: item === "all" ? "Tất cả nguồn" : (SOURCE_LABELS[item] || item),
    hint: item === "all" ? "Manager, giao diện và MCP" : `Chỉ log từ ${SOURCE_LABELS[item] || item}`,
    tone: item === "mcp" ? "mcp" : item === "renderer" ? "renderer" : "neutral",
    count: item === "all" ? availableTotal : available.sources?.[item]
  }));
  const categoryFilterOptions = categoryOptions.map((item) => ({
    value: item,
    label: item === "all" ? "Tất cả nhóm" : (CATEGORY_LABELS[item] || item),
    hint: item === "all" ? "Mọi khu vực chức năng" : `Chỉ nhóm ${CATEGORY_LABELS[item] || item}`,
    tone: ["network", "transport"].includes(item) ? "warn" : item === "chat" ? "chat" : "neutral",
    count: item === "all" ? availableTotal : available.categories?.[item]
  }));
  const hourOptions = [
    { value: 1, label: "1 giờ gần nhất", hint: "Điều tra lỗi vừa xảy ra", tone: "time" },
    { value: 6, label: "6 giờ gần nhất", hint: "Theo dõi trong một phiên", tone: "time" },
    { value: 12, label: "12 giờ gần nhất", hint: "Nửa ngày gần nhất", tone: "time" },
    { value: 24, label: "24 giờ gần nhất", hint: "Toàn bộ thời gian lưu", tone: "time" }
  ];

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
          <div className="diagnostic-toolbar-actions">
            <button className="button secondary diagnostic-refresh" type="button" onClick={onRefresh} disabled={busy}>{busy ? "Đang tải…" : "Làm mới"}</button>
            {visibleCount < entries.length && (
              <button
                className="button secondary diagnostic-load-more"
                type="button"
                onClick={() => setVisibleCount((current) => Math.min(entries.length, current + DIAGNOSTIC_RENDER_BATCH))}
              >
                Hiển thị thêm {Math.min(DIAGNOSTIC_RENDER_BATCH, entries.length - visibleCount)} log
              </button>
            )}
            <button className="button danger-quiet" type="button" onClick={onClear} disabled={busy || !summary.total}>Xóa log</button>
          </div>
          <div className="diagnostic-filter-row">
            <DiagnosticDropdown value={filters.level} options={levelOptions} onChange={(level) => onFilters({ level })} ariaLabel="Lọc mức log" />
            <DiagnosticDropdown value={filters.source} options={sourceFilterOptions} onChange={(source) => onFilters({ source })} ariaLabel="Lọc nguồn log" />
            <DiagnosticDropdown value={filters.category} options={categoryFilterOptions} onChange={(category) => onFilters({ category })} ariaLabel="Lọc nhóm log" />
            <DiagnosticDropdown value={filters.hours} options={hourOptions} onChange={(hours) => onFilters({ hours: Number(hours) })} ariaLabel="Khoảng thời gian log" />
          </div>
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
          {visibleEntries.map((entry, index) => {
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
