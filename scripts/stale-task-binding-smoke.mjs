import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "codexpro-stale-task-binding-"));
const port = 24_000 + Math.floor(Math.random() * 10_000);
process.env.CODEXPRO_HOME = home;
process.env.CODEXPRO_BROWSER_EXTENSION_BRIDGE_PORT = String(port);

const profileId = "stale-binding-profile";
const unrelatedProfileId = "unrelated-binding-profile";
const staleTaskId = "cpt_111111111111111111111111";
const nextTaskId = "cpt_222222222222222222222222";
const unrelatedTaskId = "cpt_444444444444444444444444";
const staleRoot = path.join(home, "deleted-completed-worktree");
const unrelatedRoot = path.join(home, "unrelated-workspace");

const bridge = await import("../dist/browserExtensionBridge.js");
const policy = await import("../dist/workerPolicy.js");
const { createWorkerJobToolDefinitions } = await import("../dist/workerJobTools.js");
const popup = await import("../manager/src/profile-task-popup.js");

async function registerIdleProfile() {
  bridge.ensureBrowserExtensionBridge();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const response = await fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://gndipignbnipohooclcbhjliikamjlpl",
      "x-codexpro-extension": "profile-bridge-v1"
    },
    body: JSON.stringify({
      profile: {
        id: profileId,
        label: "Stale binding regression",
        version: "0.5.135",
        enabled: true,
        worker_enabled_updated_at: Date.now()
      },
      tabs: [{ id: 101, url: "https://chatgpt.com/c/stale-binding-chat-0001", title: "Stale binding chat", active: true, busy: false, settling: false, network_state: "idle" }]
    })
  });
  assert.equal(response.ok, true, `profile registration failed: ${response.status} ${await response.text()}`);
}

function bootstrapInput(jobId, title) {
  return {
    jobId,
    workerId: profileId,
    title,
    kind: "general",
    taskSize: "small",
    root: staleRoot,
    workspaceId: "ws-stale-binding-regression",
    scope: "workspace",
    agentsFiles: [],
    codexGraphActive: false
  };
}

try {
  await registerIdleProfile();
  await policy.prepareWorkerJob({ jobId: staleTaskId, workerId: profileId, root: staleRoot, scope: "workspace" });
  const staleJob = await policy.bootstrapWorkerJob(bootstrapInput(staleTaskId, "Stale unfinished profile task"));
  assert.equal(staleJob.status, "running");
  bridge.setBrowserExtensionProfileWorkspaceBinding(profileId, staleRoot);
  bridge.setBrowserExtensionProfileWorkspace(profileId, staleRoot);
  bridge.setBrowserExtensionProfileTask(profileId, staleTaskId, staleJob.title);
  await policy.prepareWorkerJob({ jobId: unrelatedTaskId, workerId: unrelatedProfileId, root: unrelatedRoot, scope: "workspace" });
  bridge.setBrowserExtensionProfileWorkspaceBinding(unrelatedProfileId, unrelatedRoot);
  bridge.setBrowserExtensionProfileWorkspace(unrelatedProfileId, unrelatedRoot);
  bridge.setBrowserExtensionProfileTask(unrelatedProfileId, unrelatedTaskId, "Unrelated unfinished profile task");

  const profileBefore = bridge.listBrowserExtensionProfiles().find((profile) => profile.profile_id === profileId);
  assert.equal(profileBefore?.activity, "idle", "fixture worker must be idle while its durable task remains running");
  assert.equal(profileBefore?.current_task_id, staleTaskId, "fixture must expose the stale task as CURRENT");
  assert.equal(profileBefore?.current_workspace_root, staleRoot, "fixture must expose the stale workspace root");
  assert.equal(bridge.getBrowserExtensionProfileTaskBinding(profileId)?.taskId, staleTaskId);
  assert.equal(bridge.getBrowserExtensionProfileWorkspaceBinding(profileId), staleRoot);
  assert.equal(popup.profileWorkerIsIdleForTaskResume(profileBefore), true);
  assert.equal(popup.profileTaskCanResume(policy.workerJobPublicRecord(staleJob), true), true, "stale running task must reproduce the current resumable UI state");

  await policy.prepareWorkerJob({ jobId: nextTaskId, workerId: profileId, root: staleRoot, scope: "workspace" });
  await assert.rejects(
    () => policy.bootstrapWorkerJob(bootstrapInput(nextTaskId, "Fresh replacement profile task")),
    (error) => error?.code === "WORKER_JOB_FIFO_WAIT" && error?.details?.queued_behind_task_id === staleTaskId,
    "a fresh begin/bootstrap must be blocked by the stale running task"
  );

  const definitions = createWorkerJobToolDefinitions({
    serverKey: {},
    resolveProfileId: (_serverKey, taskId) => policy.readWorkerJob(taskId)?.workerId === profileId ? profileId : "",
    textResult: (_text, structuredContent) => structuredContent,
    readOnlyAnnotations: {},
    handoffWriteAnnotations: {}
  });
  const finalize = definitions.find((definition) => definition.name === "finalize_worker_job");
  assert.ok(finalize, "finalize_worker_job definition must exist");
  const finalized = await finalize.handler({
    task_id: staleTaskId,
    outcome: "cancelled",
    summary: "Explicitly abandoned from the Manager task popup"
  });
  assert.equal(finalized?.job?.status, "cancelled", "abandonment must use the sanctioned cancelled terminal state");

  const profileAfter = bridge.listBrowserExtensionProfiles().find((profile) => profile.profile_id === profileId);
  assert.equal(bridge.getBrowserExtensionProfileTaskBinding(profileId), undefined, "terminal abandonment must clear the exact task binding immediately");
  assert.equal(bridge.getBrowserExtensionProfileWorkspaceBinding(profileId), "", "terminal abandonment must clear the exact workspace binding immediately");
  assert.equal(profileAfter?.current_task_id, "", "terminal abandonment must clear current_task_id");
  assert.equal(profileAfter?.current_workspace_root, "", "terminal abandonment must clear current_workspace_root together with current_task_id");
  assert.equal(bridge.getBrowserExtensionProfileTaskBinding(unrelatedProfileId)?.taskId, unrelatedTaskId, "abandonment must not clear another profile's task binding");
  assert.equal(bridge.getBrowserExtensionProfileWorkspaceBinding(unrelatedProfileId), unrelatedRoot, "abandonment must not clear another profile's workspace binding");

  const cancelledJob = policy.workerJobPublicRecord(policy.readWorkerJob(staleTaskId));
  const unrelatedFailed = {
    job_id: "cpt_333333333333333333333333",
    worker_id: profileId,
    title: "Unrelated failed resumable task",
    status: "failed",
    completion_confirmed: false,
    updated_at: new Date().toISOString()
  };
  const popupJobs = popup.profileTaskJobsForWorker([cancelledJob, unrelatedFailed], profileId, "");
  assert.deepEqual(popupJobs.map((job) => job.job_id), [unrelatedFailed.job_id], "abandoned cancelled task must disappear while unrelated failed/resumable tasks remain");
  assert.equal(popup.profileTaskCanResume(unrelatedFailed, true), true, "unrelated failed task must remain resumable");

  const freshJob = await policy.bootstrapWorkerJob(bootstrapInput(nextTaskId, "Fresh replacement profile task"));
  assert.equal(freshJob.status, "running", "worker must accept a fresh task after exact stale abandonment");
  console.log("✓ stale task abandonment clears exact binding and releases FIFO without hiding unrelated resumable failures");
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.exit(0);
