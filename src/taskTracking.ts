import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { codexProHome } from "./profileStore.js";
import { runGitProcess } from "./processOps.js";
import { redactSensitiveText } from "./redact.js";

export const TASK_TRACKING_VERSION = 1 as const;
export const TASK_TRACKING_STATES = [
  "ACTIVE",
  "PAUSED",
  "BLOCKED",
  "WAITING_DEPENDENCY",
  "WAITING_RUNTIME_ACCEPTANCE",
  "READY_TO_INTEGRATE",
  "INTEGRATING",
  "FAILED_RESUMABLE",
  "COMPLETED"
] as const;

export type TaskTrackingState = typeof TASK_TRACKING_STATES[number];

export type TaskTrackingRecord = {
  version: 1;
  task_id: string;
  repository: string;
  owner_worker: string;
  owner_profile: string;
  title: string;
  state: TaskTrackingState;
  started_at: string;
  updated_at: string;
  checkpoint: string;
  worktree_head: string;
  origin_win_seen: string;
  last_progress: string;
  blocker: string;
  dependency: string;
  safe_next_action: string;
  commit_sha: string;
  integrated: boolean;
  finalized: boolean;
};

export type TaskTrackingWorkerSnapshot = {
  jobId?: string;
  workerId?: string;
  status?: string;
  kind?: string;
  title?: string;
  startedAt?: string;
  preparedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  lastProgressStage?: string;
  lastProgressSummary?: string;
  lastProgressReason?: string;
  waitState?: "dependency" | "runtime_acceptance";
  blockedReason?: string;
  error?: string;
  dependency?: string;
  safeNextAction?: string;
  remainingParts?: string[];
  completionConfirmed?: boolean;
  events?: Array<{ at?: string; type?: string; details?: Record<string, unknown> }>;
};

export type TaskTrackingWorkspaceSnapshot = {
  taskId?: string;
  workerId?: string;
  title?: string;
  status?: string;
  baseRemoteHead?: string;
  commitShas?: string[];
  worktreeRoot?: string;
  integrationStatus?: string;
  integrationBranch?: string;
  integratedHead?: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
};

export type TaskTrackingSyncInput = {
  root: string;
  taskId: string;
  workerJob?: TaskTrackingWorkerSnapshot;
  workspaceTask?: TaskTrackingWorkspaceSnapshot;
  ownerProfile?: string;
};

export const TASK_TRACKING_WORKER_RULE = [
  "TASK TRACKING IS MANDATORY.",
  "For every repo task you own, CodexPro maintains one persistent task tracking record under CODEXPRO_HOME/task-tracking.",
  "Keep progress reports accurate because CodexPro projects them into that record. Meaningful progress must clearly state what was completed, what remains, the current blocker if any, and the safe next action.",
  "Before a long-running test or soak, report that transition. When blocked, report the actual blocker. After commit, integration, and finalization, lifecycle state must be recorded.",
  "Do not modify another task's tracking state. Do not place secrets in progress or evidence fields.",
  "The tracking record mirrors authoritative repo-task, worker-job, workspace-coordination, and integration state; it never replaces those control planes and must never be used alone for safety decisions.",
  "Do not call arbitrary filesystem write tools merely to maintain tracking; CodexPro synchronizes it automatically."
].join(" ");

const trackingWriteTails = new Map<string, Promise<void>>();
const TASK_ID_PATTERN = /^cpt_[a-f0-9]{24}$/;
const REPOSITORY_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function clean(value: unknown, maxLength = 2000): string {
  return redactSensitiveText(String(value ?? "")).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, maxLength);
}

function normalizedOwner(value: unknown): string {
  return clean(value, 160).replace(/^browser:/, "");
}

function validTaskId(taskId: string): string {
  const value = String(taskId || "").trim();
  if (!TASK_ID_PATTERN.test(value)) throw new Error("Task tracking task id is invalid.");
  return value;
}

function validRepositoryKey(repositoryKey: string): string {
  const value = String(repositoryKey || "").trim().toLowerCase();
  if (!REPOSITORY_KEY_PATTERN.test(value) || value.includes("..") || path.isAbsolute(value)) {
    throw new Error("Task tracking repository key is invalid.");
  }
  return value;
}

function assertContained(parent: string, child: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Task tracking path escaped its configured root.");
  }
}

export function taskTrackingRoot(): string {
  return path.join(codexProHome(), "task-tracking");
}

export function taskTrackingPathForRepositoryKey(repositoryKey: string, taskId: string): string {
  const safeKey = validRepositoryKey(repositoryKey);
  const safeTaskId = validTaskId(taskId);
  const root = path.resolve(taskTrackingRoot());
  const repositoryRoot = path.resolve(root, safeKey);
  const destination = path.resolve(repositoryRoot, `${safeTaskId}.json`);
  assertContained(root, repositoryRoot);
  assertContained(repositoryRoot, destination);
  return destination;
}

