import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { codexProHome } from "./profileStore.js";

export const WORKER_POLICY_VERSION = "worker-policy-v1";

export type WorkerJobKind = "general" | "code";
export type WorkerJobScope = "workspace" | "all_allowed";
export type WorkerJobStatus = "prepared" | "running" | "completed" | "failed" | "cancelled" | "blocked";
export type WorkerJobProgressStage = "started" | "partial" | "all_parts_done" | "verifying" | "blocked" | "error" | "stalled";

export type WorkerJobProgressReport = {
  at: string;
  sequence: number;
  stage: WorkerJobProgressStage;
  progressPercent: number;
  summary: string;
  reason?: string;
  evidence?: string;
  blockedPart?: string;
  completedParts: string[];
  remainingParts: string[];
};

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
  progressSequence: number;
  progressReports: WorkerJobProgressReport[];
  progressPercent: number;
  completedParts: string[];
  remainingParts: string[];
  lastProgressStage?: WorkerJobProgressStage;
  lastProgressAt?: string;
  lastProgressSummary?: string;
  lastProgressReason?: string;
  blockedAt?: string;
  blockedPart?: string;
  blockedReason?: string;
  completionConfirmed: boolean;
  completionConfirmedAt?: string;
  completionEvidence?: string;
  summary?: string;
  error?: string;
  events: Array<{ at: string; type: string; details?: Record<string, unknown> }>;
};

const writeTails = new Map<string, Promise<void>>();
const workerBootstrapTails = new Map<string, Promise<void>>();
const MAX_EVENTS = 100;
const MAX_PROGRESS_REPORTS = 24;

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

function workerOwnerKey(value: unknown): string {
  const workerId = clean(value, 160);
  return workerId.startsWith("browser:") ? workerId.slice("browser:".length) : workerId;
}

function normalizeProgressStage(value: unknown): WorkerJobProgressStage | undefined {
  const stage = clean(value, 40);
  return ["started", "partial", "all_parts_done", "verifying", "blocked", "error", "stalled"].includes(stage)
    ? stage as WorkerJobProgressStage
    : undefined;
}

function normalizeProgressPercent(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(numeric) ? numeric : fallback)));
}

function deriveProgressPercent(input: {
  stage: WorkerJobProgressStage;
  explicit?: unknown;
  completedParts: string[];
  remainingParts: string[];
  currentPercent?: number;
}): number {
  if (input.explicit != null && Number.isFinite(Number(input.explicit))) return normalizeProgressPercent(input.explicit);
  if (input.stage === "started") return 0;
  if (input.stage === "all_parts_done") return 95;
  if (input.stage === "verifying") return Math.max(95, normalizeProgressPercent(input.currentPercent));
  const total = input.completedParts.length + input.remainingParts.length;
  if (total > 0) return Math.min(95, Math.round((input.completedParts.length / total) * 100));
  return normalizeProgressPercent(input.currentPercent);
}

