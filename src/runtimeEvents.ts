import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "./guard.js";

const RUNTIME_EVENT_SCHEMA_VERSION = 1;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_READ_EVENTS = 10_000;
const eventWriteQueues = new Map<string, Promise<void>>();

export type RuntimeEventWorkspace = Pick<Workspace, "id">;
export type RuntimeEventType =
  | "task.started"
  | "task.checkpointed"
  | "task.completed"
  | "task.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed";

export type RuntimeEventPayloadValue = string | number | boolean | null;
export type RuntimeEventPayload = Record<string, RuntimeEventPayloadValue>;

export interface RuntimeEvent {
  schemaVersion: 1;
  eventId: string;
  type: RuntimeEventType;
  timestamp: string;
  workspaceId: string;
  source: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  taskId?: string;
  taskTitle?: string;
  profileId?: string;
  workerId?: string;
  conversationId?: string;
  payload?: RuntimeEventPayload;
}

export interface RuntimeEventInput {
  type: RuntimeEventType;
  source: string;
  timestampMs?: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  taskId?: string;
  taskTitle?: string;
  profileId?: string;
  workerId?: string;
  conversationId?: string;
  payload?: RuntimeEventPayload;
}

export interface TaskRuntimeState {
  workspaceId: string;
  taskId: string;
  taskTitle?: string;
  status: "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  lastEventAt: string;
  lastEventId: string;
  eventCount: number;
  activeToolCount: number;
  activeTools: Array<{
    spanId: string;
    name: string;
    action?: string;
    startedAt: string;
  }>;
  lastFailure?: {
    source: string;
    type: RuntimeEventType;
    at: string;
    tool?: string;
    action?: string;
  };
}

function codexProHome(): string {
  const configured = process.env.CODEXPRO_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codexpro");
}

function safeWorkspaceId(workspace: RuntimeEventWorkspace): string {
  return String(workspace.id || "workspace").replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function runtimeEventPath(workspace: RuntimeEventWorkspace): string {
  return path.join(codexProHome(), "runtime-events", `${safeWorkspaceId(workspace)}.jsonl`);
}

function previousRuntimeEventPath(workspace: RuntimeEventWorkspace): string {
  return path.join(codexProHome(), "runtime-events", `${safeWorkspaceId(workspace)}.previous.jsonl`);
}

function boundedText(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, max);
}

function normalizedPayload(payload: RuntimeEventPayload | undefined): RuntimeEventPayload | undefined {
  if (!payload) return undefined;
  const entries = Object.entries(payload).slice(0, 32);
  if (!entries.length) return undefined;
  const normalized: RuntimeEventPayload = {};
  for (const [rawKey, value] of entries) {
    const key = rawKey.trim().slice(0, 80);
    if (!key) continue;
    if (/(?:token|secret|password|prompt|arguments?|args|authorization|cookie)/i.test(key)) continue;
    normalized[key] = typeof value === "string" ? value.slice(0, 500) : value;
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

export function createRuntimeEvent(workspace: RuntimeEventWorkspace, input: RuntimeEventInput): RuntimeEvent {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: randomUUID(),
    type: input.type,
    timestamp: new Date(input.timestampMs ?? Date.now()).toISOString(),
    workspaceId: workspace.id,
    source: boundedText(input.source, 120) ?? "runtime",
    ...(boundedText(input.traceId, 160) ? { traceId: boundedText(input.traceId, 160) } : {}),
    ...(boundedText(input.spanId, 160) ? { spanId: boundedText(input.spanId, 160) } : {}),
    ...(boundedText(input.parentSpanId, 160) ? { parentSpanId: boundedText(input.parentSpanId, 160) } : {}),
    ...(boundedText(input.taskId, 160) ? { taskId: boundedText(input.taskId, 160) } : {}),
    ...(boundedText(input.taskTitle, 160) ? { taskTitle: boundedText(input.taskTitle, 160) } : {}),
    ...(boundedText(input.profileId, 160) ? { profileId: boundedText(input.profileId, 160) } : {}),
    ...(boundedText(input.workerId, 160) ? { workerId: boundedText(input.workerId, 160) } : {}),
    ...(boundedText(input.conversationId, 160) ? { conversationId: boundedText(input.conversationId, 160) } : {}),
    ...(normalizedPayload(input.payload) ? { payload: normalizedPayload(input.payload) } : {})
  };
}

async function rotateIfNeeded(workspace: RuntimeEventWorkspace, filePath: string, incomingBytes: number): Promise<void> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size + incomingBytes <= MAX_EVENT_BYTES) return;
    const previousPath = previousRuntimeEventPath(workspace);
    await fsp.rm(previousPath, { force: true });
    await fsp.rename(filePath, previousPath);
  } catch {
    // Event persistence must not break the operation being observed.
  }
}

function enqueueEventWrite(filePath: string, operation: () => Promise<void>): Promise<void> {
  const previous = eventWriteQueues.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  eventWriteQueues.set(filePath, next);
  return next.finally(() => {
    if (eventWriteQueues.get(filePath) === next) eventWriteQueues.delete(filePath);
  });
}

