import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexProError } from "../dist/guard.js";
import { createRepoTaskRuntime } from "../dist/repoTaskRuntime.js";
import { registerRepoTaskTools } from "../dist/repoTaskTools.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-repo-task-tools-"));
const repoRoot = path.join(tempRoot, "repo");
const otherRoot = path.join(tempRoot, "other");
const worktreeRoot = path.join(tempRoot, "worktree");
fs.mkdirSync(repoRoot, { recursive: true });
fs.mkdirSync(otherRoot, { recursive: true });
fs.mkdirSync(worktreeRoot, { recursive: true });

const now = "2026-01-01T00:00:00.000Z";
const rules = { path: "C:/fixture/.codexpro/CODEXPRO.md", text: "rule line", sha256: "rules-v1", source: "file" };
const graph = {
  required: true,
  active: true,
  cache_key: "graph-key",
  cache_hit: false,
  fingerprint: "graph-fingerprint",
  coverage: { symbolCount: 10, relationshipCount: 20 },
  warnings: []
};
const context = { text: "AGENTS fixture", agentsFiles: ["AGENTS.md"] };

function makeJob(overrides = {}) {
  return {
    policyVersion: "worker-policy-v2",
    jobId: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa",
    workerId: "profile-a",
    status: "running",
    scope: "workspace",
    root: repoRoot,
    title: "Valid Four Word Task",
    kind: "code",
    taskSize: "small",
    workspaceId: "ws-repo",
    preparedAt: now,
    fifoQueuedAt: now,
    startedAt: now,
    updatedAt: now,
    rulesHash: rules.sha256,
    rulesPath: rules.path,
    agentsFiles: context.agentsFiles,
    agentsHash: "agents-hash",
    codexGraphActive: true,
    codexGraphSymbolCount: 10,
    codexGraphRelationshipCount: 20,
    requiredObligations: [],
    completedObligations: [],
    progressPercent: 25,
    checklist: [],
    completedParts: [],
    remainingParts: [],
    progressSequence: 1,
    events: [{ at: now, type: "bootstrapped", details: {} }],
    ...overrides
  };
}