function normalizeProgressReport(value: unknown): WorkerJobProgressReport | undefined {
  const source = value && typeof value === "object" ? value as Partial<WorkerJobProgressReport> : {};
  const stage = normalizeProgressStage(source.stage);
  const sequence = Math.max(1, Math.floor(Number(source.sequence) || 0));
  const at = clean(source.at, 80);
  const summary = clean(source.summary, 2000);
  if (!stage || !sequence || !at || !summary) return undefined;
  return {
    at,
    sequence,
    stage,
    progressPercent: normalizeProgressPercent(source.progressPercent),
    summary,
    reason: clean(source.reason, 2000) || undefined,
    evidence: clean(source.evidence, 2000) || undefined,
    blockedPart: clean(source.blockedPart, 300) || undefined,
    completedParts: uniqueStrings(source.completedParts, 50),
    remainingParts: uniqueStrings(source.remainingParts, 50)
  };
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
    progressSequence: Math.max(0, Math.floor(Number(source.progressSequence) || 0)),
    progressReports: (Array.isArray(source.progressReports) ? source.progressReports : [])
      .map((report) => normalizeProgressReport(report))
      .filter((report): report is WorkerJobProgressReport => Boolean(report))
      .slice(-MAX_PROGRESS_REPORTS),
    progressPercent: normalizeProgressPercent(source.progressPercent, status === "completed" ? 100 : 0),
    completedParts: uniqueStrings(source.completedParts, 50),
    remainingParts: uniqueStrings(source.remainingParts, 50),
    lastProgressStage: normalizeProgressStage(source.lastProgressStage),
    lastProgressAt: clean(source.lastProgressAt, 80) || undefined,
    lastProgressSummary: clean(source.lastProgressSummary, 2000) || undefined,
    lastProgressReason: clean(source.lastProgressReason, 2000) || undefined,
    blockedAt: clean(source.blockedAt, 80) || undefined,
    blockedPart: clean(source.blockedPart, 300) || undefined,
    blockedReason: clean(source.blockedReason, 2000) || undefined,
    completionConfirmed: source.completionConfirmed === true || status === "completed",
    completionConfirmedAt: clean(source.completionConfirmedAt, 80) || (status === "completed" ? clean(source.finishedAt, 80) || undefined : undefined),
    completionEvidence: clean(source.completionEvidence, 2000) || undefined,
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

export function listWorkerJobs(options: { statuses?: WorkerJobStatus[]; limit?: number } = {}): WorkerJobRecord[] {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(options.limit) || 50)));
  const statuses = new Set((Array.isArray(options.statuses) ? options.statuses : [])
    .filter((status): status is WorkerJobStatus => ["prepared", "running", "completed", "failed", "cancelled", "blocked"].includes(String(status))));
  try {
    return fs.readdirSync(workerJobsDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^cpt_[a-f0-9]{24}\.json$/.test(entry.name))
      .map((entry) => readWorkerJob(entry.name.slice(0, -5)))
      .filter((record): record is WorkerJobRecord => Boolean(record) && (!statuses.size || statuses.has(record!.status)))
      .sort((left, right) => Date.parse(right.finishedAt || right.updatedAt || right.startedAt || right.preparedAt) - Date.parse(left.finishedAt || left.updatedAt || left.startedAt || left.preparedAt))
      .slice(0, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    return [];
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
    progressSequence: current?.progressSequence || 0,
    progressReports: current?.progressReports || [],
    progressPercent: current?.progressPercent || 0,
    completedParts: current?.completedParts || [],
    remainingParts: current?.remainingParts || [],
    lastProgressStage: current?.lastProgressStage,
    lastProgressAt: current?.lastProgressAt,
    lastProgressSummary: current?.lastProgressSummary,
    lastProgressReason: current?.lastProgressReason,
    blockedAt: current?.blockedAt,
    blockedPart: current?.blockedPart,
    blockedReason: current?.blockedReason,
    completionConfirmed: current?.completionConfirmed === true,
    completionConfirmedAt: current?.completionConfirmedAt,
    completionEvidence: current?.completionEvidence,
    events: [...(current?.events || []), event("prepared", { worker_id: input.workerId, scope: input.scope, root: input.root })]
  }));
}

async function bootstrapWorkerJobRecord(input: {
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
    if (current && workerOwnerKey(current.workerId) !== workerOwnerKey(input.workerId)) throw new Error("Worker job owner mismatch.");
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
        progressSequence: 0,
        progressReports: [],
        progressPercent: 0,
        completedParts: [],
        remainingParts: [],
        completionConfirmed: false,
        events: []
      }),
      workerId: input.workerId,
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

async function supersedeRunningWorkerJobs(workerId: string, nextJobId: string): Promise<void> {
  const ownerKey = workerOwnerKey(workerId);
  const supersededAt = new Date().toISOString();
  const staleRunningJobs = listWorkerJobs({ statuses: ["running"], limit: 200 })
    .filter((record) => record.jobId !== nextJobId && workerOwnerKey(record.workerId) === ownerKey);
  for (const stale of staleRunningJobs) {
    await updateWorkerJob(stale.jobId, (current) => {
      if (!current || current.status !== "running" || workerOwnerKey(current.workerId) !== ownerKey) return current!;
      return {
        ...current,
        status: "cancelled",
        finishedAt: supersededAt,
        summary: current.summary || `Task superseded by ${nextJobId}.`,
        events: [...current.events, event("superseded", { superseded_by: nextJobId })]
      };
    });
  }
}

