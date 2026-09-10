import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CodexProError, type Workspace, type WorkspaceManager } from "./guard.js";
import { CODEXPRO_GLOBAL_RULES_FILE, readGlobalRulesSnapshotSync as defaultReadGlobalRulesSnapshotSync } from "./globalRules.js";
import { readWorkerJob as defaultReadWorkerJob, type WorkerJobRecord } from "./workerPolicy.js";
import { readWorkspaceCoordination as defaultReadWorkspaceCoordination, type WorkspaceTaskContext } from "./workspaceCoordination.js";

export type ActiveRepoTask = {
  coordinationRoot?: string;
  taskId: string;
  taskTitle: string;
  root: string;
  workspaceId: string;
  scope: "workspace" | "all_allowed";
  globalRulesSha256: string;
  worktreeRoot?: string;
  worktreeBranch?: string;
};

export type ExpectedRepoTask = {
  taskId: string;
  root?: string;
  scope: "workspace" | "all_allowed";
  preparedAt: number;
};

type RepoTaskRuntimeHooks = {
  readWorkerJob?: (taskId: string) => WorkerJobRecord | undefined;
  readGlobalRulesSnapshotSync?: typeof defaultReadGlobalRulesSnapshotSync;
  readWorkspaceCoordination?: typeof defaultReadWorkspaceCoordination;
};

const REPO_TASK_GATE_EXEMPT_TOOLS = new Set<string>([
  "codexpro",
  "begin_repo_task",
  "resume_repo_task",
  "repo_task_status",
  "workspace_coordination_status",
  "worker_job_status",
  "worker_job_history",
  "worker_context_history",
  "report_worker_job_progress",
  "finalize_worker_job"
]);

