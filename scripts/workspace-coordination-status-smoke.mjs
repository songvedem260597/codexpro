import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-coordination-status-"));
const repoRoot = path.join(scratchRoot, "repo");
process.env.CODEXPRO_HOME = path.join(scratchRoot, "home");

const {
  acquireWorkspaceIntegrationLease,
  claimWorkspacePaths,
  finalizeWorkspaceTask,
  readWorkspaceCoordination,
  readWorkspaceCoordinationStatus,
  readWorkspaceTaskCoordinationStatus,
  registerWorkspaceTask
} = await import(pathToFileURL(path.join(projectRoot, "dist", "workspaceCoordination.js")).href);

const TARGET = { taskId: "cpt_111111111111111111111111", workerId: "worker:target", title: "Target delivery task", root: repoRoot };
const FOREIGN = { taskId: "cpt_222222222222222222222222", workerId: "worker:foreign", title: "Foreign owner task", root: repoRoot };
const QUEUED = { taskId: "cpt_333333333333333333333333", workerId: "worker:queued", title: "Queued delivery task", root: repoRoot };
const UNKNOWN_TASK_ID = "cpt_999999999999999999999999";
const gitExecutable = process.platform === "win32" ? "git.exe" : "git";
const git = (args, cwd = repoRoot) => execFileSync(gitExecutable, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, message, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

function coordinationStatePath() {
  const dir = path.join(process.env.CODEXPRO_HOME, "workspace-coordination");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 1, "smoke fixture should have exactly one coordination state file");
  return path.join(dir, files[0]);
}

