import { listWorkerJobs, readWorkerJob, type WorkerJobRecord } from "./workerPolicy.js";
import { resolveWorkspaceTaskRootByTaskId, type WorkspaceTaskRecord } from "./workspaceCoordination.js";
import { syncTaskTracking, type TaskTrackingRecord } from "./taskTracking.js";

function workspaceTaskNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "WORKSPACE_TASK_NOT_FOUND");
}

function hasFinalizedEvent(job: WorkerJobRecord): boolean {
  return job.events.some((entry) => entry.type === "finalized");
}

export async function syncAuthoritativeTaskTracking(input: {
  taskId: string;
  rootHint?: string;
  ownerProfile?: string;
}): Promise<TaskTrackingRecord | undefined> {
  const workerJob = readWorkerJob(input.taskId);
  if (!workerJob || workerJob.kind !== "code" || !workerJob.root) return undefined;

  let workspaceTask: WorkspaceTaskRecord | undefined;
  try {
    workspaceTask = resolveWorkspaceTaskRootByTaskId({
      taskId: workerJob.jobId,
      rootHint: input.rootHint || workerJob.root,
      workerId: workerJob.workerId
    }).task;
  } catch (error) {
    if (!workspaceTaskNotFound(error)) throw error;
  }

  return await syncTaskTracking({
    root: workerJob.root,
    taskId: workerJob.jobId,
    workerJob,
    workspaceTask,
    ownerProfile: input.ownerProfile || workerJob.workerId
  });
}

export type TaskTrackingBackfillResult = {
  backfilled: Array<{ taskId: string; state: string; pathRoot: string }>;
  skippedTerminalTaskIds: string[];
  errors: Array<{ taskId: string; error: string }>;
};

export async function backfillUnfinishedTaskTracking(): Promise<TaskTrackingBackfillResult> {
  const jobs = listWorkerJobs({ limit: 200 }).filter((job) => job.kind === "code" && Boolean(job.root));
  const backfilled: Array<{ taskId: string; state: string; pathRoot: string }> = [];
  const skippedTerminalTaskIds: string[] = [];
  const errors: Array<{ taskId: string; error: string }> = [];
  for (const job of jobs) {
    if (job.status === "cancelled" || (job.status === "completed" && hasFinalizedEvent(job))) {
      skippedTerminalTaskIds.push(job.jobId);
      continue;
    }
    try {
      const record = await syncAuthoritativeTaskTracking({ taskId: job.jobId, rootHint: job.root, ownerProfile: job.workerId });
      if (record) backfilled.push({ taskId: record.task_id, state: record.state, pathRoot: job.root });
    } catch (error) {
      errors.push({ taskId: job.jobId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    backfilled,
    skippedTerminalTaskIds: [...new Set(skippedTerminalTaskIds)].sort(),
    errors
  };
}
