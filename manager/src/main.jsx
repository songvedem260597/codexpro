import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import workerHung from "./assets/worker-hung.gif";
import workerIdle from "./assets/worker-idle.gif";
import workerWorking from "./assets/worker-working.gif";

const api = window.codexpro;
const PROFILE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_CHECK_RETRY_MS = 30 * 60 * 1000;
const RESPONSE_AUTO_SCROLL_RESUME_MS = 3000;
const RESPONSE_BOTTOM_THRESHOLD_PX = 18;
const REALTIME_POLL_MS = 1000;
const NEW_CHAT_TARGET = "__codexpro_new_chat__";
const ROLLOVER_CONTEXT_MAX_CHARS = 9000;
const PROJECTS_PER_PAGE = 8;

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
  { value: "arial", label: "Arial", css: 'Arial, sans-serif' },
  { value: "tahoma", label: "Tahoma", css: 'Tahoma, sans-serif' },
  { value: "verdana", label: "Verdana", css: 'Verdana, sans-serif' },
  { value: "trebuchet", label: "Trebuchet MS", css: '"Trebuchet MS", sans-serif' },
  { value: "georgia", label: "Georgia", css: 'Georgia, serif' },
  { value: "cascadia", label: "Cascadia Code", css: '"Cascadia Code", Consolas, monospace' }
];

const DEFAULT_MANAGER_SETTINGS = {
  chatWidth: 940,
  chatHeight: 330,
  fontFamily: "system",
  fontSize: 14,
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

function ProjectDropdown({ value, projects, disabled, onChange, workspaceTarget, onBrowseDirectory, onBrowseFile }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef(null);
  const selected = projects.find((project) => project.root === value);
  const targetMatches = Boolean(workspaceTarget?.root && value && String(workspaceTarget.root).toLowerCase() === String(value).toLowerCase());
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
        <span className="project-dropdown-mark">⌘</span>
        <span className="project-dropdown-value">
          <strong>{targetMatches && workspaceTarget?.kind === "file" ? workspaceTarget.name : selected?.name || "Chọn dự án, thư mục hoặc file"}</strong>
          <small>{targetMatches && workspaceTarget?.kind === "file" ? `File ngoài repo · ${workspaceTarget.path}` : selected ? `${selected.repoFullName ? `${selected.repoFullName} · ` : ""}${selected.isGit ? (selected.branch || "git") : "thư mục"} · ${selected.root}` : "Có thể chọn Git repo hoặc duyệt file/thư mục bất kỳ"}</small>
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
          <div className="project-dropdown-browse">
            <button type="button" onClick={() => { setOpen(false); setQuery(""); onBrowseDirectory?.(); }}><span>▣</span> Chọn thư mục ngoài danh sách</button>
            <button type="button" onClick={() => { setOpen(false); setQuery(""); onBrowseFile?.(); }}><span>▤</span> Chọn file ngoài repo</button>
          </div>
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
    begin_repo_task: "Đang xác minh repo",
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

function ResponseText({ text, truncated }) {
  const source = `${String(text || "")}${truncated ? "\n\n[Đã rút gọn khi hiển thị]" : ""}`;
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const bullet = line.match(/^\s*[•*-]\s+(.+)$/);
    if (bullet) {
      const items = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*[•*-]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push(<ul className="response-list response-bullets" key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{item}</li>)}</ul>);
      continue;
    }

    const numbered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (numbered) {
      const items = [];
      const start = Number(numbered[1]) || 1;
      while (index < lines.length) {
        const match = lines[index].match(/^\s*(\d+)[.)]\s+(.+)$/);
        if (!match) break;
        items.push(match[2]);
        index += 1;
      }
      blocks.push(<ol className="response-list response-numbered" start={start} key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{item}</li>)}</ol>);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^\s*[•*-]\s+/.test(lines[index]) && !/^\s*\d+[.)]\s+/.test(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(<p key={`p-${index}`}>{paragraph.join("\n")}</p>);
  }

  return <div className="chat-message-text response-rich-text">{blocks}</div>;
}

const WORKER_EXTENSION_VERSION = "0.5.42";
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

