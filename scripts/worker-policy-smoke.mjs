import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-worker-policy-"));
process.env.CODEXPRO_HOME = home;
const managerMain = fs.readFileSync(new URL("../manager/electron/main.mjs", import.meta.url), "utf8");
assert.match(managerMain, /\.\.\.taskScopeLines,\s*\.\.\.taskStatusProtocolLines,/, "new tasks must receive the structured progress/finalization protocol, not only recovery and adjustment turns");
const reconcileScript = fs.readFileSync(new URL("./reconcile-browser-worker-jobs.mjs", import.meta.url), "utf8");
assert.match(reconcileScript, /candidate\.job\.kind === "code"[\s\S]*assertWorkspaceTaskCompletionReady/, "automatic reconciliation must not mark source-changing code tasks completed without workspace completion proof");

const {
  WORKER_POLICY_VERSION,
  WORKER_PREPARED_PLACEHOLDER_TTL_MS,
  bootstrapWorkerJob,
  finalizeWorkerJob,
  listWorkerJobs,
  prepareWorkerJob,
  readWorkerJob,
  reconcileCompletedWorkerJob,
  reportWorkerJobProgress,
  workerJobPublicRecord
} = await import("../dist/workerPolicy.js");
const { listWorkerContextCheckpoints, MAX_WORKER_CONTEXT_CHECKPOINTS } = await import("../dist/workerContext.js");

