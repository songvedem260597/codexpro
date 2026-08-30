import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import managerPackage from "../package.json";
import "./styles.css";
import "@fontsource/be-vietnam-pro/400.css";
import "@fontsource/be-vietnam-pro/500.css";
import "@fontsource/be-vietnam-pro/600.css";
import "@fontsource/be-vietnam-pro/700.css";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import workerHung from "./assets/worker-hung.gif";
import workerIdle from "./assets/worker-idle.gif";
import workerWorking from "./assets/worker-working.gif";
import { canAcceptNextChatMessage, canVerifyRepoTaskUse, isRecoverableAbortedChatNetworkFailure, isRetryableChatTurnBusyError, isTerminalChatNetworkState, shouldShowChatBusy, shouldShowChatSettling } from "./chat-status.js";
import { handleResponseWheel, installResponseAutoPin, recordResponseScroll } from "./chat-scroll.js";
import { cacheableTranscriptMessages, completedResponseNeedsDomFallback, discardProvisionalAssistantAfterLatestUser, isNetworkStreamCurrentGeneration, materializeTranscriptMessages, mergeNetworkStreamTranscript, mergeProgressiveResponseText, replaceCanonicalTranscript, transcriptAwaitingAssistant, trimRecentTranscriptMessages } from "./chat-transcript.js";
import { projectSelectionChanged } from "./chat-project.js";
import { buildChatResponseAuditRecord, responseAuditTextFingerprint } from "./chat-response-audit.js";
import { profileCardBorderState, profileChromeActionState, profileChromeTarget } from "./profile-card-state.js";
import { mergeBrowserProfilePayload, sameProjectList } from "./ui-performance.js";
import { CodeGraphView } from "./code-graph-view.jsx";
import { DiagnosticLogView, logRendererDiagnostic } from "./diagnostic-log-view.jsx";

const ResponseText = React.lazy(() => import("./response-markdown.jsx").then((module) => ({ default: module.ResponseText })));
const api = window.codexpro;
const PROFILE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_CHECK_RETRY_MS = 30 * 60 * 1000;
const RESPONSE_BOTTOM_THRESHOLD_PX = 18;
const REALTIME_WATCHDOG_MS = 30000;
const PROJECT_REFRESH_MS = 5 * 60 * 1000;
const NEW_CHAT_TARGET = "__codexpro_new_chat__";
const ALL_ALLOWED_WORKSPACES = "__codexpro_all_allowed__";
const ROLLOVER_CONTEXT_MAX_CHARS = 9000;
const REPO_TASK_VERIFICATION_RETRY_MS = 1500;
const LATEST_RESPONSE_RECOVERY_POLL_MS = 3000;
const PROJECTS_PER_PAGE = 8;
const PROFILE_TASK_LABELS_STORAGE_KEY = "codexpro.profileTaskLabels.v2";
const DEEP_UI_DIAGNOSTICS_ENABLED = new URLSearchParams(window.location.search).get("debugUi") === "1";

function loadProfileTaskLabels() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROFILE_TASK_LABELS_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function Dot({ ok }) {
  return <span className={`dot ${ok ? "ok" : "bad"}`} aria-hidden="true" />;
}

function StatusCard({ label, ok, value, detail }) {
  return (
    <article className={`status-card ${ok ? "is-ok" : "is-bad"}`}>
      <div className="status-label"><Dot ok={ok} />{label}</div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function Icon({ children }) {
  return <span className="icon" aria-hidden="true">{children}</span>;
}

const workerIcons = {
  hung: { src: workerHung, label: "CodexPro mất kết nối extension" },
  idle: { src: workerIdle, label: "CodexPro đang rảnh" },
  working: { src: workerWorking, label: "CodexPro đang làm việc" }
};

const FONT_OPTIONS = [
  { value: "system", label: "System / mặc định", css: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif' },
  { value: "be-vietnam-pro", label: "Be Vietnam Pro", hint: "Text dài · tiếng Việt rõ và dễ đọc", css: '"Be Vietnam Pro", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif' },
  { value: "manrope", label: "Manrope", hint: "Tiêu đề · giao diện hiện đại, gọn", css: 'Manrope, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif' },
  { value: "jetbrains-mono", label: "JetBrains Mono", hint: "Code · ID · log kỹ thuật", css: '"JetBrains Mono", "SFMono-Regular", "Cascadia Code", Consolas, monospace' },
  { value: "arial", label: "Arial", css: 'Arial, sans-serif' },
  { value: "tahoma", label: "Tahoma", css: 'Tahoma, sans-serif' },
  { value: "verdana", label: "Verdana", css: 'Verdana, sans-serif' },
  { value: "trebuchet", label: "Trebuchet MS", css: '"Trebuchet MS", sans-serif' },
  { value: "georgia", label: "Georgia", css: 'Georgia, serif' },
  { value: "cascadia", label: "Cascadia Code", css: '"Cascadia Code", Consolas, monospace' }
];

const FONT_ROLE_OPTIONS = [
  { value: "inherit", label: "Theo font nội dung", hint: "Dùng cùng font với nội dung & control" },
  ...FONT_OPTIONS
];

const GLOBAL_RULES_TEMPLATE = `# CodexPro Global Rules

<!-- Rule trong file này áp dụng cho mọi repo/dự án được thao tác qua MCP CodexPro. -->
<!-- Thêm hoặc sửa rule bên dưới. Không lưu password, token hoặc API key trong file này. -->

- Đọc và tuân thủ file này trước khi đọc rule riêng của từng repo/dự án.
- Rule riêng của repo có thể bổ sung chi tiết nhưng không được âm thầm bỏ qua rule toàn cục này.
`;

const DEFAULT_MANAGER_SETTINGS = {
  chatWidth: 940,
  chatHeight: 330,
  fontFamily: "system",
  headingFontFamily: "inherit",
  monoFontFamily: "inherit",
  fontSize: 14,
  profileLayout: "rows",
  maxSubagents: 1,
  globalRules: GLOBAL_RULES_TEMPLATE,
  repoSelections: {},
  selectedWorkerPackId: "default",
  workerImagePacks: [],
  workerImages: { idle: "", working: "", hung: "" },
  workerImageDataUrls: { idle: "", working: "", hung: "" }
};

function WorkerIcon({ state, customImages }) {
  const worker = workerIcons[state] || workerIcons.hung;
  const customSrc = customImages?.[state] || "";
  return (
    <div className={`profile-worker is-${state}`} title={worker.label}>
      <img src={customSrc || worker.src} alt={worker.label} />
      <span className="profile-worker-dot" aria-hidden="true" />
    </div>
  );
}

function ProfileSummaryIcon({ state, missing }) {
  if (missing) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 3v5M12 3v5M6 8h8v2a4 4 0 0 1-4 4v3" />
        <path d="M16 16h6M19 13v6" />
      </svg>
    );
  }
  if (state === "working") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m13.5 2-8 12h6l-1 8 8-12h-6l1-8Z" />
      </svg>
    );
  }
  if (state === "idle") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 2.6 2.6L16.5 9" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 2.8 20h18.4L12 3Z" />
      <path d="M12 9v5M12 17.2v.1" />
    </svg>
  );
}

function ProfileSummaryItem({ state, count, label, missing = false }) {
  return (
    <span className={`profile-summary-item is-${state}${missing ? " is-missing" : ""}`}>
      <span className="profile-summary-icon">
        <ProfileSummaryIcon state={state} missing={missing} />
      </span>
      <strong>{count}</strong>
      <span>{label}</span>
    </span>
  );
}

function WorkingBadge() {
  return (
    <span className="badge profile-working">
      <span className="working-motion-icon" aria-hidden="true">
        <svg className="working-terminal-icon" viewBox="0 0 22 16">
          <rect x="1" y="1" width="17" height="13" rx="3" />
          <path d="m4.5 5 2.5 2-2.5 2" />
          <path className="working-terminal-caret" d="M9 9h4" />
        </svg>
        <svg className="working-cog-icon" viewBox="0 0 16 16">
          <path d="M6.8 1.4h2.4l.5 1.5 1.3.6 1.5-.6 1.2 2.1-1.1 1.1.1 1.5 1.3.9-1.2 2.1-1.6-.3-1.2.8-.3 1.6H7.3L7 11.1l-1.2-.8-1.6.3L3 8.5l1.3-.9.1-1.5L3.3 5l1.2-2.1 1.5.6 1.3-.6.5-1.5Z" />
          <circle cx="8" cy="7.7" r="2" />
        </svg>
      </span>
      <span>ĐANG LÀM VIỆC</span>
    </span>
  );
}

