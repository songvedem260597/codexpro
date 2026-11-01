import { listWorkerJobs, readWorkerJob } from "./workerPolicy.js";
import { resolveWorkspaceTaskRootByTaskId } from "./workspaceCoordination.js";
import { syncTaskTracking } from "./taskTracking.js";
function workspaceTaskNotFound(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "WORKSPACE_TASK_NOT_FOUND");
}
function hasFinalizedEvent(job) {
    return job.events.some((entry) => entry.type === "finalized");
}
export async function syncAuthoritativeTaskTracking(input) {
    const workerJob = readWorkerJob(input.taskId);
    if (!workerJob || workerJob.kind !== "code" || !workerJob.root)
        return undefined;
    let workspaceTask;
    try {
        workspaceTask = resolveWorkspaceTaskRootByTaskId({
            taskId: workerJob.jobId,
            rootHint: input.rootHint || workerJob.root,
            workerId: workerJob.workerId
        }).task;
    }
    catch (error) {
        if (!workspaceTaskNotFound(error))
            throw error;
    }
    return await syncTaskTracking({
        root: workerJob.root,
        taskId: workerJob.jobId,
        workerJob,
        workspaceTask,
        ownerProfile: input.ownerProfile || workerJob.workerId
    });
}
export async function backfillUnfinishedTaskTracking() {
    const jobs = listWorkerJobs({ limit: 200 }).filter((job) => job.kind === "code" && Boolean(job.root));
    const backfilled = [];
    const skippedTerminalTaskIds = [];
    const errors = [];
    for (const job of jobs) {
        if (job.status === "cancelled" || (job.status === "completed" && hasFinalizedEvent(job))) {
            skippedTerminalTaskIds.push(job.jobId);
            continue;
        }
        try {
            const record = await syncAuthoritativeTaskTracking({ taskId: job.jobId, rootHint: job.root, ownerProfile: job.workerId });
            if (record)
                backfilled.push({ taskId: record.task_id, state: record.state, pathRoot: job.root });
        }
        catch (error) {
            errors.push({ taskId: job.jobId, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return {
        backfilled,
        skippedTerminalTaskIds: [...new Set(skippedTerminalTaskIds)].sort(),
        errors
    };
}
//# sourceMappingURL=taskTrackingReconciliation.js.map