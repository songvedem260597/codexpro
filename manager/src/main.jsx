import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import workerHung from "./assets/worker-hung.gif";
import workerIdle from "./assets/worker-idle.gif";
import workerWorking from "./assets/worker-working.gif";

const api = window.codexpro;
const PROFILE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_CHECK_RETRY_MS = 30 * 60 * 1000;

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
  hung: { src: workerHung, label: "CodexPro đang treo" },
  idle: { src: workerIdle, label: "CodexPro đang rảnh" },
  working: { src: workerWorking, label: "CodexPro đang làm việc" }
};

function WorkerIcon({ state }) {
  const worker = workerIcons[state] || workerIcons.hung;
  return (
    <div className={`profile-worker is-${state}`} title={worker.label}>
      <img src={worker.src} alt={worker.label} />
      <span className="profile-worker-dot" aria-hidden="true" />
    </div>
  );
}

function ChatDropdown({ value, conversations, disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const selected = conversations.find((chat) => chat.id === value);

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
          {selected && <small>{selected.open ? "Đang mở trong Chrome" : "Chat gần đây"}</small>}
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

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionReady(version) {
  const parts = String(version || "").split(".").map(Number);
  const target = [0, 5, 1];
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

function App() {
  const [activePage, setActivePage] = useState(() => new URLSearchParams(window.location.search).get("page") === "requests" ? "requests" : "overview");
  const [status, setStatus] = useState(null);
  const [projects, setProjects] = useState([]);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [inspection, setInspection] = useState(null);
  const [checkingProfiles, setCheckingProfiles] = useState([]);
  const [requestDrafts, setRequestDrafts] = useState({});
  const [requestTargets, setRequestTargets] = useState({});
  const [requestFiles, setRequestFiles] = useState({});
  const [requestResponses, setRequestResponses] = useState({});
  const refreshInFlight = useRef(false);
  const profileCheckTimes = useRef(new Map());
  const responseFetches = useRef(new Set());
  const responseScrollRefs = useRef(new Map());

  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const refresh = useCallback(async (foreground = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (foreground) setBusy("refresh");
    setError("");
    try {
      const [nextStatus, nextProjects] = await Promise.all([api.getStatus(), api.listProjects()]);
      setStatus(nextStatus);
      setProjects(nextProjects);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      refreshInFlight.current = false;
      if (foreground) setBusy("");
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => void refresh(false), 10000);
    return () => window.clearInterval(timer);
  }, [refresh]);

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
    if (activePage !== "requests") return;
    for (const profile of status?.browserProfiles || []) {
      if (!profile.connected) continue;
      const conversations = profileRequestChats(profile);
      const defaultTarget = conversations.find((chat) => chat.active)?.id ?? conversations[0]?.id;
      const conversationId = String(requestTargets[profile.profile_id] || defaultTarget || "");
      if (!conversationId) continue;
      const response = requestResponses[profile.profile_id];
      if (!response || response.conversationId !== conversationId) void loadResponse(profile, conversationId, true);
    }
  }, [activePage, status?.browserProfiles, requestTargets]);

  useEffect(() => {
    if (activePage !== "requests") return undefined;
    const timer = window.setInterval(() => {
      for (const profile of status?.browserProfiles || []) {
        if (!profile.connected) continue;
        const conversations = profileRequestChats(profile);
        const defaultTarget = conversations.find((chat) => chat.active)?.id ?? conversations[0]?.id;
        const conversationId = String(requestTargets[profile.profile_id] || defaultTarget || "");
        if (conversationId) void loadResponse(profile, conversationId, true);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activePage, status?.browserProfiles, requestTargets]);

  useEffect(() => {
    if (activePage !== "requests") return;
    for (const profile of status?.browserProfiles || []) {
      if (!profile.connected || profile.activity !== "working") continue;
      const busyTab = (profile.conversation_tabs || []).find((tab) => tab.busy) || (profile.conversation_tabs || []).find((tab) => tab.active);
      const conversationId = String(busyTab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1];
      if (!conversationId) continue;
      if (requestTargets[profile.profile_id] !== conversationId) {
        setRequestTargets((current) => ({ ...current, [profile.profile_id]: conversationId }));
      }
      const response = requestResponses[profile.profile_id];
      if (!response || response.conversationId !== conversationId) void loadResponse(profile, conversationId, true);
    }
  }, [activePage, status?.browserProfiles]);

  useEffect(() => {
    if (activePage !== "requests") return;
    for (const [profileId, response] of Object.entries(requestResponses)) {
      const container = responseScrollRefs.current.get(profileId);
      if (!container || !response?.messages?.length) continue;
      if (response.busy || container.scrollHeight - container.scrollTop - container.clientHeight < 120) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [activePage, requestResponses]);

  const profileSummary = useMemo(() => {
    const allProfiles = status?.browserProfiles || [];
    const profiles = allProfiles.filter((profile) => profile.connected);
    return {
      working: profiles.filter((profile) => profile.activity === "working").length,
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

  async function reloadProfiles() {
    const needsChromeRestart = profileSummary.reload > 0;
    const message = needsChromeRestart
      ? `Reload nền ${profileSummary.reload} extension cũ? Các tab ChatGPT đang mở sẽ được giữ nguyên.`
      : "Reload extension CodexPro trong tất cả profile đang kết nối?";
    if (!window.confirm(message)) return;
    setBusy("reload-profiles");
    setError("");
    try {
      const result = await api.reloadProfiles();
      notify(result.mode === "bootstrap_reload" ? `Đang nâng ${result.count} profile lên extension mới` : `Đã gửi reload tới ${result.count} profile`);
      window.setTimeout(() => void refresh(false), result.mode === "bootstrap_reload" ? 8000 : 3500);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function sendRequest(profile) {
    const conversations = profileRequestChats(profile);
    const defaultTarget = conversations.find((chat) => chat.active)?.id ?? conversations[0]?.id;
    const conversationId = String(requestTargets[profile.profile_id] ?? defaultTarget ?? "");
    const text = String(requestDrafts[profile.profile_id] || "").trim();
    const attachments = requestFiles[profile.profile_id] || [];
    setBusy(`request:${profile.profile_id}`);
    setError("");
    try {
      const result = await api.sendProfileRequest({ profileId: profile.profile_id, conversationId, text, attachments });
      setRequestDrafts((current) => ({ ...current, [profile.profile_id]: "" }));
      setRequestFiles((current) => ({ ...current, [profile.profile_id]: [] }));
      setRequestResponses((current) => ({ ...current, [profile.profile_id]: { ...(current[profile.profile_id] || {}), visible: true, loading: true, error: "", conversationId } }));
      notify(`Đã gửi${result.attachment_count ? ` ${result.attachment_count} file` : ""} vào ${result.title || profile.active_chat_title || profile.label}`);
      window.setTimeout(() => void loadResponse(profile, conversationId, true), 1200);
      window.setTimeout(() => void refresh(false), 900);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function loadResponse(profile, explicitConversationId, silent = false) {
    const conversations = profileRequestChats(profile);
    const defaultTarget = conversations.find((chat) => chat.active)?.id ?? conversations[0]?.id;
    const conversationId = String(explicitConversationId || requestTargets[profile.profile_id] || defaultTarget || "");
    if (!conversationId || responseFetches.current.has(profile.profile_id)) return null;
    responseFetches.current.add(profile.profile_id);
    if (!silent) {
      setRequestResponses((current) => ({ ...current, [profile.profile_id]: { ...(current[profile.profile_id] || {}), visible: true, loading: true, error: "", conversationId } }));
    }
    try {
      const result = await api.getProfileResponse({ profileId: profile.profile_id, conversationId });
      setRequestResponses((current) => ({
        ...current,
        [profile.profile_id]: {
          visible: true,
          loading: false,
          error: "",
          conversationId,
          text: result.text || "",
          messages: Array.isArray(result.messages) ? result.messages : [],
          busy: Boolean(result.busy),
          truncated: Boolean(result.truncated),
          messageCount: Number(result.message_count) || 0,
          totalMessageCount: Number(result.total_message_count) || 0,
          updatedAt: result.updated_at || new Date().toISOString()
        }
      }));
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

  function toggleResponse(profile) {
    const current = requestResponses[profile.profile_id];
    if (current?.visible) {
      setRequestResponses((responses) => ({ ...responses, [profile.profile_id]: { ...responses[profile.profile_id], visible: false } }));
      return;
    }
    void loadResponse(profile);
  }

  async function chooseRequestAttachments(profileId) {
    setError("");
    try {
      const selected = await api.chooseRequestFiles();
      if (!selected.length) return;
      const current = requestFiles[profileId] || [];
      const merged = [...current, ...selected].filter((file, index, files) => files.findIndex((candidate) => candidate.path === file.path) === index);
      if (merged.length > 4) throw new Error("Mỗi yêu cầu được đính kèm tối đa 4 file.");
      if (merged.reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024) throw new Error("Tổng file đính kèm được tối đa 10 MB.");
      setRequestFiles((files) => ({ ...files, [profileId]: merged }));
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">C</div>
          <div><strong>CodexPro</strong><span>Manager</span></div>
        </div>
        <nav>
          <button className={activePage === "overview" ? "active" : ""} onClick={() => setActivePage("overview")}><Icon>⌁</Icon>Tổng quan</button>
          <button className={activePage === "requests" ? "active" : ""} onClick={() => setActivePage("requests")}><Icon>✎</Icon>Giao việc</button>
        </nav>
        <div className="sidebar-foot">
          <span className="autostart"><Dot ok={status?.autoStart} />{status?.autoStart ? `Tự chạy cùng ${platform}` : "Autostart chưa bật"}</span>
          <small>CodexPro Manager 0.2.9</small>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <p className="eyebrow">{platform.toUpperCase()} CONTROL CENTER</p>
            <h1>{activePage === "requests" ? "Giao việc cho CodexPro" : "CodexPro của bạn"}</h1>
            <p className="subtitle">{activePage === "requests" ? "Gửi yêu cầu vào đúng đoạn chat dự án của từng Chrome profile." : "Một chỗ để xem server, quản lý link MCP và kiểm tra repo."}</p>
          </div>
          <div className="live-refresh"><Dot ok={status?.local?.ok} /><span>Tự động làm mới mỗi 10 giây</span></div>
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
          <div className="action-row">
            <button className="button primary" onClick={() => control("start")} disabled={Boolean(busy)}>Khởi động</button>
            <button className="button secondary" onClick={() => control("restart")} disabled={Boolean(busy)}>{busy === "restart" ? "Đang restart..." : "Restart server"}</button>
          </div>
        </section>

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
            <button className="button secondary" onClick={copyLink} disabled={!status?.mcpLink}><Icon>□</Icon>Copy link</button>
            <button className="button danger-quiet" onClick={rotateLink} disabled={Boolean(busy)}>{busy === "rotate" ? "Đang tạo..." : "Tạo token + link mới"}</button>
            <button className="text-button" onClick={() => api.openExternal("https://chatgpt.com/plugins?q=CodexPro")}>Mở Plugins ChatGPT ↗</button>
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
              <span className="profile-count">{profileSummary.working} làm việc · {profileSummary.idle} rảnh · {profileSummary.hung} treo · {profileSummary.missing} chưa cài{profileSummary.reload ? ` · ${profileSummary.reload} cần reload` : ""}</span>
              <button className="button secondary reload-all" onClick={reloadProfiles} disabled={Boolean(busy) || !(status?.browserProfiles?.some((profile) => profile.connected))}>
                {busy === "reload-profiles" ? "Đang reload…" : profileSummary.reload ? `Reload ${profileSummary.reload} profile` : "Reload tất cả"}
              </button>
            </div>
          </div>
          <div className="profile-list">
            {!status?.browserProfiles?.length && (
              <div className="empty">Chưa có Chrome profile nào kết nối. Hãy Load unpacked extension CodexPro trong profile cần dùng.</div>
            )}
            {status?.browserProfiles?.map((profile) => {
              const ready = extensionReady(profile.extension_version);
              const profileBusy = busy === `profile:${profile.profile_id}`;
              const profileChecking = checkingProfiles.includes(profile.profile_id);
              const hung = !profile.connected;
              const working = profile.connected && profile.activity === "working";
              const idle = profile.connected && profile.activity === "idle" && (profile.connector_installed || !ready);
              const workerState = hung ? "hung" : working ? "working" : "idle";
              return (
                <article className={`browser-profile ${profile.connected ? "is-online" : "is-offline"}`} key={profile.profile_id}>
                  <WorkerIcon state={workerState} />
                  <div className="profile-main">
                    <div className="profile-title">
                      <strong>{profile.email || profile.label}</strong>
                      {profile.active && <span className="badge">ACTIVE</span>}
                      {hung && <span className="badge profile-hung">TREO</span>}
                      {working && <span className="badge profile-working">ĐANG LÀM VIỆC</span>}
                      {idle && <span className="badge connected">ĐANG RẢNH</span>}
                      {!profile.connector_installed && !profileChecking && !idle && !working && <span className="badge profile-missing">CHƯA CÓ CODEXPRO</span>}
                    </div>
                    <code>{profile.email ? profile.label : profile.profile_id}</code>
                    <div className="profile-meta">
                      <span><Dot ok={profile.connected} />{profile.connected ? "Extension online" : "Extension offline"}</span>
                      <span>v{profile.extension_version || "cũ"}</span>
                      <span>{profile.tab_count} tab</span>
                      {profile.active_chat_title && <span className="chat-title">Chat: {profile.active_chat_title}</span>}
                      {profile.connector_message && <span className={profile.connector_installed ? "ready-text" : "profile-warning"}>{profile.connector_message}</span>}
                    </div>
                  </div>
                  <div className="profile-actions">
                    {!ready && <span className="update-needed">Reload extension 0.5.1</span>}
                    {profileChecking && <span className="checking-profile">Đang kiểm tra ChatGPT…</span>}
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
            <div><p className="eyebrow">WORKSPACES</p><h2>Repo và dự án</h2><p className="section-note">Từ profile/runtime CodexPro và các thư mục bạn tự thêm.</p></div>
            <button className="button secondary" onClick={addProject} disabled={Boolean(busy)}>+ Thêm dự án</button>
          </div>
          <div className="project-list">
            {projects.length === 0 && <div className="empty">Chưa tìm thấy dự án CodexPro.</div>}
            {projects.map((project) => (
              <article className="project" key={project.root}>
                <div className="repo-icon">{project.name.slice(0, 1).toUpperCase()}</div>
                <div className="project-main">
                  <div className="project-title"><strong>{project.name}</strong>{project.active && <span className="badge">ĐANG CHẠY</span>}</div>
                  <code>{project.root}</code>
                  <div className="project-meta">
                    <span>{project.source}</span>
                    <span>{project.isGit ? `nhánh ${project.branch}` : "không phải Git repo"}</span>
                    <span className={project.changes ? "changed" : "clean"}>{project.changes ? `${project.changes} thay đổi` : "sạch"}</span>
                    {project.commit?.hash && <span>{project.commit.hash} · {project.commit.subject}</span>}
                  </div>
                </div>
                <div className="project-actions">
                  <button onClick={() => inspect(project)} disabled={Boolean(busy)}>{busy === project.root ? "Đang kiểm tra..." : "Kiểm tra qua MCP"}</button>
                  <button onClick={() => api.openFolder(project.root)}>Mở thư mục</button>
                  {!project.active && project.source === "Đã thêm" && <button className="remove" title="Bỏ khỏi danh sách" onClick={async () => setProjects(await api.removeProject(project.root))}>×</button>}
                </div>
              </article>
            ))}
          </div>
        </section>
        </div>

        <section className="request-page" hidden={activePage !== "requests"}>
          <div className="section-head">
            <div>
              <p className="eyebrow">CHATGPT PROJECT REQUESTS</p>
              <h2>Đoạn chat theo profile</h2>
              <p className="section-note">Chọn đúng đoạn chat rồi nhập yêu cầu. Chat đang làm việc sẽ tự mở phản hồi trực tiếp; app không gửi nếu profile bị treo hoặc ô ChatGPT đang có nội dung/file chưa gửi.</p>
            </div>
            <span className="profile-count">{(status?.browserProfiles || []).filter((profile) => profile.connected && profile.connector_installed).length} profile sẵn sàng</span>
          </div>
          <div className="request-grid">
            {(status?.browserProfiles || []).filter((profile) => profile.connector_installed).map((profile) => {
              const conversations = profileRequestChats(profile);
              const defaultTarget = conversations.find((chat) => chat.active)?.id ?? conversations[0]?.id ?? "";
              const selectedTarget = requestTargets[profile.profile_id] ?? defaultTarget;
              const sending = busy === `request:${profile.profile_id}`;
              const working = profile.connected && profile.activity === "working";
              const workerState = !profile.connected ? "hung" : working ? "working" : "idle";
              const draft = requestDrafts[profile.profile_id] || "";
              const attachments = requestFiles[profile.profile_id] || [];
              const response = requestResponses[profile.profile_id];
              const responseCurrent = response?.conversationId === selectedTarget;
              const messages = responseCurrent && Array.isArray(response?.messages)
                ? response.messages
                : responseCurrent && response?.text
                  ? [{ id: "assistant-latest", role: "assistant", text: response.text, truncated: response.truncated }]
                  : [];
              return (
                <article className={`request-card ${profile.connected ? "is-online" : "is-offline"}`} key={profile.profile_id}>
                  <div className="request-card-head">
                    <WorkerIcon state={workerState} />
                    <div>
                      <div className="profile-title"><strong>{profile.email || profile.label}</strong>{working ? <span className="badge profile-working">ĐANG LÀM VIỆC</span> : profile.connected ? <span className="badge connected">ĐANG RẢNH</span> : <span className="badge profile-hung">TREO</span>}</div>
                      <code>{profile.profile_id}</code>
                    </div>
                  </div>
                  <label className="request-label">Đoạn chat dự án</label>
                  <ChatDropdown value={selectedTarget} conversations={conversations} onChange={(id) => {
                    setRequestTargets((current) => ({ ...current, [profile.profile_id]: id }));
                    setRequestResponses((current) => ({ ...current, [profile.profile_id]: { visible: true, loading: true, error: "", conversationId: id, messages: [] } }));
                    void loadResponse(profile, id, true);
                  }} disabled={!profile.connected || !conversations.length || sending} />
                  <label className="request-label">Hội thoại trực tiếp</label>
                  <div className={`chat-response is-inline ${responseCurrent && response?.busy ? "is-streaming" : ""}`}>
                    <div className="chat-response-head">
                      <div><span className="response-status-dot" /><strong>{responseCurrent && response?.busy ? "ChatGPT đang trả lời…" : "Đồng bộ với ChatGPT"}</strong>{responseCurrent && response?.updatedAt && <small>{new Date(response.updatedAt).toLocaleTimeString("vi-VN")}</small>}</div>
                      {responseCurrent && response?.text && <button type="button" onClick={async () => { await api.copyText(response.text); notify("Đã copy phản hồi mới nhất"); }}>Copy phản hồi</button>}
                    </div>
                    <div className="chat-thread" ref={(element) => { if (element) responseScrollRefs.current.set(profile.profile_id, element); else responseScrollRefs.current.delete(profile.profile_id); }}>
                      {!profile.connected ? <div className="response-empty">Profile đang offline nên chưa thể đồng bộ đoạn chat.</div> : !responseCurrent || response?.loading && !messages.length ? <div className="response-empty"><span className="typing-dots"><i /><i /><i /></span> Đang tải hội thoại…</div> : response?.error ? <div className="response-error">{response.error}</div> : messages.length ? messages.map((message, index) => (
                        <div className={`chat-message ${message.role === "user" ? "is-user" : "is-assistant"}`} key={`${message.id || message.role}-${index}`}>
                          {message.role !== "user" && <div className="chat-message-avatar">✦</div>}
                          <div className="chat-message-content">
                            <span className="chat-message-role">{message.role === "user" ? "Bạn" : "ChatGPT"}</span>
                            <div className="chat-message-text">{message.text}{message.truncated ? "\n\n[Đã rút gọn khi hiển thị]" : ""}</div>
                          </div>
                        </div>
                      )) : <div className="response-empty">Đoạn chat này chưa có tin nhắn để hiển thị.</div>}
                      {responseCurrent && response?.busy && <div className="chat-message is-assistant is-typing"><div className="chat-message-avatar">✦</div><div className="chat-message-content"><span className="chat-message-role">ChatGPT</span><span className="typing-dots"><i /><i /><i /></span></div></div>}
                    </div>
                  </div>
                  <label className="request-label" htmlFor={`request-${profile.profile_id}`}>Nhắn tiếp</label>
                  <div className="request-composer">
                    <textarea id={`request-${profile.profile_id}`} value={draft} maxLength={12000} placeholder="Nhập tin nhắn như đang chat với ChatGPT…" onChange={(event) => setRequestDrafts((current) => ({ ...current, [profile.profile_id]: event.target.value }))} disabled={!profile.connected || sending} />
                    {attachments.length > 0 && (
                      <div className="request-files">
                        {attachments.map((file) => (
                          <div className="request-file" key={file.path} title={file.path}>
                            <span className="request-file-icon">▤</span>
                            <span className="request-file-copy"><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small></span>
                            <button type="button" aria-label={`Bỏ ${file.name}`} onClick={() => setRequestFiles((current) => ({ ...current, [profile.profile_id]: (current[profile.profile_id] || []).filter((item) => item.path !== file.path) }))} disabled={sending}>×</button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="request-composer-toolbar">
                      <button type="button" className="attach-button" onClick={() => chooseRequestAttachments(profile.profile_id)} disabled={!profile.connected || sending || attachments.length >= 4}><span>＋</span> Thêm file</button>
                      <span>{attachments.length ? `${attachments.length}/4 file · ${formatFileSize(attachments.reduce((total, file) => total + file.size, 0))}` : `${draft.length.toLocaleString("vi-VN")}/12.000 · TXT, PDF, mã nguồn, Office, ảnh…`}</span>
                    </div>
                  </div>
                  <div className="request-card-foot">
                    <span>{responseCurrent && response?.busy ? "Đang nhận phản hồi trực tiếp · tự cập nhật ~1 giây" : "Tự đồng bộ hội thoại ~1 giây"}</span>
                    <div className="request-card-actions">
                      <button className="button primary" onClick={() => sendRequest(profile)} disabled={Boolean(busy) || !profile.connected || working || !conversations.length || (!draft.trim() && !attachments.length)}>{sending ? "Đang tải file + gửi…" : working ? "ChatGPT đang trả lời" : "Gửi tin nhắn"}</button>
                    </div>
                  </div>
                </article>
              );
            })}
            {!(status?.browserProfiles || []).some((profile) => profile.connector_installed) && <div className="empty">Chưa có profile nào đã kết nối CodexPro.</div>}
          </div>
        </section>
      </main>

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
