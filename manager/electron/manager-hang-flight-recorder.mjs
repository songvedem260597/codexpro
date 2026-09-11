import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export const MANAGER_HANG_SAMPLE_INTERVAL_MS = 2_000;
export const MANAGER_HANG_ROLLING_HISTORY_MS = 5 * 60_000;
export const MANAGER_HANG_CHECKPOINT_INTERVAL_MS = 15_000;
export const MANAGER_HANG_INCIDENT_RETENTION = 50;
export const MANAGER_HANG_EVENT_LOOP_GAP_MS = 2_000;

const DEFAULT_SOFT_SUSTAIN_MS = 10_000;
const DEFAULT_MCP_OLD_MS = 60_000;
const DEFAULT_RESPONSE_READ_OLD_MS = 60_000;
const DEFAULT_RUNTIME_STALE_MS = 30_000;
const DEFAULT_BROWSER_STALL_MS = 15_000;
const DEFAULT_MAX_CHECKPOINT_BYTES = 512 * 1024;
const DEFAULT_MAX_INCIDENT_BYTES = 1024 * 1024;
const MAX_SIGNAL_DETAILS = 12;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableAge(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function clean(value, max = 180) {
  return String(value ?? "").trim().slice(0, max);
}

function iso(ms) {
  const value = finite(ms, Date.now());
  return new Date(value).toISOString();
}

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function safeCall(fn, fallback = null) {
  try {
    return typeof fn === "function" ? fn() : fallback;
  } catch {
    return fallback;
  }
}

function normalizeMcp(value) {
  const source = value && typeof value === "object" ? value : {};
  const calls = Array.isArray(source.calls) ? source.calls.slice(0, MAX_SIGNAL_DETAILS).map((call) => ({
    mcp_call_id: clean(call?.mcp_call_id),
    caller: clean(call?.caller, 100),
    age_ms: nullableAge(call?.age_ms),
    response_read_id: clean(call?.response_read_id),
    runtime_freshness_iteration_id: clean(call?.runtime_freshness_iteration_id),
    profile_id: clean(call?.profile_id),
    conversation_id: clean(call?.conversation_id),
    task_id: clean(call?.task_id),
    session_id: clean(call?.session_id)
  })) : [];
  return {
    initialize_in_flight: Math.max(0, finite(source.initialize_in_flight ?? source.MCP_INITIALIZE_IN_FLIGHT)),
    session_tool_in_flight: Math.max(0, finite(source.session_tool_in_flight ?? source.MCP_SESSIONS_IN_FLIGHT)),
    oldest_in_flight_age_ms: nullableAge(source.oldest_in_flight_age_ms),
    calls
  };
}

function normalizeResponseReads(value) {
  const source = value && typeof value === "object" ? value : {};
  const entries = Array.isArray(source.entries) ? source.entries.slice(0, MAX_SIGNAL_DETAILS).map((entry) => ({
    key: clean(entry?.key, 380),
    lane: clean(entry?.lane),
    state: clean(entry?.state, 40),
    age_ms: nullableAge(entry?.age_ms),
    profile_id: clean(entry?.profile_id),
    conversation_id: clean(entry?.conversation_id)
  })) : [];
  return {
    in_flight: Math.max(0, finite(source.active ?? source.in_flight)),
    queued: Math.max(0, finite(source.queued)),
    oldest_read_age_ms: nullableAge(source.oldest_active_age_ms ?? source.oldest_read_age_ms),
    oldest_queued_age_ms: nullableAge(source.oldest_queued_age_ms),
    entries
  };
}

function normalizeBrowserStream(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    in_flight: Math.max(0, finite(source.in_flight)),
    backlog: Math.max(0, finite(source.pending_keys ?? source.pendingKeys ?? source.backlog)),
    paused: Boolean(source.paused),
    in_flight_age_ms: nullableAge(source.in_flight_age_ms),
    last_ack_age_ms: nullableAge(source.last_ack_age_ms),
    last_progress_age_ms: nullableAge(source.last_progress_age_ms)
  };
}

