import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-workspace-coordination-"));
const repoRoot = path.join(scratchRoot, "repo");
const remoteRoot = path.join(repoRoot, ".codexpro-test-remote.git");
process.env.CODEXPRO_HOME = path.join(scratchRoot, "codexpro-home");

const {
  acquireWorkspaceIntegrationLease,
  claimWorkspacePaths,
  finalizeWorkspaceTask,
  preflightWorkspaceGitAdd,
  preflightWorkspacePush,
  readWorkspaceCoordination,
  recordWorkspacePathsTouched,
  registerWorkspaceTask,
  releaseWorkspacePaths
} = await import(pathToFileURL(path.join(projectRoot, "dist", "workspaceCoordination.js")).href);
const { runBash } = await import(pathToFileURL(path.join(projectRoot, "dist", "bashOps.js")).href);

const TASK_A = { taskId: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa", workerId: "worker:a", title: "Agent A task", root: repoRoot };
const TASK_B = { taskId: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb", workerId: "worker:b", title: "Agent B task", root: repoRoot };
const TASK_C = { taskId: "cpt_cccccccccccccccccccccccc", workerId: "worker:c", title: "Conflict recovery task", root: repoRoot };
const TASK_D = { taskId: "cpt_dddddddddddddddddddddddd", workerId: "worker:d", title: "Dirty isolation task", root: repoRoot };
const TASK_E = { taskId: "cpt_eeeeeeeeeeeeeeeeeeeeeeee", workerId: "worker:e", title: "Reservation task", root: repoRoot };
const gitExecutable = process.platform === "win32" ? "git.exe" : "git";

function git(args, cwd = repoRoot) {
  return execFileSync(gitExecutable, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function taskContext(task, record) {
  return { ...task, worktreeRoot: record.worktreeRoot };
}

function workspaceFor(record, suffix) {
  return { id: `workspace-coordination-${suffix}`, root: record.worktreeRoot };
}

function guardFor(root) {
  return {
    resolve(_workspace, requestedPath) {
      assert.equal(requestedPath, ".");
      return { absPath: root, relPath: "." };
    }
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const config = {
  bashMode: "full",
  requireBashSession: false,
  inheritEnv: true,
  maxOutputBytes: 100_000,
  maxBashTimeoutMs: 180_000
};

async function runTask(task, record, command, timeoutMs = 30_000) {
  const workspace = workspaceFor(record, task.taskId.slice(-4));
  return await runBash(config, guardFor(record.worktreeRoot), workspace, command, {
    repoTask: taskContext(task, record),
    timeoutMs
  });
}

try {
  fs.mkdirSync(repoRoot, { recursive: true });
  git(["init"]);
  git(["config", "user.name", "CodexPro Coordination Smoke"]);
  git(["config", "user.email", "coordination-smoke@example.invalid"]);
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".codexpro-test-remote.git/\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "a.txt"), "a0\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "b.txt"), "b0\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "legacy.txt"), "legacy0\n", "utf8");
  git(["add", ".gitignore", "a.txt", "b.txt", "legacy.txt"]);
  git(["commit", "-m", "initial"]);
  git(["branch", "-M", "main"]);
  const initialHead = git(["rev-parse", "HEAD"]);

  git(["init", "--bare", remoteRoot]);
  git(["remote", "add", "origin", remoteRoot]);
  git(["push", "-u", "origin", "main"]);

  const registeredA = await registerWorkspaceTask(TASK_A);
  const registeredB = await registerWorkspaceTask(TASK_B);
  assert.equal(registeredA.baseHead, registeredB.baseHead, "parallel tasks should snapshot the same base HEAD");
  assert.equal(registeredA.baseHead, initialHead);
  assert.ok(registeredA.worktreeRoot && fs.existsSync(registeredA.worktreeRoot), "task A should receive a real worktree");
  assert.ok(registeredB.worktreeRoot && fs.existsSync(registeredB.worktreeRoot), "task B should receive a real worktree");
  assert.notEqual(registeredA.worktreeRoot, registeredB.worktreeRoot, "parallel tasks must use different worktrees");
  assert.notEqual(registeredA.worktreeBranch, registeredB.worktreeBranch, "parallel tasks must use different branches");
  assert.deepEqual(registeredA.initialDirtyPaths, [], "clean workspace should produce a clean initial dirty set");

  await claimWorkspacePaths(TASK_A, ["a.txt"]);
  await assert.rejects(
    claimWorkspacePaths(TASK_B, ["nested/../a.txt"]),
    /WORKSPACE_PATH_CONFLICT/,
    "path aliases must normalize to the same ownership key"
  );
  await claimWorkspacePaths(TASK_B, ["b.txt"]);

  const releaseAQueue = await acquireWorkspaceIntegrationLease(TASK_A);
  let bLeaseAcquired = false;
  const pendingBLease = acquireWorkspaceIntegrationLease(TASK_B).then((release) => {
    bLeaseAcquired = true;
    return release;
  });
  await delay(120);
  assert.equal(bLeaseAcquired, false, "a later integration request must wait behind the active lease");
  const queuedState = readWorkspaceCoordination(repoRoot);
  assert.equal(queuedState.integrationQueue[0]?.taskId, TASK_B.taskId, "integration requests should queue FIFO");
  await releaseAQueue();
  const releaseBQueue = await pendingBLease;
  assert.equal(readWorkspaceCoordination(repoRoot).integrationLease?.taskId, TASK_B.taskId, "the next queued task should acquire the lease");
  await releaseBQueue();

  fs.writeFileSync(path.join(registeredA.worktreeRoot, "a.txt"), "a1 from agent A\n", "utf8");
  fs.writeFileSync(path.join(registeredB.worktreeRoot, "b.txt"), "b1 from agent B\n", "utf8");
  await recordWorkspacePathsTouched(TASK_A, ["a.txt"]);
  await recordWorkspacePathsTouched(TASK_B, ["b.txt"]);

  await assert.rejects(
    preflightWorkspaceGitAdd(taskContext(TASK_A, registeredA), registeredA.worktreeRoot, ["b.txt"]),
    /WORKSPACE_GIT_ADD_NOT_OWNED|WORKSPACE_GIT_ADD_CONFLICT/,
    "a task must not stage another task's file"
  );

  const [addA, addB] = await Promise.all([
    runTask(TASK_A, registeredA, "git add a.txt"),
    runTask(TASK_B, registeredB, "git add b.txt")
  ]);
  assert.equal(addA.exitCode, 0, "task A should stage in its own index");
  assert.equal(addB.exitCode, 0, "task B should stage in its own index concurrently");

  const [commitA, commitB] = await Promise.all([
    runTask(TASK_A, registeredA, 'git commit -m "agent A change"'),
    runTask(TASK_B, registeredB, 'git commit -m "agent B change"')
  ]);
  assert.equal(commitA.exitCode, 0, "task A should commit in its own branch");
  assert.equal(commitB.exitCode, 0, "task B should commit in its own branch");
  const aCommit = git(["rev-parse", "HEAD"], registeredA.worktreeRoot);
  const bCommitBeforeIntegration = git(["rev-parse", "HEAD"], registeredB.worktreeRoot);
  assert.match(git(["log", "-1", "--format=%B"], registeredA.worktreeRoot), new RegExp(`CodexPro-Task: ${TASK_A.taskId}`));
  assert.match(git(["log", "-1", "--format=%B"], registeredB.worktreeRoot), new RegExp(`CodexPro-Task: ${TASK_B.taskId}`));
  assert.equal(git(["rev-parse", "HEAD"]), initialHead, "task commits must not move the shared checkout HEAD");

  await assert.rejects(
    runTask(TASK_A, registeredA, 'node -e "require(\'node:fs\').writeFileSync(\'a.txt\',\'bypass\')"'),
    /WORKSPACE_SOURCE_MUTATION_BLOCKED/,
    "profile-bound code tasks must not bypass file ownership with shell source writes"
  );
  await assert.rejects(
    runTask(TASK_A, registeredA, "git reset --hard HEAD~1"),
    /WORKSPACE_GIT_WRITE_SHAPE_BLOCKED/,
    "destructive Git writes must remain blocked inside task worktrees"
  );

  const pushA = await runTask(TASK_A, registeredA, "git push origin main", 60_000);
  assert.equal(pushA.exitCode, 0, "the first task should integrate to the target branch");
  const pushB = await runTask(TASK_B, registeredB, "git push origin main", 60_000);
  assert.equal(pushB.exitCode, 0, "a disjoint second task should rebase and integrate automatically");
  const bCommitAfterIntegration = git(["rev-parse", "HEAD"], registeredB.worktreeRoot);
  assert.notEqual(bCommitAfterIntegration, bCommitBeforeIntegration, "remote advancement should rebase the second task onto the integrated head");
  assert.match(git(["log", "-1", "--format=%B"], registeredB.worktreeRoot), new RegExp(`CodexPro-Task: ${TASK_B.taskId}`), "rebased commits must preserve provenance");

  const integratedState = readWorkspaceCoordination(repoRoot);
  assert.equal(integratedState.tasks[TASK_A.taskId].integrationStatus, "integrated");
  assert.equal(integratedState.tasks[TASK_B.taskId].integrationStatus, "integrated");
  assert.equal(integratedState.tasks[TASK_A.taskId].integratedHead, aCommit);
  assert.equal(integratedState.tasks[TASK_B.taskId].integratedHead, bCommitAfterIntegration);
  assert.equal(git(["--git-dir", remoteRoot, "show", "refs/heads/main:a.txt"]), "a1 from agent A");
  assert.equal(git(["--git-dir", remoteRoot, "show", "refs/heads/main:b.txt"]), "b1 from agent B");
  assert.equal(git(["rev-parse", "HEAD"]), initialHead, "integration should not mutate the shared checkout branch");

  const aWorktreeRoot = registeredA.worktreeRoot;
  const bWorktreeRoot = registeredB.worktreeRoot;
  await finalizeWorkspaceTask(TASK_A, "completed");
  await finalizeWorkspaceTask(TASK_B, "completed");
  assert.equal(fs.existsSync(aWorktreeRoot), false, "clean integrated task A worktree should be removed on completion");
  assert.equal(fs.existsSync(bWorktreeRoot), false, "clean integrated task B worktree should be removed on completion");

  git(["fetch", "origin", "main"]);
  git(["reset", "--hard", "origin/main"]);
  const registeredC = await registerWorkspaceTask(TASK_C);
  await claimWorkspacePaths(TASK_C, ["a.txt"]);
  fs.writeFileSync(path.join(registeredC.worktreeRoot, "a.txt"), "a2 from task C\n", "utf8");
  await recordWorkspacePathsTouched(TASK_C, ["a.txt"]);
  assert.equal((await runTask(TASK_C, registeredC, "git add a.txt")).exitCode, 0);
  assert.equal((await runTask(TASK_C, registeredC, 'git commit -m "task C local conflict"')).exitCode, 0);

  fs.writeFileSync(path.join(repoRoot, "a.txt"), "a2 external main change\n", "utf8");
  git(["add", "a.txt"]);
  git(["commit", "-m", "external conflicting change"]);
  git(["push", "origin", "main"]);
  await assert.rejects(
    runTask(TASK_C, registeredC, "git push origin main", 60_000),
    /WORKSPACE_INTEGRATION_CONFLICT/,
    "overlapping remote changes must fail fast instead of silently rebasing"
  );
  assert.equal(readWorkspaceCoordination(repoRoot).tasks[TASK_C.taskId].integrationStatus, "conflict");
  const cWorktreeRoot = registeredC.worktreeRoot;
  await finalizeWorkspaceTask(TASK_C, "cancelled");
  assert.equal(fs.existsSync(cWorktreeRoot), true, "conflicted worktrees should be preserved for recovery");

  fs.writeFileSync(path.join(repoRoot, "legacy.txt"), "dirty before task D\n", "utf8");
  const registeredD = await registerWorkspaceTask(TASK_D);
  assert.deepEqual(registeredD.initialDirtyPaths, ["legacy.txt"], "task metadata should remember dirty files in the shared checkout");
  assert.equal(fs.readFileSync(path.join(registeredD.worktreeRoot, "legacy.txt"), "utf8").replace(/\r\n/g, "\n"), "legacy0\n", "task worktrees must start from committed HEAD, not shared uncommitted content");
  await claimWorkspacePaths(TASK_D, ["legacy.txt"]);
  fs.writeFileSync(path.join(registeredD.worktreeRoot, "legacy.txt"), "isolated task D change\n", "utf8");
  await recordWorkspacePathsTouched(TASK_D, ["legacy.txt"]);
  assert.equal((await runTask(TASK_D, registeredD, "git add legacy.txt")).exitCode, 0);
  assert.equal((await runTask(TASK_D, registeredD, 'git commit -m "task D isolated dirty file"')).exitCode, 0, "a worktree task may safely edit a path that is dirty only in the shared checkout");
  assert.equal(fs.readFileSync(path.join(repoRoot, "legacy.txt"), "utf8"), "dirty before task D\n", "task D must not overwrite the shared dirty file");
  await finalizeWorkspaceTask(TASK_D, "cancelled");

  const registeredE = await registerWorkspaceTask(TASK_E);
  await claimWorkspacePaths(TASK_E, ["legacy.txt"]);
  await assert.rejects(
    preflightWorkspaceGitAdd(taskContext(TASK_E, registeredE), registeredE.worktreeRoot, ["legacy.txt"]),
    /WORKSPACE_GIT_ADD_NOT_OWNED/,
    "reserving a file without a successful mutation must not make it committable"
  );
  await releaseWorkspacePaths(TASK_E, ["legacy.txt"], { onlyUntouched: true });
  await assert.rejects(
    preflightWorkspacePush(taskContext(TASK_E, registeredE), "main"),
    /WORKSPACE_PUSH_HEAD_NOT_OWNED/,
    "a task with no task-owned commit must not integrate the base HEAD"
  );
  await finalizeWorkspaceTask(TASK_E, "cancelled");

  const afterFinalize = readWorkspaceCoordination(repoRoot);
  assert.equal(Object.keys(afterFinalize.claims).length, 0, "terminal tasks must release all path claims");
  assert.equal(afterFinalize.integrationQueue.length, 0, "terminal tasks must leave no queued integrations");
  assert.equal(afterFinalize.integrationLease, undefined, "terminal tasks must release the integration lease");

  console.log("workspace coordination smoke passed");
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
