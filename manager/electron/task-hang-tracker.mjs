import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_INCIDENTS = 500;
const SNAPSHOT_LIMIT = 160;
const ACTIVE_PERSIST_INTERVAL_MS = 30_000;
const RECENT_ERROR_WINDOW_MS = 10 * 60_000;
export const TASK_NO_MEANINGFUL_PROGRESS_MS = 10 * 60_000;

function asTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function conversationIdFromUrl(value) {
  try {
    return new URL(String(value || "")).pathname.match(/^\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
  } catch {
    return String(value || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
  }
}

function httpStatusFromText(value) {
  const text = String(value || "");
  const explicit = text.match(/\b(?:HTTP|status(?:\s+code)?(?:\s+of)?)\s*[:=]?\s*(4\d\d|5\d\d)\b/i)?.[1]
    || text.match(/\bserver responded with a status of\s*(4\d\d|5\d\d)\b/i)?.[1];
  return explicit ? Number(explicit) : /\btoo many requests\b/i.test(text) ? 429 : 0;
}

function relevantToCurrentTask(profile, tab, incidentAt, taskId, nowMs) {
  if (!incidentAt) return false;
  if (nowMs - incidentAt > RECENT_ERROR_WINDOW_MS) return false;
  const taskStartedAt = asTime(profile?.busy_since);
  if (taskStartedAt && incidentAt + 5_000 < taskStartedAt) return false;
  const incidentTaskId = String(tab?.flight_recorder_latest_task_id || tab?.rate_limit_latest_task_id || profile?.rate_limit_latest_task_id || "");
  return !incidentTaskId || !taskId || incidentTaskId === taskId;
}

function selectedTaskTab(profile) {
  const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
  const currentConversationId = String(profile?.current_task_conversation_id || "");
  return tabs.find((tab) => currentConversationId && conversationIdFromUrl(tab?.url) === currentConversationId)
    || tabs.find((tab) => tab?.long_task_watchdog_hung || tab?.message_stream_error || tab?.message_delivery_timed_out || tab?.connection_interrupted || String(tab?.network_state || "").toLowerCase() === "failed" || tab?.network_error)
    || tabs.find((tab) => tab?.busy || tab?.settling)
    || tabs.find((tab) => tab?.active)
    || tabs[0]
    || null;
}

function jobForTask(jobs, profileId, taskId) {
  return (Array.isArray(jobs) ? jobs : []).find((job) => {
    const jobId = String(job?.job_id || job?.jobId || "").trim();
    const workerId = String(job?.worker_id || job?.workerId || "").trim();
    return jobId === taskId && (!workerId || workerId === profileId);
  }) || null;
}

function latestMeaningfulProgressAt(profile, tab, job) {
  return Math.max(
    asTime(job?.last_progress_at || job?.lastProgressAt),
    asTime(job?.updated_at || job?.updatedAt),
    asTime(job?.started_at || job?.startedAt),
    asTime(tab?.network_stream_updated_at),
    asTime(tab?.network_last_started_at),
    asTime(tab?.network_last_completed_at),
    asTime(profile?.busy_since)
  );
}

function hangCandidateForProfile(profile, nowMs, jobs = []) {
  const profileId = String(profile?.profile_id || "").trim();
  const taskId = String(profile?.current_task_id || "").trim();
  const taskTitle = String(profile?.current_task_title || profile?.active_chat_title || "Task CodexPro").trim();
  const tab = selectedTaskTab(profile);
  if (!profileId || !taskId) return null;
  const activity = String(profile?.activity || "").toLowerCase();
  const taskLive = activity === "working" || activity === "settling" || Number(profile?.busy_request_count || 0) > 0 || tab?.busy || tab?.settling || tab?.long_task_watchdog_hung;
  if (!taskLive) return null;

  const job = jobForTask(jobs, profileId, taskId);
  const jobStatus = String(job?.status || "").toLowerCase();
  const progressAnchorAt = latestMeaningfulProgressAt(profile, tab, job);
  const noMeaningfulProgress = Boolean(jobStatus === "running" && progressAnchorAt > 0 && nowMs - progressAnchorAt >= TASK_NO_MEANINGFUL_PROGRESS_MS);
  if (!tab?.id && !noMeaningfulProgress) return null;

  const networkState = String(tab?.network_state || "").toLowerCase();
  const networkError = String(tab?.network_error || "").trim();
  const messageStreamError = tab?.message_stream_error === true;
  const connectionInterrupted = tab?.connection_interrupted === true;
  const deliveryTimedOut = tab?.message_delivery_timed_out === true;
  const watchdogHung = tab?.long_task_watchdog_hung === true;
  const networkFailed = networkState === "failed" || Boolean(networkError) || messageStreamError || connectionInterrupted || deliveryTimedOut;

  const rateAt = asTime(tab?.rate_limit_latest_at || profile?.rate_limit_latest_at);
  const flightAt = asTime(tab?.flight_recorder_latest_at || profile?.flight_recorder_latest_at);
  const rateRelevant = relevantToCurrentTask(profile, tab, rateAt, taskId, nowMs);
  const flightRelevant = relevantToCurrentTask(profile, tab, flightAt, taskId, nowMs);
  const rateMessage = String(tab?.rate_limit_latest_message || profile?.rate_limit_latest_message || "");
  const flightMessage = String(tab?.flight_recorder_latest_message || profile?.flight_recorder_latest_message || "");
  const directStatus = Math.max(0, Number(tab?.network_status_code) || 0);
  const rateStatus = Math.max(0, Number(tab?.rate_limit_latest_status_code || profile?.rate_limit_latest_status_code) || 0);
  const inferredStatus = httpStatusFromText(`${networkError} ${rateRelevant ? rateMessage : ""} ${flightRelevant ? flightMessage : ""}`);
  const statusCode = directStatus || (rateRelevant ? rateStatus || 429 : 0) || inferredStatus;
  const openAiError = messageStreamError || statusCode >= 400 || (rateRelevant && Number(tab?.rate_limit_incident_count || profile?.rate_limit_incident_count || 0) > 0);
  const networkTransportError = connectionInterrupted || deliveryTimedOut || /\b(?:net::|ERR_|fetch failed|network|connection|socket|timeout|timed out|offline)\b/i.test(networkError);
  const hangSignal = networkFailed || noMeaningfulProgress || (watchdogHung && (openAiError || networkTransportError || rateRelevant || flightRelevant));
  if (!hangSignal) return null;

  const source = openAiError ? "openai" : noMeaningfulProgress ? "stalled" : "network";
  const conversationId = String(profile?.current_task_conversation_id || conversationIdFromUrl(tab?.url));
  const errorHintAt = Math.max(
    rateRelevant ? rateAt : 0,
    flightRelevant ? flightAt : 0,
    networkState === "failed" ? asTime(tab?.network_last_completed_at) : 0
  );
  const startedHintMs = noMeaningfulProgress ? Math.min(nowMs, progressAnchorAt + TASK_NO_MEANINGFUL_PROGRESS_MS) : errorHintAt || nowMs;
  const message = (
    openAiError
      ? (rateRelevant ? rateMessage : "") || (flightRelevant ? flightMessage : "") || networkError
      : networkError
  ) || (noMeaningfulProgress
    ? `Task vẫn ở trạng thái running nhưng không có tiến triển có ý nghĩa trong ${Math.round(TASK_NO_MEANINGFUL_PROGRESS_MS / 60_000)} phút.`
    : messageStreamError ? "ChatGPT báo Error in message stream." : deliveryTimedOut ? "Gửi tin nhắn vượt thời gian chờ." : connectionInterrupted ? "Kết nối tới ChatGPT bị gián đoạn." : watchdogHung ? "Watchdog xác nhận task không còn tiến triển sau lỗi mạng." : "Task bị treo sau lỗi mạng.");
  const causes = [openAiError ? "openai" : "", noMeaningfulProgress ? "stalled" : "", networkTransportError ? "network" : ""].filter(Boolean);
  return {
    key: `${profileId}:${taskId}:${conversationId || "no-conversation"}:${Number(tab?.id) || 0}:${source}`,
    profile_id: profileId,
    task_id: taskId,
    task_title: taskTitle,
    conversation_id: conversationId,
    tab_id: Number(tab?.id) || 0,
    tab_title: String(tab?.title || profile?.active_chat_title || "ChatGPT").slice(0, 300),
    source,
    causes: [...new Set(causes)],
    status_code: statusCode,
    message: String(message).slice(0, 900),
    network_state: networkState,
    network_error: networkError.slice(0, 500),
    progress_anchor_at: progressAnchorAt ? new Date(progressAnchorAt).toISOString() : "",
    no_meaningful_progress: noMeaningfulProgress,
    started_hint_ms: Math.max(0, Math.min(nowMs, startedHintMs)),
    recoverable: /^cpt_[a-f0-9]{24}$/.test(taskId)
  };
}

export function detectTaskHangCandidates(profiles, nowMs = Date.now(), jobs = []) {
  return (Array.isArray(profiles) ? profiles : []).map((profile) => hangCandidateForProfile(profile, nowMs, jobs)).filter(Boolean);
}

function safeIncident(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const startedMs = Math.max(0, Number(value.started_at_ms) || asTime(value.started_at));
  if (!startedMs) return null;
  return {
    id: String(value.id || randomUUID()).slice(0, 160),
    key: String(value.key || "").slice(0, 800),
    profile_id: String(value.profile_id || "").slice(0, 160),
    task_id: String(value.task_id || "").slice(0, 160),
    task_title: String(value.task_title || "Task CodexPro").slice(0, 300),
    conversation_id: String(value.conversation_id || "").slice(0, 180),
    tab_id: Math.max(0, Number(value.tab_id) || 0),
    tab_title: String(value.tab_title || "ChatGPT").slice(0, 300),
    source: ["openai", "stalled"].includes(value.source) ? value.source : "network",
    causes: Array.isArray(value.causes) ? value.causes.map(String).filter((item) => ["openai", "network", "stalled"].includes(item)).slice(0, 3) : [],
    status_code: Math.max(0, Number(value.status_code) || 0),
    message: String(value.message || "").slice(0, 900),
    network_state: String(value.network_state || "").slice(0, 40),
    network_error: String(value.network_error || "").slice(0, 500),
    progress_anchor_at: String(value.progress_anchor_at || "").slice(0, 64),
    no_meaningful_progress: value.no_meaningful_progress === true,
    started_at_ms: startedMs,
    started_at: String(value.started_at || new Date(startedMs).toISOString()).slice(0, 64),
    last_seen_ms: Math.max(startedMs, Number(value.last_seen_ms) || startedMs),
    last_seen_at: String(value.last_seen_at || value.started_at || new Date(startedMs).toISOString()).slice(0, 64),
    ended_at_ms: Math.max(0, Number(value.ended_at_ms) || 0),
    ended_at: String(value.ended_at || "").slice(0, 64),
    duration_ms: Math.max(0, Number(value.duration_ms) || 0),
    active: value.active === true,
    occurrence: Math.max(1, Number(value.occurrence) || 1),
    recoverable: value.recoverable === true
  };
}

export function summarizeTaskHangIncidents(values, nowMs = Date.now()) {
  const incidents = (Array.isArray(values) ? values : []).map(safeIncident).filter(Boolean);
  const visible = incidents.slice(-SNAPSHOT_LIMIT).map((incident) => ({
    ...incident,
    duration_ms: incident.active ? Math.max(incident.duration_ms, nowMs - incident.started_at_ms) : incident.duration_ms
  })).reverse();
  const durations = incidents.map((incident) => incident.active ? Math.max(incident.duration_ms, nowMs - incident.started_at_ms) : incident.duration_ms);
  return {
    incidents: visible,
    summary: {
      active_count: incidents.filter((incident) => incident.active).length,
      total_count: incidents.length,
      network_count: incidents.filter((incident) => incident.source === "network").length,
      openai_count: incidents.filter((incident) => incident.source === "openai").length,
      stalled_count: incidents.filter((incident) => incident.source === "stalled").length,
      total_duration_ms: durations.reduce((total, value) => total + value, 0),
      longest_duration_ms: durations.reduce((longest, value) => Math.max(longest, value), 0),
      latest_at: visible[0]?.started_at || ""
    }
  };
}

export function createTaskHangTracker({ home, now = () => Date.now() } = {}) {
  const storePath = path.join(String(home || process.cwd()), "task-hang-incidents.json");
  let loaded = false;
  let incidents = [];
  let lastPersistAt = 0;
  const seenInSession = new Set();

  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
      incidents = (Array.isArray(parsed?.incidents) ? parsed.incidents : []).map(safeIncident).filter(Boolean).slice(-MAX_INCIDENTS);
    } catch {
      incidents = [];
    }
  };

  const persist = (force = false) => {
    const nowMs = now();
    if (!force && nowMs - lastPersistAt < ACTIVE_PERSIST_INTERVAL_MS) return;
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const temp = `${storePath}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ version: STORE_VERSION, saved_at: new Date(nowMs).toISOString(), incidents: incidents.slice(-MAX_INCIDENTS) }, null, 2)}\n`, "utf8");
      fs.renameSync(temp, storePath);
      lastPersistAt = nowMs;
    } catch {
      // Hang tracking is diagnostic-only and must never break runtime status.
    }
  };

  const reconcile = (profiles, jobs = []) => {
    load();
    const nowMs = now();
    const candidates = detectTaskHangCandidates(profiles, nowMs, jobs);
    const currentKeys = new Set(candidates.map((candidate) => candidate.key));
    let changed = false;

    for (const candidate of candidates) {
      let active = null;
      for (let index = incidents.length - 1; index >= 0; index -= 1) {
        if (incidents[index].active && incidents[index].key === candidate.key) { active = incidents[index]; break; }
      }
      if (!active) {
        const previousCount = incidents.filter((incident) => incident.profile_id === candidate.profile_id && incident.task_id === candidate.task_id).length;
        const startedMs = Math.max(0, candidate.started_hint_ms || nowMs);
        active = safeIncident({
          ...candidate,
          id: randomUUID(),
          started_at_ms: startedMs,
          started_at: new Date(startedMs).toISOString(),
          last_seen_ms: nowMs,
          last_seen_at: new Date(nowMs).toISOString(),
          active: true,
          occurrence: previousCount + 1
        });
        incidents.push(active);
        incidents = incidents.slice(-MAX_INCIDENTS);
        changed = true;
      } else {
        const nextSource = active.source === "openai" || candidate.source === "openai"
          ? "openai"
          : active.source === "stalled" || candidate.source === "stalled" ? "stalled" : "network";
        const nextCauses = [...new Set([...(active.causes || []), ...(candidate.causes || [])])];
        const metadataChanged = active.source !== nextSource || active.status_code !== candidate.status_code || active.message !== candidate.message || active.network_state !== candidate.network_state || active.network_error !== candidate.network_error || active.recoverable !== candidate.recoverable || nextCauses.join("|") !== (active.causes || []).join("|");
        Object.assign(active, candidate, {
          source: nextSource,
          causes: nextCauses,
          started_at_ms: active.started_at_ms,
          started_at: active.started_at,
          last_seen_ms: nowMs,
          last_seen_at: new Date(nowMs).toISOString(),
          active: true,
          occurrence: active.occurrence
        });
        changed = changed || metadataChanged;
      }
      seenInSession.add(candidate.key);
    }

    for (const incident of incidents) {
      if (!incident.active || currentKeys.has(incident.key)) continue;
      const endedMs = seenInSession.has(incident.key) ? nowMs : Math.max(incident.started_at_ms, incident.last_seen_ms || incident.started_at_ms);
      incident.active = false;
      incident.ended_at_ms = endedMs;
      incident.ended_at = new Date(endedMs).toISOString();
      incident.duration_ms = Math.max(0, endedMs - incident.started_at_ms);
      changed = true;
    }

    if (changed) persist(true);
    else if (incidents.some((incident) => incident.active)) persist(false);
    return summarizeTaskHangIncidents(incidents, nowMs);
  };

  const snapshot = () => {
    load();
    return summarizeTaskHangIncidents(incidents, now());
  };

  return { reconcile, snapshot, storePath };
}
