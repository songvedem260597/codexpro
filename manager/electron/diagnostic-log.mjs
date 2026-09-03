import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const COMPACTED_LOG_BYTES = 6 * 1024 * 1024;
const MAX_READ_ENTRIES = 5000;
const MAX_STRING_LENGTH = 4000;
const MAX_WRITE_BATCH_ENTRIES = 250;
const MAX_WRITE_BATCH_BYTES = 256 * 1024;
const MAX_PENDING_RECORDS = 20_000;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const PENDING_BACKLOG_TARGET_RATIO = 0.9;
const PRUNE_INTERVAL_MS = 30 * 60 * 1000;
const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|refresh[_-]?token|data[_-]?base64|base64)/i;
let writeQueue = Promise.resolve();
let recordSequence = 0;
const writeStates = new Map();

function logPath(home) {
  return path.join(home, "manager-diagnostic.jsonl");
}

function writeState(home) {
  const key = path.resolve(home);
  let state = writeStates.get(key);
  if (!state) {
    state = {
      key,
      pending: [],
      pendingBytes: 0,
      droppedCount: 0,
      scheduled: false,
      flushPromise: Promise.resolve(),
      directoryReady: false,
      fileSizeBytes: null,
      lastPruneAt: Date.now()
    };
    writeStates.set(key, state);
  }
  return state;
}

function profileTaskEventLogPaths(home) {
  const current = path.join(home, "profile-task-events.jsonl");
  return [`${current}.1`, current];
}

function runtimeLifecycleLogPaths(home) {
  const current = path.join(home, "runtime-lifecycle.jsonl");
  return [`${current}.1`, current];
}

function scrubString(value) {
  return String(value || "")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:codexpro_token|token|api_key|apikey|access_token|refresh_token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/((?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, MAX_STRING_LENGTH);
}

export function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 5) return "[TRUNCATED]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return scrubString(value);
  if (value instanceof Error) {
    return {
      name: scrubString(value.name),
      message: scrubString(value.message),
      code: scrubString(value.code || ""),
      stack: scrubString(value.stack || "")
    };
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeDiagnosticValue(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 60)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeDiagnosticValue(item, depth + 1);
    }
    return output;
  }
  return scrubString(value);
}

function normalizeRecord(entry = {}) {
  const level = ["info", "warn", "error"].includes(entry.level) ? entry.level : "info";
  const timestamp = new Date().toISOString();
  recordSequence = (recordSequence + 1) % Number.MAX_SAFE_INTEGER;
  return sanitizeDiagnosticValue({
    schema_version: 1,
    record_id: `${Date.now().toString(36)}-${process.pid.toString(36)}-${recordSequence.toString(36)}`,
    timestamp,
    level,
    source: scrubString(entry.source || "manager").slice(0, 80),
    category: scrubString(entry.category || "runtime").slice(0, 80),
    action: scrubString(entry.action || "").slice(0, 160),
    message: scrubString(entry.message || ""),
    ...(entry.duration_ms != null ? { duration_ms: Math.max(0, Math.round(Number(entry.duration_ms) || 0)) } : {}),
    ...(entry.details && typeof entry.details === "object" ? { details: entry.details } : {})
  });
}

function parseLine(line) {
  try {
    const parsed = JSON.parse(line);
    const timestamp = Date.parse(parsed?.timestamp || "");
    return Number.isFinite(timestamp) ? { parsed, timestamp } : null;
  } catch {
    return null;
  }
}