function backdateWorkerJob(jobId, ageMs) {
  const file = path.join(home, "worker-jobs", `${jobId}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const staleAt = new Date(Date.now() - ageMs).toISOString();
  record.preparedAt = staleAt;
  record.fifoQueuedAt = staleAt;
  record.updatedAt = staleAt;
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

try {
  const generalId = "cpt_111111111111111111111111";
  const prepared = await prepareWorkerJob({ jobId: generalId, workerId: "api.openrouter", scope: "workspace", root: "C:\\repo" });
  assert.equal(prepared.policyVersion, WORKER_POLICY_VERSION);
  assert.equal(prepared.status, "prepared");
  assert.ok(fs.existsSync(path.join(home, "worker-jobs", `${generalId}.json`)), "prepared jobs must persist outside the repository");

  const general = await bootstrapWorkerJob({
    jobId: generalId,
    workerId: "api.openrouter",
    title: "Explain worker policy",
    kind: "general",
    root: "",
    workspaceId: "",
    scope: "workspace"
  });
  assert.deepEqual(general.requiredObligations, ["job_title"]);
  assert.deepEqual(general.completedObligations, ["job_title"]);
  const completedGeneral = await finalizeWorkerJob({ jobId: generalId, workerId: "api.openrouter", outcome: "completed", summary: "done" });
  assert.equal(completedGeneral.status, "completed");

  const codeId = "cpt_222222222222222222222222";
  await prepareWorkerJob({ jobId: codeId, workerId: "api.custom", scope: "workspace", root: "C:\\repo" });
  const incomplete = await bootstrapWorkerJob({
    jobId: codeId,
    workerId: "api.custom",
    title: "Implement policy socket",
    kind: "code",
    root: "C:\\repo",
    workspaceId: "ws_fixture",
    scope: "workspace",
    rulesHash: "rules",
    rulesPath: "CODEXPRO.md",
    agentsFiles: ["AGENTS.md"],
    agentsHash: "agents",
    codexGraphActive: false
  });
  assert.deepEqual(workerJobPublicRecord(incomplete).missing_obligations, ["codexgraph"]);
  await assert.rejects(
    () => finalizeWorkerJob({ jobId: codeId, workerId: "api.custom", outcome: "completed" }),
    /missing obligations: codexgraph/
  );

  const bootstrapped = await bootstrapWorkerJob({
    jobId: codeId,
    workerId: "api.custom",
    title: "Implement policy socket",
    kind: "code",
    root: "C:\\repo",
    workspaceId: "ws_fixture",
    scope: "workspace",
    rulesHash: "rules",
    rulesPath: "CODEXPRO.md",
    agentsFiles: ["AGENTS.md"],
    agentsHash: "agents",
    codexGraphActive: true,
    codexGraphSymbolCount: 12,
    codexGraphRelationshipCount: 20
  });
  assert.deepEqual(bootstrapped.completedObligations, ["global_rules", "agents_chain", "codexgraph"]);
  const partialProgress = await reportWorkerJobProgress({
    jobId: codeId,
    workerId: "api.custom",
    stage: "partial",
    summary: "Implementation complete; tests remain.",
    reason: "Waiting for verification before finalizing.",
    evidence: "src/workerPolicy.ts updated",
    importantFiles: ["src/workerPolicy.ts", "src/workerContext.ts"],
    testResult: "pending",
    progressPercent: 40,
    completedParts: ["implementation"],
    remainingParts: ["tests", "commit", "push"]
  });
  const publicProgress = workerJobPublicRecord(partialProgress);
  assert.equal(publicProgress.progress_sequence, 1);
  assert.equal(publicProgress.last_progress_stage, "partial");
  assert.equal(publicProgress.last_progress_summary, "Implementation complete; tests remain.");
  assert.equal(publicProgress.last_progress_reason, "Waiting for verification before finalizing.");
  assert.equal(publicProgress.progress_percent, 40);
  assert.deepEqual(publicProgress.completed_parts, ["implementation"]);
  assert.deepEqual(publicProgress.remaining_parts, ["tests", "commit", "push"]);
  assert.deepEqual(publicProgress.progress_reports[0].completed_parts, ["implementation"]);
  assert.deepEqual(publicProgress.progress_reports[0].remaining_parts, ["tests", "commit", "push"]);
  assert.deepEqual(publicProgress.progress_reports[0].important_files, ["src/workerPolicy.ts", "src/workerContext.ts"]);
  assert.equal(publicProgress.progress_reports[0].test_result, "pending");
  await assert.rejects(
    () => finalizeWorkerJob({ jobId: codeId, workerId: "api.custom", outcome: "completed" }),
    /unfinished parts remain: tests, commit, push/
  );
  const blockedProgress = await reportWorkerJobProgress({
    jobId: codeId,
    workerId: "api.custom",
    stage: "blocked",
    summary: "Verification cannot continue.",
    reason: "Test environment is unavailable.",
    blockedPart: "tests",
    progressPercent: 40,
    completedParts: ["implementation"],
    remainingParts: ["tests", "commit", "push"]
  });
  const publicBlocked = workerJobPublicRecord(blockedProgress);
  assert.equal(publicBlocked.execution_state, "blocked");
  assert.equal(publicBlocked.blocked_part, "tests");
  assert.equal(publicBlocked.blocked_reason, "Test environment is unavailable.");
  assert.deepEqual(publicBlocked.remaining_parts, ["tests", "commit", "push"]);
  const errorProgress = await reportWorkerJobProgress({
    jobId: codeId,
    workerId: "api.custom",
    stage: "error",
    summary: "Verification command failed.",
    reason: "Build command exited unexpectedly.",
    blockedPart: "tests",
    progressPercent: 40,
    completedParts: ["implementation"],
    remainingParts: ["tests", "commit", "push"]
  });
  const publicError = workerJobPublicRecord(errorProgress);
  assert.equal(publicError.execution_state, "error");
  assert.equal(publicError.blocked_part, "tests", "error progress must retain the exact failed part for Control Center");
  assert.equal(publicError.blocked_reason, "Build command exited unexpectedly.");
  assert.equal(publicError.progress_percent, 40, "error progress must preserve the last reported percentage while blocked");
  assert.deepEqual(publicError.remaining_parts, ["tests", "commit", "push"], "error progress must preserve unfinished delivery steps");
  const partsDoneProgress = await reportWorkerJobProgress({
    jobId: codeId,
    workerId: "api.custom",
    stage: "all_parts_done",
    summary: "Implementation work is done; verification and delivery remain.",
    progressPercent: 100,
    completedParts: ["implementation"],
    remainingParts: ["tests", "commit", "push"]
  });
  assert.equal(workerJobPublicRecord(partsDoneProgress).progress_percent, 99, "running progress must not show 100% while remaining_parts is non-empty");
  assert.deepEqual(workerJobPublicRecord(partsDoneProgress).remaining_parts, ["tests", "commit", "push"], "all_parts_done must not erase unfinished verification/delivery steps");
  await assert.rejects(
    () => finalizeWorkerJob({ jobId: codeId, workerId: "api.custom", outcome: "completed" }),
    /unfinished parts remain: tests, commit, push/
  );
  const verifyingProgress = await reportWorkerJobProgress({
    jobId: codeId,
    workerId: "api.custom",
    stage: "verifying",
    summary: "Tests, commit, and push are complete.",
    evidence: "verification passed",
    importantFiles: ["src/workerPolicy.ts", "src/workerContext.ts"],
    testResult: "PASS worker-policy-smoke",
    progressPercent: 99,
    completedParts: ["implementation", "tests", "commit", "push"],
    remainingParts: []
  });
  assert.equal(workerJobPublicRecord(verifyingProgress).progress_percent, 99);
  assert.deepEqual(workerJobPublicRecord(verifyingProgress).remaining_parts, []);
  const workerContexts = listWorkerContextCheckpoints({ workerId: "api.custom", root: "C:\\repo", scope: "workspace", taskId: codeId });
  assert.equal(workerContexts.length, MAX_WORKER_CONTEXT_CHECKPOINTS, "worker/project/task recovery context must retain exactly three newest checkpoints without mixing another task");
  assert.deepEqual(
    workerContexts.map((checkpoint) => checkpoint.summary),
    ["Verification command failed.", "Implementation work is done; verification and delivery remain.", "Tests, commit, and push are complete."],
    "the fourth and later progress report must evict the oldest worker/project context"
  );
  assert.deepEqual(workerContexts.at(-1)?.importantFiles, ["src/workerPolicy.ts", "src/workerContext.ts"], "checkpoint must retain important files as a dedicated field");
  assert.equal(workerContexts.at(-1)?.testResult, "PASS worker-policy-smoke", "checkpoint must retain test result as a dedicated field");
  assert.equal(listWorkerContextCheckpoints({ workerId: "api.custom", root: "C:\\repo", scope: "workspace", taskId: "cpt_999999999999999999999999" }).length, 0, "task-scoped recovery must never mix checkpoints from another task in the same worker/project");
  assert.equal(listWorkerContextCheckpoints({ workerId: "api.custom", root: "C:\\other-repo", scope: "workspace" }).length, 0, "worker context must not leak across projects");
  assert.equal(listWorkerContextCheckpoints({ workerId: "api.other", root: "C:\\repo", scope: "workspace" }).length, 0, "worker context must not leak across workers");
  assert.doesNotMatch(JSON.stringify(workerContexts), /conversation(?:Id|_id)|chatgpt\.com\/c\//i, "worker recovery context must not persist ChatGPT conversation identity");
  const completedCode = await finalizeWorkerJob({ jobId: codeId, workerId: "api.custom", outcome: "completed", summary: "Implementation, verification, commit, and push completed." });
  const publicCompleted = workerJobPublicRecord(completedCode);
  assert.equal(publicCompleted.status, "completed");
  assert.equal(publicCompleted.progress_percent, 100);
  assert.equal(publicCompleted.completion_confirmed, true);
  assert.ok(publicCompleted.completion_confirmed_at);
  assert.match(String(publicCompleted.completion_evidence || ""), /Implementation, verification, commit, and push completed/);
  await assert.rejects(
    () => reportWorkerJobProgress({ jobId: codeId, workerId: "api.custom", stage: "verifying", summary: "late update" }),
    /not running/
  );
  assert.equal(readWorkerJob(codeId)?.codexGraphSymbolCount, 12);
  assert.deepEqual(listWorkerJobs({ statuses: ["completed"], limit: 10 }).map((job) => job.jobId), [codeId, generalId], "completed job history must be newest first");
  assert.deepEqual(listWorkerJobs({ statuses: ["failed"], limit: 10 }), [], "job history status filter must exclude other terminal states");
  await assert.rejects(
    () => finalizeWorkerJob({ jobId: codeId, workerId: "api.other", outcome: "failed" }),
    /owner mismatch/
  );

  const reconciledId = "cpt_333333333333333333333333";
  await prepareWorkerJob({ jobId: reconciledId, workerId: "chrome.fixture", scope: "workspace", root: "C:\\repo" });
  const running = await bootstrapWorkerJob({
    jobId: reconciledId,
    workerId: "chrome.fixture",
    title: "Reconcile completed browser task",
    kind: "general",
    root: "",
    workspaceId: "",
    scope: "workspace"
  });
  const evidenceFinishedAt = new Date(Date.parse(running.startedAt) + 5000).toISOString();
  const reconciled = await reconcileCompletedWorkerJob({
    jobId: reconciledId,
    workerId: "chrome.fixture",
    finishedAt: evidenceFinishedAt,
    evidence: "manager_chat_response_audit"
  });
  assert.equal(reconciled.status, "completed");
  assert.equal(reconciled.finishedAt, evidenceFinishedAt);
  assert.equal(reconciled.events.at(-1)?.type, "reconciled_completed");

  const stalePlaceholderId = "cpt_aaaaaaaaaaaaaaaaaaaaaaaa";
  const staleReplacementId = "cpt_bbbbbbbbbbbbbbbbbbbbbbbb";
  await prepareWorkerJob({ jobId: stalePlaceholderId, workerId: "browser:chrome.fixture-stale", scope: "all_allowed" });
  assert.equal(readWorkerJob(stalePlaceholderId)?.title, "", "a freshly prepared Manager placeholder starts without a task title");
  backdateWorkerJob(stalePlaceholderId, WORKER_PREPARED_PLACEHOLDER_TTL_MS + 1000);
  await prepareWorkerJob({ jobId: staleReplacementId, workerId: "chrome.fixture-stale", scope: "all_allowed" });
  assert.equal(readWorkerJob(stalePlaceholderId), undefined, "an abandoned uninitialized prepared placeholder must be discarded before it can block a newer task");
  const staleReplacement = await bootstrapWorkerJob({
    jobId: staleReplacementId,
    workerId: "chrome.fixture-stale",
    title: "Start replacement browser task",
    kind: "general",
    root: "",
    workspaceId: "",
    scope: "all_allowed"
  });
  assert.equal(staleReplacement.status, "running", "the next task must start after the stale placeholder is discarded");
  await finalizeWorkerJob({ jobId: staleReplacementId, workerId: "chrome.fixture-stale", outcome: "completed" });

  const freshPlaceholderId = "cpt_dddddddddddddddddddddddd";
  const freshFollowerId = "cpt_eeeeeeeeeeeeeeeeeeeeeeee";
  await prepareWorkerJob({ jobId: freshPlaceholderId, workerId: "chrome.fixture-fresh", scope: "all_allowed" });
  await prepareWorkerJob({ jobId: freshFollowerId, workerId: "chrome.fixture-fresh", scope: "all_allowed" });
  assert.ok(readWorkerJob(freshPlaceholderId), "a fresh uninitialized placeholder must keep its short dispatch grace period");
  await assert.rejects(
    () => bootstrapWorkerJob({
      jobId: freshFollowerId,
      workerId: "chrome.fixture-fresh",
      title: "Wait behind fresh placeholder",
      kind: "general",
      root: "",
      workspaceId: "",
      scope: "all_allowed"
    }),
    new RegExp(`WORKER_JOB_FIFO_WAIT:.*${freshPlaceholderId}`),
    "a fresh placeholder must still preserve FIFO while the original ChatGPT dispatch can start"
  );
  await finalizeWorkerJob({ jobId: freshPlaceholderId, workerId: "chrome.fixture-fresh", outcome: "cancelled" });
  const freshFollower = await bootstrapWorkerJob({
    jobId: freshFollowerId,
    workerId: "chrome.fixture-fresh",
    title: "Wait behind fresh placeholder",
    kind: "general",
    root: "",
    workspaceId: "",
    scope: "all_allowed"
  });
  assert.equal(freshFollower.status, "running");
  await finalizeWorkerJob({ jobId: freshFollowerId, workerId: "chrome.fixture-fresh", outcome: "completed" });

  const supersededId = "cpt_444444444444444444444444";
  const replacementId = "cpt_555555555555555555555555";
  const laterQueuedId = "cpt_cccccccccccccccccccccccc";
  await prepareWorkerJob({ jobId: supersededId, workerId: "browser:chrome.fixture-supersede", scope: "workspace", root: "C:\\repo" });
  await bootstrapWorkerJob({
    jobId: supersededId,
    workerId: "browser:chrome.fixture-supersede",
    title: "Older browser task",
    kind: "general",
    root: "",
    workspaceId: "",
    scope: "workspace"
  });
  await prepareWorkerJob({ jobId: replacementId, workerId: "chrome.fixture-supersede", scope: "workspace", root: "C:\\repo" });
  await assert.rejects(
    () => bootstrapWorkerJob({
      jobId: replacementId,
      workerId: "chrome.fixture-supersede",
      title: "Replacement browser task",
      kind: "general",
      root: "",
      workspaceId: "",
      scope: "workspace"
    }),
    new RegExp(`WORKER_JOB_FIFO_WAIT:.*${supersededId}`),
    "a newer task must remain prepared instead of superseding the running task"
  );
  assert.equal(readWorkerJob(supersededId)?.status, "running", "FIFO protection must preserve the running task");
  assert.equal(readWorkerJob(replacementId)?.status, "prepared", "the newer task must remain durable and resumable in the queue");
  assert.equal(readWorkerJob(replacementId)?.title, "Replacement browser task", "a FIFO-blocked task must persist its bootstrap title instead of remaining an empty placeholder");
  assert.equal(readWorkerJob(replacementId)?.events.some((entry) => entry.type === "bootstrap_requested"), true, "a FIFO-blocked task must persist bootstrap-attempt evidence");
  backdateWorkerJob(replacementId, WORKER_PREPARED_PLACEHOLDER_TTL_MS + 1000);
  await prepareWorkerJob({ jobId: laterQueuedId, workerId: "chrome.fixture-supersede", scope: "workspace", root: "C:\\repo" });
  assert.equal(readWorkerJob(replacementId)?.title, "Replacement browser task", "an initialized FIFO task must survive stale-placeholder cleanup even when it has waited longer than the placeholder TTL");
  await finalizeWorkerJob({ jobId: supersededId, workerId: "browser:chrome.fixture-supersede", outcome: "completed" });
  const replacement = await bootstrapWorkerJob({
    jobId: replacementId,
    workerId: "chrome.fixture-supersede",
    title: "Replacement browser task",
    kind: "general",
    root: "",
    workspaceId: "",
    scope: "workspace"
  });
  assert.equal(replacement.status, "running");
  await finalizeWorkerJob({ jobId: replacementId, workerId: "chrome.fixture-supersede", outcome: "completed" });
  const laterQueued = await bootstrapWorkerJob({
    jobId: laterQueuedId,
    workerId: "chrome.fixture-supersede",
    title: "Run later queued task",
    kind: "general",
    root: "",
    workspaceId: "",
    scope: "workspace"
  });
  assert.equal(laterQueued.status, "running", "the later FIFO task must still run after the protected queued task completes");
  await finalizeWorkerJob({ jobId: laterQueuedId, workerId: "chrome.fixture-supersede", outcome: "completed" });

  const largeId = "cpt_666666666666666666666666";
  await prepareWorkerJob({ jobId: largeId, workerId: "api.large", scope: "workspace", root: "C:\\repo" });
  const large = await bootstrapWorkerJob({
    jobId: largeId,
    workerId: "api.large",
    title: "Refactor complex worker lifecycle",
    kind: "code",
    taskSize: "large",
    root: "C:\\repo",
    workspaceId: "ws_large",
    scope: "workspace",
    rulesHash: "rules",
    agentsHash: "agents",
    codexGraphActive: true
  });
  assert.equal(workerJobPublicRecord(large).task_size, "large");
  assert.deepEqual(workerJobPublicRecord(large).missing_obligations, ["task_checklist"], "large tasks must require a durable checklist");
  await assert.rejects(
    () => finalizeWorkerJob({ jobId: largeId, workerId: "api.large", outcome: "completed" }),
    /task_checklist/
  );
  await assert.rejects(
    () => reportWorkerJobProgress({
      jobId: largeId,
      workerId: "api.large",
      stage: "started",
      summary: "Invalid plan",
      checklist: [
        { id: "investigate", title: "Investigate", status: "in_progress" },
        { id: "implement", title: "Implement", status: "in_progress" }
      ]
    }),
    /only one in_progress/
  );
  const plannedLarge = await reportWorkerJobProgress({
    jobId: largeId,
    workerId: "api.large",
    stage: "started",
    summary: "Investigation plan persisted before source changes.",
    progressPercent: 10,
    completedParts: [],
    remainingParts: ["investigate", "implement", "verify"],
    checklist: [
      { id: "investigate", title: "Investigate root cause", status: "in_progress" },
      { id: "implement", title: "Implement scoped fix", status: "pending" },
      { id: "verify", title: "Verify and deliver", status: "pending" }
    ]
  });
  assert.deepEqual(workerJobPublicRecord(plannedLarge).missing_obligations, []);
  assert.equal(workerJobPublicRecord(plannedLarge).checklist[0].status, "in_progress");
  await assert.rejects(
    () => finalizeWorkerJob({ jobId: largeId, workerId: "api.large", outcome: "completed" }),
    /unfinished parts remain|checklist items remain unfinished/
  );
  await reportWorkerJobProgress({
    jobId: largeId,
    workerId: "api.large",
    stage: "verifying",
    summary: "All checklist items and delivery steps completed.",
    progressPercent: 99,
    completedParts: ["investigate", "implement", "verify"],
    remainingParts: [],
    checklist: [
      { id: "investigate", title: "Investigate root cause", status: "completed", evidence: "call flow inspected" },
      { id: "implement", title: "Implement scoped fix", status: "completed", evidence: "source updated" },
      { id: "verify", title: "Verify and deliver", status: "completed", evidence: "tests passed" }
    ]
  });
  const completedLarge = await finalizeWorkerJob({ jobId: largeId, workerId: "api.large", outcome: "completed", summary: "Large task completed." });
  assert.equal(completedLarge.status, "completed");
  assert.ok(completedLarge.checklist.every((item) => item.status === "completed"));

  const mediumId = "cpt_777777777777777777777777";
  await prepareWorkerJob({ jobId: mediumId, workerId: "api.medium", scope: "workspace", root: "C:\\repo" });
  const medium = await bootstrapWorkerJob({
    jobId: mediumId,
    workerId: "api.medium",
    title: "Implement medium workflow change",
    kind: "general",
    taskSize: "medium",
    root: "",
    workspaceId: "",
    scope: "workspace"
  });
  assert.deepEqual(workerJobPublicRecord(medium).missing_obligations, ["task_checklist"], "medium tasks must also require a durable checklist");
  await reportWorkerJobProgress({
    jobId: mediumId,
    workerId: "api.medium",
    stage: "verifying",
    summary: "Medium checklist complete.",
    remainingParts: [],
    checklist: [{ id: "work", title: "Implement and verify", status: "completed" }]
  });
  assert.equal((await finalizeWorkerJob({ jobId: mediumId, workerId: "api.medium", outcome: "completed" })).status, "completed");

  console.log("✓ Worker MCP policy persistence smoke test passed");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
