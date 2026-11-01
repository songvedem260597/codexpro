import fs from "node:fs";
import path from "node:path";
import { CodexProError } from "./guard.js";
import { CODEXPRO_GLOBAL_RULES_FILE, readGlobalRulesSnapshotSync as defaultReadGlobalRulesSnapshotSync } from "./globalRules.js";
import { readWorkerJob as defaultReadWorkerJob } from "./workerPolicy.js";
import { readWorkspaceCoordination as defaultReadWorkspaceCoordination } from "./workspaceCoordination.js";
const REPO_TASK_GATE_EXEMPT_TOOLS = new Set([
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
export function createRepoTaskRuntime(hooks = {}) {
    const readWorkerJob = hooks.readWorkerJob ?? defaultReadWorkerJob;
    const readGlobalRulesSnapshotSync = hooks.readGlobalRulesSnapshotSync ?? defaultReadGlobalRulesSnapshotSync;
    const readWorkspaceCoordination = hooks.readWorkspaceCoordination ?? defaultReadWorkspaceCoordination;
    const repoTaskGateRequiredByServer = new WeakMap();
    const repoTaskGateProfileByServer = new WeakMap();
    const activeRepoTaskByServer = new WeakMap();
    const activeRepoTaskByProfile = new Map();
    const repoTaskWorkspaceSelectorByServer = new WeakMap();
    const expectedRepoTaskByProfile = new Map();
    function configureServer(server, options) {
        repoTaskWorkspaceSelectorByServer.set(server, options.workspaceSelector);
        repoTaskGateRequiredByServer.set(server, options.requireRepoTask);
        if (options.profileId)
            repoTaskGateProfileByServer.set(server, options.profileId);
    }
    function profileIdForServer(server) {
        return repoTaskGateProfileByServer.get(server) || "";
    }
    function setProfileIdForServer(server, profileId) {
        repoTaskGateProfileByServer.set(server, profileId);
    }
    function resolveWorkerJobProfileIdForServer(server, taskId) {
        const durableWorkerId = String(readWorkerJob(taskId)?.workerId || "").trim();
        if (durableWorkerId) {
            repoTaskGateProfileByServer.set(server, durableWorkerId);
            return durableWorkerId;
        }
        return repoTaskGateProfileByServer.get(server) || "";
    }
    function sameResolvedRoot(left, right) {
        const resolvedLeft = path.resolve(left);
        const resolvedRight = path.resolve(right);
        return process.platform === "win32"
            ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
            : resolvedLeft === resolvedRight;
    }
    function expectedRepoTask(profileId) {
        return expectedRepoTaskByProfile.get(profileId);
    }
    function expectedRepoTaskOwner(taskId) {
        let owner;
        for (const [profileId, expected] of expectedRepoTaskByProfile) {
            if (expected.taskId !== taskId)
                continue;
            if (owner)
                return undefined;
            owner = { profileId, expected };
        }
        return owner;
    }
    function rememberExpectedRepoTask(profileId, expected) {
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
    function repoTaskRootMatches(leftRoot, right) {
        if (right.scope === "all_allowed" && !right.root)
            return true;
        return Boolean(right.root && sameResolvedRoot(leftRoot, right.root));
    }
    function sameRepoTask(left, right) {
        return Boolean(left
            && right
            && left.taskId === right.taskId
            && left.scope === right.scope
            && repoTaskRootMatches(left.root, right));
    }
    function activeRepoTaskForProfile(profileId) {
        return activeRepoTaskByProfile.get(profileId);
    }
    function setActiveRepoTaskForProfile(profileId, active) {
        activeRepoTaskByProfile.set(profileId, active);
    }
    function clearActiveRepoTaskForProfile(profileId) {
        activeRepoTaskByProfile.delete(profileId);
    }
    function activeRepoTaskForServer(server) {
        const profileId = repoTaskGateProfileByServer.get(server) || "";
        return profileId ? activeRepoTaskByProfile.get(profileId) : activeRepoTaskByServer.get(server);
    }
    function setActiveRepoTaskForServer(server, active) {
        activeRepoTaskByServer.set(server, active);
    }
    function clearActiveRepoTaskForServer(server) {
        activeRepoTaskByServer.delete(server);
    }
    function assertRepoTaskGate(server, name) {
        if (!repoTaskGateRequiredByServer.get(server) || REPO_TASK_GATE_EXEMPT_TOOLS.has(name))
            return;
        const profileId = repoTaskGateProfileByServer.get(server) || "";
        const expected = profileId ? expectedRepoTask(profileId) : undefined;
        const active = profileId ? activeRepoTaskByProfile.get(profileId) : activeRepoTaskByServer.get(server);
        if (!active || !sameRepoTask(active, expected)) {
            activeRepoTaskByServer.delete(server);
            if (profileId)
                activeRepoTaskByProfile.delete(profileId);
            throw new CodexProError(`BEGIN_REPO_TASK_REQUIRED: ${name} is blocked until the current CodexPro Manager task is activated with begin_repo_task.`, {
                code: "BEGIN_REPO_TASK_REQUIRED",
                details: {
                    tool: name,
                    profile_id: profileId || undefined,
                    expected_task_id: expected?.taskId,
                    active_task_id: active?.taskId
                }
            });
        }
        const latestRules = readGlobalRulesSnapshotSync();
        if (latestRules.sha256 !== active.globalRulesSha256) {
            activeRepoTaskByServer.delete(server);
            if (profileId)
                activeRepoTaskByProfile.delete(profileId);
            throw new CodexProError(`BEGIN_REPO_TASK_RULES_CHANGED: ${CODEXPRO_GLOBAL_RULES_FILE} changed after task ${active.taskId} began. Call begin_repo_task again before using ${name}.`, {
                code: "BEGIN_REPO_TASK_RULES_CHANGED",
                details: {
                    tool: name,
                    task_id: active.taskId,
                    previous_global_rules_sha256: active.globalRulesSha256,
                    current_global_rules_sha256: latestRules.sha256,
                    global_rules_path: latestRules.path
                }
            });
        }
        const sessionActive = activeRepoTaskByServer.get(server);
        if (!sameRepoTask(sessionActive, active) || sessionActive?.globalRulesSha256 !== active.globalRulesSha256) {
            repoTaskWorkspaceSelectorByServer.get(server)?.(active.root);
            activeRepoTaskByServer.set(server, active);
        }
    }
    function assertTaskChecklistReady(server) {
        const active = activeRepoTaskForServer(server);
        if (!active)
            return;
        const job = readWorkerJob(active.taskId);
        if (!job || !["medium", "large"].includes(String(job.taskSize)) || job.checklist.length)
            return;
        throw new CodexProError("TASK_CHECKLIST_REQUIRED: Report a complete durable checklist with report_worker_job_progress before modifying source for a medium or large task.", { code: "TASK_CHECKLIST_REQUIRED", details: { task_id: active.taskId, task_size: job.taskSize } });
    }
    function repoTaskCoordinationRoot(active) {
        return active.coordinationRoot || active.root;
    }
    function repoTaskWorktree(active) {
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
    function effectiveWorkspaceForServer(server, workspace) {
        const active = activeRepoTaskForServer(server);
        if (!active)
            return workspace;
        const worktree = repoTaskWorktree(active);
        if (!worktree.root)
            return workspace;
        if (sameResolvedRoot(workspace.root, worktree.root))
            return workspace;
        if (!sameResolvedRoot(workspace.root, active.root))
            return workspace;
        return { ...workspace, root: worktree.root };
    }
    function workspaceForTool(server, workspaces, workspaceId) {
        return effectiveWorkspaceForServer(server, workspaces.getWorkspace(workspaceId));
    }
    function workspaceTaskContextForServer(server, workspace) {
        const profileId = repoTaskGateProfileByServer.get(server) || "";
        const active = profileId ? activeRepoTaskByProfile.get(profileId) : activeRepoTaskByServer.get(server);
        if (!active)
            return undefined;
        const worktree = repoTaskWorktree(active);
        const coordinationRoot = repoTaskCoordinationRoot(active);
        const matchesCoordination = sameResolvedRoot(coordinationRoot, workspace.root);
        const matchesExecution = sameResolvedRoot(active.root, workspace.root);
        const matchesWorktree = Boolean(worktree.root && sameResolvedRoot(worktree.root, workspace.root));
        if (!matchesCoordination && !matchesExecution && !matchesWorktree)
            return undefined;
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
//# sourceMappingURL=repoTaskRuntime.js.map