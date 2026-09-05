import { z } from "zod";
import { CodexProError } from "./guard.js";
import { listWorkerContextCheckpoints } from "./workerContext.js";
import {
  finalizeWorkerJob,
  listWorkerJobs,
  readWorkerJob,
  reportWorkerJobProgress,
  workerJobPublicRecord,
  type WorkerJobRecord,
  WORKER_POLICY_VERSION
} from "./workerPolicy.js";
import {
  assertWorkspaceTaskCompletionReady,
  finalizeWorkspaceTask,
  readWorkspaceCoordination
} from "./workspaceCoordination.js";

export type WorkerJobToolDefinition = {
  name: string;
  options: Record<string, unknown>;
  handler: (args: any) => Promise<any> | any;
};

type WorkerJobToolDependencies = {
  serverKey: object;
  resolveProfileId: (serverKey: object, taskId: string) => string;
  textResult: (text: string, structuredContent?: Record<string, unknown>) => any;
  readOnlyAnnotations: Record<string, unknown>;
  handoffWriteAnnotations: Record<string, unknown>;
};

function workerJobSourceChanges(job: WorkerJobRecord | undefined): string[] {
  if (!job || job.kind !== "code" || !job.root) return [];
  try {
    const task = readWorkspaceCoordination(job.root).tasks[job.jobId];
    return [...new Set((Array.isArray(task?.touchedPaths) ? task.touchedPaths : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean))].slice(0, 100);
  } catch {
    return [];
  }
}

export function classifiedWorkerJobPublicRecord(job: WorkerJobRecord | undefined): Record<string, unknown> | undefined {
  const publicRecord = workerJobPublicRecord(job);
  if (!publicRecord) return undefined;
  const sourceChangedPaths = workerJobSourceChanges(job);
  return {
    ...publicRecord,
    counts_as_task: sourceChangedPaths.length > 0,
    source_change_count: sourceChangedPaths.length,
    source_changed_paths: sourceChangedPaths
  };
}

