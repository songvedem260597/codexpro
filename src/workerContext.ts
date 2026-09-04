import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { codexProHome } from "./profileStore.js";

export const MAX_WORKER_CONTEXT_CHECKPOINTS = 3;
const MAX_WORKER_CONTEXT_ENTRIES = 300;

export type WorkerContextScope = "workspace" | "all_allowed";
export type WorkerContextKind = "general" | "code";
export type WorkerContextTaskSize = "small" | "medium" | "large";
export type WorkerContextStage = "started" | "partial" | "all_parts_done" | "verifying" | "blocked" | "error" | "stalled";
export type WorkerContextChecklistStatus = "pending" | "in_progress" | "completed" | "blocked";

export type WorkerContextChecklistItem = {
  id: string;
  title: string;
  status: WorkerContextChecklistStatus;
  evidence?: string;
};

export type WorkerContextCheckpoint = {
  version: 1;
  workerId: string;
  root: string;
  scope: WorkerContextScope;
  taskId: string;
  taskTitle: string;
  taskKind?: WorkerContextKind;
  taskSize?: WorkerContextTaskSize;
  at: string;
  sequence: number;
  stage: WorkerContextStage;
  progressPercent: number;
  summary: string;
  reason?: string;
  evidence?: string;
  blockedPart?: string;
  completedParts: string[];
  remainingParts: string[];
  checklist: WorkerContextChecklistItem[];
};

let writeTail: Promise<void> = Promise.resolve();

function storeFile(): string {
  return path.join(codexProHome(), "worker-context-checkpoints.json");
}

function clean(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function uniqueStrings(values: unknown, maxItems = 20): string[] {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => clean(value, 300))
    .filter(Boolean))].slice(0, maxItems);
}

function ownerKey(value: unknown): string {
  const workerId = clean(value, 160);
  return workerId.startsWith("browser:") ? workerId.slice("browser:".length) : workerId;
}

function projectRootKey(value: unknown, scope: WorkerContextScope): string {
  const root = clean(value, 2048);
  if (!root) return scope === "all_allowed" ? "__all_allowed__" : "__workspace__";
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function groupKey(workerId: unknown, root: unknown, scope: WorkerContextScope): string {
  return `${ownerKey(workerId)}\u0000${scope}\u0000${projectRootKey(root, scope)}`;
}

function normalizeStage(value: unknown): WorkerContextStage | undefined {
  const stage = clean(value, 40);
  return ["started", "partial", "all_parts_done", "verifying", "blocked", "error", "stalled"].includes(stage)
    ? stage as WorkerContextStage
    : undefined;
}

function normalizeChecklist(value: unknown): WorkerContextChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = item && typeof item === "object" ? item as Partial<WorkerContextChecklistItem> : {};
    const id = clean(source.id, 80);
    const title = clean(source.title, 300);
    const status = clean(source.status, 40) as WorkerContextChecklistStatus;
    if (!id || !title || !["pending", "in_progress", "completed", "blocked"].includes(status)) return [];
    return [{ id, title, status, evidence: clean(source.evidence, 1000) || undefined }];
  }).slice(0, 50);
}