async function readValidRecords(home) {
  try {
    const text = await fs.promises.readFile(logPath(home), "utf8");
    const cutoff = Date.now() - RETENTION_MS;
    return text.split(/\r?\n/).filter(Boolean).map(parseLine).filter((item) => item && item.timestamp >= cutoff).map((item) => item.parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function taskRoutingLevel(event) {
  if (event === "repo_task_begin_rejected") return "error";
  if (event === "profile_activity_without_task" || event === "repo_task_profile_rerouted") return "warn";
  return "info";
}

function normalizeProfileTaskEvent(parsed) {
  const timestamp = String(parsed?.at || "");
  const event = String(parsed?.event || "").slice(0, 160);
  if (!event || !Number.isFinite(Date.parse(timestamp))) return null;
  const details = Object.fromEntries(Object.entries(parsed || {}).filter(([key]) => key !== "at" && key !== "event"));
  const fingerprint = createHash("sha256").update(`${timestamp}\n${event}\n${JSON.stringify(details)}`, "utf8").digest("hex").slice(0, 20);
  return sanitizeDiagnosticValue({
    schema_version: 1,
    record_id: `task-${fingerprint}`,
    timestamp,
    level: taskRoutingLevel(event),
    source: "mcp-task",
    category: "task-routing",
    action: event,
    message: `CodexPro task routing: ${event}`,
    details
  });
}

async function readProfileTaskEventRecords(home) {
  const records = [];
  for (const file of profileTaskEventLogPaths(home)) {
    try {
      const text = await fs.promises.readFile(file, "utf8");
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        try {
          const record = normalizeProfileTaskEvent(JSON.parse(line));
          if (record) records.push(record);
        } catch {}
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const cutoff = Date.now() - RETENTION_MS;
  return records.filter((record) => Date.parse(record.timestamp) >= cutoff);
}

async function readRuntimeLifecycleRecords(home) {
  const records = [];
  for (const file of runtimeLifecycleLogPaths(home)) {
    try {
      const text = await fs.promises.readFile(file, "utf8");
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        const record = parseLine(line);
        if (!record) continue;
        records.push(sanitizeDiagnosticValue(record.parsed));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const cutoff = Date.now() - RETENTION_MS;
  return records.filter((record) => Date.parse(record.timestamp || "") >= cutoff);
}

export function trimToByteLimit(records) {
  let bytes = 0;
  const kept = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const line = `${JSON.stringify(records[index])}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (kept.length && bytes + lineBytes > COMPACTED_LOG_BYTES) break;
    bytes += lineBytes;
    kept.push(records[index]);
  }
  return kept.reverse();
}

function annotateIncidentOccurrences(records) {
  const incidents = new Map();
  for (const record of records) {
    const fingerprint = String(record?.details?.incident_fingerprint || "").trim();
    if (!fingerprint) continue;
    const current = incidents.get(fingerprint) || { count: 0, firstSeenAt: record.timestamp, lastSeenAt: record.timestamp };
    current.count += 1;
    if (Date.parse(record.timestamp || "") < Date.parse(current.firstSeenAt || "")) current.firstSeenAt = record.timestamp;
    if (Date.parse(record.timestamp || "") > Date.parse(current.lastSeenAt || "")) current.lastSeenAt = record.timestamp;
    incidents.set(fingerprint, current);
  }
  return records.map((record) => {
    const fingerprint = String(record?.details?.incident_fingerprint || "").trim();
    const occurrence = fingerprint ? incidents.get(fingerprint) : null;
    if (!occurrence) return record;
    return {
      ...record,
      details: {
        ...(record.details || {}),
        occurrence_count: occurrence.count,
        first_seen_at: occurrence.firstSeenAt,
        last_seen_at: occurrence.lastSeenAt
      }
    };
  });
}

async function ensureWriteTarget(home, state) {
  const file = logPath(home);
  if (!state.directoryReady) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    state.directoryReady = true;
  }
  if (state.fileSizeBytes == null) {
    try {
      state.fileSizeBytes = (await fs.promises.stat(file)).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      state.fileSizeBytes = 0;
    }
  }
  return file;
}

async function pruneDiagnosticFile(home, state) {
  const file = await ensureWriteTarget(home, state);
  const records = trimToByteLimit(await readValidRecords(home));
  if (!records.length) {
    await fs.promises.rm(file, { force: true });
    state.fileSizeBytes = 0;
  } else {
    const payload = `${records.map((item) => JSON.stringify(item)).join("\n")}\n`;
    const temp = `${file}.tmp`;
    await fs.promises.writeFile(temp, payload, "utf8");
    await fs.promises.rm(file, { force: true });
    await fs.promises.rename(temp, file);
    state.fileSizeBytes = Buffer.byteLength(payload, "utf8");
  }
  state.lastPruneAt = Date.now();
  return records.length;
}

function takeWriteBatch(state) {
  let count = 0;
  let bytes = 0;
  while (count < state.pending.length && count < MAX_WRITE_BATCH_ENTRIES) {
    const nextBytes = state.pending[count].bytes;
    if (count > 0 && bytes + nextBytes > MAX_WRITE_BATCH_BYTES) break;
    bytes += nextBytes;
    count += 1;
  }
  const batch = state.pending.splice(0, Math.max(1, count));
  state.pendingBytes = Math.max(0, state.pendingBytes - bytes);
  return { batch, bytes };
}

function trimPendingBacklog(state) {
  if (state.pending.length <= MAX_PENDING_RECORDS && state.pendingBytes <= MAX_PENDING_BYTES) return 0;
  const targetRecords = Math.floor(MAX_PENDING_RECORDS * PENDING_BACKLOG_TARGET_RATIO);
  const targetBytes = Math.floor(MAX_PENDING_BYTES * PENDING_BACKLOG_TARGET_RATIO);
  let count = 0;
  let bytes = 0;
  while (
    count < state.pending.length
    && (state.pending.length - count > targetRecords || state.pendingBytes - bytes > targetBytes)
  ) {
    bytes += state.pending[count].bytes;
    count += 1;
  }
  if (!count) return 0;
  const dropped = state.pending.splice(0, count);
  state.pendingBytes = Math.max(0, state.pendingBytes - bytes);
  state.droppedCount += dropped.length;
  for (const item of dropped) item.resolve({ dropped: true });
  return dropped.length;
}

function scheduleDiagnosticFlush(home, state) {
  if (state.scheduled) return state.flushPromise;
  state.scheduled = true;
  const task = writeQueue.catch(() => undefined).then(async () => {
    try {
      const file = await ensureWriteTarget(home, state);
      while (state.pending.length) {
        const { batch, bytes } = takeWriteBatch(state);
        try {
          await fs.promises.appendFile(file, batch.map((item) => item.line).join(""), "utf8");
          state.fileSizeBytes = Math.max(0, Number(state.fileSizeBytes) || 0) + bytes;
          for (const item of batch) item.resolve();
        } catch (error) {
          for (const item of batch) item.reject(error);
          throw error;
        }
      }
      if (state.droppedCount > 0) {
        const droppedCount = state.droppedCount;
        const warning = normalizeRecord({
          level: "warn",
          source: "manager",
          category: "logging",
          action: "diagnostic-backpressure",
          message: `Đã bỏ qua ${droppedCount} log cũ do hàng đợi ghi quá lớn`,
          details: {
            dropped_count: droppedCount,
            max_pending_records: MAX_PENDING_RECORDS,
            max_pending_bytes: MAX_PENDING_BYTES
          }
        });
        const warningLine = `${JSON.stringify(warning)}\n`;
        await fs.promises.appendFile(file, warningLine, "utf8");
        state.fileSizeBytes = Math.max(0, Number(state.fileSizeBytes) || 0) + Buffer.byteLength(warningLine, "utf8");
        state.droppedCount = 0;
      }
      if (Date.now() - state.lastPruneAt >= PRUNE_INTERVAL_MS || Number(state.fileSizeBytes) > MAX_LOG_BYTES) {
        await pruneDiagnosticFile(home, state);
      }
    } catch (error) {
      const pending = state.pending.splice(0);
      state.pendingBytes = 0;
      for (const item of pending) item.reject(error);
    } finally {
      state.scheduled = false;
      if (state.pending.length) scheduleDiagnosticFlush(home, state);
    }
  });
  state.flushPromise = task;
  writeQueue = task;
  return task;
}

export function appendDiagnosticLog(home, entry) {
  const record = normalizeRecord(entry);
  const line = `${JSON.stringify(record)}\n`;
  const state = writeState(home);
  const promise = new Promise((resolve, reject) => {
    const bytes = Buffer.byteLength(line, "utf8");
    state.pending.push({ line, bytes, resolve, reject });
    state.pendingBytes += bytes;
    trimPendingBacklog(state);
  });
  scheduleDiagnosticFlush(home, state);
  return promise;
}

export async function flushDiagnosticLogs(home) {
  const state = writeState(home);
  if (state.pending.length && !state.scheduled) scheduleDiagnosticFlush(home, state);
  await state.flushPromise.catch(() => undefined);
}

export async function pruneDiagnosticLogs(home) {
  await flushDiagnosticLogs(home);
  const state = writeState(home);
  const task = writeQueue.catch(() => undefined).then(() => pruneDiagnosticFile(home, state));
  writeQueue = task;
  state.flushPromise = task;
  return task;
}

export async function readDiagnosticLogs(home, options = {}) {
  await flushDiagnosticLogs(home);
  const hours = Math.max(1, Math.min(24, Number(options.hours) || 24));
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const level = String(options.level || "all");
  const source = String(options.source || "all").toLowerCase();
  const category = String(options.category || "all").toLowerCase();
  const query = String(options.query || "").trim().toLowerCase().slice(0, 200);
  const limit = Math.max(1, Math.min(MAX_READ_ENTRIES, Number(options.limit) || 1000));
  const windowRecords = annotateIncidentOccurrences([
    ...await readValidRecords(home),
    ...await readProfileTaskEventRecords(home),
    ...await readRuntimeLifecycleRecords(home)
  ].filter((item) => {
    const timestamp = Date.parse(item.timestamp || "");
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  }).sort((left, right) => Date.parse(left.timestamp || "") - Date.parse(right.timestamp || "")));
  const records = windowRecords.filter((item) => {
    if (level !== "all" && item.level !== level) return false;
    if (source !== "all" && String(item.source || "").toLowerCase() !== source) return false;
    if (category !== "all" && String(item.category || "").toLowerCase() !== category) return false;
    if (query) {
      const haystack = `${item.source || ""} ${item.category || ""} ${item.action || ""} ${item.message || ""} ${JSON.stringify(item.details || {})}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
  const entries = records.slice(-limit).reverse();
  const summary = entries.reduce((acc, item) => {
    acc.total += 1;
    acc[item.level] = (acc[item.level] || 0) + 1;
    if (item.source === "user" && item.category === "user-reported-error") acc.user_reported_error += 1;
    return acc;
  }, { total: 0, info: 0, warn: 0, error: 0, user_reported_error: 0 });
  summary.user_reported_incidents = new Set(entries
    .filter((item) => item.source === "user" && item.category === "user-reported-error")
    .map((item) => String(item?.details?.incident_fingerprint || item.record_id || ""))
    .filter(Boolean)).size;
  const available = windowRecords.reduce((acc, item) => {
    const sourceName = String(item.source || "manager");
    const categoryName = String(item.category || "runtime");
    acc.levels[item.level] = (acc.levels[item.level] || 0) + 1;
    acc.sources[sourceName] = (acc.sources[sourceName] || 0) + 1;
    acc.categories[categoryName] = (acc.categories[categoryName] || 0) + 1;
    return acc;
  }, { levels: { info: 0, warn: 0, error: 0 }, sources: {}, categories: {} });
  return {
    retention_hours: 24,
    queried_hours: hours,
    checked_at: new Date().toISOString(),
    summary,
    available,
    entries,
    sources: Object.keys(available.sources).sort(),
    categories: Object.keys(available.categories).sort()
  };
}

export async function clearDiagnosticLogs(home) {
  await flushDiagnosticLogs(home);
  const state = writeState(home);
  const task = writeQueue.catch(() => undefined).then(async () => {
    await Promise.all([
      fs.promises.rm(logPath(home), { force: true }),
      ...profileTaskEventLogPaths(home).map((file) => fs.promises.rm(file, { force: true })),
      ...runtimeLifecycleLogPaths(home).map((file) => fs.promises.rm(file, { force: true }))
    ]);
    state.fileSizeBytes = 0;
    state.lastPruneAt = Date.now();
    return { cleared: true, timestamp: new Date().toISOString() };
  });
  writeQueue = task;
  state.flushPromise = task;
  return task;
}

export const DIAGNOSTIC_RETENTION_HOURS = 24;
