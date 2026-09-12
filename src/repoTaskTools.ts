import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { CodexProError, type PathGuard, type Workspace, type WorkspaceManager } from "./guard.js";
import { readGlobalRulesSnapshot, readGlobalRulesSnapshotSync, withGlobalRules } from "./globalRules.js";
import type { createRepoTaskRuntime, ActiveRepoTask, ExpectedRepoTask } from "./repoTaskRuntime.js";
import { toolCardMeta } from "./toolCardRegistration.js";
import { textResult } from "./toolResults.js";
import type { CodexToolHandler } from "./toolRegistration.js";
import { readCodexContext } from "./workspaceOps.js";
import {
  getBrowserExtensionPendingTaskOwner,
  getBrowserExtensionProfileTaskBinding,
  getBrowserExtensionProfileWorkspaceBinding,
  getBrowserExtensionTaskOwners,
  listBrowserExtensionProfiles,
  recordBrowserProfileTaskEvent,
  setBrowserExtensionProfilePendingTask,
  setBrowserExtensionProfileTask
} from "./browserExtensionBridge.js";
import {
  bootstrapWorkerJob,
  listWorkerJobs,
  prepareWorkerJob,
  readPreparedWorkerJob,
  readWorkerJob,
  resumeWorkerJob,
  workerJobHasLegacyStaleCancellation,
  type WorkerJobRecord,
  WORKER_POLICY_VERSION
} from "./workerPolicy.js";
import { classifiedWorkerJobPublicRecord } from "./workerJobTools.js";
import { syncAuthoritativeTaskTracking } from "./taskTrackingReconciliation.js";
import {
  readWorkspaceCoordination,
  registerWorkspaceTask,
  resolveWorkspaceTaskRootByTaskId,
  verifyWorkspaceTaskResume,
  withVerifiedWorkspaceTaskResume,
  type ResolvedWorkspaceTaskRoot
} from "./workspaceCoordination.js";

const defaultDependencies = {
  readGlobalRulesSnapshot,
  readGlobalRulesSnapshotSync,
  withGlobalRules,
  textResult,
  toolCardMeta,
  readCodexContext,
  getBrowserExtensionPendingTaskOwner,
  getBrowserExtensionProfileTaskBinding,
  getBrowserExtensionProfileWorkspaceBinding,
  getBrowserExtensionTaskOwners,
  listBrowserExtensionProfiles,
  recordBrowserProfileTaskEvent,
  setBrowserExtensionProfilePendingTask,
  setBrowserExtensionProfileTask,
  bootstrapWorkerJob,
  listWorkerJobs,
  prepareWorkerJob,
  readPreparedWorkerJob,
  readWorkerJob,
  resumeWorkerJob,
  workerJobHasLegacyStaleCancellation,
  classifiedWorkerJobPublicRecord,
  readWorkspaceCoordination,
  registerWorkspaceTask,
  resolveWorkspaceTaskRootByTaskId,
  verifyWorkspaceTaskResume,
  withVerifiedWorkspaceTaskResume
};

const WORKER_PROFILE_ID_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,159}|[a-z0-9][a-z0-9._-]{0,63}:[A-Za-z0-9][A-Za-z0-9._-]{0,94})$/;
const repoTaskRuntimeResumeKey = `runtime-${process.pid}-${randomBytes(8).toString("hex")}`;

type ResumeResult = {
  taskId: string;
  profileId: string;
  root: string;
  workspaceId: string;
  scope: "workspace" | "all_allowed";
  taskTitle: string;
  globalRulesSha256: string;
  worktreeRoot: string;
  worktreeBranch?: string;
  workerJob: WorkerJobRecord;
  deduplicated: boolean;
  rulesChanged: boolean;
  ownerBindingRecovered: boolean;
};

const repoTaskResumeTails = new Map<string, Promise<ResumeResult>>();

type RepoTaskProof = {
  taskId: string;
  taskTitle: string;
  taskKind: "general" | "code";
  taskSize?: "small" | "medium" | "large";
  taskSource: "manager" | "chatgpt_direct";
  root: string;
  workspaceId: string;
  startedAt: string;
  scope: "workspace" | "all_allowed";
  globalRulesPath?: string;
  globalRulesSha256?: string;
  globalRulesLoadedAt?: string;
  agentsFiles?: string[];
  agentsSha256?: string;
  codexGraph?: any;
};

const repoTaskProofs = new Map<string, RepoTaskProof>();

function durableRepoTaskProof(job: WorkerJobRecord | undefined, taskId: string, profileId: string): WorkerJobRecord | undefined {
  if (!job || job.jobId !== taskId || job.status === "prepared") return undefined;
  if (job.kind !== "general" && job.kind !== "code") return undefined;
  const titleWordCount = job.title.trim().split(/\s+/).filter(Boolean).length;
  if (titleWordCount < 4 || titleWordCount > 6) return undefined;
  if (!job.events.some((event) => event.type === "bootstrapped")) return undefined;
  if (job.requiredObligations.some((obligation) => !job.completedObligations.includes(obligation))) return undefined;
  const normalizeOwner = (value: string) => value.trim().replace(/^browser:/, "");
  if (profileId && normalizeOwner(job.workerId) !== normalizeOwner(profileId)) return undefined;
  return job;
}

function rememberRepoTaskProof(proof: RepoTaskProof): void {
  repoTaskProofs.set(proof.taskId, proof);
  if (repoTaskProofs.size <= 500) return;
  for (const taskId of [...repoTaskProofs.keys()].slice(0, repoTaskProofs.size - 400)) repoTaskProofs.delete(taskId);
}

function isPreparedLifecycleRecovery(job: WorkerJobRecord | undefined): job is WorkerJobRecord {
  return Boolean(
    job
    && job.status === "prepared"
    && job.kind === "code"
    && (job.codexGraphActive || job.events.some((entry) => entry.type === "bootstrapped"))
  );
}

type RepoTaskRuntime = ReturnType<typeof createRepoTaskRuntime>;
type RegisterCodexTool = (
  config: CodexProConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: CodexToolHandler
) => void;

type RepoTaskToolAnnotations = {
  readOnly: Record<string, unknown>;
  sessionRead: Record<string, unknown>;
  handoffWrite: Record<string, unknown>;
};

type RepoTaskToolsOptions = {
  config: CodexProConfig;
  server: McpServer;
  workspaces: WorkspaceManager;
  guard: PathGuard;
  requireRepoTask: boolean;
  registerCodexTool: RegisterCodexTool;
  runtime: RepoTaskRuntime;
  requireCodexGraphForWorkspace: (config: CodexProConfig, guard: PathGuard, workspace: Workspace) => Promise<any>;
  setBrowserProfileId: (profileId: string) => void;
  annotations: RepoTaskToolAnnotations;
  dependencies?: Partial<typeof defaultDependencies>;
};