function normalizeRuntime(value) {
  const source = value && typeof value === "object" ? value : {};
  const pids = Array.isArray(source.child_pids) ? source.child_pids.slice(0, 32).map((pid) => Math.max(0, finite(pid))).filter(Boolean) : [];
  return {
    health_known: source.health_known === true,
    local_ok: source.local_ok == null ? null : Boolean(source.local_ok),
    health_age_ms: nullableAge(source.health_age_ms),
    health_latency_ms: nullableAge(source.health_latency_ms),
    runtime_pid: Math.max(0, finite(source.runtime_pid)) || null,
    runtime_started_at: clean(source.runtime_started_at, 80),
    child_process_count: Math.max(0, finite(source.child_process_count ?? pids.length)),
    child_pids: pids
  };
}

function normalizeContext(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.slice(0, MAX_SIGNAL_DETAILS).map((item) => ({
    profile_id: clean(item?.profile_id),
    task_id: clean(item?.task_id),
    conversation_id: clean(item?.conversation_id),
    tab_id: clean(item?.tab_id)
  })).filter((item) => item.profile_id || item.task_id || item.conversation_id || item.tab_id);
}

async function atomicWriteFile(targetPath, text) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tempPath, text, "utf8");
    await fs.rename(tempPath, targetPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

export function createManagerHangFlightRecorder(options = {}) {
  const home = path.resolve(String(options.home || process.cwd()));
  const sampleIntervalMs = Math.max(250, finite(options.sampleIntervalMs, MANAGER_HANG_SAMPLE_INTERVAL_MS));
  const rollingHistoryMs = Math.max(sampleIntervalMs * 2, finite(options.rollingHistoryMs, MANAGER_HANG_ROLLING_HISTORY_MS));
  const checkpointIntervalMs = Math.max(sampleIntervalMs, finite(options.checkpointIntervalMs, MANAGER_HANG_CHECKPOINT_INTERVAL_MS));
  const incidentRetention = Math.max(1, Math.floor(finite(options.incidentRetention, MANAGER_HANG_INCIDENT_RETENTION)));
  const hardEventLoopGapMs = Math.max(500, finite(options.hardEventLoopGapMs, MANAGER_HANG_EVENT_LOOP_GAP_MS));
  const softSustainMs = Math.max(0, finite(options.softSustainMs, DEFAULT_SOFT_SUSTAIN_MS));
  const thresholds = {
    mcpOldMs: Math.max(1_000, finite(options.mcpOldMs, DEFAULT_MCP_OLD_MS)),
    responseReadOldMs: Math.max(1_000, finite(options.responseReadOldMs, DEFAULT_RESPONSE_READ_OLD_MS)),
    runtimeStaleMs: Math.max(1_000, finite(options.runtimeStaleMs, DEFAULT_RUNTIME_STALE_MS)),
    browserStallMs: Math.max(1_000, finite(options.browserStallMs, DEFAULT_BROWSER_STALL_MS))
  };
  const maxSnapshots = Math.max(4, Math.ceil(rollingHistoryMs / sampleIntervalMs) + 8);
  const maxCheckpointBytes = Math.max(8 * 1024, finite(options.maxCheckpointBytes, DEFAULT_MAX_CHECKPOINT_BYTES));
  const maxIncidentBytes = Math.max(16 * 1024, finite(options.maxIncidentBytes, DEFAULT_MAX_INCIDENT_BYTES));
  const now = typeof options.now === "function" ? options.now : Date.now;
  const monotonicNow = typeof options.monotonicNow === "function" ? options.monotonicNow : () => performance.now();
  const cpuUsage = typeof options.cpuUsage === "function" ? options.cpuUsage : (previous) => process.cpuUsage(previous);
  const memoryUsage = typeof options.memoryUsage === "function" ? options.memoryUsage : () => process.memoryUsage();
  const diagnostic = typeof options.diagnostic === "function" ? options.diagnostic : () => {};
  const writer = typeof options.writeAtomic === "function" ? options.writeAtomic : atomicWriteFile;
  const setIntervalFn = typeof options.setIntervalFn === "function" ? options.setIntervalFn : setInterval;
  const clearIntervalFn = typeof options.clearIntervalFn === "function" ? options.clearIntervalFn : clearInterval;
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : (detectedAtMs) => `mgrhang_${detectedAtMs.toString(36)}_${randomBytes(4).toString("hex")}`;
  const samplers = options.samplers && typeof options.samplers === "object" ? options.samplers : {};
  const checkpointPath = path.join(home, "manager-hang-flight-recorder", "checkpoint.json");
  const incidentDirectory = path.join(home, "manager-hang-flight-recorder", "incidents");

  let history = [];
  let activeIncident = null;
  let rendererResponsive = true;
  let lastUnresponsiveAtMs = 0;
  let lastResponsiveAtMs = finite(now());
  let sampleTimer = null;
  let checkpointTimer = null;
  let expectedTimerMono = finite(monotonicNow()) + sampleIntervalMs;
  let lastCpuMono = null;
  let lastCpuUsage = null;
  let started = false;
  let delayHistogram = null;
  const softSince = new Map();
  const pendingPersistence = new Set();
  let persistenceTail = Promise.resolve();

  if (typeof options.eventLoopPeakMs !== "function") {
    try {
      delayHistogram = monitorEventLoopDelay({ resolution: 20 });
    } catch {
      delayHistogram = null;
    }
  }

  function safeDiagnostic(message, details = {}) {
    try {
      diagnostic("warn", "manager", "hang-flight-recorder", message, { action: "manager-hang-flight-recorder", ...details });
    } catch {}
  }

  function enqueuePersistence(work) {
    const promise = persistenceTail.then(() => Promise.resolve().then(work)).catch((error) => {
      safeDiagnostic("Manager hang flight recorder persistence failed", { error: String(error?.message || error).slice(0, 500) });
      return null;
    });
    persistenceTail = promise.then(() => undefined, () => undefined);
    pendingPersistence.add(promise);
    promise.finally(() => pendingPersistence.delete(promise));
    return promise;
  }

  function processSnapshot(currentMono) {
    const memory = safeCall(memoryUsage, {}) || {};
    let cpuDeltaUs = null;
    let cpuPercent = null;
    try {
      if (lastCpuUsage && lastCpuMono != null) {
        const delta = cpuUsage(lastCpuUsage) || {};
        cpuDeltaUs = Math.max(0, finite(delta.user) + finite(delta.system));
        const elapsedUs = Math.max(1, (currentMono - lastCpuMono) * 1000);
        cpuPercent = Number(((cpuDeltaUs / elapsedUs) * 100).toFixed(2));
      }
      lastCpuUsage = cpuUsage();
      lastCpuMono = currentMono;
    } catch {
      lastCpuUsage = null;
      lastCpuMono = currentMono;
    }
    return {
      pid: process.pid,
      cpu_delta_us: cpuDeltaUs,
      cpu_utilization_percent: cpuPercent,
      rss: Math.max(0, finite(memory.rss)),
      heap_used: Math.max(0, finite(memory.heapUsed)),
      heap_total: Math.max(0, finite(memory.heapTotal)),
      external: Math.max(0, finite(memory.external))
    };
  }

  function eventLoopPeakMs() {
    if (typeof options.eventLoopPeakMs === "function") return Math.max(0, finite(safeCall(options.eventLoopPeakMs, 0)));
    if (!delayHistogram) return 0;
    try {
      const peak = Math.max(0, finite(delayHistogram.max) / 1_000_000);
      delayHistogram.reset();
      return Number(peak.toFixed(2));
    } catch {
      return 0;
    }
  }

  function buildSnapshot({ timerTick = false } = {}) {
    const wallNow = finite(now(), Date.now());
    const monoNow = finite(monotonicNow());
    let timerDriftMs = 0;
    if (timerTick) {
      timerDriftMs = Math.max(0, monoNow - expectedTimerMono);
      expectedTimerMono = monoNow + sampleIntervalMs;
    }
    const peakDelayMs = Math.max(timerDriftMs, eventLoopPeakMs());
    return {
      timestamp: iso(wallNow),
      wall_time_ms: wallNow,
      monotonic_ms: Number(monoNow.toFixed(3)),
      process: processSnapshot(monoNow),
      event_loop: {
        timer_drift_ms: Number(timerDriftMs.toFixed(2)),
        peak_delay_ms: Number(peakDelayMs.toFixed(2))
      },
      renderer: {
        responsive: rendererResponsive,
        last_unresponsive_at: lastUnresponsiveAtMs ? iso(lastUnresponsiveAtMs) : "",
        last_responsive_at: lastResponsiveAtMs ? iso(lastResponsiveAtMs) : ""
      },
      mcp: normalizeMcp(safeCall(samplers.mcp, null)),
      response_reads: normalizeResponseReads(safeCall(samplers.responseReads, null)),
      browser_stream: normalizeBrowserStream(safeCall(samplers.browserStream, null)),
      runtime: normalizeRuntime(safeCall(samplers.runtime, null)),
      context: normalizeContext(safeCall(samplers.context, []))
    };
  }

  function softSignals(snapshot, wallNow) {
    const current = new Set();
    if (snapshot.mcp.session_tool_in_flight > 0 && nullableAge(snapshot.mcp.oldest_in_flight_age_ms) >= thresholds.mcpOldMs) current.add("mcp_request_old");
    if (snapshot.response_reads.in_flight > 0 && nullableAge(snapshot.response_reads.oldest_read_age_ms) >= thresholds.responseReadOldMs) current.add("profile_response_read_old");
    if (snapshot.runtime.health_known && nullableAge(snapshot.runtime.health_age_ms) >= thresholds.runtimeStaleMs) current.add("runtime_health_stale");
    const browserBacklog = snapshot.browser_stream.in_flight + snapshot.browser_stream.backlog;
    if (browserBacklog > 0 && nullableAge(snapshot.browser_stream.last_progress_age_ms) >= thresholds.browserStallMs) current.add("browser_ipc_stalled");

    for (const key of [...softSince.keys()]) if (!current.has(key)) softSince.delete(key);
    for (const key of current) if (!softSince.has(key)) softSince.set(key, wallNow);
    return [...current].filter((key) => wallNow - finite(softSince.get(key), wallNow) >= softSustainMs);
  }

  function strongSignals(snapshot) {
    const signals = [];
    if (!snapshot.renderer.responsive) signals.push("renderer_unresponsive");
    if (snapshot.event_loop.peak_delay_ms >= hardEventLoopGapMs) signals.push("main_event_loop_gap");
    return signals;
  }

  function signalCorrelations(snapshot) {
    const values = [...snapshot.context];
    for (const call of snapshot.mcp.calls) values.push({
      profile_id: call.profile_id,
      task_id: call.task_id,
      conversation_id: call.conversation_id,
      tab_id: "",
      mcp_call_id: call.mcp_call_id,
      response_read_id: call.response_read_id,
      session_id: call.session_id,
      caller: call.caller
    });
    for (const entry of snapshot.response_reads.entries) values.push({
      profile_id: entry.profile_id,
      conversation_id: entry.conversation_id,
      task_id: "",
      tab_id: "",
      response_queue_key: entry.key
    });
    return cloneJson(values.slice(0, MAX_SIGNAL_DETAILS), []);
  }

  function likelyStartedAtMs(snapshot, activeSignals, wallNow) {
    const candidates = [wallNow];
    if (activeSignals.includes("renderer_unresponsive") && lastUnresponsiveAtMs) candidates.push(lastUnresponsiveAtMs);
    if (activeSignals.includes("main_event_loop_gap")) candidates.push(wallNow - Math.max(0, finite(snapshot.event_loop.peak_delay_ms)));
    for (const key of activeSignals) if (softSince.has(key)) candidates.push(finite(softSince.get(key), wallNow));
    return Math.min(...candidates.filter(Number.isFinite));
  }

  function incidentFilePath(incident) {
    return path.join(incidentDirectory, `${String(incident.detected_at_ms).padStart(13, "0")}-${incident.incident_id}.json`);
  }

  function boundedIncidentText(incident) {
    const copy = cloneJson(incident, {}) || {};
    copy.pre_freeze_snapshots = Array.isArray(copy.pre_freeze_snapshots) ? copy.pre_freeze_snapshots : [];
    let text = JSON.stringify(copy);
    while (byteLength(text) > maxIncidentBytes && copy.pre_freeze_snapshots.length > 1) {
      copy.pre_freeze_snapshots.shift();
      copy.pre_freeze_truncated = true;
      text = JSON.stringify(copy);
    }
    if (byteLength(text) > maxIncidentBytes) {
      copy.pre_freeze_snapshots = [];
      copy.pre_freeze_truncated = true;
      text = JSON.stringify(copy);
    }
    return text;
  }

  async function pruneIncidents() {
    await fs.mkdir(incidentDirectory, { recursive: true });
    const files = (await fs.readdir(incidentDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
    const excess = Math.max(0, files.length - incidentRetention);
    await Promise.all(files.slice(0, excess).map((name) => fs.rm(path.join(incidentDirectory, name), { force: true })));
  }

  function persistIncident(incident) {
    const target = incidentFilePath(incident);
    const text = boundedIncidentText(incident);
    return enqueuePersistence(async () => {
      await writer(target, text);
      await pruneIncidents();
    });
  }

  function checkpointText() {
    const wallNow = finite(now(), Date.now());
    const snapshots = cloneJson(history, []) || [];
    const base = {
      schema_version: 1,
      manager_pid: process.pid,
      written_at: iso(wallNow),
      sample_interval_ms: sampleIntervalMs,
      rolling_history_ms: rollingHistoryMs,
      active_incident: activeIncident ? {
        incident_id: activeIncident.incident_id,
        detected_at: activeIncident.detected_at,
        likely_started_at: activeIncident.likely_started_at,
        active_signals: activeIncident.active_signals
      } : null,
      snapshots
    };
    let text = JSON.stringify(base);
    while (byteLength(text) > maxCheckpointBytes && base.snapshots.length > 1) {
      base.snapshots.shift();
      base.snapshots_truncated = true;
      text = JSON.stringify(base);
    }
    if (byteLength(text) > maxCheckpointBytes) {
      base.snapshots = [];
      base.snapshots_truncated = true;
      text = JSON.stringify(base);
    }
    return text;
  }

  function flushCheckpoint() {
    const text = checkpointText();
    return enqueuePersistence(() => writer(checkpointPath, text));
  }

  function openIncident(snapshot, activeSignals) {
    const detectedAtMs = snapshot.wall_time_ms;
    const incident = {
      schema_version: 1,
      incident_id: idFactory(detectedAtMs),
      detected_at_ms: detectedAtMs,
      detected_at: snapshot.timestamp,
      likely_started_at: iso(likelyStartedAtMs(snapshot, activeSignals, detectedAtMs)),
      active_signals: [...new Set(activeSignals)],
      correlations: signalCorrelations(snapshot),
      pre_freeze_snapshots: cloneJson(history, []) || [],
      current_snapshot: cloneJson(snapshot, null),
      peak_event_loop_delay_ms: Math.max(0, finite(snapshot.event_loop.peak_delay_ms)),
      oldest_mcp_age_ms: nullableAge(snapshot.mcp.oldest_in_flight_age_ms),
      oldest_response_read_age_ms: nullableAge(snapshot.response_reads.oldest_read_age_ms),
      renderer_state: cloneJson(snapshot.renderer, null),
      runtime_health: cloneJson(snapshot.runtime, null),
      child_pid_summary: cloneJson(snapshot.runtime.child_pids, []),
      recovered: false,
      recovered_at: "",
      duration_ms: null,
      final_snapshot: null
    };
    activeIncident = incident;
    persistIncident(incident);
    return incident;
  }

  function updateIncident(snapshot, activeSignals) {
    if (!activeIncident) return;
    activeIncident.active_signals = [...new Set([...activeIncident.active_signals, ...activeSignals])];
    activeIncident.current_snapshot = cloneJson(snapshot, null);
    activeIncident.peak_event_loop_delay_ms = Math.max(activeIncident.peak_event_loop_delay_ms, finite(snapshot.event_loop.peak_delay_ms));
    const oldestMcp = nullableAge(snapshot.mcp.oldest_in_flight_age_ms);
    const oldestRead = nullableAge(snapshot.response_reads.oldest_read_age_ms);
    if (oldestMcp != null) activeIncident.oldest_mcp_age_ms = Math.max(activeIncident.oldest_mcp_age_ms || 0, oldestMcp);
    if (oldestRead != null) activeIncident.oldest_response_read_age_ms = Math.max(activeIncident.oldest_response_read_age_ms || 0, oldestRead);
  }

  function closeIncident(snapshot) {
    if (!activeIncident) return null;
    const incident = activeIncident;
    incident.recovered = true;
    incident.recovered_at = snapshot.timestamp;
    incident.duration_ms = Math.max(0, snapshot.wall_time_ms - incident.detected_at_ms);
    incident.final_snapshot = cloneJson(snapshot, null);
    incident.current_snapshot = cloneJson(snapshot, null);
    activeIncident = null;
    persistIncident(incident);
    return incident;
  }

  function appendHistory(snapshot) {
    history.push(snapshot);
    const cutoff = snapshot.wall_time_ms - rollingHistoryMs;
    history = history.filter((item) => item.wall_time_ms >= cutoff);
    if (history.length > maxSnapshots) history = history.slice(-maxSnapshots);
  }

  function sampleNow({ timerTick = false } = {}) {
    try {
      const snapshot = buildSnapshot({ timerTick });
      const hard = strongSignals(snapshot);
      const sustainedSoft = softSignals(snapshot, snapshot.wall_time_ms);
      const activeSignals = [...hard, ...sustainedSoft];
      if (!activeIncident && (hard.length > 0 || sustainedSoft.length >= 2)) openIncident(snapshot, activeSignals);
      else if (activeIncident) {
        updateIncident(snapshot, activeSignals);
        if (hard.length === 0 && sustainedSoft.length < 2) closeIncident(snapshot);
      }
      appendHistory(snapshot);
      return snapshot;
    } catch (error) {
      safeDiagnostic("Manager hang flight recorder sample failed", { error: String(error?.message || error).slice(0, 500) });
      return null;
    }
  }

  function markRendererUnresponsive() {
    rendererResponsive = false;
    lastUnresponsiveAtMs = finite(now(), Date.now());
    return sampleNow();
  }

  function markRendererResponsive() {
    rendererResponsive = true;
    lastResponsiveAtMs = finite(now(), Date.now());
    return sampleNow();
  }

  function start() {
    if (started) return;
    started = true;
    expectedTimerMono = finite(monotonicNow()) + sampleIntervalMs;
    try { delayHistogram?.enable(); } catch {}
    sampleNow();
    sampleTimer = setIntervalFn(() => sampleNow({ timerTick: true }), sampleIntervalMs);
    checkpointTimer = setIntervalFn(() => { void flushCheckpoint(); }, checkpointIntervalMs);
    sampleTimer?.unref?.();
    checkpointTimer?.unref?.();
  }

  function stop() {
    if (!started) return;
    started = false;
    if (sampleTimer) clearIntervalFn(sampleTimer);
    if (checkpointTimer) clearIntervalFn(checkpointTimer);
    sampleTimer = null;
    checkpointTimer = null;
    try { delayHistogram?.disable(); } catch {}
    void flushCheckpoint();
  }

  async function drain() {
    while (pendingPersistence.size) await Promise.allSettled([...pendingPersistence]);
  }

  function state() {
    return {
      started,
      history: cloneJson(history, []) || [],
      active_incident: cloneJson(activeIncident, null),
      checkpoint_path: checkpointPath,
      incident_directory: incidentDirectory,
      sample_interval_ms: sampleIntervalMs,
      rolling_history_ms: rollingHistoryMs,
      checkpoint_interval_ms: checkpointIntervalMs,
      incident_retention: incidentRetention,
      max_snapshots: maxSnapshots
    };
  }

  return {
    start,
    stop,
    sampleNow,
    markRendererUnresponsive,
    markRendererResponsive,
    flushCheckpoint,
    drain,
    state,
    checkpointPath,
    incidentDirectory
  };
}