function extensionReady(version) {
  const parts = String(version || "").split(".").map(Number);
  const target = WORKER_EXTENSION_VERSION.split(".").map(Number);
  for (let index = 0; index < target.length; index += 1) {
    const current = Number.isFinite(parts[index]) ? parts[index] : 0;
    if (current !== target[index]) return current > target[index];
  }
  return true;
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

function App() {
  const [activePage, setActivePage] = useState("overview");
  const [managerSettings, setManagerSettings] = useState(DEFAULT_MANAGER_SETTINGS);
  const [chatWidthInput, setChatWidthInput] = useState(String(DEFAULT_MANAGER_SETTINGS.chatWidth));
  const [chatHeightInput, setChatHeightInput] = useState(String(DEFAULT_MANAGER_SETTINGS.chatHeight));
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
  const [inspection, setInspection] = useState(null);
  const [checkingProfiles, setCheckingProfiles] = useState([]);
  const [requestDrafts, setRequestDrafts] = useState({});
  const [requestTargets, setRequestTargets] = useState({});
  const [requestProjectRoots, setRequestProjectRoots] = useState({});
  const [requestWorkspaceTargets, setRequestWorkspaceTargets] = useState({});
  const [requestFiles, setRequestFiles] = useState({});
  const [requestResponses, setRequestResponses] = useState({});
  const [clearedResponseTargets, setClearedResponseTargets] = useState({});
  const [requestSendErrors, setRequestSendErrors] = useState({});
  const [renameChat, setRenameChat] = useState(null);
  const conversationTitleOverridesRef = useRef({});
  const refreshInFlight = useRef(false);
  const statusRefreshInFlight = useRef(false);
  const profileCheckTimes = useRef(new Map());
  const responseFetches = useRef(new Set());
  const networkStreamReads = useRef(new Map());
  const networkCompletionReads = useRef(new Map());
  const repoTaskVerificationReads = useRef(new Map());
  const conversationRollovers = useRef(new Map());
  const profilesRef = useRef([]);
  const requestTargetsRef = useRef({});
  const responseBodyRefs = useRef(new Map());
  const responseScrollPauseUntil = useRef(new Map());
  const responseScrollTimers = useRef(new Map());

  const projectPageCount = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
  const visibleProjects = useMemo(() => projects.slice(projectPage * PROJECTS_PER_PAGE, (projectPage + 1) * PROJECTS_PER_PAGE), [projects, projectPage]);

  useEffect(() => {
    setProjectPage((current) => Math.min(current, Math.max(0, Math.ceil(projects.length / PROJECTS_PER_PAGE) - 1)));
  }, [projects.length]);

  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
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
      .catch((err) => { if (!cancelled) setError(err?.message || String(err)); });
    return () => { cancelled = true; };
  }, [applyManagerSettings]);

  useEffect(() => {
    setRequestProjectRoots((current) => ({ ...current, ...(managerSettings.repoSelections || {}) }));
  }, [managerSettings.repoSelections]);

  const refreshHeadlessWorkers = useCallback(async () => {
    try {
      const next = await api.getHeadlessWorkers();
      setHeadlessState(next || { supported: false, chromePath: "", chromeUserDataRoot: "", sourceProfiles: [], workers: [] });
      setHeadlessSourceProfile((current) => current || next?.sourceProfiles?.[0]?.profileDirectory || "");
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
  }, []);

  const holdResponseAutoScroll = useCallback((profileId) => {
    const currentTimer = responseScrollTimers.current.get(profileId);
    const resumeAt = Date.now() + RESPONSE_AUTO_SCROLL_RESUME_MS;
    responseScrollPauseUntil.current.set(profileId, resumeAt);
    if (currentTimer) window.clearTimeout(currentTimer);
    const timer = window.setTimeout(() => {
      if ((responseScrollPauseUntil.current.get(profileId) || 0) > Date.now()) return;
      responseScrollPauseUntil.current.delete(profileId);
      responseScrollTimers.current.delete(profileId);
      scrollResponseToBottom(profileId);
    }, RESPONSE_AUTO_SCROLL_RESUME_MS + 40);
    responseScrollTimers.current.set(profileId, timer);
  }, [scrollResponseToBottom]);

  const pauseResponseAutoScroll = useCallback((profileId, container) => {
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom <= RESPONSE_BOTTOM_THRESHOLD_PX) return;
    holdResponseAutoScroll(profileId);
  }, [holdResponseAutoScroll]);

  useEffect(() => () => {
    for (const timer of responseScrollTimers.current.values()) window.clearTimeout(timer);
    responseScrollTimers.current.clear();
  }, []);

  const refresh = useCallback(async (foreground = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (foreground) setBusy("refresh");
    setError("");
    try {
      const [nextStatus, nextProjects] = await Promise.all([api.getStatus(), api.listProjects()]);
      setStatus(applyConversationTitleOverrides(nextStatus, conversationTitleOverridesRef.current));
      setProjects(nextProjects);
    } catch (err) {
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
    } catch {
      // Background realtime refresh should not flash a global error for a transient miss.
    } finally {
      statusRefreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const statusTimer = window.setInterval(() => void refreshStatus(), REALTIME_POLL_MS);
    const projectsTimer = window.setInterval(() => void refresh(false), 30000);
    return () => {
      window.clearInterval(statusTimer);
      window.clearInterval(projectsTimer);
    };
  }, [refresh, refreshStatus]);

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
        .catch(() => null)
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
        if (networkState === "generating") {
          const streamKey = `${profile.profile_id}:${conversationId}`;
          const lastStreamRead = Number(networkStreamReads.current.get(streamKey) || 0);
          if (Date.now() - lastStreamRead >= 850) {
            networkStreamReads.current.set(streamKey, Date.now());
            void loadResponse(profile, conversationId, true, false);
          }
          continue;
        }
        if (networkState !== "completed" || !networkCompletedAt) continue;
        const completionKey = `${profile.profile_id}:${conversationId}`;
        if (networkCompletionReads.current.get(completionKey) === networkCompletedAt) continue;
        networkCompletionReads.current.set(completionKey, networkCompletedAt);
        void (async () => {
          await loadResponse(profile, conversationId, true, true, true);
          if (currentResponse?.repoTaskId) await verifyRepoTaskUse(profile, conversationId, currentResponse, networkCompletedAt);
        })();
        if (Date.now() - Date.parse(networkCompletedAt) < 15000 && tab.network_source === "codexpro") notify("AI đã phản hồi xong · xác nhận trực tiếp từ network");
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
    if (profile.connected && initialTarget !== NEW_CHAT_TARGET && (!response || response.conversationId !== initialTarget)) void loadResponse(profile, initialTarget, true, true);
  }, [chatProfileId, status?.browserProfiles, requestResponses]);

  useEffect(() => {
    if (!chatProfileId) return;
    const response = requestResponses[chatProfileId];
    const thinking = Boolean(response?.busy || response?.loading || response?.networkState === "generating");
    if (!response?.text && !thinking) return;
    if (thinking) responseScrollPauseUntil.current.delete(chatProfileId);
    if ((responseScrollPauseUntil.current.get(chatProfileId) || 0) > Date.now()) return;
    const frame = window.requestAnimationFrame(() => scrollResponseToBottom(chatProfileId));
    return () => window.cancelAnimationFrame(frame);
  }, [chatProfileId, requestResponses, scrollResponseToBottom]);

  useEffect(() => {
    if (!chatProfileId) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setChatProfileId("");
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [chatProfileId]);

  const profileSummary = useMemo(() => {
    const allProfiles = status?.browserProfiles || [];
    const profiles = allProfiles.filter((profile) => profile.connected);
    return {
      working: profiles.filter((profile) => profile.activity === "working" || profile.activity === "settling").length,
      idle: profiles.filter((profile) => profile.activity === "idle" && (profile.connector_installed || !extensionReady(profile.extension_version))).length,
      hung: allProfiles.filter((profile) => !profile.connected).length,
      missing: profiles.filter((profile) => profile.activity === "no_chatgpt" && !profile.connector_installed).length,
      reload: profiles.filter((profile) => !extensionReady(profile.extension_version)).length
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
    const exact = workspaceProjects.find((project) => project.root.toLowerCase() === requested.toLowerCase());
    if (exact) return exact.root;
    const currentWorkspace = String(profile.current_workspace_root || "");
    return workspaceProjects.find((project) => project.root.toLowerCase() === currentWorkspace.toLowerCase())?.root
      || workspaceProjects.find((project) => project.active)?.root
      || workspaceProjects[0]?.root
      || "";
  }

  function selectProjectForProfile(profileId, root, workspaceTarget = null) {
    setRequestProjectRoots((current) => ({ ...current, [profileId]: root }));
    setRequestWorkspaceTargets((current) => {
      if (workspaceTarget) return { ...current, [profileId]: workspaceTarget };
      const { [profileId]: _removed, ...next } = current;
      return next;
    });
    setManagerSettings((current) => ({ ...current, repoSelections: { ...(current.repoSelections || {}), [profileId]: root } }));
    void api.saveManagerSettings({ repoSelections: { [profileId]: root } })
      .then(applyManagerSettings)
      .catch((err) => setRequestSendErrors((current) => ({ ...current, [profileId]: err?.message || String(err) })));
  }

  async function browseWorkspaceTarget(profile, kind) {
    try {
      const target = await api.chooseWorkspaceTarget(kind);
      if (!target?.root) return;
      setProjects(await api.addProject(target.root));
      selectProjectForProfile(profile.profile_id, target.root, target);
      notify(target.kind === "file" ? `Đã chọn file ${target.name}` : `Đã chọn thư mục ${target.name}`);
    } catch (err) {
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: err?.message || String(err) }));
    }
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

  function openChat(profile) {
    const conversations = profileRequestChats(profile);
    const conversationId = String(requestTargets[profile.profile_id] || conversations.find((chat) => chat.active)?.id || conversations[0]?.id || NEW_CHAT_TARGET);
    if (conversationId) setRequestTargets((current) => ({ ...current, [profile.profile_id]: conversationId }));
    const projectRoot = projectRootForProfile(profile);
    const rememberedRoot = String(requestProjectRoots[profile.profile_id] || managerSettings.repoSelections?.[profile.profile_id] || "");
    if (projectRoot && projectRoot.toLowerCase() !== rememberedRoot.toLowerCase()) selectProjectForProfile(profile.profile_id, projectRoot);
    else if (projectRoot) setRequestProjectRoots((current) => ({ ...current, [profile.profile_id]: projectRoot }));
    setChatProfileId(profile.profile_id);
    if (profile.connected && conversationId && conversationId !== NEW_CHAT_TARGET) {
      setRequestResponses((current) => ({ ...current, [profile.profile_id]: { ...(current[profile.profile_id] || {}), visible: true, loading: true, error: "", conversationId } }));
      void loadResponse(profile, conversationId, true, true);
    }
  }

  function startNewChat(profile) {
    setRenameChat(null);
    setRequestTargets((current) => ({ ...current, [profile.profile_id]: NEW_CHAT_TARGET }));
    setRequestDrafts((current) => ({ ...current, [profile.profile_id]: "" }));
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

  async function openProfile(profile) {
    const tabs = profile.conversation_tabs || [];
    const activeTab = tabs.find((tab) => tab.active) || tabs[0];
    const conversationOf = (tab) => String(tab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
    const activeConversationId = conversationOf(activeTab);
    const conversations = profileRequestChats(profile);
    const defaultTarget = activeConversationId || conversations.find((chat) => chat.active)?.id || conversations[0]?.id || "";
    const conversationId = String(requestTargets[profile.profile_id] || defaultTarget);
    const selectedTab = tabs.find((tab) => conversationOf(tab) === conversationId);
    const targetTab = selectedTab || activeTab;
    const selectedConversation = conversations.find((chat) => String(chat.id) === conversationId);
    setBusy(`open-profile:${profile.profile_id}`);
    setError("");
    try {
      await api.openProfileChat({
        profileId: profile.profile_id,
        conversationId,
        targetId: targetTab?.id,
        targetConversationId: conversationOf(targetTab),
        title: selectedConversation?.title || targetTab?.title || profile.active_chat_title || ""
      });
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function reloadProfiles() {
    if (!profileSummary.reload) return;
    const message = `Update worker extension lên ${WORKER_EXTENSION_VERSION} cho ${profileSummary.reload} profile đang dùng bản cũ? Các tab ChatGPT đang mở sẽ được giữ nguyên.`;
    if (!window.confirm(message)) return;
    setBusy("reload-profiles");
    setError("");
    try {
      const result = await api.reloadProfiles();
      notify(result.count ? `Đang update ${result.count} worker extension lên ${result.version || WORKER_EXTENSION_VERSION}` : `Worker extension đã ở bản ${WORKER_EXTENSION_VERSION}`);
      window.setTimeout(() => void refresh(false), result.mode === "bootstrap_reload" || result.mode === "mixed_update" ? 8000 : 3500);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function sendRequest(profile) {
    const conversations = profileRequestChats(profile);
    const defaultTarget = conversations.find((chat) => chat.active)?.id ?? conversations[0]?.id;
    const conversationId = String(requestTargets[profile.profile_id] ?? defaultTarget ?? NEW_CHAT_TARGET);
    const newChat = conversationId === NEW_CHAT_TARGET;
    const text = String(requestDrafts[profile.profile_id] || "").trim();
    const attachments = requestFiles[profile.profile_id] || [];
    const projectRoot = projectRootForProfile(profile);
    const workspaceTarget = requestWorkspaceTargets[profile.profile_id];
    if (!projectRoot) {
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "Chưa có workspace nào được chọn. Hãy chọn repo, thư mục hoặc file trước." }));
      return;
    }
    setBusy(`request:${profile.profile_id}`);
    setError("");
    setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
    const clearKey = `${profile.profile_id}:${conversationId}`;
    setClearedResponseTargets((current) => {
      if (!current[clearKey]) return current;
      const { [clearKey]: _cleared, ...next } = current;
      return next;
    });
    if (!newChat && text) {
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        const previousMessages = previous.conversationId === conversationId && Array.isArray(previous.messages) ? previous.messages : [];
        return {
          ...current,
          [profile.profile_id]: {
            ...previous,
            visible: true,
            loading: true,
            error: "",
            conversationId,
            messages: [...previousMessages, { id: `optimistic-user-${Date.now()}`, role: "user", text, pending: true }].slice(-20)
          }
        };
      });
    }
    try {
      const result = await api.sendProfileRequest({ profileId: profile.profile_id, conversationId: newChat ? "" : conversationId, newChat, projectRoot, targetPath: workspaceTarget?.path || "", text, attachments });
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
            ? previousMessages.map((message) => message?.role === "user" && message?.pending && message?.text === text ? { ...message, pending: false, uncertain: true } : message)
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
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: uncertainMessage }));
        notify("Trạng thái gửi chưa chắc chắn · CodexPro không tự gửi lại");
        window.setTimeout(() => void refresh(false), 500);
        return;
      }
      if (newChat && resolvedConversationId && resolvedConversationId !== NEW_CHAT_TARGET) {
        setRequestTargets((current) => ({ ...current, [profile.profile_id]: resolvedConversationId }));
      }
      setRequestDrafts((current) => ({ ...current, [profile.profile_id]: "" }));
      setRequestFiles((current) => ({ ...current, [profile.profile_id]: [] }));
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        const previousMessages = previous.conversationId === resolvedConversationId && Array.isArray(previous.messages) ? previous.messages : [];
        const matchingPendingIndex = text ? previousMessages.findIndex((message) => message?.role === "user" && message?.pending && message?.text === text) : -1;
        let optimisticMessages = previousMessages;
        if (text && matchingPendingIndex >= 0) {
          optimisticMessages = previousMessages.map((message, index) => index === matchingPendingIndex ? { ...message, pending: false, uncertain: false } : message);
        } else if (text) {
          optimisticMessages = [...previousMessages, { id: `optimistic-user-${Date.now()}`, role: "user", text, pending: false, uncertain: false }].slice(-20);
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
            repoTaskRetryCount: Number(result?.repo_task_retry_count) || 0,
            repoTaskRolloverCount: Number(result?.repo_task_rollover_count) || 0,
            repoTaskStatus: "waiting",
            repoTaskVerified: false,
            repoTaskRequest: { text, attachments, projectRoot }
          }
        };
      });
      if (generationState === "failed") {
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: `Tin nhắn đã gửi nhưng AI gặp lỗi network${result?.network_error ? `: ${result.network_error}` : ""}.` }));
        notify("Tin nhắn đã gửi · AI gặp lỗi network");
      } else {
        notify(newChat ? "Đã tạo chat mới và gửi tin nhắn đầu tiên" : `Đã gửi${result.attachment_count ? ` ${result.attachment_count} file` : ""} vào ${result.title || profile.active_chat_title || profile.label}`);
      }
      window.setTimeout(() => void refresh(false), 500);
    } catch (err) {
      const message = err?.message || String(err);
      const conversationLimitReached = !newChat && message.includes("CONVERSATION_LIMIT_REACHED:");
      if (conversationLimitReached) {
        const previous = requestResponses[profile.profile_id] || {};
        const cleanMessages = Array.isArray(previous.messages) ? previous.messages.filter((item) => !item?.pending) : [];
        const rolloverMessages = text ? [...cleanMessages, { id: `rollover-user-${Date.now()}`, role: "user", text }].slice(-20) : cleanMessages;
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
          setRequestDrafts((current) => ({ ...current, [profile.profile_id]: "" }));
          setRequestFiles((current) => ({ ...current, [profile.profile_id]: [] }));
          return;
        }
      }
      if (!newChat && text) {
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          const messages = Array.isArray(previous.messages) ? previous.messages.filter((item) => !(item?.role === "user" && item?.pending && item?.text === text)) : [];
          return { ...current, [profile.profile_id]: { ...previous, loading: false, messages } };
        });
      }
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: conversationLimitReached ? "Chat đã đầy và chưa chuyển được sang chat mới." : message }));
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
      const created = await api.sendProfileRequest({
        profileId,
        conversationId: "",
        newChat: true,
        projectRoot: result?.projectRoot || projectRootForProfile(profile),
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
    const verificationKey = `${taskId}:${networkCompletedAt}`;
    if (repoTaskVerificationReads.current.has(verificationKey)) return;
    repoTaskVerificationReads.current.set(verificationKey, Date.now());
    setRequestResponses((current) => {
      const previous = current[profile.profile_id] || {};
      return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "checking" } } : current;
    });
    try {
      const proof = await api.getRepoTaskStatus({ taskId });
      if (proof?.verified) {
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "verified", repoTaskVerified: true, repoTaskProof: proof } } : current;
        });
        return;
      }
      const retryCount = Number(response?.repoTaskRetryCount) || 0;
      const rolloverCount = Number(response?.repoTaskRolloverCount) || 0;
      const original = response?.repoTaskRequest;
      if (retryCount >= 1 || !original?.projectRoot) {
        if (retryCount >= 1 && rolloverCount < 1 && original?.projectRoot) {
          setRequestResponses((current) => {
            const previous = current[profile.profile_id] || {};
            return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "rolling-over", loading: true } } : current;
          });
          notify("Chat cũ né CodexPro 2 lần · đang tạo chat mới");
          const created = await api.sendProfileRequest({
            profileId: profile.profile_id,
            conversationId: "",
            newChat: true,
            projectRoot: original.projectRoot,
            text: original.text,
            attachments: Array.isArray(original.attachments) ? original.attachments : [],
            toolRetry: false,
            toolRolloverCount: rolloverCount + 1,
            previousTaskId: taskId
          });
          if (String(created?.submission_state || "") === "uncertain") throw new Error("Chat mới có trạng thái gửi không chắc chắn; không tự gửi thêm để tránh duplicate.");
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
              repoTaskRetryCount: 0,
              repoTaskRolloverCount: rolloverCount + 1,
              repoTaskStatus: "waiting",
              repoTaskVerified: false,
              repoTaskRequest: original
            }
          }));
          notify("Đã tạo chat mới · @CodexPro được gọi lại đúng một lần");
          window.setTimeout(() => void refresh(false), 500);
          return;
        }
        const message = "ChatGPT đã trả lời nhưng không gọi CodexPro sau 2 lần. Phản hồi này không được coi là đã thực hiện công việc.";
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "failed", repoTaskVerified: false } } : current;
        });
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: message }));
        notify("ChatGPT né gọi CodexPro · đã chặn phản hồi");
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
        projectRoot: original.projectRoot,
        text: original.text,
        attachments: Array.isArray(original.attachments) ? original.attachments : [],
        toolRetry: true,
        toolRolloverCount: rolloverCount,
        previousTaskId: taskId
      });
      if (String(retried?.submission_state || "") === "uncertain") throw new Error("Lần bắt buộc gọi CodexPro có trạng thái gửi không chắc chắn; không tự gửi thêm để tránh duplicate.");
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        return previous.repoTaskId === taskId ? {
          ...current,
          [profile.profile_id]: {
            ...previous,
            repoTaskId: String(retried?.repo_task_id || ""),
            repoTaskRetryCount: 1,
            repoTaskRolloverCount: rolloverCount,
            repoTaskStatus: "waiting",
            repoTaskVerified: false,
            loading: true,
            networkState: String(retried?.generation_state || retried?.network_state || "generating")
          }
        } : current;
      });
      notify("ChatGPT chưa gọi CodexPro · đang tự gửi lại bắt buộc");
      window.setTimeout(() => void refresh(false), 500);
    } catch (err) {
      const message = err?.message || String(err);
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: `Không xác minh được tool call CodexPro: ${message}` }));
    }
  }

  async function loadResponse(profile, explicitConversationId, silent = false, readDom = false, recoverStaleDom = false) {
    const conversations = profileRequestChats(profile);
    const defaultTarget = conversations.find((chat) => chat.active)?.id ?? conversations[0]?.id;
    const conversationId = String(explicitConversationId || requestTargets[profile.profile_id] || defaultTarget || "");
    if (!conversationId || conversationId === NEW_CHAT_TARGET || responseFetches.current.has(profile.profile_id)) return null;
    responseFetches.current.add(profile.profile_id);
    if (!silent) {
      setRequestResponses((current) => ({ ...current, [profile.profile_id]: { ...(current[profile.profile_id] || {}), visible: true, loading: true, error: "", conversationId } }));
    }
    try {
      const result = await api.getProfileResponse({ profileId: profile.profile_id, conversationId, readDom, recoverStaleDom });
      const domAvailable = result.dom_available !== false;
      const networkStreamAvailable = Boolean(result.network_stream_available && (result.text || result.messages?.length));
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        const sameConversation = previous.conversationId === conversationId;
        const incomingMessages = Array.isArray(result.messages)
          ? result.messages.slice(-20).map((message, index) => ({
              id: String(message?.id || `${message?.role || "message"}-${index}`),
              role: message?.role === "user" ? "user" : "assistant",
              text: message?.role === "user" ? visibleUserMessageText(message?.text) : String(message?.text || ""),
              truncated: Boolean(message?.truncated)
            })).filter((message) => message.text)
          : [];
        let nextMessages = sameConversation && Array.isArray(previous.messages) ? previous.messages : [];
        if (domAvailable) nextMessages = incomingMessages;
        else if (networkStreamAvailable) {
          const merged = [...nextMessages];
          for (const message of incomingMessages) {
            const index = merged.findIndex((candidate) => candidate.id === message.id);
            if (index >= 0) merged[index] = { ...merged[index], ...message };
            else merged.push(message);
          }
          nextMessages = merged.slice(-20);
        }
        return {
          ...current,
          [profile.profile_id]: {
            ...(sameConversation ? previous : {}),
            visible: true,
            loading: false,
            error: "",
            conversationId,
            text: domAvailable || networkStreamAvailable ? (result.text || "") : (sameConversation ? previous.text || "" : ""),
            messages: nextMessages,
            busy: Boolean(result.busy),
            truncated: domAvailable || networkStreamAvailable ? Boolean(result.truncated) : Boolean(previous.truncated),
            incomplete: domAvailable || networkStreamAvailable ? Boolean(result.incomplete) : false,
            incompleteReason: domAvailable || networkStreamAvailable ? (result.incomplete_reason || "") : "",
            conversationLimitReached: Boolean(previous.conversationLimitReached),
            conversationLimitMessage: previous.conversationLimitMessage || "",
            domAvailable,
            domSkipped: Boolean(result.dom_skipped),
            networkStreamAvailable,
            networkStreamEndpoint: String(result.network_stream_endpoint || previous.networkStreamEndpoint || ""),
            networkStreamEventCount: Number(result.network_stream_event_count) || Number(previous.networkStreamEventCount) || 0,
            networkStreamError: String(result.network_stream_error || ""),
            contentNeedsRefresh: result.dom_skipped
              ? String(result.network_state || previous.networkState || "") === "completed"
              : domAvailable
                ? false
                : Boolean(previous.contentNeedsRefresh),
            domError: result.dom_error || "",
            networkState: String(result.network_state || previous.networkState || (result.busy ? "generating" : "idle")),
            networkSource: String(result.network_source || previous.networkSource || ""),
            networkStartedAt: result.network_last_started_at || previous.networkStartedAt || "",
            networkCompletedAt: result.network_last_completed_at || previous.networkCompletedAt || "",
            networkStatusCode: Number(result.network_status_code) || Number(previous.networkStatusCode) || 0,
            networkError: String(result.network_error || previous.networkError || ""),
            networkDurationMs: Number(result.network_duration_ms) || Number(previous.networkDurationMs) || 0,
            messageCount: domAvailable || networkStreamAvailable ? Number(result.message_count) || nextMessages.length : Number(previous.messageCount) || 0,
            updatedAt: result.updated_at || new Date().toISOString()
          }
        };
      });
      return result;
    } catch (err) {
      const message = err?.message || String(err);
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
      setError(err?.message || String(err));
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
      setRequestSendErrors((current) => ({ ...current, [profileId]: message }));
    }
  }

  async function continueIncompleteResponse(profile, conversationId) {
    if (!conversationId || busy) return;
    setBusy(`continue:${profile.profile_id}`);
    setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
    try {
      await api.sendProfileRequest({
        profileId: profile.profile_id,
        conversationId,
        projectRoot: projectRootForProfile(profile),
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
    const draft = requestDrafts[profile.profile_id] || "";
    const attachments = requestFiles[profile.profile_id] || [];
    const response = requestResponses[profile.profile_id];
    const sendError = requestSendErrors[profile.profile_id] || "";
    const responseCurrent = response?.conversationId === selectedTarget;
    const clearedKey = `${profile.profile_id}:${selectedTarget}`;
    const responseCleared = Boolean(clearedResponseTargets[clearedKey]);
    const responseMessages = responseCurrent && Array.isArray(response?.messages) ? response.messages : [];
    const displayResponseMessages = compactToolActivityMessages(responseMessages);
    const fallbackToolActivity = toolActivityFromText(response?.text);
    const fallbackResponseMessage = fallbackToolActivity
      ? { id: "codexpro-live-tool-activity", role: "assistant", text: fallbackToolActivity, truncated: false, toolActivity: true }
      : { id: "latest-assistant", role: "assistant", text: response?.text || "", truncated: response?.truncated };
    const hasResponseContent = !responseCleared && Boolean(fallbackResponseMessage.text || displayResponseMessages.length);
    const selectedTab = (profile.conversation_tabs || []).find((tab) => String(tab.url || "").includes(`/c/${selectedTarget}`));
    const selectedNetworkState = String(selectedTab?.network_state || (responseCurrent ? response?.networkState : "") || (selectedTab?.busy ? "generating" : "idle"));
    const selectedNetworkCompleted = selectedNetworkState === "completed";
    const selectedNetworkFailed = selectedNetworkState === "failed";
    const selectedBusy = selectedNetworkState === "generating" || Boolean(selectedTab?.busy || (responseCurrent && response?.busy));
    const selectedSettling = Boolean(selectedTab?.settling || (responseCurrent && response?.incomplete));
    const domUnavailable = Boolean(responseCurrent && response?.domAvailable === false && !response?.domSkipped);
    const contentNeedsRefresh = Boolean(responseCurrent && response?.contentNeedsRefresh);
    const rolloverCreating = Boolean(responseCurrent && response?.rolloverStatus === "creating");
    const canSend = !busy && profile.connected && Boolean(selectedProjectRoot) && !selectedBusy && !rolloverCreating && (isNewChat || conversations.length > 0) && Boolean(draft.trim() || attachments.length);
    const working = profile.connected && (profile.activity === "working" || selectedBusy || selectedSettling || rolloverCreating);
    const workerState = !profile.connected ? "hung" : working ? "working" : "idle";
    const responseHeadline = responseCleared
      ? "Chat đã được dọn"
      : isNewChat
      ? "Chat mới"
      : selectedBusy
        ? "AI đang xử lý · theo dõi bằng network"
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
        <div className="modal chat-modal">
          <div className="modal-head chat-modal-head">
            <div className="chat-modal-profile">
              <WorkerIcon state={workerState} customImages={managerSettings.workerImageDataUrls} />
              <div>
                <p className="eyebrow">CHATGPT · {profile.label}</p>
                <div className="profile-title"><strong>{profile.email || profile.label}</strong>{selectedSettling ? <span className="badge profile-settling">ĐANG HOÀN TẤT</span> : working ? <span className="badge profile-working">ĐANG LÀM VIỆC</span> : profile.connected ? <span className="badge connected">ĐANG RẢNH</span> : <span className="badge profile-hung">MẤT KẾT NỐI</span>}</div>
                <code>{profile.profile_id}</code>
              </div>
            </div>
            <button type="button" aria-label="Đóng chat" onClick={() => setChatProfileId("")}><span aria-hidden="true">×</span></button>
          </div>

          <article className={`request-card chat-popup-card ${profile.connected ? "is-online" : "is-offline"}`}>
            <label className="request-label">Dự án / đường dẫn cần làm <small>khóa cho profile/chat hiện tại</small></label>
            <ProjectDropdown value={selectedProjectRoot} projects={workspaceProjects} workspaceTarget={requestWorkspaceTargets[profile.profile_id]} onChange={(root) => selectProjectForProfile(profile.profile_id, root)} onBrowseDirectory={() => void browseWorkspaceTarget(profile, "directory")} onBrowseFile={() => void browseWorkspaceTarget(profile, "file")} disabled={!profile.connected || sending || selectedBusy || rolloverCreating} />
            {!workspaceProjects.length && <div className="request-send-error">Chưa có workspace đã lưu. Dùng nút chọn thư mục/file ngay trong danh sách phía trên.</div>}
            <label className="request-label">Tin nhắn gần nhất</label>
            <div className={`chat-response is-inline ${selectedBusy ? "is-streaming" : ""} ${responseCurrent && response?.incomplete ? "is-incomplete" : ""}`}>
              <div className="chat-response-head">
                <div><span className="response-status-dot" /><strong>{responseHeadline}</strong>{!isNewChat && responseCurrent && response?.updatedAt && <small>{new Date(response.updatedAt).toLocaleTimeString("vi-VN")}</small>}</div>
                <div className="response-head-actions">
                  {responseCurrent && !responseCleared && !isNewChat && !selectedBusy && (contentNeedsRefresh || domUnavailable) && <button type="button" onClick={() => void loadResponse(profile, selectedTarget, false, true)} disabled={Boolean(busy)}>Đọc nội dung</button>}
                  {responseCurrent && !responseCleared && response?.incomplete && !selectedBusy && <button type="button" className="continue-response" onClick={() => void continueIncompleteResponse(profile, selectedTarget)} disabled={Boolean(busy)}>Tiếp tục</button>}
                  {responseCurrent && response?.text && !responseCleared && <button type="button" onClick={async () => { await api.copyText(response.text); notify("Đã copy phản hồi mới nhất"); }}>Copy</button>}
                  {responseCurrent && hasResponseContent && !selectedBusy && <button type="button" onClick={() => { setClearedResponseTargets((current) => ({ ...current, [clearedKey]: true })); notify("Đã dọn chat trong Manager"); }}>Clear</button>}
                </div>
              </div>
              {responseCurrent && !responseCleared && response?.rolloverNotice && (
                <div className={`conversation-rollover-notice is-${response.rolloverStatus || "done"}`}>
                  <strong>{response.rolloverStatus === "creating" ? "Chat đã đầy · đang chuyển sang chat mới" : response.rolloverStatus === "failed" ? "Chat đã đầy · chuyển chat tự động thất bại" : "Đã chuyển sang chat mới"}</strong>
                  <span>{response.rolloverNotice}</span>
                </div>
              )}
              {responseCurrent && !responseCleared && response?.repoTaskId && (
                <div className={`network-response-notice is-${response.repoTaskStatus === "verified" ? "completed" : response.repoTaskStatus === "failed" ? "failed" : "generating"}`}>
                  <strong>{response.repoTaskStatus === "verified" ? "CodexPro: đã xác minh tool call" : response.repoTaskStatus === "retrying" ? "CodexPro: ChatGPT né tool · đang gửi lại" : response.repoTaskStatus === "failed" ? "CodexPro: phản hồi bị chặn" : "CodexPro: đang chờ bằng chứng tool call"}</strong>
                  <span>{response.repoTaskStatus === "verified" ? `Repo đã được mở thật · task ${response.repoTaskId}` : response.repoTaskStatus === "failed" ? "ChatGPT không gọi CodexPro nên Manager không công nhận phản hồi này." : "Manager chỉ công nhận công việc sau khi server nhận begin_repo_task."}</span>
                </div>
              )}
              {responseCurrent && !responseCleared && !isNewChat && selectedNetworkState !== "idle" && !selectedNetworkCompleted && (
                <div className={`network-response-notice is-${selectedNetworkState}`}>
                  <strong>{selectedBusy ? "Network: AI đang xử lý" : "Network: request thất bại"}</strong>
                  <span>{selectedBusy ? "Theo dõi trực tiếp vòng đời request của ChatGPT." : (response?.networkError || selectedTab?.network_error || `HTTP ${response?.networkStatusCode || selectedTab?.network_status_code || "error"}`)}</span>
                </div>
              )}
              {sending && (
                <div className="message-send-indicator" role="status" aria-live="polite">
                  <span>{isNewChat ? "Đang tạo chat và gửi" : attachments.length ? "Đang tải file và gửi" : "Đang gửi tin nhắn"}</span>
                  <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
                </div>
              )}
              {responseCleared ? <div className="response-empty">Chat đã được dọn.</div> : !profile.connected ? <div className="response-empty">Extension đang mất heartbeat nên chưa thể cập nhật.</div> : isNewChat ? <div className="response-empty">Chat mới chưa được tạo trên ChatGPT. Gửi tin nhắn đầu tiên để tạo conversation mới trong nền.</div> : selectedNetworkFailed && !hasResponseContent ? <div className="response-error">Request AI đã kết thúc với lỗi network. CodexPro không cần DOM để phát hiện lỗi này.</div> : selectedNetworkCompleted && domUnavailable && !hasResponseContent ? <div className="response-empty network-complete-empty"><strong>AI đã phản hồi xong.</strong><span>Chrome renderer không phản hồi nên chưa đọc được nội dung từ giao diện. Trạng thái hoàn tất được xác nhận trực tiếp từ network.</span></div> : selectedNetworkCompleted && !hasResponseContent ? <div className="response-empty network-complete-empty"><strong>AI đã phản hồi xong.</strong><span>{contentNeedsRefresh ? "CodexPro chưa đụng DOM để đọc nội dung. Bấm “Đọc nội dung” khi bạn cần xem transcript." : "Network đã xác nhận hoàn tất. Bấm “Đọc nội dung” nếu bạn cần tải transcript từ giao diện."}</span></div> : !responseCurrent || response?.loading && !hasResponseContent ? <div className="response-empty"><span className="typing-dots"><i /><i /><i /></span> Đang chờ AI hoàn tất qua network…</div> : response?.error ? <div className="response-error">{response.error}</div> : hasResponseContent ? (
                <div className="latest-response chat-transcript" ref={(element) => { if (element) responseBodyRefs.current.set(profile.profile_id, element); else responseBodyRefs.current.delete(profile.profile_id); }} onWheel={() => holdResponseAutoScroll(profile.profile_id)} onTouchMove={() => holdResponseAutoScroll(profile.profile_id)} onScroll={(event) => pauseResponseAutoScroll(profile.profile_id, event.currentTarget)}>
                  {(displayResponseMessages.length ? displayResponseMessages : [fallbackResponseMessage]).map((message, messageIndex, allMessages) => {
                    const isLastAssistant = message.role === "assistant" && !allMessages.slice(messageIndex + 1).some((candidate) => candidate.role === "assistant");
                    if (message.toolActivity) {
                      return <div className="chat-transcript-message is-tool-activity" key={message.id}><div className="tool-activity-live"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span><span>{message.text}</span></div></div>;
                    }
                    return (
                      <div className={`chat-transcript-message is-${message.role}`} key={message.id}>
                        <div className="chat-message-avatar">{message.role === "user" ? "B" : "✦"}</div>
                        <div className="latest-response-content">
                          <span className="chat-message-role">{message.role === "user" ? "Bạn" : "ChatGPT"}{message.pending ? " · đang gửi" : message.uncertain ? " · chưa xác định đã gửi" : ""}</span>
                          {message.role === "assistant" ? <><ResponseText text={message.text} truncated={message.truncated} />{response.busy && response.networkStreamAvailable && isLastAssistant && <span className="live-stream-tail" aria-label="ChatGPT đang tiếp tục phản hồi"><span className="typing-dots"><i /><i /><i /></span></span>}</> : <div className="chat-message-text user-message-text">{message.text}</div>}
                        </div>
                      </div>
                    );
                  })}
                  {response.busy && !(response.networkStreamAvailable && hasResponseContent) && <div className="chat-transcript-message is-assistant is-typing"><div className="chat-message-avatar">✦</div><div className="latest-response-content"><span className="chat-message-role">ChatGPT</span><span className="thinking-state latest-response-typing"><span>Thinking</span><span className="typing-dots"><i /><i /><i /></span></span></div></div>}
                </div>
              ) : <div className="response-empty">Đoạn chat này chưa có tin nhắn.</div>}
            </div>

            <label className="request-label" htmlFor={`request-${profile.profile_id}`}>Nhắn tiếp</label>
            <div className="request-composer">
              <textarea
                id={`request-${profile.profile_id}`}
                value={draft}
                maxLength={12000}
                placeholder={rolloverCreating ? "Chat cũ đã đầy · đang tạo chat mới để tiếp tục dự án…" : "Nhập tin nhắn hoặc Ctrl+V ảnh như ChatGPT…"}
                onPaste={(event) => void pasteRequestImage(profile.profile_id, event)}
                onChange={(event) => { setRequestDrafts((current) => ({ ...current, [profile.profile_id]: event.target.value })); if (sendError) setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" })); }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent?.isComposing || event.repeat) return;
                  if (!canSend) return;
                  event.preventDefault();
                  void sendRequest(profile);
                }}
                disabled={!profile.connected || sending || rolloverCreating}
              />
              {attachments.length > 0 && (
                <div className="request-files">
                  {attachments.map((file) => (
                    <div className="request-file" key={file.path} title={file.path}>
                      {file.previewDataUrl
                        ? <img className="request-file-image" src={file.previewDataUrl} alt="" />
                        : <span className="request-file-icon">▤</span>}
                      <span className="request-file-copy"><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small></span>
                      <button type="button" aria-label={`Bỏ ${file.name}`} onClick={() => setRequestFiles((current) => ({ ...current, [profile.profile_id]: (current[profile.profile_id] || []).filter((item) => item.path !== file.path) }))} disabled={sending}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="request-composer-toolbar">
                <button type="button" className="attach-button" onClick={() => chooseRequestAttachments(profile.profile_id)} disabled={!profile.connected || sending || rolloverCreating || attachments.length >= 4}><span>＋</span> Thêm file</button>
                <span>{attachments.length ? `${attachments.length}/4 file · ${formatFileSize(attachments.reduce((total, file) => total + file.size, 0))}` : `${draft.length.toLocaleString("vi-VN")}/12.000 · TXT, PDF, mã nguồn, Office, ảnh…`}</span>
              </div>
            </div>
            {sendError && <div className="request-send-error">{sendError}</div>}
            <div className="request-card-foot">
              <span>{selectedBusy ? "Đang nhận phản hồi · realtime ~1 giây" : "Realtime phản hồi ~1 giây"}</span>
              <div className="request-card-actions">
                <button type="button" className="button secondary" onClick={() => setChatProfileId("")}>Đóng</button>
                <button type="button" className="button secondary" onClick={() => openProfile(profile)} disabled={Boolean(busy) || !profile.connected || isNewChat || !(profile.conversation_tabs?.length)}>Mở Chrome</button>
                <button type="button" className="button primary" onClick={() => sendRequest(profile)} disabled={!canSend}>{sending ? (isNewChat ? "Đang tạo chat…" : attachments.length ? "Đang tải file + gửi…" : "Đang gửi…") : rolloverCreating ? "Đang chuyển chat…" : selectedBusy ? "Chat này đang trả lời" : isNewChat ? "Tạo chat + gửi" : "Gửi tin nhắn"}</button>
              </div>
            </div>
          </article>
        </div>
      </div>
    );
  }

  const selectedFont = FONT_OPTIONS.find((option) => option.value === managerSettings.fontFamily) || FONT_OPTIONS[0];
  const appStyle = {
    "--chat-modal-width": `${managerSettings.chatWidth}px`,
    "--chat-response-height": `${managerSettings.chatHeight}px`,
    "--app-font-family": selectedFont.css,
    "--font-xs": `${Math.max(10, managerSettings.fontSize - 2)}px`,
    "--font-base": `${managerSettings.fontSize}px`,
    "--font-brand": `${managerSettings.fontSize + 2}px`,
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
          <button type="button" className={activePage === "settings" ? "active" : ""} onClick={() => setActivePage("settings")}><Icon>⚙</Icon>Cài đặt</button>
        </nav>
        <div className="sidebar-foot">
          <span className="autostart"><Dot ok={status?.autoStart} />{status?.autoStart ? `Tự chạy cùng ${platform}` : "Autostart chưa bật"}</span>
          <small>CodexPro Manager 0.2.68</small>
        </div>
      </aside>

      <main className={activePage === "settings" ? "page-settings" : "page-overview"}>
        <header>
          <div>
            <p className="eyebrow">{activePage === "settings" ? "SETTINGS" : `${platform.toUpperCase()} CONTROL CENTER`}</p>
            <h1>{activePage === "settings" ? "Cài đặt CodexPro" : "CodexPro của bạn"}</h1>
            <p className="subtitle">{activePage === "settings" ? "Quản lý kết nối MCP, popup chat, ảnh worker và font chữ toàn app." : "Một chỗ để xem server, profile và kiểm tra repo."}</p>
          </div>
          {activePage === "overview" && (
            <div className="header-server-actions">
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
            <div className="profile-head-actions">
              <span className="profile-count">{profileSummary.working} làm việc · {profileSummary.idle} rảnh · {profileSummary.hung} mất kết nối · {profileSummary.missing} chưa cài{profileSummary.reload ? ` · ${profileSummary.reload} cần update worker` : ""}</span>
              <button
                className={`button ${profileSummary.reload ? "primary" : "secondary"} reload-all`}
                onClick={reloadProfiles}
                disabled={Boolean(busy) || profileSummary.reload === 0}
                title={profileSummary.reload ? `${profileSummary.reload} profile đang dùng worker cũ hơn ${WORKER_EXTENSION_VERSION}` : `Tất cả profile đã dùng worker ${WORKER_EXTENSION_VERSION}`}
              >
                {busy === "reload-profiles" ? "Đang update worker…" : "Update worker extension"}
              </button>
            </div>
          </div>
          <div className="profile-list">
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
              const idle = profile.connected && profile.activity === "idle" && (profile.connector_installed || !ready);
              const workerState = hung ? "hung" : working || settling ? "working" : "idle";
              const workspaceRoot = String(profile.current_workspace_root || "").trim();
              const directProject = workspaceRoot ? projects.find((project) => String(project.root || "").toLowerCase() === workspaceRoot.toLowerCase()) : null;
              const fallbackProject = profileRepoProject(profile, projects, profileRepoRoots[profile.profile_id]);
              const repoProject = directProject || fallbackProject;
              const repoLabel = String(profile.current_workspace_repo || repoProject?.githubRepo || (repoProject ? `Local · ${repoProject.name}` : "")).trim();
              const repoTitle = repoProject?.githubUrl || repoProject?.remoteUrl || workspaceRoot || repoProject?.root || "Worker chưa xác định được repo GitHub";
              return (
                <article className={`browser-profile ${profile.connected ? "is-online" : "is-offline"}`} key={profile.profile_id}>
                  <WorkerIcon state={workerState} customImages={managerSettings.workerImageDataUrls} />
                  <div className="profile-main">
                    <div className="profile-title">
                      <strong>{profile.email || profile.label}</strong>
                      {profile.active && <span className="badge">ACTIVE</span>}
                      {hung && <span className="badge profile-hung">MẤT KẾT NỐI</span>}
                      {settling && <span className="badge profile-settling">ĐANG HOÀN TẤT</span>}
                      {working && <span className="badge profile-working">ĐANG LÀM VIỆC</span>}
                      {idle && <span className="badge connected">ĐANG RẢNH</span>}
                      {!profile.connector_installed && !profileChecking && !idle && !working && !settling && <span className="badge profile-missing">CHƯA CÓ CODEXPRO</span>}
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
                      {profile.connector_message && <span className={profile.connector_installed ? "ready-text" : "profile-warning"}>{profile.connector_message}</span>}
                    </div>
                  </div>
                  <div className="profile-actions">
                    {!ready && <span className="update-needed">Có worker {WORKER_EXTENSION_VERSION} mới</span>}
                    {profileChecking && <span className="checking-profile">Đang kiểm tra ChatGPT…</span>}
                    <div className="profile-action-buttons">
                      <button
                        className="button primary profile-chat"
                        onClick={() => openChat(profile)}
                        disabled={!profile.connected || !profile.connector_installed || !profileRequestChats(profile).length}
                      >
                        Chat
                      </button>
                      <button
                        className="button secondary open-profile"
                        onClick={() => openProfile(profile)}
                        disabled={Boolean(busy) || !profile.connected || !(profile.conversation_tabs?.length)}
                      >
                        {busy === `open-profile:${profile.profile_id}` ? "Đang mở…" : "Mở profile"}
                      </button>
                    </div>
                    {profile.connector_installed ? (
                      <span className="already-connected">✓ Đã thêm CodexPro</span>
                    ) : (
                      <button
                        className="button primary profile-setup"
                        onClick={() => setupProfile(profile)}
                        disabled={Boolean(busy) || profileChecking || !profile.connected || !ready}
                      >
                        {profileBusy ? "Đang thêm + test…" : "Thêm CodexPro"}
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
                  options={(headlessState.sourceProfiles || []).map((profile) => ({
                    value: profile.profileDirectory,
                    label: profile.userName || profile.name || profile.profileDirectory,
                    hint: `${profile.name || profile.profileDirectory} · ${profile.profileDirectory}`
                  }))}
                  disabled={Boolean(headlessBusy) || !(headlessState.sourceProfiles || []).length}
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
            {!headlessState.supported && <div className="headless-warning">Cần Google Chrome và CodexPro extension đi kèm app. Có thể đặt <code>CODEXPRO_CHROME_PATH</code> nếu Chrome nằm ở vị trí khác.</div>}
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
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">TYPOGRAPHY</p>
                <h2>Font chữ toàn app</h2>
                <p className="section-note">Áp dụng ngay cho sidebar, popup chat, nội dung phản hồi và các control.</p>
              </div>
            </div>
            <div className="font-setting-row">
              <label>Font đang dùng</label>
              <SettingsDropdown
                value={managerSettings.fontFamily}
                options={FONT_OPTIONS}
                disabled={settingsBusy === "save"}
                onChange={(value) => void saveManagerSetting({ fontFamily: value }, "Đã đổi font toàn app")}
              />
              <div className="font-preview" style={{ fontFamily: selectedFont.css, fontSize: `${managerSettings.fontSize}px` }}>Aa Bb Cc · CodexPro đang làm việc · 0123456789</div>
            </div>
            <div className="font-size-setting-row">
              <label>Cỡ chữ</label>
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

      {inspection && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setInspection(null)}>
          <div className="modal">
            <div className="modal-head"><div><p className="eyebrow">MCP INSPECTION</p><h2>{inspection.project.name}</h2></div><button onClick={() => setInspection(null)}>×</button></div>
            <div className="inspection-grid">
              <div><small>Workspace ID</small><code>{inspection.result.workspace_id || "—"}</code></div>
              <div><small>Root</small><code>{inspection.result.root || inspection.project.root}</code></div>
            </div>
            <h3>Git status</h3>
            <pre>{inspection.result.git_status || "Working tree sạch hoặc không có dữ liệu."}</pre>
            <h3>Cây dự án</h3>
            <pre>{inspection.result.tree || inspection.result.tree_text || "CodexPro đã mở workspace thành công."}</pre>
          </div>
        </div>
      )}

      {toast && <div className="toast">✓ {toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
