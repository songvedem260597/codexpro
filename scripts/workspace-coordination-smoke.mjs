import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-workspace-coordination-"));
const repoRoot = path.join(scratchRoot, "repo");
process.env.CODEXPRO_HOME = path.join(scratchRoot, "codexpro-home");

const {
  acquireWorkspaceIntegrationLease,
  claimWorkspacePaths,
  finalizeWorkspaceTask,
  preflightWorkspaceCommit,
  preflightWorkspaceGitAdd,
  preflightWorkspacePush,
  readWorkspaceCoordination,
  recordWorkspaceCommit,
  recordWorkspacePathsTouched,
  registerWorkspaceTask,
  releaseWorkspacePaths
} = await import(pathToFileURL(path.join(projectRoot, "dist", "workspaceCoordination.js")).href);
const { runBash } = await import(pathToFileURL(path.join(projectRoot, "dist", "bashOps.js")).href);

const TASK_A = { taskId: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa", workerId: "worker:a", title: "Agent A task", root: repoRoot };
const TASK_B = { taskId: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb", workerId: "worker:b", title: "Agent B task", root: repoRoot };
const TASK_C = { taskId: "cpt_cccccccccccccccccccccccc", workerId: "worker:c", title: "Provenance task", root: repoRoot };
const TASK_D = { taskId: "cpt_dddddddddddddddddddddddd", workerId: "worker:d", title: "Dirty baseline task", root: repoRoot };
const TASK_E = { taskId: "cpt_eeeeeeeeeeeeeeeeeeeeeeee", workerId: "worker:e", title: "Reservation task", root: repoRoot };

function git(args) {
  return execFileSync(process.platform === "win32" ? "git.exe" : "git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

try {
  fs.mkdirSync(repoRoot, { recursive: true });
  git(["init"]);
  git(["config", "user.name", "CodexPro Coordination Smoke"]);
  git(["config", "user.email", "coordination-smoke@example.invalid"]);
  fs.writeFileSync(path.join(repoRoot, "a.txt"), "a0\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "b.txt"), "b0\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "legacy.txt"), "legacy0\n", "utf8");
  git(["add", "a.txt", "b.txt", "legacy.txt"]);
  git(["commit", "-m", "initial"]);
  git(["branch", "-M", "main"]);

  const registeredA = await registerWorkspaceTask(TASK_A);
  const registeredB = await registerWorkspaceTask(TASK_B);
  assert.equal(registeredA.baseHead, registeredB.baseHead, "parallel tasks should snapshot the same clean base HEAD");
  assert.deepEqual(registeredA.initialDirtyPaths, [], "clean workspace should produce a clean initial dirty set");

  await claimWorkspacePaths(TASK_A, ["a.txt"]);
  await assert.rejects(
    claimWorkspacePaths(TASK_B, ["nested/../a.txt"]),
    /WORKSPACE_PATH_CONFLICT/,
    "path aliases must normalize to the same ownership key"
  );
  await assert.rejects(
    claimWorkspacePaths(TASK_B, ["a.txt"]),
    /WORKSPACE_PATH_CONFLICT/,
    "a second active task must not claim the same file"
  );
  await claimWorkspacePaths(TASK_B, ["b.txt"]);

  const leaseRelease = await acquireWorkspaceIntegrationLease(TASK_A);
  await assert.rejects(
    acquireWorkspaceIntegrationLease(TASK_B),
    /WORKSPACE_INTEGRATION_BUSY/,
    "only one task may hold the workspace integration lease"
  );
  await leaseRelease();

  fs.writeFileSync(path.join(repoRoot, "a.txt"), "a1 from agent A\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "b.txt"), "b1 from agent B\n", "utf8");
  await recordWorkspacePathsTouched(TASK_A, ["a.txt"]);
  await recordWorkspacePathsTouched(TASK_B, ["b.txt"]);

  await preflightWorkspaceGitAdd(TASK_A, repoRoot, ["a.txt"]);
  await assert.rejects(
    preflightWorkspaceGitAdd(TASK_A, repoRoot, ["b.txt"]),
    /WORKSPACE_GIT_ADD_NOT_OWNED|WORKSPACE_GIT_ADD_CONFLICT/,
    "a task must not stage another task's file"
  );

  git(["add", "a.txt"]);
  await assert.rejects(
    preflightWorkspaceGitAdd(TASK_B, repoRoot, ["b.txt"]),
    /WORKSPACE_GIT_INDEX_BUSY/,
    "a second task must not add into an index already staged by another task"
  );
  git(["add", "b.txt"]);
  await assert.rejects(
    preflightWorkspaceCommit(TASK_A),
    /WORKSPACE_COMMIT_NOT_OWNED|WORKSPACE_COMMIT_CONFLICT/,
    "a commit containing another task's staged file must be rejected"
  );
  git(["restore", "--staged", "b.txt"]);
  await preflightWorkspaceCommit(TASK_A);
  git(["commit", "-m", "agent A change", "-m", `CodexPro-Task: ${TASK_A.taskId}`]);
  const aCommit = await recordWorkspaceCommit(TASK_A);
  assert.equal(aCommit, git(["rev-parse", "HEAD"]));

  git(["add", "b.txt"]);
  await preflightWorkspaceCommit(TASK_B);
  git(["commit", "-m", "agent B disjoint change", "-m", `CodexPro-Task: ${TASK_B.taskId}`]);
  await recordWorkspaceCommit(TASK_B);

  await assert.rejects(
    claimWorkspacePaths(TASK_B, ["a.txt"]),
    /WORKSPACE_STALE_BASE_CONFLICT|WORKSPACE_PATH_CONFLICT/,
    "a task based on an older HEAD must not silently take over a path changed by another task"
  );

  const config = {
    bashMode: "full",
    requireBashSession: false,
    inheritEnv: true,
    maxOutputBytes: 100_000
  };
  const workspace = { id: "workspace-coordination-smoke", root: repoRoot };
  const guard = {
    resolve(_workspace, requestedPath) {
      assert.equal(requestedPath, ".");
      return { absPath: repoRoot, relPath: "." };
    }
  };
  await assert.rejects(
    runBash(config, guard, workspace, 'node -e "require(\'node:fs\').writeFileSync(\'a.txt\',\'bypass\')"', { repoTask: TASK_A }),
    /WORKSPACE_SOURCE_MUTATION_BLOCKED/,
    "profile-bound code tasks must not bypass file ownership with shell source writes"
  );
  await assert.rejects(
    runBash(config, guard, workspace, "git reset --hard HEAD~1", { repoTask: TASK_A }),
    /WORKSPACE_GIT_WRITE_SHAPE_BLOCKED/,
    "destructive Git writes must be blocked for coordinated tasks"
  );

  await registerWorkspaceTask(TASK_C);
  fs.writeFileSync(path.join(repoRoot, "provenance.txt"), "owned by task C\n", "utf8");
  await claimWorkspacePaths(TASK_C, ["provenance.txt"]);
  await recordWorkspacePathsTouched(TASK_C, ["provenance.txt"]);
  const addC = await runBash(config, guard, workspace, "git add provenance.txt", { repoTask: TASK_C });
  assert.equal(addC.exitCode, 0, "coordinated explicit git add should succeed for an owned file");
  const commitC = await runBash(config, guard, workspace, 'git commit -m "agent C provenance"', { repoTask: TASK_C });
  assert.equal(commitC.exitCode, 0, "coordinated commit should succeed for task-owned staged changes");
  const cHead = git(["rev-parse", "HEAD"]);
  const cMessage = git(["log", "-1", "--format=%B"]);
  assert.match(cMessage, new RegExp(`CodexPro-Task: ${TASK_C.taskId}`), "coordinated commits must carry task provenance");
  const afterCommitC = readWorkspaceCoordination(repoRoot);
  assert.ok(afterCommitC.tasks[TASK_C.taskId].commitShas.includes(cHead), "successful coordinated commits must be recorded for the task");
  await preflightWorkspacePush(TASK_C, "main");

  await registerWorkspaceTask(TASK_E);
  await assert.rejects(
    preflightWorkspacePush(TASK_E, "main"),
    /WORKSPACE_PUSH_HEAD_NOT_OWNED/,
    "a task must not push a HEAD committed by another task"
  );
  await claimWorkspacePaths(TASK_E, ["legacy.txt"]);
  await assert.rejects(
    preflightWorkspaceGitAdd(TASK_E, repoRoot, ["legacy.txt"]),
    /WORKSPACE_GIT_ADD_NOT_OWNED/,
    "reserving a file without a successful mutation must not make it committable"
  );
  await releaseWorkspacePaths(TASK_E, ["legacy.txt"], { onlyUntouched: true });
  const afterReleaseE = readWorkspaceCoordination(repoRoot);
  assert.equal(
    Object.values(afterReleaseE.claims).some((claim) => claim.taskId === TASK_E.taskId),
    false,
    "failed or no-op mutations must be able to release untouched reservations"
  );

  await finalizeWorkspaceTask(TASK_A, "completed");
  await finalizeWorkspaceTask(TASK_B, "completed");
  await finalizeWorkspaceTask(TASK_C, "completed");
  await finalizeWorkspaceTask(TASK_E, "cancelled");
  const afterFinalize = readWorkspaceCoordination(repoRoot);
  assert.equal(Object.keys(afterFinalize.claims).length, 0, "terminal tasks must release all path claims");
  assert.equal(afterFinalize.integrationLease, undefined, "terminal tasks must release the integration lease");

  fs.writeFileSync(path.join(repoRoot, "legacy.txt"), "dirty before task D\n", "utf8");
  const registeredD = await registerWorkspaceTask(TASK_D);
  assert.deepEqual(registeredD.initialDirtyPaths, ["legacy.txt"], "task baseline must remember pre-existing dirty files");
  await claimWorkspacePaths(TASK_D, ["legacy.txt"]);
  fs.writeFileSync(path.join(repoRoot, "legacy.txt"), "dirty before task D\nupdated by task D\n", "utf8");
  await recordWorkspacePathsTouched(TASK_D, ["legacy.txt"]);
  git(["add", "legacy.txt"]);
  await assert.rejects(
    preflightWorkspaceCommit(TASK_D),
    /WORKSPACE_COMMIT_PREEXISTING_DIRTY/,
    "a task must not absorb a file that was already dirty when it started"
  );
  await finalizeWorkspaceTask(TASK_D, "cancelled");

  console.log("workspace coordination smoke passed");
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
