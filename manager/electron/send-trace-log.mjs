import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE_RECORDS = 2_000;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BYTES = 12 * 1024;
const MAX_STRING = 1_000;
const CRITICAL_EVENTS = new Set([
  "renderer_send_started",
  "ipc_accepted",
  "task_gate_rejected",
  "network_ack",
  "bridge_timeout",
  "late_result",
  "result_received",
  "send_finished",
  "runtime_identity",
  "dropped_events"
]);
const SENSITIVE_KEY = /(prompt|response|image|token|credential|authorization|cookie|password|secret|api[_-]?key|url|query|body|text|attachment.*data|data_base64)/i;

function sanitize(value, depth = 0) {
  if (depth > 4) return "[TRUNCATED]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return String(value).slice(0, MAX_STRING);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (value instanceof Error) return { name: String(value.name || "Error").slice(0, 120), message: String(value.message || "").slice(0, MAX_STRING), code: String(value.code || "").slice(0, 160) };
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 60)) output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1);
    return output;
  }
  return String(value).slice(0, MAX_STRING);
}

function safeLine(record) {
  let line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, "utf8") <= MAX_EVENT_BYTES) return line;
  const compact = { ...record, details: { truncated: true, send_trace_id: record?.details?.send_trace_id || "", command_id: record?.details?.command_id || "", ipc_call_id: record?.details?.ipc_call_id || "", attempt_id: record?.details?.attempt_id || "" } };
  line = `${JSON.stringify(compact)}\n`;
  return line;
}

const TRACE_READ_COMPONENTS = ["manager", "bridge"];
const TRACE_DETAIL_KEYS = [
  "submission_state", "terminal_outcome", "ack_source", "network_acknowledged",
  "error_code", "stage_outcome", "tab_status", "tab_loading", "location_path",
  "target_path_matches", "composer_visible", "composer_selector", "composer_wait_ms",
  "remaining_deadline_ms", "message_length", "delivered_immediately", "action", "result_kind"
];

function traceEventStatus(record) {
  const event = String(record?.event || "");
  const details = record?.details && typeof record.details === "object" ? record.details : {};
  const stageOutcome = String(details.stage_outcome || "").toLowerCase();
  const terminalOutcome = String(details.terminal_outcome || "").toLowerCase();
  const submissionState = String(details.submission_state || "").toLowerCase();
  if (event.includes("timeout") || stageOutcome === "timeout") return "TIMEOUT";
  if (event.includes("error") || event.includes("rejected") || ["error", "failed", "rejected"].includes(stageOutcome) || terminalOutcome === "failed" || (event === "send_finished" && submissionState === "failed")) return "FAIL";
  if (event.endsWith("_started") || event === "renderer_send_started") return "START";
  return "PASS";
}

