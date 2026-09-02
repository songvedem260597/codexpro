import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CodexProError } from "./guard.js";
import { codexProHome } from "./profileStore.js";

const COORDINATION_VERSION = 1;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 200;
const STALE_LOCK_MS = 30_000;
const STALE_INTEGRATION_LEASE_MS = 10 * 60 * 1000;
const STALE_TASK_MS = 6 * 60 * 60 * 1000;

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

type WorkspaceCoordinationState = {
  version: 1;
  root: string;
  updatedAt: string;
  tasks: Record<string, WorkspaceTaskRecord>;
  claims: Record<string, WorkspaceClaim>;
  integrationLease?: IntegrationLease;
};

export type WorkspaceTaskContext = {
  taskId: string;
  workerId?: string;
  title?: string;
  root: string;
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

function statePath(root: string): string {
  return path.join(coordinationDir(), `${workspaceKey(root)}.json`);
}

function lockPath(root: string): string {
  return `${statePath(root)}.lock`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function gitText(root: string, args: string[]): string {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 12_000
  });
  return result.status === 0 ? String(result.stdout ?? "").trim() : "";
}

function gitStatus(root: string, args: string[]): number {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 12_000
  });
  return Number(result.status ?? 1);
}

function nulPaths(text: string): string[] {
  return text.split("\0").map((value) => value.trim()).filter(Boolean).map((value) => value.replace(/\\/g, "/"));
}

