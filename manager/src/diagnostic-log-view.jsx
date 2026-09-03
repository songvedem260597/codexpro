import React, { useEffect, useState } from "react";
import { AppDropdown } from "./app-dropdown.jsx";

const LEVEL_LABELS = { info: "INFO", warn: "CẢNH BÁO", error: "LỖI" };
const SOURCE_LABELS = { user: "Người dùng", manager: "Manager", renderer: "Giao diện", mcp: "MCP", worker: "Worker", electron: "Electron" };
const DIAGNOSTIC_RENDER_BATCH = 180;
const ERROR_TYPE_LABELS = {
  user: "Người dùng",
  network_api: "Mạng / API",
  ui_ux: "UI / UX",
  openai: "OpenAI",
  logic: "Logic",
  git: "Git",
  runtime: "Runtime",
  syntax: "Syntax"
};
const ERROR_TYPE_HINTS = {
  user: "Lỗi được người dùng báo hoặc phát hiện",
  network_api: "HTTP, API, timeout, DNS, socket, rate limit",
  ui_ux: "Renderer, CSS, layout, DOM, hiển thị",
  openai: "OpenAI, ChatGPT, model hoặc Responses API",
  logic: "State, invariant, routing hoặc xử lý nghiệp vụ",
  git: "Commit, push, branch, merge, rebase hoặc conflict",
  runtime: "Process, lifecycle và lỗi thực thi khác",
  syntax: "Parser, syntax error hoặc TypeScript syntax"
};