function makeFixture({ profileId = "profile-a", requireRepoTask = true, workspaceId = "ws-repo" } = {}) {
  const jobs = new Map();
  const events = [];
  const pendingOwners = new Map();
  const taskBindings = new Map();
  const workspaceBindings = new Map();
  const coordinationByRoot = new Map();
  const registered = new Map();
  const counters = {
    prepare: 0,
    bootstrap: 0,
    resume: 0,
    graph: 0,
    context: 0,
    rules: 0,
    registerWorkspace: 0,
    verifyWorkspace: 0
  };
  let selectedBrowserProfile = profileId;
  let workspaceIdResolver = () => workspaceId;
  let resumeBarrier;
  let recoveryResolution;

  const workspaces = {
    openWorkspace(root) {
      const resolved = path.resolve(root || repoRoot);
      return { id: workspaceIdResolver(resolved), root: resolved, openedAt: now };
    }
  };
  const server = {};
  const runtime = createRepoTaskRuntime({
    readWorkerJob: (taskId) => jobs.get(taskId),
    readGlobalRulesSnapshotSync: () => rules,
    readWorkspaceCoordination: (root) => coordinationByRoot.get(root) ?? { tasks: {} }
  });
  runtime.configureServer(server, {
    requireRepoTask,
    ...(profileId ? { profileId } : {}),
    workspaceSelector: (root) => workspaces.openWorkspace(root)
  });

  const dependencies = {
    readGlobalRulesSnapshot: async () => {
      counters.rules += 1;
      return rules;
    },
    readGlobalRulesSnapshotSync: () => rules,
    readCodexContext: async () => {
      counters.context += 1;
      return context;
    },
    getBrowserExtensionPendingTaskOwner: (taskId) => pendingOwners.get(taskId),
    getBrowserExtensionProfileTaskBinding: (id) => taskBindings.get(id),
    getBrowserExtensionProfileWorkspaceBinding: (id) => workspaceBindings.get(id) || "",
    getBrowserExtensionTaskOwners: (taskId) => [...taskBindings.entries()]
      .filter(([, binding]) => binding?.taskId === taskId)
      .map(([id]) => ({ profile_id: id })),
    listBrowserExtensionProfiles: () => selectedBrowserProfile ? [{ profile_id: selectedBrowserProfile, connected: true }] : [],
    recordBrowserProfileTaskEvent: (type, payload) => events.push({ type, payload }),
    setBrowserExtensionProfilePendingTask: (id, taskId, root, scope, preparedAt) => {
      pendingOwners.set(taskId, { profile_id: id, task_id: taskId, root, scope, prepared_at: new Date(preparedAt).toISOString() });
    },
    setBrowserExtensionProfileTask: (id, taskId, title) => {
      taskBindings.set(id, { taskId, title });
    },
    prepareWorkerJob: async (input) => {
      counters.prepare += 1;
      const job = makeJob({
        jobId: input.jobId,
        workerId: input.workerId,
        status: "prepared",
        scope: input.scope,
        root: input.root || "",
        title: "Prepared Manager Task",
        kind: "general",
        workspaceId: "",
        codexGraphActive: false,
        events: [{ at: now, type: "prepared", details: {} }]
      });
      jobs.set(input.jobId, job);
      return job;
    },
    listWorkerJobs: ({ statuses }) => [...jobs.values()].filter((job) => !statuses || statuses.includes(job.status)),
    readPreparedWorkerJob: (taskId) => jobs.get(taskId)?.status === "prepared" ? jobs.get(taskId) : undefined,
    readWorkerJob: (taskId) => jobs.get(taskId),
    bootstrapWorkerJob: async (input) => {
      counters.bootstrap += 1;
      const job = makeJob({
        jobId: input.jobId,
        workerId: input.workerId,
        status: "running",
        scope: input.scope,
        root: input.root,
        title: input.title,
        kind: input.kind,
        taskSize: input.taskSize,
        workspaceId: input.workspaceId,
        rulesHash: input.rulesHash,
        rulesPath: input.rulesPath,
        agentsFiles: input.agentsFiles || [],
        agentsHash: input.agentsHash,
        codexGraphActive: input.codexGraphActive,
        codexGraphSymbolCount: input.codexGraphSymbolCount,
        codexGraphRelationshipCount: input.codexGraphRelationshipCount,
        events: [{ at: now, type: "bootstrapped", details: {} }]
      });
      jobs.set(input.jobId, job);
      return job;
    },
    resumeWorkerJob: async (input) => {
      counters.resume += 1;
      if (resumeBarrier) await resumeBarrier.promise;
      const current = jobs.get(input.jobId);
      const job = { ...current, rulesHash: input.rulesHash, rulesPath: input.rulesPath, agentsFiles: input.agentsFiles, agentsHash: input.agentsHash };
      jobs.set(input.jobId, job);
      return { record: job, deduplicated: false, rulesChanged: false };
    },
    workerJobHasLegacyStaleCancellation: () => false,
    classifiedWorkerJobPublicRecord: (job) => job ? { job_id: job.jobId, status: job.status, policy_version: job.policyVersion } : undefined,
    readWorkspaceCoordination: (root) => coordinationByRoot.get(root) ?? { tasks: {} },
    registerWorkspaceTask: async (input) => {
      counters.registerWorkspace += 1;
      const task = { taskId: input.taskId, status: "running", worktreeRoot, worktreeBranch: `codexpro/task/${input.taskId}`, integrationStatus: "idle" };
      coordinationByRoot.set(input.root, { tasks: { [input.taskId]: task } });
      return task;
    },
    resolveWorkspaceTaskRootByTaskId: () => recoveryResolution ?? { root: repoRoot, task: { status: "running", worktreeRoot: repoRoot, worktreeBranch: "codexpro/task/recovery" } },
    verifyWorkspaceTaskResume: async ({ taskId, root }) => {
      counters.verifyWorkspace += 1;
      return { taskId, status: "running", worktreeRoot, worktreeBranch: `codexpro/task/${taskId}`, root };
    },
    withVerifiedWorkspaceTaskResume: async (_context, _verified, fn) => await fn()
  };

  const registerCodexTool = (_config, _server, name, options, handler) => registered.set(name, { options, handler });
  registerRepoTaskTools({
    config: { defaultRoot: repoRoot },
    server,
    workspaces,
    guard: {},
    requireRepoTask,
    registerCodexTool,
    runtime,
    requireCodexGraphForWorkspace: async () => {
      counters.graph += 1;
      return graph;
    },
    setBrowserProfileId: (id) => { selectedBrowserProfile = id; },
    annotations: { readOnly: { readOnlyHint: true }, sessionRead: { readOnlyHint: true }, handoffWrite: { readOnlyHint: false } },
    dependencies
  });

  return {
    server,
    runtime,
    registered,
    jobs,
    events,
    pendingOwners,
    taskBindings,
    workspaceBindings,
    coordinationByRoot,
    counters,
    workspaces,
    dependencies,
    setWorkspaceIdResolver(fn) { workspaceIdResolver = fn; },
    setResumeBarrier(barrier) { resumeBarrier = barrier; },
    setRecoveryResolution(value) { recoveryResolution = value; },
    selectedBrowserProfile: () => selectedBrowserProfile
  };
}

