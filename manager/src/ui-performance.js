const browserProfileSignatureCache = new WeakMap();
export const EMPTY_BROWSER_PROFILE_GRACE_MS = 15_000;

export function browserProfileUiSignature(profile) {
  if (!profile || typeof profile !== "object") return "";
  const cached = browserProfileSignatureCache.get(profile);
  if (cached) return cached;
  const { last_seen: _lastSeen, ...uiState } = profile;
  const signature = JSON.stringify(uiState);
  browserProfileSignatureCache.set(profile, signature);
  return signature;
}

export function mergeBrowserProfilePayload(previousProfiles, incomingProfiles) {
  const previous = Array.isArray(previousProfiles) ? previousProfiles : [];
  const incoming = Array.isArray(incomingProfiles) ? incomingProfiles : [];
  if (!previous.length) return incoming;
  const previousById = new Map(previous.map((profile) => [profile.profile_id, profile]));
  let changed = previous.length !== incoming.length;
  const merged = incoming.map((profile) => {
    const prior = previousById.get(profile.profile_id);
    if (!prior) {
      changed = true;
      return profile;
    }
    const candidate = { ...prior, ...profile };
    if (browserProfileUiSignature(prior) === browserProfileUiSignature(candidate)) return prior;
    changed = true;
    return candidate;
  });
  if (!changed && incoming.every((profile) => previousById.has(profile.profile_id))) return previous;
  return merged;
}

export function stabilizeEmptyBrowserProfileSnapshot(previousProfiles, incomingProfiles, options = {}) {
  const removedProfileIds = new Set(
    (Array.isArray(options.removedProfileIds) ? options.removedProfileIds : [])
      .map((profileId) => String(profileId || ""))
      .filter(Boolean)
  );
  const previousSource = Array.isArray(previousProfiles) ? previousProfiles : [];
  const previous = removedProfileIds.size
    ? previousSource.filter((profile) => !removedProfileIds.has(String(profile?.profile_id || "")))
    : previousSource;
  const incoming = Array.isArray(incomingProfiles) ? incomingProfiles : [];
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const graceMs = Number.isFinite(options.graceMs) ? Math.max(0, options.graceMs) : EMPTY_BROWSER_PROFILE_GRACE_MS;
  const emptySinceMs = Number.isFinite(options.emptySinceMs) ? Math.max(0, options.emptySinceMs) : 0;

  if (incoming.length || !previous.length) {
    return {
      profiles: mergeBrowserProfilePayload(previous, incoming),
      emptySinceMs: 0,
      preserved: false,
      retryAfterMs: 0
    };
  }

  const startedAt = emptySinceMs || nowMs;
  const elapsedMs = Math.max(0, nowMs - startedAt);
  if (elapsedMs < graceMs) {
    return {
      profiles: previous,
      emptySinceMs: startedAt,
      preserved: true,
      retryAfterMs: Math.max(1, graceMs - elapsedMs)
    };
  }

  return {
    profiles: [],
    emptySinceMs: 0,
    preserved: false,
    retryAfterMs: 0
  };
}

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

export function mergeRuntimeStatus(previousStatus, incomingStatus) {
  if (!incomingStatus || typeof incomingStatus !== "object") return previousStatus;
  const previous = previousStatus && typeof previousStatus === "object" ? previousStatus : null;
  const workerSnapshotAvailable = incomingStatus.workerSnapshotAvailable !== false;
  const workerJobsAvailable = incomingStatus.workerJobsAvailable !== false;
  const workerJobs = workerJobsAvailable ? incomingStatus.workerJobs : (previous?.workerJobs || []);

  if (workerSnapshotAvailable) {
    const normalizedProfiles = normalizeTerminalMessageStreamProfiles(incomingStatus.browserProfiles, workerJobs);
    const browserProfiles = mergeBrowserProfilePayload(previous?.browserProfiles, normalizedProfiles);
    return {
      ...incomingStatus,
      browserProfiles,
      workerJobs,
      workerSnapshotStale: false,
      workerSnapshotStaleSince: ""
    };
  }

  return {
    ...incomingStatus,
    browserProfiles: previous?.browserProfiles || incomingStatus.browserProfiles || [],
    workers: previous?.workers || incomingStatus.workers || [],
    workerSources: previous?.workerSources || incomingStatus.workerSources || [],
    workerJobs: workerJobsAvailable ? incomingStatus.workerJobs : (previous?.workerJobs || incomingStatus.workerJobs || []),
    workerSnapshotStale: true,
    workerSnapshotStaleSince: previous?.workerSnapshotStaleSince || incomingStatus.checkedAt || new Date().toISOString()
  };
}

export function sameProjectList(previousProjects, nextProjects) {
  const previous = Array.isArray(previousProjects) ? previousProjects : [];
  const next = Array.isArray(nextProjects) ? nextProjects : [];
  if (previous.length !== next.length) return false;
  return previous.every((project, index) => JSON.stringify(project) === JSON.stringify(next[index]));
}
