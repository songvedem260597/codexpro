import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-completed-task-resurrection-"));
process.env.CODEXPRO_HOME = home;

const {
  bootstrapWorkerJob,
  finalizeWorkerJob,
  listWorkerJobs,
  prepareWorkerJob,
  readWorkerJob,
  resumeWorkerJob
} = await import("../dist/workerPolicy.js");
const {
  getBrowserExtensionProfileTaskBinding,
  setBrowserExtensionProfileTask
} = await import("../dist/browserExtensionBridge.js");
const { createWorkerJobToolDefinitions } = await import("../dist/workerJobTools.js");

const completedTaskId = "cpt_111122223333444455556666";
const interruptedTaskId = "cpt_777788889999aaaabbbbcccc";
const incompleteTaskId = "cpt_ddddeeeeffff000011112222";
const profileId = "fixture.profile";

function bootstrapGeneral(jobId, workerId = profileId) {
  return bootstrapWorkerJob({
    jobId,
    workerId,
    title: "Controlled lifecycle request",
    kind: "general",
    root: "C:\\repo",
    workspaceId: "ws_fixture",
    scope: "workspace"
  });
}

try {
  // Controlled exactly-once request: one durable task id, one prepare, one dispatch/bootstrap.
  await prepareWorkerJob({ jobId: completedTaskId, workerId: profileId, scope: "workspace", root: "C:\\repo" });
  await bootstrapGeneral(completedTaskId);
  setBrowserExtensionProfileTask(profileId, completedTaskId, "Controlled lifecycle request");
  assert.equal(getBrowserExtensionProfileTaskBinding(profileId)?.taskId, completedTaskId, "active task must be presented while legitimately running");

  const beforeFinalize = readWorkerJob(completedTaskId);
  assert.equal(beforeFinalize?.status, "running");
  assert.equal(beforeFinalize?.events.filter((entry) => entry.type === "prepared").length, 1, "request must prepare exactly once");
  assert.equal(beforeFinalize?.events.filter((entry) => entry.type === "bootstrapped").length, 1, "request must dispatch/bootstrap exactly once");
  assert.equal(listWorkerJobs({ limit: 200 }).filter((job) => job.jobId === completedTaskId).length, 1, "exactly one durable worker job must exist for the logical execution");

  const tools = createWorkerJobToolDefinitions({
    serverKey: {},
    resolveProfileId: (_serverKey, taskId) => taskId === completedTaskId ? profileId : "",
    textResult: (_text, structuredContent) => structuredContent,
    readOnlyAnnotations: {},
    handoffWriteAnnotations: {}
  });
  const finalizeTool = tools.find((tool) => tool.name === "finalize_worker_job");
  assert.ok(finalizeTool, "finalize_worker_job tool must exist");
  await finalizeTool.handler({ task_id: completedTaskId, outcome: "completed", summary: "controlled response final and task legitimately complete" });

  const completed = readWorkerJob(completedTaskId);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.completionConfirmed, true, "legitimate completion must be durable");
  assert.ok(completed?.finishedAt, "legitimate completion must retain its terminal timestamp");
  assert.equal(getBrowserExtensionProfileTaskBinding(profileId), undefined, "completed task must stop being authoritative current task immediately");
  const terminalFinishedAt = completed.finishedAt;
  const terminalEventCount = completed.events.length;

  // Stale/older activation attempts cannot resurrect a legitimately completed task.
  await assert.rejects(
    () => prepareWorkerJob({ jobId: completedTaskId, workerId: profileId, scope: "workspace", root: "C:\\repo" }),
    /WORKER_JOB_COMPLETED_TERMINAL/
  );
  await assert.rejects(
    () => bootstrapGeneral(completedTaskId),
    /WORKER_JOB_COMPLETED_TERMINAL/
  );
  await assert.rejects(
    () => resumeWorkerJob({
      jobId: completedTaskId,
      workerId: profileId,
      root: "C:\\repo",
      workspaceId: "ws_fixture",
      scope: "workspace",
      resumeKey: "stale-auto-recovery"
    }),
    /WORKER_JOB_RESUME_NOT_RUNNING: task status is completed/i
  );
  setBrowserExtensionProfileTask(profileId, completedTaskId, "Stale completed task update");
  assert.equal(getBrowserExtensionProfileTaskBinding(profileId), undefined, "stale completed-task update must not restore current_task_id");

  const afterStaleAttempts = readWorkerJob(completedTaskId);
  assert.equal(afterStaleAttempts?.status, "completed", "terminal state must dominate stale activation attempts");
  assert.equal(afterStaleAttempts?.completionConfirmed, true);
  assert.equal(afterStaleAttempts?.finishedAt, terminalFinishedAt, "stale updates must not erase completion timestamp");
  assert.equal(afterStaleAttempts?.events.length, terminalEventCount, "rejected stale attempts must not append a second prepare/bootstrap execution");
  assert.equal(afterStaleAttempts?.events.filter((entry) => entry.type === "prepared").length, 1);
  assert.equal(afterStaleAttempts?.events.filter((entry) => entry.type === "bootstrapped").length, 1);
  assert.equal(listWorkerJobs({ limit: 200 }).filter((job) => job.jobId === completedTaskId).length, 1, "no second worker job/task record may be created for the completed execution");

  // A genuinely interrupted/running task remains recoverable.
  await prepareWorkerJob({ jobId: interruptedTaskId, workerId: profileId, scope: "workspace", root: "C:\\repo" });
  await bootstrapWorkerJob({
    jobId: interruptedTaskId,
    workerId: profileId,
    title: "Interrupted lifecycle fixture",
    kind: "code",
    root: "C:\\repo",
    workspaceId: "ws_fixture",
    scope: "workspace",
    rulesHash: "rules",
    rulesPath: "CODEXPRO.md",
    agentsFiles: ["AGENTS.md"],
    agentsHash: "agents",
    codexGraphActive: true,
    codexGraphSymbolCount: 10,
    codexGraphRelationshipCount: 20
  });
  const resumed = await resumeWorkerJob({
    jobId: interruptedTaskId,
    workerId: profileId,
    root: "C:\\repo",
    workspaceId: "ws_fixture",
    scope: "workspace",
    resumeKey: "legitimate-manual-recovery"
  });
  assert.equal(resumed.record.status, "running", "legitimately active task must still resume");
  assert.equal(resumed.record.events.filter((entry) => entry.type === "resumed").length, 1, "manual/legitimate recovery must remain functional");

  // A genuinely incomplete code task must not be completed prematurely.
  await prepareWorkerJob({ jobId: incompleteTaskId, workerId: "fixture.incomplete", scope: "workspace", root: "C:\\repo" });
  await bootstrapWorkerJob({
    jobId: incompleteTaskId,
    workerId: "fixture.incomplete",
    title: "Incomplete lifecycle fixture",
    kind: "code",
    root: "C:\\repo",
    workspaceId: "ws_incomplete",
    scope: "workspace",
    rulesHash: "rules",
    rulesPath: "CODEXPRO.md",
    agentsFiles: ["AGENTS.md"],
    agentsHash: "agents",
    codexGraphActive: false
  });
  await assert.rejects(
    () => finalizeWorkerJob({ jobId: incompleteTaskId, workerId: "fixture.incomplete", outcome: "completed", summary: "must not complete" }),
    /missing obligations: codexgraph/
  );
  assert.equal(readWorkerJob(incompleteTaskId)?.status, "running", "incomplete task must remain non-terminal");
  assert.equal(readWorkerJob(incompleteTaskId)?.completionConfirmed, false);

  console.log(JSON.stringify({
    regression: "completed-task-resurrection",
    first_task_id: completedTaskId,
    second_task_id_after_fix: null,
    prepare_count: afterStaleAttempts?.events.filter((entry) => entry.type === "prepared").length || 0,
    dispatch_count: afterStaleAttempts?.events.filter((entry) => entry.type === "bootstrapped").length || 0,
    current_task_after_completion: getBrowserExtensionProfileTaskBinding(profileId)?.taskId || "",
    legitimate_recovery_preserved: true,
    incomplete_completion_blocked: true
  }, null, 2));
  console.log("completed-task-resurrection-smoke: ok");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
