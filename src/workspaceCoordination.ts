import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { runGitProcess } from "./processOps.js";
import { CodexProError } from "./guard.js";
import { codexProHome } from "./profileStore.js";

const COORDINATION_VERSION = 1;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 200;
const STALE_LOCK_MS = 30_000;
const STALE_INTEGRATION_LEASE_MS = 10 * 60 * 1000;
const STALE_TASK_MS = 6 * 60 * 60 * 1000;
const INTEGRATION_QUEUE_WAIT_MS = 2 * 60 * 1000;
const INTEGRATION_QUEUE_POLL_MS = 50;

export type WorkspaceTaskStatus = "running" | "completed" | "failed" | "cancelled";

export type WorkspaceTaskRecord = {
  taskId: string;
  workerId: string;
  title: string;
  status: WorkspaceTaskStatus;
  baseHead: string;
  baseBranch: string;
  baseRemoteHead: string;
  initialDirtyPaths: string[];
  touchedPaths: string[];
  claimedPaths: string[];
  commitShas: string[];
  worktreeRoot?: string;
  worktreeBranch?: string;
  integrationStatus?: "idle" | "queued" | "integrating" | "integrated" | "conflict" | "failed";
  integrationBranch?: string;
  integrationRequestedAt?: string;
  integrationStartedAt?: string;
  integrationFinishedAt?: string;
  integratedHead?: string;
  remoteHeadBeforeIntegration?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
};

type WorkspaceClaim = {
  taskId: string;
  claimedAt: string;
  updatedAt: string;
};

type IntegrationLease = {
  taskId: string;
  acquiredAt: string;
};

type IntegrationQueueEntry = {
  taskId: string;
  branch: string;
  enqueuedAt: string;
};

type WorkspaceCoordinationState = {
  version: 1;
  root: string;
  updatedAt: string;
  tasks: Record<string, WorkspaceTaskRecord>;
  claims: Record<string, WorkspaceClaim>;
  integrationQueue: IntegrationQueueEntry[];
  integrationLease?: IntegrationLease;
};

export type WorkspaceTaskContext = {
  taskId: string;
  workerId?: string;
  title?: string;
  root: string;
  worktreeRoot?: string;
};

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function canonicalPathKey(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function workspaceKey(root: string): string {
  const canonical = canonicalRoot(root);
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

function coordinationDir(): string {
  return path.join(codexProHome(), "workspace-coordination");
}

function worktreeDir(root: string, taskId: string): string {
  return path.join(codexProHome(), "workspace-worktrees", workspaceKey(root), taskId);
}

function worktreeBranch(taskId: string): string {
  return `codexpro/task/${taskId.slice(4)}`;
}

function statePath(root: string): string {
  return path.join(coordinationDir(), `${workspaceKey(root)}.json`);
}

function lockPath(root: string): string {
  return `${statePath(root)}.lock`;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function gitText(root: string, args: string[]): Promise<string> {

  const result = await runGitProcess(root, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 12_000
  });
  return result.status === 0 ? String(result.stdout ?? "").trim() : "";
}

async function gitStatus(root: string, args: string[]): Promise<number> {

  const result = await runGitProcess(root, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 12_000
  });
  return Number(result.status ?? 1);
}

async function gitRun(root: string, args: string[], timeout = 30_000): Promise<{ status: number; stdout: string; stderr: string }> {

  const result = await runGitProcess(root, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout
  });
  return {
    status: Number(result.status ?? 1),
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim()
  };
}

function nulPaths(text: string): string[] {
  return text.split("\0").map((value) => value.trim()).filter(Boolean).map((value) => value.replace(/\\/g, "/"));
}

async function gitPaths(root: string, args: string[]): Promise<string[]> {
  return nulPaths(await gitText(root, args));
}

function uniquePaths(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of values) {
    const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized || normalized === ".") continue;
    const key = canonicalPathKey(normalized);
    if (!seen.has(key)) seen.set(key, normalized);
  }
  return [...seen.values()].sort((left, right) => left.localeCompare(right));
}

async function currentDirtyPaths(root: string): Promise<string[]> {
  return uniquePaths([
    ...await gitPaths(root, ["diff", "--name-only", "-z", "--"]),
    ...await gitPaths(root, ["diff", "--cached", "--name-only", "-z", "--"]),
    ...await gitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"])
  ]);
}

function currentHead(root: string): Promise<string> {
  return gitText(root, ["rev-parse", "HEAD"]);
}