export async function bootstrapWorkerJob(input: Parameters<typeof bootstrapWorkerJobRecord>[0]): Promise<WorkerJobRecord> {
  const ownerKey = workerOwnerKey(input.workerId);
  const previous = workerBootstrapTails.get(ownerKey) ?? Promise.resolve();
  let result!: WorkerJobRecord;
  const next = previous.catch(() => undefined).then(async () => {
    await supersedeRunningWorkerJobs(input.workerId, input.jobId);
    result = await bootstrapWorkerJobRecord(input);
  });
  workerBootstrapTails.set(ownerKey, next);
  try {
    await next;
    return result;
  } finally {
    if (workerBootstrapTails.get(ownerKey) === next) workerBootstrapTails.delete(ownerKey);
  }
}

export async function reportWorkerJobProgress(input: {
  jobId: string;
  workerId?: string;
  stage: WorkerJobProgressStage;
  summary: string;
  reason?: string;
  evidence?: string;
  progressPercent?: number;
  blockedPart?: string;
  completedParts?: string[];
  remainingParts?: string[];
}): Promise<WorkerJobRecord> {
  return await updateWorkerJob(input.jobId, (current) => {
    if (!current) throw new Error("Worker job was not prepared.");
    if (input.workerId && workerOwnerKey(current.workerId) !== workerOwnerKey(input.workerId)) throw new Error("Worker job owner mismatch.");
    if (current.status !== "running") throw new Error(`Worker job is not running; current status is ${current.status}.`);
    const stage = normalizeProgressStage(input.stage);
    const summary = clean(input.summary, 2000);
    if (!stage) throw new Error("Worker job progress stage is invalid.");
    if (!summary) throw new Error("Worker job progress summary is required.");
    const at = new Date().toISOString();
    const sequence = Math.max(0, current.progressSequence || 0) + 1;
    const completedParts = Array.isArray(input.completedParts) ? uniqueStrings(input.completedParts, 50) : current.completedParts;
    const remainingParts = Array.isArray(input.remainingParts) ? uniqueStrings(input.remainingParts, 50) : current.remainingParts;
    const progressPercent = deriveProgressPercent({
      stage,
      explicit: input.progressPercent,
      completedParts,
      remainingParts,
      currentPercent: current.progressPercent
    });
    const blocking = stage === "blocked" || stage === "stalled" || stage === "error";
    const report: WorkerJobProgressReport = {
      at,
      sequence,
      stage,
      progressPercent,
      summary,
      reason: clean(input.reason, 2000) || undefined,
      evidence: clean(input.evidence, 2000) || undefined,
      blockedPart: clean(input.blockedPart, 300) || undefined,
      completedParts,
      remainingParts
    };
    return {
      ...current,
      progressSequence: sequence,
      progressReports: [...current.progressReports, report].slice(-MAX_PROGRESS_REPORTS),
      progressPercent,
      completedParts,
      remainingParts,
      lastProgressStage: stage,
      lastProgressAt: at,
      lastProgressSummary: summary,
      lastProgressReason: report.reason,
      blockedAt: blocking ? at : undefined,
      blockedPart: blocking ? report.blockedPart || remainingParts[0] : undefined,
      blockedReason: blocking ? report.reason || summary : undefined,
      completionConfirmed: false,
      completionConfirmedAt: undefined,
      completionEvidence: undefined,
      events: [...current.events, event("progress_reported", {
        sequence,
        stage,
        progress_percent: progressPercent,
        summary: summary.slice(0, 500),
        reason: report.reason?.slice(0, 500),
        blocked_part: report.blockedPart,
        completed_parts: report.completedParts,
        remaining_parts: report.remainingParts
      })]
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
    if (input.outcome === "completed" && current.remainingParts.length) {
      throw new Error(`Worker job cannot complete; unfinished parts remain: ${current.remainingParts.join(", ")}. Report all_parts_done/verifying with an empty remaining_parts list first.`);
    }
    const finishedAt = new Date().toISOString();
    const completionConfirmed = input.outcome === "completed";
    return {
      ...current,
      status: input.outcome,
      finishedAt,
      updatedAt: finishedAt,
      completedObligations: completed,
      progressPercent: completionConfirmed ? 100 : current.progressPercent,
      remainingParts: completionConfirmed ? [] : current.remainingParts,
      completionConfirmed,
      completionConfirmedAt: completionConfirmed ? finishedAt : undefined,
      completionEvidence: completionConfirmed ? clean(input.summary, 2000) || current.lastProgressSummary || "finalize_worker_job" : undefined,
      summary: clean(input.summary, 4000) || current.summary,
      error: clean(input.error, 4000) || current.error,
      events: [...current.events, event("finalized", { outcome: input.outcome, missing_obligations: missing })]
    };
  });
}

export async function reconcileCompletedWorkerJob(input: {
  jobId: string;
  workerId?: string;
  finishedAt: string;
  evidence: string;
  summary?: string;
}): Promise<WorkerJobRecord> {
  const finishedAtMs = Date.parse(input.finishedAt);
  if (!Number.isFinite(finishedAtMs)) throw new Error("Worker job reconciliation requires a valid completion timestamp.");
  return await updateWorkerJob(input.jobId, (current) => {
    if (!current) throw new Error("Worker job was not prepared.");
    if (input.workerId && current.workerId !== input.workerId) throw new Error("Worker job owner mismatch.");
    if (current.status !== "running") return current;
    const startedAtMs = Date.parse(current.startedAt || current.preparedAt);
    if (Number.isFinite(startedAtMs) && finishedAtMs < startedAtMs) throw new Error("Worker job completion evidence predates the task start.");
    return {
      ...current,
      status: "completed",
      finishedAt: new Date(finishedAtMs).toISOString(),
      progressPercent: 100,
      remainingParts: [],
      completionConfirmed: true,
      completionConfirmedAt: new Date(finishedAtMs).toISOString(),
      completionEvidence: clean(input.evidence, 2000),
      summary: clean(input.summary, 4000) || current.summary,
      events: [...current.events, event("reconciled_completed", {
        evidence: clean(input.evidence, 300),
        evidence_finished_at: new Date(finishedAtMs).toISOString(),
        reconciled_at: new Date().toISOString()
      })]
    };
  });
}

export function workerJobPublicRecord(record: WorkerJobRecord | undefined): Record<string, unknown> | undefined {
  if (!record) return undefined;
  const missingObligations = record.requiredObligations.filter((obligation) => !record.completedObligations.includes(obligation));
  const executionState = ["completed", "failed", "cancelled", "blocked"].includes(record.status)
    ? record.status
    : ["blocked", "stalled", "error", "verifying"].includes(String(record.lastProgressStage))
      ? record.lastProgressStage
      : record.status;
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
    execution_state: executionState,
    progress_percent: record.progressPercent,
    completed_parts: record.completedParts,
    remaining_parts: record.remainingParts,
    progress_sequence: record.progressSequence,
    progress_reports: record.progressReports.map((report) => ({
      at: report.at,
      sequence: report.sequence,
      stage: report.stage,
      progress_percent: report.progressPercent,
      summary: report.summary,
      reason: report.reason,
      evidence: report.evidence,
      blocked_part: report.blockedPart,
      completed_parts: report.completedParts,
      remaining_parts: report.remainingParts
    })),
    last_progress_stage: record.lastProgressStage,
    last_progress_at: record.lastProgressAt,
    last_progress_summary: record.lastProgressSummary,
    last_progress_reason: record.lastProgressReason,
    blocked_at: record.blockedAt,
    blocked_part: record.blockedPart,
    blocked_reason: record.blockedReason,
    completion_confirmed: record.completionConfirmed,
    completion_confirmed_at: record.completionConfirmedAt,
    completion_evidence: record.completionEvidence,
    summary: record.summary,
    error: record.error,
    events: record.events.slice(-20)
  };
}