export async function recordRuntimeEvent(workspace: RuntimeEventWorkspace, input: RuntimeEventInput): Promise<RuntimeEvent> {
  const event = createRuntimeEvent(workspace, input);
  const filePath = runtimeEventPath(workspace);
  const serialized = `${JSON.stringify(event)}\n`;
  const incomingBytes = Buffer.byteLength(serialized, "utf8");
  await enqueueEventWrite(filePath, async () => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await rotateIfNeeded(workspace, filePath, incomingBytes);
    await fsp.appendFile(filePath, serialized, "utf8");
  });
  return event;
}

function isRuntimeEventType(value: unknown): value is RuntimeEventType {
  return [
    "task.started",
    "task.checkpointed",
    "task.completed",
    "task.failed",
    "tool.started",
    "tool.completed",
    "tool.failed"
  ].includes(String(value));
}

function parseRuntimeEvent(line: string, workspace: RuntimeEventWorkspace): RuntimeEvent | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<RuntimeEvent>;
    if (
      parsed.schemaVersion !== RUNTIME_EVENT_SCHEMA_VERSION ||
      parsed.workspaceId !== workspace.id ||
      typeof parsed.eventId !== "string" ||
      !isRuntimeEventType(parsed.type) ||
      typeof parsed.timestamp !== "string" ||
      typeof parsed.source !== "string"
    ) return undefined;
    return parsed as RuntimeEvent;
  } catch {
    return undefined;
  }
}

async function readEventFile(workspace: RuntimeEventWorkspace, filePath: string): Promise<RuntimeEvent[]> {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => parseRuntimeEvent(line, workspace))
      .filter((event): event is RuntimeEvent => Boolean(event));
  } catch {
    return [];
  }
}

export async function loadRuntimeEvents(workspace: RuntimeEventWorkspace, limit = MAX_READ_EVENTS): Promise<RuntimeEvent[]> {
  const boundedLimit = Math.max(1, Math.min(MAX_READ_EVENTS, Math.floor(limit)));
  const previous = await readEventFile(workspace, previousRuntimeEventPath(workspace));
  const current = await readEventFile(workspace, runtimeEventPath(workspace));
  return [...previous, ...current].slice(-boundedLimit);
}

export function reduceTaskRuntimeState(events: RuntimeEvent[], taskId: string): TaskRuntimeState | undefined {
  const relevant = events.filter((event) => event.taskId === taskId);
  if (!relevant.length) return undefined;

  const activeTools = new Map<string, { spanId: string; name: string; action?: string; startedAt: string }>();
  let taskTitle: string | undefined;
  let status: TaskRuntimeState["status"] = "running";
  let startedAt: string | undefined;
  let completedAt: string | undefined;
  let failedAt: string | undefined;
  let lastFailure: TaskRuntimeState["lastFailure"];

  for (const event of relevant) {
    if (event.taskTitle) taskTitle = event.taskTitle;

    if (event.type === "task.started") {
      activeTools.clear();
      status = "running";
      startedAt = startedAt ?? event.timestamp;
      completedAt = undefined;
      failedAt = undefined;
    } else if (event.type === "task.completed") {
      activeTools.clear();
      status = "completed";
      completedAt = event.timestamp;
    } else if (event.type === "task.failed") {
      activeTools.clear();
      status = "failed";
      failedAt = event.timestamp;
      lastFailure = {
        source: event.source,
        type: event.type,
        at: event.timestamp
      };
    }

    if (event.type === "tool.started" && event.spanId) {
      activeTools.set(event.spanId, {
        spanId: event.spanId,
        name: String(event.payload?.tool ?? "tool"),
        ...(typeof event.payload?.action === "string" && event.payload.action ? { action: event.payload.action } : {}),
        startedAt: event.timestamp
      });
    } else if ((event.type === "tool.completed" || event.type === "tool.failed") && event.spanId) {
      activeTools.delete(event.spanId);
      if (event.type === "tool.failed") {
        lastFailure = {
          source: event.source,
          type: event.type,
          at: event.timestamp,
          ...(typeof event.payload?.tool === "string" ? { tool: event.payload.tool } : {}),
          ...(typeof event.payload?.action === "string" && event.payload.action ? { action: event.payload.action } : {})
        };
      }
    }
  }

  const lastEvent = relevant[relevant.length - 1];
  return {
    workspaceId: lastEvent.workspaceId,
    taskId,
    ...(taskTitle ? { taskTitle } : {}),
    status,
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(failedAt ? { failedAt } : {}),
    lastEventAt: lastEvent.timestamp,
    lastEventId: lastEvent.eventId,
    eventCount: relevant.length,
    activeToolCount: activeTools.size,
    activeTools: [...activeTools.values()],
    ...(lastFailure ? { lastFailure } : {})
  };
}

export async function loadTaskRuntimeState(
  workspace: RuntimeEventWorkspace,
  taskId: string,
  limit = MAX_READ_EVENTS
): Promise<TaskRuntimeState | undefined> {
  return reduceTaskRuntimeState(await loadRuntimeEvents(workspace, limit), taskId);
}