function SettingsDropdown({ value, options, disabled, onChange, ariaLabel = "Chọn font chữ", selectedHint = "" }) {
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
    <div className={`settings-dropdown ${open ? "is-open" : ""} ${disabled ? "is-disabled" : ""}`} ref={root}>
      <button
        type="button"
        className="settings-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (["ArrowDown", "Enter", " "].includes(event.key) && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="settings-dropdown-value">
          <strong>{selected?.label || "Chọn giá trị"}</strong>
          <small>{selectedHint || selected?.hint || (selected?.value === "system" ? "Theo giao diện hệ thống" : "Áp dụng cho toàn bộ CodexPro")}</small>
        </span>
        <svg className="settings-dropdown-chevron" aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="settings-dropdown-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`settings-dropdown-option ${option.value === value ? "is-selected" : ""}`}
              key={option.value}
              onClick={() => { onChange(option.value); setOpen(false); }}
              style={option.css ? { fontFamily: option.css } : undefined}
            >
              <span className="settings-dropdown-option-copy"><strong>{option.label}</strong>{option.hint && <small>{option.hint}</small>}</span>
              {option.value === value && <span className="settings-dropdown-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ChatDropdown({ value, conversations, disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const selected = value === NEW_CHAT_TARGET ? { id: NEW_CHAT_TARGET, title: "Chat mới", open: false, draft: true } : conversations.find((chat) => chat.id === value);

  useEffect(() => {
    const close = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  return (
    <div className={`chat-dropdown ${open ? "is-open" : ""} ${disabled ? "is-disabled" : ""}`} ref={root}>
      <button
        type="button"
        className="chat-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (["ArrowDown", "Enter", " "].includes(event.key) && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="chat-dropdown-value">
          <strong>{selected?.title || "Chưa tải được các đoạn chat gần đây"}</strong>
          {selected && <small>{selected.draft ? "Chưa tạo trên ChatGPT" : selected.open ? "Đang mở trong Chrome" : "Chat gần đây"}</small>}
        </span>
        <svg className="chat-dropdown-chevron" aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="chat-dropdown-menu" role="listbox" aria-label="Chọn đoạn chat dự án">
          {conversations.map((chat, index) => (
            <button
              type="button"
              role="option"
              aria-selected={chat.id === value}
              data-conversation-id={chat.id}
              className={`chat-dropdown-option ${chat.id === value ? "is-selected" : ""}`}
              key={chat.id}
              onClick={() => { onChange(chat.id); setOpen(false); }}
            >
              <span className="chat-option-index">{index + 1}</span>
              <span className="chat-option-copy"><strong>{chat.title || "Đoạn chat chưa có tiêu đề"}</strong><small>{chat.open ? "Đang mở" : "Gần đây"}</small></span>
              {chat.active && <span className="chat-option-active">ACTIVE</span>}
              {chat.id === value && <span className="chat-option-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectDropdown({ value, projects, disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef(null);
  const selected = projects.find((project) => project.root === value);
  const allAllowed = value === ALL_ALLOWED_WORKSPACES;
  const normalizedQuery = query.trim().toLocaleLowerCase("vi-VN");
  const filteredProjects = normalizedQuery
    ? projects.filter((project) => [project.name, project.repoFullName, project.branch, project.root].some((field) => String(field || "").toLocaleLowerCase("vi-VN").includes(normalizedQuery)))
    : projects;

  useEffect(() => {
    const close = (event) => {
      if (!root.current?.contains(event.target)) { setOpen(false); setQuery(""); }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  return (
    <div className={`project-dropdown ${open ? "is-open" : ""} ${disabled ? "is-disabled" : ""}`} ref={root}>
      <button type="button" className="project-dropdown-trigger" aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => { setOpen((current) => !current); if (open) setQuery(""); }}>
        <span className="project-dropdown-mark">{allAllowed ? "⌕" : "⌘"}</span>
        <span className="project-dropdown-value">
          <strong>{allAllowed ? "Tất cả vùng được cấp quyền" : selected?.name || "Chọn dự án hoặc đường dẫn"}</strong>
          <small>{allAllowed ? "Không khóa repo/đường dẫn · CodexPro có thể tìm trong toàn bộ vùng đã cấp quyền" : selected ? `${selected.repoFullName ? `${selected.repoFullName} · ` : ""}${selected.isGit ? (selected.branch || "git") : "thư mục"} · ${selected.root}` : "Chọn một workspace cụ thể hoặc tìm trên toàn bộ vùng được cấp quyền"}</small>
        </span>
        <svg className="project-dropdown-chevron" aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="project-dropdown-menu" role="listbox" aria-label="Chọn dự án hoặc đường dẫn cần làm">
          <div className="project-dropdown-search">
            <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
            <input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm dự án, thư mục hoặc đường dẫn…" aria-label="Tìm dự án hoặc đường dẫn" />
            {query && <button type="button" aria-label="Xóa từ khóa" onClick={() => setQuery("")}>×</button>}
          </div>
          <button type="button" role="option" aria-selected={allAllowed} className={`project-dropdown-option project-dropdown-option-all ${allAllowed ? "is-selected" : ""}`} onClick={() => { onChange(ALL_ALLOWED_WORKSPACES); setOpen(false); setQuery(""); }}>
            <span className="project-dropdown-mark">⌕</span>
            <span className="project-dropdown-copy"><strong>Tất cả đường dẫn</strong><small>Không chọn repo/đường dẫn cụ thể · cho phép tìm trên mọi workspace được phép truy cập</small></span>
            {allAllowed && <span className="project-dropdown-check">✓</span>}
          </button>
          {filteredProjects.map((project) => (
            <button type="button" role="option" aria-selected={project.root === value} className={`project-dropdown-option ${project.root === value ? "is-selected" : ""}`} key={project.root} onClick={() => { onChange(project.root); setOpen(false); }}>
              <span className="project-dropdown-mark">⌘</span>
              <span className="project-dropdown-copy"><strong>{project.name}</strong><small>{project.repoFullName ? `${project.repoFullName} · ` : ""}{project.isGit ? (project.branch || "git") : "thư mục"} · {project.root}</small></span>
              {formatRepoActivity(project) && <span className="project-dropdown-activity">{formatRepoActivity(project)}</span>}
              {project.changes > 0 && <span className="project-dropdown-changes">{project.changes} đổi</span>}
              {project.root === value && <span className="project-dropdown-check">✓</span>}
            </button>
          ))}
          {!filteredProjects.length && <div className="project-dropdown-empty">Không tìm thấy trong danh sách đã lưu.</div>}
        </div>
      )}
    </div>
  );
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRepoActivity(project) {
  const timestamp = Date.parse(project?.activityAt || "");
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60000);
  const label = project.activityKind === "push" ? "push" : project.activityKind === "remote" ? "remote" : "commit";
  if (minutes < 1) return `${label} vừa xong`;
  if (minutes < 60) return `${label} ${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${label} ${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${label} ${days} ngày trước`;
  return `${label} ${new Date(timestamp).toLocaleDateString("vi-VN")}`;
}

function toolActivityFromText(text) {
  const source = String(text || "").trim();
  if (!source.includes("/CodexPro/") || !source.includes("args")) return null;
  const normalized = source.replace(/\\"/g, '"');
  let toolPath = "";
  let args = {};
  try {
    const payload = JSON.parse(normalized);
    toolPath = String(payload?.path || "");
    args = payload?.args && typeof payload.args === "object" ? payload.args : {};
  } catch {
    toolPath = normalized.match(/"path"\s*:\s*"(\/CodexPro\/[^"\s]+)"/)?.[1] || "";
    args = {
      path: normalized.match(/"args"\s*:\s*\{[\s\S]*?"path"\s*:\s*"([^"]+)"/)?.[1] || "",
      cwd: normalized.match(/"args"\s*:\s*\{[\s\S]*?"cwd"\s*:\s*"([^"]+)"/)?.[1] || "",
      root: normalized.match(/"args"\s*:\s*\{[\s\S]*?"root"\s*:\s*"([^"]+)"/)?.[1] || ""
    };
  }
  if (!toolPath.includes("/CodexPro/")) return null;
  const action = toolPath.split("/").filter(Boolean).pop() || "tool";
  const target = String(args.path || args.cwd || args.root || "").trim();
  const shortTarget = target ? target.replace(/\\+/g, "/").split("/").slice(-3).join("/") : "";
  const labels = {
    begin_repo_task: "Đang ghi nhận task",
    open_workspace: "Đang mở repo",
    open_current_workspace: "Đang mở workspace",
    search: shortTarget ? `Đang tìm trong ${shortTarget}` : "Đang tìm trong repo",
    read: shortTarget ? `Đang đọc ${shortTarget}` : "Đang đọc file",
    edit: shortTarget ? `Đang sửa ${shortTarget}` : "Đang sửa code",
    write: shortTarget ? `Đang ghi ${shortTarget}` : "Đang ghi file",
    apply_patch: "Đang áp dụng thay đổi",
    show_changes: "Đang kiểm tra thay đổi",
    bash: "Đang chạy kiểm tra",
    view_image: shortTarget ? `Đang kiểm tra ${shortTarget}` : "Đang kiểm tra ảnh",
    inspect_workspace: "Đang phân tích repo"
  };
  return labels[action] || `Đang chạy ${action}`;
}

function compactToolActivityMessages(messages) {
  const output = [];
  let pendingActivity = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    const activity = message?.role === "assistant" ? toolActivityFromText(message.text) : null;
    if (activity) {
      pendingActivity = { ...message, id: "codexpro-live-tool-activity", text: activity, toolActivity: true };
      continue;
    }
    pendingActivity = null;
    output.push(message);
  }
  if (pendingActivity) output.push(pendingActivity);
  return output;
}

const WORKER_EXTENSION_VERSION = "0.5.79";
const PROFILE_REPO_CACHE_KEY = "codexpro-profile-repo-roots-v1";

function dateMs(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function latestProfileNetworkAt(profile) {
  return Math.max(0, ...(profile?.conversation_tabs || []).flatMap((tab) => [
    dateMs(tab.network_last_started_at),
    dateMs(tab.network_last_completed_at)
  ]));
}

function strongProfileRepoMatch(profile, projects) {
  const workerId = String(profile?.worker_id || "").trim();
  if (workerId) {
    const exact = projects
      .filter((project) => (project.workers || []).includes(workerId))
      .sort((left, right) => dateMs(right.lastSeenAt) - dateMs(left.lastSeenAt))[0];
    if (exact) return exact;
  }

  const busySince = profile?.activity === "working" ? dateMs(profile.busy_since) : 0;
  if (busySince) {
    const now = Date.now();
    const activeDuringWork = projects
      .filter((project) => project.active)
      .map((project) => ({ project, seenAt: dateMs(project.lastSeenAt) }))
      .filter((candidate) => candidate.seenAt >= busySince - 10000 && candidate.seenAt <= now + 5000)
      .sort((left, right) => right.seenAt - left.seenAt);
    if (activeDuringWork.length === 1) return activeDuringWork[0].project;
    if (activeDuringWork.length > 1 && activeDuringWork[0].seenAt - activeDuringWork[1].seenAt > 15000) return activeDuringWork[0].project;
  }

  const activityAt = latestProfileNetworkAt(profile);
  if (!activityAt) return null;
  const candidates = projects
    .filter((project) => project.active && dateMs(project.lastSeenAt))
    .map((project) => ({ project, distance: Math.abs(dateMs(project.lastSeenAt) - activityAt) }))
    .filter((candidate) => candidate.distance <= 120000)
    .sort((left, right) => left.distance - right.distance);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[1].distance - candidates[0].distance < 15000) return null;
  return candidates[0].project;
}

function profileRepoProject(profile, projects, cachedRoot) {
  return strongProfileRepoMatch(profile, projects)
    || projects.find((project) => cachedRoot && project.root === cachedRoot)
    || null;
}

function sendDebugEvidence(result = {}, error = null) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  const source = result && typeof result === "object" ? result : {};
  const evidence = Array.isArray(source.network_evidence)
    ? source.network_evidence.slice(-12)
    : Array.isArray(details.network_evidence)
      ? details.network_evidence.slice(-12)
      : [];
  return {
    recordedAt: new Date().toISOString(),
    attemptId: String(source.attempt_id || details.attempt_id || details.command_id || ""),
    state: String(source.submission_state || (error ? "failed" : "")),
    path: String(source.submitted_by || source.submit_path || details.submitted_by || details.stage || ""),
    pathAttempted: Array.isArray(source.path_attempted) ? source.path_attempted : [],
    networkAck: source.network_acknowledged === true,
    endpoint: String(source.network_generation_endpoint || details.network_generation_endpoint || ""),
    statusCode: Number(source.network_status_code || details.network_status_code) || 0,
    message: String(source.error || error?.message || details.message || ""),
    code: String(error?.code || details.code || ""),
    trustedEnterError: String(source.trusted_enter_error || details.trusted_enter_error || ""),
    trustedClickError: String(source.trusted_click_error || details.trusted_click_error || ""),
    fallbackReason: String(source.fallback_reason || details.fallback_reason || ""),
    evidence
  };
}

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

function extensionReady(version) {
  const parts = String(version || "").split(".").map(Number);
  const target = WORKER_EXTENSION_VERSION.split(".").map(Number);
  for (let index = 0; index < target.length; index += 1) {
    const current = Number.isFinite(parts[index]) ? parts[index] : 0;
    if (current !== target[index]) return current > target[index];
  }
  return true;
}

function repoTaskEvidenceSummary(proof) {
  if (!proof) return "";
  const title = String(proof.task_title || "").trim() || "Task chưa có tên";
  if (proof.task_kind !== "code") return `${title} · GENERAL · không tải Rules/CodexGraph`;
  const rulesHash = String(proof.global_rules_sha256 || "").slice(0, 8);
  const coverage = proof.codexgraph?.coverage || {};
  const symbols = Number(coverage.symbolCount) || 0;
  const relationships = Number(coverage.relationshipCount) || 0;
  return `${title} · CODE · Rules ${rulesHash || "thiếu hash"} ✓ · CodexGraph ${symbols} symbols / ${relationships} edges ✓`;
}

function profileSafeForWorkerUpdate(profile) {
  const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
  const hasBusyTab = tabs.some((tab) => tab?.busy || tab?.settling || String(tab?.network_state || "") === "generating");
  return profile?.activity === "idle" && Number(profile?.busy_request_count || 0) === 0 && !hasBusyTab;
}

function profileRequestChats(profile) {
  const recent = Array.isArray(profile?.recent_conversations) ? profile.recent_conversations : [];
  if (recent.length) return recent.slice(0, 3);
  return (profile?.conversation_tabs || []).map((tab) => {
    const match = String(tab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/);
    return match ? { id: match[1], title: tab.title, url: tab.url, open: true, active: tab.active } : null;
  }).filter(Boolean).slice(0, 3);
}

function applyConversationTitleOverrides(status, overrides) {
  if (!status || !overrides || !Object.keys(overrides).length) return status;
  return {
    ...status,
    browserProfiles: (status.browserProfiles || []).map((profile) => {
      const recentConversations = (profile.recent_conversations || []).map((chat) => {
        const title = overrides[`${profile.profile_id}:${chat.id}`];
        return title ? { ...chat, title } : chat;
      });
      const conversationTabs = (profile.conversation_tabs || []).map((tab) => {
        const conversationId = String(tab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
        const title = overrides[`${profile.profile_id}:${conversationId}`];
        return title ? { ...tab, title } : tab;
      });
      const activeTab = conversationTabs.find((tab) => tab.active) || conversationTabs[0];
      return {
        ...profile,
        recent_conversations: recentConversations,
        conversation_tabs: conversationTabs,
        active_chat_title: activeTab?.title || profile.active_chat_title
      };
    })
  };
}

function visibleUserMessageText(value) {
  const text = String(value || "").trim();
  const marker = "Yêu cầu của người dùng:";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) return text.slice(markerIndex + marker.length).trim();
  if (text.includes("Yêu cầu của người dùng nằm trong file đính kèm.")) return "Yêu cầu nằm trong file đính kèm.";
  return text;
}

function buildConversationRolloverPrompt(result) {
  const prefix = [
    "Đoạn chat trước vừa đạt giới hạn độ dài nên CodexPro đã tự tạo cuộc chat mới này.",
    "Hãy tiếp tục đúng dự án/công việc đang làm từ bối cảnh gần nhất bên dưới. Không bắt đầu lại từ đầu và không yêu cầu người dùng lặp lại thông tin đã có nếu có thể suy ra từ bối cảnh.",
    result?.projectRoot ? `Repo tiếp tục (đã khóa trong CodexPro): ${String(result.projectRoot).trim()}` : "",
    result?.title ? `Tên chat trước: ${String(result.title).trim()}` : "",
    "",
    "Bối cảnh gần nhất từ chat trước:"
  ].filter((line) => line !== "").join("\n");
  const messages = Array.isArray(result?.messages) ? result.messages.filter((message) => String(message?.text || "").trim()) : [];
  const chunks = [];
  let remaining = ROLLOVER_CONTEXT_MAX_CHARS;
  for (let index = messages.length - 1; index >= 0 && remaining > 200; index -= 1) {
    const message = messages[index];
    const role = message?.role === "user" ? "Bạn" : "ChatGPT";
    const messageText = message?.role === "user" ? visibleUserMessageText(message.text) : String(message.text || "").trim();
    const fullChunk = `${role}:\n${messageText}`;
    if (fullChunk.length <= remaining) {
      chunks.unshift(fullChunk);
      remaining -= fullChunk.length + 2;
      continue;
    }
    const tailLength = Math.max(0, remaining - role.length - 6);
    if (tailLength > 180) chunks.unshift(`${role}:\n…${fullChunk.slice(-tailLength)}`);
    break;
  }
  const context = chunks.length ? chunks.join("\n\n") : "(Không đọc được transcript gần nhất; hãy tiếp tục dựa trên yêu cầu tiếp theo của người dùng.)";
  return `${prefix}\n\n${context}\n\nTiếp tục từ đúng việc còn dang dở. Nếu cần chờ người dùng đưa yêu cầu tiếp theo thì chỉ báo ngắn gọn rằng chat mới đã sẵn sàng để tiếp tục dự án.`.slice(0, 11800);
}

function ChatRequestComposer({
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
  onClose,
  onOpenChrome,
  onSend
}) {
  const [draft, setDraft] = useState(() => String(initialDraft || ""));
  const sendingRef = useRef(false);

  const updateDraft = useCallback((nextDraft) => {
    const normalized = String(nextDraft || "");
    setDraft(normalized);
    onDraftSnapshot(normalized);
  }, [onDraftSnapshot]);

  useEffect(() => {
    updateDraft(initialDraft);
  }, [profileId, draftResetVersion]);

  const canSend = canSendBase && Boolean(draft.trim() || attachments.length);

  const submit = useCallback(async () => {
    if (!canSend || sendingRef.current) return;
    sendingRef.current = true;
    try {
      const submitted = await onSend(draft);
      if (submitted) updateDraft("");
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
          maxLength={12000}
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
          <button type="button" className="attach-button" onClick={onChooseAttachments} disabled={attachmentDisabled || attachments.length >= 4}><span>＋</span> Thêm file</button>
          <span>{attachments.length ? `${attachments.length}/4 file · ${formatFileSize(attachments.reduce((total, file) => total + file.size, 0))}` : `${draft.length.toLocaleString("vi-VN")}/12.000 · TXT, PDF, mã nguồn, Office, ảnh…`}</span>
        </div>
      </div>
      {sendError && <div className="request-send-error">{sendError}</div>}
      <SendDebugEvidence evidence={sendEvidence} />
      <div className="request-card-foot">
        {selectedBusy && <span>Đang nhận phản hồi</span>}
        <div className="request-card-actions">
          <button type="button" className="button secondary" onClick={onClose}>Đóng</button>
          <button type="button" className="button secondary" onClick={onOpenChrome} disabled={!canOpenChrome}>Mở Chrome</button>
          <button type="button" className="button primary" onClick={() => void submit()} disabled={!canSend}>{sending ? (isNewChat ? "Đang tạo chat…" : attachments.length ? "Đang tải file + gửi…" : "Đang gửi…") : rolloverCreating ? "Đang chuyển chat…" : selectedBusy ? "Chat này đang trả lời" : selectedSettling ? "Chat đang hoàn tất" : isNewChat ? "Tạo chat + gửi" : "Gửi tin nhắn"}</button>
        </div>
      </div>
    </>
  );
}

function App() {
  const [activePage, setActivePage] = useState("overview");
  const [diagnosticLogs, setDiagnosticLogs] = useState({ summary: { total: 0, info: 0, warn: 0, error: 0 }, entries: [], sources: [], categories: [], queried_hours: 24, checked_at: "" });
  const [diagnosticFilters, setDiagnosticFilters] = useState({ level: "all", source: "all", category: "all", hours: 24, query: "" });
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [selectedDiagnostic, setSelectedDiagnostic] = useState(null);
  const [managerSettings, setManagerSettings] = useState(DEFAULT_MANAGER_SETTINGS);
  const [chatWidthInput, setChatWidthInput] = useState(String(DEFAULT_MANAGER_SETTINGS.chatWidth));
  const [chatHeightInput, setChatHeightInput] = useState(String(DEFAULT_MANAGER_SETTINGS.chatHeight));
  const [globalRulesDraft, setGlobalRulesDraft] = useState(DEFAULT_MANAGER_SETTINGS.globalRules);
  const [settingsBusy, setSettingsBusy] = useState("");
  const [headlessState, setHeadlessState] = useState({ supported: false, chromePath: "", chromeUserDataRoot: "", sourceProfiles: [], workers: [] });
  const [headlessBusy, setHeadlessBusy] = useState("");
  const [headlessSourceProfile, setHeadlessSourceProfile] = useState("");
  const [workerPackDraft, setWorkerPackDraft] = useState("");
  const [showWorkerPackCreator, setShowWorkerPackCreator] = useState(false);
  const [workerPackDeleteArmed, setWorkerPackDeleteArmed] = useState("");
  const [chatProfileId, setChatProfileId] = useState("");
  const [status, setStatus] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectPage, setProjectPage] = useState(0);
  const [profileRepoRoots, setProfileRepoRoots] = useState(() => {
    try {
      const value = JSON.parse(window.localStorage.getItem(PROFILE_REPO_CACHE_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  });
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [workerUpdateConfirmOpen, setWorkerUpdateConfirmOpen] = useState(false);
  const [inspection, setInspection] = useState(null);
  const [checkingProfiles, setCheckingProfiles] = useState([]);
  const requestDraftsRef = useRef({});
  const [requestDraftResetVersions, setRequestDraftResetVersions] = useState({});
  const [requestTargets, setRequestTargets] = useState({});
  const [requestProjectRoots, setRequestProjectRoots] = useState({});
  const [requestFiles, setRequestFiles] = useState({});
  const [attachmentPreview, setAttachmentPreview] = useState(null);
  const [requestResponses, setRequestResponses] = useState({});
  const [profileTaskLabels, setProfileTaskLabels] = useState(() => loadProfileTaskLabels());
  const [responseSelection, setResponseSelection] = useState({ key: "", text: "" });
  const [clearedResponseTargets, setClearedResponseTargets] = useState({});
  const [requestSendErrors, setRequestSendErrors] = useState({});
  const [requestSendEvidence, setRequestSendEvidence] = useState({});
  const [renameChat, setRenameChat] = useState(null);
  const conversationTitleOverridesRef = useRef({});
  const refreshInFlight = useRef(false);
  const projectRefreshInFlight = useRef(false);
  const statusRefreshInFlight = useRef(false);
  const profileCheckTimes = useRef(new Map());
  const responseFetches = useRef(new Set());
  const responseCacheLoads = useRef(new Set());
  const responseCacheSaveSignatures = useRef(new Map());
  const networkStreamReads = useRef(new Map());
  const networkCompletionReads = useRef(new Map());
  const connectionRecoveryReads = useRef(new Map());
  const repoTaskVerificationReads = useRef(new Map());
  const conversationRollovers = useRef(new Map());
  const profilesRef = useRef([]);
  const requestTargetsRef = useRef({});
  const responseBodyRefs = useRef(new Map());
  const chatModalRef = useRef(null);
  const chatResponseRef = useRef(null);
  const responseScrollLocked = useRef(new Map());
  const responseScrollPositions = useRef(new Map());
  const responseAuditSignatures = useRef(new Map());

  const projectPageCount = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
  const visibleProjects = useMemo(() => projects.slice(projectPage * PROJECTS_PER_PAGE, (projectPage + 1) * PROJECTS_PER_PAGE), [projects, projectPage]);
  const openChatResponse = chatProfileId ? requestResponses[chatProfileId] : null;
  const openChatMessages = useMemo(() => openChatResponse && chatProfileId
    ? materializeTranscriptMessages(openChatResponse, String(openChatResponse.conversationId || ""))
    : [], [chatProfileId, openChatResponse]);
  const openChatAwaitingAssistant = transcriptAwaitingAssistant(openChatMessages);
  const openChatLatestMessage = openChatMessages.at(-1);
  const openChatLatestMessageKey = openChatLatestMessage
    ? `${openChatLatestMessage.id || "message"}:${openChatLatestMessage.role || ""}:${String(openChatLatestMessage.text || "").length}`
    : "";
  const openChatScrollKey = useMemo(() => {
    if (!openChatResponse || !chatProfileId) return "";
    const messages = Array.isArray(openChatResponse.messages) ? openChatResponse.messages : [];
    const lastMessage = messages.at(-1);
    const visibleText = String(lastMessage?.text || openChatResponse.text || "");
    const contentKey = `${lastMessage?.id || "response"}:${visibleText.length}:${visibleText.slice(-48)}`;
    const selectedTarget = String(requestTargets[chatProfileId] || openChatResponse.conversationId || "");
    const openProfile = (status?.browserProfiles || []).find((profile) => profile.profile_id === chatProfileId);
    const openTab = (openProfile?.conversation_tabs || []).find((tab) => selectedTarget && String(tab.url || "").includes(`/c/${selectedTarget}`))
      || (openProfile?.conversation_tabs || []).find((tab) => tab.active);
    const turnKey = [
      busy === `request:${chatProfileId}`,
      Boolean(openChatResponse.busy),
      Boolean(openChatResponse.loading),
      Boolean(openChatResponse.networkStreamInProgress),
      Boolean(openTab?.busy),
      Boolean(openTab?.settling),
      String(openTab?.network_state || openChatResponse.networkState || "")
    ].join(":");
    return `${openChatResponse.conversationId || ""}:${messages.length}:${contentKey}:${turnKey}`;
  }, [busy, chatProfileId, openChatResponse, requestTargets, status?.browserProfiles]);

  useEffect(() => {
    setProjectPage((current) => Math.min(current, Math.max(0, Math.ceil(projects.length / PROJECTS_PER_PAGE) - 1)));
  }, [projects.length]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PROFILE_TASK_LABELS_STORAGE_KEY, JSON.stringify(profileTaskLabels));
    } catch {
      // Convenience UI only; storage failure must not affect request sending.
    }
  }, [profileTaskLabels]);

  useEffect(() => {
    const browserProfiles = Array.isArray(status?.browserProfiles) ? status.browserProfiles : [];
    if (!browserProfiles.length) return;
    setProfileTaskLabels((current) => {
      let changed = false;
      const next = { ...current };
      for (const profile of browserProfiles) {
        const title = String(profile?.current_task_title || "").trim();
        if (!title || next[profile.profile_id] === title) continue;
        next[profile.profile_id] = title;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [status?.browserProfiles]);
  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const loadDiagnosticLogs = useCallback(async (showBusy = true) => {
    if (typeof api.getDiagnosticLogs !== "function") return;
    if (showBusy) setDiagnosticBusy(true);
    try {
      const next = await api.getDiagnosticLogs({ ...diagnosticFilters, limit: 1500 });
      setDiagnosticLogs(next || { summary: { total: 0, info: 0, warn: 0, error: 0 }, entries: [] });
      setSelectedDiagnostic(null);
    } catch (err) {
      logRendererDiagnostic(api, "error", "runtime", `Không tải được nhật ký: ${err?.message || String(err)}`, { action: "get-diagnostic-logs", error: err });
      setError(err?.message || String(err));
    } finally {
      if (showBusy) setDiagnosticBusy(false);
    }
  }, [diagnosticFilters]);

  const clearDiagnosticLogHistory = useCallback(async () => {
    setDiagnosticBusy(true);
    try {
      await api.clearDiagnosticLogs?.();
      setSelectedDiagnostic(null);
      await loadDiagnosticLogs(false);
      notify("Đã xóa nhật ký chẩn đoán");
    } catch (err) {
      logRendererDiagnostic(api, "error", "runtime", `Không xóa được nhật ký: ${err?.message || String(err)}`, { action: "clear-diagnostic-logs", error: err });
      setError(err?.message || String(err));
    } finally {
      setDiagnosticBusy(false);
    }
  }, [loadDiagnosticLogs, notify]);

  useEffect(() => {
    if (activePage !== "logs") return undefined;
    const timer = window.setTimeout(() => void loadDiagnosticLogs(false), 140);
    return () => window.clearTimeout(timer);
  }, [activePage, loadDiagnosticLogs]);

  useEffect(() => {
    const onError = (event) => logRendererDiagnostic(api, "error", "runtime", event?.message || "Renderer error", { action: "window.error", filename: event?.filename, lineno: event?.lineno, colno: event?.colno, error: event?.error });
    const onRejection = (event) => logRendererDiagnostic(api, "error", "runtime", event?.reason?.message || String(event?.reason || "Unhandled promise rejection"), { action: "unhandledrejection", reason: event?.reason });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  const applyManagerSettings = useCallback((next) => {
    setManagerSettings({
      ...DEFAULT_MANAGER_SETTINGS,
      ...(next || {}),
      repoSelections: { ...DEFAULT_MANAGER_SETTINGS.repoSelections, ...(next?.repoSelections || {}) },
      workerImages: { ...DEFAULT_MANAGER_SETTINGS.workerImages, ...(next?.workerImages || {}) },
      workerImageDataUrls: { ...DEFAULT_MANAGER_SETTINGS.workerImageDataUrls, ...(next?.workerImageDataUrls || {}) },
      workerImagePacks: Array.isArray(next?.workerImagePacks) ? next.workerImagePacks : []
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getManagerSettings()
      .then((next) => { if (!cancelled) applyManagerSettings(next); })
      .catch((err) => {
        if (!cancelled) {
          logRendererDiagnostic(api, "error", "settings", `Không tải được cài đặt: ${err?.message || String(err)}`, { action: "get-manager-settings", error: err });
          setError(err?.message || String(err));
        }
      });
    return () => { cancelled = true; };
  }, [applyManagerSettings]);

  useEffect(() => {
    setRequestProjectRoots((current) => ({ ...current, ...(managerSettings.repoSelections || {}) }));
  }, [managerSettings.repoSelections]);

  const refreshHeadlessWorkers = useCallback(async () => {
    try {
      const next = await api.getHeadlessWorkers();
      setHeadlessState(next || { supported: false, chromePath: "", chromeUserDataRoot: "", sourceProfiles: [], workers: [] });
      setHeadlessSourceProfile((current) => {
        const eligible = (next?.sourceProfiles || []).filter((profile) => profile.codexProInstalled);
        if (current && eligible.some((profile) => profile.profileDirectory === current)) return current;
        return eligible[0]?.profileDirectory || "";
      });
      return next;
    } catch (err) {
      setError(err?.message || String(err));
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshHeadlessWorkers();
    if (activePage !== "settings") return undefined;
    const timer = window.setInterval(() => void refreshHeadlessWorkers(), 4000);
    return () => window.clearInterval(timer);
  }, [activePage, refreshHeadlessWorkers]);

  const runHeadlessAction = useCallback(async (key, action, successMessage) => {
    setHeadlessBusy(key);
    try {
      const result = await action();
      await refreshHeadlessWorkers();
      if (successMessage) notify(successMessage);
      if (result?.warning) notify(result.warning);
      return result;
    } catch (err) {
      setError(err?.message || String(err));
      return null;
    } finally {
      setHeadlessBusy("");
    }
  }, [notify, refreshHeadlessWorkers]);

  const saveManagerSetting = useCallback(async (patch, message = "Đã lưu cài đặt") => {
    setSettingsBusy("save");
    try {
      applyManagerSettings(await api.saveManagerSettings(patch));
      if (message) notify(message);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [applyManagerSettings, notify]);

  useEffect(() => {
    setChatWidthInput(String(managerSettings.chatWidth));
  }, [managerSettings.chatWidth]);

  useEffect(() => {
    setChatHeightInput(String(managerSettings.chatHeight));
  }, [managerSettings.chatHeight]);

  useEffect(() => {
    setGlobalRulesDraft(managerSettings.globalRules || GLOBAL_RULES_TEMPLATE);
  }, [managerSettings.globalRules]);

  const commitChatWidthInput = useCallback(() => {
    const parsed = Number(chatWidthInput);
    const nextWidth = Math.max(720, Math.min(1600, Number.isFinite(parsed) ? Math.round(parsed / 20) * 20 : managerSettings.chatWidth));
    setChatWidthInput(String(nextWidth));
    if (nextWidth !== managerSettings.chatWidth) void saveManagerSetting({ chatWidth: nextWidth }, "Đã lưu độ rộng popup");
  }, [chatWidthInput, managerSettings.chatWidth, saveManagerSetting]);

  const commitChatHeightInput = useCallback(() => {
    const parsed = Number(chatHeightInput);
    const nextHeight = Math.max(180, Math.min(700, Number.isFinite(parsed) ? Math.round(parsed / 10) * 10 : managerSettings.chatHeight));
    setChatHeightInput(String(nextHeight));
    if (nextHeight !== managerSettings.chatHeight) void saveManagerSetting({ chatHeight: nextHeight }, "Đã lưu chiều cao khung chat");
  }, [chatHeightInput, managerSettings.chatHeight, saveManagerSetting]);

  const changeWorkerImage = useCallback(async (state) => {
    setSettingsBusy(`worker:${state}`);
    try {
      applyManagerSettings(await api.chooseWorkerImage({ packId: managerSettings.selectedWorkerPackId, state }));
      notify(`Đã đổi ảnh worker ${state}`);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [applyManagerSettings, managerSettings.selectedWorkerPackId, notify]);

  const restoreWorkerImage = useCallback(async (state) => {
    setSettingsBusy(`worker:${state}`);
    try {
      applyManagerSettings(await api.resetWorkerImage({ packId: managerSettings.selectedWorkerPackId, state }));
      notify(`Đã khôi phục ảnh worker ${state}`);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [applyManagerSettings, managerSettings.selectedWorkerPackId, notify]);

  const createWorkerImagePack = useCallback(async () => {
    const name = workerPackDraft.trim();
    if (!name) return;
    setSettingsBusy("worker-pack:create");
    try {
      applyManagerSettings(await api.createWorkerImagePack(name));
      setWorkerPackDraft("");
      setShowWorkerPackCreator(false);
      setWorkerPackDeleteArmed("");
      notify(`Đã tạo bộ ảnh “${name.slice(0, 60)}”`);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [applyManagerSettings, notify, workerPackDraft]);

  const selectWorkerImagePack = useCallback(async (packId) => {
    setSettingsBusy("worker-pack:select");
    try {
      const next = await api.selectWorkerImagePack(packId);
      applyManagerSettings(next);
      setWorkerPackDeleteArmed("");
      const selected = next.workerImagePacks?.find((pack) => pack.id === packId);
      notify(`Đang dùng ${selected ? `bộ “${selected.name}”` : "bộ mặc định"}`);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [applyManagerSettings, notify]);

  const deleteWorkerImagePack = useCallback(async () => {
    const pack = managerSettings.workerImagePacks.find((item) => item.id === managerSettings.selectedWorkerPackId);
    if (!pack) return;
    if (workerPackDeleteArmed !== pack.id) {
      setWorkerPackDeleteArmed(pack.id);
      return;
    }
    setSettingsBusy("worker-pack:delete");
    try {
      applyManagerSettings(await api.deleteWorkerImagePack(pack.id));
      setWorkerPackDeleteArmed("");
      notify(`Đã xóa bộ ảnh “${pack.name}”`);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [applyManagerSettings, managerSettings.selectedWorkerPackId, managerSettings.workerImagePacks, notify, workerPackDeleteArmed]);

  const restoreManagerSettings = useCallback(async () => {
    setSettingsBusy("reset");
    try {
      applyManagerSettings(await api.resetManagerSettings());
      notify("Đã khôi phục giao diện mặc định");
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [applyManagerSettings, notify]);

  const scrollResponseToBottom = useCallback((profileId) => {
    const container = responseBodyRefs.current.get(profileId);
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    responseScrollPositions.current.set(profileId, container.scrollTop);
  }, []);

  const scrollOpenChatToBottom = useCallback((profileId) => {
    scrollResponseToBottom(profileId);
    const modal = chatModalRef.current;
    if (!modal) return;
    const previousBehavior = modal.style.scrollBehavior;
    modal.style.scrollBehavior = 'auto';
    modal.scrollTop = modal.scrollHeight;
    modal.style.scrollBehavior = previousBehavior;
  }, [scrollResponseToBottom]);

  const holdResponseAutoScroll = useCallback((profileId, container, deltaY = 0) => {
    handleResponseWheel(profileId, container, deltaY, responseScrollLocked.current, RESPONSE_BOTTOM_THRESHOLD_PX);
  }, []);

  const pauseResponseAutoScroll = useCallback((profileId, container) => {
    recordResponseScroll(profileId, container, responseScrollLocked.current, responseScrollPositions.current, RESPONSE_BOTTOM_THRESHOLD_PX);
  }, []);

  const captureResponseSelection = useCallback((key, container) => {
    const selection = window.getSelection?.();
    const text = selection?.toString() || "";
    const inside = Boolean(
      selection
      && selection.rangeCount > 0
      && !selection.isCollapsed
      && selection.anchorNode
      && selection.focusNode
      && container.contains(selection.anchorNode)
      && container.contains(selection.focusNode)
    );
    setResponseSelection(inside && text.trim() ? { key, text } : (current) => current.key === key ? { key: "", text: "" } : current);
  }, []);

  const refresh = useCallback(async (foreground = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (foreground) setBusy("refresh");
    setError("");
    try {
      const nextStatus = await api.getStatus();
      setStatus(applyConversationTitleOverrides(nextStatus, conversationTitleOverridesRef.current));
      if (foreground) {
        const nextProjects = await api.listProjects();
        setProjects((current) => sameProjectList(current, nextProjects) ? current : nextProjects);
      }
    } catch (err) {
      logRendererDiagnostic(api, "error", "status", `Không làm mới Manager: ${err?.message || String(err)}`, { action: "refresh", error: err });
      setError(err?.message || String(err));
    } finally {
      refreshInFlight.current = false;
      if (foreground) setBusy("");
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    if (statusRefreshInFlight.current || refreshInFlight.current) return;
    statusRefreshInFlight.current = true;
    try {
      setStatus(applyConversationTitleOverrides(await api.getStatus(), conversationTitleOverridesRef.current));
    } catch (err) {
      logRendererDiagnostic(api, "warn", "status", `Background status refresh lỗi: ${err?.message || String(err)}`, { action: "refresh-status", error: err });
      // Background realtime refresh should not flash a global error for a transient miss.
    } finally {
      statusRefreshInFlight.current = false;
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    if (projectRefreshInFlight.current || refreshInFlight.current) return;
    projectRefreshInFlight.current = true;
    try {
      const nextProjects = await api.listProjects();
      setProjects((current) => sameProjectList(current, nextProjects) ? current : nextProjects);
    } catch (err) {
      logRendererDiagnostic(api, "warn", "projects", `Background project refresh lỗi: ${err?.message || String(err)}`, { action: "refresh-projects", error: err });
      // Keep the last good project list when a background discovery refresh transiently fails.
    } finally {
      projectRefreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const unsubscribe = api.onBrowserProfiles?.((payload) => {
      const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
      setStatus((current) => {
        if (!current) return current;
        const browserProfiles = mergeBrowserProfilePayload(current.browserProfiles, profiles);
        if (browserProfiles === current.browserProfiles) return current;
        return applyConversationTitleOverrides({ ...current, checkedAt: payload?.checked_at || new Date().toISOString(), browserProfiles }, conversationTitleOverridesRef.current);
      });
    });
    const statusTimer = window.setInterval(() => void refreshStatus(), REALTIME_WATCHDOG_MS);
    const projectsTimer = window.setInterval(() => void refreshProjects(), PROJECT_REFRESH_MS);
    return () => {
      unsubscribe?.();
      window.clearInterval(statusTimer);
      window.clearInterval(projectsTimer);
    };
  }, [refresh, refreshProjects, refreshStatus]);

  const platform = status?.platform || status?.task?.platform || "Windows";

  useEffect(() => {
    const profiles = status?.browserProfiles || [];
    for (const profile of profiles) {
      const lastCheck = profileCheckTimes.current.get(profile.profile_id) || 0;
      const checkedAt = Date.parse(profile.connector_checked_at || "");
      const recentlyVerified = Number.isFinite(checkedAt) && Date.now() - checkedAt < PROFILE_CHECK_TTL_MS;
      if (!profile.connected || !extensionReady(profile.extension_version) || recentlyVerified || Date.now() - lastCheck < PROFILE_CHECK_RETRY_MS) continue;
      profileCheckTimes.current.set(profile.profile_id, Date.now());
      setCheckingProfiles((current) => [...new Set([...current, profile.profile_id])]);
      void api.checkProfile(profile.profile_id)
        .catch((err) => {
          logRendererDiagnostic(api, "warn", "profile", `Kiểm tra profile ${profile.profile_id} lỗi: ${err?.message || String(err)}`, { action: "check-profile", profile_id: profile.profile_id, error: err });
          return null;
        })
        .finally(() => {
          setCheckingProfiles((current) => current.filter((id) => id !== profile.profile_id));
          window.setTimeout(() => void refresh(false), 1200);
        });
    }
  }, [status?.browserProfiles, refresh]);

  useEffect(() => {
    profilesRef.current = status?.browserProfiles || [];
  }, [status?.browserProfiles]);

  useEffect(() => {
    if (!projects.length || !status?.browserProfiles?.length) return;
    const next = { ...profileRepoRoots };
    let changed = false;
    for (const profile of status.browserProfiles) {
      const project = strongProfileRepoMatch(profile, projects);
      if (!project?.root || next[profile.profile_id] === project.root) continue;
      next[profile.profile_id] = project.root;
      changed = true;
    }
    if (!changed) return;
    setProfileRepoRoots(next);
    try { window.localStorage.setItem(PROFILE_REPO_CACHE_KEY, JSON.stringify(next)); } catch {}
  }, [projects, status?.browserProfiles, profileRepoRoots]);

  useEffect(() => {
    for (const profile of status?.browserProfiles || []) {
      if (!profile?.connected || !extensionReady(profile.extension_version)) continue;
      for (const tab of profile.conversation_tabs || []) {
        const conversationId = String(tab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
        if (!conversationId) continue;
        const selectedTarget = String(requestTargetsRef.current[profile.profile_id] || "");
        const currentResponse = requestResponses[profile.profile_id];
        const relevant = selectedTarget === conversationId || currentResponse?.conversationId === conversationId || (chatProfileId === profile.profile_id && tab.active);
        if (!relevant) continue;
        const networkState = String(tab.network_state || (tab.busy ? "generating" : "idle"));
        const networkCompletedAt = String(tab.network_last_completed_at || "");
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          if (previous.conversationId && previous.conversationId !== conversationId) return current;
          if (previous.networkState === networkState && previous.networkCompletedAt === networkCompletedAt && previous.networkError === String(tab.network_error || "")) return current;
          return {
            ...current,
            [profile.profile_id]: {
              ...previous,
              visible: true,
              conversationId,
              busy: networkState === "generating",
              loading: networkState === "generating" ? previous.loading !== false : false,
              networkState,
              networkSource: String(tab.network_source || ""),
              networkStartedAt: String(tab.network_last_started_at || ""),
              networkCompletedAt,
              networkStatusCode: Number(tab.network_status_code) || 0,
              networkError: String(tab.network_error || ""),
              networkDurationMs: Number(tab.network_duration_ms) || 0,
              contentNeedsRefresh: networkState === "completed" ? true : networkState === "generating" ? false : Boolean(previous.contentNeedsRefresh)
            }
          };
        });
        if (tab.connection_interrupted) {
          const recoveryKey = `${profile.profile_id}:${conversationId}`;
          const lastRecovery = Number(connectionRecoveryReads.current.get(recoveryKey) || 0);
          if (Date.now() - lastRecovery >= 15000) {
            connectionRecoveryReads.current.set(recoveryKey, Date.now());
            void loadResponse(profile, conversationId, true, true, true);
          }
          continue;
        }
        const recoverableAbort = isRecoverableAbortedChatNetworkFailure({
          networkState,
          networkError: tab.network_error,
          networkCompletedAt,
          responseReady: Boolean(currentResponse?.responseReady)
        });
        if (recoverableAbort) {
          const recoveryKey = `network-abort:${profile.profile_id}:${conversationId}`;
          const lastRecovery = Number(connectionRecoveryReads.current.get(recoveryKey) || 0);
          if (Date.now() - lastRecovery >= LATEST_RESPONSE_RECOVERY_POLL_MS) {
            connectionRecoveryReads.current.set(recoveryKey, Date.now());
            void loadResponse(profile, conversationId, true, false, false, true);
          }
          continue;
        }
        if (networkState === "generating" || tab.busy || tab.settling) {
          const streamKey = `${profile.profile_id}:${conversationId}`;
          const lastStreamRead = Number(networkStreamReads.current.get(streamKey) || 0);
          const activityPollMs = networkState === "generating" ? 850 : LATEST_RESPONSE_RECOVERY_POLL_MS;
          if (Date.now() - lastStreamRead >= activityPollMs) {
            networkStreamReads.current.set(streamKey, Date.now());
            void loadResponse(profile, conversationId, true, false, false, networkState !== "generating");
          }
          continue;
        }
        if (networkState !== "completed" || !networkCompletedAt) continue;
        const completionKey = `${profile.profile_id}:${conversationId}`;
        const contentAlreadyRead = networkCompletionReads.current.get(completionKey) === networkCompletedAt;
        if (!contentAlreadyRead) {
          networkCompletionReads.current.set(completionKey, networkCompletedAt);
          void loadResponse(profile, conversationId, true, false);
          if (Date.now() - Date.parse(networkCompletedAt) < 15000 && tab.network_source === "codexpro") notify("AI đã phản hồi xong · xác nhận trực tiếp từ network");
        }
        if (currentResponse?.repoTaskId && canVerifyRepoTaskUse({
          responseCurrent: currentResponse.conversationId === conversationId,
          responseReady: currentResponse.responseReady,
          responseBusy: currentResponse.busy,
          responseIncomplete: currentResponse.incomplete,
          awaitingAssistant: currentResponse.awaitingAssistant,
          tabBusy: tab.busy,
          tabSettling: tab.settling,
          canonicalBusy: currentResponse.canonicalBusy,
          streamBusy: currentResponse.networkStreamInProgress,
          networkCompletedAt,
          repoTaskDispatchedAt: currentResponse.repoTaskDispatchedAt
        })) {
          void verifyRepoTaskUse(profile, conversationId, currentResponse, networkCompletedAt);
        }
      }
    }
  }, [status?.browserProfiles, chatProfileId, requestResponses, notify]);

  useEffect(() => {
    requestTargetsRef.current = requestTargets;
  }, [requestTargets]);

  useEffect(() => {
    if (!chatProfileId) return;
    const profile = (status?.browserProfiles || []).find((item) => item.profile_id === chatProfileId);
    if (!profile) return;
    const conversations = profileRequestChats(profile);
    const initialTarget = requestTargetsRef.current[chatProfileId] || conversations.find((chat) => chat.active)?.id || conversations[0]?.id || NEW_CHAT_TARGET;
    if (!requestTargetsRef.current[chatProfileId]) {
      setRequestTargets((current) => ({ ...current, [chatProfileId]: initialTarget }));
    }
    const response = requestResponses[chatProfileId];
    if (profile.connected && initialTarget !== NEW_CHAT_TARGET && (!response || response.conversationId !== initialTarget)) void hydrateCachedResponse(profile, initialTarget);
  }, [chatProfileId, status?.browserProfiles, requestResponses]);

  useEffect(() => {
    const conversationId = String(openChatResponse?.conversationId || "");
    if (!chatProfileId || !/^[A-Za-z0-9-]{8,160}$/.test(conversationId) || !openChatAwaitingAssistant) return;
    let cancelled = false;
    let timer = 0;
    const pollLatestResponse = async () => {
      const profile = profilesRef.current.find((item) => item.profile_id === chatProfileId);
      if (cancelled) return;
      if (profile?.connected) {
        const canonical = await loadResponse(profile, conversationId, true, false, false, true);
        if (!cancelled && completedResponseNeedsDomFallback(canonical)) {
          await loadResponse(profile, conversationId, true, true);
        }
      }
      if (!cancelled) timer = window.setTimeout(pollLatestResponse, LATEST_RESPONSE_RECOVERY_POLL_MS);
    };
    timer = window.setTimeout(pollLatestResponse, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chatProfileId, openChatResponse?.conversationId, openChatAwaitingAssistant, openChatLatestMessageKey]);

  useEffect(() => {
    if (!chatProfileId) return;
    responseScrollLocked.current.delete(chatProfileId);
    responseScrollPositions.current.delete(chatProfileId);
  }, [chatProfileId, requestTargets[chatProfileId]]);

  useEffect(() => {
    if (!chatProfileId) return;
    const response = requestResponses[chatProfileId];
    persistResponseCache(chatProfileId, response);
  }, [chatProfileId, requestResponses]);

  useEffect(() => {
    if (!DEEP_UI_DIAGNOSTICS_ENABLED || !chatProfileId || !openChatResponse?.responseAudit || typeof api.logChatResponseAudit !== "function") return undefined;
    const conversationId = String(openChatResponse.conversationId || "");
    const timer = window.setTimeout(() => {
      const transcript = responseBodyRefs.current.get(chatProfileId);
      const renderedMessages = transcript ? [...transcript.querySelectorAll(".chat-transcript-message[data-audit-role]")].map((node) => {
        const content = node.querySelector(".chat-message-text");
        const visibleText = String(content?.innerText || content?.textContent || "").replace(/\s+/g, " ").trim();
        return {
          role: String(node.dataset.auditRole || ""),
          fingerprint: String(node.dataset.auditFingerprint || ""),
          length: Number(node.dataset.auditLength) || 0,
          preview: visibleText.slice(-180)
        };
      }) : [];
      const record = buildChatResponseAuditRecord({
        profileId: chatProfileId,
        conversationId,
        requestId: openChatResponse.repoTaskId,
        fetchMode: openChatResponse.responseAuditFetchMode,
        sourceAudit: openChatResponse.responseAudit,
        managerMessages: materializeTranscriptMessages(openChatResponse, conversationId),
        renderedMessages,
        networkState: openChatResponse.networkState,
        networkStartedAt: openChatResponse.networkStartedAt,
        networkCompletedAt: openChatResponse.networkCompletedAt
      });
      const key = `${chatProfileId}:${conversationId}`;
      const signature = JSON.stringify({
        comparison: record.comparison,
        basis: record.comparisonBasis,
        selectedSource: record.selectedSource,
        source: record.sources[record.comparisonBasis === "chatgpt_dom" ? "chatgptDom" : record.comparisonBasis === "canonical_api" ? "canonical" : "networkStream"],
        managerState: record.managerState,
        managerUi: record.managerUi
      });
      if (responseAuditSignatures.current.get(key) === signature) return;
      responseAuditSignatures.current.set(key, signature);
      api.logChatResponseAudit(record);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [chatProfileId, openChatResponse?.conversationId, openChatResponse?.responseAuditKey, openChatLatestMessageKey]);

  useLayoutEffect(() => {
    if (!chatProfileId || !openChatScrollKey) return;
    if (responseScrollLocked.current.get(chatProfileId)) return;
    scrollResponseToBottom(chatProfileId);
  }, [chatProfileId, openChatScrollKey, scrollResponseToBottom]);

  useEffect(() => {
    if (!chatProfileId) return undefined;
    return installResponseAutoPin({
      panel: chatResponseRef.current,
      getContainer: () => responseBodyRefs.current.get(chatProfileId),
      isLocked: () => Boolean(responseScrollLocked.current.get(chatProfileId)),
      scrollToBottom: () => scrollResponseToBottom(chatProfileId)
    });
  }, [chatProfileId, requestTargets[chatProfileId], scrollResponseToBottom]);

  useEffect(() => {
    if (!DEEP_UI_DIAGNOSTICS_ENABLED || !chatProfileId || typeof api.logChatLayout !== "function") return undefined;
    const panel = chatResponseRef.current;
    if (!panel) return undefined;
    let animationFrame = 0;
    let flushTimer = 0;
    let previousSnapshot = null;
    const pendingChanges = [];
    const describeNode = (node) => {
      if (!(node instanceof Element)) return { nodeType: node?.nodeType || 0 };
      return {
        tag: node.tagName.toLowerCase(),
        className: String(node.className || "").slice(0, 180),
        height: Math.round(node.getBoundingClientRect().height),
        children: node.childElementCount,
        textLength: String(node.textContent || "").length
      };
    };
    const captureSnapshot = (cause) => {
      const transcript = panel.querySelector(".chat-transcript");
      const panelNodes = [...panel.children].map(describeNode);
      const transcriptNodes = transcript ? [...transcript.children].map(describeNode) : [];
      const snapshot = {
        at: new Date().toISOString(),
        profileId: chatProfileId,
        conversationId: String(panel.dataset.layoutConversationId || ""),
        cause,
        state: {
          sending: panel.dataset.layoutSending === "1",
          busy: panel.dataset.layoutBusy === "1",
          settling: panel.dataset.layoutSettling === "1",
          stream: panel.dataset.layoutStream === "1",
          hasContent: panel.dataset.layoutHasContent === "1",
          networkState: String(panel.dataset.layoutNetworkState || ""),
          messageCount: Number(panel.dataset.layoutMessageCount || 0)
        },
        panel: {
          height: Math.round(panel.getBoundingClientRect().height),
          scrollHeight: panel.scrollHeight,
          clientHeight: panel.clientHeight
        },
        transcript: transcript ? {
          height: Math.round(transcript.getBoundingClientRect().height),
          scrollTop: Math.round(transcript.scrollTop),
          scrollHeight: transcript.scrollHeight,
          clientHeight: transcript.clientHeight,
          locked: Boolean(responseScrollLocked.current.get(chatProfileId))
        } : null,
        panelNodes,
        transcriptNodes,
        changes: pendingChanges.splice(0, pendingChanges.length)
      };
      const layoutPanelNodes = panelNodes.map(({ textLength: _textLength, ...node }) => node);
      const layoutTranscriptNodes = transcriptNodes.map(({ textLength: _textLength, ...node }) => node);
      const signature = JSON.stringify({ state: snapshot.state, panel: snapshot.panel, transcript: snapshot.transcript, panelNodes: layoutPanelNodes, transcriptNodes: layoutTranscriptNodes });
      if (!previousSnapshot || previousSnapshot.signature !== signature) {
        snapshot.delta = previousSnapshot ? {
          panelHeight: snapshot.panel.height - previousSnapshot.panelHeight,
          transcriptHeight: (snapshot.transcript?.height || 0) - previousSnapshot.transcriptHeight,
          scrollTop: (snapshot.transcript?.scrollTop || 0) - previousSnapshot.scrollTop
        } : null;
        api.logChatLayout(snapshot);
        previousSnapshot = {
          signature,
          panelHeight: snapshot.panel.height,
          transcriptHeight: snapshot.transcript?.height || 0,
          scrollTop: snapshot.transcript?.scrollTop || 0
        };
      }
    };
    const scheduleSnapshot = (cause) => {
      window.clearTimeout(flushTimer);
      window.cancelAnimationFrame(animationFrame);
      flushTimer = window.setTimeout(() => {
        animationFrame = window.requestAnimationFrame(() => captureSnapshot(cause));
      }, 80);
    };
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        pendingChanges.push({
          type: record.type,
          attribute: record.attributeName || "",
          target: describeNode(record.target),
          added: [...record.addedNodes].map(describeNode),
          removed: [...record.removedNodes].map(describeNode)
        });
      }
      if (pendingChanges.length > 24) pendingChanges.splice(0, pendingChanges.length - 24);
      scheduleSnapshot("mutation");
    });
    const resizeObserver = new ResizeObserver(() => scheduleSnapshot("resize"));
    mutationObserver.observe(panel, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-layout-sending", "data-layout-busy", "data-layout-settling", "data-layout-stream", "data-layout-has-content", "data-layout-network-state", "data-layout-message-count"]
    });
    resizeObserver.observe(panel);
    scheduleSnapshot("attach");
    return () => {
      window.clearTimeout(flushTimer);
      window.cancelAnimationFrame(animationFrame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [chatProfileId, requestTargets[chatProfileId]]);


  useEffect(() => {
    if (!chatProfileId) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event) => {
      if (event.key !== "Escape") return;
      if (attachmentPreview) {
        event.preventDefault();
        setAttachmentPreview(null);
        return;
      }
      setChatProfileId("");
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [chatProfileId, attachmentPreview]);

  const profileSummary = useMemo(() => {
    const allProfiles = status?.browserProfiles || [];
    const profiles = allProfiles.filter((profile) => profile.connected);
    const outdated = profiles.filter((profile) => !extensionReady(profile.extension_version));
    return {
      working: profiles.filter((profile) => profile.activity === "working" || profile.activity === "settling").length,
      idle: profiles.filter((profile) => profile.activity === "idle" && (profile.connector_installed || !extensionReady(profile.extension_version))).length,
      hung: allProfiles.filter((profile) => !profile.connected).length,
      missing: profiles.filter((profile) => profile.activity === "no_chatgpt" && !profile.connector_installed).length,
      reload: outdated.filter(profileSafeForWorkerUpdate).length,
      deferredUpdate: outdated.filter((profile) => !profileSafeForWorkerUpdate(profile)).length,
      outdated: outdated.length
    };
  }, [status?.browserProfiles]);

  async function copyLink() {
    if (!status?.mcpLink) return;
    await api.copyText(status.mcpLink);
    notify("Đã copy link MCP");
  }

  async function rotateLink() {
    setBusy("rotate");
    setError("");
    try {
      const result = await api.rotateLink();
      if (!result.cancelled) {
        setStatus(result);
        await api.copyText(result.mcpLink);
        notify("Đã tạo và copy link mới");
      }
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function control(action) {
    setBusy(action);
    setError("");
    try {
      setStatus(await api.controlServer(action));
      notify(action === "restart" ? "CodexPro đã restart" : "CodexPro đã khởi động");
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function addProject() {
    const root = await api.chooseProject();
    if (!root) return;
    setBusy("add");
    try {
      setProjects(await api.addProject(root));
      notify("Đã thêm dự án");
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function inspect(project) {
    setBusy(project.root);
    setError("");
    try {
      const result = await api.inspectProject(project.root);
      setInspection({ project, result });
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  function projectRootForProfile(profile) {
    const workspaceProjects = projects;
    const requested = String(requestProjectRoots[profile.profile_id] || managerSettings.repoSelections?.[profile.profile_id] || "");
    if (requested === ALL_ALLOWED_WORKSPACES) return ALL_ALLOWED_WORKSPACES;
    const exact = workspaceProjects.find((project) => project.root.toLowerCase() === requested.toLowerCase());
    if (exact) return exact.root;
    const currentWorkspace = String(profile.current_workspace_root || "");
    return workspaceProjects.find((project) => project.root.toLowerCase() === currentWorkspace.toLowerCase())?.root
      || workspaceProjects.find((project) => project.active)?.root
      || workspaceProjects[0]?.root
      || "";
  }

  function selectProjectForProfile(profileId, root) {
    setRequestProjectRoots((current) => ({ ...current, [profileId]: root }));
    setManagerSettings((current) => ({ ...current, repoSelections: { ...(current.repoSelections || {}), [profileId]: root } }));
    void api.saveManagerSettings({ repoSelections: { [profileId]: root } })
      .then(applyManagerSettings)
      .catch((err) => setRequestSendErrors((current) => ({ ...current, [profileId]: err?.message || String(err) })));
  }

  function changeProjectForProfile(profile, root) {
    const profileId = profile.profile_id;
    const previousRoot = projectRootForProfile(profile);
    selectProjectForProfile(profileId, root);
    if (!projectSelectionChanged(previousRoot, root)) return;

    requestTargetsRef.current = { ...requestTargetsRef.current, [profileId]: NEW_CHAT_TARGET };
    setRequestTargets((current) => ({ ...current, [profileId]: NEW_CHAT_TARGET }));
    setRequestResponses((current) => ({
      ...current,
      [profileId]: {
        visible: true,
        loading: false,
        error: "",
        conversationId: NEW_CHAT_TARGET,
        text: "",
        messages: [],
        busy: false
      }
    }));
    setRequestSendErrors((current) => ({ ...current, [profileId]: "" }));
    setRequestSendEvidence((current) => ({ ...current, [profileId]: null }));
    setRenameChat(null);
    responseScrollLocked.current.delete(profileId);
    responseScrollPositions.current.delete(profileId);
    notify("Đã đổi dự án · tin nhắn tiếp theo sẽ mở chat mới");
  }

  async function setupProfile(profile) {
    setBusy(`profile:${profile.profile_id}`);
    setError("");
    try {
      const result = await api.setupProfile(profile.profile_id);
      notify(result.message || "CodexPro READY · kết nối thành công");
      await refresh(false);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  function responseCacheKey(profileId, conversationId) {
    return `${profileId}:${conversationId}`;
  }

  function profileConversationTab(profile, conversationId) {
    return (profile?.conversation_tabs || []).find((tab) => String(tab?.url || "").includes(`/c/${conversationId}`)) || null;
  }

  function cachedResponseIsFresh(profile, conversationId, cached) {
    if (!cached?.messages?.length && !cached?.text) return false;
    if (cached?.responseReady !== true) return false;
    if (transcriptAwaitingAssistant(materializeTranscriptMessages(cached, conversationId))) return false;
    const tab = profileConversationTab(profile, conversationId);
    if (!tab) return false;
    const networkState = String(tab.network_state || (tab.busy ? "generating" : "idle"));
    if (tab.busy || tab.settling || networkState === "generating") return false;
    const completedAt = String(tab.network_last_completed_at || "");
    return !completedAt || completedAt === String(cached.networkCompletedAt || "");
  }

  function persistResponseCache(profileId, response) {
    const conversationId = String(response?.conversationId || "");
    const messages = cacheableTranscriptMessages(response?.messages);
    const text = String(response?.text || "").trim();
    const networkState = String(response?.networkState || "");
    if (!/^[A-Za-z0-9-]{8,160}$/.test(conversationId) || (!messages.length && !text)) return;
    const key = responseCacheKey(profileId, conversationId);
    const signature = JSON.stringify([
      String(response?.networkCompletedAt || ""),
      networkState,
      Boolean(response?.responseReady),
      String(response?.responseSource || ""),
      Boolean(response?.truncated),
      text,
      messages.map((message) => [message?.id, message?.role, message?.text, Boolean(message?.truncated), message?.submissionState, message?.createdAt, Boolean(message?.uncertain), Boolean(message?.provisional), message?.endTurn])
    ]);
    if (responseCacheSaveSignatures.current.get(key) === signature) return;
    responseCacheSaveSignatures.current.set(key, signature);
    void api.saveChatResponseCache({
      profileId,
      conversationId,
      messages,
      text,
      truncated: Boolean(response?.truncated),
      networkCompletedAt: String(response?.networkCompletedAt || ""),
      networkState,
      responseReady: Boolean(response?.responseReady),
      responseSource: String(response?.responseSource || ""),
      updatedAt: String(response?.updatedAt || new Date().toISOString())
    }).catch(() => {
      if (responseCacheSaveSignatures.current.get(key) === signature) responseCacheSaveSignatures.current.delete(key);
    });
  }

  async function hydrateCachedResponse(profile, conversationId) {
    const key = responseCacheKey(profile.profile_id, conversationId);
    if (responseCacheLoads.current.has(key)) return;
    responseCacheLoads.current.add(key);
    try {
      const cached = await api.getChatResponseCache({ profileId: profile.profile_id, conversationId }).catch(() => null);
      if (cached) {
        const tab = profileConversationTab(profile, conversationId);
        const networkState = String(tab?.network_state || cached.networkState || "idle");
        const terminalUnverified = cached.responseReady !== true && !tab?.busy && !tab?.settling && isTerminalChatNetworkState(networkState);
        const rawCachedMessages = trimRecentTranscriptMessages(cached.messages);
        const cacheableMessages = cacheableTranscriptMessages(cached.messages);
        const cachedMessages = terminalUnverified
          ? discardProvisionalAssistantAfterLatestUser(cacheableMessages, { includeUnverified: true })
          : cacheableMessages;
        const cachedText = terminalUnverified
          ? String([...cachedMessages].reverse().find((message) => message?.role === "assistant")?.text || "")
          : String(cached.text || "").trim();
        if (!terminalUnverified && rawCachedMessages.length === cachedMessages.length) {
          responseCacheSaveSignatures.current.set(key, JSON.stringify([
            String(cached.networkCompletedAt || ""),
            String(cached.networkState || ""),
            Boolean(cached.responseReady),
            String(cached.responseSource || ""),
            Boolean(cached.truncated),
            cachedText,
            cachedMessages.map((message) => [message?.id, message?.role, message?.text, Boolean(message?.truncated), message?.submissionState, message?.createdAt, Boolean(message?.uncertain), Boolean(message?.provisional), message?.endTurn])
          ]));
        } else {
          responseCacheSaveSignatures.current.delete(key);
        }
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          const previousIsNewer = previous.conversationId === conversationId
            && Date.parse(String(previous.updatedAt || "")) > Date.parse(String(cached.updatedAt || ""));
          if (previousIsNewer) return current;
          return {
            ...current,
            [profile.profile_id]: {
              ...previous,
              ...cached,
              visible: true,
              loading: false,
              error: "",
              conversationId,
              text: cachedText,
              messages: cachedMessages,
              busy: Boolean(tab?.busy || tab?.settling || networkState === "generating"),
              networkState,
              networkCompletedAt: String(tab?.network_last_completed_at || cached.networkCompletedAt || ""),
              cached: true
            }
          };
        });
      }
      if (!cachedResponseIsFresh(profile, conversationId, cached)) {
        const cachedHasContent = Boolean(cached?.messages?.length || String(cached?.text || "").trim());
        const fastResult = await loadResponse(profile, conversationId, true, false);
        const fastHasContent = Boolean(
          fastResult?.network_stream_available && fastResult?.network_stream_in_progress === true
          && (String(fastResult?.text || "").trim() || fastResult?.messages?.length || String(fastResult?.network_stream_activity_text || "").trim())
        );
        if (!fastHasContent && completedResponseNeedsDomFallback(fastResult)) {
          window.setTimeout(() => void loadResponse(profile, conversationId, true, true, false, false), cachedHasContent ? 250 : 0);
        }
      }
    } finally {
      responseCacheLoads.current.delete(key);
    }
  }

  function openChat(profile) {
    const conversations = profileRequestChats(profile);
    const conversationId = String(requestTargets[profile.profile_id] || conversations.find((chat) => chat.active)?.id || conversations[0]?.id || NEW_CHAT_TARGET);
    if (conversationId) setRequestTargets((current) => ({ ...current, [profile.profile_id]: conversationId }));
    const projectRoot = projectRootForProfile(profile);
    const rememberedRoot = String(requestProjectRoots[profile.profile_id] || managerSettings.repoSelections?.[profile.profile_id] || "");
    if (projectRoot && projectRoot.toLowerCase() !== rememberedRoot.toLowerCase()) selectProjectForProfile(profile.profile_id, projectRoot);
    else if (projectRoot) setRequestProjectRoots((current) => ({ ...current, [profile.profile_id]: projectRoot }));
    responseScrollLocked.current.delete(profile.profile_id);
    responseScrollPositions.current.delete(profile.profile_id);
    setChatProfileId(profile.profile_id);
    window.requestAnimationFrame(() => {
      scrollOpenChatToBottom(profile.profile_id);
      window.setTimeout(() => scrollOpenChatToBottom(profile.profile_id), 180);
    });
    if (profile.connected && conversationId && conversationId !== NEW_CHAT_TARGET) {
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        const sameConversation = previous.conversationId === conversationId;
        return { ...current, [profile.profile_id]: { ...(sameConversation ? previous : {}), visible: true, loading: !sameConversation, error: "", conversationId, messages: sameConversation ? trimRecentTranscriptMessages(previous.messages) : [] } };
      });
      void hydrateCachedResponse(profile, conversationId).finally(() => {
        window.requestAnimationFrame(() => {
          scrollOpenChatToBottom(profile.profile_id);
          window.setTimeout(() => scrollOpenChatToBottom(profile.profile_id), 180);
        });
      });
    }
  }

  function startNewChat(profile) {
    setRenameChat(null);
    setRequestTargets((current) => ({ ...current, [profile.profile_id]: NEW_CHAT_TARGET }));
    requestDraftsRef.current[profile.profile_id] = "";
    setRequestDraftResetVersions((current) => ({ ...current, [profile.profile_id]: (current[profile.profile_id] || 0) + 1 }));
    setRequestFiles((current) => ({ ...current, [profile.profile_id]: [] }));
    setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
    setRequestResponses((current) => ({ ...current, [profile.profile_id]: { visible: true, loading: false, error: "", conversationId: NEW_CHAT_TARGET, text: "", busy: false } }));
  }

  function beginRenameSelectedChat(profile, conversationId, currentTitle) {
    if (!conversationId || conversationId === NEW_CHAT_TARGET || busy) return;
    setRenameChat({ profileId: profile.profile_id, conversationId, originalTitle: currentTitle || "", title: currentTitle || "" });
    setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
  }

  async function saveRenamedChat(profile) {
    if (!renameChat || renameChat.profileId !== profile.profile_id || busy) return;
    const { conversationId, originalTitle } = renameChat;
    const title = String(renameChat.title || "").trim();
    if (!title) {
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "Tên đoạn chat không được để trống." }));
      return;
    }
    if (title.length > 120) {
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "Tên đoạn chat được tối đa 120 ký tự." }));
      return;
    }
    if (title === originalTitle) {
      setRenameChat(null);
      return;
    }
    setBusy(`rename-chat:${profile.profile_id}`);
    setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
    try {
      await api.renameProfileChat({ profileId: profile.profile_id, conversationId, title });
      conversationTitleOverridesRef.current = { ...conversationTitleOverridesRef.current, [`${profile.profile_id}:${conversationId}`]: title };
      setStatus((current) => applyConversationTitleOverrides(current, conversationTitleOverridesRef.current));
      setRenameChat(null);
      notify(`Đã đổi tên thành “${title}”`);
      window.setTimeout(() => void refresh(false), 2500);
    } catch (err) {
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: err?.message || String(err) }));
    } finally {
      setBusy("");
    }
  }

  async function openProfile(profile, options = {}) {
    const tabs = profile.conversation_tabs || [];
    const activeTab = profileChromeTarget(profile);
    const conversationOf = (tab) => String(tab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
    const activeConversationId = conversationOf(activeTab);
    const conversations = profileRequestChats(profile);
    const defaultTarget = activeConversationId || conversations.find((chat) => chat.active)?.id || conversations[0]?.id || "";
    const requestedConversationId = String(requestTargets[profile.profile_id] || "");
    const conversationId = options.focusOnly ? activeConversationId : String(requestedConversationId || defaultTarget);
    const selectedTab = tabs.find((tab) => conversationOf(tab) === conversationId);
    const targetTab = selectedTab || activeTab;
    const selectedConversation = conversations.find((chat) => String(chat.id) === conversationId);
    const selectionReason = options.focusOnly ? "focus_only_active_tab" : selectedTab ? "selected_conversation_tab" : activeTab ? "active_tab_fallback" : "missing_target_tab";
    const selectionDiagnostic = {
      action: "profile-tab-open-selection",
      profile_id: profile.profile_id,
      focus_only: Boolean(options.focusOnly),
      selection_reason: selectionReason,
      requested_conversation_id: requestedConversationId,
      default_conversation_id: String(defaultTarget || ""),
      selected_conversation_id: String(conversationId || ""),
      active_target_id: String(activeTab?.id || ""),
      active_conversation_id: activeConversationId,
      selected_target_id: String(selectedTab?.id || ""),
      target_id: String(targetTab?.id || ""),
      target_conversation_id: conversationOf(targetTab),
      target_title: String(selectedConversation?.title || targetTab?.title || profile.active_chat_title || ""),
      tab_candidates: tabs.slice(0, 20).map((tab) => ({ id: String(tab?.id || ""), conversation_id: conversationOf(tab), active: Boolean(tab?.active), window_id: String(tab?.windowId ?? tab?.window_id ?? ""), title: String(tab?.title || "").slice(0, 160), url: String(tab?.url || "").slice(0, 300) }))
    };
    logRendererDiagnostic(api, "info", "profile", `Manager chọn tab ${selectionDiagnostic.target_id || "không xác định"} để mở profile ${profile.profile_id}`, selectionDiagnostic);
    setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
    setRequestSendEvidence((current) => ({ ...current, [profile.profile_id]: null }));
    setBusy(`open-profile:${profile.profile_id}`);
    setError("");
    try {
      const result = await api.openProfileChat({
        profileId: profile.profile_id,
        conversationId,
        targetId: targetTab?.id,
        targetConversationId: conversationOf(targetTab),
        title: selectedConversation?.title || targetTab?.title || profile.active_chat_title || "",
        selectionReason,
        activeTargetId: activeTab?.id,
        activeConversationId
      });
      logRendererDiagnostic(api, "info", "profile", `Chrome xác nhận mở tab ${String(result?.activation?.target_id || result?.target_id || "không xác định")}`, { ...selectionDiagnostic, action: "profile-tab-open-result", result_profile_id: String(result?.profile_id || ""), result_conversation_id: String(result?.conversation_id || ""), result_target_id: String(result?.target_id || ""), activation_target_id: String(result?.activation?.target_id || ""), activation_window_id: String(result?.activation?.window_id || ""), activation_window_focused: Boolean(result?.activation?.window_focused), activation_acknowledgement_delayed: Boolean(result?.activation_acknowledgement_delayed), navigation_target_id: String(result?.navigation?.target_id || ""), navigation_url: String(result?.navigation?.url || ""), window_focus: result?.window_focus || null });
    } catch (err) {
      logRendererDiagnostic(api, "error", "profile", `Mở tab profile thất bại: ${err?.message || String(err)}`, { ...selectionDiagnostic, action: "profile-tab-open-error", error: err });
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function recoverProfileTab(profile) {
    const tabs = profile.conversation_tabs || [];
    const conversationOf = (tab) => String(tab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
    const selectedConversationId = String(requestTargets[profile.profile_id] || "");
    const selectedTab = tabs.find((tab) => conversationOf(tab) === selectedConversationId);
    const targetTab = selectedTab || tabs.find((tab) => tab.active) || tabs[0];
    const conversationId = conversationOf(targetTab);
    const selectedConversation = profileRequestChats(profile).find((chat) => String(chat.id) === conversationId);
    setBusy(`recover-profile:${profile.profile_id}`);
    setError("");
    try {
      await api.recoverProfileChat({
        profileId: profile.profile_id,
        conversationId,
        targetId: targetTab?.id,
        title: selectedConversation?.title || targetTab?.title || profile.active_chat_title || ""
      });
      notify("Đã thay tab ChatGPT bị treo bằng tab mới");
      window.setTimeout(() => void refresh(false), 1200);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function reloadProfiles() {
    if (!profileSummary.reload) return;
    setWorkerUpdateConfirmOpen(false);
    setBusy("reload-profiles");
    setError("");
    try {
      const result = await api.reloadProfiles();
      if (result.count) {
        notify(`Đã update thành công ${result.count} worker lên ${result.version}${result.deferred ? ` · bỏ qua ${result.deferred} worker đang làm việc` : ""}`);
      } else if (result.deferred) {
        notify(`${result.deferred} worker đang làm việc · chưa update để tránh gián đoạn`);
      } else {
        notify(`Worker extension đã ở bản ${WORKER_EXTENSION_VERSION}`);
      }
      window.setTimeout(() => void refresh(false), result.mode === "bootstrap_reload" || result.mode === "mixed_update" ? 8000 : 3500);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function sendRequest(profile, draftOverride = null) {
    const conversations = profileRequestChats(profile);
    const defaultTarget = conversations.find((chat) => chat.active)?.id ?? conversations[0]?.id;
    const conversationId = String(requestTargets[profile.profile_id] ?? defaultTarget ?? NEW_CHAT_TARGET);
    const newChat = conversationId === NEW_CHAT_TARGET;
    const text = String(draftOverride !== null ? draftOverride : (requestDraftsRef.current[profile.profile_id] || "")).trim();
    const attachments = requestFiles[profile.profile_id] || [];
    const projectRoot = projectRootForProfile(profile);
    if (!text && !attachments.length) return false;
    if (!projectRoot) {
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "Chưa có workspace nào được chọn." }));
      return false;
    }
    if (!newChat) {
      const selectedTab = (profile.conversation_tabs || []).find((tab) => String(tab.url || "").includes(`/c/${conversationId}`));
      const currentResponse = requestResponses[profile.profile_id];
      const networkState = String(selectedTab?.network_state || currentResponse?.networkState || (selectedTab?.busy ? "generating" : "idle"));
      const selectedRecoveringNetworkAbort = isRecoverableAbortedChatNetworkFailure({
        networkState,
        networkError: currentResponse?.networkError || selectedTab?.network_error || "",
        networkCompletedAt: currentResponse?.networkCompletedAt || selectedTab?.network_last_completed_at || "",
        responseReady: Boolean(currentResponse?.responseReady)
      });
      const turnReady = !selectedRecoveringNetworkAbort && canAcceptNextChatMessage({
        networkState,
        tabBusy: selectedTab?.busy,
        tabSettling: selectedTab?.settling,
        responseCurrent: currentResponse?.conversationId === conversationId,
        responseBusy: currentResponse?.busy,
        responseReady: currentResponse?.responseReady,
        responseLoading: currentResponse?.loading,
        responseIncomplete: currentResponse?.incomplete,
        canonicalBusy: currentResponse?.canonicalBusy,
        streamBusy: currentResponse?.networkStreamInProgress
      });
      if (!turnReady) {
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "ChatGPT vẫn đang xử lý hoặc hoàn tất lượt trước. Chờ trạng thái về ĐANG RẢNH rồi gửi để tin nhắn không bị nhập vào turn cũ." }));
        return false;
      }
    }
    responseScrollLocked.current.delete(profile.profile_id);
    setBusy(`request:${profile.profile_id}`);
    setError("");
    setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
    setRequestSendEvidence((current) => ({ ...current, [profile.profile_id]: null }));
    const clearKey = `${profile.profile_id}:${conversationId}`;
    setClearedResponseTargets((current) => {
      if (!current[clearKey]) return current;
      const { [clearKey]: _cleared, ...next } = current;
      return next;
    });
    if (!newChat && text) {
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        const previousMessages = materializeTranscriptMessages(previous, conversationId);
        return {
          ...current,
          [profile.profile_id]: {
            ...previous,
            visible: true,
            loading: true,
            error: "",
            conversationId,
            messages: trimRecentTranscriptMessages([...previousMessages, {
              id: `optimistic-user-${Date.now()}`,
              role: "user",
              text,
              pending: true,
              submissionState: "pending",
              createdAt: new Date().toISOString()
            }])
          }
        };
      });
    }
    try {
      const restoreSubmittedInputs = () => {
        setRequestFiles((current) => {
          if (!attachments.length || (current[profile.profile_id] || []).length) return current;
          return { ...current, [profile.profile_id]: attachments };
        });
      };
      setRequestFiles((current) => ({ ...current, [profile.profile_id]: [] }));
      const allAllowedScope = projectRoot === ALL_ALLOWED_WORKSPACES;
      const result = await api.sendProfileRequest({ profileId: profile.profile_id, conversationId: newChat ? "" : conversationId, newChat, scope: allAllowedScope ? "all_allowed" : "workspace", projectRoot: allAllowedScope ? "" : projectRoot, workspaceCandidates: allAllowedScope ? projects.map((project) => project.root) : [], text, attachments });
      setRequestSendEvidence((current) => ({ ...current, [profile.profile_id]: sendDebugEvidence(result) }));
      const submissionState = String(result?.submission_state || (result?.network_acknowledged ? "submitted" : "uncertain"));
      const generationState = String(result?.generation_state || result?.network_state || "idle");
      const resolvedConversationId = String(result?.conversation_id || conversationId);
      if (submissionState === "failed") {
        throw new Error(String(result?.error || "ChatGPT không chuẩn bị được tin nhắn để gửi."));
      }
      if (submissionState === "uncertain") {
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          const previousMessages = previous.conversationId === conversationId && Array.isArray(previous.messages) ? previous.messages : [];
          const messages = text
            ? previousMessages.map((message) => message?.role === "user" && message?.pending && message?.text === text ? { ...message, pending: false, uncertain: true, submissionState: "uncertain" } : message)
            : previousMessages;
          return {
            ...current,
            [profile.profile_id]: {
              ...previous,
              visible: true,
              loading: false,
              error: "",
              conversationId,
              messages,
              submissionState: "uncertain",
              sendUncertain: true
            }
          };
        });
        const technicalReason = String(result?.error || "Chưa thấy network ACK.").replace(/^SEND_UNCERTAIN:\s*/i, "");
        const submitPath = String(result?.submitted_by || result?.submit_path || "pre-submit");
        const generationEndpoint = String(result?.network_generation_endpoint || "");
        const uncertainMessage = `Chưa xác định được tin nhắn đã gửi hay chưa. Path: ${submitPath}.${generationEndpoint ? ` Endpoint: ${generationEndpoint}.` : ""} ${technicalReason}`;
        logRendererDiagnostic(api, "warn", "network", uncertainMessage, { action: "send-uncertain", profile_id: profile.profile_id, conversation_id: conversationId, submission_state: submissionState, submitted_by: submitPath, generation_endpoint: generationEndpoint });
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: uncertainMessage }));
        restoreSubmittedInputs();
        notify("Trạng thái gửi chưa chắc chắn · CodexPro không tự gửi lại");
        window.setTimeout(() => void refresh(false), 500);
        return false;
      }
      if (newChat && resolvedConversationId && resolvedConversationId !== NEW_CHAT_TARGET) {
        setRequestTargets((current) => ({ ...current, [profile.profile_id]: resolvedConversationId }));
      }
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        const previousMessages = materializeTranscriptMessages(previous, resolvedConversationId);
        const matchingPendingIndex = text ? previousMessages.findIndex((message) => message?.role === "user" && message?.pending && message?.text === text) : -1;
        let optimisticMessages = previousMessages;
        if (text && matchingPendingIndex >= 0) {
          optimisticMessages = previousMessages.map((message, index) => index === matchingPendingIndex ? { ...message, pending: false, uncertain: false, submissionState: "submitted" } : message);
        } else if (text) {
          optimisticMessages = trimRecentTranscriptMessages([...previousMessages, { id: `optimistic-user-${Date.now()}`, role: "user", text, pending: false, uncertain: false, submissionState: "submitted", createdAt: new Date().toISOString() }]);
        }
        return {
          ...current,
          [profile.profile_id]: {
            ...previous,
            visible: true,
            loading: generationState === "generating",
            error: "",
            conversationId: resolvedConversationId,
            messages: optimisticMessages,
            submissionState: "submitted",
            sendUncertain: false,
            networkState: generationState,
            networkError: String(result?.network_error || previous.networkError || ""),
            networkStatusCode: Number(result?.network_status_code) || Number(previous.networkStatusCode) || 0,
            repoTaskId: String(result?.repo_task_id || ""),
            repoTaskDispatchedAt: String(result?.repo_task_dispatched_at || ""),
            repoTaskScope: String(result?.repo_task_scope || (allAllowedScope ? "all_allowed" : "workspace")),
            repoTaskRetryCount: Number(result?.repo_task_retry_count) || 0,
            repoTaskRolloverCount: Number(result?.repo_task_rollover_count) || 0,
            repoTaskStatus: "waiting",
            repoTaskVerified: false,
            repoTaskRequest: { text, attachments, projectRoot, scope: allAllowedScope ? "all_allowed" : "workspace" }
          }
        };
      });
      if (generationState === "failed") {
        logRendererDiagnostic(api, "error", "network", `AI gặp lỗi network${result?.network_error ? `: ${result.network_error}` : ""}`, { action: "generation-failed", profile_id: profile.profile_id, conversation_id: resolvedConversationId, network_status_code: result?.network_status_code, network_error: result?.network_error });
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: `Tin nhắn đã gửi nhưng AI gặp lỗi network${result?.network_error ? `: ${result.network_error}` : ""}.` }));
        notify("Tin nhắn đã gửi · AI gặp lỗi network");
      } else {
        notify(newChat ? "Đã tạo chat mới và gửi tin nhắn đầu tiên" : `Đã gửi${result.attachment_count ? ` ${result.attachment_count} file` : ""} vào ${result.title || profile.active_chat_title || profile.label}`);
      }
      window.setTimeout(() => void refresh(false), 500);
      return true;
    } catch (err) {
      const message = err?.message || String(err);
      logRendererDiagnostic(api, "error", "chat", `Gửi yêu cầu thất bại: ${message}`, { action: "send-request", profile_id: profile.profile_id, conversation_id: conversationId, project_root: projectRoot, error: err });
      setRequestSendEvidence((current) => ({ ...current, [profile.profile_id]: sendDebugEvidence({}, err) }));
      const conversationLimitReached = !newChat && message.includes("CONVERSATION_LIMIT_REACHED:");
      if (conversationLimitReached) {
        const previous = requestResponses[profile.profile_id] || {};
        const cleanMessages = Array.isArray(previous.messages) ? previous.messages.filter((item) => !item?.pending) : [];
        const rolloverMessages = text ? trimRecentTranscriptMessages([...cleanMessages, { id: `rollover-user-${Date.now()}`, role: "user", text, submissionState: "submitted", createdAt: new Date().toISOString() }]) : trimRecentTranscriptMessages(cleanMessages);
        const newConversationId = await rolloverFullConversation(profile, conversationId, {
          ...previous,
          title: conversations.find((chat) => chat.id === conversationId)?.title || profile.active_chat_title || "",
          messages: rolloverMessages,
          conversation_limit_reached: true,
          conversation_limit_message: message.replace(/^.*CONVERSATION_LIMIT_REACHED:\s*/s, "").trim() || "ChatGPT báo đoạn chat đã đạt giới hạn độ dài.",
          projectRoot,
          rollover_attachments: attachments
        });
        if (newConversationId) {
          return true;
        }
      }
      setRequestFiles((current) => {
        if (!attachments.length || (current[profile.profile_id] || []).length) return current;
        return { ...current, [profile.profile_id]: attachments };
      });
      if (!newChat && text) {
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          const messages = Array.isArray(previous.messages) ? previous.messages.filter((item) => !(item?.role === "user" && item?.pending && item?.text === text)) : [];
          return { ...current, [profile.profile_id]: { ...previous, loading: false, messages } };
        });
      }
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: conversationLimitReached ? "Chat đã đầy và chưa chuyển được sang chat mới." : message }));
      if (/heartbeat|offline|did not reconnect|không còn được CodexPro nhận diện/i.test(message)) {
        window.setTimeout(() => void refreshStatus(), 0);
      }
      return false;
    } finally {
      setBusy("");
    }
  }

  async function rolloverFullConversation(profile, conversationId, result) {
    const profileId = profile.profile_id;
    const key = `${profileId}:${conversationId}`;
    const previousAttempt = conversationRollovers.current.get(key);
    if (previousAttempt?.status === "creating" || previousAttempt?.status === "done") return previousAttempt?.conversationId || null;
    if (previousAttempt?.status === "failed" && Date.now() - Number(previousAttempt.at || 0) < 10000) return null;

    conversationRollovers.current.set(key, { status: "creating", at: Date.now() });
    setRequestResponses((current) => {
      const previous = current[profileId] || {};
      if (previous.conversationId !== conversationId) return current;
      return {
        ...current,
        [profileId]: {
          ...previous,
          conversationLimitReached: true,
          conversationLimitMessage: result?.conversation_limit_message || "ChatGPT báo đoạn chat đã đạt giới hạn độ dài.",
          rolloverStatus: "creating",
          rolloverNotice: "Đoạn chat đã đầy. CodexPro đang tự tạo chat mới và chuyển bối cảnh gần nhất để bạn tiếp tục dự án."
        }
      };
    });

    try {
      const handoffText = buildConversationRolloverPrompt(result);
      const rolloverProjectRoot = result?.projectRoot || projectRootForProfile(profile);
      const rolloverAllAllowed = result?.repo_task_scope === "all_allowed" || result?.repoTaskScope === "all_allowed" || rolloverProjectRoot === ALL_ALLOWED_WORKSPACES;
      const created = await api.sendProfileRequest({
        profileId,
        conversationId: "",
        newChat: true,
        scope: rolloverAllAllowed ? "all_allowed" : "workspace",
        projectRoot: rolloverAllAllowed ? "" : rolloverProjectRoot,
        workspaceCandidates: rolloverAllAllowed ? projects.map((project) => project.root) : [],
        text: handoffText,
        attachments: Array.isArray(result?.rollover_attachments) ? result.rollover_attachments : []
      });
      const newConversationId = String(created?.conversation_id || "").trim();
      if (!/^[A-Za-z0-9-]{8,160}$/.test(newConversationId)) throw new Error("ChatGPT chưa trả conversation id cho chat tiếp nối.");

      conversationRollovers.current.set(key, { status: "done", at: Date.now(), conversationId: newConversationId });
      requestTargetsRef.current = { ...requestTargetsRef.current, [profileId]: newConversationId };
      setRequestTargets((current) => ({ ...current, [profileId]: newConversationId }));
      setChatProfileId(profileId);
      setRenameChat(null);
      setRequestSendErrors((current) => ({ ...current, [profileId]: "" }));
      setRequestResponses((current) => ({
        ...current,
        [profileId]: {
          visible: true,
          loading: true,
          error: "",
          conversationId: newConversationId,
          text: "",
          messages: [],
          busy: true,
          conversationLimitReached: false,
          rolloverStatus: "done",
          rolloverFromConversationId: conversationId,
          rolloverNotice: "Chat cũ đã đạt giới hạn. CodexPro đã tự tạo chat mới và chuyển bối cảnh gần nhất. Bạn có thể tiếp tục dự án ngay tại đây."
        }
      }));
      notify("Chat cũ đã đầy · CodexPro đã tự tạo chat mới để tiếp tục dự án");
      window.setTimeout(() => void refresh(false), 500);
      return newConversationId;
    } catch (err) {
      const message = err?.message || String(err);
      logRendererDiagnostic(api, "error", "chat", `Không tạo được chat tiếp nối: ${message}`, { action: "conversation-rollover", profile_id: profileId, conversation_id: conversationId, error: err });
      conversationRollovers.current.set(key, { status: "failed", at: Date.now() });
      setRequestResponses((current) => {
        const previous = current[profileId] || {};
        if (previous.conversationId !== conversationId) return current;
        return {
          ...current,
          [profileId]: {
            ...previous,
            loading: false,
            rolloverStatus: "failed",
            rolloverNotice: "ChatGPT đã báo đoạn chat này đạt giới hạn nhưng CodexPro chưa tạo được chat mới tự động.",
            error: `Không tạo được chat tiếp nối: ${message}`
          }
        };
      });
      setRequestSendErrors((current) => ({ ...current, [profileId]: `Chat đã đầy. Không tạo được chat mới tự động: ${message}` }));
      return null;
    }
  }

  async function verifyRepoTaskUse(profile, conversationId, response, networkCompletedAt) {
    const taskId = String(response?.repoTaskId || "");
    if (!taskId || response?.conversationId !== conversationId) return;
    const taskDispatchedAt = String(response?.repoTaskDispatchedAt || "");
    const verificationKey = `${taskId}:${taskDispatchedAt}:${networkCompletedAt}`;
    const verificationState = repoTaskVerificationReads.current.get(verificationKey);
    if (verificationState === "running" || verificationState === "done" || Number(verificationState) > Date.now()) return;
    repoTaskVerificationReads.current.set(verificationKey, "running");
    setRequestResponses((current) => {
      const previous = current[profile.profile_id] || {};
      return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "checking" } } : current;
    });
    try {
      const proof = await api.getRepoTaskStatus({ taskId, profileId: profile.profile_id, conversationId });
      if (proof?.verified) {
        repoTaskVerificationReads.current.set(verificationKey, "done");
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskScope: String(proof?.scope || previous.repoTaskScope || "workspace"), repoTaskStatus: "verified", repoTaskVerified: true, repoTaskProof: proof } } : current;
        });
        return;
      }
      const retryCount = Number(response?.repoTaskRetryCount) || 0;
      const rolloverCount = Number(response?.repoTaskRolloverCount) || 0;
      const original = response?.repoTaskRequest;
      const originalScope = original?.scope === "all_allowed" || original?.projectRoot === ALL_ALLOWED_WORKSPACES ? "all_allowed" : "workspace";
      if (retryCount >= 1 || !original?.projectRoot) {
        if (retryCount >= 1 && rolloverCount < 1 && original?.projectRoot) {
          setRequestResponses((current) => {
            const previous = current[profile.profile_id] || {};
            return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "rolling-over", loading: true } } : current;
          });
          notify("Chat cũ thiếu task title 2 lần · đang tạo chat mới");
          const created = await api.sendProfileRequest({
            profileId: profile.profile_id,
            conversationId: "",
            newChat: true,
            scope: originalScope,
            projectRoot: originalScope === "all_allowed" ? "" : original.projectRoot,
            workspaceCandidates: originalScope === "all_allowed" ? projects.map((project) => project.root) : [],
            text: original.text,
            attachments: Array.isArray(original.attachments) ? original.attachments : [],
            toolRetry: false,
            toolRolloverCount: rolloverCount + 1,
            previousTaskId: taskId
          });
          if (String(created?.submission_state || "") === "uncertain") throw new Error("Chat mới có trạng thái gửi không chắc chắn; không tự gửi thêm để tránh duplicate.");
          if (String(created?.repo_task_id || "") !== taskId) throw new Error("Manager đã đổi Task ID khi tạo chat mới; đã dừng để tránh REPO_TASK_MISMATCH.");
          const newConversationId = String(created?.conversation_id || "").trim();
          if (!/^[A-Za-z0-9-]{8,160}$/.test(newConversationId)) throw new Error("ChatGPT chưa trả conversation id cho chat mới bắt buộc dùng CodexPro.");
          requestTargetsRef.current = { ...requestTargetsRef.current, [profile.profile_id]: newConversationId };
          setRequestTargets((current) => ({ ...current, [profile.profile_id]: newConversationId }));
          setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
          setRequestResponses((current) => ({
            ...current,
            [profile.profile_id]: {
              visible: true,
              loading: true,
              error: "",
              conversationId: newConversationId,
              messages: [],
              submissionState: "submitted",
              sendUncertain: false,
              networkState: String(created?.generation_state || created?.network_state || "generating"),
              repoTaskId: String(created?.repo_task_id || ""),
              repoTaskDispatchedAt: String(created?.repo_task_dispatched_at || ""),
              repoTaskScope: String(created?.repo_task_scope || originalScope),
              repoTaskRetryCount: 0,
              repoTaskRolloverCount: rolloverCount + 1,
              repoTaskStatus: "waiting",
              repoTaskVerified: false,
              repoTaskRequest: original
            }
          }));
          repoTaskVerificationReads.current.set(verificationKey, "done");
          logRendererDiagnostic(api, "warn", "tool", "ChatGPT thiếu task title; Manager đã tạo chat mới và giữ nguyên Task ID", { action: "repo-task-title-rollover", profile_id: profile.profile_id, previous_conversation_id: conversationId, conversation_id: newConversationId, previous_task_id: taskId, rollover_task_id: String(created?.repo_task_id || ""), task_id_reused: created?.repo_task_id_reused === true, repo_task_dispatched_at: String(created?.repo_task_dispatched_at || "") });
          notify("Đã tạo chat mới · @CodexPro được gọi lại đúng một lần");
          window.setTimeout(() => void refresh(false), 500);
          return;
        }
        const message = "ChatGPT đã trả lời nhưng không trả task title qua CodexPro sau 2 lần. Phản hồi này không được công nhận.";
        logRendererDiagnostic(api, "error", "tool", message, { action: "repo-task-title-missing", profile_id: profile.profile_id, conversation_id: conversationId, task_id: taskId, retry_count: retryCount, rollover_count: rolloverCount, proof });
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "failed", repoTaskVerified: false } } : current;
        });
        repoTaskVerificationReads.current.set(verificationKey, "done");
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: message }));
        notify("ChatGPT thiếu task title · đã chặn phản hồi");
        return;
      }
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "retrying", loading: true } } : current;
      });
      const retried = await api.sendProfileRequest({
        profileId: profile.profile_id,
        conversationId,
        newChat: false,
        scope: originalScope,
        projectRoot: originalScope === "all_allowed" ? "" : original.projectRoot,
        workspaceCandidates: originalScope === "all_allowed" ? projects.map((project) => project.root) : [],
        text: original.text,
        attachments: Array.isArray(original.attachments) ? original.attachments : [],
        toolRetry: true,
        toolRolloverCount: rolloverCount,
        previousTaskId: taskId
      });
      if (String(retried?.submission_state || "") === "uncertain") throw new Error("Lần bắt buộc gọi CodexPro có trạng thái gửi không chắc chắn; không tự gửi thêm để tránh duplicate.");
      if (String(retried?.repo_task_id || "") !== taskId) throw new Error("Manager đã đổi Task ID khi gửi lại; đã dừng để tránh REPO_TASK_MISMATCH.");
      repoTaskVerificationReads.current.set(verificationKey, "done");
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        return previous.repoTaskId === taskId ? {
          ...current,
          [profile.profile_id]: {
            ...previous,
            repoTaskId: String(retried?.repo_task_id || ""),
            repoTaskDispatchedAt: String(retried?.repo_task_dispatched_at || ""),
            repoTaskScope: String(retried?.repo_task_scope || originalScope),
            repoTaskRetryCount: 1,
            repoTaskRolloverCount: rolloverCount,
            repoTaskStatus: "waiting",
            repoTaskVerified: false,
            loading: true,
            networkState: String(retried?.generation_state || retried?.network_state || "generating")
          }
        } : current;
      });
      notify("ChatGPT chưa trả task title · đang tự gửi lại bắt buộc");
      logRendererDiagnostic(api, "warn", "tool", "ChatGPT thiếu task title; Manager đã gửi lại một lần và giữ nguyên Task ID", { action: "repo-task-title-retry", profile_id: profile.profile_id, conversation_id: conversationId, previous_task_id: taskId, retry_task_id: String(retried?.repo_task_id || ""), task_id_reused: retried?.repo_task_id_reused === true, repo_task_dispatched_at: String(retried?.repo_task_dispatched_at || "") });
      window.setTimeout(() => void refresh(false), 500);
    } catch (err) {
      const message = err?.message || String(err);
      if (isRetryableChatTurnBusyError(err)) {
        repoTaskVerificationReads.current.set(verificationKey, Date.now() + REPO_TASK_VERIFICATION_RETRY_MS);
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "waiting", loading: false } } : current;
        });
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
        window.setTimeout(() => void refresh(false), REPO_TASK_VERIFICATION_RETRY_MS + 50);
        return;
      }
      repoTaskVerificationReads.current.set(verificationKey, "done");
      logRendererDiagnostic(api, "error", "tool", `Không xác minh được tool call CodexPro: ${message}`, { action: "repo-task-verification", profile_id: profile.profile_id, conversation_id: conversationId, task_id: taskId, error: err });
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: `Không xác minh được tool call CodexPro: ${message}` }));
    }
  }

  async function loadResponse(profile, explicitConversationId, silent = false, readDom = false, recoverStaleDom = false, canonicalOnly = false) {
    const conversations = profileRequestChats(profile);
    const defaultTarget = conversations.find((chat) => chat.active)?.id ?? conversations[0]?.id;
    const conversationId = String(explicitConversationId || requestTargets[profile.profile_id] || defaultTarget || "");
    if (!conversationId || conversationId === NEW_CHAT_TARGET || responseFetches.current.has(profile.profile_id)) return null;
    responseFetches.current.add(profile.profile_id);
    if (!silent) {
      setRequestResponses((current) => ({ ...current, [profile.profile_id]: { ...(current[profile.profile_id] || {}), visible: true, loading: true, error: "", conversationId } }));
    }
    try {
      const result = await api.getProfileResponse({ profileId: profile.profile_id, conversationId, readDom, recoverStaleDom, canonicalOnly });
      const domAvailable = result.dom_available !== false;
      const canonicalAvailable = result.canonical_available === true;
      const contentAvailable = domAvailable || canonicalAvailable;
      const networkStreamPayloadAvailable = Boolean(result.network_stream_available && (result.text || result.messages?.length || result.network_stream_activity_text));
      const responseAudit = result.response_audit && typeof result.response_audit === "object" ? result.response_audit : null;
      const responseAuditFetchMode = canonicalOnly ? "canonical_only" : readDom ? (recoverStaleDom ? "dom_recovery" : "dom") : "network_only";
      const responseAuditKey = responseAudit ? JSON.stringify([responseAuditFetchMode, responseAudit]) : "";
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        const sameConversation = previous.conversationId === conversationId;
        const networkStreamCurrentGeneration = networkStreamPayloadAvailable && isNetworkStreamCurrentGeneration({
          networkStartedAt: result.network_last_started_at || previous.networkStartedAt,
          streamUpdatedAt: result.network_stream_updated_at
        });
        const nextNetworkState = String(result.network_state || previous.networkState || (result.busy ? "generating" : "idle"));
        const networkTerminal = isTerminalChatNetworkState(nextNetworkState);
        const networkStreamInProgress = Boolean(networkStreamCurrentGeneration && result.network_stream_in_progress);
        const networkStreamAvailable = Boolean(networkStreamCurrentGeneration && (!networkTerminal || networkStreamInProgress));
        const domResponseVerified = Boolean(result.response_ready === true && domAvailable && result.dom_busy !== true && result.network_stream_in_progress !== true);
        const canonicalBusyFromSource = Object.prototype.hasOwnProperty.call(result, "canonical_busy")
          ? Boolean(result.canonical_busy)
          : Boolean(sameConversation && previous.canonicalBusy);
        const canonicalBusy = domResponseVerified ? false : canonicalBusyFromSource;
        const incomingMessages = Array.isArray(result.messages)
          ? trimRecentTranscriptMessages(result.messages.map((message, index) => ({
              id: String(message?.id || `${message?.role || "message"}-${index}`),
              role: message?.role === "user" ? "user" : "assistant",
              text: message?.role === "user" ? visibleUserMessageText(message?.text) : String(message?.text || ""),
              images: message?.role === "assistant" && Array.isArray(message?.images) ? message.images.slice(0, 4).map((image, imageIndex) => ({ id: String(image?.id || `${message?.id || "assistant"}-image-${imageIndex}`), name: String(image?.name || "Ảnh tạo bởi ChatGPT"), alt: String(image?.alt || "Ảnh tạo bởi ChatGPT"), mimeType: String(image?.mime_type || image?.mimeType || "image/jpeg"), width: Number(image?.width) || 0, height: Number(image?.height) || 0, sourceWidth: Number(image?.source_width) || Number(image?.sourceWidth) || 0, sourceHeight: Number(image?.source_height) || Number(image?.sourceHeight) || 0, size: Number(image?.size) || 0, dataUrl: String(image?.data_url || image?.dataUrl || "") })).filter((image) => image.dataUrl.startsWith("data:image/")) : [],
              truncated: Boolean(message?.truncated),
              provisional: message?.role === "assistant" && (message?.provisional === true || message?.end_turn === false),
              endTurn: message?.role === "assistant" ? (message?.end_turn === true ? true : message?.end_turn === false ? false : null) : null
            })).filter((message) => message.text || message.images?.length))
          : [];
        let nextMessages = sameConversation ? materializeTranscriptMessages(previous, conversationId) : [];
        if (contentAvailable) nextMessages = replaceCanonicalTranscript(nextMessages, incomingMessages);
        else if (networkStreamAvailable) nextMessages = mergeNetworkStreamTranscript(nextMessages, {
          conversationId,
          text: result.text,
            truncated: result.truncated
        });
        const terminalAwaitingFinal = Boolean(networkTerminal && !networkStreamInProgress && !canonicalBusy && result.response_ready !== true);
        if (terminalAwaitingFinal) {
          nextMessages = discardProvisionalAssistantAfterLatestUser(nextMessages, { includeUnverified: true });
        }
        const nextAssistantText = String([...nextMessages].reverse().find((message) => message?.role === "assistant")?.text || "").trim();
        return {
          ...current,
          [profile.profile_id]: {
            ...(sameConversation ? previous : {}),
            visible: true,
            loading: false,
            error: "",
            conversationId,
            text: terminalAwaitingFinal
              ? nextAssistantText
              : contentAvailable || networkStreamAvailable
                ? nextAssistantText || mergeProgressiveResponseText(sameConversation ? previous.text : "", result.text)
                : (sameConversation ? previous.text || "" : ""),
            messages: nextMessages,
            busy: Boolean(canonicalBusy || networkStreamInProgress || (!networkTerminal && result.busy)),
            canonicalBusy,
            truncated: contentAvailable || networkStreamAvailable ? Boolean(result.truncated) : Boolean(previous.truncated),
            incomplete: canonicalBusy ? true : networkTerminal ? false : contentAvailable || networkStreamAvailable ? Boolean(result.incomplete) : false,
            incompleteReason: canonicalBusy ? "canonical_generation_in_progress" : networkTerminal ? "" : contentAvailable || networkStreamAvailable ? (result.incomplete_reason || "") : "",
            conversationLimitReached: Boolean(previous.conversationLimitReached),
            conversationLimitMessage: previous.conversationLimitMessage || "",
            domAvailable,
            domSkipped: Boolean(result.dom_skipped),
            canonicalAvailable,
            networkStreamAvailable,
            networkStreamEndpoint: String(result.network_stream_endpoint || previous.networkStreamEndpoint || ""),
            networkStreamEventCount: Number(result.network_stream_event_count) || Number(previous.networkStreamEventCount) || 0,
            networkStreamActivityText: networkStreamAvailable ? String(result.network_stream_activity_text || "") : "",
            networkStreamInProgress,
            networkStreamUpdatedAt: String(result.network_stream_updated_at || previous.networkStreamUpdatedAt || ""),
            networkStreamError: String(result.network_stream_error || ""),
            contentNeedsRefresh: networkStreamInProgress
              ? false
              : result.dom_skipped
              ? String(result.network_state || previous.networkState || "") === "completed"
              : contentAvailable
                ? false
                : Boolean(previous.contentNeedsRefresh),
            domError: result.dom_error || "",
            networkState: nextNetworkState,
            networkSource: String(result.network_source || previous.networkSource || ""),
            networkStartedAt: result.network_last_started_at || previous.networkStartedAt || "",
            networkCompletedAt: result.network_last_completed_at || previous.networkCompletedAt || "",
            networkStatusCode: Number(result.network_status_code) || Number(previous.networkStatusCode) || 0,
            networkError: String(result.network_error || previous.networkError || ""),
            networkDurationMs: Number(result.network_duration_ms) || Number(previous.networkDurationMs) || 0,
            responseReady: Boolean(!canonicalBusy && result.response_ready && !networkStreamInProgress),
            responseSource: terminalAwaitingFinal ? "network_state" : String(result.response_source || previous.responseSource || ''),
            responseAudit,
            responseAuditFetchMode,
            responseAuditKey,
            messageCount: contentAvailable || networkStreamAvailable ? Number(result.message_count) || nextMessages.length : Number(previous.messageCount) || 0,
            awaitingAssistant: transcriptAwaitingAssistant(nextMessages),
            updatedAt: result.updated_at || new Date().toISOString()
          }
        };
      });
      return result;
    } catch (err) {
      const message = err?.message || String(err);
      logRendererDiagnostic(api, "error", "chat", `Đọc phản hồi thất bại: ${message}`, { action: "load-response", profile_id: profile.profile_id, conversation_id: conversationId, read_dom: readDom, recover_stale_dom: recoverStaleDom, canonical_only: canonicalOnly, silent, error: err });
      setRequestResponses((current) => ({ ...current, [profile.profile_id]: { ...(current[profile.profile_id] || {}), visible: true, loading: false, error: message, conversationId } }));
      if (!silent) setError(message);
      return null;
    } finally {
      responseFetches.current.delete(profile.profile_id);
    }
  }

  function addRequestAttachments(profileId, selected) {
    const current = requestFiles[profileId] || [];
    const merged = [...current, ...selected].filter((file, index, files) => files.findIndex((candidate) => candidate.path === file.path) === index);
    if (merged.length > 4) throw new Error("Mỗi yêu cầu được đính kèm tối đa 4 file.");
    if (merged.some((file) => file.size > 8 * 1024 * 1024)) throw new Error("Mỗi file được tối đa 8 MB.");
    if (merged.reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024) throw new Error("Tổng file đính kèm được tối đa 10 MB.");
    setRequestFiles((files) => ({ ...files, [profileId]: merged }));
  }

  async function chooseRequestAttachments(profileId) {
    setError("");
    try {
      const selected = await api.chooseRequestFiles();
      if (!selected.length) return;
      addRequestAttachments(profileId, selected);
    } catch (err) {
      const message = err?.message || String(err);
      logRendererDiagnostic(api, "error", "chat", `Xử lý file đính kèm thất bại: ${message}`, { action: "choose-request-attachments", profile_id: profileId, error: err });
      setError(message);
    }
  }

  async function openAttachmentPreview(file) {
    setAttachmentPreview({ loading: true, name: file.name, size: file.size, mimeType: file.mimeType, path: file.path });
    try {
      const preview = await api.getRequestFilePreview(file.path);
      setAttachmentPreview({ ...preview, loading: false, path: file.path });
    } catch (err) {
      logRendererDiagnostic(api, "error", "chat", `Đọc preview file thất bại: ${err?.message || String(err)}`, { action: "open-attachment-preview", file_name: file.name, file_size: file.size, mime_type: file.mimeType, error: err });
      setAttachmentPreview({
        loading: false,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        path: file.path,
        kind: "error",
        error: err?.message || String(err)
      });
    }
  }
  async function pasteRequestImage(profileId, event) {
    const items = Array.from(event.clipboardData?.items || []);
    const files = Array.from(event.clipboardData?.files || []);
    const hasImage = items.some((item) => String(item.type || "").startsWith("image/")) || files.some((file) => String(file.type || "").startsWith("image/"));
    if (!hasImage) return;
    event.preventDefault();
    setRequestSendErrors((current) => ({ ...current, [profileId]: "" }));
    try {
      const image = await api.captureClipboardImage();
      if (!image) throw new Error("Không đọc được ảnh từ clipboard.");
      addRequestAttachments(profileId, [image]);
      notify("Đã dán ảnh từ clipboard");
    } catch (err) {
      const message = err?.message || String(err);
      logRendererDiagnostic(api, "error", "chat", `Dán ảnh clipboard thất bại: ${message}`, { action: "paste-request-image", profile_id: profileId, error: err });
      setRequestSendErrors((current) => ({ ...current, [profileId]: message }));
    }
  }

  async function continueIncompleteResponse(profile, conversationId) {
    if (!conversationId || busy) return;
    setBusy(`continue:${profile.profile_id}`);
    setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
    try {
      const continueProjectRoot = projectRootForProfile(profile);
      const continueAllAllowed = continueProjectRoot === ALL_ALLOWED_WORKSPACES;
      await api.sendProfileRequest({
        profileId: profile.profile_id,
        conversationId,
        scope: continueAllAllowed ? "all_allowed" : "workspace",
        projectRoot: continueAllAllowed ? "" : continueProjectRoot,
        workspaceCandidates: continueAllAllowed ? projects.map((project) => project.root) : [],
        text: "Tiếp tục từ đúng chỗ phản hồi vừa bị ngắt. Không lặp lại phần trước; hoàn thành câu trả lời còn dang dở.",
        attachments: []
      });
      setRequestResponses((current) => ({ ...current, [profile.profile_id]: { ...(current[profile.profile_id] || {}), loading: true, incomplete: false } }));
      notify("Đã yêu cầu ChatGPT tiếp tục phần bị ngắt");
      window.setTimeout(() => void refresh(false), 500);
    } catch (err) {
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: err?.message || String(err) }));
    } finally {
      setBusy("");
    }
  }

  function renderChatModal() {
    const profile = (status?.browserProfiles || []).find((item) => item.profile_id === chatProfileId);
    if (!profile) return null;
    const conversations = profileRequestChats(profile);
    const workspaceProjects = projects;
    const selectedProjectRoot = projectRootForProfile(profile);
    const selectedTarget = String(requestTargets[profile.profile_id] || conversations.find((chat) => chat.active)?.id || conversations[0]?.id || NEW_CHAT_TARGET);
    const isNewChat = selectedTarget === NEW_CHAT_TARGET;
    const sending = busy === `request:${profile.profile_id}`;
    const initialDraft = requestDraftsRef.current[profile.profile_id] || "";
    const attachments = requestFiles[profile.profile_id] || [];
    const response = requestResponses[profile.profile_id];
    const sendError = requestSendErrors[profile.profile_id] || "";
    const sendEvidence = requestSendEvidence[profile.profile_id] || null;
    const responseCurrent = response?.conversationId === selectedTarget;
    const clearedKey = `${profile.profile_id}:${selectedTarget}`;
    const selectedResponseText = responseSelection.key === clearedKey ? responseSelection.text : "";
    const responseCleared = Boolean(clearedResponseTargets[clearedKey]);
    const responseMessages = responseCurrent && Array.isArray(response?.messages) ? response.messages : [];
    const compactResponseMessages = compactToolActivityMessages(responseMessages);
    const liveNetworkToolActivity = responseCurrent && response?.networkStreamInProgress ? String(response?.networkStreamActivityText || "").trim() : "";
    const displayResponseMessages = liveNetworkToolActivity
      ? [...compactResponseMessages.filter((message) => !message?.toolActivity), { id: "codexpro-live-tool-activity", role: "assistant", text: liveNetworkToolActivity, truncated: false, toolActivity: true }]
      : compactResponseMessages;
    const fallbackToolActivity = toolActivityFromText(response?.text);
    const fallbackResponseMessage = fallbackToolActivity
      ? { id: "codexpro-live-tool-activity", role: "assistant", text: fallbackToolActivity, truncated: false, toolActivity: true }
      : { id: "latest-assistant", role: "assistant", text: response?.text || "", truncated: response?.truncated };
    const hasResponseContent = !responseCleared && Boolean(fallbackResponseMessage.text || displayResponseMessages.length);

    const responseVerifiedComplete = Boolean(responseCurrent && response?.responseReady && hasResponseContent);
    const selectedTab = (profile.conversation_tabs || []).find((tab) => String(tab.url || "").includes(`/c/${selectedTarget}`));
    const selectedActivityText = String((responseCurrent && response?.networkStreamActivityText) || selectedTab?.activity_text || "").trim();
    const selectedNetworkState = String(selectedTab?.network_state || (responseCurrent ? response?.networkState : "") || (selectedTab?.busy ? "generating" : "idle"));
    const selectedNetworkCompleted = selectedNetworkState === "completed";
    const selectedNetworkFailed = selectedNetworkState === "failed";
    const selectedNetworkError = String((responseCurrent && response?.networkError) || selectedTab?.network_error || "");
    const selectedRecoveringNetworkAbort = isRecoverableAbortedChatNetworkFailure({
      networkState: selectedNetworkState,
      networkError: selectedNetworkError,
      networkCompletedAt: (responseCurrent && response?.networkCompletedAt) || selectedTab?.network_last_completed_at || "",
      responseReady: responseVerifiedComplete
    });
    const selectedBusy = selectedRecoveringNetworkAbort || shouldShowChatBusy({
      networkState: selectedNetworkState,
      tabBusy: selectedTab?.busy,
      responseCurrent,
      responseBusy: response?.busy,
      responseReady: responseVerifiedComplete,
      responseLoading: response?.loading,
      streamBusy: responseCurrent && response?.networkStreamInProgress,
      canonicalBusy: responseCurrent && response?.canonicalBusy
    });
    const selectedSettling = !(responseCurrent && response?.networkStreamInProgress) && shouldShowChatSettling({
      networkState: selectedNetworkState,
      tabSettling: selectedTab?.settling,
      responseCurrent,
      responseIncomplete: response?.incomplete
    });
    const responseTurnActive = selectedRecoveringNetworkAbort || Boolean(sending || selectedBusy || selectedSettling || (responseCurrent && (response?.busy || response?.loading)));
    const turnReady = !selectedRecoveringNetworkAbort && canAcceptNextChatMessage({
      networkState: selectedNetworkState,
      tabBusy: selectedTab?.busy,
      tabSettling: selectedTab?.settling,
      responseCurrent,
      responseBusy: response?.busy,
      responseReady: responseVerifiedComplete,
      responseLoading: response?.loading,
      responseIncomplete: response?.incomplete,
      canonicalBusy: responseCurrent && response?.canonicalBusy,
      streamBusy: responseCurrent && response?.networkStreamInProgress
    });
    const domUnavailable = Boolean(responseCurrent && response?.domAvailable === false && !response?.domSkipped);
    const contentNeedsRefresh = Boolean(responseCurrent && response?.contentNeedsRefresh);
    const rolloverCreating = Boolean(responseCurrent && response?.rolloverStatus === "creating");
    const otherBusyTab = (profile.conversation_tabs || []).some((tab) => (!selectedTab || tab.id !== selectedTab.id) && (tab?.busy || tab?.settling || String(tab?.network_state || "") === "generating"));
    const selectedResponseClearsProfileBusy = Boolean(responseVerifiedComplete && !selectedBusy && !selectedSettling && !otherBusyTab);
    const canSendBase = !busy && profile.connected && Boolean(selectedProjectRoot) && (isNewChat || turnReady) && !rolloverCreating && (isNewChat || conversations.length > 0);
    const working = profile.connected && ((profile.activity === "working" && !selectedResponseClearsProfileBusy) || selectedBusy || selectedSettling || rolloverCreating);
    const workerState = !profile.connected ? "hung" : working ? "working" : "idle";
    const responseHeadline = responseCleared
      ? "Chat đã được dọn"
      : isNewChat
      ? "Chat mới"
      : selectedRecoveringNetworkAbort
        ? "AI vẫn đang xử lý · đang xác minh sau khi transport bị hủy"
        : selectedBusy || selectedSettling
        ? "CodexPro đang xử lý…"
        : selectedNetworkFailed && responseVerifiedComplete
          ? "AI đã phản hồi xong · canonical xác nhận"
          : selectedNetworkFailed
            ? "Request AI kết thúc với lỗi network"
            : selectedNetworkCompleted && domUnavailable
            ? "AI đã phản hồi xong · Chrome UI đang treo"
            : selectedNetworkCompleted && contentNeedsRefresh
              ? "AI đã phản hồi xong · nội dung chưa đọc"
              : selectedNetworkCompleted
                ? "AI đã phản hồi xong · network xác nhận"
              : responseCurrent && response?.incomplete
                ? "Phản hồi có vẻ bị ngắt"
                : "Chờ tín hiệu network";

    return (
      <div className="modal-backdrop chat-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setChatProfileId("")}>
        <div className="modal chat-modal" ref={chatModalRef}>
          <div className="modal-head chat-modal-head">
            <div className="chat-modal-profile">
              <WorkerIcon state={workerState} customImages={managerSettings.workerImageDataUrls} />
              <div>
                <p className="eyebrow">CHATGPT · {profile.label}</p>
                <div className="profile-title"><strong>{profile.email || profile.label}</strong>{selectedSettling ? <span className="badge profile-settling">ĐANG HOÀN TẤT</span> : working ? <WorkingBadge /> : profile.connected ? <span className="badge connected">ĐANG RẢNH</span> : <span className="badge profile-hung">MẤT KẾT NỐI</span>}</div>
                <code>{profile.profile_id}</code>
              </div>
            </div>
            <button type="button" aria-label="Đóng chat" onClick={() => setChatProfileId("")}><span aria-hidden="true">×</span></button>
          </div>

          <article className={`request-card chat-popup-card ${profile.connected ? "is-online" : "is-offline"}`}>
            <label className="request-label">Chọn repo và đường dẫn</label>
            <ProjectDropdown value={selectedProjectRoot} projects={workspaceProjects} onChange={(root) => changeProjectForProfile(profile, root)} disabled={!profile.connected || sending || (!isNewChat && !turnReady) || rolloverCreating} />
            {!workspaceProjects.length && selectedProjectRoot !== ALL_ALLOWED_WORKSPACES && <div className="request-send-error">Chưa có workspace đã lưu. Chọn “Tất cả vùng được cấp quyền” để CodexPro tự tìm.</div>}
            <label className="request-label">Tin nhắn gần nhất</label>
            <div className={`chat-response is-inline ${sending || selectedBusy ? "is-streaming" : ""} ${responseCurrent && response?.incomplete ? "is-incomplete" : ""}`} ref={chatResponseRef} data-layout-conversation-id={selectedTarget} data-layout-sending={sending ? "1" : "0"} data-layout-busy={selectedBusy ? "1" : "0"} data-layout-settling={selectedSettling ? "1" : "0"} data-layout-stream={response?.networkStreamInProgress ? "1" : "0"} data-layout-has-content={hasResponseContent ? "1" : "0"} data-layout-network-state={selectedNetworkState} data-layout-message-count={displayResponseMessages.length}>
              <div className="chat-response-head">
                <div><span className="response-status-dot" /><strong title={responseHeadline}>{responseHeadline}</strong>{sending && <span className="chat-response-send-state"><span>Đang gửi tin nhắn</span><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span></span>}{!sending && !isNewChat && responseCurrent && response?.updatedAt && <small>{new Date(response.updatedAt).toLocaleTimeString("vi-VN")}</small>}</div>
                <div className="response-head-actions">
                  {responseCurrent && !responseCleared && !isNewChat && !selectedBusy && (contentNeedsRefresh || domUnavailable) && <button type="button" onClick={() => void loadResponse(profile, selectedTarget, false, true)} disabled={Boolean(busy)}>Đọc nội dung</button>}
                  {responseCurrent && !responseCleared && response?.incomplete && !selectedBusy && <button type="button" className="continue-response" onClick={() => void continueIncompleteResponse(profile, selectedTarget)} disabled={Boolean(busy)}>Tiếp tục</button>}
                  {selectedResponseText && <button type="button" onClick={async () => { await api.copyText(selectedResponseText); notify("Đã copy đoạn được chọn"); }}>Copy đoạn</button>}
                  {responseCurrent && response?.text && !responseCleared && <button type="button" onClick={async () => { await api.copyText(response.text); notify("Đã copy toàn bộ phản hồi mới nhất"); }}>Copy hết</button>}
                  {responseCurrent && hasResponseContent && !selectedBusy && <button type="button" onClick={() => { setClearedResponseTargets((current) => ({ ...current, [clearedKey]: true })); notify("Đã dọn chat trong Manager"); }}>Clear</button>}
                </div>
              </div>
              {responseCurrent && !responseCleared && response?.rolloverNotice && (
                <div className={`conversation-rollover-notice is-${response.rolloverStatus || "done"}`}>
                  <strong>{response.rolloverStatus === "creating" ? "Chat đã đầy · đang chuyển sang chat mới" : response.rolloverStatus === "failed" ? "Chat đã đầy · chuyển chat tự động thất bại" : "Đã chuyển sang chat mới"}</strong>
                  <span>{response.rolloverNotice}</span>
                </div>
              )}
              {responseCurrent && !responseCleared && response?.repoTaskId && (response.repoTaskStatus === "verified" || response.repoTaskStatus === "failed") && (
                <div className={`network-response-notice is-${response.repoTaskStatus === "verified" ? "completed" : response.repoTaskStatus === "failed" ? "failed" : "generating"}`}>
                  <strong>{response.repoTaskStatus === "verified" ? (response.repoTaskProof?.task_kind === "code" ? "CodexPro: Rules + CodexGraph đã xác minh" : "CodexPro: đã ghi nhận task title") : response.repoTaskStatus === "retrying" ? "CodexPro: ChatGPT thiếu title · đang gửi lại" : response.repoTaskStatus === "failed" ? "CodexPro: phản hồi bị chặn" : "CodexPro: đang chờ task title"}</strong>
                  <span>{response.repoTaskStatus === "verified" ? repoTaskEvidenceSummary(response.repoTaskProof) : response.repoTaskStatus === "failed" ? "ChatGPT không trả task title qua CodexPro nên Manager không công nhận phản hồi này." : "Mọi task phải có title; chỉ task CODE mới tải Rules và CodexGraph."}</span>
                </div>
              )}
              {responseCurrent && !responseCleared && !isNewChat && !responseVerifiedComplete && (selectedNetworkFailed || selectedRecoveringNetworkAbort) && (
                <div className={`network-response-notice is-${selectedNetworkState}`}>
                  <strong>{selectedRecoveringNetworkAbort ? "Network: transport cũ bị hủy · đang xác minh" : selectedBusy ? "Network: AI đang xử lý" : "Network: request thất bại"}</strong>
                  <span>{selectedRecoveringNetworkAbort ? "Chrome đã hủy transport cũ nhưng ChatGPT có thể vẫn tiếp tục ở backend. CodexPro đang kiểm tra transcript canonical trước khi kết luận lỗi." : selectedNetworkFailed ? (response?.networkError || selectedTab?.network_error || `HTTP ${response?.networkStatusCode || selectedTab?.network_status_code || "error"}`) : "Theo dõi trực tiếp vòng đời request của ChatGPT."}</span>
                </div>
              )}
              {/* Trạng thái gửi nằm ngay trên thanh trạng thái phản hồi. */}
              {responseCleared ? <div className="response-empty">Chat đã được dọn.</div> : !profile.connected ? <div className="response-empty">Extension đang mất heartbeat nên chưa thể cập nhật.</div> : isNewChat ? <div className="response-empty">Chat mới chưa được tạo trên ChatGPT. Gửi tin nhắn đầu tiên để tạo conversation mới trong nền.</div> : selectedRecoveringNetworkAbort && !hasResponseContent ? <div className="response-empty"><span className="typing-dots"><i /><i /><i /></span> Đang xác minh phản hồi sau khi Chrome hủy transport cũ…</div> : selectedNetworkFailed && !hasResponseContent ? <div className="response-error">Request AI đã kết thúc với lỗi network. CodexPro không cần DOM để phát hiện lỗi này.</div> : selectedNetworkCompleted && domUnavailable && !hasResponseContent ? <div className="response-empty network-complete-empty"><strong>AI đã phản hồi xong.</strong><span>Chrome renderer không phản hồi nên chưa đọc được nội dung từ giao diện. Trạng thái hoàn tất được xác nhận trực tiếp từ network.</span></div> : selectedNetworkCompleted && !hasResponseContent ? <div className="response-empty network-complete-empty"><strong>AI đã phản hồi xong.</strong><span>{contentNeedsRefresh ? "CodexPro chưa đụng DOM để đọc nội dung. Bấm “Đọc nội dung” khi bạn cần xem transcript." : "Network đã xác nhận hoàn tất. Bấm “Đọc nội dung” nếu bạn cần tải transcript từ giao diện."}</span></div> : !responseCurrent || response?.loading && !hasResponseContent ? <div className="response-empty"><span className="typing-dots"><i /><i /><i /></span> Đang chờ AI hoàn tất qua network…</div> : response?.error ? <div className="response-error">{response.error}</div> : hasResponseContent ? (
                <div className="latest-response chat-transcript" ref={(element) => { if (element) responseBodyRefs.current.set(profile.profile_id, element); else responseBodyRefs.current.delete(profile.profile_id); }} onWheel={(event) => holdResponseAutoScroll(profile.profile_id, event.currentTarget, event.deltaY)} onTouchMove={(event) => holdResponseAutoScroll(profile.profile_id, event.currentTarget, -1)} onScroll={(event) => pauseResponseAutoScroll(profile.profile_id, event.currentTarget)}>
                  {(displayResponseMessages.length ? displayResponseMessages : [fallbackResponseMessage]).map((message, messageIndex, allMessages) => {
                    const isLastAssistant = message.role === "assistant" && !allMessages.slice(messageIndex + 1).some((candidate) => candidate.role === "assistant");
                    const responseSpaceClass = !isLastAssistant ? "" : responseTurnActive && !(response.networkStreamAvailable && hasResponseContent) ? "is-response-cage" : "is-response-runway";
                    if (message.toolActivity) {
                      return <div className="chat-transcript-message is-tool-activity" key={message.id}><div className="tool-activity-live"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span><span>{message.text}</span></div></div>;
                    }
                    return (
                      <div className={`chat-transcript-message is-${message.role} ${responseSpaceClass}`} key={message.id} data-audit-role={message.role} data-audit-fingerprint={responseAuditTextFingerprint(message.text)} data-audit-length={String(message.text || "").length}>
                        <div className="chat-message-avatar">{message.role === "user" ? "B" : "✦"}</div>
                        <div className="latest-response-content" onPointerUp={message.role === "assistant" ? (event) => captureResponseSelection(clearedKey, event.currentTarget) : undefined}>
                          <span className="chat-message-role">{message.role === "user" ? "Bạn" : "ChatGPT"}{message.pending ? " · đang gửi" : message.uncertain ? " · chưa xác định đã gửi" : ""}</span>
                          {message.role === "assistant" ? <>
                            {message.text && <React.Suspense fallback={<div className="chat-message-text response-rich-text response-rich-loading">{message.text}</div>}><ResponseText text={message.text} truncated={message.truncated} /></React.Suspense>}
                            {Boolean(message.images?.length) && <div className={`chat-message-images ${message.images.length === 1 ? "is-single" : "is-grid"}`}>{message.images.map((image, imageIndex) => <button type="button" className="chat-generated-image" key={image.id || `${message.id}-image-${imageIndex}`} title="Mở ảnh" aria-label={`Mở ${image.alt || image.name || "ảnh tạo bởi ChatGPT"}`} onClick={() => setAttachmentPreview({ loading: false, name: image.name || "Ảnh tạo bởi ChatGPT", size: Number(image.size) || 0, mimeType: image.mimeType || "image/jpeg", kind: "image", dataUrl: image.dataUrl, generated: true })}><img src={image.dataUrl} alt={image.alt || image.name || "Ảnh tạo bởi ChatGPT"} /></button>)}</div>}
                            {responseTurnActive && response.networkStreamAvailable && isLastAssistant && <span className="live-stream-tail" aria-label="ChatGPT đang tiếp tục phản hồi"><span className="typing-dots"><i /><i /><i /></span></span>}
                            {message.text && turnReady && (
                              <div className="chat-message-actions">
                                <button type="button" className="chat-message-copy" title="Copy response" aria-label="Copy phản hồi" onClick={async () => { await api.copyText(message.text); notify("Đã copy phản hồi"); }}>
                                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
                                </button>
                              </div>
                            )}
                          </> : <div className="chat-message-text user-message-text">{message.text}</div>}
                        </div>
                      </div>
                    );
                  })}
                  {responseTurnActive && !(response.networkStreamAvailable && hasResponseContent) && <div className="chat-transcript-message is-assistant is-typing is-response-runway"><div className="chat-message-avatar">✦</div><div className="latest-response-content"><span className="chat-message-role">ChatGPT</span><span className="thinking-state latest-response-typing"><span>Thinking</span><span className="typing-dots"><i /><i /><i /></span></span></div></div>}
                </div>
              ) : <div className="response-empty">Đoạn chat này chưa có tin nhắn.</div>}
            </div>

            <ChatRequestComposer
              profileId={profile.profile_id}
              initialDraft={initialDraft}
              draftResetVersion={requestDraftResetVersions[profile.profile_id] || 0}
              attachments={attachments}
              placeholder={rolloverCreating ? "Chat cũ đã đầy · đang tạo chat mới để tiếp tục dự án…" : "Nhập file hoặc tin nhắn"}
              disabled={!profile.connected || sending || (!isNewChat && !turnReady) || rolloverCreating}
              attachmentDisabled={!profile.connected || sending || rolloverCreating}
              canSendBase={canSendBase}
              sending={sending}
              rolloverCreating={rolloverCreating}
              selectedBusy={selectedBusy}
              selectedSettling={selectedSettling}
              isNewChat={isNewChat}
              sendError={sendError}
              sendEvidence={sendEvidence}
              canOpenChrome={!busy && profile.connected && !isNewChat && Boolean(profile.conversation_tabs?.length)}
              onPaste={(event) => void pasteRequestImage(profile.profile_id, event)}
              onChooseAttachments={() => void chooseRequestAttachments(profile.profile_id)}
              onOpenAttachmentPreview={(file) => openAttachmentPreview(file)}
              onRemoveAttachment={(filePath) => setRequestFiles((current) => ({ ...current, [profile.profile_id]: (current[profile.profile_id] || []).filter((item) => item.path !== filePath) }))}
              onClearSendError={() => setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }))}
              onDraftSnapshot={(nextDraft) => { requestDraftsRef.current[profile.profile_id] = nextDraft; }}
              onClose={() => setChatProfileId("")}
              onOpenChrome={() => openProfile(profile)}
              onSend={(nextDraft) => sendRequest(profile, nextDraft)}
            />
          </article>
        </div>
      </div>
    );
  }

  const selectedFont = FONT_OPTIONS.find((option) => option.value === managerSettings.fontFamily) || FONT_OPTIONS[0];
  const selectedHeadingFont = FONT_OPTIONS.find((option) => option.value === managerSettings.headingFontFamily);
  const selectedMonoFont = FONT_OPTIONS.find((option) => option.value === managerSettings.monoFontFamily);
  const appStyle = {
    "--chat-modal-width": `${managerSettings.chatWidth}px`,
    "--chat-response-height": `${managerSettings.chatHeight}px`,
    "--chat-response-runway-height": `${Math.max(108, Math.round((managerSettings.chatHeight - 45) / 2))}px`,
    "--app-font-family": selectedFont.css,
    "--heading-font-family": selectedHeadingFont?.css || selectedFont.css,
    "--mono-font-family": selectedMonoFont?.css || selectedFont.css,
    "--font-micro": `${Math.max(10, managerSettings.fontSize - 4)}px`,
    "--font-description": `${Math.max(11, managerSettings.fontSize - 2)}px`,
    "--font-body": `${managerSettings.fontSize}px`,
    "--font-control": `${managerSettings.fontSize}px`,
    "--font-title": `${managerSettings.fontSize + 3}px`,
    "--font-xs": `${Math.max(11, managerSettings.fontSize - 2)}px`,
    "--font-base": `${managerSettings.fontSize}px`,
    "--font-brand": `${managerSettings.fontSize + 3}px`,
    "--font-section": `${managerSettings.fontSize + 6}px`,
    "--font-page": `${managerSettings.fontSize + 14}px`
  };
  const workerSettingItems = [
    { state: "idle", title: "Đang rảnh", description: "Hiện khi profile online và đang chờ việc." },
    { state: "working", title: "Đang làm việc", description: "Hiện khi ChatGPT đang xử lý hoặc hoàn tất turn." },
    { state: "hung", title: "Mất kết nối", description: "Hiện khi extension/profile mất heartbeat." }
  ];
  const selectedWorkerPack = managerSettings.workerImagePacks.find((pack) => pack.id === managerSettings.selectedWorkerPackId) || null;
  const workerPackOptions = [
    { value: "default", label: "Bộ mặc định", hint: "Ảnh worker đi kèm CodexPro" },
    ...managerSettings.workerImagePacks.map((pack) => ({
      value: pack.id,
      label: pack.name,
      hint: `${Object.values(pack.imageDataUrls || {}).filter(Boolean).length}/3 ảnh đã tải lên`
    }))
  ];

  return (
    <div className="app-shell" style={appStyle}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">C</div>
          <div><strong>CodexPro</strong><span>Manager</span></div>
        </div>
        <nav>
          <button type="button" className={activePage === "overview" ? "active" : ""} onClick={() => setActivePage("overview")}><Icon>⌁</Icon>Tổng quan</button>
          <button type="button" className={activePage === "logs" ? "active" : ""} onClick={() => setActivePage("logs")}><Icon>≡</Icon>Nhật ký</button>
          <button type="button" className={activePage === "settings" ? "active" : ""} onClick={() => setActivePage("settings")}><Icon>⚙</Icon>Cài đặt</button>
        </nav>
        <div className="sidebar-foot">
          <span className="autostart"><Dot ok={status?.autoStart} />{status?.autoStart ? `Tự chạy cùng ${platform}` : "Autostart chưa bật"}</span>
          <small>CodexPro Manager {managerPackage.version}</small>
        </div>
      </aside>

      <main className={activePage === "settings" ? "page-settings" : activePage === "logs" ? "page-logs" : "page-overview"}>
        <header>
          <div>
            <p className="eyebrow">{activePage === "settings" ? "SETTINGS" : activePage === "logs" ? "DIAGNOSTIC LOGS" : `${platform.toUpperCase()} CONTROL CENTER`}</p>
            <h1>{activePage === "settings" ? "Cài đặt CodexPro" : activePage === "logs" ? "Nhật ký CodexPro" : "CodexPro của bạn"}</h1>
            <p className="subtitle">{activePage === "settings" ? "Quản lý kết nối MCP, popup chat, ảnh worker và font chữ theo thành phần." : activePage === "logs" ? "Theo dõi lỗi, cảnh báo và hoạt động MCP trong 24 giờ gần nhất." : "Một chỗ để xem server, profile và kiểm tra repo."}</p>
          </div>
          {activePage === "overview" && (
            <div className="header-server-actions">
              <div className="profile-count" aria-label={`${profileSummary.working} làm việc, ${profileSummary.idle} rảnh, ${profileSummary.hung} mất kết nối, ${profileSummary.missing} chưa cài`}>
                <ProfileSummaryItem state="working" count={profileSummary.working} label="làm việc" />
                <ProfileSummaryItem state="idle" count={profileSummary.idle} label="rảnh" />
                <ProfileSummaryItem state="hung" count={profileSummary.hung} label="mất kết nối" />
                <ProfileSummaryItem state="hung" count={profileSummary.missing} label="chưa cài" missing />
                {profileSummary.reload > 0 && <span className="profile-summary-update">{profileSummary.reload} cần update worker</span>}
                {profileSummary.deferredUpdate > 0 && <span className="profile-summary-update">{profileSummary.deferredUpdate} chờ rảnh để update</span>}
              </div>
              <button
                className={`button ${profileSummary.reload ? "primary" : "secondary"} reload-all`}
                onClick={() => setWorkerUpdateConfirmOpen(true)}
                disabled={Boolean(busy) || profileSummary.reload === 0}
                title={profileSummary.reload
                  ? `Chỉ update ${profileSummary.reload} worker đang rảnh lên ${WORKER_EXTENSION_VERSION}${profileSummary.deferredUpdate ? `; ${profileSummary.deferredUpdate} worker đang làm việc sẽ được bỏ qua` : ""}`
                  : profileSummary.deferredUpdate
                    ? `${profileSummary.deferredUpdate} worker cần update nhưng đang làm việc; chờ rảnh rồi update`
                    : `Tất cả profile đã dùng worker ${WORKER_EXTENSION_VERSION}`}
              >
                {busy === "reload-profiles" ? "Đang update worker…" : "Update worker extension"}
              </button>
              <button className="button primary" onClick={() => control("start")} disabled={Boolean(busy)}>
                {busy === "start" ? "Đang khởi động..." : "Khởi động"}
              </button>
              <button className="button secondary" onClick={() => control("restart")} disabled={Boolean(busy)}>
                {busy === "restart" ? "Đang restart..." : "Restart server"}
              </button>
            </div>
          )}
        </header>

        {error && <div className="alert"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}

        <div className="page-view" hidden={activePage !== "overview"}>
        <section id="overview">
          <div className="section-head"><div><p className="eyebrow">LIVE STATUS</p><h2>Trạng thái hệ thống</h2></div><span className="last-check">{status ? `Cập nhật ${new Date(status.checkedAt).toLocaleTimeString("vi-VN")}` : "Đang kiểm tra..."}</span></div>
          <div className="status-grid">
            <StatusCard label={platform === "Windows" ? "Scheduled Task" : "CodexPro Runtime"} ok={status?.task?.state === "Running"} value={status?.task?.state || "..."} detail={status?.task?.lastRunTime ? `Lần chạy: ${new Date(status.task.lastRunTime).toLocaleString("vi-VN")}` : platform === "Windows" ? "Windows Task Scheduler" : "Runtime native trên macOS"} />
            <StatusCard label="Local MCP" ok={status?.local?.ok} value={status?.local?.ok ? "Online" : "Offline"} detail={status?.local?.ok ? `127.0.0.1:${status.config.port} · ${status.local.latency} ms` : status?.local?.error || "Đang kiểm tra"} />
            <StatusCard label="Public tunnel" ok={status?.tunnel?.ok} value={status?.tunnel?.ok ? "Online" : "Offline"} detail={status?.tunnel?.ok ? `${status.config.hostname} · ${status.tunnel.latency} ms` : status?.tunnel?.error || status?.config?.hostname || "Chưa cấu hình"} />
            <StatusCard label="Processes" ok={status?.processes?.length > 0} value={`${status?.processes?.length ?? 0} tiến trình`} detail={status?.processes?.length ? status.processes.map((p) => `${p.name} ${p.pid}`).join(" · ") : "Không tìm thấy process"} />
          </div>
        </section>

        <section id="profiles">
          <div className="section-head">
            <div>
              <p className="eyebrow">CHROME PROFILE BRIDGE</p>
              <h2>Profile đã kết nối</h2>
              <p className="section-note">Mỗi profile có extension CodexPro sẽ tự xuất hiện tại đây. Chọn đúng profile để app tự thêm và test MCP.</p>
            </div>
          </div>
          <div className={`profile-list is-${managerSettings.profileLayout === "cards" ? "card" : "row"}-layout`}>
            {!status?.browserProfiles?.length && (
              <div className="empty">Chưa có Chrome profile nào kết nối. Hãy Load unpacked extension CodexPro trong profile cần dùng.</div>
            )}
            {[...(status?.browserProfiles || [])]
              .sort((left, right) => {
                const rank = (profile) => {
                  if (!profile.connected) return 3;
                  const tabs = Array.isArray(profile.conversation_tabs) ? profile.conversation_tabs : [];
                  const activeTab = tabs.find((tab) => tab.active) || tabs[0];
                  if (activeTab?.settling === true || profile.activity === "settling") return 1;
                  if (activeTab?.busy === false || (!activeTab && profile.activity === "idle")) return 0;
                  if (activeTab?.busy === true || profile.activity === "working") return 1;
                  return 2;
                };
                const rankDiff = rank(left) - rank(right);
                if (rankDiff) return rankDiff;
                return String(left.profile_id || "").localeCompare(String(right.profile_id || ""));
              })
              .map((profile) => {
              const ready = extensionReady(profile.extension_version);
              const profileBusy = busy === `profile:${profile.profile_id}`;
              const profileChecking = checkingProfiles.includes(profile.profile_id);
              const hung = !profile.connected;
              const settling = profile.connected && profile.activity === "settling";
              const working = profile.connected && profile.activity === "working";
              const profileTabs = Array.isArray(profile.conversation_tabs) ? profile.conversation_tabs : [];
              const liveTab = profileTabs.find((tab) => tab.active) || profileTabs.find((tab) => tab.busy || tab.settling) || profileTabs[0];
              const rendererUnresponsive = Boolean(profile.connected && liveTab?.renderer_unresponsive);
              const liveActivityText = working || settling ? String(liveTab?.activity_text || "").trim() : "";
              const connectorInstalled = Boolean(profile.connector_installed && profile.connector_profile_bound !== false);
              const connectorUpdateRequired = Boolean(profile.connector_update_required);
              const connectorMessage = profile.connector_message;
              const idle = profile.connected && profile.activity === "idle" && (connectorInstalled || !ready);
              const workerState = hung ? "hung" : working || settling ? "working" : "idle";
              const profileBorderState = profileCardBorderState({
                connected: profile.connected,
                working,
                settling,
                rendererUnresponsive,
                networkState: String(liveTab?.network_state || ""),
                rendererError: String(liveTab?.renderer_error || ""),
                connectionInterrupted: Boolean(liveTab?.connection_interrupted)
              });
              const chromeAction = profileChromeActionState({ profile, busy, rendererUnresponsive });
              const workspaceRoot = String(profile.current_workspace_root || "").trim();
              const directProject = workspaceRoot ? projects.find((project) => String(project.root || "").toLowerCase() === workspaceRoot.toLowerCase()) : null;
              const fallbackProject = profileRepoProject(profile, projects, profileRepoRoots[profile.profile_id]);
              const repoProject = directProject || fallbackProject;
              const repoLabel = String(profile.current_workspace_repo || repoProject?.githubRepo || (repoProject ? `Local · ${repoProject.name}` : "")).trim();
              const repoTitle = repoProject?.githubUrl || repoProject?.remoteUrl || workspaceRoot || repoProject?.root || "Worker chưa xác định được repo GitHub";
              const profileTaskLabel = String(profile.current_task_title || profileTaskLabels[profile.profile_id] || "").trim();
              return (
                <article className={`browser-profile ${profile.connected ? "is-online" : "is-offline"} is-${profileBorderState}`} key={profile.profile_id}>
                  <WorkerIcon state={workerState} customImages={managerSettings.workerImageDataUrls} />
                  <div className="profile-main">
                    <div className="profile-title">
                      <strong>{profile.email || profile.label}</strong>
                      {profile.headless && <span className="badge profile-headless">HEADLESS</span>}
                      {profile.active && <span className="badge">ACTIVE</span>}
                      {hung && <span className="badge profile-hung">MẤT KẾT NỐI</span>}
                      {settling && <span className="badge profile-settling">ĐANG HOÀN TẤT</span>}
                      {working && <WorkingBadge />}
                      {idle && <span className="badge connected">ĐANG RẢNH</span>}
                      {connectorUpdateRequired && <span className="badge profile-missing">CẦN CẬP NHẬT CONNECTOR</span>}
                      {!connectorInstalled && !connectorUpdateRequired && !profileChecking && !idle && !working && !settling && <span className="badge profile-missing">CHƯA CÓ CODEXPRO</span>}
                      <span
                        className={`active-repo-chip ${repoLabel ? "" : "is-empty"}`}
                        title={repoTitle}
                      >
                        {repoLabel || "Chưa xác định repo"}
                      </span>
                    </div>
                    <code>{profile.email ? profile.label : profile.profile_id}</code>
                    <div className="profile-meta">
                      <span><Dot ok={profile.connected} />{profile.connected ? "Extension online" : "Mất heartbeat extension"}</span>
                      <span>v{profile.extension_version || "cũ"}</span>
                      <span>{profile.tab_count} tab</span>
                      {connectorMessage && <span className={connectorInstalled ? "ready-text" : "profile-warning"}>{connectorMessage}</span>}
                    </div>
                    {profileTaskLabel && (
                      <div className="profile-task-summary" title={profileTaskLabel}>
                        <span>{working || settling ? "Task hi\u1ec7n t\u1ea1i" : "Task g\u1ea7n nh\u1ea5t"}</span>
                        <strong>{profileTaskLabel}</strong>
                      </div>
                    )}
                    {(working || settling) && <div className="profile-live-activity" role="status" aria-live="polite"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span><span>{liveActivityText || (settling ? "ChatGPT đang hoàn tất tác vụ" : "ChatGPT đang xử lý")}</span></div>}
                  </div>
                  <div className="profile-actions">
                    {!ready && <span className="update-needed">Có worker {WORKER_EXTENSION_VERSION} mới</span>}
                    {profileChecking && <span className="checking-profile">Đang kiểm tra ChatGPT…</span>}
                    <div className="profile-action-buttons">
                      <button
                        className="button primary profile-chat"
                        onClick={() => openChat(profile)}
                        disabled={!profile.connected || !connectorInstalled || !profileRequestChats(profile).length}
                      >
                        Chat
                      </button>
                      <button
                        className="button secondary open-profile"
                        onClick={() => rendererUnresponsive ? recoverProfileTab(profile) : openProfile(profile, { focusOnly: true })}
                        disabled={chromeAction.disabled}
                        title={chromeAction.title}
                      >
                        {busy === `recover-profile:${profile.profile_id}` ? "Đang khôi phục…" : busy === `open-profile:${profile.profile_id}` ? "Đang chuyển…" : chromeAction.label}
                      </button>
                    </div>
                    {connectorInstalled ? (
                      <span className="already-connected">✓ Đã thêm CodexPro</span>
                    ) : (
                      <button
                        className="button primary profile-setup"
                        onClick={() => setupProfile(profile)}
                        disabled={Boolean(busy) || profileChecking || !profile.connected || !ready}
                      >
                        {profileBusy ? (connectorUpdateRequired ? "Đang cập nhật + test…" : "Đang thêm + test…") : (connectorUpdateRequired ? "Cập nhật CodexPro" : "Thêm CodexPro")}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section id="projects">
          <div className="section-head">
            <div><p className="eyebrow">WORKSPACES</p><h2>Repo và dự án</h2><p className="section-note">Tự quét Git repo trong các thư mục đã cấp quyền, đồng thời ưu tiên repo ChatGPT đang dùng và repo đã ghim.</p></div>
            <button className="button secondary" onClick={addProject} disabled={Boolean(busy)}>+ Thêm dự án</button>
          </div>
          <div className="project-list">
            {projects.length === 0 && <div className="empty">Chưa có repo hoặc dự án nào đang được ChatGPT mở qua CodexPro.</div>}
            {visibleProjects.map((project) => (
              <article className="project" key={project.root}>
                <div className="repo-icon">{project.name.slice(0, 1).toUpperCase()}</div>
                <div className="project-main">
                  <div className="project-title"><strong>{project.name}</strong>{project.active ? <span className="badge">ĐANG CHẠY</span> : project.inUse ? <span className="badge">ĐANG CODE</span> : null}</div>
                  <code>{project.root}</code>
                  <div className="project-meta">
                    {project.repoFullName && <span>{project.repoFullName}</span>}
                    {formatRepoActivity(project) && <span className="recent-activity">{formatRepoActivity(project)}</span>}
                    <span>{project.source}</span>
                    {project.active && <span>{project.sessionCount} phiên MCP</span>}
                    <span>{project.isGit ? `nhánh ${project.branch}` : "thư mục dự án"}</span>
                    <span className={project.changes ? "changed" : "clean"}>{project.changes ? `${project.changes} thay đổi` : "sạch"}</span>
                    {project.lastSeenAt && <span>Hoạt động {new Date(project.lastSeenAt).toLocaleTimeString("vi-VN")}</span>}
                    {project.commit?.hash && <span>{project.commit.hash} · {project.commit.subject}</span>}
                  </div>
                </div>
                <div className="project-actions">
                  <button onClick={() => inspect(project)} disabled={Boolean(busy)}>{busy === project.root ? "Đang kiểm tra..." : "Kiểm tra qua MCP"}</button>
                  <button onClick={() => api.openFolder(project.root)}>Mở thư mục</button>
                  {!project.active && project.source === "Đã ghim" && <button className="remove" title="Bỏ khỏi danh sách" onClick={async () => setProjects(await api.removeProject(project.root))}>×</button>}
                </div>
              </article>
            ))}
          </div>
          {projects.length > PROJECTS_PER_PAGE && (
            <nav className="project-pagination" aria-label="Phân trang repo và dự án">
              <span>{projectPage * PROJECTS_PER_PAGE + 1}–{Math.min((projectPage + 1) * PROJECTS_PER_PAGE, projects.length)} / {projects.length} repo</span>
              <div>
                <button type="button" onClick={() => setProjectPage((page) => Math.max(0, page - 1))} disabled={projectPage === 0}>‹ Trước</button>
                <strong>Trang {projectPage + 1} / {projectPageCount}</strong>
                <button type="button" onClick={() => setProjectPage((page) => Math.min(projectPageCount - 1, page + 1))} disabled={projectPage >= projectPageCount - 1}>Sau ›</button>
              </div>
            </nav>
          )}
        </section>
        </div>

        <div className="diagnostic-page" hidden={activePage !== "logs"}>
          <DiagnosticLogView
            data={diagnosticLogs}
            filters={diagnosticFilters}
            busy={diagnosticBusy}
            selected={selectedDiagnostic}
            onFilters={(patch) => setDiagnosticFilters((current) => ({ ...current, ...patch }))}
            onRefresh={() => void loadDiagnosticLogs(true)}
            onClear={() => void clearDiagnosticLogHistory()}
            onSelect={setSelectedDiagnostic}
            onCopy={(entry) => {
              void api.copyText(JSON.stringify(entry, null, 2));
              notify("Đã copy chi tiết log");
            }}
          />
        </div>

        <div className="settings-view" hidden={activePage !== "settings"}>
          <section className="connection-card" id="connection">
            <div className="connection-copy">
              <p className="eyebrow">MCP SERVER URL</p>
              <h2>Kết nối ChatGPT</h2>
              <p>Link đã gắn token riêng của CodexPro. Chọn <b>Server URL</b> và <b>No Auth</b>.</p>
            </div>
            <div className="link-box">
              <code>{status?.mcpLink || "Chưa có link MCP"}</code>
              <button className="copy-button" onClick={copyLink} disabled={!status?.mcpLink}>Copy</button>
            </div>
            <div className="link-actions">
              <button className="button secondary" onClick={copyLink} disabled={!status?.mcpLink}>Copy link</button>
              <button className="button danger-quiet" onClick={rotateLink} disabled={Boolean(busy)}>{busy === "rotate" ? "Đang tạo..." : "Tạo token + link mới"}</button>
              <button className="text-button" onClick={() => api.openExternal("https://chatgpt.com/plugins?q=CodexPro")}>Mở Plugins ChatGPT ↗</button>
            </div>
          </section>

          <section className="settings-panel headless-workers-panel">
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">HEADLESS WORKERS</p>
                <h2>Chrome worker chạy nền</h2>
                <p className="section-note">Clone session từ Chrome profile chính sang profile riêng của CodexPro rồi chạy Chrome <code>--headless=new</code>. Dùng chung trên macOS và Windows.</p>
              </div>
              <span className={`headless-support-badge ${headlessState.supported ? "is-ready" : "is-offline"}`}>{headlessState.supported ? "SẴN SÀNG" : "CHƯA SẴN SÀNG"}</span>
            </div>
            <div className="headless-create-row">
              <div className="headless-source-select">
                <label>Chrome profile nguồn</label>
                <SettingsDropdown
                  value={headlessSourceProfile}
                  options={(headlessState.sourceProfiles || []).filter((profile) => profile.codexProInstalled).map((profile) => ({
                    value: profile.profileDirectory,
                    label: profile.userName || profile.name || profile.profileDirectory,
                    hint: `${profile.name || profile.profileDirectory} · ${profile.profileDirectory} · CodexPro ✓`
                  }))}
                  disabled={Boolean(headlessBusy) || !(headlessState.sourceProfiles || []).some((profile) => profile.codexProInstalled)}
                  ariaLabel="Chọn Chrome profile để clone session"
                  onChange={setHeadlessSourceProfile}
                />
              </div>
              <button
                type="button"
                className="button primary headless-create-button"
                disabled={Boolean(headlessBusy) || !headlessState.supported || !headlessSourceProfile}
                onClick={() => void runHeadlessAction(
                  "create",
                  () => api.createHeadlessWorker({ sourceProfileDirectory: headlessSourceProfile, autoStart: true }),
                  "Đã tạo headless worker và clone session"
                )}
              >{headlessBusy === "create" ? "Đang tạo…" : "＋ Tạo headless worker"}</button>
            </div>
            <div className="headless-runtime-meta">
              <span><b>Chrome</b> {headlessState.chromePath || "Không tìm thấy"}</span>
              <span><b>User data</b> {headlessState.chromeUserDataRoot || "—"}</span>
            </div>
            {!headlessState.supported && <div className="headless-warning">Không tìm thấy Google Chrome. Có thể đặt <code>CODEXPRO_CHROME_PATH</code> nếu Chrome nằm ở vị trí khác.</div>}
            {headlessState.supported && !(headlessState.sourceProfiles || []).some((profile) => profile.codexProInstalled) && <div className="headless-warning">Chưa tìm thấy Chrome profile nào đã bật CodexPro extension. Hãy mở profile cần dùng, bật CodexPro rồi quay lại đây.</div>}
            <div className="headless-worker-list">
              {(headlessState.workers || []).length === 0 && <div className="headless-empty">Chưa có headless worker. Chọn profile chính rồi tạo worker đầu tiên.</div>}
              {(headlessState.workers || []).map((worker) => {
                const workerBusy = headlessBusy === worker.id;
                return (
                  <article className="headless-worker-card" key={worker.id}>
                    <div className={`headless-worker-status ${worker.running ? "is-running" : "is-stopped"}`}><span />{worker.running ? "RUNNING" : "STOPPED"}</div>
                    <div className="headless-worker-main">
                      <div className="headless-worker-title"><strong>{worker.label}</strong><code>{worker.id}</code></div>
                      <div className="headless-worker-details">
                        <span>Nguồn: <b>{worker.sourceUserName || worker.sourceProfileName || worker.sourceProfileDirectory}</b></span>
                        <span>Profile: <code>{worker.sourceProfileDirectory}</code></span>
                        <span>{worker.running ? `PID ${worker.pid}` : "Không chạy"}</span>
                        <span>{worker.lastSyncedAt ? `Sync ${new Date(worker.lastSyncedAt).toLocaleString("vi-VN")}` : "Chưa sync"}</span>
                      </div>
                      {worker.lastSyncWarning && <div className="headless-worker-warning">{worker.lastSyncWarning}</div>}
                      {worker.lastError && <div className="headless-worker-error">{worker.lastError}</div>}
                    </div>
                    <div className="headless-worker-controls">
                      <label className="headless-autostart-toggle">
                        <input
                          type="checkbox"
                          checked={Boolean(worker.autoStart)}
                          disabled={workerBusy}
                          onChange={(event) => void runHeadlessAction(
                            worker.id,
                            () => api.setHeadlessWorkerAutoStart({ workerId: worker.id, autoStart: event.target.checked }),
                            event.target.checked ? "Đã bật tự chạy headless worker" : "Đã tắt tự chạy headless worker"
                          )}
                        />
                        <span>Tự chạy</span>
                      </label>
                      <button type="button" className="button secondary" disabled={workerBusy} onClick={() => void runHeadlessAction(worker.id, () => api.syncHeadlessWorker(worker.id), "Đã sync lại session từ Chrome chính")}>{workerBusy ? "Đang xử lý…" : "Sync session"}</button>
                      <button type="button" className={worker.running ? "button danger-quiet" : "button primary"} disabled={workerBusy} onClick={() => void runHeadlessAction(worker.id, () => worker.running ? api.stopHeadlessWorker(worker.id) : api.startHeadlessWorker(worker.id), worker.running ? "Đã dừng headless worker" : "Đã chạy headless worker")}>{worker.running ? "Dừng" : "Chạy"}</button>
                      <button type="button" className="button ghost" disabled={workerBusy} onClick={() => void runHeadlessAction(worker.id, () => api.deleteHeadlessWorker(worker.id), "Đã xóa headless worker")}>Xóa</button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="settings-panel global-rules-panel">
            <div className="settings-panel-head global-rules-head">
              <div>
                <p className="eyebrow">GLOBAL MCP RULES</p>
                <h2>Rule bắt buộc cho mọi repo</h2>
                <p className="section-note">CodexPro sẽ nạp <code>~/.codexpro/CODEXPRO.md</code> trước rule riêng của repo/dự án mỗi khi bắt đầu hoặc mở workspace.</p>
              </div>
              <span className="global-rules-badge">BẮT BUỘC</span>
            </div>
            <textarea
              className="global-rules-editor"
              value={globalRulesDraft}
              maxLength={30000}
              spellCheck={false}
              aria-label="CodexPro global rules"
              disabled={settingsBusy === "save"}
              onChange={(event) => setGlobalRulesDraft(event.target.value)}
              placeholder={GLOBAL_RULES_TEMPLATE}
            />
            <div className="global-rules-actions">
              <span>{globalRulesDraft.length.toLocaleString("vi-VN")} / 30.000 ký tự · áp dụng toàn bộ repo/dự án</span>
              <button type="button" className="button ghost" disabled={settingsBusy === "save"} onClick={() => setGlobalRulesDraft(GLOBAL_RULES_TEMPLATE)}>Dùng template</button>
              <button type="button" className="button primary" disabled={settingsBusy === "save" || globalRulesDraft === managerSettings.globalRules} onClick={() => void saveManagerSetting({ globalRules: globalRulesDraft }, "Đã lưu CODEXPRO.md")}>{settingsBusy === "save" ? "Đang lưu…" : "Lưu rule"}</button>
            </div>
          </section>

          <section className="settings-panel subagent-limit-panel">
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">AGENT EXECUTION</p>
                <h2>Số lượng subagent chạy</h2>
                <p className="section-note">Agent chính luôn chạy một phiên. Setting này giới hạn số agent con CodexPro được phép gọi trong mỗi handoff.</p>
              </div>
              <span className="subagent-test-badge">TEST CAP</span>
            </div>
            <div className="subagent-limit-row">
              <div className="subagent-limit-copy">
                <strong>Tối đa mỗi handoff</strong>
                <span>Đang khóa 1 subagent để kiểm thử ổn định. Explore dùng slot duy nhất; Gemini scout sẽ được bỏ qua.</span>
              </div>
              <div className="settings-number-field subagent-limit-field" aria-label="Số subagent tối đa">
                <input type="number" min="1" max="1" value={managerSettings.maxSubagents} readOnly aria-readonly="true" />
                <span>agent</span>
              </div>
            </div>
            <div className="subagent-limit-meter" aria-hidden="true">
              <span className="is-active"><b>1</b><small>Explore</small></span>
              <i />
              <span className="is-locked"><b>2+</b><small>Đang khóa</small></span>
            </div>
          </section>

          <section className="settings-panel">
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">CHAT POPUP</p>
                <h2>Độ rộng popup chat</h2>
                <p className="section-note">Tăng hoặc giảm chiều rộng cửa sổ Chat. Giá trị vẫn tự co theo màn hình nhỏ.</p>
              </div>
              <div className="settings-number-field">
                <input
                  type="number"
                  min="720"
                  max="1600"
                  step="20"
                  inputMode="numeric"
                  aria-label="Độ rộng popup chat"
                  value={chatWidthInput}
                  disabled={settingsBusy === "save"}
                  onChange={(event) => setChatWidthInput(event.target.value.replace(/[^0-9]/g, ""))}
                  onBlur={commitChatWidthInput}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      setChatWidthInput(String(managerSettings.chatWidth));
                      event.currentTarget.blur();
                    }
                  }}
                />
                <span>px</span>
              </div>
            </div>
            <div className="width-control">
              <button
                type="button"
                className="setting-step-button"
                aria-label="Giảm độ rộng popup"
                disabled={settingsBusy === "save" || managerSettings.chatWidth <= 720}
                onClick={() => void saveManagerSetting({ chatWidth: Math.max(720, managerSettings.chatWidth - 40) }, "Đã giảm độ rộng popup")}
              >−</button>
              <input
                className="settings-range"
                type="range"
                min="720"
                max="1600"
                step="20"
                value={managerSettings.chatWidth}
                onChange={(event) => setManagerSettings((current) => ({ ...current, chatWidth: Number(event.target.value) }))}
                onPointerUp={(event) => void saveManagerSetting({ chatWidth: Number(event.currentTarget.value) }, "Đã lưu độ rộng popup")}
                onKeyUp={(event) => void saveManagerSetting({ chatWidth: Number(event.currentTarget.value) }, "Đã lưu độ rộng popup")}
              />
              <button
                type="button"
                className="setting-step-button"
                aria-label="Tăng độ rộng popup"
                disabled={settingsBusy === "save" || managerSettings.chatWidth >= 1600}
                onClick={() => void saveManagerSetting({ chatWidth: Math.min(1600, managerSettings.chatWidth + 40) }, "Đã tăng độ rộng popup")}
              >＋</button>
            </div>
            <div className="width-scale"><span>720px</span><span>Mặc định 940px</span><span>1600px</span></div>
            <div className="chat-width-preview"><div style={{ width: `${Math.max(42, Math.min(100, managerSettings.chatWidth / 16))}%` }}><span>Chat popup</span><small>{managerSettings.chatWidth}px</small></div></div>
          </section>

          <section className="settings-panel">
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">CHAT CONTENT</p>
                <h2>Chiều cao khung chat bên trong</h2>
                <p className="section-note">Chỉnh chiều cao vùng “Tin nhắn gần nhất” trong popup Chat. Nội dung dài vẫn cuộn độc lập bên trong khung.</p>
              </div>
              <div className="settings-number-field">
                <input
                  type="number"
                  min="180"
                  max="700"
                  step="10"
                  inputMode="numeric"
                  aria-label="Chiều cao khung chat bên trong"
                  value={chatHeightInput}
                  disabled={settingsBusy === "save"}
                  onChange={(event) => setChatHeightInput(event.target.value.replace(/[^0-9]/g, ""))}
                  onBlur={commitChatHeightInput}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      setChatHeightInput(String(managerSettings.chatHeight));
                      event.currentTarget.blur();
                    }
                  }}
                />
                <span>px</span>
              </div>
            </div>
            <div className="width-control">
              <button
                type="button"
                className="setting-step-button"
                aria-label="Giảm chiều cao khung chat"
                disabled={settingsBusy === "save" || managerSettings.chatHeight <= 180}
                onClick={() => void saveManagerSetting({ chatHeight: Math.max(180, managerSettings.chatHeight - 20) }, "Đã giảm chiều cao khung chat")}
              >−</button>
              <input
                className="settings-range chat-height-range"
                type="range"
                min="180"
                max="700"
                step="10"
                value={managerSettings.chatHeight}
                onChange={(event) => setManagerSettings((current) => ({ ...current, chatHeight: Number(event.target.value) }))}
                onPointerUp={(event) => void saveManagerSetting({ chatHeight: Number(event.currentTarget.value) }, "Đã lưu chiều cao khung chat")}
                onKeyUp={(event) => void saveManagerSetting({ chatHeight: Number(event.currentTarget.value) }, "Đã lưu chiều cao khung chat")}
              />
              <button
                type="button"
                className="setting-step-button"
                aria-label="Tăng chiều cao khung chat"
                disabled={settingsBusy === "save" || managerSettings.chatHeight >= 700}
                onClick={() => void saveManagerSetting({ chatHeight: Math.min(700, managerSettings.chatHeight + 20) }, "Đã tăng chiều cao khung chat")}
              >＋</button>
            </div>
            <div className="width-scale"><span>180px</span><span>Mặc định 330px</span><span>700px</span></div>
            <div className="chat-height-preview">
              <div style={{ height: `${Math.max(34, Math.min(100, managerSettings.chatHeight / 7))}%` }}>
                <span>Tin nhắn gần nhất</span><small>{managerSettings.chatHeight}px</small>
              </div>
            </div>
          </section>

          <section className="settings-panel">
            <div className="settings-panel-head profile-layout-setting-head">
              <div>
                <p className="eyebrow">PROFILE LAYOUT</p>
                <h2>Bố cục profile đã kết nối</h2>
                <p className="section-note">Chọn danh sách ngang gọn gàng hoặc thẻ dọc với ảnh worker lớn. Thẻ dọc hiển thị tối đa 4 profile mỗi hàng.</p>
              </div>
              <div className="profile-layout-select">
                <label>Kiểu hiển thị</label>
                <SettingsDropdown
                  value={managerSettings.profileLayout}
                  options={[
                    { value: "rows", label: "Danh sách ngang", hint: "Gọn, ưu tiên thông tin profile" },
                    { value: "cards", label: "Thẻ dọc", hint: "Ảnh worker lớn, tối đa 4 thẻ mỗi hàng" }
                  ]}
                  disabled={settingsBusy === "save"}
                  ariaLabel="Chọn bố cục profile"
                  onChange={(value) => void saveManagerSetting({ profileLayout: value }, value === "cards" ? "Đã chuyển sang thẻ dọc" : "Đã chuyển sang danh sách ngang")}
                />
              </div>
            </div>
            <div className={`profile-layout-preview is-${managerSettings.profileLayout === "cards" ? "card" : "row"}`} aria-hidden="true">
              {["idle", "working", "idle", "hung"].map((state, index) => (
                <span className="profile-layout-preview-item" key={`${state}-${index}`}>
                  <WorkerIcon state={state} customImages={managerSettings.workerImageDataUrls} />
                  <i />
                </span>
              ))}
            </div>
          </section>

          <section className="settings-panel">
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">TYPOGRAPHY</p>
                <h2>Font chữ theo thành phần</h2>
                <p className="section-note">Chọn font riêng cho nội dung, tiêu đề và phần kỹ thuật. Có thể để các nhóm dùng chung một font.</p>
              </div>
            </div>
            <div className="font-role-grid">
              <div className="font-setting-row">
                <label>Nội dung & control</label>
                <SettingsDropdown
                  value={managerSettings.fontFamily}
                  options={FONT_OPTIONS}
                  disabled={settingsBusy === "save"}
                  ariaLabel="Chọn font nội dung và control"
                  onChange={(value) => void saveManagerSetting({ fontFamily: value }, "Đã đổi font nội dung")}
                />
                <div className="font-preview" style={{ fontFamily: selectedFont.css, fontSize: `${managerSettings.fontSize}px` }}>Aa Bb Cc · Nội dung tiếng Việt: Đặng, Nguyễn, Trường · 0123456789</div>
              </div>
              <div className="font-setting-row">
                <label>Tiêu đề</label>
                <SettingsDropdown
                  value={managerSettings.headingFontFamily}
                  options={FONT_ROLE_OPTIONS}
                  disabled={settingsBusy === "save"}
                  ariaLabel="Chọn font tiêu đề"
                  onChange={(value) => void saveManagerSetting({ headingFontFamily: value }, value === "inherit" ? "Tiêu đề dùng font nội dung" : "Đã đổi font tiêu đề")}
                />
                <div className="font-preview is-title" style={{ fontFamily: selectedHeadingFont?.css || selectedFont.css }}>CodexPro · Tiêu đề giao diện</div>
              </div>
              <div className="font-setting-row">
                <label>Code · ID · log</label>
                <SettingsDropdown
                  value={managerSettings.monoFontFamily}
                  options={FONT_ROLE_OPTIONS}
                  disabled={settingsBusy === "save"}
                  ariaLabel="Chọn font code ID và log"
                  onChange={(value) => void saveManagerSetting({ monoFontFamily: value }, value === "inherit" ? "Code và log dùng font nội dung" : "Đã đổi font code và log")}
                />
                <div className="font-preview is-mono" style={{ fontFamily: selectedMonoFont?.css || selectedFont.css }}>cpt_task_id · 127.0.0.1:8793 · npm run build</div>
              </div>
            </div>
            <div className="font-size-setting-row">
              <label>Cỡ chữ chung</label>
              <div className="width-control">
                <button
                  type="button"
                  className="setting-step-button"
                  aria-label="Giảm cỡ chữ"
                  disabled={settingsBusy === "save" || managerSettings.fontSize <= 12}
                  onClick={() => void saveManagerSetting({ fontSize: Math.max(12, managerSettings.fontSize - 1) }, "Đã giảm cỡ chữ")}
                >−</button>
                <input
                  className="settings-range"
                  type="range"
                  min="12"
                  max="18"
                  step="1"
                  value={managerSettings.fontSize}
                  onChange={(event) => setManagerSettings((current) => ({ ...current, fontSize: Number(event.target.value) }))}
                  onPointerUp={(event) => void saveManagerSetting({ fontSize: Number(event.currentTarget.value) }, "Đã lưu cỡ chữ")}
                  onKeyUp={(event) => void saveManagerSetting({ fontSize: Number(event.currentTarget.value) }, "Đã lưu cỡ chữ")}
                />
                <button
                  type="button"
                  className="setting-step-button"
                  aria-label="Tăng cỡ chữ"
                  disabled={settingsBusy === "save" || managerSettings.fontSize >= 18}
                  onClick={() => void saveManagerSetting({ fontSize: Math.min(18, managerSettings.fontSize + 1) }, "Đã tăng cỡ chữ")}
                >＋</button>
              </div>
              <div className="font-size-value"><strong>{managerSettings.fontSize}</strong><span>px · cỡ chữ cơ bản</span></div>
            </div>
          </section>

          <section className="settings-panel">
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">WORKER APPEARANCE</p>
                <h2>Bộ ảnh worker</h2>
                <p className="section-note">Tạo nhiều bộ, tải ảnh cho từng trạng thái rồi đổi bộ đang dùng bất cứ lúc nào. Hỗ trợ PNG, JPG, GIF, WEBP tối đa 10 MB.</p>
              </div>
            </div>
            <div className="worker-pack-toolbar">
              <div className="worker-pack-select">
                <label>Bộ đang dùng</label>
                <SettingsDropdown
                  value={managerSettings.selectedWorkerPackId}
                  options={workerPackOptions}
                  disabled={Boolean(settingsBusy)}
                  ariaLabel="Chọn bộ ảnh worker"
                  onChange={(value) => void selectWorkerImagePack(value)}
                />
              </div>
              <div className="worker-pack-preview-strip" aria-label="Xem trước bộ ảnh đang dùng">
                {workerSettingItems.map((item) => <WorkerIcon key={item.state} state={item.state} customImages={managerSettings.workerImageDataUrls} />)}
              </div>
              <div className="worker-pack-actions">
                <button type="button" className="button secondary" onClick={() => { setWorkerPackDraft(`Bộ worker ${managerSettings.workerImagePacks.length + 1}`); setShowWorkerPackCreator(true); }} disabled={Boolean(settingsBusy)}>＋ Tạo bộ mới</button>
                <button type="button" className={`button danger-quiet ${workerPackDeleteArmed === selectedWorkerPack?.id ? "is-armed" : ""}`} onClick={() => void deleteWorkerImagePack()} disabled={Boolean(settingsBusy) || !selectedWorkerPack}>{workerPackDeleteArmed === selectedWorkerPack?.id ? "Xác nhận xóa" : "Xóa bộ"}</button>
              </div>
            </div>
            {showWorkerPackCreator && (
              <div className="worker-pack-creator">
                <input
                  autoFocus
                  value={workerPackDraft}
                  maxLength={60}
                  placeholder="Tên bộ ảnh worker"
                  onChange={(event) => setWorkerPackDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void createWorkerImagePack();
                    if (event.key === "Escape") { setShowWorkerPackCreator(false); setWorkerPackDraft(""); }
                  }}
                />
                <button type="button" className="button primary" onClick={() => void createWorkerImagePack()} disabled={Boolean(settingsBusy) || !workerPackDraft.trim()}>Tạo bộ</button>
                <button type="button" className="button ghost" onClick={() => { setShowWorkerPackCreator(false); setWorkerPackDraft(""); }} disabled={Boolean(settingsBusy)}>Hủy</button>
              </div>
            )}
            {!selectedWorkerPack && <p className="worker-pack-help">Bộ mặc định chỉ để sử dụng. Hãy bấm <strong>Tạo bộ mới</strong> để upload ảnh riêng.</p>}
            <div className="worker-settings-grid">
              {workerSettingItems.map((item) => {
                const customized = Boolean(selectedWorkerPack?.imageDataUrls?.[item.state]);
                const loading = settingsBusy === `worker:${item.state}`;
                return (
                  <article className="worker-setting-card" key={item.state}>
                    <WorkerIcon state={item.state} customImages={managerSettings.workerImageDataUrls} />
                    <div className="worker-setting-copy">
                      <div><strong>{item.title}</strong>{customized && <span className="customized-badge">TÙY CHỈNH</span>}</div>
                      <p>{item.description}</p>
                    </div>
                    <div className="worker-setting-actions">
                      <button type="button" className="button secondary" onClick={() => void changeWorkerImage(item.state)} disabled={Boolean(settingsBusy) || !selectedWorkerPack}>{loading ? "Đang chọn…" : "Chọn ảnh"}</button>
                      <button type="button" className="button ghost" onClick={() => void restoreWorkerImage(item.state)} disabled={Boolean(settingsBusy) || !customized}>Mặc định</button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <div className="settings-footer">
            <span>Cài đặt được lưu trong dữ liệu CodexPro trên máy này.</span>
            <button type="button" className="button danger-quiet" onClick={() => void restoreManagerSettings()} disabled={Boolean(settingsBusy)}>{settingsBusy === "reset" ? "Đang khôi phục…" : "Khôi phục tất cả mặc định"}</button>
          </div>
        </div>

      </main>

      {renderChatModal()}

      {attachmentPreview && (
        <div className="modal-backdrop attachment-lightbox-backdrop" tabIndex={-1} autoFocus onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setAttachmentPreview(null); } }} onMouseDown={(event) => event.target === event.currentTarget && setAttachmentPreview(null)}>
          <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={`Xem trước ${attachmentPreview.name || "file"}`}>
            <div className="attachment-lightbox-head">
              <div>
                <strong title={attachmentPreview.name || ""}>{attachmentPreview.name || "File đính kèm"}</strong>
                <span>{[attachmentPreview.mimeType, formatFileSize(Number(attachmentPreview.size) || 0)].filter(Boolean).join(" · ")}{attachmentPreview.truncated ? " · chỉ hiển thị phần đầu" : ""}</span>
              </div>
              <button type="button" aria-label="Đóng xem trước" onClick={() => setAttachmentPreview(null)}>×</button>
            </div>
            <div className={`attachment-lightbox-body is-${attachmentPreview.loading ? "loading" : attachmentPreview.kind || "unsupported"}`}>
              {attachmentPreview.loading ? (
                <div className="attachment-preview-state"><span className="typing-dots"><i /><i /><i /></span><span>Đang mở file…</span></div>
              ) : attachmentPreview.kind === "image" ? (
                <img src={attachmentPreview.dataUrl} alt={attachmentPreview.name || "Ảnh đính kèm"} />
              ) : attachmentPreview.kind === "text" ? (
                <pre>{attachmentPreview.text || "(File không có nội dung văn bản.)"}</pre>
              ) : (
                <div className="attachment-preview-state is-error"><strong>Không thể xem trước file này</strong><span>{attachmentPreview.error || "CodexPro hiện hỗ trợ lightbox cho ảnh và file văn bản."}</span></div>
              )}
            </div>
          </div>
        </div>
      )}

      {workerUpdateConfirmOpen && (
        <div className="modal-backdrop worker-update-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setWorkerUpdateConfirmOpen(false)}>
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
              <p>Cập nhật <strong>{profileSummary.reload} worker đang rảnh</strong> lên phiên bản <code>{WORKER_EXTENSION_VERSION}</code>.</p>
              {profileSummary.deferredUpdate > 0 && <p className="worker-update-note">{profileSummary.deferredUpdate} worker đang làm việc sẽ được giữ nguyên để không gián đoạn task.</p>}
            </div>
            <div className="worker-update-actions">
              <button type="button" className="button ghost" onClick={() => setWorkerUpdateConfirmOpen(false)}>Hủy</button>
              <button type="button" className="button primary" onClick={() => void reloadProfiles()}>Cập nhật worker</button>
            </div>
          </div>
        </div>
      )}

      {inspection && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setInspection(null)}>
          <div className="modal codexgraph-modal">
            <div className="modal-head"><div><p className="eyebrow">MCP INSPECTION</p><h2>{inspection.project.name}</h2></div><button onClick={() => setInspection(null)}>×</button></div>
            <div className="inspection-grid">
              <div><small>Workspace ID</small><code>{inspection.result.workspace_id || "—"}</code></div>
              <div><small>Root</small><code>{inspection.result.root || inspection.project.root}</code></div>
            </div>
            <CodeGraphView graphData={inspection.result.codexgraph} />
            <details className="codexgraph-raw-details">
              <summary>Chi tiết workspace / Git / cây dự án</summary>
              <h3>Git status</h3>
            <pre>{inspection.result.git_status || "Working tree sạch hoặc không có dữ liệu."}</pre>
            <h3>Cây dự án</h3>
              <pre>{inspection.result.tree || inspection.result.tree_text || "CodexPro đã mở workspace thành công."}</pre>
            </details>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <span className="toast-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="m7.5 12.4 3 3.1 6.4-7" />
            </svg>
          </span>
          <span className="toast-message">{toast}</span>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
