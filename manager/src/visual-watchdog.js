export const VISUAL_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

function conversationIdFromUrl(url) {
  return String(url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
}

function terminalWorkerJob(job) {
  const status = String(job?.status || "").trim().toLowerCase();
  return ["completed", "cancelled", "failed"].includes(status)
    || job?.completion_confirmed === true
    || job?.completionConfirmed === true;
}

export function visualWatchdogCandidate(profile, jobs, now = Date.now()) {
  if (!profile?.connected) return null;
  const profileId = String(profile?.profile_id || "").trim();
  const taskId = String(profile?.current_task_id || "").trim();
  if (!profileId || !/^cpt_[a-f0-9]{24}$/.test(taskId)) return null;

  const workerJobs = Array.isArray(jobs) ? jobs : [];
  const job = workerJobs.find((item) =>
    String(item?.job_id || item?.jobId || "") === taskId
    && String(item?.worker_id || item?.workerId || "") === profileId
  );
  if (!job || terminalWorkerJob(job)) return null;
  const jobStatus = String(job?.status || "").trim().toLowerCase();
  if (jobStatus !== "running") return null;

  const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
  const boundConversationId = String(profile?.current_task_conversation_id || "").trim();
  let tab = boundConversationId
    ? tabs.find((item) => conversationIdFromUrl(item?.url) === boundConversationId)
    : null;
  if (!tab) {
    tab = tabs.find((item) => item?.busy || item?.settling || String(item?.network_state || "") === "generating")
      || tabs.find((item) => item?.active)
      || tabs[0];
  }
  if (!tab?.id || tab?.visual_watchdog === true) return null;

  const conversationId = boundConversationId || conversationIdFromUrl(tab.url);
  if (!/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) return null;

  const startedAt = String(
    job?.started_at
    || job?.startedAt
    || job?.prepared_at
    || job?.preparedAt
    || job?.dispatched_at
    || job?.dispatchedAt
    || profile?.busy_since
    || tab?.busy_since
    || tab?.network_last_started_at
    || ""
  ).trim();
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs) || now - startedAtMs < VISUAL_WATCHDOG_INTERVAL_MS) return null;

  return {
    profileId,
    taskId,
    title: String(profile?.current_task_title || tab?.title || "Task CodexPro").trim().slice(0, 300),
    conversationId,
    targetId: Number(tab.id),
    startedAt,
    ageMs: Math.max(0, now - startedAtMs)
  };
}
