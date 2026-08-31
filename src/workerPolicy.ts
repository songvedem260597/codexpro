import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { codexProHome } from "./profileStore.js";

export const WORKER_POLICY_VERSION = "worker-policy-v1";

export type WorkerJobKind = "general" | "code";
export type WorkerJobScope = "workspace" | "all_allowed";
export type WorkerJobStatus = "prepared" | "running" | "completed" | "failed" | "cancelled" | "blocked";

export type WorkerJobRecord = {
  version: 1;
  policyVersion: string;
  jobId: string;
  workerId: string;
  status: WorkerJobStatus;
  scope: WorkerJobScope;
  root: string;
  title: string;
  kind?: WorkerJobKind;
  workspaceId?: string;
  preparedAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  rulesHash?: string;
  rulesPath?: string;
  agentsFiles: string[];
  agentsHash?: string;
  codexGraphActive: boolean;
  codexGraphSymbolCount?: number;
  codexGraphRelationshipCount?: number;
  requiredObligations: string[];
  completedObligations: string[];
  summary?: string;
  error?: string;
  events: Array<{ at: string; type: string; details?: Record<string, unknown> }>;
};

const writeTails = new Map<string, Promise<void>>();
const MAX_EVENTS = 100;

function workerJobsDir(): string {
  return path.join(codexProHome(), "worker-jobs");
}

function jobPath(jobId: string): string {
  if (!/^cpt_[a-f0-9]{24}$/.test(jobId)) throw new Error("Worker job id is invalid.");
  return path.join(workerJobsDir(), `${jobId}.json`);
}

function clean(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function uniqueStrings(values: unknown, maxItems = 100): string[] {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => clean(value, 300))
    .filter(Boolean))].slice(0, maxItems);
}

function normalizeRecord(value: unknown): WorkerJobRecord | undefined {
  const source = value && typeof value === "object" ? value as Partial<WorkerJobRecord> : {};
  const jobId = clean(source.jobId, 40);
  const workerId = clean(source.workerId, 160);
  if (!/^cpt_[a-f0-9]{24}$/.test(jobId) || !workerId) return undefined;
  const status: WorkerJobStatus = ["prepared", "running", "completed", "failed", "cancelled", "blocked"].includes(String(source.status))
    ? source.status as WorkerJobStatus
    : "prepared";
  const scope: WorkerJobScope = source.scope === "all_allowed" ? "all_allowed" : "workspace";
  return {
    version: 1,
    policyVersion: clean(source.policyVersion, 80) || WORKER_POLICY_VERSION,
    jobId,
    workerId,
    status,
    scope,
    root: clean(source.root, 2048),
    title: clean(source.title, 120),
    kind: source.kind === "general" || source.kind === "code" ? source.kind : undefined,
    workspaceId: clean(source.workspaceId, 160) || undefined,
    preparedAt: clean(source.preparedAt, 80) || new Date().toISOString(),
    startedAt: clean(source.startedAt, 80) || undefined,
    finishedAt: clean(source.finishedAt, 80) || undefined,
    updatedAt: clean(source.updatedAt, 80) || new Date().toISOString(),
    rulesHash: clean(source.rulesHash, 128) || undefined,
    rulesPath: clean(source.rulesPath, 2048) || undefined,
    agentsFiles: uniqueStrings(source.agentsFiles),
    agentsHash: clean(source.agentsHash, 128) || undefined,
    codexGraphActive: source.codexGraphActive === true,
    codexGraphSymbolCount: Number.isFinite(source.codexGraphSymbolCount) ? Number(source.codexGraphSymbolCount) : undefined,
    codexGraphRelationshipCount: Number.isFinite(source.codexGraphRelationshipCount) ? Number(source.codexGraphRelationshipCount) : undefined,
    requiredObligations: uniqueStrings(source.requiredObligations),
    completedObligations: uniqueStrings(source.completedObligations),
    summary: clean(source.summary, 4000) || undefined,
    error: clean(source.error, 4000) || undefined,
    events: (Array.isArray(source.events) ? source.events : []).slice(-MAX_EVENTS).map((event) => ({
      at: clean(event?.at, 80) || new Date().toISOString(),
      type: clean(event?.type, 100) || "unknown",
      ...(event?.details && typeof event.details === "object" ? { details: event.details } : {})
    }))
  };
}

export function readWorkerJob(jobId: string): WorkerJobRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(jobPath(jobId), "utf8"));
    return normalizeRecord(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    return undefined;
  }
}

async function atomicWrite(record: WorkerJobRecord): Promise<void> {
  const destination = jobPath(record.jobId);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fsp.rename(temporary, destination);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function updateWorkerJob(jobId: string, update: (current: WorkerJobRecord | undefined) => WorkerJobRecord): Promise<WorkerJobRecord> {
  let result!: WorkerJobRecord;
  const previous = writeTails.get(jobId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    result = normalizeRecord(update(readWorkerJob(jobId)))!;
    if (!result) throw new Error("Worker job update produced an invalid record.");
    result.updatedAt = new Date().toISOString();
    result.events = result.events.slice(-MAX_EVENTS);
    await atomicWrite(result);
  });
  writeTails.set(jobId, next);
  try {
    await next;
    return result;
  } finally {
    if (writeTails.get(jobId) === next) writeTails.delete(jobId);
  }
}

function event(type: string, details?: Record<string, unknown>): WorkerJobRecord["events"][number] {
  return { at: new Date().toISOString(), type: clean(type, 100), ...(details ? { details } : {}) };
}

