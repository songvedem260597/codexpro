export function isLiveCoordinationTask(task) {
  return task?.status === "running";
}

export function liveCoordinationTasks(tasks = []) {
  return (Array.isArray(tasks) ? tasks : []).filter(isLiveCoordinationTask);
}

export function liveCoordinationConflicts(tasks = []) {
  return liveCoordinationTasks(tasks).filter((task) => task?.stale_base || task?.integration_status === "conflict");
}

export function summarizeLiveCoordinationSnapshot(snapshot = {}) {
  const tasks = liveCoordinationTasks(snapshot.tasks);
  const conflicts = liveCoordinationConflicts(tasks);
  const claims = Array.isArray(snapshot.claims) ? snapshot.claims : [];
  const queue = Array.isArray(snapshot.integration_queue) ? snapshot.integration_queue : [];
  return {
    tasks,
    conflicts,
    claims,
    queue,
    task_count: tasks.length,
    claim_count: claims.length,
    queue_count: queue.length,
    conflict_count: conflicts.length,
    has_conflict: conflicts.length > 0
  };
}
