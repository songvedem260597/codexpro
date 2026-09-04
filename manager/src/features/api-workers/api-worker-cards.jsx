import React from "react";
import { ChatGalaxyButtonContent, Dot, WorkerIcon, WorkingBadge } from "../../components/worker-ui.jsx";
import { WorkerRunningDuration } from "../../worker-running-duration.jsx";

export function ApiWorkerCards({ workers, customImages, onRun, onStop }) {
  if (!workers.length) return null;
  return workers.map((worker) => {
    const workerState = !worker.connected || worker.activity === "failed" ? "hung" : worker.activity === "working" ? "working" : "idle";
    const cardState = workerState === "hung" ? "error" : workerState;
    return (
      <article className={`browser-profile api-worker-card ${worker.connected ? "is-online" : "is-offline"} is-${cardState}`} key={worker.worker_id}>
        <span className="worker-active-border" aria-hidden="true" />
        <WorkerIcon state={workerState} customImages={customImages} />
        <div className="profile-main">
          <div className="profile-title">
            <strong>{worker.label}</strong>
            <span className="badge">API WORKER</span>
            <span className="badge">{worker.provider}</span>
            {worker.activity === "working" ? <WorkingBadge /> : <span className={`badge ${worker.connected ? "connected" : "profile-missing"}`}>{worker.connected ? "ĐANG RẢNH" : "THIẾU KEY"}</span>}
          </div>
          {worker.activity === "working" && <WorkerRunningDuration startedAt={worker.started_at} />}
          <div className="profile-meta"><span><Dot ok={worker.connected} />{worker.model}</span><span>MCP-ONLY</span></div>
          {(worker.current_task_title || worker.last_task_title) && <div className="profile-task-summary"><span>{worker.activity === "working" ? "Task hiện tại" : "Task gần nhất"}</span><strong>{worker.current_task_title || worker.last_task_title}</strong></div>}
          {worker.last_error && <div className="profile-warning">{worker.last_error}</div>}
        </div>
        <div className="profile-actions">
          <div className={`profile-action-buttons ${worker.activity === "working" ? "" : "is-single"}`}>
            <button className="button primary profile-chat chat-galaxy-button" type="button" disabled={!worker.connected} onClick={() => onRun(worker)}><ChatGalaxyButtonContent /></button>
            {worker.activity === "working" && <button className="button profile-stop-button" type="button" onClick={() => onStop(worker.worker_id)}>Dừng</button>}
          </div>
          {worker.connected
            ? <span className="already-connected">✓ Đã kết nối CodexPro</span>
            : <span className="api-worker-connection-missing">Chưa kết nối CodexPro</span>}
        </div>
      </article>
    );
  });
}