async function currentBranch(root: string): Promise<string> {
  const branch = await gitText(root, ["branch", "--show-current"]);
  return branch || await gitText(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function currentRemoteHead(root: string): Promise<string> {
  return gitText(root, ["rev-parse", "@{upstream}"]);
}

function emptyState(root: string): WorkspaceCoordinationState {
  return {
    version: COORDINATION_VERSION,
    root: canonicalRoot(root),
    updatedAt: nowIso(),
    tasks: {},
    claims: {},
    integrationQueue: []
  };
}

function normalizeTask(value: unknown): WorkspaceTaskRecord | undefined {
  const source = value && typeof value === "object" ? value as Partial<WorkspaceTaskRecord> : {};
  const taskId = String(source.taskId || "").trim();
  if (!/^cpt_[a-f0-9]{24}$/.test(taskId)) return undefined;
  const status = ["running", "completed", "failed", "cancelled"].includes(String(source.status)) ? source.status as WorkspaceTaskStatus : "running";
  return {
    taskId,
    workerId: String(source.workerId || "").trim().slice(0, 160),
    title: String(source.title || "").trim().slice(0, 120),
    status,
    baseHead: String(source.baseHead || "").trim().slice(0, 80),
    baseBranch: String(source.baseBranch || "").trim().slice(0, 200),
    baseRemoteHead: String(source.baseRemoteHead || "").trim().slice(0, 80),
    initialDirtyPaths: uniquePaths(Array.isArray(source.initialDirtyPaths) ? source.initialDirtyPaths.map(String) : []),
    touchedPaths: uniquePaths(Array.isArray(source.touchedPaths) ? source.touchedPaths.map(String) : []),
    claimedPaths: uniquePaths(Array.isArray(source.claimedPaths) ? source.claimedPaths.map(String) : []),
    commitShas: [...new Set(Array.isArray(source.commitShas) ? source.commitShas.map((value) => String(value).trim()).filter(Boolean) : [])].slice(-200),
    ...(source.worktreeRoot ? { worktreeRoot: String(source.worktreeRoot) } : {}),
    ...(source.worktreeBranch ? { worktreeBranch: String(source.worktreeBranch) } : {}),
    ...(source.integrationStatus ? { integrationStatus: source.integrationStatus } : {}),
    ...(source.integrationBranch ? { integrationBranch: String(source.integrationBranch) } : {}),
    ...(source.integrationRequestedAt ? { integrationRequestedAt: String(source.integrationRequestedAt) } : {}),
    ...(source.integrationStartedAt ? { integrationStartedAt: String(source.integrationStartedAt) } : {}),
    ...(source.integrationFinishedAt ? { integrationFinishedAt: String(source.integrationFinishedAt) } : {}),
    ...(source.integratedHead ? { integratedHead: String(source.integratedHead) } : {}),
    ...(source.remoteHeadBeforeIntegration ? { remoteHeadBeforeIntegration: String(source.remoteHeadBeforeIntegration) } : {}),
    startedAt: String(source.startedAt || nowIso()),
    updatedAt: String(source.updatedAt || nowIso()),
    ...(source.finishedAt ? { finishedAt: String(source.finishedAt) } : {})
  };
}

function readState(root: string): WorkspaceCoordinationState {
  const canonical = canonicalRoot(root);
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(canonical), "utf8"));
    const tasks: Record<string, WorkspaceTaskRecord> = {};
    for (const [taskId, value] of Object.entries(parsed?.tasks || {})) {
      const task = normalizeTask(value);
      if (task && task.taskId === taskId) tasks[taskId] = task;
    }
    const claims: Record<string, WorkspaceClaim> = {};
    for (const [claimPath, value] of Object.entries(parsed?.claims || {})) {
      const source = value && typeof value === "object" ? value as Partial<WorkspaceClaim> : {};
      const taskId = String(source.taskId || "").trim();
      if (!/^cpt_[a-f0-9]{24}$/.test(taskId)) continue;
      claims[canonicalPathKey(claimPath)] = {
        taskId,
        claimedAt: String(source.claimedAt || nowIso()),
        updatedAt: String(source.updatedAt || nowIso())
      };
    }
    const integrationQueue: IntegrationQueueEntry[] = Array.isArray(parsed?.integrationQueue)
      ? parsed.integrationQueue.flatMap((value: unknown) => {
          const source = value && typeof value === "object" ? value as Partial<IntegrationQueueEntry> : {};
          const taskId = String(source.taskId || "").trim();
          if (!/^cpt_[a-f0-9]{24}$/.test(taskId)) return [];
          return [{ taskId, branch: String(source.branch || "").trim().slice(0, 200), enqueuedAt: String(source.enqueuedAt || nowIso()) }];
        })
      : [];
    const leaseTaskId = String(parsed?.integrationLease?.taskId || "").trim();
    return {
      version: COORDINATION_VERSION,
      root: canonical,
      updatedAt: String(parsed?.updatedAt || nowIso()),
      tasks,
      claims,
      integrationQueue,
      ...( /^cpt_[a-f0-9]{24}$/.test(leaseTaskId) ? { integrationLease: { taskId: leaseTaskId, acquiredAt: String(parsed?.integrationLease?.acquiredAt || nowIso()) } } : {})
    };
  } catch {
    return emptyState(canonical);
  }
}

