function conversationIdFromProfileTab(tab) {
  return String(tab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
}

function terminalWorkerJob(job) {
  const status = String(job?.status || "").toLowerCase();
  return Boolean(job && (["completed", "cancelled"].includes(status) || job?.completion_confirmed === true || job?.completionConfirmed === true));
}

function taskIdForProfileTab(profile, tab) {
  const profileId = String(profile?.profile_id || "");
  const currentTaskId = String(profile?.current_task_id || "");
  const currentTaskConversationId = String(profile?.current_task_conversation_id || "");
  const tabConversationId = conversationIdFromProfileTab(tab);
  if (currentTaskId && currentTaskConversationId && tabConversationId === currentTaskConversationId) return currentTaskId;
  const recorderTaskId = String(tab?.flight_recorder_latest_task_id || "");
  if (recorderTaskId && (!tab?.flight_recorder_latest_profile_id || String(tab.flight_recorder_latest_profile_id) === profileId)) return recorderTaskId;
  return "";
}

export function normalizeTerminalMessageStreamProfiles(profiles, workerJobs) {
  const source = Array.isArray(profiles) ? profiles : [];
  const jobs = Array.isArray(workerJobs) ? workerJobs : [];
  if (!source.length || !jobs.length) return source;
  const jobsById = new Map(jobs.map((job) => [String(job?.job_id || job?.jobId || ""), job]).filter(([id]) => id));
  let anyProfileChanged = false;
  const normalized = source.map((profile) => {
    const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
    let tabsChanged = false;
    const nextTabs = tabs.map((tab) => {
      const networkState = String(tab?.network_state || "").toLowerCase();
      const staleTerminalError = Boolean(
        tab?.message_stream_error === true
        && tab?.settling === true
        && tab?.busy !== true
        && tab?.network_stream_in_progress !== true
        && networkState !== "generating"
      );
      if (!staleTerminalError) return tab;
      const taskId = taskIdForProfileTab(profile, tab);
      const job = taskId ? jobsById.get(taskId) : null;
      if (!terminalWorkerJob(job)) return tab;
      const workerId = String(job?.worker_id || job?.workerId || "");
      if (workerId && workerId !== String(profile?.profile_id || "")) return tab;
      tabsChanged = true;
      return {
        ...tab,
        settling: false,
        message_stream_error: false,
        activity_text: "",
        terminal_message_stream_error: true,
        terminal_message_stream_task_id: taskId,
        terminal_message_stream_activity_text: String(tab?.activity_text || "")
      };
    });
    if (!tabsChanged) return profile;
    const hasLiveTab = nextTabs.some((tab) => tab?.busy === true || tab?.settling === true || tab?.network_stream_in_progress === true || String(tab?.network_state || "").toLowerCase() === "generating");
    const clearProfileSettling = String(profile?.activity || "").toLowerCase() === "settling" && !hasLiveTab && Number(profile?.busy_request_count || 0) === 0;
    anyProfileChanged = true;
    return {
      ...profile,
      conversation_tabs: nextTabs,
      ...(clearProfileSettling ? { activity: "idle", busy_since: "" } : {})
    };
  });
  return anyProfileChanged ? normalized : source;
}
