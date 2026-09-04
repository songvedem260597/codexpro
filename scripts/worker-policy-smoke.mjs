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
  bootstrapWorkerJob,
  finalizeWorkerJob,
  listWorkerJobs,
  prepareWorkerJob,
  readWorkerJob,
  reconcileCompletedWorkerJob,
  reportWorkerJobProgress,
  workerJobPublicRecord
} = await import("../dist/workerPolicy.js");

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
    progressPercent: 90,
    completedParts: ["implementation"],
    remainingParts: ["tests", "commit", "push"]
  });
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
    progressPercent: 99,
    completedParts: ["implementation", "tests", "commit", "push"],
    remainingParts: []
  });
  assert.equal(workerJobPublicRecord(verifyingProgress).progress_percent, 99);
  assert.deepEqual(workerJobPublicRecord(verifyingProgress).remaining_parts, []);
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

  const supersededId = "cpt_444444444444444444444444";
  const replacementId = "cpt_555555555555555555555555";
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
  const replacement = await bootstrapWorkerJob({
    jobId: replacementId,
    workerId: "chrome.fixture-supersede",
    title: "Replacement browser task",
    kind: "general",
    root: "",
    workspaceId: "",
    scope: "workspace"
  });
  const superseded = readWorkerJob(supersededId);
  assert.equal(superseded?.status, "cancelled", "starting a newer task on the same worker must close the previous running job");
  assert.equal(superseded?.events.at(-1)?.type, "superseded");
  assert.equal(superseded?.events.at(-1)?.details?.superseded_by, replacementId);
  assert.equal(replacement.status, "running");
  await finalizeWorkerJob({ jobId: replacementId, workerId: "chrome.fixture-supersede", outcome: "completed" });

  console.log("✓ Worker MCP policy persistence smoke test passed");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