const CATEGORY_LABELS = {
  "user-reported-error": "Lỗi người dùng phát hiện",
  "task-unfinalized": "Task chưa chốt trạng thái",
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
  return (
    <AppDropdown
      className="is-diagnostic"
      compact
      value={value}
      options={options}
      onChange={onChange}
      ariaLabel={ariaLabel}
      searchPlaceholder={`Tìm ${ariaLabel.toLocaleLowerCase("vi-VN")}…`}
      renderValue={(selected) => <><span className={`app-dropdown-dot is-${selected?.tone || "neutral"}`} aria-hidden="true" /><strong>{selected?.label || "Chọn bộ lọc"}</strong></>}
      renderOption={(option) => <><span className={`app-dropdown-dot is-${option.tone || "neutral"}`} aria-hidden="true" /><span className="app-dropdown-option-copy"><strong>{option.label}</strong>{option.hint && <small>{option.hint}</small>}</span>{Number.isFinite(Number(option.count)) && <span className="app-dropdown-count">{Number(option.count)}</span>}</>}
    />
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
  const summary = data?.summary || { total: 0, info: 0, warn: 0, error: 0, user_reported_error: 0, user_reported_incidents: 0, unique_error_incidents: 0, repeated_error_incidents: 0 };

  useEffect(() => {
    setVisibleCount(DIAGNOSTIC_RENDER_BATCH);
  }, [data?.checked_at, filters.level, filters.source, filters.category, filters.errorType, filters.hours, filters.query]);
  const available = data?.available || { levels: summary, sources: {}, categories: {}, error_types: {} };
  const availableTotal = Object.values(available.levels || {}).reduce((total, count) => total + (Number(count) || 0), 0);
  const sourceOptions = ["all", ...new Set(["user", "renderer", "mcp", ...(data?.sources || [])])];
  const categoryOptions = ["all", ...new Set(["user-reported-error", "task-unfinalized", "runtime", "status", "projects", "profile", "chat", "network", "tool", "transport", ...(data?.categories || [])])];
  const levelOptions = [
    { value: "all", label: "Mọi mức", hint: "Hiển thị toàn bộ mức độ", tone: "neutral", count: availableTotal },
    { value: "error", label: "Lỗi", hint: "Cần điều tra ngay", tone: "error", count: available.levels?.error || 0 },
    { value: "warn", label: "Cảnh báo", hint: "Có thể tự phục hồi", tone: "warn", count: available.levels?.warn || 0 },
    { value: "info", label: "Thông tin", hint: "Hoạt động bình thường", tone: "info", count: available.levels?.info || 0 }
  ];
  const sourceFilterOptions = sourceOptions.map((item) => ({
    value: item,
    label: item === "all" ? "Mọi nguồn" : (SOURCE_LABELS[item] || item),
    hint: item === "all" ? "Người dùng, Manager, giao diện và MCP" : `Chỉ log từ ${SOURCE_LABELS[item] || item}`,
    tone: item === "user" ? "error" : item === "mcp" ? "mcp" : item === "renderer" ? "renderer" : "neutral",
    count: item === "all" ? availableTotal : available.sources?.[item]
  }));
  const categoryFilterOptions = categoryOptions.map((item) => ({
    value: item,
    label: item === "all" ? "Mọi nhóm" : (CATEGORY_LABELS[item] || item),
    hint: item === "all" ? "Mọi khu vực chức năng" : `Chỉ nhóm ${CATEGORY_LABELS[item] || item}`,
    tone: ["network", "transport"].includes(item) ? "warn" : item === "chat" ? "chat" : "neutral",
    count: item === "all" ? availableTotal : available.categories?.[item]
  }));
  const errorTypeOptions = [
    { value: "all", label: "Tất cả loại lỗi", hint: "Người dùng, API, UI/UX, OpenAI, logic, Git, runtime, syntax", tone: "neutral", count: Object.values(available.error_types || {}).reduce((total, count) => total + (Number(count) || 0), 0) },
    ...Object.entries(ERROR_TYPE_LABELS).map(([value, label]) => ({
      value,
      label,
      hint: ERROR_TYPE_HINTS[value],
      tone: value === "user" || value === "syntax" ? "error" : value === "network_api" || value === "git" ? "warn" : value === "ui_ux" ? "renderer" : value === "openai" ? "mcp" : "neutral",
      count: available.error_types?.[value] || 0
    }))
  ];
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
        <article className="is-user-error"><span>Lỗi người dùng phát hiện</span><strong>{summary.user_reported_error || 0}</strong><small>{summary.user_reported_incidents || 0} lỗi riêng biệt</small></article>
        <article className="is-incident"><span>Sự cố riêng biệt</span><strong>{summary.unique_error_incidents || 0}</strong><small>theo fingerprint lỗi</small></article>
        <article className="is-repeat"><span>Sự cố bị lặp</span><strong>{summary.repeated_error_incidents || 0}</strong><small>xuất hiện từ 2 lần</small></article>
        <article className="is-warn"><span>Cảnh báo</span><strong>{summary.warn || 0}</strong><small>có thể tự phục hồi</small></article>
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
            <DiagnosticDropdown value={filters.errorType || "all"} options={errorTypeOptions} onChange={(errorType) => onFilters({ errorType })} ariaLabel="Lọc loại lỗi" />
            <DiagnosticDropdown value={filters.hours} options={hourOptions} onChange={(hours) => onFilters({ hours: Number(hours) })} ariaLabel="Khoảng thời gian log" />
          </div>
        </div>

        <div className="diagnostic-retention-note">
          <span>Chỉ lưu tối đa 24 giờ</span>
          <small>{data?.checked_at ? `Cập nhật ${diagnosticTime(data.checked_at)}` : "Chưa tải log"}</small>
        </div>

        <div className="diagnostic-table" role="table" aria-label="Nhật ký chẩn đoán CodexPro">
          <div className="diagnostic-row diagnostic-head" role="row">
            <span>Thời gian</span><span>Mức</span><span>Nguồn / nhóm</span><span>Loại lỗi</span><span>Action</span><span>Nội dung</span><span>Lặp lại</span><span>Thời lượng</span>
          </div>
          {!entries.length && <div className="diagnostic-empty">Không có log phù hợp trong khoảng thời gian đã chọn.</div>}
          {visibleEntries.map((entry, index) => {
            const key = `${entry.timestamp || "log"}:${entry.source || ""}:${entry.action || ""}:${index}`;
            const active = selected === entry;
            return (
              <button className={`diagnostic-row diagnostic-entry is-${entry.level || "info"} ${active ? "is-selected" : ""}`} type="button" role="row" key={key} onClick={() => onSelect(active ? null : entry)}>
                <span className="diagnostic-time">{diagnosticTime(entry.timestamp)}</span>
                <span><b className={`diagnostic-level is-${entry.level || "info"}`}>{LEVEL_LABELS[entry.level] || "INFO"}</b></span>
                <span className="diagnostic-source"><strong>{SOURCE_LABELS[entry.source] || entry.source || "Manager"}</strong><small>{CATEGORY_LABELS[entry.category] || entry.category || "Runtime"}</small></span>
                <span className="diagnostic-error-type">{entry.details?.error_type ? <b className={`is-${entry.details.error_type}`}>{ERROR_TYPE_LABELS[entry.details.error_type] || entry.details.error_type}</b> : "—"}</span>
                <span className="diagnostic-action">{entry.action || "—"}</span>
                <span className="diagnostic-message">{entry.message || "—"}</span>
                <span className="diagnostic-occurrence">{entry.details?.error_fingerprint || entry.details?.incident_fingerprint ? `${Number(entry.details?.occurrence_count) || 1} lần` : "—"}</span>
                <span className="diagnostic-duration">{Number.isFinite(Number(entry.duration_ms)) ? `${Number(entry.duration_ms)} ms` : "—"}</span>
              </button>
            );
          })}
        </div>
        {selected && (
          <div className="diagnostic-detail">
            <div className="diagnostic-detail-head">
              <div><b>{LEVEL_LABELS[selected.level] || "INFO"} · {SOURCE_LABELS[selected.source] || selected.source || "Manager"}</b><span>{diagnosticTime(selected.timestamp)} · {CATEGORY_LABELS[selected.category] || selected.category || "Runtime"}{selected.details?.error_type ? ` · ${ERROR_TYPE_LABELS[selected.details.error_type] || selected.details.error_type}` : ""}</span></div>
              <button className="button secondary" type="button" onClick={() => onCopy(selected)}>Copy chi tiết</button>
            </div>
            <strong>{selected.message || "Không có message"}</strong>
            <pre>{JSON.stringify({ action: selected.action || "", occurrence_count: selected.details?.occurrence_count ?? null, duration_ms: selected.duration_ms ?? null, details: selected.details || {} }, null, 2)}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
