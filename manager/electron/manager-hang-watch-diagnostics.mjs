import fs from "node:fs/promises";
import path from "node:path";

const MAX_RECENT_INCIDENTS = 20;
const MAX_EVIDENCE_SNAPSHOTS = 12;
const MAX_CORRELATIONS = 12;

function finite(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value, max = 180) {
  return String(value ?? "").trim().slice(0, max);
}

function age(value) {
  const number = finite(value);
  return number != null && number >= 0 ? Math.round(number) : null;
}

async function readJson(filePath) {
  try {
    return { value: JSON.parse(await fs.readFile(filePath, "utf8")), error: "" };
  } catch (error) {
    if (error?.code === "ENOENT") return { value: null, error: "missing" };
    return { value: null, error: text(error?.message || error, 300) || "invalid" };
  }
}

function sanitizeContext(value) {
  const list = Array.isArray(value) ? value : [];
  return list.slice(0, MAX_CORRELATIONS).map((item) => ({
    profile_id: text(item?.profile_id),
    task_id: text(item?.task_id),
    conversation_id: text(item?.conversation_id),
    tab_id: text(item?.tab_id),
    mcp_call_id: text(item?.mcp_call_id),
    response_read_id: text(item?.response_read_id)
  })).filter((item) => Object.values(item).some(Boolean));
}

function sanitizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const runtime = snapshot.runtime && typeof snapshot.runtime === "object" ? snapshot.runtime : {};
  const pids = Array.isArray(runtime.child_pids)
    ? runtime.child_pids.slice(0, 32).map((pid) => finite(pid)).filter((pid) => Number.isInteger(pid) && pid > 0)
    : [];
  return {
    timestamp: text(snapshot.timestamp, 80),
    wall_time_ms: finite(snapshot.wall_time_ms),
    process: {
      pid: finite(snapshot.process?.pid),
      cpu_percent: finite(snapshot.process?.cpu_utilization_percent),
      rss: finite(snapshot.process?.rss, 0),
      heap_used: finite(snapshot.process?.heap_used, 0)
    },
    event_loop: {
      delay_ms: finite(snapshot.event_loop?.timer_drift_ms, 0),
      peak_delay_ms: finite(snapshot.event_loop?.peak_delay_ms, 0)
    },
    renderer: {
      responsive: snapshot.renderer?.responsive !== false,
      last_unresponsive_at: text(snapshot.renderer?.last_unresponsive_at, 80),
      last_responsive_at: text(snapshot.renderer?.last_responsive_at, 80)
    },
    mcp: {
      in_flight: Math.max(0, finite(snapshot.mcp?.initialize_in_flight, 0) + finite(snapshot.mcp?.session_tool_in_flight, 0)),
      oldest_age_ms: age(snapshot.mcp?.oldest_in_flight_age_ms)
    },
    response_reads: {
      in_flight: Math.max(0, finite(snapshot.response_reads?.in_flight, 0)),
      queued: Math.max(0, finite(snapshot.response_reads?.queued, 0)),
      oldest_age_ms: age(snapshot.response_reads?.oldest_read_age_ms)
    },
    browser_stream: {
      backlog: Math.max(0, finite(snapshot.browser_stream?.in_flight, 0) + finite(snapshot.browser_stream?.backlog, 0)),
      last_progress_age_ms: age(snapshot.browser_stream?.last_progress_age_ms)
    },
    runtime: {
      health_known: runtime.health_known === true,
      ok: runtime.local_ok == null ? null : Boolean(runtime.local_ok),
      health_age_ms: age(runtime.health_age_ms),
      runtime_pid: finite(runtime.runtime_pid),
      child_pids: pids
    },
    context: sanitizeContext(snapshot.context)
  };
}