export async function readSendTraceTimeline(home, options = {}) {
  const sendTraceId = String(options?.send_trace_id || options?.sendTraceId || "").trim().slice(0, 160);
  if (!sendTraceId) return { send_trace_id: "", events: [], status: "EMPTY", total_ms: 0, last_successful_stage: "", first_failed_stage: "" };
  const maxEvents = Math.max(1, Math.min(500, Number(options?.limit) || 250));
  const records = [];
  const parsedRecords = [];
  for (const component of TRACE_READ_COMPONENTS) {
    const current = path.join(home, `send-trace-${component}.jsonl`);
    for (const candidate of [`${current}.1`, current]) {
      let text = "";
      try { text = await fs.promises.readFile(candidate, "utf8"); }
      catch (error) { if (error?.code !== "ENOENT") throw error; continue; }
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        try {
          const record = JSON.parse(line);
          parsedRecords.push(record);
          if (String(record?.details?.send_trace_id || "") === sendTraceId) records.push(record);
        } catch {}
      }
    }
  }
  const collectIds = (key) => new Set(records.map((record) => String(record?.details?.[key] || "")).filter(Boolean));
  const commandIds = collectIds("command_id");
  const attemptIds = collectIds("attempt_id");
  const ipcCallIds = collectIds("ipc_call_id");
  for (const record of parsedRecords) {
    if (records.includes(record)) continue;
    if (String(record?.writer_component || "") !== "bridge") continue;
    const details = record?.details && typeof record.details === "object" ? record.details : {};
    if (String(details.send_trace_id || "")) continue;
    const matchesKnownSend =
      (details.command_id && commandIds.has(String(details.command_id)))
      || (details.attempt_id && attemptIds.has(String(details.attempt_id)))
      || (details.ipc_call_id && ipcCallIds.has(String(details.ipc_call_id)));
    if (matchesKnownSend) records.push(record);
  }
  const fallbackIpcCallId = ipcCallIds.size === 1 ? [...ipcCallIds][0] : "";
  records.sort((left, right) => Date.parse(left?.event_at || left?.received_at || 0) - Date.parse(right?.event_at || right?.received_at || 0) || Number(left?.writer_sequence || 0) - Number(right?.writer_sequence || 0));
  const selected = records.slice(-maxEvents);
  const startedMs = selected.length ? Date.parse(selected[0]?.event_at || selected[0]?.received_at || 0) : 0;
  const events = selected.map((record) => {
    const details = record?.details && typeof record.details === "object" ? record.details : {};
    const eventMs = Date.parse(record?.event_at || record?.received_at || 0);
    const relevant = {};
    for (const key of TRACE_DETAIL_KEYS) if (details[key] !== undefined && details[key] !== "") relevant[key] = details[key];
    return {
      timestamp: String(record?.event_at || record?.received_at || ""),
      delta_ms: Number.isFinite(eventMs) && Number.isFinite(startedMs) ? Math.max(0, eventMs - startedMs) : 0,
      component: String(details.source_component || record?.writer_component || ""),
      event: String(record?.event || ""),
      status: traceEventStatus(record),
      send_trace_id: sendTraceId,
      ipc_call_id: String(details.ipc_call_id || fallbackIpcCallId || ""),
      attempt_id: String(details.attempt_id || ""),
      command_id: String(details.command_id || ""),
      profile_id: String(details.profile_id || ""),
      conversation_id: String(details.conversation_id || ""),
      tab_id: Number(details.tab_id) || 0,
      relevant
    };
  });
  const firstFailure = events.find((event) => event.status === "FAIL" || event.status === "TIMEOUT") || null;
  const totalMs = events.length > 1 ? Math.max(0, Number(events.at(-1)?.delta_ms || 0)) : 0;
  const sendFinished = [...events].reverse().find((event) => event.event === "send_finished");
  const terminalSuccess = sendFinished?.relevant?.terminal_outcome === "success" || sendFinished?.relevant?.submission_state === "submitted";
  const status = terminalSuccess ? "SUCCESS" : firstFailure ? "FAILURE" : "IN_PROGRESS";
  const firstFailureIndex = !terminalSuccess && firstFailure ? events.indexOf(firstFailure) : events.length;
  const lastSuccess = events.slice(0, firstFailureIndex).filter((event) => event.status === "PASS").at(-1) || null;
  return {
    send_trace_id: sendTraceId,
    status,
    total_ms: totalMs,
    last_successful_stage: String(lastSuccess?.event || ""),
    first_failed_stage: terminalSuccess ? "" : String(firstFailure?.event || ""),
    events
  };
}