function gitPaths(root: string, args: string[]): string[] {
  return nulPaths(gitText(root, args));
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

function currentDirtyPaths(root: string): string[] {
  return uniquePaths([
    ...gitPaths(root, ["diff", "--name-only", "-z", "--"]),
    ...gitPaths(root, ["diff", "--cached", "--name-only", "-z", "--"]),
    ...gitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"])
  ]);
}

function currentHead(root: string): string {
  return gitText(root, ["rev-parse", "HEAD"]);
}

function currentBranch(root: string): string {
  const branch = gitText(root, ["branch", "--show-current"]);
  return branch || gitText(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function currentRemoteHead(root: string): string {
  return gitText(root, ["rev-parse", "@{upstream}"]);
}

function emptyState(root: string): WorkspaceCoordinationState {
  return {
    version: COORDINATION_VERSION,
    root: canonicalRoot(root),
    updatedAt: nowIso(),
    tasks: {},
    claims: {}
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
    const leaseTaskId = String(parsed?.integrationLease?.taskId || "").trim();
    return {
      version: COORDINATION_VERSION,
      root: canonical,
      updatedAt: String(parsed?.updatedAt || nowIso()),
      tasks,
      claims,
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

function changedPathsBetween(root: string, baseHead: string, head: string, paths?: string[]): string[] {
  if (!baseHead || !head || baseHead === head) return [];
  const args = ["diff", "--name-only", "-z", `${baseHead}..${head}`];
  if (paths?.length) args.push("--", ...paths);
  return uniquePaths(gitPaths(root, args));
}

function claimOwner(state: WorkspaceCoordinationState, relPath: string): string | undefined {
  return state.claims[canonicalPathKey(relPath)]?.taskId;
}

export async function registerWorkspaceTask(context: WorkspaceTaskContext): Promise<WorkspaceTaskRecord> {
  const root = canonicalRoot(context.root);
  return await withState(root, (state) => {
    const existing = state.tasks[context.taskId];
    const now = nowIso();
    if (existing?.status === "running") {
      existing.updatedAt = now;
      if (context.workerId) existing.workerId = String(context.workerId).slice(0, 160);
      if (context.title) existing.title = String(context.title).slice(0, 120);
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
        if (state.integrationLease?.taskId === task.taskId) delete state.integrationLease;
      }
    }

    const task: WorkspaceTaskRecord = {
      taskId: context.taskId,
      workerId,
      title: String(context.title || "").trim().slice(0, 120),
      status: "running",
      baseHead: currentHead(root),
      baseBranch: currentBranch(root),
      baseRemoteHead: currentRemoteHead(root),
      initialDirtyPaths: currentDirtyPaths(root),
      touchedPaths: [],
      claimedPaths: [],
      commitShas: [],
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
  return await withState(root, (state) => {
    const task = requireTask(state, context.taskId);
    const head = currentHead(root);
    const committedConflicts = changedPathsBetween(root, task.baseHead, head, normalizedPaths);
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
  return await withState(root, (state) => {
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
  await withState(root, (state) => {
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
  const paths = uniquePaths(args.map((value) => workspaceRelativePath(root, cwd, value)));
  await withState(root, (state) => {
    const task = requireTask(state, context.taskId);
    const ownedKeys = new Set(task.touchedPaths.map(canonicalPathKey));
    const stagedPaths = uniquePaths(gitPaths(root, ["diff", "--cached", "--name-only", "-z", "--"]));
    const foreignStaged = stagedPaths.filter((relPath) => !ownedKeys.has(canonicalPathKey(relPath)));
    if (foreignStaged.length) {
      throw new CodexProError(`WORKSPACE_GIT_INDEX_BUSY: staged paths belong to another task or predate ${task.taskId}: ${foreignStaged.join(", ")}. Commit or clear that integration first.`, {
        code: "WORKSPACE_GIT_INDEX_BUSY",
        details: { task_id: task.taskId, staged_paths: foreignStaged }
      });
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
  return await withState(root, (state) => {
    const task = requireTask(state, context.taskId);
    const stagedPaths = uniquePaths(gitPaths(root, ["diff", "--cached", "--name-only", "-z", "--"]));
    if (!stagedPaths.length) return { stagedPaths };

    const ownedKeys = new Set(task.touchedPaths.map(canonicalPathKey));
    const notOwned = stagedPaths.filter((relPath) => !ownedKeys.has(canonicalPathKey(relPath)));
    if (notOwned.length) {
      throw new CodexProError(`WORKSPACE_COMMIT_NOT_OWNED: staged paths are outside task ${task.taskId}: ${notOwned.join(", ")}.`, {
        code: "WORKSPACE_COMMIT_NOT_OWNED",
        details: { task_id: task.taskId, paths: notOwned }
      });
    }

    const dirtyAtStart = new Set(task.initialDirtyPaths.map(canonicalPathKey));
    const preexisting = stagedPaths.filter((relPath) => dirtyAtStart.has(canonicalPathKey(relPath)));
    if (preexisting.length) {
      throw new CodexProError(`WORKSPACE_COMMIT_PREEXISTING_DIRTY: refusing to commit paths that were already dirty when ${task.taskId} started: ${preexisting.join(", ")}.`, {
        code: "WORKSPACE_COMMIT_PREEXISTING_DIRTY",
        details: { task_id: task.taskId, paths: preexisting }
      });
    }

    const foreignClaims = stagedPaths.filter((relPath) => { const owner = claimOwner(state, relPath); return owner && owner !== task.taskId; });
    if (foreignClaims.length) {
      throw new CodexProError(`WORKSPACE_COMMIT_CONFLICT: staged paths are owned by another active task: ${foreignClaims.join(", ")}.`, {
        code: "WORKSPACE_COMMIT_CONFLICT",
        details: { task_id: task.taskId, paths: foreignClaims }
      });
    }

    const head = currentHead(root);
    const conflicts = changedPathsBetween(root, task.baseHead, head, stagedPaths);
    if (conflicts.length) {
      throw new CodexProError(`WORKSPACE_COMMIT_STALE_BASE: HEAD changed on paths staged by ${task.taskId}: ${conflicts.join(", ")}.`, {
        code: "WORKSPACE_COMMIT_STALE_BASE",
        details: { task_id: task.taskId, base_head: task.baseHead, current_head: head, paths: conflicts }
      });
    }
    task.updatedAt = nowIso();
    return { stagedPaths };
  });
}

export async function recordWorkspaceCommit(context: WorkspaceTaskContext): Promise<string> {
  const root = canonicalRoot(context.root);
  const head = currentHead(root);
  if (!head) return "";
  const message = gitText(root, ["show", "-s", "--format=%B", head]);
  const provenance = `CodexPro-Task: ${context.taskId}`;
  if (!message.split(/\r?\n/).some((line) => line.trim() === provenance)) {
    throw new CodexProError(`WORKSPACE_COMMIT_PROVENANCE_MISSING: HEAD is not tagged for task ${context.taskId}.`, {
      code: "WORKSPACE_COMMIT_PROVENANCE_MISSING",
      details: { task_id: context.taskId, head }
    });
  }
  await withState(root, (state) => {
    const task = requireTask(state, context.taskId);
    task.commitShas = [...new Set([...task.commitShas, head])].slice(-200);
    task.baseHead = head;
    task.baseBranch = currentBranch(root);
    task.baseRemoteHead = currentRemoteHead(root);
    task.updatedAt = nowIso();
  });
  return head;
}

export async function acquireWorkspaceIntegrationLease(context: WorkspaceTaskContext): Promise<() => Promise<void>> {
  const root = canonicalRoot(context.root);
  await withState(root, (state) => {
    requireTask(state, context.taskId);
    if (state.integrationLease && state.integrationLease.taskId !== context.taskId) {
      throw new CodexProError(`WORKSPACE_INTEGRATION_BUSY: task ${state.integrationLease.taskId} is committing or pushing this workspace.`, {
        code: "WORKSPACE_INTEGRATION_BUSY",
        details: { task_id: context.taskId, owner_task_id: state.integrationLease.taskId }
      });
    }
    state.integrationLease = { taskId: context.taskId, acquiredAt: nowIso() };
  });
  return async () => {
    await withState(root, (state) => {
      if (state.integrationLease?.taskId === context.taskId) delete state.integrationLease;
    }).catch(() => undefined);
  };
}

export async function preflightWorkspacePush(context: WorkspaceTaskContext, branch: string): Promise<void> {
  const root = canonicalRoot(context.root);
  await withState(root, (state) => {
    const task = requireTask(state, context.taskId);
    const current = currentBranch(root);
    if (!current || current !== branch) {
      throw new CodexProError(`WORKSPACE_PUSH_BRANCH_MISMATCH: active branch is ${current || "detached"}, requested ${branch}.`, {
        code: "WORKSPACE_PUSH_BRANCH_MISMATCH",
        details: { task_id: task.taskId, current_branch: current, requested_branch: branch }
      });
    }
    const remoteLine = gitText(root, ["ls-remote", "origin", `refs/heads/${branch}`]);
    const remoteHead = remoteLine.split(/\s+/)[0] || "";
    const head = currentHead(root);
    if (head && !task.commitShas.includes(head)) {
      throw new CodexProError(`WORKSPACE_PUSH_HEAD_NOT_OWNED: local HEAD was not committed by task ${task.taskId}.`, {
        code: "WORKSPACE_PUSH_HEAD_NOT_OWNED",
        details: { task_id: task.taskId, branch, local_head: head, commit_shas: task.commitShas }
      });
    }
    if (remoteHead && head && gitStatus(root, ["merge-base", "--is-ancestor", remoteHead, head]) !== 0) {
      throw new CodexProError(`WORKSPACE_PUSH_REMOTE_ADVANCED: origin/${branch} is not an ancestor of local HEAD. Reconcile before pushing.`, {
        code: "WORKSPACE_PUSH_REMOTE_ADVANCED",
        details: { task_id: task.taskId, branch, remote_head: remoteHead, local_head: head }
      });
    }
    task.updatedAt = nowIso();
  });
}

export async function finalizeWorkspaceTask(context: WorkspaceTaskContext, status: WorkspaceTaskStatus): Promise<void> {
  const root = canonicalRoot(context.root);
  await withState(root, (state) => {
    const task = state.tasks[context.taskId];
    if (!task) return;
    const now = nowIso();
    task.status = status;
    task.finishedAt = now;
    task.updatedAt = now;
    for (const [claimPath, claim] of Object.entries(state.claims)) {
      if (claim.taskId === task.taskId) delete state.claims[claimPath];
    }
    if (state.integrationLease?.taskId === task.taskId) delete state.integrationLease;
  });
}

export function readWorkspaceCoordination(root: string): WorkspaceCoordinationState {
  const state = readState(root);
  cleanupStaleState(state);
  return state;
}
