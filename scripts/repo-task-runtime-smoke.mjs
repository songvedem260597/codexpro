import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexProError } from "../dist/guard.js";
import { createRepoTaskRuntime } from "../dist/repoTaskRuntime.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-repo-task-runtime-"));
const repoRoot = path.join(tempRoot, "repo");
const worktreeRoot = path.join(tempRoot, "worktree");
fs.mkdirSync(repoRoot, { recursive: true });
fs.mkdirSync(worktreeRoot, { recursive: true });

const jobs = new Map();
let rules = { path: "C:/fixture/.codexpro/CODEXPRO.md", text: "rules", sha256: "rules-v1", source: "file" };
const coordination = new Map();
const runtime = createRepoTaskRuntime({
  readWorkerJob: (taskId) => jobs.get(taskId),
  readGlobalRulesSnapshotSync: () => rules,
  readWorkspaceCoordination: (root) => coordination.get(root) ?? { tasks: {} }
});

const serverA = {};
const serverB = {};
const selectedRootsA = [];
const selectedRootsB = [];
runtime.configureServer(serverA, {
  requireRepoTask: true,
  profileId: "profile-a",
  workspaceSelector: (root) => {
    selectedRootsA.push(root);
    return { id: "ws-a", root, openedAt: "2026-01-01T00:00:00.000Z" };
  }
});
runtime.configureServer(serverB, {
  requireRepoTask: true,
  profileId: "profile-b",
  workspaceSelector: (root) => {
    selectedRootsB.push(root);
    return { id: "ws-b", root, openedAt: "2026-01-01T00:00:00.000Z" };
  }
});
assert.equal(runtime.profileIdForServer(serverA), "profile-a");
assert.equal(runtime.profileIdForServer(serverB), "profile-b");

const expectedA = runtime.rememberExpectedRepoTask("profile-a", {
  taskId: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa",
  root: repoRoot,
  scope: "workspace"
});
assert.equal(expectedA.taskId, "cpt_aaaaaaaaaaaaaaaaaaaaaaaa");
assert.equal(expectedA.root, repoRoot);
assert.equal(expectedA.scope, "workspace");
assert.equal(typeof expectedA.preparedAt, "number");

const activeA = {
  taskId: expectedA.taskId,
  taskTitle: "Test Repo Runtime Gate",
  root: repoRoot,
  workspaceId: "ws-a",
  scope: "workspace",
  globalRulesSha256: "rules-v1"
};
runtime.setActiveRepoTaskForProfile("profile-a", activeA);
runtime.assertRepoTaskGate(serverA, "read");
assert.deepEqual(selectedRootsA, [repoRoot], "passing a profile gate must restore the session workspace binding");
assert.equal(runtime.activeRepoTaskForServer(serverA), activeA);
assert.equal(runtime.activeRepoTaskForServer(serverB), undefined, "profile/server state must remain isolated");

const expectedB = runtime.rememberExpectedRepoTask("profile-b", {
  taskId: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb",
  root: repoRoot,
  scope: "workspace"
});
const activeB = {
  taskId: expectedB.taskId,
  taskTitle: "Second Profile Runtime Gate",
  root: repoRoot,
  workspaceId: "ws-b",
  scope: "workspace",
  globalRulesSha256: "rules-v1"
};
runtime.setActiveRepoTaskForProfile("profile-b", activeB);
runtime.assertRepoTaskGate(serverB, "search");
assert.equal(runtime.activeRepoTaskForServer(serverA), activeA);
assert.equal(runtime.activeRepoTaskForServer(serverB), activeB);
assert.deepEqual(selectedRootsB, [repoRoot]);

runtime.rememberExpectedRepoTask("profile-a", {
  taskId: "cpt_cccccccccccccccccccccccc",
  root: repoRoot,
  scope: "workspace"
});
assert.equal(runtime.activeRepoTaskForProfile("profile-a"), undefined, "preparing a new task must invalidate the profile active task");
assert.throws(
  () => runtime.assertRepoTaskGate(serverA, "read"),
  (error) => error instanceof CodexProError
    && error.code === "BEGIN_REPO_TASK_REQUIRED"
    && error.message === "BEGIN_REPO_TASK_REQUIRED: read is blocked until the current CodexPro Manager task is activated with begin_repo_task."
    && error.details?.tool === "read"
    && error.details?.profile_id === "profile-a"
    && error.details?.expected_task_id === "cpt_cccccccccccccccccccccccc"
    && error.details?.active_task_id === undefined
);
assert.doesNotThrow(() => runtime.assertRepoTaskGate(serverA, "begin_repo_task"), "gate-exempt lifecycle tools must remain available");