function incidentDuration(incident) {
  const explicit = finite(incident?.duration_ms);
  if (explicit != null && explicit >= 0) return Math.round(explicit);
  const start = Date.parse(String(incident?.detected_at || ""));
  const end = Date.parse(String(incident?.recovered_at || ""));
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function sanitizeIncident(incident, { detail = false } = {}) {
  if (!incident || typeof incident !== "object") return null;
  const current = sanitizeSnapshot(incident.current_snapshot);
  const correlations = sanitizeContext(incident.correlations);
  const result = {
    incident_id: text(incident.incident_id, 160),
    detected_at: text(incident.detected_at, 80),
    likely_started_at: text(incident.likely_started_at, 80),
    recovered_at: text(incident.recovered_at, 80),
    recovered: incident.recovered === true,
    state: incident.recovered === true ? "RECOVERED" : "ACTIVE",
    duration_ms: incidentDuration(incident),
    active_signals: Array.isArray(incident.active_signals) ? incident.active_signals.slice(0, 16).map((value) => text(value, 100)).filter(Boolean) : [],
    correlations,
    peak_event_loop_delay_ms: finite(incident.peak_event_loop_delay_ms, current?.event_loop?.peak_delay_ms ?? 0),
    oldest_mcp_age_ms: age(incident.oldest_mcp_age_ms),
    oldest_response_read_age_ms: age(incident.oldest_response_read_age_ms),
    renderer: incident.renderer_state && typeof incident.renderer_state === "object"
      ? { responsive: incident.renderer_state.responsive !== false }
      : current?.renderer || null
  };
  if (detail) {
    result.current_snapshot = current;
    result.final_snapshot = sanitizeSnapshot(incident.final_snapshot);
    result.pre_freeze_evidence = (Array.isArray(incident.pre_freeze_snapshots) ? incident.pre_freeze_snapshots : [])
      .slice(-MAX_EVIDENCE_SNAPSHOTS)
      .map(sanitizeSnapshot)
      .filter(Boolean);
    result.pre_freeze_truncated = Boolean(incident.pre_freeze_truncated)
      || (Array.isArray(incident.pre_freeze_snapshots) && incident.pre_freeze_snapshots.length > MAX_EVIDENCE_SNAPSHOTS);
  }
  return result;
}

function currentView(snapshot, activeIncident) {
  const current = sanitizeSnapshot(snapshot);
  if (!current) return null;
  return {
    cpu_percent: current.process.cpu_percent,
    rss: current.process.rss,
    event_loop_delay_ms: current.event_loop.delay_ms,
    event_loop_peak_ms: activeIncident?.peak_event_loop_delay_ms ?? current.event_loop.peak_delay_ms,
    renderer_responsive: current.renderer.responsive,
    mcp_in_flight: current.mcp.in_flight,
    mcp_oldest_age_ms: current.mcp.oldest_age_ms,
    response_reads: current.response_reads.in_flight,
    response_read_oldest_age_ms: current.response_reads.oldest_age_ms,
    browser_backlog: current.browser_stream.backlog,
    browser_last_progress_age_ms: current.browser_stream.last_progress_age_ms,
    runtime_ok: current.runtime.ok,
    runtime_health_age_ms: current.runtime.health_age_ms,
    child_pids: current.runtime.child_pids,
    manager_pid: current.process.pid
  };
}

async function incidentFiles(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function readManagerHangWatchDiagnostics({ codexProHome, liveState = null, incidentId = "", now = Date.now } = {}) {
  const home = path.resolve(String(codexProHome || process.cwd()));
  const directory = path.join(home, "manager-hang-flight-recorder");
  const checkpointPath = path.join(directory, "checkpoint.json");
  const incidentsPath = path.join(directory, "incidents");
  const issues = [];
  const checkpointRead = await readJson(checkpointPath);
  if (checkpointRead.error) issues.push(checkpointRead.error === "missing" ? "checkpoint_missing" : "checkpoint_invalid");
  const checkpoint = checkpointRead.value && typeof checkpointRead.value === "object" ? checkpointRead.value : null;
  const live = liveState && typeof liveState === "object" ? liveState : {};
  const liveHistory = Array.isArray(live.history) ? live.history : [];
  const persistedHistory = Array.isArray(checkpoint?.snapshots) ? checkpoint.snapshots : [];
  const latestSnapshot = liveHistory.at(-1) || persistedHistory.at(-1) || null;
  const lastSampleAt = text(latestSnapshot?.timestamp, 80);
  const activeIncident = sanitizeIncident(live.active_incident, { detail: false });

  let files = [];
  try {
    files = await incidentFiles(incidentsPath);
  } catch {
    issues.push("incidents_unreadable");
  }
  const recent = [];
  for (const fileName of files.slice(0, MAX_RECENT_INCIDENTS)) {
    const item = await readJson(path.join(incidentsPath, fileName));
    if (item.error || !item.value) {
      issues.push("incident_invalid");
      continue;
    }
    const summary = sanitizeIncident(item.value);
    if (summary) recent.push(summary);
  }

  let selectedIncident = null;
  const selectedId = text(incidentId, 160);
  if (selectedId && /^[A-Za-z0-9_.-]+$/.test(selectedId)) {
    const selectedName = files.find((name) => name.endsWith(`-${selectedId}.json`));
    if (selectedName) {
      const selected = await readJson(path.join(incidentsPath, selectedName));
      if (selected.value) selectedIncident = sanitizeIncident(selected.value, { detail: true });
      else issues.push("selected_incident_invalid");
    }
  }

  const enabled = live.started === true;
  const checkpointWrittenAt = text(checkpoint?.written_at, 80);
  const checkpointAgeMs = Number.isFinite(Date.parse(checkpointWrittenAt)) ? Math.max(0, now() - Date.parse(checkpointWrittenAt)) : null;
  const checkpointIntervalMs = Math.max(1_000, finite(live.checkpoint_interval_ms, finite(checkpoint?.sample_interval_ms, 5_000) * 3));
  if (checkpointAgeMs != null && checkpointAgeMs > Math.max(30_000, checkpointIntervalMs * 3)) issues.push("checkpoint_stale");
  if (!enabled) issues.push("recorder_not_running");
  const state = activeIncident ? "FREEZE_DETECTED" : issues.length ? "WARNING" : "HEALTHY";

  return {
    enabled,
    last_sample_at: lastSampleAt,
    state,
    current: currentView(latestSnapshot, activeIncident),
    active_incident: activeIncident,
    recent_incidents: recent,
    selected_incident: selectedIncident,
    checkpoint: {
      written_at: checkpointWrittenAt,
      age_ms: checkpointAgeMs,
      persisted_active_incident: checkpoint?.active_incident ? {
        incident_id: text(checkpoint.active_incident.incident_id, 160),
        detected_at: text(checkpoint.active_incident.detected_at, 80),
        active_signals: Array.isArray(checkpoint.active_incident.active_signals)
          ? checkpoint.active_incident.active_signals.slice(0, 16).map((value) => text(value, 100)).filter(Boolean)
          : []
      } : null
    },
    issues: [...new Set(issues)].slice(0, 12),
    limits: { recent_incidents: MAX_RECENT_INCIDENTS, evidence_snapshots: MAX_EVIDENCE_SNAPSHOTS }
  };
}
