import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE_RECORDS = 2_000;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BYTES = 12 * 1024;
const MAX_STRING = 1_000;
const CRITICAL_EVENTS = new Set(["bridge_queued", "extension_received", "network_ack", "bridge_timeout", "result_received", "late_result", "runtime_identity", "dropped_events"]);
const SENSITIVE_KEY = /(prompt|response|image|token|credential|authorization|cookie|password|secret|api[_-]?key|url|query|body|text|attachment.*data|data_base64)/i;

type TracePriority = "critical" | "normal";
interface TraceRecord {
  schema_version: number;
  event: string;
  event_at: string;
  received_at: string;
  writer_component: string;
  writer_run_id: string;
  writer_process_id: number;
  writer_sequence: number;
  writer_elapsed_ms: number;
  priority: TracePriority;
  details: Record<string, unknown>;
}
interface QueueItem { record: TraceRecord; bytes: number; priority: TracePriority; }

function sanitize(value: unknown, depth = 0): any {
  if (depth > 4) return "[TRUNCATED]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, MAX_STRING);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (value instanceof Error) return { name: String(value.name || "Error").slice(0, 120), message: String(value.message || "").slice(0, MAX_STRING), code: String((value as any).code || "").slice(0, 160) };
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 60)) output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1);
    return output;
  }
  return String(value).slice(0, MAX_STRING);
}

function safeLine(record: TraceRecord & { written_at?: string; durability?: string }): string {
  let line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, "utf8") <= MAX_EVENT_BYTES) return line;
  const compact = {
    ...record,
    details: {
      truncated: true,
      send_trace_id: String((record.details as any)?.send_trace_id || ""),
      command_id: String((record.details as any)?.command_id || ""),
      ipc_call_id: String((record.details as any)?.ipc_call_id || ""),
      attempt_id: String((record.details as any)?.attempt_id || "")
    }
  };
  return `${JSON.stringify(compact)}\n`;
}

export function createBridgeSendTraceLogger(runId: string) {
  const home = String(process.env.CODEXPRO_HOME || "").trim() ? path.resolve(String(process.env.CODEXPRO_HOME)) : path.join(os.homedir(), ".codexpro");
  const file = path.join(home, "send-trace-bridge.jsonl");
  const previous = `${file}.1`;
  const startedMono = performance.now();
  let sequence = 0;
  let queue: QueueItem[] = [];
  let queueBytes = 0;
  let droppedEvents = 0;
  let scheduled = false;
  let flushPromise = Promise.resolve();
  let fileSize: number | null = null;
  let directoryReady = false;

  const ensureTarget = async () => {
    if (!directoryReady) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      directoryReady = true;
    }
    if (fileSize == null) {
      try { fileSize = (await fs.promises.stat(file)).size; }
      catch (error: any) { if (error?.code !== "ENOENT") throw error; fileSize = 0; }
    }
  };

  const rotateIfNeeded = async () => {
    await ensureTarget();
    const cutoff = Date.now() - RETENTION_MS;
    for (const candidate of [previous, file]) {
      try {
        const stat = await fs.promises.stat(candidate);
        if (stat.mtimeMs < cutoff) await fs.promises.rm(candidate, { force: true });
      } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
    try { fileSize = (await fs.promises.stat(file)).size; }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; fileSize = 0; }
    if (Number(fileSize) < MAX_FILE_BYTES) return;
    await fs.promises.rm(previous, { force: true });
    await fs.promises.rename(file, previous);
    fileSize = 0;
  };

  const makeRecord = (event: string, details: Record<string, unknown> = {}, options: { eventAt?: string; priority?: TracePriority } = {}): TraceRecord => sanitize({
    schema_version: 1,
    event: String(event || "unknown").slice(0, 120),
    event_at: String(options.eventAt || details?.event_at || new Date().toISOString()),
    received_at: new Date().toISOString(),
    writer_component: "bridge",
    writer_run_id: runId,
    writer_process_id: process.pid,
    writer_sequence: ++sequence,
    writer_elapsed_ms: Math.max(0, Math.round((performance.now() - startedMono) * 1000) / 1000),
    priority: options.priority || (CRITICAL_EVENTS.has(event) ? "critical" : "normal"),
    details
  }) as TraceRecord;

  const trimQueue = (incomingCritical: boolean) => {
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
          const batch: QueueItem[] = [];
          if (droppedEvents) {
            const count = droppedEvents;
            droppedEvents = 0;
            const record = makeRecord("dropped_events", { dropped_events: count, max_queue_records: MAX_QUEUE_RECORDS, max_queue_bytes: MAX_QUEUE_BYTES }, { priority: "critical" });
            batch.push({ record, bytes: 0, priority: "critical" });
          }
          while (queue.length && batch.length < 100) {
            const item = queue.shift()!;
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

  const emit = (event: string, details: Record<string, unknown> = {}, options: { eventAt?: string; priority?: TracePriority } = {}) => {
    try {
      const record = makeRecord(event, details, options);
      const line = safeLine(record);
      const item: QueueItem = { record, bytes: Buffer.byteLength(line, "utf8"), priority: record.priority };
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

export const SEND_TRACE_LIMITS = Object.freeze({ max_queue_records: MAX_QUEUE_RECORDS, max_queue_bytes: MAX_QUEUE_BYTES, max_file_bytes: MAX_FILE_BYTES, max_event_bytes: MAX_EVENT_BYTES, retention_ms: RETENTION_MS });