export function registerRepoTaskTools(options: RepoTaskToolsOptions): void {
  const {
    config,
    server,
    workspaces,
    guard,
    requireRepoTask,
    registerCodexTool,
    runtime,
    requireCodexGraphForWorkspace,
    setBrowserProfileId,
    annotations
  } = options;
  const {
    readGlobalRulesSnapshot,
    readGlobalRulesSnapshotSync,
    withGlobalRules,
    textResult,
    toolCardMeta,
    readCodexContext,
    getBrowserExtensionPendingTaskOwner,
    getBrowserExtensionProfileTaskBinding,
    getBrowserExtensionProfileWorkspaceBinding,
    getBrowserExtensionTaskOwners,
    listBrowserExtensionProfiles,
    recordBrowserProfileTaskEvent,
    setBrowserExtensionProfilePendingTask,
    setBrowserExtensionProfileTask,
    bootstrapWorkerJob,
    listWorkerJobs,
    prepareWorkerJob,
    readPreparedWorkerJob,
    readWorkerJob,
    resumeWorkerJob,
    workerJobHasLegacyStaleCancellation,
    classifiedWorkerJobPublicRecord,
    readWorkspaceCoordination,
    registerWorkspaceTask,
    resolveWorkspaceTaskRootByTaskId,
    verifyWorkspaceTaskResume,
    withVerifiedWorkspaceTaskResume
  } = { ...defaultDependencies, ...options.dependencies };
  const {
    profileIdForServer: repoTaskProfileIdForServer,
    setProfileIdForServer: setRepoTaskProfileIdForServer,
    sameResolvedRoot,
    expectedRepoTask,
    expectedRepoTaskOwner,
    rememberExpectedRepoTask,
    repoTaskRootMatches,
    sameRepoTask,
    activeRepoTaskForProfile,
    setActiveRepoTaskForProfile,
    clearActiveRepoTaskForProfile,
    activeRepoTaskForServer,
    setActiveRepoTaskForServer,
    clearActiveRepoTaskForServer,
    repoTaskWorktree
  } = runtime;

  function resolvePreparedLifecycleRecovery(input: {
    taskId: string;
    workerId: string;
    preparedJob: WorkerJobRecord;
    requestedRoot: string;
    scope: "workspace" | "all_allowed";
  }): ResolvedWorkspaceTaskRoot {
    const normalizeOwner = (value: string) => String(value || "").trim().replace(/^browser:/, "");
    if (normalizeOwner(input.preparedJob.workerId) !== normalizeOwner(input.workerId)) {
      throw new CodexProError("REPO_TASK_PREPARED_OWNER_MISMATCH: prepared WorkerJob belongs to another worker.", {
        code: "REPO_TASK_PREPARED_OWNER_MISMATCH",
        details: { task_id: input.taskId, prepared_worker_id: input.preparedJob.workerId, received_worker_id: input.workerId }
      });
    }
    if (input.preparedJob.scope !== input.scope) {
      throw new CodexProError("REPO_TASK_PREPARED_SCOPE_MISMATCH: prepared WorkerJob scope changed before recovery.", {
        code: "REPO_TASK_PREPARED_SCOPE_MISMATCH",
        details: { task_id: input.taskId, prepared_scope: input.preparedJob.scope, received_scope: input.scope }
      });
    }
    if (!input.preparedJob.root || !sameResolvedRoot(input.preparedJob.root, input.requestedRoot)) {
      throw new CodexProError("REPO_TASK_PREPARED_ROOT_MISMATCH: prepared WorkerJob root does not match the Manager-prepared execution root.", {
        code: "REPO_TASK_PREPARED_ROOT_MISMATCH",
        details: { task_id: input.taskId, prepared_root: input.preparedJob.root || null, received_root: input.requestedRoot }
      });
    }
    const resolved = resolveWorkspaceTaskRootByTaskId({
      taskId: input.taskId,
      rootHint: input.requestedRoot,
      workerId: input.workerId,
      requireUniqueMatch: true
    });
    if (resolved.task.status !== "running") {
      throw new CodexProError(`WORKSPACE_TASK_NOT_ACTIVE: ${input.taskId} is not an active running workspace task.`, {
        code: "WORKSPACE_TASK_NOT_ACTIVE",
        details: { task_id: input.taskId, workspace_root: resolved.root, status: resolved.task.status }
      });
    }
    if (!resolved.task.worktreeRoot || !sameResolvedRoot(resolved.task.worktreeRoot, input.requestedRoot)) {
      throw new CodexProError("REPO_TASK_PREPARED_WORKTREE_MISMATCH: Manager-prepared execution root does not match the authoritative task worktree.", {
        code: "REPO_TASK_PREPARED_WORKTREE_MISMATCH",
        details: {
          task_id: input.taskId,
          coordination_root: resolved.root,
          authoritative_worktree_root: resolved.task.worktreeRoot || null,
          prepared_root: input.requestedRoot
        }
      });
    }
    return resolved;
  }

  if (!requireRepoTask) registerCodexTool(
    config,
    server,
    "prepare_repo_task",
    {
      title: "Prepare Manager Repo Task",
      description: "Manager-only control-plane action. Bind the next CodexPro Manager task id/scope to a worker before dispatch. A workspace-scoped task must include root; all_allowed deliberately leaves root unbound so the worker can choose the correct allowed workspace.",
      inputSchema: {
        profile_id: z.string().regex(WORKER_PROFILE_ID_PATTERN).describe("Profile-bound worker id receiving the Manager request. API workers use <plugin>:<worker>; legacy Chrome profile ids remain supported."),
        task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/).describe("Exact task id generated by CodexPro Manager."),
        root: z.string().min(1).optional().describe("Locked workspace root for workspace scope. Omit for all_allowed so the AI chooses the actual workspace."),
        scope: z.enum(["workspace", "all_allowed"]).optional().describe("Task scope. Default: workspace.")
      },
      annotations: annotations.handoffWrite
    },
    async (args) => {
      const scope: "workspace" | "all_allowed" = args.scope === "all_allowed" ? "all_allowed" : "workspace";
      if (scope === "workspace" && !args.root) {
        throw new CodexProError("REPO_TASK_ROOT_REQUIRED: workspace-scoped Manager tasks must prepare an exact root.", { code: "REPO_TASK_ROOT_REQUIRED" });
      }
      const preparedRoot = args.root ? workspaces.openWorkspace(args.root, { select: false }).root : undefined;
      const expected: ExpectedRepoTask = {
        taskId: args.task_id,
        root: scope === "workspace" ? preparedRoot : undefined,
        scope,
        preparedAt: Date.now()
      };
      const workerJob = await prepareWorkerJob({
        jobId: expected.taskId,
        workerId: args.profile_id,
        root: expected.root,
        scope: expected.scope
      });
      const normalizedOwner = (value: string) => value.trim().replace(/^browser:/, "");
      const runningBlocker = listWorkerJobs({ statuses: ["running"], limit: 200 }).find((job) => (
        job.jobId !== expected.taskId && normalizedOwner(job.workerId) === normalizedOwner(args.profile_id)
      ));
      if (!runningBlocker) {
        rememberExpectedRepoTask(args.profile_id, expected);
        setBrowserExtensionProfilePendingTask(args.profile_id, expected.taskId, expected.root || "", expected.scope, expected.preparedAt);
      }
      recordBrowserProfileTaskEvent("repo_task_prepared", {
        profile_id: args.profile_id,
        task_id: expected.taskId,
        root: expected.root,
        scope: expected.scope,
        fifo_queued: Boolean(runningBlocker),
        queued_behind_task_id: runningBlocker?.jobId,
        prepared_at: new Date(expected.preparedAt).toISOString(),
        policy_version: workerJob.policyVersion
      });
      return textResult(`# Repo Task Prepared\n\nProfile: ${args.profile_id}\nTask: ${expected.taskId}\nRoot: ${expected.root || "(AI chooses an allowed workspace)"}\nScope: ${expected.scope}`, {
        prepared: true,
        profile_id: args.profile_id,
        task_id: expected.taskId,
        root: expected.root,
        root_unbound: scope === "all_allowed",
        scope: expected.scope,
        fifo_queued: Boolean(runningBlocker),
        queued_behind_task_id: runningBlocker?.jobId,
        prepared_at: new Date(expected.preparedAt).toISOString()
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "begin_repo_task",
    {
      title: "Register Profile Task",
      description: "Mandatory lightweight first call for every profile-bound worker request. Always provide a clear 4-6 word task_title and classify task_size as small, medium, or large. task_kind only controls MCP workspace access. Medium and large tasks must persist a structured checklist before source writes and completion.",
      inputSchema: {
        task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/).optional().describe("Exact task id included by CodexPro Manager. Omit only for a request typed directly in ChatGPT."),
        task_title: z.string().trim().min(4).max(56)
          .refine((value) => { const words = value.split(/\s+/).filter(Boolean).length; return words >= 4 && words <= 6; }, "Task title must contain 4-6 words.")
          .refine((value) => !/^(?:làm sao|sửa đi|làm đi|fix đi|check lỗi|kiểm tra|tiếp tục)$/iu.test(value.trim()), "Task title must describe the actual work, not a vague request.")
          .describe("Required title chosen and returned by the AI: 4-6 short, clear, natural words describing the actual work."),
        task_kind: z.enum(["general", "code"]).describe("Workspace access mode, not the Manager Task classification. Use general when no source/workspace tool is needed. Use code before reading, changing, building, testing, committing, or pushing in a repository; Manager counts it as a Task only after an actual write/edit/apply_patch source change."),
        task_size: z.enum(["small", "medium", "large"]).optional().describe("Task complexity selected by the worker. Medium and large tasks require a durable checklist before source writes; use large for multi-module, high-risk, architectural, migration, concurrency/recovery, or multi-phase work."),
        root: z.string().min(1).optional().describe("Initial workspace root included by CodexPro Manager. Omit for a direct ChatGPT request to use the profile's locked workspace."),
        scope: z.enum(["workspace", "all_allowed"]).optional().describe("Task scope. Omit or use workspace for a locked workspace; use all_allowed only when Manager explicitly enables all allowed roots.")
      },
      annotations: annotations.sessionRead,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Registering the CodexPro task...",
        "openai/toolInvocation/invoked": "CodexPro task registered"
      }
    },
    async (args) => {
      const sessionProfileId = repoTaskProfileIdForServer(server as object);
      let gateProfileId = sessionProfileId;
      let expected = gateProfileId ? expectedRepoTask(gateProfileId) : undefined;
      const managerPrepared = Boolean(args.task_id);
      const taskId = args.task_id || (gateProfileId ? `cpt_${randomBytes(12).toString("hex")}` : "");
      let preparedOwner = managerPrepared && taskId ? expectedRepoTaskOwner(taskId) : undefined;
      if (managerPrepared && taskId && !preparedOwner) {
        const persistedOwner = getBrowserExtensionPendingTaskOwner(taskId);
        if (persistedOwner) {
          const recoveredExpected = rememberExpectedRepoTask(persistedOwner.profile_id, {
            taskId: persistedOwner.task_id,
            root: persistedOwner.scope === "workspace" ? persistedOwner.root || undefined : undefined,
            scope: persistedOwner.scope
          });
          preparedOwner = { profileId: persistedOwner.profile_id, expected: recoveredExpected };
          if (gateProfileId === persistedOwner.profile_id) expected = recoveredExpected;
          recordBrowserProfileTaskEvent("repo_task_prepared_rehydrated", {
            profile_id: persistedOwner.profile_id,
            session_profile_id: sessionProfileId,
            task_id: taskId,
            root: recoveredExpected.root,
            scope: recoveredExpected.scope,
            prepared_at: persistedOwner.prepared_at,
            reason: "runtime_restart"
          });
        }
      }
      if (managerPrepared && taskId && !preparedOwner) {
        const queuedJob = readWorkerJob(taskId);
        if (queuedJob?.status === "prepared" && queuedJob.workerId) {
          preparedOwner = {
            profileId: queuedJob.workerId.replace(/^browser:/, ""),
            expected: {
              taskId: queuedJob.jobId,
              root: queuedJob.scope === "workspace" ? queuedJob.root || undefined : undefined,
              scope: queuedJob.scope,
              preparedAt: Date.parse(queuedJob.fifoQueuedAt || queuedJob.preparedAt) || Date.now()
            }
          };
        }
      }
      if (preparedOwner && preparedOwner.profileId !== gateProfileId) {
        gateProfileId = preparedOwner.profileId;
        expected = preparedOwner.expected;
        setBrowserProfileId(gateProfileId);
        setRepoTaskProfileIdForServer(server as object, gateProfileId);
        recordBrowserProfileTaskEvent("repo_task_profile_rerouted", {
          task_id: taskId,
          task_title: String(args.task_title || ""),
          session_profile_id: sessionProfileId,
          task_owner_profile_id: gateProfileId,
          reason: "prepared_task_id_owner"
        });
      } else if (preparedOwner) {
        expected = preparedOwner.expected;
      }
      if (managerPrepared && !preparedOwner && !gateProfileId) {
        recordBrowserProfileTaskEvent("repo_task_owner_missing", {
          task_id: taskId,
          task_title: String(args.task_title || ""),
          session_profile_id: sessionProfileId,
          reason: "prepared_task_id_not_found"
        });
        throw new CodexProError(
          "REPO_TASK_NOT_PREPARED: This Manager task id has no owning Chrome profile. Refresh the Manager task and call begin_repo_task with the newly prepared id.",
          { code: "REPO_TASK_NOT_PREPARED", details: { task_id: taskId } }
        );
      }
      const scope: "workspace" | "all_allowed" = managerPrepared && args.scope === "all_allowed" ? "all_allowed" : "workspace";
      if (requireRepoTask) {
        if (!gateProfileId) {
          throw new CodexProError(
            "REPO_TASK_PROFILE_REQUIRED: The MCP connector is not bound to a worker profile.",
            { code: "REPO_TASK_PROFILE_REQUIRED", details: { task_id: taskId || undefined } }
          );
        }
        if (managerPrepared && !expected) {
          recordBrowserProfileTaskEvent("repo_task_begin_rejected", {
            profile_id: gateProfileId,
            session_profile_id: sessionProfileId,
            task_id: taskId,
            reason: "task_not_prepared"
          });
          throw new CodexProError(
            "REPO_TASK_NOT_PREPARED: CodexPro Manager has not prepared the supplied task for this worker profile.",
            { code: "REPO_TASK_NOT_PREPARED", details: { profile_id: gateProfileId, task_id: taskId } }
          );
        }
        if (managerPrepared && expected && (expected.taskId !== taskId || expected.scope !== scope)) {
          recordBrowserProfileTaskEvent("repo_task_begin_rejected", {
            profile_id: gateProfileId,
            session_profile_id: sessionProfileId,
            task_id: taskId,
            expected_task_id: expected.taskId,
            expected_scope: expected.scope,
            received_scope: scope,
            reason: "task_mismatch"
          });
          throw new CodexProError(
            `REPO_TASK_MISMATCH: begin_repo_task must use the exact task id and scope prepared by CodexPro Manager (${expected.taskId}, ${expected.scope}).`,
            {
              code: "REPO_TASK_MISMATCH",
              details: {
                profile_id: gateProfileId,
                expected_task_id: expected.taskId,
                received_task_id: taskId,
                expected_scope: expected.scope,
                received_scope: scope
              }
            }
          );
        }
      }
      if (!taskId) {
        throw new CodexProError("REPO_TASK_ID_REQUIRED: task_id is required outside a profile-bound ChatGPT connector.", { code: "REPO_TASK_ID_REQUIRED" });
      }
      const managerAllAllowed = Boolean(managerPrepared && expected?.scope === "all_allowed");
      if (managerAllAllowed && args.task_kind === "code" && !args.root) {
        throw new CodexProError(
          "REPO_TASK_ROOT_REQUIRED: all_allowed code tasks must choose the actual allowed workspace root instead of inheriting the Manager default workspace.",
          { code: "REPO_TASK_ROOT_REQUIRED", details: { profile_id: gateProfileId, task_id: taskId, scope } }
        );
      }
      let requestedRoot = String(args.root || "").trim();
      if (!requestedRoot && !managerAllAllowed) {
        requestedRoot = getBrowserExtensionProfileWorkspaceBinding(gateProfileId) || expected?.root || config.defaultRoot;
      }
      const workspace = args.task_kind === "code" ? workspaces.openWorkspace(requestedRoot) : undefined;
      const resolvedRoot = workspace?.root || (requestedRoot ? path.resolve(requestedRoot) : "");
      if (managerPrepared && expected?.root && !sameResolvedRoot(resolvedRoot, expected.root)) {
        throw new CodexProError(
          `REPO_TASK_ROOT_MISMATCH: begin_repo_task must open the exact workspace prepared by CodexPro Manager: ${expected.root}`,
          {
            code: "REPO_TASK_ROOT_MISMATCH",
            details: { profile_id: gateProfileId, task_id: taskId, expected_root: expected.root, received_root: resolvedRoot }
          }
        );
      }
      let preparedLifecycleRecovery: ResolvedWorkspaceTaskRoot | undefined;
      if (managerPrepared && args.task_kind === "code") {
        const preparedJob = readPreparedWorkerJob(taskId);
        if (isPreparedLifecycleRecovery(preparedJob)) {
          preparedLifecycleRecovery = resolvePreparedLifecycleRecovery({
            taskId,
            workerId: gateProfileId || preparedJob.workerId,
            preparedJob,
            requestedRoot: resolvedRoot,
            scope
          });
        }
      }
      if (gateProfileId && !managerPrepared) {
        expected = rememberExpectedRepoTask(gateProfileId, { taskId, root: resolvedRoot, scope: "workspace" });
      }
      const taskSource: RepoTaskProof["taskSource"] = managerPrepared ? "manager" : "chatgpt_direct";
      const startedAt = new Date().toISOString();
      const globalRules = args.task_kind === "code" ? await readGlobalRulesSnapshot() : undefined;
      const globalRulesLoadedAt = globalRules ? new Date().toISOString() : undefined;
      const codexGraph = args.task_kind === "code" ? await requireCodexGraphForWorkspace(config, guard, workspace!) : undefined;
      const codexContext = args.task_kind === "code" ? await readCodexContext(config, guard, workspace!, {
        targetPath: ".",
        includeAiBridge: false,
        includeGit: false,
        includeDiff: false
      }) : undefined;
      const agentsSha256 = codexContext ? createHash("sha256").update(codexContext.text).digest("hex") : undefined;
      const proof: RepoTaskProof = {
        taskId,
        taskTitle: args.task_title.trim(),
        taskKind: args.task_kind,
        taskSize: args.task_size,
        taskSource,
        root: resolvedRoot,
        workspaceId: workspace?.id || "",
        startedAt,
        scope,
        globalRulesPath: globalRules?.path,
        globalRulesSha256: globalRules?.sha256,
        globalRulesLoadedAt,
        agentsFiles: codexContext?.agentsFiles || [],
        agentsSha256,
        codexGraph
      };
      const durableJob = await bootstrapWorkerJob({
        jobId: proof.taskId,
        workerId: gateProfileId || `direct.${proof.taskId}`,
        title: proof.taskTitle,
        kind: proof.taskKind,
        taskSize: proof.taskSize,
        root: proof.root,
        workspaceId: proof.workspaceId,
        scope: proof.scope,
        rulesHash: proof.globalRulesSha256,
        rulesPath: proof.globalRulesPath,
        agentsFiles: proof.agentsFiles,
        agentsHash: proof.agentsSha256,
        codexGraphActive: Boolean(proof.codexGraph),
        codexGraphSymbolCount: proof.codexGraph?.coverage.symbolCount,
        codexGraphRelationshipCount: proof.codexGraph?.coverage.relationshipCount
      });
      if (managerPrepared && gateProfileId && expected && expectedRepoTask(gateProfileId)?.taskId !== proof.taskId) {
        expected = rememberExpectedRepoTask(gateProfileId, {
          taskId: proof.taskId,
          root: expected.root,
          scope: expected.scope
        });
      }
      if (gateProfileId) setBrowserExtensionProfileTask(gateProfileId, proof.taskId, proof.taskTitle);
      recordBrowserProfileTaskEvent("repo_task_started", {
        profile_id: gateProfileId,
        session_profile_id: sessionProfileId,
        profile_rerouted: Boolean(sessionProfileId && sessionProfileId !== gateProfileId),
        task_id: proof.taskId,
        task_title: proof.taskTitle,
        task_title_requested_by: "mcp_server",
        task_title_returned_by: "ai",
        task_kind: proof.taskKind,
        task_size: proof.taskSize,
        task_source: taskSource,
        root: proof.root,
        global_rules_loaded: Boolean(globalRules),
        global_rules_path: globalRules?.path,
        global_rules_sha256: globalRules?.sha256,
        global_rules_loaded_at: globalRulesLoadedAt,
        codexgraph_active: Boolean(codexGraph),
        codexgraph_workspace_id: codexGraph ? proof.workspaceId : undefined,
        codexgraph_symbol_count: codexGraph?.coverage.symbolCount,
        codexgraph_relationship_count: codexGraph?.coverage.relationshipCount
      });
      rememberRepoTaskProof(proof);
      clearActiveRepoTaskForServer(server);
      if (gateProfileId) clearActiveRepoTaskForProfile(gateProfileId);
      if (proof.taskKind === "general") {
        return textResult(`# Profile Task Registered\n\nTask: ${proof.taskId}\nTitle: ${proof.taskTitle}\nKind: general\n\nGlobal rules and CodexGraph were not loaded because this task does not use repository tools.`, {
          task_id: proof.taskId,
          task_title: proof.taskTitle,
          task_title_source: "ai",
          task_title_requested_by: "mcp_server",
          task_title_returned_by: "ai",
          task_kind: proof.taskKind,
          task_size: proof.taskSize,
          task_source: proof.taskSource,
          profile_id: gateProfileId,
          session_profile_id: sessionProfileId,
          profile_rerouted: Boolean(sessionProfileId && sessionProfileId !== gateProfileId),
          verified: true,
          gate_active: false,
          workspace_access: false,
          root: proof.root,
          workspace_id: proof.workspaceId,
          started_at: proof.startedAt,
          scope: proof.scope,
          global_rules_loaded: false,
          codexgraph_active: false,
          policy_version: durableJob.policyVersion,
          worker_job: classifiedWorkerJobPublicRecord(durableJob)
        });
      }
      if (!workspace || !globalRules || !codexGraph) {
        throw new CodexProError("REPO_TASK_CODE_CONTEXT_MISSING: code task activation requires a workspace, global rules, and CodexGraph.", { code: "REPO_TASK_CODE_CONTEXT_MISSING" });
      }
      const coordinationRoot = preparedLifecycleRecovery?.root || proof.root;
      const coordinationTask = preparedLifecycleRecovery?.task || await registerWorkspaceTask({
        taskId: proof.taskId,
        workerId: gateProfileId || `direct.${proof.taskId}`,
        title: proof.taskTitle,
        root: proof.root
      });
      const activeTask: ActiveRepoTask = {
        coordinationRoot,
        taskId: proof.taskId,
        taskTitle: proof.taskTitle,
        root: proof.root,
        workspaceId: proof.workspaceId,
        scope: proof.scope,
        globalRulesSha256: proof.globalRulesSha256!,
        worktreeRoot: coordinationTask.worktreeRoot,
        worktreeBranch: coordinationTask.worktreeBranch
      };
      setActiveRepoTaskForServer(server, activeTask);
      if (gateProfileId) {
        clearActiveRepoTaskForProfile(gateProfileId);
        setActiveRepoTaskForProfile(gateProfileId, activeTask);
      }
      await syncAuthoritativeTaskTracking({ taskId: proof.taskId, rootHint: proof.root, ownerProfile: gateProfileId }).catch(() => undefined);
      return textResult(withGlobalRules(`# Repo Task Verified\n\nTask: ${proof.taskId}\nRoot: ${proof.root}\nWorkspace: ${proof.workspaceId}\nScope: ${proof.scope}\nCodexGraph: active (${codexGraph.coverage.symbolCount} symbols, ${codexGraph.coverage.relationshipCount} relationships)`, globalRules), {
        task_id: proof.taskId,
        task_title: proof.taskTitle,
        task_title_source: "ai",
        task_title_requested_by: "mcp_server",
        task_title_returned_by: "ai",
        task_kind: proof.taskKind,
        task_size: proof.taskSize,
        task_source: proof.taskSource,
        profile_id: gateProfileId,
        session_profile_id: sessionProfileId,
        profile_rerouted: Boolean(sessionProfileId && sessionProfileId !== gateProfileId),
        verified: true,
        gate_active: true,
        workspace_access: true,
        prepared_recovery: Boolean(preparedLifecycleRecovery),
        coordination_root: coordinationRoot,
        root: proof.root,
        workspace_id: proof.workspaceId,
        worktree_root: coordinationTask.worktreeRoot,
        worktree_branch: coordinationTask.worktreeBranch,
        integration_status: coordinationTask.integrationStatus,
        started_at: proof.startedAt,
        scope: proof.scope,
        global_rules_loaded: true,
        global_rules_loaded_at: proof.globalRulesLoadedAt,
        global_rules_path: globalRules!.path,
        global_rules_sha256: globalRules!.sha256,
        global_rules_source: globalRules!.source,
        global_rules: globalRules!.text,
        agents_loaded: true,
        agents_files: proof.agentsFiles,
        agents_sha256: proof.agentsSha256,
        codexgraph_active: true,
        codexgraph: codexGraph,
        policy_version: durableJob.policyVersion,
        worker_job: classifiedWorkerJobPublicRecord(durableJob)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "resume_repo_task",
    {
      title: "Resume Repo Task",
      description: "Restore the in-memory gate for the exact already-running CodexPro task after an MCP/runtime restart without preparing a new task, opening a chat, or replaying prior actions.",
      inputSchema: {
        task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/),
        profile_id: z.string().regex(WORKER_PROFILE_ID_PATTERN).optional(),
        recover_stale_cancellation: z.boolean().optional().describe("Explicitly recover a proven legacy timeout reconciliation only when raw coordination remains running. Never revives deliberately finalized tasks.")
      },
      annotations: { ...annotations.handoffWrite, idempotentHint: true }
    },
    async (args) => {
      const taskId = String(args.task_id || "").trim();
      const sessionProfileId = repoTaskProfileIdForServer(server as object);
      const requestedProfileId = String(args.profile_id || "").trim();
      if (sessionProfileId && requestedProfileId && sessionProfileId !== requestedProfileId) {
        throw new CodexProError("REPO_TASK_RESUME_PROFILE_MISMATCH: bound MCP profile does not match the requested task owner.", {
          code: "REPO_TASK_RESUME_PROFILE_MISMATCH",
          details: { task_id: taskId, session_profile_id: sessionProfileId, requested_profile_id: requestedProfileId }
        });
      }
      const profileId = sessionProfileId || requestedProfileId;
      if (!profileId) {
        throw new CodexProError("REPO_TASK_RESUME_PROFILE_REQUIRED: profile_id is required when the MCP session is not profile-bound.", {
          code: "REPO_TASK_RESUME_PROFILE_REQUIRED",
          details: { task_id: taskId }
        });
      }

      const durableBefore = readWorkerJob(taskId);
      const canResume = (job: WorkerJobRecord | undefined) => job?.kind === "code" && (job.status === "running"
        || (args.recover_stale_cancellation === true && workerJobHasLegacyStaleCancellation(job)));
      if (!durableBefore || !canResume(durableBefore)) {
        throw new CodexProError(`REPO_TASK_RESUME_NOT_RUNNING: ${taskId} is not an active running code task.`, {
          code: "REPO_TASK_RESUME_NOT_RUNNING",
          details: { task_id: taskId, status: durableBefore?.status || "missing", kind: durableBefore?.kind || null }
        });
      }
      const normalizeWorkerOwner = (value: string) => String(value || "").trim().replace(/^browser:/, "");
      const assertResumeStillCurrent = () => {
        const current = readWorkerJob(taskId);
        const binding = getBrowserExtensionProfileTaskBinding(profileId);
        if (!current || current.status !== "running" || normalizeWorkerOwner(current.workerId) !== normalizeWorkerOwner(profileId)
          || (binding?.taskId && binding.taskId !== taskId)) {
          throw new CodexProError("REPO_TASK_RESUME_CHANGED: task or owner changed before gate publication.", { code: "REPO_TASK_RESUME_CHANGED", details: { task_id: taskId, status: current?.status } });
        }
      };
      if (normalizeWorkerOwner(durableBefore.workerId) !== normalizeWorkerOwner(profileId)) {
        throw new CodexProError("REPO_TASK_RESUME_OWNER_MISMATCH: durable worker ownership does not match this profile.", {
          code: "REPO_TASK_RESUME_OWNER_MISMATCH",
          details: { task_id: taskId, durable_worker_id: durableBefore.workerId, profile_id: profileId }
        });
      }
      const persistedOwners = getBrowserExtensionTaskOwners(taskId);
      if (persistedOwners.length > 1) {
        throw new CodexProError("REPO_TASK_RESUME_OWNER_AMBIGUOUS: task is persisted against more than one browser profile.", {
          code: "REPO_TASK_RESUME_OWNER_AMBIGUOUS",
          details: { task_id: taskId, profile_ids: persistedOwners.map((item) => item.profile_id) }
        });
      }
      if (persistedOwners[0] && persistedOwners[0].profile_id !== profileId) {
        throw new CodexProError("REPO_TASK_RESUME_OWNER_MISMATCH: persisted browser ownership belongs to another profile.", {
          code: "REPO_TASK_RESUME_OWNER_MISMATCH",
          details: { task_id: taskId, persisted_profile_id: persistedOwners[0].profile_id, profile_id: profileId }
        });
      }
      const profileBinding = getBrowserExtensionProfileTaskBinding(profileId);
      if (profileBinding?.taskId && profileBinding.taskId !== taskId) {
        throw new CodexProError("REPO_TASK_RESUME_PROFILE_BUSY: profile is already bound to a different task.", {
          code: "REPO_TASK_RESUME_PROFILE_BUSY",
          details: { task_id: taskId, profile_id: profileId, bound_task_id: profileBinding.taskId }
        });
      }
      if (!sessionProfileId && !persistedOwners.length) {
        const liveProfile = listBrowserExtensionProfiles().find((item) => item.profile_id === profileId && item.connected);
        if (!liveProfile) {
          throw new CodexProError("REPO_TASK_RESUME_OWNER_UNVERIFIED: Manager cannot restore a lost profile mapping without a live matching browser profile.", {
            code: "REPO_TASK_RESUME_OWNER_UNVERIFIED",
            details: { task_id: taskId, profile_id: profileId }
          });
        }
      }

      const durableScope = durableBefore.scope === "all_allowed" ? "all_allowed" : "workspace";
      const existingActive = activeRepoTaskForProfile(profileId);
      const existingExpected = expectedRepoTask(profileId);
      const latestRules = readGlobalRulesSnapshotSync();
      if (durableBefore.status === "running" && existingActive
        && existingExpected
        && existingActive.taskId === taskId
        && existingExpected.taskId === taskId
        && existingActive.scope === durableScope
        && existingExpected.scope === durableScope
        && sameResolvedRoot(existingActive.root, durableBefore.root)
        && existingActive.globalRulesSha256 === latestRules.sha256) {
        const context = { taskId, root: durableBefore.root, workerId: profileId };
        const verified = await verifyWorkspaceTaskResume(context);
        await withVerifiedWorkspaceTaskResume(context, verified, async () => assertResumeStillCurrent());
        const worktree = repoTaskWorktree(existingActive);
        assertResumeStillCurrent();
        setActiveRepoTaskForServer(server, existingActive);
        await syncAuthoritativeTaskTracking({ taskId, rootHint: durableBefore.root, ownerProfile: profileId }).catch(() => undefined);
        return textResult(`# Repo Task Gate Ready\n\nTask: ${taskId}\nProfile: ${profileId}\n\nThe existing task gate is already valid; no task action was replayed.`, {
          resumed: true,
          gate_active: true,
          gate_already_active: true,
          task_id: taskId,
          task_title: durableBefore.title,
          task_kind: durableBefore.kind,
          task_size: durableBefore.taskSize,
          profile_id: profileId,
          root: durableBefore.root,
          workspace_id: durableBefore.workspaceId,
          worktree_root: worktree.root,
          worktree_branch: worktree.branch,
          scope: durableScope,
          started_at: durableBefore.startedAt,
          progress_percent: durableBefore.progressPercent,
          checklist: durableBefore.checklist,
          completed_parts: durableBefore.completedParts,
          remaining_parts: durableBefore.remainingParts,
          progress_sequence: durableBefore.progressSequence,
          rules_changed: false,
          owner_binding_recovered: false,
          resume_deduplicated: true,
          replayed_actions: false,
          opened_new_chat: false,
          policy_version: durableBefore.policyVersion,
          worker_job: classifiedWorkerJobPublicRecord(durableBefore)
        });
      }

      const resumeTailKey = `${profileId}:${taskId}`;
      let resumePromise = repoTaskResumeTails.get(resumeTailKey);
      let joinedConcurrentResume = Boolean(resumePromise);
      if (!resumePromise) {
        resumePromise = (async () => {
          const durableJob = readWorkerJob(taskId);
          if (!durableJob || !canResume(durableJob)) {
            throw new CodexProError(`REPO_TASK_RESUME_NOT_RUNNING: ${taskId} stopped before recovery completed.`, {
              code: "REPO_TASK_RESUME_NOT_RUNNING",
              details: { task_id: taskId, status: durableJob?.status || "missing" }
            });
          }
          const root = String(durableJob.root || "").trim();
          if (!root) throw new CodexProError("REPO_TASK_RESUME_ROOT_MISSING: durable task no longer contains its repository root.", { code: "REPO_TASK_RESUME_ROOT_MISSING", details: { task_id: taskId } });
          const scope = durableJob.scope === "all_allowed" ? "all_allowed" : "workspace";
          const workspace = workspaces.openWorkspace(root);
          if (durableJob.workspaceId && durableJob.workspaceId !== workspace.id) {
            throw new CodexProError("REPO_TASK_RESUME_WORKSPACE_MISMATCH: repository identity changed since the task began.", {
              code: "REPO_TASK_RESUME_WORKSPACE_MISMATCH",
              details: { task_id: taskId, saved_workspace_id: durableJob.workspaceId, current_workspace_id: workspace.id, root: workspace.root }
            });
          }
          const coordinationTask = await verifyWorkspaceTaskResume({
            taskId,
            workerId: profileId,
            title: durableJob.title,
            root: workspace.root
          });
          const globalRules = await readGlobalRulesSnapshot();
          const codexGraph = await requireCodexGraphForWorkspace(config, guard, workspace);
          const codexContext = await readCodexContext(config, guard, workspace, {
            targetPath: ".",
            includeAiBridge: false,
            includeGit: false,
            includeDiff: false
          });
          const agentsSha256 = createHash("sha256").update(codexContext.text).digest("hex");
          const resumedJob = await withVerifiedWorkspaceTaskResume({ taskId, root: workspace.root, workerId: profileId }, coordinationTask, () => resumeWorkerJob({
            jobId: taskId,
            workerId: profileId,
            root: workspace.root,
            workspaceId: workspace.id,
            scope,
            resumeKey: `${repoTaskRuntimeResumeKey}:${profileId}:${taskId}`,
            recoverStaleCancellation: args.recover_stale_cancellation === true,
            rulesHash: globalRules.sha256,
            rulesPath: globalRules.path,
            agentsFiles: codexContext.agentsFiles,
            agentsHash: agentsSha256,
            codexGraphActive: true,
            codexGraphSymbolCount: codexGraph.coverage.symbolCount,
            codexGraphRelationshipCount: codexGraph.coverage.relationshipCount
          }));
          const proof: RepoTaskProof = {
            taskId,
            taskTitle: durableJob.title,
            taskKind: "code",
            taskSize: durableJob.taskSize || "small",
            taskSource: "manager",
            root: workspace.root,
            workspaceId: workspace.id,
            startedAt: durableJob.startedAt || durableJob.preparedAt,
            scope,
            globalRulesPath: globalRules.path,
            globalRulesSha256: globalRules.sha256,
            globalRulesLoadedAt: new Date().toISOString(),
            agentsFiles: codexContext.agentsFiles,
            agentsSha256,
            codexGraph
          };
          assertResumeStillCurrent();
          rememberRepoTaskProof(proof);
          rememberExpectedRepoTask(profileId, { taskId, root: workspace.root, scope });
          const activeTask: ActiveRepoTask = {
            taskId,
            taskTitle: durableJob.title,
            root: workspace.root,
            workspaceId: workspace.id,
            scope,
            globalRulesSha256: globalRules.sha256,
            worktreeRoot: coordinationTask.worktreeRoot,
            worktreeBranch: coordinationTask.worktreeBranch
          };
          setActiveRepoTaskForProfile(profileId, activeTask);
          const ownerBindingRecovered = !profileBinding || persistedOwners.length === 0;
          setBrowserExtensionProfileTask(profileId, taskId, durableJob.title);
          if (!resumedJob.deduplicated) {
            recordBrowserProfileTaskEvent("repo_task_resumed", {
              profile_id: profileId,
              task_id: taskId,
              root: workspace.root,
              workspace_id: workspace.id,
              worktree_root: coordinationTask.worktreeRoot,
              rules_changed: resumedJob.rulesChanged,
              owner_binding_recovered: ownerBindingRecovered,
              resume_key: repoTaskRuntimeResumeKey
            });
          }
          return {
            taskId,
            profileId,
            root: workspace.root,
            workspaceId: workspace.id,
            scope,
            taskTitle: durableJob.title,
            globalRulesSha256: globalRules.sha256,
            worktreeRoot: String(coordinationTask.worktreeRoot || ""),
            worktreeBranch: coordinationTask.worktreeBranch,
            workerJob: resumedJob.record,
            deduplicated: resumedJob.deduplicated,
            rulesChanged: resumedJob.rulesChanged,
            ownerBindingRecovered
          };
        })();
        repoTaskResumeTails.set(resumeTailKey, resumePromise);
        resumePromise.finally(() => {
          if (repoTaskResumeTails.get(resumeTailKey) === resumePromise) repoTaskResumeTails.delete(resumeTailKey);
        }).catch(() => undefined);
      }

      const recovered = await resumePromise;
      const workspace = workspaces.openWorkspace(recovered.root);
      if (workspace.id !== recovered.workspaceId) {
        throw new CodexProError("REPO_TASK_RESUME_WORKSPACE_MISMATCH: MCP session reopened a different workspace identity.", {
          code: "REPO_TASK_RESUME_WORKSPACE_MISMATCH",
          details: { task_id: taskId, expected_workspace_id: recovered.workspaceId, current_workspace_id: workspace.id }
        });
      }
      const activeTask: ActiveRepoTask = {
        taskId: recovered.taskId,
        taskTitle: recovered.taskTitle,
        root: recovered.root,
        workspaceId: recovered.workspaceId,
        scope: recovered.scope,
        globalRulesSha256: recovered.globalRulesSha256,
        worktreeRoot: recovered.worktreeRoot,
        worktreeBranch: recovered.worktreeBranch
      };
      assertResumeStillCurrent();
      setActiveRepoTaskForProfile(profileId, activeTask);
      setActiveRepoTaskForServer(server, activeTask);
      await syncAuthoritativeTaskTracking({ taskId, rootHint: recovered.root, ownerProfile: profileId }).catch(() => undefined);
      return textResult(`# Repo Task Resumed\n\nTask: ${taskId}\nProfile: ${profileId}\nWorktree: ${recovered.worktreeRoot}\n\nThe existing task gate was restored without replaying prior task actions.`, {
        resumed: true,
        gate_active: true,
        task_id: taskId,
        task_title: recovered.taskTitle,
        task_kind: "code",
        task_size: recovered.workerJob.taskSize,
        profile_id: profileId,
        session_profile_id: sessionProfileId,
        root: recovered.root,
        workspace_id: recovered.workspaceId,
        worktree_root: recovered.worktreeRoot,
        worktree_branch: recovered.worktreeBranch,
        scope: recovered.scope,
        started_at: recovered.workerJob.startedAt,
        progress_percent: recovered.workerJob.progressPercent,
        checklist: recovered.workerJob.checklist,
        completed_parts: recovered.workerJob.completedParts,
        remaining_parts: recovered.workerJob.remainingParts,
        progress_sequence: recovered.workerJob.progressSequence,
        rules_changed: recovered.rulesChanged,
        owner_binding_recovered: recovered.ownerBindingRecovered,
        resume_deduplicated: recovered.deduplicated || joinedConcurrentResume,
        replayed_actions: false,
        opened_new_chat: false,
        policy_version: recovered.workerJob.policyVersion,
        worker_job: classifiedWorkerJobPublicRecord(recovered.workerJob)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "repo_task_status",
    {
      title: "Repo Task Status",
      description: "Check server-side proof that begin_repo_task was called for a CodexPro Manager task.",
      inputSchema: { task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/) },
      annotations: annotations.readOnly
    },
    async (args) => {
      let trackingSyncError = "";
      let trackingRecord;
      await syncAuthoritativeTaskTracking({ taskId: args.task_id }).then((record) => { trackingRecord = record; }).catch((error) => { trackingSyncError = error instanceof Error ? error.message : String(error); });
      const proof = repoTaskProofs.get(args.task_id);
      const gateProfileId = repoTaskProfileIdForServer(server as object);
      const expected = gateProfileId ? expectedRepoTask(gateProfileId) : undefined;
      const active = activeRepoTaskForServer(server);
      const rulesMatch = Boolean(active && readGlobalRulesSnapshotSync().sha256 === active.globalRulesSha256);
      const workerJob = readWorkerJob(args.task_id);
      const durableProof = durableRepoTaskProof(workerJob, args.task_id, gateProfileId);
      let coordinationTask;
      const statusTaskKind = proof?.taskKind || durableProof?.kind;
      const statusRoot = proof?.root || durableProof?.root;
      if (statusTaskKind === "code" && statusRoot) {
        try {
          coordinationTask = readWorkspaceCoordination(statusRoot).tasks[args.task_id];
        } catch {
          coordinationTask = undefined;
        }
      }
      const memoryTaskVerified = requireRepoTask
        ? Boolean(proof && expected && expected.taskId === args.task_id && expected.scope === proof.scope && repoTaskRootMatches(proof.root, expected))
        : Boolean(proof);
      const taskVerified = memoryTaskVerified || Boolean(durableProof);
      const gateActive = Boolean(memoryTaskVerified && proof?.taskKind === "code" && sameRepoTask(active, expected) && rulesMatch);
      if (memoryTaskVerified && gateProfileId && proof?.taskTitle) {
        setBrowserExtensionProfileTask(gateProfileId, proof.taskId, proof.taskTitle);
      }
      const taskTitle = proof?.taskTitle || durableProof?.title;
      const taskKind = proof?.taskKind || durableProof?.kind;
      return textResult(taskVerified ? `# Profile Task Verified\n\n${args.task_id} registered “${taskTitle}” as ${taskKind}.` : `# Profile Task Missing\n\nNo begin_repo_task proof was found for ${args.task_id}.`, {
        task_id: args.task_id,
        verified: taskVerified,
        verification_source: memoryTaskVerified ? "memory" : durableProof ? "worker_job" : undefined,
        gate_active: gateActive,
        profile_id: gateProfileId || undefined,
        expected_task_id: expected?.taskId,
        active_task_id: active?.taskId,
        ...(proof ? {
          task_title: proof.taskTitle,
          task_title_source: "ai",
          task_title_requested_by: "mcp_server",
          task_title_returned_by: "ai",
          task_kind: proof.taskKind,
          task_size: proof.taskSize,
          task_source: proof.taskSource,
          root: proof.root,
          workspace_id: proof.workspaceId,
          started_at: proof.startedAt,
          scope: proof.scope,
          global_rules_loaded: Boolean(proof.globalRulesSha256),
          global_rules_path: proof.globalRulesPath,
          global_rules_sha256: proof.globalRulesSha256,
          global_rules_loaded_at: proof.globalRulesLoadedAt,
          agents_loaded: Boolean(proof.agentsFiles),
          agents_files: proof.agentsFiles,
          agents_sha256: proof.agentsSha256,
          codexgraph_active: Boolean(proof.codexGraph),
          codexgraph: proof.codexGraph,
          worktree_root: coordinationTask?.worktreeRoot,
          worktree_branch: coordinationTask?.worktreeBranch,
          integration_status: coordinationTask?.integrationStatus,
          integration_branch: coordinationTask?.integrationBranch,
          integration_requested_at: coordinationTask?.integrationRequestedAt,
          integration_started_at: coordinationTask?.integrationStartedAt,
          integration_finished_at: coordinationTask?.integrationFinishedAt,
          integrated_head: coordinationTask?.integratedHead
        } : durableProof ? {
          task_title: durableProof.title,
          task_title_source: "ai",
          task_title_requested_by: "mcp_server",
          task_title_returned_by: "ai",
          task_kind: durableProof.kind,
          task_size: durableProof.taskSize,
          task_source: "manager",
          root: durableProof.root,
          workspace_id: durableProof.workspaceId,
          started_at: durableProof.startedAt,
          scope: durableProof.scope,
          global_rules_loaded: Boolean(durableProof.rulesHash),
          global_rules_path: durableProof.rulesPath,
          global_rules_sha256: durableProof.rulesHash,
          agents_loaded: Boolean(durableProof.agentsFiles.length),
          agents_files: durableProof.agentsFiles,
          agents_sha256: durableProof.agentsHash,
          codexgraph_active: durableProof.codexGraphActive,
          codexgraph_symbol_count: durableProof.codexGraphSymbolCount,
          codexgraph_relationship_count: durableProof.codexGraphRelationshipCount,
          worktree_root: coordinationTask?.worktreeRoot,
          worktree_branch: coordinationTask?.worktreeBranch,
          integration_status: coordinationTask?.integrationStatus,
          integration_branch: coordinationTask?.integrationBranch,
          integration_requested_at: coordinationTask?.integrationRequestedAt,
          integration_started_at: coordinationTask?.integrationStartedAt,
          integration_finished_at: coordinationTask?.integrationFinishedAt,
          integrated_head: coordinationTask?.integratedHead
        } : {}),
        tracking: trackingRecord,
        tracking_sync_error: trackingSyncError || undefined,
        policy_version: workerJob?.policyVersion || WORKER_POLICY_VERSION,
        worker_job: classifiedWorkerJobPublicRecord(workerJob)
      });
    }
  );
}