function mutateCoordinationState(mutator) {
  const file = coordinationStatePath();
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  mutator(state);
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

try {
  fs.mkdirSync(repoRoot, { recursive: true });
  git(["init"]);
  git(["config", "user.name", "CodexPro Status Smoke"]);
  git(["config", "user.email", "status-smoke@example.invalid"]);
  fs.writeFileSync(path.join(repoRoot, "a.txt"), "a0\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "b.txt"), "b0\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "c.txt"), "c0\n", "utf8");
  git(["add", "a.txt", "b.txt", "c.txt"]);
  git(["commit", "-m", "initial"]);
  git(["branch", "-M", "main"]);

  const targetRecord = await registerWorkspaceTask(TARGET);
  await registerWorkspaceTask(FOREIGN);
  await registerWorkspaceTask(QUEUED);
  await claimWorkspacePaths(TARGET, ["a.txt"]);

  // Case A: one active task with no blocker is delivery-safe.
  const safe = await readWorkspaceTaskCoordinationStatus(repoRoot, TARGET.taskId);
  assert.equal(safe.found, true);
  assert.equal(safe.task_status, "running");
  assert.equal(safe.task_worker_id, TARGET.workerId);
  assert.equal(safe.task_title, TARGET.title);
  assert.deepEqual(safe.task_claimed_paths, ["a.txt"]);
  assert.deepEqual(safe.task_touched_paths, []);
  assert.equal(safe.task_worktree_root, targetRecord.worktreeRoot);
  assert.equal(safe.task_worktree_branch, targetRecord.worktreeBranch);
  assert.equal(safe.safe_for_delivery, true, "uncontended active task must be delivery-safe");
  assert.deepEqual(safe.blocking_reasons, []);
  const overview = await readWorkspaceCoordinationStatus(repoRoot);
  assert.ok(Array.isArray(overview.tasks) && overview.tasks.length >= 3, "root-only status must preserve the existing workspace overview contract");
  assert.ok(Array.isArray(overview.claims), "root-only status must preserve full claim overview");

  // Case B: an authoritative foreign claim on a target-owned path blocks delivery.
  mutateCoordinationState((state) => {
    state.claims["a.txt"].taskId = FOREIGN.taskId;
    state.claims["a.txt"].updatedAt = new Date().toISOString();
  });
  const overlap = await readWorkspaceTaskCoordinationStatus(repoRoot, TARGET.taskId);
  assert.equal(overlap.safe_for_delivery, false);
  assert.deepEqual(overlap.foreign_claims, [{ path: "a.txt", task_id: FOREIGN.taskId, worker_id: FOREIGN.workerId }]);
  assert.deepEqual(overlap.overlapping_claims, [{ path: "a.txt", foreign_task_id: FOREIGN.taskId, foreign_worker_id: FOREIGN.workerId }]);
  assert.deepEqual(overlap.foreign_active_tasks, [{ task_id: FOREIGN.taskId, worker_id: FOREIGN.workerId, title: FOREIGN.title }]);
  assert.ok(overlap.blocking_reasons.some((reason) => reason.code === "FOREIGN_CLAIM_OVERLAP"));
  mutateCoordinationState((state) => {
    state.claims["a.txt"].taskId = TARGET.taskId;
    state.claims["a.txt"].updatedAt = new Date().toISOString();
  });
  mutateCoordinationState((state) => {
    delete state.claims["a.txt"];
  });
  const missingClaim = await readWorkspaceTaskCoordinationStatus(repoRoot, TARGET.taskId);
  assert.equal(missingClaim.safe_for_delivery, false, "missing authoritative claim evidence must fail closed");
  assert.deepEqual(missingClaim.missing_claims, ["a.txt"]);
  assert.ok(missingClaim.blocking_reasons.some((reason) => reason.code === "TASK_CLAIM_MISSING"));
  mutateCoordinationState((state) => {
    const now = new Date().toISOString();
    state.claims["a.txt"] = { taskId: TARGET.taskId, claimedAt: now, updatedAt: now };
  });

  // Case C: a foreign integration lease names its owner and blocks delivery.
  const releaseForeignLease = await acquireWorkspaceIntegrationLease(FOREIGN, "main");
  const leased = await readWorkspaceTaskCoordinationStatus(repoRoot, TARGET.taskId);
  assert.equal(leased.safe_for_delivery, false);
  assert.equal(leased.integration_lease?.task_id, FOREIGN.taskId);
  assert.equal(leased.integration_lease?.worker_id, FOREIGN.workerId);
  assert.equal(leased.integration_lease?.task_title, FOREIGN.title);
  assert.equal(leased.integration_lease?.belongs_to_current_task, false);
  assert.ok(leased.integration_lease?.acquired_at);
  assert.ok(leased.blocking_reasons.some((reason) => reason.code === "FOREIGN_INTEGRATION_LEASE"));
  await releaseForeignLease();

  // Case D: queue position is exact while the payload contains only the queue context needed for this task.
  const releaseForeignForQueue = await acquireWorkspaceIntegrationLease(FOREIGN, "main");
  const pendingTargetLease = acquireWorkspaceIntegrationLease(TARGET, "main");
  await waitUntil(() => readWorkspaceCoordination(repoRoot).integrationQueue.some((entry) => entry.taskId === TARGET.taskId), "target task did not enter integration queue");
  const pendingQueuedLease = acquireWorkspaceIntegrationLease(QUEUED, "main");
  await waitUntil(() => readWorkspaceCoordination(repoRoot).integrationQueue.some((entry) => entry.taskId === QUEUED.taskId), "queued task did not enter integration queue");
  const queued = await readWorkspaceTaskCoordinationStatus(repoRoot, QUEUED.taskId);
  assert.equal(queued.queue_position, 2);
  assert.equal(queued.safe_for_delivery, false);
  assert.ok(queued.blocking_reasons.some((reason) => reason.code === "QUEUE_WAIT"));
  assert.ok(queued.integration_queue.some((entry) => entry.task_id === TARGET.taskId && entry.position === 1));
  assert.ok(queued.integration_queue.some((entry) => entry.task_id === QUEUED.taskId && entry.position === 2));
  assert.ok(queued.integration_queue.length <= 3, "targeted queue context must stay bounded");
  await releaseForeignForQueue();
  const releaseTargetLease = await pendingTargetLease;
  await releaseTargetLease();
  const releaseQueuedLease = await pendingQueuedLease;
  await releaseQueuedLease();

  // Case E: exact stale path evidence blocks delivery.
  fs.writeFileSync(path.join(repoRoot, "a.txt"), "external committed edit\n", "utf8");
  git(["add", "a.txt"]);
  git(["commit", "-m", "advance shared head"]);
  const stale = await readWorkspaceTaskCoordinationStatus(repoRoot, TARGET.taskId);
  assert.equal(stale.stale_base, true);
  assert.deepEqual(stale.stale_paths, ["a.txt"]);
  assert.equal(stale.safe_for_delivery, false);
  assert.ok(stale.blocking_reasons.some((reason) => reason.code === "STALE_BASE"));

  // Case F: hundreds of unrelated tasks/claims must not inflate a targeted response.
  mutateCoordinationState((state) => {
    const now = new Date().toISOString();
    for (let index = 0; index < 100; index += 1) {
      const taskId = `cpt_${(0x1000 + index).toString(16).padStart(24, "0")}`;
      state.tasks[taskId] = {
        taskId,
        workerId: `worker:unrelated-${index}`,
        title: `Unrelated task ${index}`,
        status: "running",
        baseHead: state.tasks[TARGET.taskId].baseHead,
        baseBranch: "main",
        baseRemoteHead: "",
        initialDirtyPaths: [],
        touchedPaths: [],
        claimedPaths: [],
        commitShas: [],
        integrationStatus: "idle",
        startedAt: now,
        updatedAt: now
      };
      for (let claimIndex = 0; claimIndex < 10; claimIndex += 1) {
        state.claims[`unrelated/${index}-${claimIndex}.txt`] = { taskId, claimedAt: now, updatedAt: now };
      }
    }
  });
  const bounded = await readWorkspaceTaskCoordinationStatus(repoRoot, TARGET.taskId);
  const boundedJson = JSON.stringify(bounded);
  assert.equal(bounded.foreign_active_tasks.some((task) => task.title.startsWith("Unrelated task")), false);
  assert.equal(bounded.foreign_claims.some((claim) => claim.path.startsWith("unrelated/")), false);
  assert.equal(bounded.overlapping_claims.some((claim) => claim.path.startsWith("unrelated/")), false);
  assert.equal(boundedJson.includes("Unrelated task"), false, "targeted status must not dump unrelated task records");
  assert.equal(boundedJson.includes("unrelated/"), false, "targeted status must not dump unrelated claims");
  assert.ok(boundedJson.length < 30_000, `targeted status should remain compact, received ${boundedJson.length} bytes`);

  // Case G: unknown tasks fail closed with a deterministic reason and no workspace dump.
  const unknown = await readWorkspaceTaskCoordinationStatus(repoRoot, UNKNOWN_TASK_ID);
  assert.equal(unknown.found, false);
  assert.equal(unknown.safe_for_delivery, false);
  assert.equal(unknown.blocking_reasons[0]?.code, "TASK_NOT_FOUND");
  assert.equal(JSON.stringify(unknown).includes("Unrelated task"), false);
  assert.equal(JSON.stringify(unknown).includes("unrelated/"), false);

  await finalizeWorkspaceTask(TARGET, "cancelled");
  await finalizeWorkspaceTask(FOREIGN, "cancelled");
  await finalizeWorkspaceTask(QUEUED, "cancelled");
  console.log("workspace coordination status smoke passed");
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