const expectedRules = runtime.expectedRepoTask("profile-a");
const staleRulesActive = {
  taskId: expectedRules.taskId,
  taskTitle: "Stale Rules Runtime Gate",
  root: repoRoot,
  workspaceId: "ws-a",
  scope: "workspace",
  globalRulesSha256: "rules-v1"
};
runtime.setActiveRepoTaskForProfile("profile-a", staleRulesActive);
rules = { ...rules, sha256: "rules-v2" };
assert.throws(
  () => runtime.assertRepoTaskGate(serverA, "write"),
  (error) => error instanceof CodexProError
    && error.code === "BEGIN_REPO_TASK_RULES_CHANGED"
    && error.details?.tool === "write"
    && error.details?.task_id === expectedRules.taskId
    && error.details?.previous_global_rules_sha256 === "rules-v1"
    && error.details?.current_global_rules_sha256 === "rules-v2"
    && error.details?.global_rules_path === rules.path
);
assert.equal(runtime.activeRepoTaskForProfile("profile-a"), undefined, "rules mismatch must fail closed and clear profile state");
rules = { ...rules, sha256: "rules-v1" };

const openRuntime = createRepoTaskRuntime({ readGlobalRulesSnapshotSync: () => rules });
const openServer = {};
openRuntime.configureServer(openServer, { requireRepoTask: false, workspaceSelector: (root) => ({ id: "open", root, openedAt: "" }) });
assert.doesNotThrow(() => openRuntime.assertRepoTaskGate(openServer, "read"));

assert.equal(runtime.repoTaskRootMatches("C:/any/allowed/root", {
  taskId: "cpt_dddddddddddddddddddddddd",
  scope: "all_allowed",
  preparedAt: Date.now()
}), true, "rootless all_allowed tasks must match any chosen allowed root");
assert.equal(runtime.sameRepoTask({
  taskId: "cpt_dddddddddddddddddddddddd",
  taskTitle: "All Allowed Runtime Task",
  root: "C:/chosen/root",
  workspaceId: "ws-any",
  scope: "all_allowed",
  globalRulesSha256: "rules-v1"
}, {
  taskId: "cpt_dddddddddddddddddddddddd",
  scope: "all_allowed",
  preparedAt: Date.now()
}), true);
if (process.platform === "win32") {
  assert.equal(runtime.sameResolvedRoot("C:\\Fixture\\Repo", "c:\\fixture\\repo"), true, "Windows root matching must remain case-insensitive");
}

const ownershipRuntime = createRepoTaskRuntime({
  readWorkerJob: (taskId) => taskId === "durable" ? { workerId: "browser:durable-profile" } : undefined
});
ownershipRuntime.setProfileIdForServer(serverA, "fallback-profile");
assert.equal(ownershipRuntime.resolveWorkerJobProfileIdForServer(serverA, "missing"), "fallback-profile");
assert.equal(ownershipRuntime.resolveWorkerJobProfileIdForServer(serverA, "durable"), "browser:durable-profile");
assert.equal(ownershipRuntime.profileIdForServer(serverA), "browser:durable-profile");
ownershipRuntime.rememberExpectedRepoTask("owner-a", { taskId: "same-task", root: repoRoot, scope: "workspace" });
assert.equal(ownershipRuntime.expectedRepoTaskOwner("same-task")?.profileId, "owner-a");
ownershipRuntime.rememberExpectedRepoTask("owner-b", { taskId: "same-task", root: repoRoot, scope: "workspace" });
assert.equal(ownershipRuntime.expectedRepoTaskOwner("same-task"), undefined, "ambiguous expected ownership must remain unresolved");

