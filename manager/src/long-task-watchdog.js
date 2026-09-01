export const LONG_TASK_WATCHDOG_AFTER_MS = 30 * 60 * 1000;

function conversationIdFromUrl(value) {
  return String(value || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
}

export function longRunningChatWatchdogCandidate(profile, jobs = [], nowMs = Date.now()) {
  if (!profile?.connected) return null;
  const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
  const tab = tabs.find((item) => item?.busy || item?.settling || String(item?.network_state || "") === "generating")
    || tabs.find((item) => item?.active)
    || tabs[0];
  if (tab?.long_task_watchdog_hung) return null;
  const conversationId = conversationIdFromUrl(tab?.url);
  if (!conversationId || !Number.isInteger(Number(tab?.id))) return null;

  const profileId = String(profile.profile_id || "");
  const taskId = String(profile.current_task_id || "");
  const exactJob = (Array.isArray(jobs) ? jobs : []).find((item) => taskId && String(item?.job_id || "") === taskId);
  if (exactJob && String(exactJob.status || "") !== "running") return null;
  const job = exactJob
    || (Array.isArray(jobs) ? jobs : []).find((item) => String(item?.worker_id || "") === profileId && String(item?.status || "") === "running");
  const liveWorking = Boolean(profile.activity === "working" || Number(profile.busy_request_count || 0) > 0 || tab?.busy || tab?.settling || String(tab?.network_state || "") === "generating");
  if (String(job?.status || "") !== "running" && !liveWorking) return null;

  const startedAt = String(job?.started_at || job?.prepared_at || profile.busy_since || tab?.network_last_started_at || "");
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) return null;
  const ageMs = Math.max(0, Number(nowMs) - startedAtMs);
  if (ageMs < LONG_TASK_WATCHDOG_AFTER_MS) return null;

  const stableTaskId = taskId || String(job?.job_id || "") || conversationId;
  return {
    profileId,
    taskId: stableTaskId,
    title: String(profile.current_task_title || job?.title || tab?.title || profile.active_chat_title || "Task CodexPro"),
    conversationId,
    targetId: Number(tab.id),
    startedAt,
    attemptKey: `${profileId}:${stableTaskId}:${startedAt}`,
    ageMs
  };
}
