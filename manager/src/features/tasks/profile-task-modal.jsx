import React, { useEffect } from "react";
import {
  profileTaskCanResume,
  profileTaskJobsForWorker,
  profileTaskLastReason,
  profileTaskProgress,
  profileTaskStatusLabel,
  profileWorkerIsIdleForTaskResume
} from "../../profile-task-popup.js";

function formatTaskTime(job) {
  const raw = job?.updated_at || job?.updatedAt || job?.finished_at || job?.started_at || job?.prepared_at;
  if (!raw) return "Chưa có thời gian";
  const value = new Date(raw);
  return Number.isNaN(value.getTime())
    ? "Chưa có thời gian"
    : value.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

export function ProfileTaskModal({ profile, jobs, resumeBusyTaskId, onClose, onResume }) {
  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  if (!profile) return null;
  const workerIdle = profileWorkerIsIdleForTaskResume(profile);
  const currentTaskId = String(profile.current_task_id || "");
  const profileJobs = profileTaskJobsForWorker(jobs, profile.profile_id, currentTaskId);
  const resumableCount = profileJobs.filter((job) => profileTaskCanResume(job, workerIdle)).length;
  const profileLabel = profile.email || profile.label || `Chrome ${String(profile.profile_id || "").slice(0, 8)}`;

  return (
    <div className="modal-backdrop profile-task-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Danh sách task của ${profileLabel}`} onMouseDown={(event) => event.target === event.currentTarget && !resumeBusyTaskId && onClose()}>
      <div className="modal profile-task-modal">
        <div className="modal-head profile-task-modal-head">
          <div>
            <p className="eyebrow">TASK · {profileLabel}</p>
            <h2>Danh sách task</h2>
            <p>{workerIdle ? `${resumableCount} task có thể tiếp tục ngay.` : "Worker đang bận; chỉ xem task, chưa thể tiếp tục."}</p>
          </div>
          <button type="button" aria-label="Đóng danh sách task" disabled={Boolean(resumeBusyTaskId)} onClick={onClose}><span aria-hidden="true">×</span></button>
        </div>
        <div className={`profile-task-worker-state ${workerIdle ? "is-idle" : "is-busy"}`}>
          <span className="profile-task-worker-dot" />
          <strong>{workerIdle ? "Worker đang rảnh" : "Worker đang bận"}</strong>
          <small>{workerIdle ? "Có thể tiếp tục task thất bại hoặc chưa hoàn thành." : "Nút Tiếp tục sẽ tự bật khi worker trở về trạng thái rảnh."}</small>
        </div>
        {!profileJobs.length ? <div className="empty profile-task-empty">Worker này chưa có task được lưu.</div> : (
          <div className="profile-task-list">
            {profileJobs.map((job) => {
              const taskId = String(job?.job_id || job?.jobId || "");
              const status = String(job?.status || "").toLowerCase();
              const current = Boolean(currentTaskId && taskId === currentTaskId);
              const progress = profileTaskProgress(job);
              const completed = Array.isArray(job?.completed_parts) ? job.completed_parts : [];
              const remaining = Array.isArray(job?.remaining_parts) ? job.remaining_parts : [];
              const reason = profileTaskLastReason(job);
              const canResume = profileTaskCanResume(job, workerIdle) && !resumeBusyTaskId;
              const isResuming = resumeBusyTaskId === taskId;
              return (
                <article className={`profile-task-item is-${status || "unknown"} ${current ? "is-current" : ""}`} key={taskId || `${job?.title}:${job?.updated_at}`}>
                  <div className="profile-task-item-head">
                    <div className="profile-task-item-title">
                      <div><span className={`profile-task-status is-${status || "unknown"}`}>{profileTaskStatusLabel(job)}</span>{current && <span className="profile-task-current">HIỆN TẠI</span>}</div>
                      <strong>{job?.title || "Task CodexPro"}</strong>
                      <code>{taskId || "Task ID chưa xác định"}</code>
                    </div>
                    <time>{formatTaskTime(job)}</time>
                  </div>
                  <div className="profile-task-progress-row"><span>Tiến độ</span><strong>{progress}%</strong></div>
                  <div className="profile-task-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div>
                  {(completed.length > 0 || remaining.length > 0) && <div className="profile-task-parts">
                    <span className="is-done">✓ {completed.length ? completed.slice(0, 2).join(" · ") : "Chưa có phần hoàn tất"}</span>
                    <span className="is-left">→ {remaining.length ? remaining.slice(0, 2).join(" · ") : "Không còn phần chưa xong"}</span>
                  </div>}
                  {reason && status !== "completed" && <div className="profile-task-reason"><span>Lý do gần nhất</span><p>{reason}</p></div>}
                  <div className="profile-task-item-foot">
                    <span>{job?.root ? String(job.root).split(/[\\/]/).at(-1) : "Tất cả vùng được cấp quyền"}</span>
                    {status === "completed" || job?.completion_confirmed === true ? <span className="profile-task-done">✓ Đã hoàn thành</span> : (
                      <button className="button primary profile-task-resume" type="button" disabled={!canResume} title={!workerIdle ? "Chỉ có thể tiếp tục khi worker đang rảnh" : "Tiếp tục task từ checkpoint gần nhất"} onClick={() => void onResume(job)}>{isResuming ? "Đang tiếp tục…" : "Tiếp tục task"}</button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
