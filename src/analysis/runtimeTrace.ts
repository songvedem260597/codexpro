import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "../guard.js";

const TRACE_SCHEMA_VERSION = 1;
const MAX_TRACE_BYTES = 16 * 1024 * 1024;
const MAX_READ_SPANS = 5_000;
const writeQueues = new Map<string, Promise<void>>();
const runtimeTraceContextStorage = new AsyncLocalStorage<RuntimeTraceContext>();

export type RuntimeTraceKind = "tool" | "browser-extension" | "ipc" | "network" | "test";
export type RuntimeTraceStatus = "ok" | "error";
export type RuntimeTraceWorkspace = Pick<Workspace, "id">;

export interface RuntimeTraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  workspaceId: string;
}

export interface RuntimeTraceSpan {
  schemaVersion: 1;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  workspaceId: string;
  kind: RuntimeTraceKind;
  name: string;
  action?: string;
  source: string;
  status: RuntimeTraceStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface RuntimeTraceSpanInput {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  kind: RuntimeTraceKind;
  name: string;
  action?: string;
  source: string;
  status: RuntimeTraceStatus;
  startedAtMs: number;
  endedAtMs?: number;
}

export interface RuntimeTraceObservation {
  kind: RuntimeTraceKind;
  name: string;
  action?: string;
  observed: number;
  ok: number;
  error: number;
  totalDurationMs: number;
  lastObservedAt: string;
}

export interface RuntimeTraceSummary {
  spanCount: number;
  traceCount: number;
  observations: RuntimeTraceObservation[];
}

export function currentRuntimeTraceContext(): RuntimeTraceContext | undefined {
  return runtimeTraceContextStorage.getStore();
}

export function createRuntimeTraceContext(workspace: RuntimeTraceWorkspace, parent?: RuntimeTraceContext): RuntimeTraceContext {
  return {
    traceId: parent?.traceId ?? randomUUID(),
    spanId: randomUUID(),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    workspaceId: workspace.id
  };
}

export function runWithRuntimeTraceContext<T>(context: RuntimeTraceContext, operation: () => T): T {
  return runtimeTraceContextStorage.run(context, operation);
}

function codexProHome(): string {
  const configured = process.env.CODEXPRO_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codexpro");
}

function safeWorkspaceId(workspace: RuntimeTraceWorkspace): string {
  return String(workspace.id || "workspace").replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function runtimeTracePath(workspace: RuntimeTraceWorkspace): string {
  return path.join(codexProHome(), "runtime-traces", `${safeWorkspaceId(workspace)}.jsonl`);
}

function previousRuntimeTracePath(workspace: RuntimeTraceWorkspace): string {
  return path.join(codexProHome(), "runtime-traces", `${safeWorkspaceId(workspace)}.previous.jsonl`);
}

async function rotateIfNeeded(workspace: RuntimeTraceWorkspace, filePath: string, incomingBytes: number): Promise<void> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size + incomingBytes <= MAX_TRACE_BYTES) return;
    const previousPath = previousRuntimeTracePath(workspace);
    await fsp.rm(previousPath, { force: true });
    await fsp.rename(filePath, previousPath);
  } catch {
    // Missing trace files need no rotation. Recording must never break the tool being observed.
  }
}

function enqueue(filePath: string, operation: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  writeQueues.set(filePath, next);
  return next.finally(() => {
    if (writeQueues.get(filePath) === next) writeQueues.delete(filePath);
  });
}

export function createRuntimeTraceSpan(workspace: RuntimeTraceWorkspace, input: RuntimeTraceSpanInput): RuntimeTraceSpan {
  const endedAtMs = input.endedAtMs ?? Date.now();
  const startedAtMs = Math.min(input.startedAtMs, endedAtMs);
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    traceId: input.traceId || randomUUID(),
    spanId: input.spanId || randomUUID(),
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    workspaceId: workspace.id,
    kind: input.kind,
    name: input.name,
    ...(input.action ? { action: input.action } : {}),
    source: input.source,
    status: input.status,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - startedAtMs)
  };
}

export async function recordRuntimeTraceSpan(workspace: RuntimeTraceWorkspace, input: RuntimeTraceSpanInput): Promise<RuntimeTraceSpan> {
  const span = createRuntimeTraceSpan(workspace, input);
  const filePath = runtimeTracePath(workspace);
  const serialized = `${JSON.stringify(span)}\n`;
  const incomingBytes = Buffer.byteLength(serialized, "utf8");
  await enqueue(filePath, async () => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await rotateIfNeeded(workspace, filePath, incomingBytes);
    await fsp.appendFile(filePath, serialized, "utf8");
  });
  return span;
}

function parseSpan(line: string, workspace: RuntimeTraceWorkspace): RuntimeTraceSpan | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<RuntimeTraceSpan>;
    if (
      parsed.schemaVersion !== TRACE_SCHEMA_VERSION ||
      parsed.workspaceId !== workspace.id ||
      typeof parsed.traceId !== "string" ||
      typeof parsed.spanId !== "string" ||
      typeof parsed.kind !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.source !== "string" ||
      (parsed.status !== "ok" && parsed.status !== "error") ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.endedAt !== "string" ||
      typeof parsed.durationMs !== "number"
    ) return undefined;
    return parsed as RuntimeTraceSpan;
  } catch {
    return undefined;
  }
}

async function readTraceFile(workspace: RuntimeTraceWorkspace, filePath: string): Promise<RuntimeTraceSpan[]> {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => parseSpan(line, workspace)).filter((span): span is RuntimeTraceSpan => Boolean(span));
  } catch {
    return [];
  }
}

export async function loadRuntimeTraceSpans(workspace: RuntimeTraceWorkspace, limit = MAX_READ_SPANS): Promise<RuntimeTraceSpan[]> {
  const boundedLimit = Math.max(1, Math.min(MAX_READ_SPANS, Math.floor(limit)));
  const previous = await readTraceFile(workspace, previousRuntimeTracePath(workspace));
  const current = await readTraceFile(workspace, runtimeTracePath(workspace));
  return [...previous, ...current].slice(-boundedLimit);
}