async function gitText(root: string, args: string[]): Promise<string> {
  try {
    const result = await runGitProcess(root, args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 12_000
    });
    return result.status === 0 ? String(result.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

function normalizeRemoteIdentity(remote: string): string {
  const raw = String(remote || "").trim();
  if (!raw) return "";
  const scp = raw.match(/^(?:[^@\s]+@)?([^:\/\s]+):(.+)$/);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const host = scp[1].toLowerCase();
    const repositoryPath = scp[2].replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\\/g, "/");
    return `${host}/${repositoryPath}`;
  }
  try {
    const parsed = new URL(raw.replace(/^git\+/, ""));
    const host = parsed.hostname.toLowerCase();
    const repositoryPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\\/g, "/");
    return host && repositoryPath ? `${host}/${repositoryPath}` : "";
  } catch {
    return "";
  }
}

function repositoryKey(identity: string): string {
  const normalized = identity.toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "repository";
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return validRepositoryKey(`${slug}-${digest}`.slice(0, 128));
}

export async function resolveTaskTrackingRepository(root: string): Promise<{ repository: string; repositoryKey: string }> {
  const resolvedRoot = path.resolve(String(root || ""));
  const remote = normalizeRemoteIdentity(await gitText(resolvedRoot, ["config", "--get", "remote.origin.url"]));
  if (remote) return { repository: remote, repositoryKey: repositoryKey(remote) };

  const commonDirRaw = await gitText(resolvedRoot, ["rev-parse", "--git-common-dir"]);
  const topLevel = await gitText(resolvedRoot, ["rev-parse", "--show-toplevel"]);
  if (!commonDirRaw && !topLevel) throw new Error("Task tracking requires a Git repository identity.");
  const commonDir = path.resolve(resolvedRoot, commonDirRaw || ".git");
  const localIdentity = `local-git-${createHash("sha256").update(process.platform === "win32" ? commonDir.toLowerCase() : commonDir).digest("hex").slice(0, 24)}`;
  const displayName = path.basename(topLevel || resolvedRoot).replace(/[^A-Za-z0-9._-]+/g, "-") || "repository";
  return { repository: `${displayName}@${localIdentity}`, repositoryKey: repositoryKey(localIdentity) };
}

export async function resolveTaskTrackingPath(root: string, taskId: string): Promise<string> {
  const repository = await resolveTaskTrackingRepository(root);
  return taskTrackingPathForRepositoryKey(repository.repositoryKey, taskId);
}

function readRecordAt(destination: string): TaskTrackingRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(destination, "utf8"));
    if (!parsed || parsed.version !== TASK_TRACKING_VERSION || !TASK_ID_PATTERN.test(String(parsed.task_id || ""))) return undefined;
    if (!TASK_TRACKING_STATES.includes(parsed.state as TaskTrackingState)) return undefined;
    return parsed as TaskTrackingRecord;
  } catch {
    return undefined;
  }
}

export async function readTaskTracking(root: string, taskId: string): Promise<TaskTrackingRecord | undefined> {
  return readRecordAt(await resolveTaskTrackingPath(root, taskId));
}

function lastCommit(workspaceTask?: TaskTrackingWorkspaceSnapshot): string {
  const commits = Array.isArray(workspaceTask?.commitShas) ? workspaceTask!.commitShas!.map((value) => clean(value, 80)).filter(Boolean) : [];
  return clean(workspaceTask?.integratedHead, 80) || commits.at(-1) || "";
}

function finalizedByAuthority(workerJob?: TaskTrackingWorkerSnapshot): boolean {
  if (!workerJob) return false;
  return Boolean(workerJob.events?.some((entry) => clean(entry?.type, 100) === "finalized"));
}

function dependencyFromWorker(workerJob?: TaskTrackingWorkerSnapshot): string {
  const explicit = clean(workerJob?.dependency);
  if (explicit) return explicit;
  const candidate = clean(workerJob?.lastProgressReason || workerJob?.blockedReason || workerJob?.error);
  return /(?:dependency|depends? on|waiting (?:for|on)|blocked by|after .* completes?)/i.test(candidate) ? candidate : "";
}

function safeNextActionFromWorker(workerJob?: TaskTrackingWorkerSnapshot): string {
  const explicit = clean(workerJob?.safeNextAction);
  if (explicit) return explicit;
  const remaining = Array.isArray(workerJob?.remainingParts) ? workerJob!.remainingParts!.map((item) => clean(item, 300)).filter(Boolean) : [];
  return remaining[0] || "";
}

