import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-task-tracking-home-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-task-tracking-repo-"));
process.env.CODEXPRO_HOME = home;

function git(args, cwd = repo) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function finalizedEvent() {
  return [{ at: new Date().toISOString(), type: "finalized", details: { outcome: "completed" } }];
}

try {
  git(["init"]);
  git(["config", "user.email", "task-tracking@example.test"]);
  git(["config", "user.name", "Task Tracking Smoke"]);
  fs.writeFileSync(path.join(repo, "README.md"), "task tracking smoke\n", "utf8");
  git(["add", "README.md"]);
  git(["commit", "-m", "initial"]);
  git(["branch", "-M", "win"]);
  git(["remote", "add", "origin", "https://github.com/TestOwner/TestRepo.git"]);
  const head = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/win", head]);

  const {
    TASK_TRACKING_WORKER_RULE,
    projectTaskTrackingState,
    readTaskTracking,
    resolveTaskTrackingPath,
    resolveTaskTrackingRepository,
    syncTaskTracking,
    taskTrackingPathForRepositoryKey,
    taskTrackingRoot
  } = await import("../dist/taskTracking.js");
  const { codexProHome } = await import("../dist/profileStore.js");
  const {
    bootstrapWorkerJob,
    finalizeWorkerJob,
    prepareWorkerJob,
    readWorkerJob,
    reportWorkerJobProgress
  } = await import("../dist/workerPolicy.js");
  const { backfillUnfinishedTaskTracking, syncAuthoritativeTaskTracking } = await import("../dist/taskTrackingReconciliation.js");
  const { finalizeWorkspaceTask, readWorkspaceCoordination, registerWorkspaceTask } = await import("../dist/workspaceCoordination.js");
  const { serverInstructions } = await import("../dist/server.js");

  // A. PATH / STORAGE
  assert.equal(taskTrackingRoot(), path.join(codexProHome(), "task-tracking"), "tracking must use the actual codexProHome()");
  assert.equal(inside(repo, taskTrackingRoot()), false, "tracking root must stay outside the repository/worktree");
  const repositoryA = await resolveTaskTrackingRepository(repo);
  const repositoryB = await resolveTaskTrackingRepository(repo);
  assert.deepEqual(repositoryA, repositoryB, "repository identity/key must be deterministic");
  assert.match(repositoryA.repositoryKey, /^[a-z0-9][a-z0-9._-]{0,127}$/);
  const taskA = "cpt_aaaaaaaaaaaaaaaaaaaaaaaa";
  const taskB = "cpt_bbbbbbbbbbbbbbbbbbbbbbbb";
  const destinationA = taskTrackingPathForRepositoryKey(repositoryA.repositoryKey, taskA);
  assert.ok(inside(taskTrackingRoot(), destinationA), "resolved tracking file must remain under task-tracking root");
  assert.throws(() => taskTrackingPathForRepositoryKey("../escape", taskA), /repository key is invalid/i);
  assert.throws(() => taskTrackingPathForRepositoryKey(repositoryA.repositoryKey, "../escape"), /task id is invalid/i);

  // B/C. WRITE SAFETY + CONTENT
  const startedAt = "2026-09-12T10:00:00.000Z";
  const secret = ["Authorization: Bearer ", "abcdefghijklmnopqrstuvwx"].join("");
  const baseWorker = {
    jobId: taskA,
    workerId: "a569b150-1fb3-4270-888f-b157a112953c",
    status: "running",
    kind: "code",
    title: "Track persistent tasks",
    startedAt,
    preparedAt: "2026-09-12T09:59:00.000Z",
    lastProgressStage: "partial",
    lastProgressSummary: `implemented storage ${secret}`,
    dependency: "",
    safeNextAction: "run tests",
    remainingParts: ["tests"],
    completionConfirmed: false,
    events: []
  };
  const first = await syncTaskTracking({ root: repo, taskId: taskA, workerJob: baseWorker, ownerProfile: "profile-a" });
  assert.equal(first.task_id, taskA);
  assert.equal(first.owner_worker, baseWorker.workerId);
  assert.equal(first.owner_profile, "profile-a");
  assert.equal(first.started_at, startedAt);
  const serializedFirst = fs.readFileSync(destinationA, "utf8");
  assert.doesNotMatch(serializedFirst, new RegExp(secret));
  assert.match(serializedFirst, /REDACTED_SECRET/);
  assert.ok(Buffer.byteLength(serializedFirst) < 20_000, "tracking record must remain compact");

  await new Promise((resolve) => setTimeout(resolve, 10));
  const resumed = await syncTaskTracking({
    root: repo,
    taskId: taskA,
    workerJob: { ...baseWorker, lastProgressSummary: "resumed safely" },
    ownerProfile: "profile-a"
  });
  assert.equal(resumed.started_at, startedAt, "resume must preserve authoritative started_at");
  assert.ok(Date.parse(resumed.updated_at) > Date.parse(first.updated_at), "updated_at must advance");

  const sameTaskWrites = await Promise.all(Array.from({ length: 12 }, (_, index) => syncTaskTracking({
    root: repo,
    taskId: taskA,
    workerJob: { ...baseWorker, lastProgressSummary: `same-task-${index}` },
    ownerProfile: "profile-a"
  })));
  assert.equal(sameTaskWrites.length, 12);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(destinationA, "utf8")), "same-task concurrent writes must never leave partial JSON");
  assert.equal(fs.readdirSync(path.dirname(destinationA)).some((name) => name.includes(`${taskA}.json.`) && name.endsWith(".tmp")), false, "atomic writes must not leave temp files");

  await Promise.all([
    syncTaskTracking({ root: repo, taskId: taskA, workerJob: { ...baseWorker, lastProgressSummary: "task-a" }, ownerProfile: "profile-a" }),
    syncTaskTracking({ root: repo, taskId: taskB, workerJob: { ...baseWorker, jobId: taskB, workerId: "worker-b", title: "Second task", lastProgressSummary: "task-b" }, ownerProfile: "profile-b" })
  ]);
  const destinationB = await resolveTaskTrackingPath(repo, taskB);
  assert.equal(JSON.parse(fs.readFileSync(destinationA, "utf8")).task_id, taskA);
  assert.equal(JSON.parse(fs.readFileSync(destinationB, "utf8")).task_id, taskB, "different-task writes must not overwrite each other");

  // D. DETERMINISTIC LIFECYCLE PROJECTION
  assert.equal(projectTaskTrackingState({ workerJob: { status: "prepared" } }), "PAUSED");
  assert.equal(projectTaskTrackingState({ workerJob: { status: "running" } }), "ACTIVE");
  assert.equal(projectTaskTrackingState({ workerJob: { status: "blocked", lastProgressStage: "blocked" } }), "BLOCKED");
  assert.equal(projectTaskTrackingState({ workerJob: { status: "failed" } }), "FAILED_RESUMABLE");
  assert.equal(projectTaskTrackingState({ workerJob: { status: "running", waitState: "dependency" } }), "WAITING_DEPENDENCY");
  assert.equal(projectTaskTrackingState({ workerJob: { status: "running", waitState: "runtime_acceptance" } }), "WAITING_RUNTIME_ACCEPTANCE");
  assert.equal(projectTaskTrackingState({ workerJob: { status: "running" }, workspaceTask: { integrationStatus: "queued" } }), "READY_TO_INTEGRATE");
  assert.equal(projectTaskTrackingState({ workerJob: { status: "running" }, workspaceTask: { integrationStatus: "integrating" } }), "INTEGRATING");
  assert.equal(projectTaskTrackingState({ workerJob: { status: "completed", events: [] }, workspaceTask: { status: "completed" } }), "PAUSED", "unfinalized completion must not project COMPLETED");
  assert.equal(projectTaskTrackingState({ workerJob: { status: "completed", events: finalizedEvent() }, workspaceTask: { status: "completed" } }), "COMPLETED");

  const failedTask = "cpt_cccccccccccccccccccccccc";
  const failedRecord = await syncTaskTracking({
    root: repo,
    taskId: failedTask,
    workerJob: { ...baseWorker, jobId: failedTask, status: "failed", error: "fixture failed", lastProgressSummary: "failed but resumable" }
  });
  assert.equal(failedRecord.state, "FAILED_RESUMABLE");
  assert.ok(fs.existsSync(await resolveTaskTrackingPath(repo, failedTask)), "failed resumable task must remain persisted");

  const integratedTask = "cpt_dddddddddddddddddddddddd";
  const integratedRecord = await syncTaskTracking({
    root: repo,
    taskId: integratedTask,
    workerJob: { ...baseWorker, jobId: integratedTask },
    workspaceTask: {
      taskId: integratedTask,
      workerId: baseWorker.workerId,
      status: "running",
      commitShas: [head],
      integrationStatus: "integrated",
      integrationBranch: "win",
      integratedHead: head,
      baseRemoteHead: head,
      startedAt
    }
  });
  assert.equal(integratedRecord.integrated, true);
  assert.equal(integratedRecord.commit_sha, head);
  assert.equal(integratedRecord.checkpoint, head);
  assert.equal(integratedRecord.origin_win_seen, head, "origin_win_seen must use authoritative successful integration evidence");

  const completedRecord = await syncTaskTracking({
    root: repo,
    taskId: integratedTask,
    workerJob: { ...baseWorker, jobId: integratedTask, status: "completed", events: finalizedEvent(), completionConfirmed: true },
    workspaceTask: {
      taskId: integratedTask,
      workerId: baseWorker.workerId,
      status: "completed",
      commitShas: [head],
      integrationStatus: "integrated",
      integrationBranch: "win",
      integratedHead: head,
      baseRemoteHead: head,
      startedAt
    }
  });
  assert.equal(completedRecord.state, "COMPLETED");
  assert.equal(completedRecord.finalized, true);
  assert.equal(completedRecord.integrated, true);
  assert.ok(fs.existsSync(await resolveTaskTrackingPath(repo, integratedTask)), "completed task tracking file must remain on disk");

  // E/F. RECONCILIATION + CONTROL-PLANE SAFETY
  const authoritativeTask = "cpt_eeeeeeeeeeeeeeeeeeeeeeee";
  const authoritativeWorker = "worker-authoritative";
  await prepareWorkerJob({ jobId: authoritativeTask, workerId: authoritativeWorker, scope: "workspace", root: repo });
  await bootstrapWorkerJob({
    jobId: authoritativeTask,
    workerId: authoritativeWorker,
    title: "Authoritative tracking fixture",
    kind: "code",
    root: repo,
    workspaceId: "ws_task_tracking_fixture",
    scope: "workspace",
    rulesHash: "rules",
    rulesPath: "CODEXPRO.md",
    agentsFiles: ["AGENTS.md"],
    agentsHash: "agents",
    codexGraphActive: true,
    codexGraphSymbolCount: 1,
    codexGraphRelationshipCount: 1
  });
  await registerWorkspaceTask({ taskId: authoritativeTask, workerId: authoritativeWorker, title: "Authoritative tracking fixture", root: repo });
  const authoritativePath = await resolveTaskTrackingPath(repo, authoritativeTask);
  fs.rmSync(authoritativePath, { force: true });
  const reconstructed = await syncAuthoritativeTaskTracking({ taskId: authoritativeTask, rootHint: repo, ownerProfile: authoritativeWorker });
  assert.equal(reconstructed?.state, "ACTIVE", "missing tracking file must reconstruct from authoritative state");
  assert.ok(fs.existsSync(authoritativePath));

  fs.writeFileSync(authoritativePath, "{malformed", "utf8");
  const repaired = await syncAuthoritativeTaskTracking({ taskId: authoritativeTask, rootHint: repo, ownerProfile: authoritativeWorker });
  assert.equal(repaired?.task_id, authoritativeTask, "malformed tracking file must be safely replaced");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(authoritativePath, "utf8")));

  const authoritativeJobPath = path.join(home, "worker-jobs", `${authoritativeTask}.json`);
  const coordinationBefore = JSON.parse(JSON.stringify(readWorkspaceCoordination(repo)));
  const jobBefore = fs.readFileSync(authoritativeJobPath, "utf8");
  await syncAuthoritativeTaskTracking({ taskId: authoritativeTask, rootHint: repo, ownerProfile: authoritativeWorker });
  assert.deepEqual(readWorkspaceCoordination(repo), coordinationBefore, "tracking sync must not claim/release files, mutate queue/lease, ownership, or lifecycle");
  assert.equal(fs.readFileSync(authoritativeJobPath, "utf8"), jobBefore, "tracking reconciliation must not mutate worker authoritative state");

  await reportWorkerJobProgress({
    jobId: authoritativeTask,
    workerId: authoritativeWorker,
    stage: "all_parts_done",
    summary: "fixture complete",
    completedParts: ["fixture"],
    remainingParts: []
  });
  await finalizeWorkerJob({ jobId: authoritativeTask, workerId: authoritativeWorker, outcome: "completed", summary: "fixture finalized" });
  await finalizeWorkspaceTask({ taskId: authoritativeTask, workerId: authoritativeWorker, title: "Authoritative tracking fixture", root: repo }, "completed");
  const staleActive = {
    ...repaired,
    owner_worker: "wrong-worker",
    owner_profile: "wrong-profile",
    title: "wrong title",
    state: "ACTIVE",
    finalized: false,
    updated_at: "2000-01-01T00:00:00.000Z"
  };
  fs.writeFileSync(authoritativePath, `${JSON.stringify(staleActive, null, 2)}\n`, "utf8");
  const authoritativeBeforeRepair = fs.readFileSync(authoritativeJobPath, "utf8");
  const corrected = await syncAuthoritativeTaskTracking({ taskId: authoritativeTask, rootHint: repo, ownerProfile: authoritativeWorker });
  assert.equal(corrected?.state, "COMPLETED", "stale ACTIVE must never resurrect authoritative completed task");
  assert.equal(corrected?.finalized, true);
  assert.equal(corrected?.owner_worker, authoritativeWorker);
  assert.equal(corrected?.owner_profile, authoritativeWorker);
  assert.equal(corrected?.title, "Authoritative tracking fixture");
  assert.equal(fs.readFileSync(authoritativeJobPath, "utf8"), authoritativeBeforeRepair, "repair must remain a one-way authoritative -> tracking projection");

  // G. RULE INJECTION through the actual server instruction builder.
  const ruleFixture = "cpt_ffffffffffffffffffffffff";
  await prepareWorkerJob({ jobId: ruleFixture, workerId: "worker-rule", scope: "workspace", root: repo });
  await bootstrapWorkerJob({
    jobId: ruleFixture,
    workerId: "worker-rule",
    title: "Rule injection fixture",
    kind: "code",
    root: repo,
    workspaceId: "ws_rule_fixture",
    scope: "workspace",
    rulesHash: "rules",
    rulesPath: "CODEXPRO.md",
    agentsFiles: ["AGENTS.md"],
    agentsHash: "agents",
    codexGraphActive: true,
    codexGraphSymbolCount: 1,
    codexGraphRelationshipCount: 1
  });
  const instructions = serverInstructions({
    connectionTest: false,
    writeMode: "workspace",
    bashMode: "full",
    codexSessions: "off",
    requireBashSession: false,
    bashSessionId: undefined,
    toolMode: "full"
  }, true);
  assert.equal(instructions.split(TASK_TRACKING_WORKER_RULE).length - 1, 1, "mandatory task tracking rule must appear exactly once in repo worker serverInstructions");

  const invalidRootTask = "cpt_121212121212121212121212";
  await prepareWorkerJob({ jobId: invalidRootTask, workerId: "worker-invalid-root", scope: "workspace", root: home });
  await bootstrapWorkerJob({
    jobId: invalidRootTask,
    workerId: "worker-invalid-root",
    title: "Invalid root fixture",
    kind: "code",
    root: home,
    workspaceId: "ws_invalid_root_fixture",
    scope: "workspace",
    rulesHash: "rules",
    rulesPath: "CODEXPRO.md",
    agentsFiles: ["AGENTS.md"],
    agentsHash: "agents",
    codexGraphActive: true,
    codexGraphSymbolCount: 1,
    codexGraphRelationshipCount: 1
  });

  // Backfill and extension terminal contract.
  const backfill = await backfillUnfinishedTaskTracking();
  assert.ok(backfill.backfilled.some((item) => item.taskId === ruleFixture), "unfinished authoritative code tasks must be backfilled");
  assert.ok(backfill.skippedTerminalTaskIds.includes(authoritativeTask), "completed+finalized tasks must be skipped by unfinished backfill");
  assert.ok(backfill.errors.some((item) => item.taskId === invalidRootTask), "one invalid historical root must not block backfill of other tasks");
  const extensionFixture = [
    await readTaskTracking(repo, ruleFixture),
    corrected
  ].filter(Boolean);
  const filterable = extensionFixture.filter((item) => item.state === "COMPLETED" && item.finalized === true);
  assert.ok(extensionFixture.some((item) => item.state !== "COMPLETED"), "unfinished task must remain retained/uploadable");
  assert.deepEqual(filterable.map((item) => item.task_id), [authoritativeTask], "only COMPLETED + finalized=true is filterable by the extension contract");

  console.log(JSON.stringify({
    repository_key_example: repositoryA.repositoryKey,
    tracking_root: taskTrackingRoot(),
    path_traversal_test: "PASS",
    atomic_write_test: "PASS",
    same_task_concurrency_test: "PASS",
    multi_task_concurrency_test: "PASS",
    restart_reconciliation_test: "PASS",
    no_second_control_plane_test: "PASS",
    worker_rule_test: "PASS"
  }, null, 2));
  console.log("task tracking smoke passed");
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
