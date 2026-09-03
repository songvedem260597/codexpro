import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_STRING_LENGTH = 4_000;
const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|refresh[_-]?token|private[_-]?key)/i;

export function runtimeLifecycleLogPaths(home = path.join(os.homedir(), '.codexpro')) {
  const current = path.join(home, 'runtime-lifecycle.jsonl');
  return [`${current}.1`, current];
}

export function cloudflaredOutputLevel(line) {
  const text = String(line ?? '').trim();
  if (!text) return 'info';
  if (/\bcontext cancel(?:l)?ed\b/i.test(text)) return null;
  if (/\b(error|failed|failure|unable|fatal|panic)\b/i.test(text)) return 'error';
  if (/\b(warn|warning|timeout|reconnect|retry|closed|disconnect)\b/i.test(text)) return 'warn';
  return 'info';
}

function scrubString(value) {
  return String(value ?? '')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:codexpro_token|token|api_key|apikey|access_token|refresh_token)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/((?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, MAX_STRING_LENGTH);
}

export function sanitizeRuntimeLifecycleValue(value, depth = 0) {
  if (depth > 5) return '[TRUNCATED]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return scrubString(value);
  if (value instanceof Error) {
    return {
      name: scrubString(value.name),
      message: scrubString(value.message),
      code: scrubString(value.code || ''),
      stack: scrubString(value.stack || '')
    };
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeRuntimeLifecycleValue(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 60)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeRuntimeLifecycleValue(item, depth + 1);
    }
    return output;
  }
  return scrubString(value);
}

function pruneExpiredFiles(home) {
  const cutoff = Date.now() - RETENTION_MS;
  for (const file of runtimeLifecycleLogPaths(home)) {
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function rotateIfNeeded(home, incomingBytes) {
  pruneExpiredFiles(home);
  const [, current] = runtimeLifecycleLogPaths(home);
  try {
    if (fs.statSync(current).size + incomingBytes <= MAX_LOG_BYTES) return;
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  fs.rmSync(`${current}.1`, { force: true });
  fs.renameSync(current, `${current}.1`);
}

export function appendRuntimeLifecycleLog(home, entry = {}) {
  const targetHome = path.resolve(home || path.join(os.homedir(), '.codexpro'));
  const [, current] = runtimeLifecycleLogPaths(targetHome);
  const record = sanitizeRuntimeLifecycleValue({
    schema_version: 1,
    record_id: String(entry.record_id || `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomUUID().slice(0, 8)}`),
    timestamp: String(entry.timestamp || new Date().toISOString()),
    level: ['info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info',
    source: 'runtime',
    category: 'lifecycle',
    action: String(entry.action || '').slice(0, 160),
    message: String(entry.message || '').slice(0, MAX_STRING_LENGTH),
    ...(entry.details && typeof entry.details === 'object' ? { details: entry.details } : {})
  });
  const line = `${JSON.stringify(record)}\n`;
  fs.mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  rotateIfNeeded(targetHome, Buffer.byteLength(line, 'utf8'));
  fs.appendFileSync(current, line, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(current, 0o600); } catch {}
  return record;
}

export function createRuntimeLifecycleLogger(options = {}) {
  const home = path.resolve(options.home || path.join(os.homedir(), '.codexpro'));
  const runId = String(options.runId || randomUUID());
  const pid = Number(options.pid || process.pid);
  return {
    home,
    runId,
    append(action, message, details = {}, level = 'info') {
      return appendRuntimeLifecycleLog(home, {
        level,
        action,
        message,
        details: { run_id: runId, launcher_pid: pid, ...details }
      });
    }
  };
}