export function projectTaskTrackingState(input: {
  workerJob?: TaskTrackingWorkerSnapshot;
  workspaceTask?: TaskTrackingWorkspaceSnapshot;
}): TaskTrackingState {
  const workerStatus = clean(input.workerJob?.status, 40).toLowerCase();
  const workspaceStatus = clean(input.workspaceTask?.status, 40).toLowerCase();
  const progressStage = clean(input.workerJob?.lastProgressStage, 40).toLowerCase();
  const integrationStatus = clean(input.workspaceTask?.integrationStatus, 40).toLowerCase();
  const waitState = input.workerJob?.waitState;
  const finalized = finalizedByAuthority(input.workerJob);

  if (workerStatus === "completed" && finalized && (!workspaceStatus || workspaceStatus === "completed")) return "COMPLETED";
  if (integrationStatus === "integrating") return "INTEGRATING";
  if (integrationStatus === "queued") return "READY_TO_INTEGRATE";
  if (workerStatus === "failed" || workspaceStatus === "failed" || progressStage === "error" || integrationStatus === "failed") return "FAILED_RESUMABLE";
  if (integrationStatus === "conflict") return "BLOCKED";
  if (waitState === "runtime_acceptance") return "WAITING_RUNTIME_ACCEPTANCE";
  if (waitState === "dependency") return "WAITING_DEPENDENCY";
  if (workerStatus === "blocked" || progressStage === "blocked" || progressStage === "stalled") return "BLOCKED";
  if (workerStatus === "completed" || workspaceStatus === "completed") return "PAUSED";
  if (workerStatus === "cancelled" || workspaceStatus === "cancelled") return "PAUSED";
  if (workerStatus === "prepared") return "PAUSED";
  return "ACTIVE";
}

async function atomicWrite(destination: string, record: TaskTrackingRecord): Promise<void> {
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

async function updateSerialized<T>(destination: string, update: () => Promise<T>): Promise<T> {
  const previous = trackingWriteTails.get(destination) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(update);
  const tail = next.then(() => undefined, () => undefined);
  trackingWriteTails.set(destination, tail);
  try {
    return await next;
  } finally {
    if (trackingWriteTails.get(destination) === tail) trackingWriteTails.delete(destination);
  }
}

export async function syncTaskTracking(input: TaskTrackingSyncInput): Promise<TaskTrackingRecord> {
  const taskId = validTaskId(input.taskId);
  const repositoryInfo = await resolveTaskTrackingRepository(input.root);
  const destination = taskTrackingPathForRepositoryKey(repositoryInfo.repositoryKey, taskId);
  return await updateSerialized(destination, async () => {
    const existing = readRecordAt(destination);
    const workerJob = input.workerJob;
    const workspaceTask = input.workspaceTask;
    const dependency = workerJob ? dependencyFromWorker(workerJob) : existing?.dependency || "";
    const state = projectTaskTrackingState({ workerJob, workspaceTask });
    const commitSha = lastCommit(workspaceTask) || existing?.commit_sha || "";
    const worktreeRoot = clean(workspaceTask?.worktreeRoot, 2048);
    const worktreeHead = worktreeRoot && fs.existsSync(worktreeRoot)
      ? await gitText(worktreeRoot, ["rev-parse", "HEAD"])
      : clean(workspaceTask?.integratedHead, 80) || commitSha;
    const integrated = workspaceTask?.integrationStatus === "integrated" && Boolean(clean(workspaceTask.integratedHead, 80));
    const originWin = integrated && workspaceTask?.integrationBranch === "win"
      ? clean(workspaceTask.integratedHead, 80)
      : await gitText(input.root, ["rev-parse", "refs/remotes/origin/win"]);
    const ownerWorker = normalizedOwner(workerJob?.workerId || workspaceTask?.workerId) || existing?.owner_worker || "";
    const ownerProfile = normalizedOwner(input.ownerProfile || workerJob?.workerId || workspaceTask?.workerId) || existing?.owner_profile || "";
    const finalized = workerJob ? finalizedByAuthority(workerJob) : Boolean(existing?.finalized);
    const now = new Date().toISOString();
    const record: TaskTrackingRecord = {
      version: TASK_TRACKING_VERSION,
      task_id: taskId,
      repository: repositoryInfo.repository,
      owner_worker: ownerWorker,
      owner_profile: ownerProfile,
      title: clean(workerJob?.title || workspaceTask?.title, 120) || existing?.title || "",
      state,
      started_at: clean(workerJob?.startedAt || workspaceTask?.startedAt || workerJob?.preparedAt, 80) || existing?.started_at || now,
      updated_at: now,
      checkpoint: commitSha,
      worktree_head: clean(worktreeHead, 80),
      origin_win_seen: clean(originWin || workspaceTask?.baseRemoteHead, 80),
      last_progress: workerJob ? clean(workerJob.lastProgressSummary) : existing?.last_progress || "",
      blocker: workerJob && ["BLOCKED", "WAITING_DEPENDENCY", "FAILED_RESUMABLE"].includes(state)
        ? clean(workerJob.blockedReason || workerJob.error || workerJob.lastProgressReason)
        : existing?.blocker && ["BLOCKED", "WAITING_DEPENDENCY", "FAILED_RESUMABLE"].includes(state) ? existing.blocker : "",
      dependency,
      safe_next_action: workerJob ? safeNextActionFromWorker(workerJob) : existing?.safe_next_action || "",
      commit_sha: commitSha,
      integrated,
      finalized
    };
    await atomicWrite(destination, record);
    return record;
  });
}
