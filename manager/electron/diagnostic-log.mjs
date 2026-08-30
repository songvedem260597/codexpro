import fs from "node:fs";
import path from "node:path";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_READ_ENTRIES = 5000;
const MAX_STRING_LENGTH = 4000;
const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|refresh[_-]?token|data[_-]?base64|base64)/i;
let writeQueue = Promise.resolve();
let lastPruneAt = 0;

function logPath(home) {
  return path.join(home, "manager-diagnostic.jsonl");
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
  return sanitizeDiagnosticValue({
    schema_version: 1,
    timestamp: new Date().toISOString(),
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

function trimToByteLimit(records) {
  let bytes = 0;
  const kept = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const line = `${JSON.stringify(records[index])}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (kept.length && bytes + lineBytes > MAX_LOG_BYTES) break;
    bytes += lineBytes;
    kept.unshift(records[index]);
  }
  return kept;
}

export async function pruneDiagnosticLogs(home) {
  const file = logPath(home);
  const records = trimToByteLimit(await readValidRecords(home));
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  if (!records.length) {
    await fs.promises.rm(file, { force: true });
  } else {
    const temp = `${file}.tmp`;
    await fs.promises.writeFile(temp, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    await fs.promises.rm(file, { force: true });
    await fs.promises.rename(temp, file);
  }
  lastPruneAt = Date.now();
  return records.length;
}

export function appendDiagnosticLog(home, entry) {
  const record = normalizeRecord(entry);
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const file = logPath(home);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    if (Date.now() - lastPruneAt > 30 * 60 * 1000) await pruneDiagnosticLogs(home);
    await fs.promises.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    try {
      const stat = await fs.promises.stat(file);
      if (stat.size > MAX_LOG_BYTES) await pruneDiagnosticLogs(home);
    } catch {}
  });
  return writeQueue;
}

export async function readDiagnosticLogs(home, options = {}) {
  await writeQueue.catch(() => undefined);
  const hours = Math.max(1, Math.min(24, Number(options.hours) || 24));
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const level = String(options.level || "all");
  const source = String(options.source || "all").toLowerCase();
  const category = String(options.category || "all").toLowerCase();
  const query = String(options.query || "").trim().toLowerCase().slice(0, 200);
  const limit = Math.max(1, Math.min(MAX_READ_ENTRIES, Number(options.limit) || 1000));
  const records = (await readValidRecords(home)).filter((item) => {
    const timestamp = Date.parse(item.timestamp || "");
    if (!Number.isFinite(timestamp) || timestamp < cutoff) return false;
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
    return acc;
  }, { total: 0, info: 0, warn: 0, error: 0 });
  return {
    retention_hours: 24,
    queried_hours: hours,
    checked_at: new Date().toISOString(),
    summary,
    entries,
    sources: [...new Set(records.map((item) => String(item.source || "manager")))].sort(),
    categories: [...new Set(records.map((item) => String(item.category || "runtime")))].sort()
  };
}

export async function clearDiagnosticLogs(home) {
  await writeQueue.catch(() => undefined);
  await fs.promises.rm(logPath(home), { force: true });
  lastPruneAt = Date.now();
  return { cleared: true, timestamp: new Date().toISOString() };
}

export const DIAGNOSTIC_RETENTION_HOURS = 24;