async function writeState(root: string, state: WorkspaceCoordinationState): Promise<void> {
  const destination = statePath(root);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  state.updatedAt = nowIso();
  const temporary = `${destination}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fsp.rename(temporary, destination);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireStateLock(root: string): Promise<() => Promise<void>> {
  const lock = lockPath(root);
  await fsp.mkdir(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await fsp.mkdir(lock);
      await fsp.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: nowIso() }), "utf8").catch(() => undefined);
      return async () => { await fsp.rm(lock, { recursive: true, force: true }).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        const stat = await fsp.stat(lock);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fsp.rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch {}
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new CodexProError("WORKSPACE_COORDINATION_BUSY: timed out waiting for the workspace coordination lock.", { code: "WORKSPACE_COORDINATION_BUSY" });
}

function cleanupStaleState(state: WorkspaceCoordinationState): void {
  const now = Date.now();
  const staleTaskIds = new Set<string>();
  for (const task of Object.values(state.tasks)) {
    if (task.status !== "running") continue;
    const updated = Date.parse(task.updatedAt || task.startedAt);
    if (Number.isFinite(updated) && now - updated > STALE_TASK_MS) {
      task.status = "cancelled";
      task.finishedAt = nowIso();
      task.updatedAt = task.finishedAt;
      staleTaskIds.add(task.taskId);
    }
  }
  for (const [claimPath, claim] of Object.entries(state.claims)) {
    const task = state.tasks[claim.taskId];
    if (!task || task.status !== "running" || staleTaskIds.has(claim.taskId)) delete state.claims[claimPath];
  }
  state.integrationQueue = state.integrationQueue.filter((entry) => {
    const task = state.tasks[entry.taskId];
    return Boolean(task && task.status === "running" && !staleTaskIds.has(entry.taskId));
  });
  if (state.integrationLease) {
    const leaseTask = state.tasks[state.integrationLease.taskId];
    const acquired = Date.parse(state.integrationLease.acquiredAt);
    if (!leaseTask || leaseTask.status !== "running" || (Number.isFinite(acquired) && now - acquired > STALE_INTEGRATION_LEASE_MS)) delete state.integrationLease;
  }
}

async function withState<T>(root: string, update: (state: WorkspaceCoordinationState) => Promise<T> | T): Promise<T> {
  const canonical = canonicalRoot(root);
  const release = await acquireStateLock(canonical);
  try {
    const state = readState(canonical);
    cleanupStaleState(state);
    const result = await update(state);
    await writeState(canonical, state);
    return result;
  } finally {
    await release();
  }
}

function requireTask(state: WorkspaceCoordinationState, taskId: string): WorkspaceTaskRecord {
  const task = state.tasks[taskId];
  if (!task || task.status !== "running") {
    throw new CodexProError(`WORKSPACE_TASK_NOT_ACTIVE: ${taskId} has no active workspace coordination record.`, {
      code: "WORKSPACE_TASK_NOT_ACTIVE",
      details: { task_id: taskId, workspace_root: state.root }
    });
  }
  return task;
}

async function changedPathsBetween(root: string, baseHead: string, head: string, paths?: string[]): Promise<string[]> {
  if (!baseHead || !head || baseHead === head) return [];
  const args = ["diff", "--name-only", "-z", `${baseHead}..${head}`];
  if (paths?.length) args.push("--", ...paths);
  return uniquePaths(await gitPaths(root, args));
}

function claimOwner(state: WorkspaceCoordinationState, relPath: string): string | undefined {
  return state.claims[canonicalPathKey(relPath)]?.taskId;
}

async function ensureTaskWorktree(root: string, taskId: string, baseHead: string): Promise<{ root: string; branch: string } | undefined> {
  if (!baseHead) return undefined;
  const target = worktreeDir(root, taskId);
  const branch = worktreeBranch(taskId);
  if (fs.existsSync(target)) {
    const top = await gitText(target, ["rev-parse", "--show-toplevel"]);
    if (top && sameFsPath(top, target)) return { root: canonicalRoot(target), branch: (await currentBranch(target)) || branch };
    throw new CodexProError(`WORKSPACE_WORKTREE_PATH_BUSY: task worktree path already exists but is not a valid Git worktree: ${target}.`, {
      code: "WORKSPACE_WORKTREE_PATH_BUSY",
      details: { task_id: taskId, worktree_root: target }
    });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const branchExists = (await gitStatus(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) === 0;
  const result = branchExists
    ? await gitRun(root, ["worktree", "add", target, branch], 60_000)
    : await gitRun(root, ["worktree", "add", "-b", branch, target, baseHead], 60_000);
  if (result.status !== 0) {
    throw new CodexProError(`WORKSPACE_WORKTREE_CREATE_FAILED: ${result.stderr || result.stdout || "git worktree add failed"}`, {
      code: "WORKSPACE_WORKTREE_CREATE_FAILED",
      details: { task_id: taskId, worktree_root: target, branch, base_head: baseHead }
    });
  }
  return { root: canonicalRoot(target), branch };
}

function sameFsPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function taskGitRoot(context: WorkspaceTaskContext, task?: WorkspaceTaskRecord): string {
  const candidate = context.worktreeRoot || task?.worktreeRoot;
  return candidate && fs.existsSync(candidate) ? canonicalRoot(candidate) : canonicalRoot(context.root);
}

export async function registerWorkspaceTask(context: WorkspaceTaskContext): Promise<WorkspaceTaskRecord> {
  const root = canonicalRoot(context.root);
  return await withState(root, async (state) => {
    const existing = state.tasks[context.taskId];
    const now = nowIso();
    if (existing?.status === "running") {
      existing.updatedAt = now;
      if (context.workerId) existing.workerId = String(context.workerId).slice(0, 160);
      if (context.title) existing.title = String(context.title).slice(0, 120);
      if (!existing.worktreeRoot) {
        const worktree = await ensureTaskWorktree(root, existing.taskId, existing.baseHead);
        if (worktree) {
          existing.worktreeRoot = worktree.root;
          existing.worktreeBranch = worktree.branch;
        }
      }
      return existing;
    }

    const workerId = String(context.workerId || "").trim().slice(0, 160);
    if (workerId) {
      for (const task of Object.values(state.tasks)) {
        if (task.taskId === context.taskId || task.status !== "running" || task.workerId !== workerId) continue;
        task.status = "cancelled";
        task.finishedAt = now;
        task.updatedAt = now;
        for (const [claimPath, claim] of Object.entries(state.claims)) {
          if (claim.taskId === task.taskId) delete state.claims[claimPath];
        }
        state.integrationQueue = state.integrationQueue.filter((entry) => entry.taskId !== task.taskId);
        if (state.integrationLease?.taskId === task.taskId) delete state.integrationLease;
      }
    }

    const baseHead = await currentHead(root);
    const worktree = await ensureTaskWorktree(root, context.taskId, baseHead);
    const task: WorkspaceTaskRecord = {
      taskId: context.taskId,
      workerId,
      title: String(context.title || "").trim().slice(0, 120),
      status: "running",
      baseHead,
      baseBranch: await currentBranch(root),
      baseRemoteHead: await currentRemoteHead(root),
      initialDirtyPaths: await currentDirtyPaths(root),
      touchedPaths: [],
      claimedPaths: [],
      commitShas: [],
      ...(worktree ? { worktreeRoot: worktree.root, worktreeBranch: worktree.branch } : {}),
      integrationStatus: "idle",
      startedAt: now,
      updatedAt: now
    };
    state.tasks[task.taskId] = task;
    return task;
  });
}

export async function claimWorkspacePaths(context: WorkspaceTaskContext, paths: string[]): Promise<WorkspaceTaskRecord> {
  const root = canonicalRoot(context.root);
  const normalizedPaths = uniquePaths(paths.map((value) => workspaceRelativePath(root, root, value)));
  if (!normalizedPaths.length) throw new CodexProError("WORKSPACE_PATH_REQUIRED: at least one path must be claimed.", { code: "WORKSPACE_PATH_REQUIRED" });
  return await withState(root, async (state) => {
    const task = requireTask(state, context.taskId);
    const gitRoot = taskGitRoot(context, task);
    const head = await currentHead(gitRoot);
    const committedConflicts = task.worktreeRoot ? [] : await changedPathsBetween(gitRoot, task.baseHead, head, normalizedPaths);
    if (committedConflicts.length) {
      throw new CodexProError(`WORKSPACE_STALE_BASE_CONFLICT: committed changes landed after ${task.taskId} began: ${committedConflicts.join(", ")}.`, {
        code: "WORKSPACE_STALE_BASE_CONFLICT",
        details: { task_id: task.taskId, base_head: task.baseHead, current_head: head, paths: committedConflicts }
      });
    }

    for (const relPath of normalizedPaths) {
      const owner = claimOwner(state, relPath);
      if (owner && owner !== task.taskId) {
        throw new CodexProError(`WORKSPACE_PATH_CONFLICT: ${relPath} is owned by active task ${owner}.`, {
          code: "WORKSPACE_PATH_CONFLICT",
          details: { task_id: task.taskId, owner_task_id: owner, path: relPath }
        });
      }
    }

    const now = nowIso();
    for (const relPath of normalizedPaths) {
      const key = canonicalPathKey(relPath);
      const existing = state.claims[key];
      state.claims[key] = { taskId: task.taskId, claimedAt: existing?.claimedAt || now, updatedAt: now };
    }
    task.claimedPaths = uniquePaths([...task.claimedPaths, ...normalizedPaths]);
    task.updatedAt = now;
    return task;
  });
}

export async function recordWorkspacePathsTouched(context: WorkspaceTaskContext, paths: string[]): Promise<WorkspaceTaskRecord> {
  const root = canonicalRoot(context.root);
  const normalizedPaths = uniquePaths(paths.map((value) => workspaceRelativePath(root, root, value)));
  if (!normalizedPaths.length) throw new CodexProError("WORKSPACE_PATH_REQUIRED: at least one path must be recorded.", { code: "WORKSPACE_PATH_REQUIRED" });
  return await withState(root, async (state) => {
    const task = requireTask(state, context.taskId);
    const now = nowIso();
    for (const relPath of normalizedPaths) {
      const owner = claimOwner(state, relPath);
      if (owner !== task.taskId) {
        throw new CodexProError(`WORKSPACE_TOUCH_NOT_CLAIMED: ${relPath} is not reserved by task ${task.taskId}.`, {
          code: "WORKSPACE_TOUCH_NOT_CLAIMED",
          details: { task_id: task.taskId, owner_task_id: owner || null, path: relPath }
        });
      }
      const claim = state.claims[canonicalPathKey(relPath)];
      if (claim) claim.updatedAt = now;
    }
    task.touchedPaths = uniquePaths([...task.touchedPaths, ...normalizedPaths]);
    task.updatedAt = now;
    return task;
  });
}

export async function releaseWorkspacePaths(context: WorkspaceTaskContext, paths: string[], options: { onlyUntouched?: boolean } = {}): Promise<void> {
  const root = canonicalRoot(context.root);
  const normalizedPaths = uniquePaths(paths.map((value) => workspaceRelativePath(root, root, value)));
  if (!normalizedPaths.length) return;
  await withState(root, async (state) => {
    const task = requireTask(state, context.taskId);
    const touchedKeys = new Set(task.touchedPaths.map(canonicalPathKey));
    const releasedKeys = new Set<string>();
    for (const relPath of normalizedPaths) {
      const key = canonicalPathKey(relPath);
      if (state.claims[key]?.taskId !== task.taskId) continue;
      if (options.onlyUntouched && touchedKeys.has(key)) continue;
      delete state.claims[key];
      releasedKeys.add(key);
    }
    if (releasedKeys.size) task.claimedPaths = task.claimedPaths.filter((relPath) => !releasedKeys.has(canonicalPathKey(relPath)));
    task.updatedAt = nowIso();
  });
}

function workspaceRelativePath(root: string, cwd: string, value: string): string {
  const absolute = path.resolve(cwd, value);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".") return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CodexProError(`WORKSPACE_GIT_PATH_OUTSIDE_ROOT: ${value} is outside the active workspace.`, { code: "WORKSPACE_GIT_PATH_OUTSIDE_ROOT" });
  }
  return relative.replace(/\\/g, "/");
}

export async function preflightWorkspaceGitAdd(context: WorkspaceTaskContext, cwd: string, args: string[]): Promise<void> {
  const root = canonicalRoot(context.root);
  await withState(root, async (state) => {
    const task = requireTask(state, context.taskId);
    const gitRoot = taskGitRoot(context, task);
    const paths = uniquePaths(args.map((value) => workspaceRelativePath(gitRoot, cwd, value)));
    const ownedKeys = new Set(task.touchedPaths.map(canonicalPathKey));
    const stagedPaths = uniquePaths(await gitPaths(gitRoot, ["diff", "--cached", "--name-only", "-z", "--"]));
    if (!task.worktreeRoot) {
      const foreignStaged = stagedPaths.filter((relPath) => !ownedKeys.has(canonicalPathKey(relPath)));
      if (foreignStaged.length) {
        throw new CodexProError(`WORKSPACE_GIT_INDEX_BUSY: staged paths belong to another task or predate ${task.taskId}: ${foreignStaged.join(", ")}. Commit or clear that integration first.`, {
          code: "WORKSPACE_GIT_INDEX_BUSY",
          details: { task_id: task.taskId, staged_paths: foreignStaged }
        });
      }
    }
    const unowned = paths.filter((relPath) => !ownedKeys.has(canonicalPathKey(relPath)));
    if (unowned.length) {
      throw new CodexProError(`WORKSPACE_GIT_ADD_NOT_OWNED: task ${task.taskId} did not create/edit these paths through CodexPro: ${unowned.join(", ")}.`, {
        code: "WORKSPACE_GIT_ADD_NOT_OWNED",
        details: { task_id: task.taskId, paths: unowned }
      });
    }
    const conflicts = paths.filter((relPath) => { const owner = claimOwner(state, relPath); return owner && owner !== task.taskId; });
    if (conflicts.length) {
      throw new CodexProError(`WORKSPACE_GIT_ADD_CONFLICT: paths are owned by another active task: ${conflicts.join(", ")}.`, {
        code: "WORKSPACE_GIT_ADD_CONFLICT",
        details: { task_id: task.taskId, paths: conflicts }
      });
    }
    task.updatedAt = nowIso();
  });
}

export async function preflightWorkspaceCommit(context: WorkspaceTaskContext): Promise<{ stagedPaths: string[] }> {
  const root = canonicalRoot(context.root);
  return await withState(root, async (state) => {
    const task = requireTask(state, context.taskId);
    const gitRoot = taskGitRoot(context, task);
    const stagedPaths = uniquePaths(await gitPaths(gitRoot, ["diff", "--cached", "--name-only", "-z", "--"]));
    if (!stagedPaths.length) return { stagedPaths };

    const ownedKeys = new Set(task.touchedPaths.map(canonicalPathKey));
    const notOwned = stagedPaths.filter((relPath) => !ownedKeys.has(canonicalPathKey(relPath)));
    if (notOwned.length) {
      throw new CodexProError(`WORKSPACE_COMMIT_NOT_OWNED: staged paths are outside task ${task.taskId}: ${notOwned.join(", ")}.`, {
        code: "WORKSPACE_COMMIT_NOT_OWNED",
        details: { task_id: task.taskId, paths: notOwned }
      });
    }

    if (!task.worktreeRoot) {
      const dirtyAtStart = new Set(task.initialDirtyPaths.map(canonicalPathKey));
      const preexisting = stagedPaths.filter((relPath) => dirtyAtStart.has(canonicalPathKey(relPath)));
      if (preexisting.length) {
        throw new CodexProError(`WORKSPACE_COMMIT_PREEXISTING_DIRTY: refusing to commit paths that were already dirty when ${task.taskId} started: ${preexisting.join(", ")}.`, {
          code: "WORKSPACE_COMMIT_PREEXISTING_DIRTY",
          details: { task_id: task.taskId, paths: preexisting }
        });
      }
    }

    const foreignClaims = stagedPaths.filter((relPath) => { const owner = claimOwner(state, relPath); return owner && owner !== task.taskId; });
    if (foreignClaims.length) {
      throw new CodexProError(`WORKSPACE_COMMIT_CONFLICT: staged paths are owned by another active task: ${foreignClaims.join(", ")}.`, {
        code: "WORKSPACE_COMMIT_CONFLICT",
        details: { task_id: task.taskId, paths: foreignClaims }
      });
    }

    if (!task.worktreeRoot) {
      const head = await currentHead(gitRoot);
      const conflicts = await changedPathsBetween(gitRoot, task.baseHead, head, stagedPaths);
      if (conflicts.length) {
        throw new CodexProError(`WORKSPACE_COMMIT_STALE_BASE: HEAD changed on paths staged by ${task.taskId}: ${conflicts.join(", ")}.`, {
          code: "WORKSPACE_COMMIT_STALE_BASE",
          details: { task_id: task.taskId, base_head: task.baseHead, current_head: head, paths: conflicts }
        });
      }
    }
    task.updatedAt = nowIso();
    return { stagedPaths };
  });
}

export async function recordWorkspaceCommit(context: WorkspaceTaskContext): Promise<string> {
  const root = canonicalRoot(context.root);
  return await withState(root, async (state) => {
    const task = requireTask(state, context.taskId);
    const gitRoot = taskGitRoot(context, task);
    const head = await currentHead(gitRoot);
    if (!head) return "";
    const message = await gitText(gitRoot, ["show", "-s", "--format=%B", head]);
    const provenance = `CodexPro-Task: ${context.taskId}`;
    if (!message.split(/\r?\n/).some((line) => line.trim() === provenance)) {
      throw new CodexProError(`WORKSPACE_COMMIT_PROVENANCE_MISSING: HEAD is not tagged for task ${context.taskId}.`, {
        code: "WORKSPACE_COMMIT_PROVENANCE_MISSING",
        details: { task_id: context.taskId, head }
      });
    }
    task.commitShas = [...new Set([...task.commitShas, head])].slice(-200);
    if (!task.worktreeRoot) {
      task.baseHead = head;
      task.baseBranch = await currentBranch(gitRoot);
      task.baseRemoteHead = await currentRemoteHead(gitRoot);
    }
    task.updatedAt = nowIso();
    return head;
  });
}

export async function acquireWorkspaceIntegrationLease(context: WorkspaceTaskContext, branch = ""): Promise<() => Promise<void>> {
  const root = canonicalRoot(context.root);
  const startedAt = Date.now();
  const enqueuedAt = nowIso();
  await withState(root, async (state) => {
    const task = requireTask(state, context.taskId);
    if (state.integrationLease?.taskId === context.taskId) return;
    if (!state.integrationQueue.some((entry) => entry.taskId === context.taskId)) {
      state.integrationQueue.push({ taskId: context.taskId, branch: String(branch || "").slice(0, 200), enqueuedAt });
    }
    if (branch) {
      task.integrationStatus = "queued";
      task.integrationBranch = branch;
      task.integrationRequestedAt = enqueuedAt;
    }
    task.updatedAt = nowIso();
  });

  while (true) {
    const acquired = await withState(root, async (state) => {
      const task = requireTask(state, context.taskId);
      if (state.integrationLease?.taskId === context.taskId) return true;
      const first = state.integrationQueue[0];
      if (state.integrationLease || first?.taskId !== context.taskId) return false;
      state.integrationQueue.shift();
      state.integrationLease = { taskId: context.taskId, acquiredAt: nowIso() };
      if (branch) {
        task.integrationStatus = "integrating";
        task.integrationStartedAt = nowIso();
      }
      task.updatedAt = nowIso();
      return true;
    });
    if (acquired) break;
    if (Date.now() - startedAt >= INTEGRATION_QUEUE_WAIT_MS) {
      await withState(root, async (state) => {
        state.integrationQueue = state.integrationQueue.filter((entry) => entry.taskId !== context.taskId);
        const task = state.tasks[context.taskId];
        if (task?.status === "running" && branch) {
          task.integrationStatus = "failed";
          task.integrationFinishedAt = nowIso();
          task.updatedAt = nowIso();
        }
      }).catch(() => undefined);
      throw new CodexProError(`WORKSPACE_INTEGRATION_QUEUE_TIMEOUT: task ${context.taskId} waited too long for workspace integration.`, {
        code: "WORKSPACE_INTEGRATION_QUEUE_TIMEOUT",
        details: { task_id: context.taskId, branch, wait_ms: INTEGRATION_QUEUE_WAIT_MS }
      });
    }
    await sleep(INTEGRATION_QUEUE_POLL_MS);
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await withState(root, async (state) => {
      if (state.integrationLease?.taskId === context.taskId) delete state.integrationLease;
      const task = state.tasks[context.taskId];
      if (task?.status === "running" && branch && task.integrationStatus === "integrating") {
        task.integrationStatus = "failed";
        task.integrationFinishedAt = nowIso();
        task.updatedAt = nowIso();
      }
    }).catch(() => undefined);
  };
}

export async function preflightWorkspacePush(context: WorkspaceTaskContext, branch: string): Promise<void> {
  const root = canonicalRoot(context.root);
  const task = await withState(root, async (state) => {
    const currentTask = requireTask(state, context.taskId);
    return { ...currentTask, commitShas: [...currentTask.commitShas], touchedPaths: [...currentTask.touchedPaths] };
  });
  const gitRoot = taskGitRoot(context, task);
  const current = await currentBranch(gitRoot);
  const expectedCurrent = task.worktreeRoot ? task.worktreeBranch : branch;
  if (!current || (expectedCurrent && current !== expectedCurrent) || (task.worktreeRoot && task.baseBranch && branch !== task.baseBranch)) {
    throw new CodexProError(`WORKSPACE_PUSH_BRANCH_MISMATCH: active task branch is ${current || "detached"}, integration target is ${branch}.`, {
      code: "WORKSPACE_PUSH_BRANCH_MISMATCH",
      details: { task_id: task.taskId, current_branch: current, task_branch: task.worktreeBranch || null, base_branch: task.baseBranch || null, requested_branch: branch }
    });
  }
  const dirty = await currentDirtyPaths(gitRoot);
  if (dirty.length) {
    throw new CodexProError(`WORKSPACE_PUSH_DIRTY_WORKTREE: commit or revert task changes before integrating: ${dirty.join(", ")}.`, {
      code: "WORKSPACE_PUSH_DIRTY_WORKTREE",
      details: { task_id: task.taskId, paths: dirty }
    });
  }
  let head = await currentHead(gitRoot);
  if (head && !task.commitShas.includes(head)) {
    throw new CodexProError(`WORKSPACE_PUSH_HEAD_NOT_OWNED: local HEAD was not committed by task ${task.taskId}.`, {
      code: "WORKSPACE_PUSH_HEAD_NOT_OWNED",
      details: { task_id: task.taskId, branch, local_head: head, commit_shas: task.commitShas }
    });
  }

  const remoteLine = await gitText(gitRoot, ["ls-remote", "origin", `refs/heads/${branch}`]);
  let remoteHead = remoteLine.split(/\s+/)[0] || "";
  if (remoteHead && head && await gitStatus(gitRoot, ["merge-base", "--is-ancestor", remoteHead, head]) !== 0) {
    const fetched = await gitRun(gitRoot, ["fetch", "--quiet", "origin", branch], 60_000);
    if (fetched.status !== 0) {
      throw new CodexProError(`WORKSPACE_INTEGRATION_FETCH_FAILED: ${fetched.stderr || fetched.stdout || `could not fetch origin/${branch}`}.`, {
        code: "WORKSPACE_INTEGRATION_FETCH_FAILED",
        details: { task_id: task.taskId, branch }
      });
    }
    remoteHead = await gitText(gitRoot, ["rev-parse", `refs/remotes/origin/${branch}`]) || remoteHead;
    const localChanged = await changedPathsBetween(gitRoot, task.baseHead, head);
    const remoteChanged = await changedPathsBetween(gitRoot, task.baseHead, remoteHead);
    const remoteKeys = new Set(remoteChanged.map(canonicalPathKey));
    const overlap = localChanged.filter((relPath) => remoteKeys.has(canonicalPathKey(relPath)));
    if (overlap.length) {
      await withState(root, async (state) => {
        const live = requireTask(state, context.taskId);
        live.integrationStatus = "conflict";
        live.integrationFinishedAt = nowIso();
        live.remoteHeadBeforeIntegration = remoteHead;
        live.updatedAt = nowIso();
      });
      throw new CodexProError(`WORKSPACE_INTEGRATION_CONFLICT: origin/${branch} changed task-owned paths: ${overlap.join(", ")}.`, {
        code: "WORKSPACE_INTEGRATION_CONFLICT",
        details: { task_id: task.taskId, branch, base_head: task.baseHead, remote_head: remoteHead, local_head: head, paths: overlap }
      });
    }

    const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-empty-git-hooks-"));
    try {
      const rebased = await gitRun(gitRoot, ["-c", `core.hooksPath=${hooksDir}`, "rebase", remoteHead], 120_000);
      if (rebased.status !== 0) {
        await gitRun(gitRoot, ["-c", `core.hooksPath=${hooksDir}`, "rebase", "--abort"], 30_000);
        await withState(root, async (state) => {
          const live = requireTask(state, context.taskId);
          live.integrationStatus = "conflict";
          live.integrationFinishedAt = nowIso();
          live.remoteHeadBeforeIntegration = remoteHead;
          live.updatedAt = nowIso();
        });
        throw new CodexProError(`WORKSPACE_INTEGRATION_REBASE_FAILED: ${rebased.stderr || rebased.stdout || "git rebase failed"}`, {
          code: "WORKSPACE_INTEGRATION_REBASE_FAILED",
          details: { task_id: task.taskId, branch, remote_head: remoteHead, local_head: head }
        });
      }
    } finally {
      fs.rmSync(hooksDir, { recursive: true, force: true });
    }
    head = await currentHead(gitRoot);
    const rebasedCommits = (await gitText(gitRoot, ["rev-list", "--reverse", `${remoteHead}..${head}`])).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const provenance = `CodexPro-Task: ${task.taskId}`;
    for (const commit of rebasedCommits) {
      const message = await gitText(gitRoot, ["show", "-s", "--format=%B", commit]);
      if (!message.split(/\r?\n/).some((line) => line.trim() === provenance)) {
        throw new CodexProError(`WORKSPACE_COMMIT_PROVENANCE_MISSING: rebased commit ${commit} is not tagged for task ${task.taskId}.`, {
          code: "WORKSPACE_COMMIT_PROVENANCE_MISSING",
          details: { task_id: task.taskId, commit }
        });
      }
    }
    await withState(root, async (state) => {
      const live = requireTask(state, context.taskId);
      live.baseHead = remoteHead;
      live.baseRemoteHead = remoteHead;
      live.commitShas = [...new Set([...live.commitShas, ...rebasedCommits, head].filter(Boolean))].slice(-200);
      live.remoteHeadBeforeIntegration = remoteHead;
      live.updatedAt = nowIso();
    });
  } else {
    await withState(root, async (state) => {
      const live = requireTask(state, context.taskId);
      live.remoteHeadBeforeIntegration = remoteHead;
      live.updatedAt = nowIso();
    });
  }
}

export async function recordWorkspacePush(context: WorkspaceTaskContext, branch: string): Promise<string> {
  const root = canonicalRoot(context.root);
  return await withState(root, async (state) => {
    const task = requireTask(state, context.taskId);
    const gitRoot = taskGitRoot(context, task);
    const head = await currentHead(gitRoot);
    task.integrationStatus = "integrated";
    task.integrationBranch = branch;
    task.integrationFinishedAt = nowIso();
    task.integratedHead = head;
    task.baseHead = head;
    task.baseRemoteHead = head;
    task.updatedAt = nowIso();
    return head;
  });
}

export async function finalizeWorkspaceTask(context: WorkspaceTaskContext, status: WorkspaceTaskStatus): Promise<void> {
  const root = canonicalRoot(context.root);
  const cleanup = await withState(root, async (state) => {
    const task = state.tasks[context.taskId];
    if (!task) return undefined;
    const now = nowIso();
    task.status = status;
    task.finishedAt = now;
    task.updatedAt = now;
    for (const [claimPath, claim] of Object.entries(state.claims)) {
      if (claim.taskId === task.taskId) delete state.claims[claimPath];
    }
    state.integrationQueue = state.integrationQueue.filter((entry) => entry.taskId !== task.taskId);
    if (state.integrationLease?.taskId === task.taskId) delete state.integrationLease;
    return {
      worktreeRoot: task.worktreeRoot,
      worktreeBranch: task.worktreeBranch,
      removeWorktree: status === "completed" && task.integrationStatus === "integrated"
    };
  });
  if (cleanup?.removeWorktree && cleanup.worktreeRoot && fs.existsSync(cleanup.worktreeRoot) && (await currentDirtyPaths(cleanup.worktreeRoot)).length === 0) {
    const removed = await gitRun(root, ["worktree", "remove", cleanup.worktreeRoot], 60_000);
    if (removed.status === 0 && cleanup.worktreeBranch) {
      await gitRun(root, ["branch", "-D", cleanup.worktreeBranch], 30_000);
    }
  }
}

export function readWorkspaceCoordination(root: string): WorkspaceCoordinationState {
  const state = readState(root);
  cleanupStaleState(state);
  return state;
}

export async function readWorkspaceCoordinationStatus(root: string) {
  const canonical = canonicalRoot(root);
  const state = readState(canonical);
  cleanupStaleState(state);
  const head = await currentHead(canonical);
  const branch = await currentBranch(canonical);
  const queuePosition = new Map(state.integrationQueue.map((entry, index) => [entry.taskId, index + 1]));
  const claims = Object.entries(state.claims)
    .map(([claimPath, claim]) => {
      const task = state.tasks[claim.taskId];
      return {
        path: claimPath,
        task_id: claim.taskId,
        task_title: task?.title || "",
        worker_id: task?.workerId || "",
        claimed_at: claim.claimedAt,
        updated_at: claim.updatedAt
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const tasks = (await Promise.all(Object.values(state.tasks)
    .map(async (task) => {
      const watchedPaths = uniquePaths([...task.claimedPaths, ...task.touchedPaths]);
      const stalePaths = task.status === "running" && task.baseHead && head && task.baseHead !== head && watchedPaths.length
        ? await changedPathsBetween(canonical, task.baseHead, head, watchedPaths)
        : [];
      return {
        task_id: task.taskId,
        worker_id: task.workerId,
        title: task.title,
        status: task.status,
        base_head: task.baseHead,
        base_branch: task.baseBranch,
        base_remote_head: task.baseRemoteHead,
        current_head: head,
        current_branch: branch,
        base_behind: Boolean(task.status === "running" && task.baseHead && head && task.baseHead !== head),
        stale_base: stalePaths.length > 0,
        stale_paths: stalePaths,
        initial_dirty_paths: [...task.initialDirtyPaths],
        touched_paths: [...task.touchedPaths],
        claimed_paths: [...task.claimedPaths],
        commit_shas: [...task.commitShas],
        worktree_root: task.worktreeRoot || "",
        worktree_branch: task.worktreeBranch || "",
        integration_status: task.integrationStatus || "idle",
        integration_branch: task.integrationBranch || "",
        integration_requested_at: task.integrationRequestedAt || "",
        integration_started_at: task.integrationStartedAt || "",
        integration_finished_at: task.integrationFinishedAt || "",
        integrated_head: task.integratedHead || "",
        remote_head_before_integration: task.remoteHeadBeforeIntegration || "",
        queue_position: queuePosition.get(task.taskId) || 0,
        started_at: task.startedAt,
        updated_at: task.updatedAt,
        finished_at: task.finishedAt || ""
      };
    })))
    .sort((left, right) => {
      if (left.status === "running" && right.status !== "running") return -1;
      if (left.status !== "running" && right.status === "running") return 1;
      return Date.parse(right.updated_at || "") - Date.parse(left.updated_at || "");
    });
  return {
    version: state.version,
    root: canonical,
    updated_at: state.updatedAt,
    current_head: head,
    current_branch: branch,
    tasks,
    claims,
    integration_queue: state.integrationQueue.map((entry, index) => ({
      task_id: entry.taskId,
      task_title: state.tasks[entry.taskId]?.title || "",
      branch: entry.branch,
      enqueued_at: entry.enqueuedAt,
      position: index + 1
    })),
    integration_lease: state.integrationLease ? {
      task_id: state.integrationLease.taskId,
      task_title: state.tasks[state.integrationLease.taskId]?.title || "",
      acquired_at: state.integrationLease.acquiredAt
    } : null
  };
}
