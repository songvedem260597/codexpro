const RUNNING_STALE_MS = 60_000;

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function workerOwnerKey(value) {
  const workerId = clean(value, 180);
  return workerId.startsWith("browser:") ? workerId.slice("browser:".length) : workerId;
}

export function taskUnfinalizedIncident(job, { profiles = [], workers = [], now = Date.now() } = {}) {
  if (clean(job?.status, 40) !== "running") return null;
  const jobId = clean(job?.job_id, 80);
  const workerId = clean(job?.worker_id, 180);
  if (!jobId || !workerId) return null;
  const updatedAt = clean(job?.updated_at || job?.started_at || job?.prepared_at, 80);
  const updatedAtMs = Date.parse(updatedAt);
  const staleMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : 0;
  if (staleMs < RUNNING_STALE_MS) return null;

  const ownerKey = workerOwnerKey(workerId);
  const profile = profiles.find((item) => workerOwnerKey(item?.profile_id) === ownerKey);
  const worker = workers.find((item) => workerOwnerKey(item?.worker_id || item?.local_worker_id) === ownerKey || `api:${clean(item?.local_worker_id, 180)}` === workerId);
  const currentTaskId = clean(profile?.current_task_id || worker?.current_task_id, 80);
  const live = profile ? profile?.connected !== false && currentTaskId === jobId : worker ? worker?.connected !== false && currentTaskId === jobId : false;
  if (live) return null;

  let suspectedCause = "worker_missing_or_history_orphaned";
  if (profile) {
    if (profile?.connected === false) suspectedCause = "browser_profile_disconnected_before_finalize";
    else if (currentTaskId && currentTaskId !== jobId) suspectedCause = "browser_task_superseded_without_finalize";
    else suspectedCause = "browser_task_pointer_missing_without_finalize";
  } else if (worker) {
    if (currentTaskId && currentTaskId !== jobId) suspectedCause = "api_task_superseded_without_finalize";
    else suspectedCause = "api_worker_idle_without_finalize";
  }

  const events = Array.isArray(job?.events) ? job.events : [];
  return {
    level: "error",
    source: "manager",
    category: "task-unfinalized",
    action: "task-unfinalized-detected",
    message: `Task chưa chốt trạng thái: ${clean(job?.title, 120) || jobId}`,
    fingerprint: `task-unfinalized:${jobId}`,
    details: {
      classification: "task_unfinalized",
      incident_fingerprint: `task-unfinalized:${jobId}`,
      suspected_cause: suspectedCause,
      job_id: jobId,
      task_id: jobId,
      task_title: clean(job?.title, 120),
      task_kind: clean(job?.kind, 40),
      worker_id: workerId,
      profile_id: profile ? workerId : "",
      workspace_root: clean(job?.root, 2048),
      status: "running",
      prepared_at: clean(job?.prepared_at, 80),
      started_at: clean(job?.started_at, 80),
      updated_at: updatedAt,
      finished_at: clean(job?.finished_at, 80),
      stale_ms: staleMs,
      worker_connected: profile ? profile?.connected !== false : Boolean(worker),
      worker_activity: clean(profile?.activity || worker?.activity || "missing", 40),
      current_task_id: currentTaskId,
      current_task_title: clean(profile?.current_task_title || worker?.current_task_title, 120),
      required_obligations: Array.isArray(job?.required_obligations) ? job.required_obligations : [],
      completed_obligations: Array.isArray(job?.completed_obligations) ? job.completed_obligations : [],
      missing_obligations: Array.isArray(job?.missing_obligations) ? job.missing_obligations : [],
      last_event: events.length ? events.at(-1) : null,
      event_count: events.length
    }
  };
}

export function taskUnfinalizedIncidents(jobs, context = {}) {
  return (Array.isArray(jobs) ? jobs : []).map((job) => taskUnfinalizedIncident(job, context)).filter(Boolean);
}

export const TASK_UNFINALIZED_REPEAT_MS = 10 * 60_000;