export async function prepareWorkerJob(input: {
  jobId: string;
  workerId: string;
  root?: string;
  scope: WorkerJobScope;
}): Promise<WorkerJobRecord> {
  const preparedAt = new Date().toISOString();
  return await updateWorkerJob(input.jobId, (current) => ({
    version: 1,
    policyVersion: WORKER_POLICY_VERSION,
    jobId: input.jobId,
    workerId: clean(input.workerId, 160),
    status: "prepared",
    scope: input.scope,
    root: clean(input.root, 2048),
    title: current?.title || "",
    kind: current?.kind,
    workspaceId: current?.workspaceId,
    preparedAt: current?.preparedAt || preparedAt,
    updatedAt: preparedAt,
    agentsFiles: current?.agentsFiles || [],
    codexGraphActive: current?.codexGraphActive || false,
    requiredObligations: current?.requiredObligations || [],
    completedObligations: current?.completedObligations || [],
    events: [...(current?.events || []), event("prepared", { worker_id: input.workerId, scope: input.scope, root: input.root })]
  }));
}

export async function bootstrapWorkerJob(input: {
  jobId: string;
  workerId: string;
  title: string;
  kind: WorkerJobKind;
  root: string;
  workspaceId: string;
  scope: WorkerJobScope;
  rulesHash?: string;
  rulesPath?: string;
  agentsFiles?: string[];
  agentsHash?: string;
  codexGraphActive?: boolean;
  codexGraphSymbolCount?: number;
  codexGraphRelationshipCount?: number;
}): Promise<WorkerJobRecord> {
  return await updateWorkerJob(input.jobId, (current) => {
    if (current && current.workerId !== input.workerId) throw new Error("Worker job owner mismatch.");
    const requiredObligations = input.kind === "code" ? ["global_rules", "agents_chain", "codexgraph"] : ["job_title"];
    const completedObligations = input.kind === "code"
      ? [
          ...(input.rulesHash ? ["global_rules"] : []),
          ...(input.agentsHash ? ["agents_chain"] : []),
          ...(input.codexGraphActive ? ["codexgraph"] : [])
        ]
      : ["job_title"];
    return {
      ...(current || {
        version: 1 as const,
        policyVersion: WORKER_POLICY_VERSION,
        jobId: input.jobId,
        workerId: input.workerId,
        preparedAt: new Date().toISOString(),
        agentsFiles: [],
        codexGraphActive: false,
        requiredObligations: [],
        completedObligations: [],
        events: []
      }),
      status: "running",
      scope: input.scope,
      root: input.root,
      title: clean(input.title, 120),
      kind: input.kind,
      workspaceId: input.workspaceId,
      startedAt: current?.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rulesHash: input.rulesHash,
      rulesPath: input.rulesPath,
      agentsFiles: uniqueStrings(input.agentsFiles),
      agentsHash: input.agentsHash,
      codexGraphActive: input.codexGraphActive === true,
      codexGraphSymbolCount: input.codexGraphSymbolCount,
      codexGraphRelationshipCount: input.codexGraphRelationshipCount,
      requiredObligations,
      completedObligations,
      events: [...(current?.events || []), event("bootstrapped", { kind: input.kind, policy_version: WORKER_POLICY_VERSION })]
    };
  });
}

export async function finalizeWorkerJob(input: {
  jobId: string;
  workerId?: string;
  outcome: "completed" | "failed" | "cancelled";
  completedObligations?: string[];
  summary?: string;
  error?: string;
}): Promise<WorkerJobRecord> {
  return await updateWorkerJob(input.jobId, (current) => {
    if (!current) throw new Error("Worker job was not prepared.");
    if (input.workerId && current.workerId !== input.workerId) throw new Error("Worker job owner mismatch.");
    const completed = uniqueStrings([...current.completedObligations, ...(input.completedObligations || [])]);
    const missing = current.requiredObligations.filter((obligation) => !completed.includes(obligation));
    if (input.outcome === "completed" && missing.length) {
      throw new Error(`Worker job cannot complete; missing obligations: ${missing.join(", ")}.`);
    }
    return {
      ...current,
      status: input.outcome,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedObligations: completed,
      summary: clean(input.summary, 4000) || current.summary,
      error: clean(input.error, 4000) || current.error,
      events: [...current.events, event("finalized", { outcome: input.outcome, missing_obligations: missing })]
    };
  });
}

export function workerJobPublicRecord(record: WorkerJobRecord | undefined): Record<string, unknown> | undefined {
  if (!record) return undefined;
  const missingObligations = record.requiredObligations.filter((obligation) => !record.completedObligations.includes(obligation));
  return {
    policy_version: record.policyVersion,
    job_id: record.jobId,
    worker_id: record.workerId,
    status: record.status,
    scope: record.scope,
    root: record.root,
    title: record.title,
    kind: record.kind,
    workspace_id: record.workspaceId,
    prepared_at: record.preparedAt,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    updated_at: record.updatedAt,
    rules_hash: record.rulesHash,
    rules_path: record.rulesPath,
    agents_files: record.agentsFiles,
    agents_hash: record.agentsHash,
    codexgraph_active: record.codexGraphActive,
    codexgraph_symbol_count: record.codexGraphSymbolCount,
    codexgraph_relationship_count: record.codexGraphRelationshipCount,
    required_obligations: record.requiredObligations,
    completed_obligations: record.completedObligations,
    missing_obligations: missingObligations,
    summary: record.summary,
    error: record.error,
    events: record.events.slice(-20)
  };
}