export function createWorkerJobToolDefinitions(deps: WorkerJobToolDependencies): WorkerJobToolDefinition[] {
  const { serverKey, resolveProfileId, textResult, readOnlyAnnotations, handoffWriteAnnotations } = deps;
  const gateProfileIdForTask = (taskId: string): string | undefined => resolveProfileId(serverKey, taskId) || undefined;

  return [
    {
      name: "worker_job_status",
      options: {
        title: "Worker Job Status",
        description: "Read the durable MCP policy record for a Browser or API worker job, including bootstrap evidence and outstanding completion obligations.",
        inputSchema: { task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/) },
        annotations: readOnlyAnnotations
      },
      handler: async (args) => {
        const record = readWorkerJob(args.task_id);
        return textResult(record ? `# Worker Job\n\n${args.task_id}: ${record.status}` : `# Worker Job Missing\n\n${args.task_id} has no durable worker policy record.`, {
          found: Boolean(record),
          policy_version: record?.policyVersion || WORKER_POLICY_VERSION,
          job: classifiedWorkerJobPublicRecord(record)
        });
      }
    },
    {
      name: "worker_job_history",
      options: {
        title: "Worker Job History",
        description: "List recent durable worker jobs for the CodexPro control center, including terminal status and start/finish timestamps.",
        inputSchema: {
          statuses: z.array(z.enum(["prepared", "running", "completed", "failed", "cancelled", "blocked"])).max(6).optional(),
          limit: z.number().int().min(1).max(200).optional()
        },
        annotations: readOnlyAnnotations
      },
      handler: async (args) => {
        const jobs = listWorkerJobs({ statuses: args.statuses, limit: args.limit });
        return textResult(`# Worker Job History\n\n${jobs.length} recent job(s).`, {
          count: jobs.length,
          jobs: jobs.map((record) => classifiedWorkerJobPublicRecord(record))
        });
      }
    },
    {
      name: "worker_context_history",
      options: {
        title: "Worker Context History",
        description: "Read up to the three newest compact work-context checkpoints for one worker and project, optionally restricted to one exact Task ID. These checkpoints are independent of ChatGPT conversation ids and are intended for lightweight task recovery without mixing another task's context.",
        inputSchema: {
          worker_id: z.string().min(1).max(160),
          root: z.string().max(2048).optional(),
          scope: z.enum(["workspace", "all_allowed"]).optional(),
          task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/).optional()
        },
        annotations: readOnlyAnnotations
      },
      handler: async (args) => {
        const scope = args.scope === "all_allowed" ? "all_allowed" : "workspace";
        const checkpoints = listWorkerContextCheckpoints({
          workerId: args.worker_id,
          root: args.root,
          scope,
          taskId: args.task_id
        });
        return textResult(`# Worker Context History\n\n${checkpoints.length} checkpoint(s) for this worker/project${args.task_id ? "/task" : ""}.`, {
          worker_id: args.worker_id,
          root: args.root || "",
          scope,
          task_id: args.task_id || "",
          count: checkpoints.length,
          checkpoints
        });
      }
    },
    {
      name: "report_worker_job_progress",
      options: {
        title: "Report Worker Job Progress",
        description: "Persist a structured task checkpoint with progress, completed/remaining parts, important files, test result, durable checklist, blocker location, verification evidence, and stall/error context. A running checkpoint cannot stay at 100% while unfinished parts remain. Medium and large tasks should send the full checklist every time; large tasks cannot finalize without it.",
        inputSchema: {
          task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/),
          stage: z.enum(["started", "partial", "all_parts_done", "verifying", "blocked", "error", "stalled"]),
          summary: z.string().min(1).max(2000),
          reason: z.string().max(2000).optional(),
          evidence: z.string().max(2000).optional(),
          important_files: z.array(z.string().min(1).max(300)).max(30).optional(),
          test_result: z.string().max(2000).optional(),
          progress_percent: z.number().min(0).max(100).optional(),
          blocked_part: z.string().min(1).max(300).optional(),
          completed_parts: z.array(z.string().min(1).max(300)).max(50).optional(),
          remaining_parts: z.array(z.string().min(1).max(300)).max(50).optional(),
          checklist: z.array(z.object({
            id: z.string().min(1).max(80),
            title: z.string().min(1).max(300),
            status: z.enum(["pending", "in_progress", "completed", "blocked"]),
            evidence: z.string().max(1000).optional()
          })).max(50).optional()
        },
        annotations: handoffWriteAnnotations
      },
      handler: async (args) => {
        const gateProfileId = gateProfileIdForTask(args.task_id);
        if (!gateProfileId) {
          throw new CodexProError("WORKER_JOB_PROFILE_REQUIRED: report_worker_job_progress requires a profile-bound Browser or API worker MCP session.", {
            code: "WORKER_JOB_PROFILE_REQUIRED",
            details: { task_id: args.task_id }
          });
        }
        try {
          const record = await reportWorkerJobProgress({
            jobId: args.task_id,
            workerId: gateProfileId,
            stage: args.stage,
            summary: args.summary,
            reason: args.reason,
            evidence: args.evidence,
            importantFiles: args.important_files,
            testResult: args.test_result,
            progressPercent: args.progress_percent,
            blockedPart: args.blocked_part,
            completedParts: args.completed_parts,
            remainingParts: args.remaining_parts,
            checklist: args.checklist
          });
          return textResult(`# Worker Job Progress\n\n${record.jobId}: ${record.lastProgressStage || "running"} · checkpoint ${record.progressSequence}`, {
            reported: true,
            policy_version: record.policyVersion,
            job: classifiedWorkerJobPublicRecord(record)
          });
        } catch (error) {
          throw new CodexProError(`WORKER_JOB_PROGRESS_REJECTED: ${error instanceof Error ? error.message : String(error)}`, {
            code: "WORKER_JOB_PROGRESS_REJECTED",
            details: { task_id: args.task_id, profile_id: gateProfileId }
          });
        }
      }
    },
    {
      name: "finalize_worker_job",
      options: {
        title: "Finalize Worker Job",
        description: "Finalize a profile-bound worker job only after all required obligations are satisfied. A source-changing task can complete only after a recognized test/check/verify/smoke command passes after the latest source change, those verified changes are committed, and the commit is successfully pushed/integrated.",
        inputSchema: {
          task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/),
          outcome: z.enum(["completed", "failed", "cancelled"]),
          completed_obligations: z.array(z.string().min(1).max(100)).max(100).optional(),
          summary: z.string().max(4000).optional(),
          error: z.string().max(4000).optional()
        },
        annotations: handoffWriteAnnotations
      },
      handler: async (args) => {
        const gateProfileId = gateProfileIdForTask(args.task_id);
        if (!gateProfileId) {
          throw new CodexProError("WORKER_JOB_PROFILE_REQUIRED: finalize_worker_job requires a profile-bound Browser or API worker MCP session.", {
            code: "WORKER_JOB_PROFILE_REQUIRED",
            details: { task_id: args.task_id }
          });
        }
        try {
          const currentJob = readWorkerJob(args.task_id);
          if (args.outcome === "completed" && currentJob?.kind === "code" && currentJob.root) {
            assertWorkspaceTaskCompletionReady({
              taskId: currentJob.jobId,
              workerId: gateProfileId,
              title: currentJob.title,
              root: currentJob.root
            });
          }
          const record = await finalizeWorkerJob({
            jobId: args.task_id,
            workerId: gateProfileId,
            outcome: args.outcome,
            completedObligations: args.completed_obligations,
            summary: args.summary,
            error: args.error
          });
          if (record.root) {
            const coordinationStatus = record.status === "completed" || record.status === "failed" || record.status === "cancelled" ? record.status : args.outcome;
            await finalizeWorkspaceTask({
              taskId: record.jobId,
              workerId: gateProfileId,
              title: record.title,
              root: record.root
            }, coordinationStatus);
          }
          return textResult(`# Worker Job Finalized\n\n${record.jobId}: ${record.status}`, {
            finalized: true,
            policy_version: record.policyVersion,
            job: classifiedWorkerJobPublicRecord(record)
          });
        } catch (error) {
          if (error instanceof CodexProError && String(error.code || "").startsWith("WORKSPACE_TASK_")) throw error;
          throw new CodexProError(`WORKER_JOB_FINALIZE_REJECTED: ${error instanceof Error ? error.message : String(error)}`, {
            code: "WORKER_JOB_FINALIZE_REJECTED",
            details: { task_id: args.task_id, profile_id: gateProfileId }
          });
        }
      }
    }
  ];
}