function normalizeCheckpoint(value: unknown): WorkerContextCheckpoint | undefined {
  const source = value && typeof value === "object" ? value as Partial<WorkerContextCheckpoint> : {};
  const workerId = clean(source.workerId, 160);
  const taskId = clean(source.taskId, 40);
  const scope: WorkerContextScope = source.scope === "all_allowed" ? "all_allowed" : "workspace";
  const stage = normalizeStage(source.stage);
  const at = clean(source.at, 80);
  const summary = clean(source.summary, 1200);
  if (!workerId || !/^cpt_[a-f0-9]{24}$/.test(taskId) || !stage || !at || !summary) return undefined;
  return {
    version: 1,
    workerId,
    root: clean(source.root, 2048),
    scope,
    taskId,
    taskTitle: clean(source.taskTitle, 120),
    taskKind: source.taskKind === "general" || source.taskKind === "code" ? source.taskKind : undefined,
    taskSize: ["small", "medium", "large"].includes(String(source.taskSize)) ? source.taskSize as WorkerContextTaskSize : undefined,
    at,
    sequence: Math.max(1, Math.floor(Number(source.sequence) || 1)),
    stage,
    progressPercent: Math.max(0, Math.min(100, Math.round(Number(source.progressPercent) || 0))),
    summary,
    reason: clean(source.reason, 1200) || undefined,
    evidence: clean(source.evidence, 1200) || undefined,
    blockedPart: clean(source.blockedPart, 300) || undefined,
    completedParts: uniqueStrings(source.completedParts),
    remainingParts: uniqueStrings(source.remainingParts),
    checklist: normalizeChecklist(source.checklist)
  };
}

function readStore(): WorkerContextCheckpoint[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
    return (Array.isArray(parsed?.checkpoints) ? parsed.checkpoints : [])
      .map((checkpoint: unknown) => normalizeCheckpoint(checkpoint))
      .filter((checkpoint: WorkerContextCheckpoint | undefined): checkpoint is WorkerContextCheckpoint => Boolean(checkpoint))
      .slice(-MAX_WORKER_CONTEXT_ENTRIES);
  } catch {
    return [];
  }
}

function retainRecent(checkpoints: WorkerContextCheckpoint[]): WorkerContextCheckpoint[] {
  const grouped = new Map<string, WorkerContextCheckpoint[]>();
  for (const checkpoint of checkpoints) {
    const normalized = normalizeCheckpoint(checkpoint);
    if (!normalized) continue;
    const key = groupKey(normalized.workerId, normalized.root, normalized.scope);
    const current = grouped.get(key) || [];
    const deduped = current.filter((candidate) => !(candidate.taskId === normalized.taskId && candidate.sequence === normalized.sequence));
    deduped.push(normalized);
    deduped.sort((left, right) => (Date.parse(left.at) - Date.parse(right.at)) || (left.sequence - right.sequence));
    grouped.set(key, deduped.slice(-MAX_WORKER_CONTEXT_CHECKPOINTS));
  }
  return [...grouped.values()]
    .flat()
    .sort((left, right) => (Date.parse(left.at) - Date.parse(right.at)) || (left.sequence - right.sequence))
    .slice(-MAX_WORKER_CONTEXT_ENTRIES);
}

async function writeStore(checkpoints: WorkerContextCheckpoint[]): Promise<void> {
  const destination = storeFile();
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify({ version: 1, checkpoints: retainRecent(checkpoints) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fsp.rename(temporary, destination);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function saveWorkerContextCheckpoint(value: WorkerContextCheckpoint): Promise<WorkerContextCheckpoint | undefined> {
  const checkpoint = normalizeCheckpoint(value);
  if (!checkpoint) return undefined;
  const next = writeTail.catch(() => undefined).then(async () => {
    const current = readStore();
    current.push(checkpoint);
    await writeStore(current);
  });
  writeTail = next;
  await next;
  return checkpoint;
}

export function listWorkerContextCheckpoints(input: {
  workerId: string;
  root?: string;
  scope?: WorkerContextScope;
}): WorkerContextCheckpoint[] {
  const workerId = clean(input.workerId, 160);
  const scope: WorkerContextScope = input.scope === "all_allowed" ? "all_allowed" : "workspace";
  if (!workerId) return [];
  const key = groupKey(workerId, input.root, scope);
  return readStore()
    .filter((checkpoint) => groupKey(checkpoint.workerId, checkpoint.root, checkpoint.scope) === key)
    .sort((left, right) => (Date.parse(left.at) - Date.parse(right.at)) || (left.sequence - right.sequence))
    .slice(-MAX_WORKER_CONTEXT_CHECKPOINTS);
}