const retentionRuntime = createRepoTaskRuntime();
for (let index = 0; index <= 500; index += 1) {
  retentionRuntime.rememberExpectedRepoTask(`profile-${index}`, {
    taskId: `task-${index}`,
    root: repoRoot,
    scope: "workspace"
  });
}
assert.equal(retentionRuntime.expectedRepoTask("profile-0"), undefined);
assert.equal(retentionRuntime.expectedRepoTask("profile-100"), undefined);
assert.equal(retentionRuntime.expectedRepoTask("profile-101")?.taskId, "task-101", "501 entries must trim oldest 101 and retain 400");
assert.equal(retentionRuntime.expectedRepoTask("profile-500")?.taskId, "task-500");

const worktreeTask = {
  coordinationRoot: "coordination-root",
  taskId: "worktree-task",
  taskTitle: "Resolve Runtime Worktree",
  root: repoRoot,
  workspaceId: "ws-worktree",
  scope: "workspace",
  globalRulesSha256: "rules-v1"
};
coordination.set("coordination-root", {
  tasks: {
    "worktree-task": { worktreeRoot, worktreeBranch: "codexpro/task/worktree-task" }
  }
});
assert.deepEqual(runtime.repoTaskWorktree(worktreeTask), {
  root: worktreeRoot,
  branch: "codexpro/task/worktree-task"
});
assert.equal(worktreeTask.worktreeRoot, worktreeRoot, "coordination lookup must cache authoritative worktree root on active task");

const missingWorktree = {
  taskId: "missing-worktree-task",
  taskTitle: "Missing Runtime Worktree",
  root: repoRoot,
  workspaceId: "ws-missing",
  scope: "workspace",
  globalRulesSha256: "rules-v1",
  worktreeRoot: path.join(tempRoot, "does-not-exist")
};
assert.throws(
  () => runtime.repoTaskWorktree(missingWorktree),
  (error) => error instanceof CodexProError
    && error.code === "WORKSPACE_TASK_WORKTREE_MISSING"
    && error.details?.task_id === "missing-worktree-task"
    && error.details?.worktree_root === missingWorktree.worktreeRoot
    && error.details?.workspace_root === repoRoot
);

runtime.rememberExpectedRepoTask("profile-a", { taskId: worktreeTask.taskId, root: repoRoot, scope: "workspace" });
runtime.setActiveRepoTaskForProfile("profile-a", worktreeTask);
const repoWorkspace = { id: "ws-worktree", root: repoRoot, openedAt: "2026-01-01T00:00:00.000Z" };
const substituted = runtime.effectiveWorkspaceForServer(serverA, repoWorkspace);
assert.equal(substituted.root, worktreeRoot);
assert.equal(substituted.id, repoWorkspace.id);
assert.equal(repoWorkspace.root, repoRoot, "workspace substitution must not mutate the source workspace object");
const alreadyWorktree = { ...repoWorkspace, root: worktreeRoot };
assert.equal(runtime.effectiveWorkspaceForServer(serverA, alreadyWorktree), alreadyWorktree);
const unrelated = { ...repoWorkspace, root: path.join(tempRoot, "unrelated") };
assert.equal(runtime.effectiveWorkspaceForServer(serverA, unrelated), unrelated);
const manager = { getWorkspace: () => repoWorkspace };
assert.equal(runtime.workspaceForTool(serverA, manager).root, worktreeRoot);
assert.deepEqual(runtime.workspaceTaskContextForServer(serverA, repoWorkspace), {
  taskId: worktreeTask.taskId,
  workerId: "profile-a",
  title: worktreeTask.taskTitle,
  root: "coordination-root",
  worktreeRoot
});
assert.equal(runtime.workspaceTaskContextForServer(serverA, unrelated), undefined);

jobs.set(worktreeTask.taskId, { taskSize: "medium", checklist: [] });
assert.throws(
  () => runtime.assertTaskChecklistReady(serverA),
  (error) => error instanceof CodexProError
    && error.code === "TASK_CHECKLIST_REQUIRED"
    && error.details?.task_id === worktreeTask.taskId
    && error.details?.task_size === "medium"
);
jobs.set(worktreeTask.taskId, { taskSize: "medium", checklist: ["bounded step"] });
assert.doesNotThrow(() => runtime.assertTaskChecklistReady(serverA));

runtime.clearActiveRepoTaskForProfile("profile-a");
runtime.clearActiveRepoTaskForServer(serverA);
assert.equal(runtime.activeRepoTaskForServer(serverA), undefined);

console.log("repo-task-runtime smoke passed");

fs.rmSync(tempRoot, { recursive: true, force: true });
