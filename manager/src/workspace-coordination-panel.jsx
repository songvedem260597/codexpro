import React, { useEffect, useMemo, useState } from "react";
import "./workspace-coordination-panel.css";

function keyForRoot(root) {
  return String(root || "").trim().replace(/\\/g, "/").toLowerCase();
}

function shortSha(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 8) : "—";
}

function shortTask(value) {
  const text = String(value || "").trim();
  return text.startsWith("cpt_") ? text.slice(4, 12) : text.slice(0, 8) || "—";
}

function projectLabel(root, projects) {
  const key = keyForRoot(root);
  const project = projects.find((item) => keyForRoot(item?.root) === key);
  return project?.repoFullName || project?.name || String(root || "").split(/[\\/]/).filter(Boolean).at(-1) || "Workspace";
}

function integrationLabel(status) {
  if (status === "queued") return "ĐANG XẾP HÀNG";
  if (status === "integrating") return "ĐANG TÍCH HỢP";
  if (status === "integrated") return "ĐÃ TÍCH HỢP";
  if (status === "conflict") return "CONFLICT";
  if (status === "failed") return "TÍCH HỢP LỖI";
  return "ĐANG LÀM";
}

function relativeTime(value) {
  const at = Date.parse(String(value || ""));
  if (!Number.isFinite(at)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s trước`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  return `${Math.round(minutes / 60)} giờ trước`;
}

function taskVisible(task) {
  return task?.status === "running" || ["queued", "integrating", "conflict", "failed"].includes(String(task?.integration_status || ""));
}

function RepoCoordinationCard({ snapshot, projects, onOpenRepo }) {
  const tasks = (snapshot.tasks || []).filter(taskVisible);
  const conflicts = tasks.filter((task) => task.stale_base || task.integration_status === "conflict");
  const claims = Array.isArray(snapshot.claims) ? snapshot.claims : [];
  const queue = Array.isArray(snapshot.integration_queue) ? snapshot.integration_queue : [];
  const lease = snapshot.integration_lease;
  const title = projectLabel(snapshot.root, projects);

  return (
    <article className={`coordination-repo ${conflicts.length ? "has-conflict" : ""}`}>
      <div className="coordination-repo-head">
        <div className="coordination-repo-title">
          <strong>{title}</strong>
          <code title={snapshot.root}>{snapshot.root}</code>
        </div>
        <div className="coordination-head-meta">
          <span>{snapshot.current_branch || "detached"}</span>
          <span>{shortSha(snapshot.current_head)}</span>
          <button type="button" className="button secondary" onClick={() => onOpenRepo?.(snapshot.root)}>Repo</button>
        </div>
      </div>

      <div className="coordination-summary-row">
        <span><b>{tasks.length}</b> task theo dõi</span>
        <span><b>{claims.length}</b> file claim</span>
        <span><b>{queue.length}</b> chờ tích hợp</span>
        <span className={conflicts.length ? "is-danger" : "is-safe"}><b>{conflicts.length}</b> xung đột</span>
      </div>

      {lease && (
        <div className="coordination-lease">
          <span className="coordination-live-dot" />
          <div><strong>Integration lease</strong><small>{lease.task_title || `Task ${shortTask(lease.task_id)}`} đang giữ quyền tích hợp · {relativeTime(lease.acquired_at)}</small></div>
        </div>
      )}

      {!tasks.length ? (
        <div className="coordination-empty">Không có task đang chạy, xếp hàng hoặc conflict trong repo này.</div>
      ) : (
        <div className="coordination-task-list">
          {tasks.map((task) => {
            const danger = task.stale_base || task.integration_status === "conflict";
            const active = task.integration_status === "integrating";
            const queued = Number(task.queue_position) > 0;
            const sourceBranch = task.worktree_branch || task.base_branch || "detached";
            const targetBranch = task.integration_branch || task.base_branch || snapshot.current_branch || "target";
            return (
              <div className={`coordination-task ${danger ? "is-danger" : active ? "is-active" : ""}`} key={task.task_id}>
                <div className="coordination-task-top">
                  <div className="coordination-task-copy">
                    <strong>{task.title || `Task ${shortTask(task.task_id)}`}</strong>
                    <small>{task.task_id} · worker {String(task.worker_id || "—").slice(0, 24)}</small>
                  </div>
                  <div className="coordination-badges">
                    <span className={task.worktree_root ? "is-worktree" : ""}>{task.worktree_root ? "WORKTREE" : "SHARED TREE"}</span>
                    {queued && <span className="is-queue">QUEUE #{task.queue_position}</span>}
                    {task.integration_status !== "idle" && <span className={danger ? "is-danger" : active ? "is-active" : ""}>{integrationLabel(task.integration_status)}</span>}
                    {task.base_behind && !task.stale_base && <span className="is-warn">HEAD ĐÃ TIẾN</span>}
                    {task.stale_base && <span className="is-danger">STALE BASE</span>}
                  </div>
                </div>

                <div className="coordination-flow" title={`${sourceBranch} → ${targetBranch}`}>
                  <code>{sourceBranch}</code><b>→</b><code>{targetBranch}</code>
                  <span>base {shortSha(task.base_head)}</span>
                  <span>HEAD {shortSha(task.current_head)}</span>
                </div>

                <div className="coordination-task-stats">
                  <span>{task.claimed_paths?.length || 0} claim</span>
                  <span>{task.touched_paths?.length || 0} touched</span>
                  <span>{task.commit_shas?.length || 0} commit</span>
                  <span>Cập nhật {relativeTime(task.updated_at)}</span>
                </div>

                {task.stale_paths?.length > 0 && (
                  <div className="coordination-conflict-box">
                    <strong>File đã thay đổi sau khi task bắt đầu</strong>
                    <div>{task.stale_paths.slice(0, 8).map((item) => <code key={item}>{item}</code>)}</div>
                    {task.stale_paths.length > 8 && <small>+{task.stale_paths.length - 8} file khác</small>}
                  </div>
                )}

                {task.integration_status === "conflict" && (
                  <div className="coordination-conflict-box">
                    <strong>Integration conflict</strong>
                    <small>CodexPro giữ worktree để recovery thay vì chọn một phía và làm mất code.</small>
                  </div>
                )}

                {task.worktree_root && (danger || active || queued) && (
                  <div className="coordination-task-actions">
                    <button type="button" className="button secondary" onClick={() => onOpenRepo?.(task.worktree_root)}>Mở worktree</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="coordination-lower-grid">
        <div className="coordination-subpanel">
          <div className="coordination-subpanel-head"><strong>File ownership</strong><span>{claims.length}</span></div>
          {!claims.length ? <small className="coordination-muted">Chưa có file nào đang bị task giữ.</small> : (
            <div className="coordination-claim-list">
              {claims.slice(0, 12).map((claim) => (
                <div key={`${claim.task_id}:${claim.path}`}>
                  <code title={claim.path}>{claim.path}</code>
                  <span title={claim.task_title || claim.task_id}>{claim.task_title || `Task ${shortTask(claim.task_id)}`}</span>
                </div>
              ))}
              {claims.length > 12 && <small className="coordination-muted">+{claims.length - 12} file khác</small>}
            </div>
          )}
        </div>

        <div className="coordination-subpanel">
          <div className="coordination-subpanel-head"><strong>Integration queue</strong><span>{queue.length}</span></div>
          {!queue.length ? <small className="coordination-muted">Queue đang trống.</small> : (
            <div className="coordination-queue-list">
              {queue.map((entry) => (
                <div key={`${entry.task_id}:${entry.position}`}>
                  <b>#{entry.position}</b>
                  <span>{entry.task_title || `Task ${shortTask(entry.task_id)}`}</span>
                  <code>{entry.branch || snapshot.current_branch || "target"}</code>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function WorkspaceCoordinationPanel({ api, roots = [], projects = [], onOpenRepo }) {
  const normalizedRoots = useMemo(() => [...new Map(roots.map((root) => [keyForRoot(root), String(root || "").trim()])).values()].filter(Boolean), [roots]);
  const [snapshots, setSnapshots] = useState({});
  const [errors, setErrors] = useState({});
  const [checkedAt, setCheckedAt] = useState("");

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    const refresh = async () => {
      if (!api?.getWorkspaceCoordination || !normalizedRoots.length) {
        if (!disposed) {
          setSnapshots({});
          setErrors({});
        }
        return;
      }
      const nextSnapshots = {};
      const nextErrors = {};
      await Promise.all(normalizedRoots.map(async (root) => {
        try {
          nextSnapshots[keyForRoot(root)] = await api.getWorkspaceCoordination(root);
        } catch (error) {
          nextErrors[keyForRoot(root)] = error?.message || String(error);
        }
      }));
      if (disposed) return;
      setSnapshots(nextSnapshots);
      setErrors(nextErrors);
      setCheckedAt(new Date().toISOString());
      timer = window.setTimeout(refresh, 2500);
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [api, normalizedRoots]);

  const list = normalizedRoots.map((root) => ({ root, key: keyForRoot(root), snapshot: snapshots[keyForRoot(root)], error: errors[keyForRoot(root)] }));
  const active = list.reduce((total, item) => total + Number(item.snapshot?.active_task_count || 0), 0);
  const claims = list.reduce((total, item) => total + (item.snapshot?.claims?.length || 0), 0);
  const queued = list.reduce((total, item) => total + (item.snapshot?.integration_queue?.length || 0), 0);
  const conflicts = list.reduce((total, item) => total + Number(item.snapshot?.conflict_count || 0), 0);

  return (
    <section className="control-section coordination-section">
      <div className="control-section-head coordination-section-head">
        <div><p className="eyebrow">MULTI-AGENT SAFETY</p><h2>Worktree & Integration Queue</h2><p className="coordination-note">Theo dõi ownership thật của file, branch riêng của từng task và điểm xung đột trước khi code được đưa vào nhánh đích.</p></div>
        <div className="coordination-overview">
          <span><b>{active}</b> active</span><span><b>{claims}</b> claim</span><span><b>{queued}</b> queue</span><span className={conflicts ? "is-danger" : "is-safe"}><b>{conflicts}</b> conflict</span>
          {checkedAt && <small>{new Date(checkedAt).toLocaleTimeString("vi-VN")}</small>}
        </div>
      </div>

      {!normalizedRoots.length ? <div className="coordination-empty">Chưa có workspace đang chạy task để theo dõi.</div> : (
        <div className="coordination-repo-list">
          {list.map((item) => item.snapshot ? (
            <RepoCoordinationCard key={item.key} snapshot={item.snapshot} projects={projects} onOpenRepo={onOpenRepo} />
          ) : (
            <div className="coordination-repo coordination-error" key={item.key}>
              <strong>{projectLabel(item.root, projects)}</strong>
              <small>{item.error || "Đang tải trạng thái coordination…"}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
