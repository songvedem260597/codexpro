import React, { useMemo } from "react";
import "./control-center.css";
import { WorkerRunningDuration } from "./worker-running-duration.jsx";
import { WorkspaceCoordinationPanel } from "./workspace-coordination-panel.jsx";

function bytes(value) {
  const size = Math.max(0, Number(value) || 0);
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let current = size / 1024;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current >= 100 ? current.toFixed(0) : current >= 10 ? current.toFixed(1) : current.toFixed(2)} ${units[index]}`;
}

function relativeTime(value) {
  const at = Date.parse(String(value || ""));
  if (!at) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s trước`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  return `${hours} giờ trước`;
}

function durationText(value) {
  const totalSeconds = Math.max(0, Math.round((Number(value) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function activeProfileTab(profile) {
  const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
  return tabs.find((tab) => tab.busy || tab.settling || String(tab?.network_state || "") === "generating") || tabs.find((tab) => tab.active) || tabs[0] || null;
}

export function profileHealth(profile) {
  const tab = activeProfileTab(profile);
  let score = 100;
  const issues = [];
  if (!profile?.connected) { score -= 55; issues.push("mất heartbeat"); }
  if (!profile?.connector_installed) { score -= 25; issues.push("chưa có CodexPro"); }
  if (profile?.connector_profile_bound === false) { score -= 20; issues.push("MCP chưa bind profile"); }
  if (profile?.connector_update_required) { score -= 10; issues.push("worker cũ"); }
  if (tab?.renderer_unresponsive) { score -= 30; issues.push("renderer treo"); }
  if (tab?.message_delivery_timed_out) { score -= 18; issues.push("gửi tin timeout"); }
  if (tab?.connection_interrupted) { score -= 15; issues.push("mất kết nối"); }
  if (String(tab?.network_state || "").toLowerCase() === "failed" || tab?.network_error) { score -= 18; issues.push("network lỗi"); }
  const age = Date.now() - (Date.parse(String(profile?.last_seen || "")) || Date.now());
  if (age > 30_000) { score -= 20; issues.push("heartbeat chậm"); }
  else if (age > 12_000) { score -= 8; issues.push("heartbeat trễ"); }
  score = Math.max(0, Math.min(100, score));
  return { score, issues, state: score >= 90 ? "good" : score >= 70 ? "warn" : "bad" };
}

function projectForTask(task, projects) {
  const root = String(task.root || "").toLowerCase();
  if (root) {
    const direct = projects.find((project) => String(project.root || "").toLowerCase() === root);
    if (direct) return direct;
  }
  const repo = String(task.profile?.current_workspace_repo || "").toLowerCase();
  return repo ? projects.find((project) => String(project.repoFullName || project.githubRepo || "").toLowerCase() === repo) || null : null;
}

function timelineLabel(entry) {
  const action = String(entry?.action || entry?.details?.action || "").toLowerCase();
  if (action.includes("begin") || action.includes("task-routing")) return "Bắt đầu / định tuyến task";
  if (action.includes("open-workspace")) return "Mở workspace";
  if (action.includes("code-graph")) return "Phân tích CodexGraph";
  if (action.includes("read")) return "Đọc source";
  if (action.includes("edit") || action.includes("write") || action.includes("patch")) return "Sửa source";
  if (action.includes("build")) return "Build";
  if (action.includes("test") || action.includes("smoke")) return "Kiểm thử";
  if (action.includes("recover")) return "Khôi phục";
  if (action.includes("reload")) return "Cập nhật worker";
  if (action.includes("response")) return "Đọc phản hồi";
  return String(entry?.message || action || "Hoạt động CodexPro");
}

function Toggle({ checked, onChange, title, hint }) {
  return (
    <button type="button" className={`control-toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="control-toggle-track"><i /></span>
      <span><strong>{title}</strong><small>{hint}</small></span>
    </button>
  );
}

function Empty({ children }) {
  return <div className="control-empty">{children}</div>;
}

function taskExecutionState(job) {
  const progressStage = String(job?.last_progress_stage || "");
  const structuredStage = ["blocked", "stalled", "error", "verifying"].includes(progressStage) ? progressStage : "";
  return String(job?.execution_state || structuredStage || job?.status || "running");
}

function terminalStateLabel(job) {
  const status = taskExecutionState(job);
  if (status === "completed") return "Hoàn thành";
  if (status === "running") return "Chưa hoàn thành";
  if (status === "verifying") return "Đang xác minh";
  if (status === "stalled") return "Đang treo";
  if (status === "error") return "Đang lỗi";
  if (status === "cancelled") return "Đã dừng";
  if (status === "blocked") return "Bị chặn";
  return "Thất bại";
}

function liveTaskStateLabel(state) {
  if (state === "working") return "Đang chạy";
  if (state === "hung" || state === "stalled") return "Bị treo";
  if (state === "blocked") return "Bị chặn";
  if (state === "error") return "Đang lỗi";
  if (state === "verifying" || state === "settling") return "Đang xác minh";
  return "Đang chờ";
}

function TaskProgressSnapshot({ job }) {
  if (!job) return null;
  const reports = Array.isArray(job.progress_reports) ? job.progress_reports : [];
  const latest = reports.length ? reports.at(-1) : null;
  const completed = Array.isArray(job.completed_parts) && job.completed_parts.length ? job.completed_parts : (Array.isArray(latest?.completed_parts) ? latest.completed_parts : []);
  const remaining = Array.isArray(job.remaining_parts) && job.remaining_parts.length ? job.remaining_parts : (Array.isArray(latest?.remaining_parts) ? latest.remaining_parts : []);
  const explicitProgress = Number(job.progress_percent ?? latest?.progress_percent);
  const derivedProgress = completed.length + remaining.length > 0 ? Math.round((completed.length / (completed.length + remaining.length)) * 100) : (job.status === "completed" ? 100 : 0);
  const progress = Math.max(0, Math.min(100, Number.isFinite(explicitProgress) ? Math.round(explicitProgress) : derivedProgress));
  const blockedPart = String(job.blocked_part || latest?.blocked_part || "").trim();
  const blockedReason = String(job.blocked_reason || job.last_progress_reason || latest?.reason || "").trim();
  return (
    <div className="control-task-snapshot">
      <div className="control-task-snapshot-head"><span>Tiến độ</span><strong>{progress}%</strong></div>
      <div className="control-task-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div>
      <div className="control-task-parts">
        <span className="is-done" title={completed.join(" · ")}>{completed.length ? `Đã xong ${completed.length}: ${completed.slice(0, 2).join(" · ")}` : "Chưa ghi nhận phần đã xong"}</span>
        <span className={remaining.length ? "is-remaining" : "is-clear"} title={remaining.join(" · ")}>{remaining.length ? `Chưa xong ${remaining.length}: ${remaining.slice(0, 2).join(" · ")}` : "Không còn phần chưa xong"}</span>
      </div>
      {(blockedPart || blockedReason) && <div className="control-task-blocker"><strong>{blockedPart ? `Treo/chặn tại: ${blockedPart}` : "Task đang bị chặn"}</strong>{blockedReason && <small>{blockedReason}</small>}</div>}
      {job.completion_confirmed === true && <div className="control-task-confirmed">✓ Đã xác nhận hoàn tất{job.completion_confirmed_at ? ` · ${relativeTime(job.completion_confirmed_at)}` : ""}</div>}
    </div>
  );
}

function terminalWorkerLabel(job, profiles, workers) {
  const workerId = String(job?.worker_id || "");
  const profile = profiles.find((item) => item.profile_id === workerId);
  if (profile) return profile.email || profile.label || `Chrome ${workerId.slice(0, 8)}`;
  const worker = workers.find((item) => item.worker_id === workerId || item.local_worker_id === workerId);
  return worker?.label || (workerId.startsWith("api:") ? workerId.slice(4) : "Worker CodexPro");
}

function TerminalTaskSection({ jobs, profiles, workers, projects, mode = "completed" }) {
  const failed = mode === "failed";
  const unfinished = mode === "unfinished";
  const title = unfinished ? "Task chưa hoàn thành" : failed ? "Task thất bại" : "Task hoàn thành";
  const eyebrow = unfinished ? "UNFINISHED TASKS" : failed ? "FAILED TASKS" : "COMPLETED TASKS";
  return (
    <section className={`control-section control-terminal-section is-${mode}`}>
      <div className="control-section-head"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><span className="control-section-count">{jobs.length} task</span></div>
      {!jobs.length ? <Empty>Chưa có {title.toLocaleLowerCase("vi-VN")}.</Empty> : <div className="control-terminal-list">
        {jobs.map((job) => {
          const project = projects.find((item) => String(item.root || "").toLowerCase() === String(job.root || "").toLowerCase());
          const executionState = taskExecutionState(job);
          return <article className={`control-terminal-task is-${executionState}`} key={job.job_id}>
            <span className="control-terminal-state">{terminalStateLabel(job)}</span>
            <div className="control-terminal-main">
              <strong>{job.title || "Task CodexPro"}</strong>
              <small>{terminalWorkerLabel(job, profiles, workers)} · {project?.name || project?.localName || (job.root ? String(job.root).split(/[\\/]/).at(-1) : "Tất cả vùng")}</small>
              {job.error && <p>{job.error}</p>}
              <TaskProgressSnapshot job={job} />
            </div>
            <div className="control-terminal-time">
              <WorkerRunningDuration startedAt={job.started_at || job.prepared_at} finishedAt={job.finished_at || job.updated_at} prefix={job.status === "completed" ? "Hoàn thành trong" : "Hoạt động trong"} />
              <small>{relativeTime(job.finished_at || job.updated_at)}</small>
            </div>
          </article>;
        })}
      </div>}
    </section>
  );
}

export function ControlCenter({
  api = window.codexpro,
  status,
  projects = [],
  performance,
  uiPerformance,
  diagnosticEntries = [],
  settings,
  managerVersion,
  workerVersion,
  platform = "hệ thống",
  profileSummary,
  busy,
  onOpenChat,
  onOpenChrome,
  onRecover,
  onContinueAfterHang,
  onStop,
  onOpenRepo,
  onToggleSetting,
  onUpdateWorkers,
  onRestartServer
}) {
  const profiles = Array.isArray(status?.browserProfiles) ? status.browserProfiles : [];
  const workers = Array.isArray(status?.workers) ? status.workers : [];
  const workerJobs = Array.isArray(status?.workerJobs) ? status.workerJobs : [];
  const taskWorkerJobs = useMemo(() => workerJobs.filter((job) => job?.counts_as_task === true), [workerJobs]);
  const taskHangIncidents = Array.isArray(status?.taskHangIncidents) ? status.taskHangIncidents : [];
  const taskHangSummary = status?.taskHangSummary && typeof status.taskHangSummary === "object" ? status.taskHangSummary : {};
  const recentTaskHangIncidents = taskHangIncidents.slice(0, 24);
  const completedTasks = taskWorkerJobs.filter((job) => job?.status === "completed");
  const failedTasks = taskWorkerJobs.filter((job) => ["failed", "cancelled", "blocked"].includes(String(job?.status)));
  const tasks = useMemo(() => profiles
    .filter((profile) => {
      const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
      return profile.activity === "working" || profile.activity === "settling" || Number(profile.busy_request_count || 0) > 0 || tabs.some((tab) => tab?.busy || tab?.settling || tab?.long_task_watchdog_hung || String(tab?.network_state || "") === "generating");
    })
    .map((profile) => {
      const tab = activeProfileTab(profile);
      const taskId = String(profile.current_task_id || "");
      const job = taskWorkerJobs.find((item) => String(item?.job_id || "") === taskId) || null;
      if (!job) return null;
      const executionState = taskExecutionState(job);
      return {
        profile,
        tab,
        job,
        taskId,
        title: String(profile.current_task_title || "").trim() || String(tab?.title || profile.active_chat_title || "Task chưa có title"),
        root: String(profile.current_workspace_root || ""),
        state: tab?.renderer_unresponsive ? "hung" : ["blocked", "stalled", "error", "verifying"].includes(executionState) ? executionState : (tab?.busy || profile.activity === "working") ? "working" : tab?.settling ? "settling" : "idle",
        startedAt: String(profile.busy_since || tab?.network_last_started_at || "")
      };
    }).filter(Boolean), [profiles, taskWorkerJobs]);
  const liveTaskIds = new Set([
    ...tasks.map((task) => task.taskId),
    ...workers.filter((worker) => worker?.activity === "working").map((worker) => String(worker.current_task_id || ""))
  ].filter(Boolean));
  const unfinishedTasks = taskWorkerJobs.filter((job) => job?.status === "running" && !liveTaskIds.has(String(job?.job_id || "")));

  const taskProjects = useMemo(() => new Map(tasks.map((task) => [task.profile.profile_id, projectForTask(task, projects)])), [tasks, projects]);
  const rootUsage = useMemo(() => {
    const map = new Map();
    for (const task of tasks) {
      const project = taskProjects.get(task.profile.profile_id);
      const root = String(project?.root || task.root || "").toLowerCase();
      if (!root) continue;
      map.set(root, (map.get(root) || 0) + 1);
    }
    return map;
  }, [tasks, taskProjects]);

  const health = profiles.map((profile) => ({ profile, ...profileHealth(profile) })).sort((a, b) => a.score - b.score);
  const runtimeProcesses = Array.isArray(performance?.processes) ? performance.processes : [];
  const managerProcess = runtimeProcesses.find((item) => Number(item.pid) === Number(performance?.managerPid));
  const mcpPids = new Set((status?.processes || []).map((item) => Number(item.pid)).filter(Boolean));
  const mcpProcesses = runtimeProcesses.filter((item) => mcpPids.has(Number(item.pid)));
  const mcpRam = mcpProcesses.reduce((total, item) => total + Number(item.memoryBytes || 0), 0);
  const mcpCpu = mcpProcesses.reduce((total, item) => total + Number(item.cpuPercent || 0), 0);
  const chromeProcesses = runtimeProcesses.filter((item) => String(item.name || "").toLowerCase().includes("chrome"));
  const chromeRam = chromeProcesses.reduce((total, item) => total + Number(item.memoryBytes || 0), 0);
  const chromeCpu = chromeProcesses.reduce((total, item) => total + Number(item.cpuPercent || 0), 0);
  const slowRequests = diagnosticEntries.filter((entry) => Number(entry?.duration_ms || entry?.details?.duration_ms || 0) >= 2000 || /phản hồi chậm|slow/i.test(String(entry?.message || "")));
  const slowestRequestMs = slowRequests.reduce((max, entry) => Math.max(max, Number(entry?.duration_ms || entry?.details?.duration_ms || 0)), 0);
  const recentTimeline = diagnosticEntries.slice(0, 18);
  const problematicRepos = projects.filter((project) => Number(project.conflicted || 0) > 0 || Number(project.behind || 0) > 0 || Number(project.changes || 0) > 0 || (rootUsage.get(String(project.root || "").toLowerCase()) || 0) > 1).slice(0, 12);
  const coordinationRoots = useMemo(() => [...new Set([
    ...tasks.map((task) => String(task.root || "").trim()),
    ...taskWorkerJobs.filter((job) => job?.status === "running").map((job) => String(job.root || "").trim()),
    ...projects.filter((project) => project?.active || project?.inUse).map((project) => String(project.root || "").trim())
  ].filter(Boolean))], [tasks, taskWorkerJobs, projects]);

  return (
    <div className="control-center">
      <section className="control-section">
        <div className="control-section-head">
          <div><p className="eyebrow">UPDATE CENTER</p><h2>Phiên bản</h2></div>
          <div className="control-section-actions">
            <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={onRestartServer}>Restart MCP</button>
            <button className="button secondary" type="button" disabled={Boolean(busy) || !profileSummary?.reload} onClick={onUpdateWorkers}>Update worker</button>
          </div>
        </div>
        <div className="update-center-list">
          <div><span>CodexPro Manager</span><strong>v{managerVersion}</strong><small>Desktop app</small></div>
          <div><span>MCP runtime</span><strong>{status?.local?.ok ? "Online" : "Offline"}</strong><small>{String(status?.local?.data?.runtimeBuildId || "build chưa xác định").slice(0, 26)}</small></div>
          <div><span>Worker extension</span><strong>Target v{workerVersion}</strong><small>{profileSummary?.reload || 0} cần update · {profileSummary?.deferredUpdate || 0} đang bận</small></div>
        </div>
      </section>

      <section className="control-section control-task-section">
        <div className="control-section-head"><div><p className="eyebrow">TASK CENTER</p><h2>Task đang chạy</h2></div><span className="control-section-count">{tasks.length} task</span></div>
        {!tasks.length ? <Empty>Không có task nào đang chạy.</Empty> : (
          <div className="control-task-list">
            {tasks.map((task) => {
              const project = taskProjects.get(task.profile.profile_id);
              const mappingMissing = !task.taskId || !task.root || !task.profile.profile_id || !String(project?.repoFullName || project?.name || "");
              return (
                <article className={`control-task is-${task.state}`} key={`${task.profile.profile_id}:${task.taskId || task.title}`}>
                  <div className="control-task-state"><span className="control-pulse" /><strong>{liveTaskStateLabel(task.state)}</strong></div>
                  <div className="control-task-main">
                    <strong>{task.title}</strong>
                    <div className="control-mapping-row">
                      <span className={task.taskId ? "ok" : "missing"}>Task {task.taskId ? task.taskId.slice(0, 12) : "?"}</span><b>→</b>
                      <span className="ok">{task.profile.label || task.profile.profile_id.slice(0, 8)}</span><b>→</b>
                      <span className={task.root ? "ok" : "missing"}>{project?.name || project?.localName || (task.root ? task.root.split(/[\\/]/).at(-1) : "Workspace ?")}</span><b>→</b>
                      <span className={project?.repoFullName ? "ok" : "missing"}>{project?.repoFullName || task.profile.current_workspace_repo || "Repo ?"}</span>
                    </div>
                    <div className="control-task-progress"><small>{task.tab?.activity_text || "CodexPro đang xử lý"}</small><WorkerRunningDuration startedAt={task.startedAt} /></div>
                    <TaskProgressSnapshot job={task.job} />
                    {project?.isGit && (
                      <div className="control-task-git" title={project.root || task.root}>
                        <span>{project.branch || "detached"}</span>
                        <span>{project.modified || 0} sửa</span>
                        <span>{project.untracked || 0} mới</span>
                        <span>↑{project.ahead || 0}</span>
                        <span>↓{project.behind || 0}</span>
                        {Number(project.conflicted || 0) > 0 && <b>{project.conflicted} conflict</b>}
                      </div>
                    )}
                    {mappingMissing && <div className="control-warning">Thiếu liên kết Task ↔ Profile ↔ Workspace ↔ Repo</div>}
                  </div>
                  <div className="control-task-actions">
                    <button className="button secondary" type="button" onClick={() => onOpenChat(task.profile.profile_id)}>Chat</button>
                    <button className="button secondary" type="button" onClick={() => onOpenChrome(task.profile)}>Chrome</button>
                    <button className="button secondary" type="button" disabled={!project?.root && !task.root} onClick={() => onOpenRepo(project?.root || task.root)}>Repo</button>
                    <button className="button secondary" type="button" disabled={!task.tab?.id || !task.tab?.url} onClick={() => onRecover(task.profile)}>Khôi phục</button>
                    <button className="button danger-quiet" type="button" disabled={!task.tab?.id || !(task.state === "working" || task.state === "settling")} onClick={() => onStop(task)}>Dừng task</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="control-section control-hang-section">
        <div className="control-section-head">
          <div><p className="eyebrow">HANG INCIDENTS</p><h2>Lỗi mạng / OpenAI làm treo task</h2></div>
          <span className={`control-section-count ${Number(taskHangSummary.active_count || 0) > 0 ? "is-danger" : ""}`}>{taskHangSummary.active_count || 0} đang treo · {taskHangSummary.total_count || 0} lần</span>
        </div>
        <div className="control-hang-summary">
          <div><span>Đang treo</span><strong>{taskHangSummary.active_count || 0}</strong><small>incident cần theo dõi</small></div>
          <div><span>Tổng số lần treo</span><strong>{taskHangSummary.total_count || 0}</strong><small>lưu xuyên phiên Manager</small></div>
          <div><span>Do mạng</span><strong>{taskHangSummary.network_count || 0}</strong><small>disconnect · timeout · net::ERR</small></div>
          <div><span>Do OpenAI</span><strong>{taskHangSummary.openai_count || 0}</strong><small>HTTP 4xx / 5xx · 429</small></div>
          <div><span>Tổng thời gian treo</span><strong>{durationText(taskHangSummary.total_duration_ms || 0)}</strong><small>lâu nhất {durationText(taskHangSummary.longest_duration_ms || 0)}</small></div>
        </div>
        <div className="control-hang-policy">CodexPro chỉ ghi nhận khi task đang chạy và có tín hiệu lỗi thực tế. Tab lỗi <strong>không bị tự đóng</strong>; bạn có thể thử khôi phục tab cũ hoặc chủ động đóng tab lỗi và tiếp tục đúng Task ID hiện tại.</div>
        {!recentTaskHangIncidents.length ? <Empty>Chưa ghi nhận task nào treo do mạng hoặc lỗi OpenAI.</Empty> : <div className="control-hang-list">
          {recentTaskHangIncidents.map((incident) => {
            const profile = profiles.find((item) => String(item?.profile_id || "") === String(incident.profile_id || ""));
            const targetTab = (profile?.conversation_tabs || []).find((tab) => Number(tab?.id) === Number(incident.tab_id));
            const sourceLabel = incident.source === "openai" ? "OpenAI" : "Mạng";
            return <article className={`control-hang-row is-${incident.active ? "active" : "resolved"} is-${incident.source || "network"}`} key={incident.id}>
              <div className="control-hang-state">
                <span className={`hang-source is-${incident.source || "network"}`}>{sourceLabel}{Number(incident.status_code || 0) ? ` · ${incident.status_code}` : ""}</span>
                <small>{incident.active ? "Đang treo" : "Đã hồi phục"}</small>
              </div>
              <div className="control-hang-main">
                <strong>{incident.task_title || "Task CodexPro"}</strong>
                <div className="control-hang-meta"><span>Lần treo #{incident.occurrence || 1}</span><span>{incident.task_id ? incident.task_id.slice(0, 16) : "Task ?"}</span><span>{incident.tab_title || `Tab ${incident.tab_id || "?"}`}</span></div>
                <p>{incident.message || incident.network_error || "Không có mô tả lỗi."}</p>
              </div>
              <div className="control-hang-time">
                {incident.active ? <WorkerRunningDuration startedAt={incident.started_at} prefix="Treo" /> : <strong>{durationText(incident.duration_ms || 0)}</strong>}
                <small>{incident.active ? `từ ${relativeTime(incident.started_at)}` : `kết thúc ${relativeTime(incident.ended_at)}`}</small>
              </div>
              <div className="control-hang-actions">
                <button className="button secondary" type="button" disabled={!profile} onClick={() => profile && onOpenChat(profile.profile_id)}>Chat</button>
                <button className="button secondary" type="button" disabled={!profile || !incident.active} onClick={() => profile && onRecover(profile, { conversationId: incident.conversation_id, targetTab })}>Khôi phục tab</button>
                <button className="button danger-quiet" type="button" disabled={!incident.active || !incident.recoverable || !profile} onClick={() => onContinueAfterHang(incident)}>Đóng tab + tiếp tục task</button>
              </div>
            </article>;
          })}
        </div>}
      </section>

      <WorkspaceCoordinationPanel api={api} roots={coordinationRoots} projects={projects} onOpenRepo={onOpenRepo} />

      <div className="control-two-column control-task-history-grid">
        <TerminalTaskSection jobs={completedTasks} profiles={profiles} workers={workers} projects={projects} />
        <TerminalTaskSection jobs={failedTasks} profiles={profiles} workers={workers} projects={projects} mode="failed" />
        <TerminalTaskSection jobs={unfinishedTasks} profiles={profiles} workers={workers} projects={projects} mode="unfinished" />
      </div>

      <div className="control-two-column">
        <section className="control-section">
          <div className="control-section-head"><div><p className="eyebrow">PERFORMANCE</p><h2>Hiệu suất</h2></div><span className={`health-pill ${(uiPerformance?.longTasks || 0) > 2 ? "is-warn" : "is-good"}`}>{Math.round(uiPerformance?.fps || 0)} FPS</span></div>
          <div className="performance-grid">
            <div><span>Manager</span><strong>{managerProcess?.cpuPercent ?? 0}% CPU</strong><small>{bytes(managerProcess?.memoryBytes || 0)} RAM</small></div>
            <div><span>MCP runtime</span><strong>{mcpCpu.toFixed(1)}% CPU</strong><small>{bytes(mcpRam)} RAM</small></div>
            <div><span>Chrome tổng</span><strong>{chromeCpu.toFixed(1)}% CPU</strong><small>{chromeProcesses.length} process · {bytes(chromeRam)}</small></div>
            <div><span>UI thread</span><strong>{Math.round(uiPerformance?.fps || 0)} FPS</strong><small>{uiPerformance?.longTasks || 0} long task / 10s</small></div>
            <div><span>Request chậm</span><strong>{slowRequests.length}</strong><small>{slowestRequestMs ? `chậm nhất ${(slowestRequestMs / 1000).toFixed(1)}s` : "không có trong mẫu gần đây"}</small></div>
            <div><span>System RAM</span><strong>{bytes((performance?.totalMemoryBytes || 0) - (performance?.freeMemoryBytes || 0))}</strong><small>{bytes(performance?.totalMemoryBytes || 0)} tổng</small></div>
          </div>
          {(uiPerformance?.maxLongTaskMs || 0) >= 200 && <div className="control-warning">UI main thread vừa bị block {Math.round(uiPerformance.maxLongTaskMs)} ms.</div>}
        </section>

        <section className="control-section">
          <div className="control-section-head"><div><p className="eyebrow">AUTOMATION</p><h2>Auto Recovery</h2></div></div>
          <div className="control-toggle-list">
            <Toggle checked={settings?.autoRecovery === true} onChange={(value) => onToggleSetting("autoRecovery", value)} title="Tự khôi phục profile treo" hint="Chỉ chạy khi phát hiện renderer/network bất thường rõ ràng." />
            <Toggle checked={settings?.autoUpdateWorkers === true} onChange={(value) => onToggleSetting("autoUpdateWorkers", value)} title="Update worker khi rảnh" hint="Bỏ qua task đang chạy và tự update sau khi worker rảnh." />
            <Toggle checked={settings?.taskNotifications !== false} onChange={(value) => onToggleSetting("taskNotifications", value)} title={`Thông báo ${platform}`} hint="Báo khi task hoàn tất, lỗi hoặc profile bị treo." />
          </div>
        </section>
      </div>

      <section className="control-section">
        <div className="control-section-head"><div><p className="eyebrow">PROFILE HEALTH</p><h2>Health Score</h2></div><span className="control-section-count">{profiles.length} profile</span></div>
        <div className="health-list">
          {health.map(({ profile, score, issues, state }) => (
            <div className="health-row" key={profile.profile_id}>
              <div className={`health-score is-${state}`}>{score}</div>
              <div><strong>{profile.label || `Chrome ${profile.profile_id.slice(0, 8)}`}</strong><small>{issues.length ? issues.join(" · ") : "Kết nối và MCP bình thường"}</small></div>
              <span>{profile.extension_version || "—"}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="control-two-column control-lower-grid">
        <section className="control-section">
          <div className="control-section-head"><div><p className="eyebrow">ACTIVITY TIMELINE</p><h2>Hoạt động gần đây</h2></div></div>
          {!recentTimeline.length ? <Empty>Chưa có timeline gần đây.</Empty> : <div className="control-timeline">
            {recentTimeline.map((entry, index) => (
              <div className={`timeline-row is-${entry.level || "info"}`} key={`${entry.record_id || entry.timestamp}:${index}`}>
                <time>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</time>
                <i />
                <div><strong>{timelineLabel(entry)}</strong><small>{entry.message || entry.action || entry.category}</small></div>
              </div>
            ))}
          </div>}
        </section>

        <section className="control-section">
          <div className="control-section-head"><div><p className="eyebrow">REPO SAFETY</p><h2>Git & xung đột</h2></div></div>
          {!problematicRepos.length ? <Empty>Các repo đang dùng đều sạch và không có cảnh báo.</Empty> : <div className="repo-safety-list">
            {problematicRepos.map((project) => {
              const concurrent = rootUsage.get(String(project.root || "").toLowerCase()) || 0;
              const danger = Number(project.conflicted || 0) > 0 || concurrent > 1;
              return <div className={`repo-safety-row ${danger ? "is-danger" : ""}`} key={project.root}>
                <div><strong>{project.repoFullName || project.name}</strong><small>{project.branch || "not-git"}</small></div>
                <div className="repo-safety-stats">
                  <span>{project.modified || 0} sửa</span><span>{project.untracked || 0} mới</span><span>↑{project.ahead || 0}</span><span>↓{project.behind || 0}</span>
                </div>
                {Number(project.conflicted || 0) > 0 && <b>{project.conflicted} conflict</b>}
                {concurrent > 1 && <b>{concurrent} task cùng repo</b>}
              </div>;
            })}
          </div>}
          {projects.some((project) => (rootUsage.get(String(project.root || "").toLowerCase()) || 0) > 1) && <div className="control-warning">Có nhiều task đang làm cùng repo. CodexPro sẽ cảnh báo để tránh stage/commit chéo thay đổi.</div>}
        </section>
      </div>
    </div>
  );
}