function expectCode(error, code) {
  return error instanceof CodexProError && error.code === code;
}

try {
  // PREPARE: workspace, all_allowed, exact missing-root failure, pending binding, event payload.
  const manager = makeFixture({ profileId: "", requireRepoTask: false });
  assert.deepEqual([...manager.registered.keys()].slice(0, 4), ["prepare_repo_task", "begin_repo_task", "resume_repo_task", "repo_task_status"]);
  await assert.rejects(
    manager.registered.get("prepare_repo_task").handler({ profile_id: "profile-p", task_id: "cpt_111111111111111111111111", scope: "workspace" }),
    (error) => expectCode(error, "REPO_TASK_ROOT_REQUIRED") && error.message === "REPO_TASK_ROOT_REQUIRED: workspace-scoped Manager tasks must prepare an exact root."
  );
  const preparedWorkspace = await manager.registered.get("prepare_repo_task").handler({
    profile_id: "profile-p",
    task_id: "cpt_121212121212121212121212",
    root: repoRoot,
    scope: "workspace"
  });
  assert.equal(preparedWorkspace.structuredContent.prepared, true);
  assert.equal(preparedWorkspace.structuredContent.root, path.resolve(repoRoot));
  assert.equal(preparedWorkspace.structuredContent.root_unbound, false);
  assert.equal(manager.runtime.expectedRepoTask("profile-p")?.taskId, "cpt_121212121212121212121212");
  assert.equal(manager.pendingOwners.get("cpt_121212121212121212121212")?.profile_id, "profile-p");
  assert.equal(manager.events.at(-1)?.type, "repo_task_prepared");
  assert.equal(manager.events.at(-1)?.payload.scope, "workspace");
  const preparedAll = await manager.registered.get("prepare_repo_task").handler({
    profile_id: "profile-q",
    task_id: "cpt_131313131313131313131313",
    scope: "all_allowed"
  });
  assert.equal(preparedAll.structuredContent.root, undefined);
  assert.equal(preparedAll.structuredContent.root_unbound, true);
  assert.equal(preparedAll.structuredContent.scope, "all_allowed");

  // BEGIN: Manager-prepared code task, memory status, and exact runtime binding.
  const beginFixture = makeFixture({ profileId: "profile-a", requireRepoTask: true });
  const beginId = "cpt_222222222222222222222222";
  beginFixture.runtime.rememberExpectedRepoTask("profile-a", { taskId: beginId, root: repoRoot, scope: "workspace" });
  const begun = await beginFixture.registered.get("begin_repo_task").handler({
    task_id: beginId,
    task_title: "Extract Repo Task Tools",
    task_kind: "code",
    task_size: "small",
    root: repoRoot,
    scope: "workspace"
  });
  assert.equal(begun.structuredContent.verified, true);
  assert.equal(begun.structuredContent.gate_active, true);
  assert.equal(begun.structuredContent.profile_id, "profile-a");
  assert.equal(begun.structuredContent.root, path.resolve(repoRoot));
  assert.equal(begun.structuredContent.task_source, "manager");
  assert.equal(begun.structuredContent.codexgraph_active, true);
  assert.equal(beginFixture.counters.bootstrap, 1);
  assert.equal(beginFixture.counters.graph, 1);
  assert.equal(beginFixture.counters.context, 1);
  assert.equal(beginFixture.events.some((entry) => entry.type === "repo_task_started"), true);
  assert.equal(beginFixture.runtime.activeRepoTaskForProfile("profile-a")?.taskId, beginId);
  const memoryStatus = await beginFixture.registered.get("repo_task_status").handler({ task_id: beginId });
  assert.equal(memoryStatus.structuredContent.verified, true);
  assert.equal(memoryStatus.structuredContent.verification_source, "memory");
  assert.equal(memoryStatus.structuredContent.gate_active, true);

  // BEGIN direct task keeps direct task-id generation semantics and no repo gate for general work.
  const direct = makeFixture({ profileId: "profile-direct", requireRepoTask: true });
  const directResult = await direct.registered.get("begin_repo_task").handler({
    task_title: "Handle Direct General Request",
    task_kind: "general",
    task_size: "small"
  });
  assert.match(directResult.structuredContent.task_id, /^cpt_[a-f0-9]{24}$/);
  assert.equal(directResult.structuredContent.task_source, "chatgpt_direct");
  assert.equal(directResult.structuredContent.gate_active, false);
  assert.equal(directResult.structuredContent.workspace_access, false);

  // Prepared owner reroute remains authoritative over the session-bound profile.
  const reroute = makeFixture({ profileId: "profile-old", requireRepoTask: true });
  const rerouteId = "cpt_333333333333333333333333";
  reroute.runtime.rememberExpectedRepoTask("profile-new", { taskId: rerouteId, root: repoRoot, scope: "workspace" });
  const rerouted = await reroute.registered.get("begin_repo_task").handler({
    task_id: rerouteId,
    task_title: "Reroute Prepared Task Owner",
    task_kind: "general",
    task_size: "small",
    root: repoRoot,
    scope: "workspace"
  });
  assert.equal(rerouted.structuredContent.profile_id, "profile-new");
  assert.equal(rerouted.structuredContent.profile_rerouted, true);
  assert.equal(reroute.selectedBrowserProfile(), "profile-new");
  assert.equal(reroute.events.some((entry) => entry.type === "repo_task_profile_rerouted"), true);

  // Exact mismatch/scope/root/all_allowed fail-closed behavior.
  const rejectFixture = makeFixture({ profileId: "profile-reject", requireRepoTask: true });
  rejectFixture.runtime.rememberExpectedRepoTask("profile-reject", { taskId: "cpt_444444444444444444444444", root: repoRoot, scope: "workspace" });
  await assert.rejects(
    rejectFixture.registered.get("begin_repo_task").handler({ task_id: "cpt_454545454545454545454545", task_title: "Reject Wrong Task Identifier", task_kind: "general", task_size: "small", root: repoRoot, scope: "workspace" }),
    (error) => expectCode(error, "REPO_TASK_MISMATCH") && error.details?.expected_task_id === "cpt_444444444444444444444444"
  );
  await assert.rejects(
    rejectFixture.registered.get("begin_repo_task").handler({ task_id: "cpt_444444444444444444444444", task_title: "Reject Wrong Task Scope", task_kind: "general", task_size: "small", root: repoRoot, scope: "all_allowed" }),
    (error) => expectCode(error, "REPO_TASK_MISMATCH") && error.details?.received_scope === "all_allowed"
  );
  await assert.rejects(
    rejectFixture.registered.get("begin_repo_task").handler({ task_id: "cpt_444444444444444444444444", task_title: "Reject Wrong Repository Root", task_kind: "general", task_size: "small", root: otherRoot, scope: "workspace" }),
    (error) => expectCode(error, "REPO_TASK_ROOT_MISMATCH") && error.details?.expected_root === path.resolve(repoRoot)
  );
  const allAllowedReject = makeFixture({ profileId: "profile-all", requireRepoTask: true });
  const allId = "cpt_464646464646464646464646";
  allAllowedReject.runtime.rememberExpectedRepoTask("profile-all", { taskId: allId, scope: "all_allowed" });
  await assert.rejects(
    allAllowedReject.registered.get("begin_repo_task").handler({ task_id: allId, task_title: "Require Explicit Allowed Root", task_kind: "code", task_size: "small", scope: "all_allowed" }),
    (error) => expectCode(error, "REPO_TASK_ROOT_REQUIRED") && error.details?.scope === "all_allowed"
  );

  // Prepared lifecycle recovery uses the authoritative existing coordination task instead of registering a new one.
  const recovery = makeFixture({ profileId: "profile-recovery", requireRepoTask: true });
  const recoveryId = "cpt_555555555555555555555555";
  recovery.runtime.rememberExpectedRepoTask("profile-recovery", { taskId: recoveryId, root: repoRoot, scope: "workspace" });
  recovery.jobs.set(recoveryId, makeJob({
    jobId: recoveryId,
    workerId: "profile-recovery",
    status: "prepared",
    scope: "workspace",
    root: repoRoot,
    kind: "code",
    codexGraphActive: true
  }));
  recovery.setRecoveryResolution({
    root: path.join(tempRoot, "coordination-root"),
    task: { status: "running", worktreeRoot: repoRoot, worktreeBranch: "codexpro/task/recovery", integrationStatus: "idle" }
  });
  const recoveredBegin = await recovery.registered.get("begin_repo_task").handler({
    task_id: recoveryId,
    task_title: "Recover Prepared Lifecycle Task",
    task_kind: "code",
    task_size: "small",
    root: repoRoot,
    scope: "workspace"
  });
  assert.equal(recoveredBegin.structuredContent.prepared_recovery, true);
  assert.equal(recoveredBegin.structuredContent.coordination_root, path.join(tempRoot, "coordination-root"));
  assert.equal(recovery.counters.registerWorkspace, 0);

  // RESUME already-active gate short-circuit: no resumeWorkerJob replay.
  const activeResume = makeFixture({ profileId: "profile-active", requireRepoTask: true });
  const activeId = "cpt_666666666666666666666666";
  const activeJob = makeJob({ jobId: activeId, workerId: "profile-active", root: repoRoot, workspaceId: "ws-repo" });
  activeResume.jobs.set(activeId, activeJob);
  activeResume.runtime.rememberExpectedRepoTask("profile-active", { taskId: activeId, root: repoRoot, scope: "workspace" });
  activeResume.runtime.setActiveRepoTaskForProfile("profile-active", {
    taskId: activeId,
    taskTitle: activeJob.title,
    root: repoRoot,
    workspaceId: "ws-repo",
    scope: "workspace",
    globalRulesSha256: rules.sha256,
    worktreeRoot,
    worktreeBranch: "codexpro/task/active"
  });
  const gateReady = await activeResume.registered.get("resume_repo_task").handler({ task_id: activeId });
  assert.equal(gateReady.structuredContent.gate_already_active, true);
  assert.equal(gateReady.structuredContent.resume_deduplicated, true);
  assert.equal(activeResume.counters.resume, 0);

  // RESUME durable path refreshes rules/context/graph, restores runtime state and emits resume event.
  const durableResume = makeFixture({ profileId: "profile-resume", requireRepoTask: true });
  const resumeId = "cpt_777777777777777777777777";
  durableResume.jobs.set(resumeId, makeJob({ jobId: resumeId, workerId: "profile-resume", root: repoRoot, workspaceId: "ws-repo" }));
  const resumed = await durableResume.registered.get("resume_repo_task").handler({ task_id: resumeId });
  assert.equal(resumed.structuredContent.resumed, true);
  assert.equal(resumed.structuredContent.gate_active, true);
  assert.equal(durableResume.counters.resume, 1);
  assert.equal(durableResume.counters.rules, 1);
  assert.equal(durableResume.counters.context, 1);
  assert.equal(durableResume.counters.graph, 1);
  assert.equal(durableResume.runtime.activeRepoTaskForProfile("profile-resume")?.taskId, resumeId);
  assert.equal(durableResume.events.some((entry) => entry.type === "repo_task_resumed"), true);

  // Concurrent resume calls share one in-flight recovery and mark the follower deduplicated.
  const concurrent = makeFixture({ profileId: "profile-concurrent", requireRepoTask: true });
  const concurrentId = "cpt_888888888888888888888888";
  concurrent.jobs.set(concurrentId, makeJob({ jobId: concurrentId, workerId: "profile-concurrent", root: repoRoot, workspaceId: "ws-repo" }));
  let releaseBarrier;
  const barrier = { promise: new Promise((resolve) => { releaseBarrier = resolve; }) };
  concurrent.setResumeBarrier(barrier);
  const firstResume = concurrent.registered.get("resume_repo_task").handler({ task_id: concurrentId });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const secondResume = concurrent.registered.get("resume_repo_task").handler({ task_id: concurrentId });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(concurrent.counters.resume, 1, "concurrent resume must have one resumeWorkerJob call while first recovery is in flight");
  releaseBarrier();
  const [firstConcurrent, secondConcurrent] = await Promise.all([firstResume, secondResume]);
  assert.equal(firstConcurrent.structuredContent.resumed, true);
  assert.equal(secondConcurrent.structuredContent.resume_deduplicated, true);
  assert.equal(concurrent.counters.resume, 1);

  // Historical workspace identity mismatch remains fail-closed and unchanged.
  const mismatch = makeFixture({ profileId: "profile-mismatch", requireRepoTask: true, workspaceId: "ws-current" });
  const mismatchId = "cpt_999999999999999999999999";
  mismatch.jobs.set(mismatchId, makeJob({ jobId: mismatchId, workerId: "profile-mismatch", root: repoRoot, workspaceId: "ws-saved" }));
  await assert.rejects(
    mismatch.registered.get("resume_repo_task").handler({ task_id: mismatchId }),
    (error) => expectCode(error, "REPO_TASK_RESUME_WORKSPACE_MISMATCH")
      && error.message === "REPO_TASK_RESUME_WORKSPACE_MISMATCH: repository identity changed since the task began."
      && error.details?.saved_workspace_id === "ws-saved"
      && error.details?.current_workspace_id === "ws-current"
  );

  // STATUS durable proof and missing proof behavior.
  const statusFixture = makeFixture({ profileId: "profile-status", requireRepoTask: true });
  const durableId = "cpt_aaaaaaaaaaaaaaaaaaaaaaab";
  statusFixture.jobs.set(durableId, makeJob({
    jobId: durableId,
    workerId: "profile-status",
    title: "Durable Status Proof Task",
    status: "running",
    kind: "code",
    requiredObligations: ["global_rules", "agents_chain"],
    completedObligations: ["global_rules", "agents_chain"]
  }));
  const durableStatus = await statusFixture.registered.get("repo_task_status").handler({ task_id: durableId });
  assert.equal(durableStatus.structuredContent.verified, true);
  assert.equal(durableStatus.structuredContent.verification_source, "worker_job");
  assert.equal(durableStatus.structuredContent.task_title, "Durable Status Proof Task");
  const missingId = "cpt_bbbbbbbbbbbbbbbbbbbbbbbb";
  const missingStatus = await statusFixture.registered.get("repo_task_status").handler({ task_id: missingId });
  assert.equal(missingStatus.structuredContent.verified, false);
  assert.equal(missingStatus.structuredContent.verification_source, undefined);
  assert.match(missingStatus.content[0].text, /Profile Task Missing/);

  console.log("repo-task-tools smoke passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