export function createSendTraceLogger({ home, component, runId }) {
  const startedMono = performance.now();
  const file = path.join(home, `send-trace-${component}.jsonl`);
  const previous = `${file}.1`;
  let sequence = 0;
  let queue = [];
  let queueBytes = 0;
  let droppedEvents = 0;
  let scheduled = false;
  let flushPromise = Promise.resolve();
  let fileSize = null;
  let directoryReady = false;

  const ensureTarget = async () => {
    if (!directoryReady) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      directoryReady = true;
    }
    if (fileSize == null) {
      try { fileSize = (await fs.promises.stat(file)).size; }
      catch (error) { if (error?.code !== "ENOENT") throw error; fileSize = 0; }
    }
  };

  const rotateIfNeeded = async () => {
    await ensureTarget();
    const cutoff = Date.now() - RETENTION_MS;
    for (const candidate of [previous, file]) {
      try {
        const stat = await fs.promises.stat(candidate);
        if (stat.mtimeMs < cutoff) await fs.promises.rm(candidate, { force: true });
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    try { fileSize = (await fs.promises.stat(file)).size; }
    catch (error) { if (error?.code !== "ENOENT") throw error; fileSize = 0; }
    if (Number(fileSize) < MAX_FILE_BYTES) return;
    await fs.promises.rm(previous, { force: true });
    await fs.promises.rename(file, previous);
    fileSize = 0;
  };

  const makeRecord = (event, details = {}, options = {}) => sanitize({
    schema_version: 1,
    event: String(event || "unknown").slice(0, 120),
    event_at: String(options.eventAt || details?.event_at || new Date().toISOString()),
    received_at: new Date().toISOString(),
    writer_component: component,
    writer_run_id: runId,
    writer_process_id: process.pid,
    writer_sequence: ++sequence,
    writer_elapsed_ms: Math.max(0, Math.round((performance.now() - startedMono) * 1000) / 1000),
    priority: options.priority || (CRITICAL_EVENTS.has(event) ? "critical" : "normal"),
    details
  });

  const trimQueue = (incomingCritical) => {
    while (queue.length > MAX_QUEUE_RECORDS || queueBytes > MAX_QUEUE_BYTES) {
      let index = queue.findIndex((item) => item.priority !== "critical");
      if (index < 0) {
        if (!incomingCritical) return false;
        index = 0;
      }
      const [removed] = queue.splice(index, 1);
      queueBytes = Math.max(0, queueBytes - removed.bytes);
      droppedEvents += 1;
    }
    return true;
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    flushPromise = flushPromise.catch(() => undefined).then(async () => {
      try {
        await ensureTarget();
        await rotateIfNeeded();
        while (queue.length || droppedEvents) {
          const batch = [];
          if (droppedEvents) {
            const count = droppedEvents;
            droppedEvents = 0;
            const dropped = makeRecord("dropped_events", { dropped_events: count, max_queue_records: MAX_QUEUE_RECORDS, max_queue_bytes: MAX_QUEUE_BYTES }, { priority: "critical" });
            batch.push({ record: dropped, bytes: 0, priority: "critical" });
          }
          while (queue.length && batch.length < 100) {
            const item = queue.shift();
            queueBytes = Math.max(0, queueBytes - item.bytes);
            batch.push(item);
          }
          const writtenAt = new Date().toISOString();
          const payload = batch.map((item) => safeLine({ ...item.record, written_at: writtenAt, durability: "appended_not_fsynced" })).join("");
          if (!payload) continue;
          await fs.promises.appendFile(file, payload, "utf8");
          fileSize = Math.max(0, Number(fileSize) || 0) + Buffer.byteLength(payload, "utf8");
          if (Number(fileSize) >= MAX_FILE_BYTES) await rotateIfNeeded();
        }
      } catch {
        droppedEvents += queue.length;
        queue = [];
        queueBytes = 0;
      } finally {
        scheduled = false;
        if (queue.length) schedule();
      }
    });
  };

  const emit = (event, details = {}, options = {}) => {
    try {
      const record = makeRecord(event, details, options);
      const line = safeLine(record);
      const item = { record, bytes: Buffer.byteLength(line, "utf8"), priority: record.priority };
      const incomingCritical = item.priority === "critical";
      if (!incomingCritical && (queue.length >= MAX_QUEUE_RECORDS || queueBytes + item.bytes > MAX_QUEUE_BYTES)) {
        droppedEvents += 1;
        schedule();
        return false;
      }
      queue.push(item);
      queueBytes += item.bytes;
      if (!trimQueue(incomingCritical)) {
        queue.pop();
        queueBytes = Math.max(0, queueBytes - item.bytes);
        droppedEvents += 1;
      }
      schedule();
      return true;
    } catch {
      return false;
    }
  };

  return {
    emit,
    flush: async () => { schedule(); await flushPromise.catch(() => undefined); },
    stats: () => ({ queued_records: queue.length, queued_bytes: queueBytes, dropped_events: droppedEvents, max_queue_records: MAX_QUEUE_RECORDS, max_queue_bytes: MAX_QUEUE_BYTES, max_file_bytes: MAX_FILE_BYTES })
  };
}