export function createRepoTaskRuntime(hooks: RepoTaskRuntimeHooks = {}) {
  const readWorkerJob = hooks.readWorkerJob ?? defaultReadWorkerJob;
  const readGlobalRulesSnapshotSync = hooks.readGlobalRulesSnapshotSync ?? defaultReadGlobalRulesSnapshotSync;
  const readWorkspaceCoordination = hooks.readWorkspaceCoordination ?? defaultReadWorkspaceCoordination;

  const repoTaskGateRequiredByServer = new WeakMap<object, boolean>();
  const repoTaskGateProfileByServer = new WeakMap<object, string>();
  const activeRepoTaskByServer = new WeakMap<object, ActiveRepoTask>();
  const activeRepoTaskByProfile = new Map<string, ActiveRepoTask>();
  const repoTaskWorkspaceSelectorByServer = new WeakMap<object, (root: string) => Workspace>();
  const expectedRepoTaskByProfile = new Map<string, ExpectedRepoTask>();

  function configureServer(
    server: McpServer,
    options: { requireRepoTask: boolean; profileId?: string; workspaceSelector: (root: string) => Workspace }
  ): void {
    repoTaskWorkspaceSelectorByServer.set(server as object, options.workspaceSelector);
    repoTaskGateRequiredByServer.set(server as object, options.requireRepoTask);
    if (options.profileId) repoTaskGateProfileByServer.set(server as object, options.profileId);
  }

  function profileIdForServer(server: object): string {
    return repoTaskGateProfileByServer.get(server) || "";
  }

  function setProfileIdForServer(server: object, profileId: string): void {
    repoTaskGateProfileByServer.set(server, profileId);
  }

  function resolveWorkerJobProfileIdForServer(server: object, taskId: string): string {
    const durableWorkerId = String(readWorkerJob(taskId)?.workerId || "").trim();
    if (durableWorkerId) {
      repoTaskGateProfileByServer.set(server, durableWorkerId);
      return durableWorkerId;
    }
    return repoTaskGateProfileByServer.get(server) || "";
  }

  function sameResolvedRoot(left: string, right: string): boolean {
    const resolvedLeft = path.resolve(left);
    const resolvedRight = path.resolve(right);
    return process.platform === "win32"
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight;
  }

  function expectedRepoTask(profileId: string): ExpectedRepoTask | undefined {
    return expectedRepoTaskByProfile.get(profileId);
  }

  function expectedRepoTaskOwner(taskId: string): { profileId: string; expected: ExpectedRepoTask } | undefined {
    let owner: { profileId: string; expected: ExpectedRepoTask } | undefined;
    for (const [profileId, expected] of expectedRepoTaskByProfile) {
      if (expected.taskId !== taskId) continue;
      if (owner) return undefined;
      owner = { profileId, expected };
    }
    return owner;
  }

  function rememberExpectedRepoTask(profileId: string, expected: Omit<ExpectedRepoTask, "preparedAt">): ExpectedRepoTask {
    const prepared = { ...expected, preparedAt: Date.now() };
    activeRepoTaskByProfile.delete(profileId);
    expectedRepoTaskByProfile.delete(profileId);
    expectedRepoTaskByProfile.set(profileId, prepared);
    if (expectedRepoTaskByProfile.size > 500) {
      for (const staleProfileId of [...expectedRepoTaskByProfile.keys()].slice(0, expectedRepoTaskByProfile.size - 400)) {
        expectedRepoTaskByProfile.delete(staleProfileId);
      }
    }
    return prepared;
  }

  function repoTaskRootMatches(leftRoot: string, right: ExpectedRepoTask | ActiveRepoTask): boolean {
    if (right.scope === "all_allowed" && !right.root) return true;
    return Boolean(right.root && sameResolvedRoot(leftRoot, right.root));
  }

  function sameRepoTask(left: ActiveRepoTask | undefined, right: ExpectedRepoTask | ActiveRepoTask | undefined): boolean {
    return Boolean(
      left
      && right
      && left.taskId === right.taskId
      && left.scope === right.scope
      && repoTaskRootMatches(left.root, right)
    );
  }

  function activeRepoTaskForProfile(profileId: string): ActiveRepoTask | undefined {
    return activeRepoTaskByProfile.get(profileId);
  }

  function setActiveRepoTaskForProfile(profileId: string, active: ActiveRepoTask): void {
    activeRepoTaskByProfile.set(profileId, active);
  }

  function clearActiveRepoTaskForProfile(profileId: string): void {
    activeRepoTaskByProfile.delete(profileId);
  }

  function activeRepoTaskForServer(server: McpServer): ActiveRepoTask | undefined {
    const profileId = repoTaskGateProfileByServer.get(server as object) || "";
    return profileId ? activeRepoTaskByProfile.get(profileId) : activeRepoTaskByServer.get(server as object);
  }

  function setActiveRepoTaskForServer(server: McpServer, active: ActiveRepoTask): void {
    activeRepoTaskByServer.set(server as object, active);
  }

  function clearActiveRepoTaskForServer(server: McpServer): void {
    activeRepoTaskByServer.delete(server as object);
  }

  function assertRepoTaskGate(server: McpServer, name: string): void {
    if (!repoTaskGateRequiredByServer.get(server as object) || REPO_TASK_GATE_EXEMPT_TOOLS.has(name)) return;
    const profileId = repoTaskGateProfileByServer.get(server as object) || "";
    const expected = profileId ? expectedRepoTask(profileId) : undefined;
    const active = profileId ? activeRepoTaskByProfile.get(profileId) : activeRepoTaskByServer.get(server as object);
    if (!active || !sameRepoTask(active, expected)) {
      activeRepoTaskByServer.delete(server as object);
      if (profileId) activeRepoTaskByProfile.delete(profileId);
      throw new CodexProError(
        `BEGIN_REPO_TASK_REQUIRED: ${name} is blocked until the current CodexPro Manager task is activated with begin_repo_task.`,
        {
          code: "BEGIN_REPO_TASK_REQUIRED",
          details: {
            tool: name,
            profile_id: profileId || undefined,
            expected_task_id: expected?.taskId,
            active_task_id: active?.taskId
          }
        }
      );
    }
    const latestRules = readGlobalRulesSnapshotSync();
    if (latestRules.sha256 !== active.globalRulesSha256) {
      activeRepoTaskByServer.delete(server as object);
      if (profileId) activeRepoTaskByProfile.delete(profileId);
      throw new CodexProError(
        `BEGIN_REPO_TASK_RULES_CHANGED: ${CODEXPRO_GLOBAL_RULES_FILE} changed after task ${active.taskId} began. Call begin_repo_task again before using ${name}.`,
        {
          code: "BEGIN_REPO_TASK_RULES_CHANGED",
          details: {
            tool: name,
            task_id: active.taskId,
            previous_global_rules_sha256: active.globalRulesSha256,
            current_global_rules_sha256: latestRules.sha256,
            global_rules_path: latestRules.path
          }
        }
      );
    }
    const sessionActive = activeRepoTaskByServer.get(server as object);
    if (!sameRepoTask(sessionActive, active) || sessionActive?.globalRulesSha256 !== active.globalRulesSha256) {
      repoTaskWorkspaceSelectorByServer.get(server as object)?.(active.root);
      activeRepoTaskByServer.set(server as object, active);
    }
  }

  function assertTaskChecklistReady(server: McpServer): void {
    const active = activeRepoTaskForServer(server);
    if (!active) return;
    const job = readWorkerJob(active.taskId);
    if (!job || !["medium", "large"].includes(String(job.taskSize)) || job.checklist.length) return;
    throw new CodexProError(
      "TASK_CHECKLIST_REQUIRED: Report a complete durable checklist with report_worker_job_progress before modifying source for a medium or large task.",
      { code: "TASK_CHECKLIST_REQUIRED", details: { task_id: active.taskId, task_size: job.taskSize } }
    );
  }

  function repoTaskCoordinationRoot(active: ActiveRepoTask): string {
    return active.coordinationRoot || active.root;
  }

  function repoTaskWorktree(active: ActiveRepoTask): { root?: string; branch?: string } {
    if (active.worktreeRoot) {
      if (!fs.existsSync(active.worktreeRoot)) {
        throw new CodexProError(`WORKSPACE_TASK_WORKTREE_MISSING: recorded worktree no longer exists: ${active.worktreeRoot}.`, {
          code: "WORKSPACE_TASK_WORKTREE_MISSING",
          details: { task_id: active.taskId, worktree_root: active.worktreeRoot, workspace_root: active.root }
        });
      }
      return { root: active.worktreeRoot, branch: active.worktreeBranch };
    }
    const record = readWorkspaceCoordination(repoTaskCoordinationRoot(active)).tasks[active.taskId];
    if (record?.worktreeRoot) {
      if (!fs.existsSync(record.worktreeRoot)) {
        throw new CodexProError(`WORKSPACE_TASK_WORKTREE_MISSING: recorded worktree no longer exists: ${record.worktreeRoot}.`, {
          code: "WORKSPACE_TASK_WORKTREE_MISSING",
          details: { task_id: active.taskId, worktree_root: record.worktreeRoot, workspace_root: active.root }
        });
      }
      active.worktreeRoot = record.worktreeRoot;
      active.worktreeBranch = record.worktreeBranch;
      return { root: record.worktreeRoot, branch: record.worktreeBranch };
    }
    return {};
  }

  function effectiveWorkspaceForServer(server: McpServer, workspace: Workspace): Workspace {
    const active = activeRepoTaskForServer(server);
    if (!active) return workspace;
    const worktree = repoTaskWorktree(active);
    if (!worktree.root) return workspace;
    if (sameResolvedRoot(workspace.root, worktree.root)) return workspace;
    if (!sameResolvedRoot(workspace.root, active.root)) return workspace;
    return { ...workspace, root: worktree.root };
  }

  function workspaceForTool(server: McpServer, workspaces: WorkspaceManager, workspaceId?: string): Workspace {
    return effectiveWorkspaceForServer(server, workspaces.getWorkspace(workspaceId));
  }

  function workspaceTaskContextForServer(server: McpServer, workspace: Workspace): WorkspaceTaskContext | undefined {
    const profileId = repoTaskGateProfileByServer.get(server as object) || "";
    const active = profileId ? activeRepoTaskByProfile.get(profileId) : activeRepoTaskByServer.get(server as object);
    if (!active) return undefined;
    const worktree = repoTaskWorktree(active);
    const coordinationRoot = repoTaskCoordinationRoot(active);
    const matchesCoordination = sameResolvedRoot(coordinationRoot, workspace.root);
    const matchesExecution = sameResolvedRoot(active.root, workspace.root);
    const matchesWorktree = Boolean(worktree.root && sameResolvedRoot(worktree.root, workspace.root));
    if (!matchesCoordination && !matchesExecution && !matchesWorktree) return undefined;
    return {
      taskId: active.taskId,
      workerId: profileId || `direct.${active.taskId}`,
      title: active.taskTitle,
      root: coordinationRoot,
      ...(worktree.root ? { worktreeRoot: worktree.root } : {})
    };
  }

  return {
    configureServer,
    profileIdForServer,
    setProfileIdForServer,
    resolveWorkerJobProfileIdForServer,
    sameResolvedRoot,
    expectedRepoTask,
    expectedRepoTaskOwner,
    rememberExpectedRepoTask,
    repoTaskRootMatches,
    sameRepoTask,
    activeRepoTaskForProfile,
    setActiveRepoTaskForProfile,
    clearActiveRepoTaskForProfile,
    activeRepoTaskForServer,
    setActiveRepoTaskForServer,
    clearActiveRepoTaskForServer,
    assertRepoTaskGate,
    assertTaskChecklistReady,
    repoTaskCoordinationRoot,
    repoTaskWorktree,
    effectiveWorkspaceForServer,
    workspaceForTool,
    workspaceTaskContextForServer
  };
}
