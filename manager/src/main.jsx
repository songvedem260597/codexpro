import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const api = window.codexpro;

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

function App() {
  const [status, setStatus] = useState(null);
  const [projects, setProjects] = useState([]);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [inspection, setInspection] = useState(null);
  const refreshInFlight = useRef(false);

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
  const onlineCount = useMemo(() => [status?.local?.ok, status?.tunnel?.ok, status?.task?.state === "Running"].filter(Boolean).length, [status]);

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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">C</div>
          <div><strong>CodexPro</strong><span>Manager</span></div>
        </div>
        <nav>
          <a className="active" href="#overview"><Icon>⌁</Icon>Tổng quan</a>
          <a href="#projects"><Icon>▱</Icon>Dự án</a>
          <a href="#connection"><Icon>↗</Icon>Kết nối</a>
        </nav>
        <div className="sidebar-foot">
          <span><Dot ok={onlineCount === 3} />{onlineCount === 3 ? "Hoạt động tốt" : "Cần kiểm tra"}</span>
          <span className="autostart"><Dot ok={status?.autoStart} />{status?.autoStart ? `Tự chạy cùng ${platform}` : "Autostart chưa bật"}</span>
          <small>CodexPro Manager 0.1.0</small>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <p className="eyebrow">{platform.toUpperCase()} CONTROL CENTER</p>
            <h1>CodexPro của bạn</h1>
            <p className="subtitle">Một chỗ để xem server, quản lý link MCP và kiểm tra repo.</p>
          </div>
          <div className="live-refresh"><Dot ok={status?.local?.ok} /><span>Tự động làm mới mỗi 10 giây</span></div>
        </header>

        {error && <div className="alert"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}

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
            <button className="text-button" onClick={() => api.openExternal("https://chatgpt.com/#settings/Connectors")}>Mở cài đặt ChatGPT ↗</button>
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
