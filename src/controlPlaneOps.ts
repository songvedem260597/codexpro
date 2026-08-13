import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";

export const CONTROL_PLANE_TOOL_NAMES = [
  "worker_cycle_start",
  "control_overview",
  "ruleset_ack",
  "worker_run_receipt",
  "task_claim_or_resume",
  "task_checkpoint",
  "task_submit_for_review",
  "task_block",
  "task_approve",
  "task_create",
  "codebase_map_get",
  "task_capsule_build",
  "task_capsule_get",
  "research_brief_submit",
  "task_merge",
  "resource_acquire",
  "resource_release",
  "recovery_run"
] as const;

type ControlPlaneToolName = (typeof CONTROL_PLANE_TOOL_NAMES)[number];

export interface ControlPlaneBridgeContext {
  baseUrl: string;
  workerId: string | null;
  token: string;
}

export interface ControlPlaneToolDefinition {
  name: ControlPlaneToolName;
  options: Record<string, unknown>;
  handler: (args: any) => Promise<any>;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const MUTATION = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };

function result(name: string, payload: unknown): any {
  const structured = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : { value: payload };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: { control_plane_tool: name, ...structured }
  };
}

async function request(context: ControlPlaneBridgeContext, pathname: string, init?: RequestInit): Promise<any> {
  const url = new URL(pathname, context.baseUrl);
  const method = (init?.method ?? "GET").toUpperCase();
  const rawBody = typeof init?.body === "string" ? init.body : "";
  if (init?.body !== undefined && typeof init.body !== "string") throw new Error("Control Plane signed request body must be a JSON string");
  const workerId = requireBoundWorker(context);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const canonical = ["v1", timestamp, nonce, method, url.pathname, workerId, bodyHash].join("\n");
  const signature = createHmac("sha256", context.token).update(canonical).digest("hex");
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-codexpro-bridge-version": "v1",
      "x-codexpro-worker-id": workerId,
      "x-codexpro-timestamp": timestamp,
      "x-codexpro-nonce": nonce,
      "x-codexpro-signature": signature,
      ...(init?.headers ?? {})
    },
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = payload?.error?.code ?? `HTTP_${response.status}`;
    const message = payload?.error?.message ?? "Control Plane request failed";
    throw new Error(`${code}: ${message}`);
  }
  return payload;
}

function requireBoundWorker(context: ControlPlaneBridgeContext, supplied?: unknown): string {
  if (!context.workerId) throw new Error("WORKER_MARKER_REQUIRED: reconnect with codexpro_worker_id in the Server URL");
  if (supplied !== undefined && supplied !== null && String(supplied) !== context.workerId) {
    throw new Error(`WORKER_MARKER_MISMATCH: connector is bound to ${context.workerId}`);
  }
  return context.workerId;
}

async function boundRole(context: ControlPlaneBridgeContext): Promise<string> {
  const workerId = requireBoundWorker(context);
  const overview = await request(context, "/api/overview");
  const worker = overview.workers?.find((candidate: any) => candidate.id === workerId);
  if (!worker) throw new Error(`WORKER_NOT_FOUND: ${workerId}`);
  return String(worker.role);
}

async function requireRole(context: ControlPlaneBridgeContext, allowed: string[]): Promise<string> {
  const role = await boundRole(context);
  if (!allowed.includes(role)) throw new Error(`ROLE_PERMISSION_DENIED: ${role} cannot call this control tool`);
  return role;
}

async function requireTaskAccess(context: ControlPlaneBridgeContext, taskId: string): Promise<void> {
  const role = await boundRole(context);
  if (role === "coordinator" || role === "reviewer_qa") return;
  const tasks = await request(context, "/api/tasks");
  const task = tasks.tasks?.find((candidate: any) => candidate.id === taskId);
  if (!task) throw new Error(`TASK_NOT_FOUND: ${taskId}`);
  if (task.requiredRole !== role) throw new Error(`ROLE_PERMISSION_DENIED: task ${taskId} belongs to ${task.requiredRole}`);
}

async function acknowledgeCurrentRuleset(
  context: ControlPlaneBridgeContext,
  overview: any,
  workerId: string
): Promise<{ acknowledged: boolean; eventId: number | null }> {
  const rulesetHash = overview.governance?.activeRulesetHash;
  if (typeof rulesetHash !== "string" || !rulesetHash) {
    throw new Error("ACTIVE_RULESET_MISSING: Control Plane has no active ruleset hash");
  }
  const current = overview.governance?.workerAcks?.find((ack: any) => ack.workerId === workerId);
  if (current?.rulesetHash === rulesetHash && current?.source === "CODEXPRO_WORKER_CONNECTOR") {
    return { acknowledged: true, eventId: null };
  }
  const payload = await request(context, `/api/workers/${encodeURIComponent(workerId)}/ruleset-ack`, {
    method: "POST",
    body: JSON.stringify({ rulesetHash })
  });
  return { acknowledged: true, eventId: Number(payload?.eventId ?? 0) || null };
}

export function controlPlaneToolDefinitions(context: ControlPlaneBridgeContext): ControlPlaneToolDefinition[] {
  return [
    {
      name: "worker_cycle_start",
      options: {
        title: "Start Automatic P0 Worker Cycle",
        description: "Single automatic entrypoint for a role-bound CodexPro Worker Chat cycle. It acknowledges the current ruleset, records signed STARTED/ACKED cycle receipts, atomically claims the next READY task for this worker role, and returns the exact worktree and Task Capsule. Call exactly once for each Control Plane wake job; no schedule or manual bootstrap sequence is needed.",
        inputSchema: {},
        annotations: MUTATION
      },
      handler: async () => {
        const workerId = requireBoundWorker(context);
        const [overview, taskPayload] = await Promise.all([
          request(context, "/api/overview"),
          request(context, "/api/tasks")
        ]);
        const worker = overview.workers?.find((candidate: any) => candidate.id === workerId);
        if (!worker) throw new Error(`WORKER_NOT_FOUND: ${workerId}`);
        const governance = await acknowledgeCurrentRuleset(context, overview, workerId);
        const tasks = Array.isArray(taskPayload.tasks) ? taskPayload.tasks : [];
        const claimable = tasks
          .filter((task: any) => task.requiredRole === worker.role && (
            task.status === "READY" || (task.status === "RUNNING" && task.assignedWorkerId === workerId)
          ))
          .sort((left: any, right: any) => Number(right.priority ?? 0) - Number(left.priority ?? 0));
        const selectedTask = claimable[0] ?? null;
        const pendingInstructions = selectedTask && Array.isArray(overview.pendingInstructions)
          ? overview.pendingInstructions.filter((instruction: any) => (
              instruction?.taskId === selectedTask.id && instruction?.status === "PENDING"
            ))
          : [];
        const scheduleRunId = `codexpro-${workerId}-${Date.now()}-${randomUUID()}`;
        const deliveryId = selectedTask ? randomUUID() : null;
        const receiptBase = {
          scheduleRunId,
          ...(selectedTask ? { taskId: selectedTask.id } : {}),
          sessionEpoch: worker.sessionEpoch
        };
        const started = await request(context, `/api/workers/${encodeURIComponent(workerId)}/receipts`, {
          method: "POST",
          body: JSON.stringify({ ...receiptBase, state: "STARTED", detail: "Automatic @CodexPro worker cycle" })
        });
        const acked = await request(context, `/api/workers/${encodeURIComponent(workerId)}/receipts`, {
          method: "POST",
          body: JSON.stringify({
            ...receiptBase,
            state: "ACKED",
            detail: selectedTask ? `Claiming ${selectedTask.id}` : "Queue idle"
          })
        });

        if (!selectedTask) {
          const reviewTasks = tasks
            .filter((task: any) => ["IN_REVIEW", "WAITING_APPROVAL"].includes(task.status))
            .map((task: any) => {
              const implementationWorker = overview.workers?.find((candidate: any) => candidate.id === task.assignedWorkerId);
              return {
                ...task,
                implementationWorkerBinding: implementationWorker ? {
                  workerId: implementationWorker.id,
                  role: implementationWorker.role,
                  worktreePath: implementationWorker.worktreePath ?? null
                } : null,
                reviewEvidence: {
                  checkpoint: task.checkpoint ?? null,
                  allowedPaths: Array.isArray(task.allowedPaths) ? task.allowedPaths : [],
                  acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : []
                }
              };
            });
          const pendingReviewTasks = reviewTasks.filter((task: any) => task.status === "IN_REVIEW");
          return result("worker_cycle_start", {
            state: pendingReviewTasks.length && ["reviewer_qa", "coordinator"].includes(String(worker.role)) ? "REVIEW_READY" : "IDLE",
            workerBinding: {
              workerId,
              role: worker.role,
              sessionEpoch: worker.sessionEpoch,
              scheduleId: worker.scheduleId,
              worktreePath: worker.worktreePath ?? null
            },
            scheduleRunId,
            deliveryId: null,
            governance,
            receiptEventIds: { started: started.eventId ?? null, acked: acked.eventId ?? null },
            reviewTasks,
            nextAction: pendingReviewTasks.length && ["reviewer_qa", "coordinator"].includes(String(worker.role))
              ? "For every returned IN_REVIEW task, open implementationWorkerBinding.worktreePath, read the files listed in reviewEvidence.allowedPaths, and compare their contents with checkpoint.commitSha, checkpoint.tests, and the acceptance criteria. If the evidence is valid and paths are in scope, call task_approve now with that taskId. Do not edit the implementation, do not claim it, and do not call task_merge; the Developer records the merge after your independent approval. Do not stop after saying that you will review."
              : "Stop this run cleanly; there is no READY task for the bound role."
          });
        }

        const claimPayload = await request(context, `/api/tasks/${encodeURIComponent(selectedTask.id)}/claim`, {
          method: "POST",
          body: JSON.stringify({
            workerId,
            sessionEpoch: worker.sessionEpoch,
            scheduleRunId,
            deliveryId
          })
        });
        const capsulePayload = await request(context, `/api/tasks/${encodeURIComponent(selectedTask.id)}/capsule`, {
          method: "POST",
          body: JSON.stringify({})
        });
        return result("worker_cycle_start", {
          state: "TASK_CLAIMED",
          workerBinding: {
            workerId,
            role: worker.role,
            sessionEpoch: worker.sessionEpoch,
            scheduleId: worker.scheduleId,
            worktreePath: worker.worktreePath ?? null
          },
          scheduleRunId,
          deliveryId,
          governance,
          receiptEventIds: { started: started.eventId ?? null, acked: acked.eventId ?? null },
          claim: claimPayload.claim,
          capsule: capsulePayload.capsule ?? null,
          pendingInstructions,
          nextAction: pendingInstructions.length
            ? "Open workerBinding.worktreePath and execute the pendingInstructions now. Complete only the claimed task inside its allowed paths, checkpoint with ackInstructionRevision for every applied revision, submit for review, then record COMPLETED with this scheduleRunId/deliveryId and the returned lease/task attempt. Do not stop after describing what you will do."
            : "Open workerBinding.worktreePath, complete only the claimed task inside its allowed paths, checkpoint, submit for review, then record COMPLETED with this scheduleRunId/deliveryId and the returned lease/task attempt. Do not stop after describing what you will do."
        });
      }
    },
    {
      name: "control_overview",
      options: {
        title: "P0 Control Overview",
        description: "Read the role-bound P0 queue, worker runtime, Gate A/Gate C state, and the exact bounded worker protocol.",
        inputSchema: {},
        annotations: READ_ONLY
      },
      handler: async () => {
        const workerId = requireBoundWorker(context);
        const [overview, taskPayload] = await Promise.all([
          request(context, "/api/overview"),
          request(context, "/api/tasks")
        ]);
        const worker = overview.workers?.find((candidate: any) => candidate.id === workerId);
        if (!worker) throw new Error(`WORKER_NOT_FOUND: ${workerId}`);
        const role = String(worker.role);
        const tasks = Array.isArray(taskPayload.tasks) ? taskPayload.tasks : [];
        const relevantTasks = tasks.filter((task: any) => task.requiredRole === role || (["coordinator", "reviewer_qa"].includes(role) && ["IN_REVIEW", "WAITING_APPROVAL"].includes(task.status)));
        const workerRulesetAck = overview.governance?.workerAcks?.find((ack: any) => ack.workerId === workerId);
        const schedule = overview.schedules?.find((candidate: any) => candidate.workerId === workerId) ?? null;
        return result("control_overview", {
          workerBinding: { workerId, role, sessionEpoch: worker.sessionEpoch, scheduleId: worker.scheduleId, worktreePath: worker.worktreePath ?? null },
          project: overview.project,
          preflight: overview.preflight,
          p0Gates: overview.p0Gates,
          governance: {
            activeRulesetHash: overview.governance?.activeRulesetHash ?? null,
            acknowledged: workerRulesetAck?.rulesetHash === overview.governance?.activeRulesetHash,
            acknowledgedAt: workerRulesetAck?.acknowledgedAt ?? null
          },
          schedule,
          relevantTasks,
          protocol: [
            "For a scheduled run, call worker_cycle_start once; it automatically ACKs governance, records schedule STARTED/ACKED, and claims the next role-compatible task.",
            "Use the remaining steps below only after worker_cycle_start returns TASK_CLAIMED.",
            "Before source work, call open_workspace with workerBinding.worktreePath and keep every write inside that exact Git worktree.",
            "Build/read the Task Capsule, then call task_claim_or_resume with sessionEpoch and a new UUID deliveryId.",
            "Perform only bounded work in the returned worktree/scope; checkpoint with the exact lease/session epochs.",
            "Call task_submit_for_review, then worker_run_receipt COMPLETED. Do not approve your own implementation task.",
            "Reviewer/QA verifies evidence, calls task_approve, and records task_merge only after CI passes."
          ]
        });
      }
    },
    {
      name: "ruleset_ack",
      options: {
        title: "Acknowledge P0 Ruleset",
        description: "Acknowledge the exact active governance hash for this authenticated worker before mutations are enabled.",
        inputSchema: {},
        annotations: { ...MUTATION, idempotentHint: true }
      },
      handler: async () => {
        const workerId = requireBoundWorker(context);
        const overview = await request(context, "/api/overview");
        const rulesetHash = overview.governance?.activeRulesetHash;
        if (typeof rulesetHash !== "string" || !rulesetHash) throw new Error("ACTIVE_RULESET_MISSING: Control Plane has no active ruleset hash");
        const payload = await request(context, `/api/workers/${encodeURIComponent(workerId)}/ruleset-ack`, {
          method: "POST",
          body: JSON.stringify({ rulesetHash })
        });
        return result("ruleset_ack", payload);
      }
    },
    {
      name: "worker_run_receipt",
      options: {
        title: "P0 Worker Run Receipt",
        description: "Record a signed scheduled-run receipt. STARTED/ACKED may omit taskId for an idle schedule health check; COMPLETED always requires a bound task and full correlation.",
        inputSchema: {
          workerId: z.string().optional(),
          scheduleRunId: z.string().min(1).max(240),
          taskId: z.string().min(1).optional(),
          sessionEpoch: z.number().int().positive(),
          state: z.enum(["STARTED", "ACKED", "COMPLETED", "ERROR"]),
          detail: z.string().max(4_000).optional(),
          deliveryId: z.string().uuid().optional(),
          leaseEpoch: z.number().int().positive().optional(),
          taskAttempt: z.number().int().positive().optional(),
          scheduleCadence: z.string().min(1).max(120).optional(),
          scheduleTimezone: z.string().min(1).max(80).optional(),
          nextRunAt: z.string().datetime().optional()
        },
        annotations: { ...MUTATION, idempotentHint: true }
      },
      handler: async (args) => {
        const workerId = requireBoundWorker(context, args.workerId);
        if (args.state === "COMPLETED" && (!args.taskId || !args.deliveryId || !args.leaseEpoch || !args.taskAttempt)) {
          throw new Error("RUN_CORRELATION_REQUIRED: COMPLETED requires taskId, deliveryId, leaseEpoch, and taskAttempt");
        }
        if (!args.taskId && (args.deliveryId || args.leaseEpoch || args.taskAttempt)) {
          throw new Error("TASKLESS_RUN_CORRELATION_FORBIDDEN: idle schedule receipts cannot carry task correlation fields");
        }
        const payload = await request(context, `/api/workers/${encodeURIComponent(workerId)}/receipts`, {
          method: "POST",
          body: JSON.stringify({
            scheduleRunId: args.scheduleRunId,
            taskId: args.taskId,
            state: args.state,
            detail: args.detail,
            sessionEpoch: args.sessionEpoch,
            deliveryId: args.deliveryId,
            leaseEpoch: args.leaseEpoch,
            taskAttempt: args.taskAttempt,
            scheduleCadence: args.scheduleCadence,
            scheduleTimezone: args.scheduleTimezone,
            nextRunAt: args.nextRunAt
          })
        });
        return result("worker_run_receipt", payload);
      }
    },
    {
      name: "task_claim_or_resume",
      options: {
        title: "P0 Claim or Resume Task",
        description: "Atomically claim one role-compatible READY task for this connector marker.",
        inputSchema: {
          workerId: z.string().optional(),
          sessionEpoch: z.number().int().positive(),
          scheduleRunId: z.string().min(1).max(240),
          deliveryId: z.string().uuid(),
          taskId: z.string().min(1).optional()
        },
        annotations: { ...MUTATION, idempotentHint: true }
      },
      handler: async (args) => {
        const workerId = requireBoundWorker(context, args.workerId);
        const path = args.taskId ? `/api/tasks/${encodeURIComponent(args.taskId)}/claim` : "/api/tasks/claim";
        const payload = await request(context, path, {
          method: "POST",
          body: JSON.stringify({ workerId, sessionEpoch: args.sessionEpoch, scheduleRunId: args.scheduleRunId, deliveryId: args.deliveryId })
        });
        return result("task_claim_or_resume", payload);
      }
    },
    {
      name: "task_checkpoint",
      options: {
        title: "P0 Task Checkpoint",
        description: "Persist a fenced checkpoint and touched paths for this bound worker.",
        inputSchema: {
          workerId: z.string().optional(), taskId: z.string().min(1), leaseEpoch: z.number().int().positive(), sessionEpoch: z.number().int().positive(), scheduleRunId: z.string().min(1).max(240),
          checkpoint: z.record(z.any()), touchedPaths: z.array(z.string()).max(200).optional(), ackInstructionRevision: z.number().int().positive().optional()
        },
        annotations: { ...MUTATION, idempotentHint: true }
      },
      handler: async (args) => {
        const workerId = requireBoundWorker(context, args.workerId);
        const payload = await request(context, `/api/tasks/${encodeURIComponent(args.taskId)}/checkpoint`, {
          method: "POST",
          body: JSON.stringify({ ...args, workerId, touchedPaths: args.touchedPaths ?? [] })
        });
        return result("task_checkpoint", payload);
      }
    },
    {
      name: "task_submit_for_review",
      options: {
        title: "P0 Submit for Review",
        description: "Release the fenced lease and submit structured evidence for Reviewer/QA.",
        inputSchema: {
          workerId: z.string().optional(), taskId: z.string().min(1), leaseEpoch: z.number().int().positive(), sessionEpoch: z.number().int().positive(), scheduleRunId: z.string().min(1).max(240),
          evidence: z.record(z.any()), touchedPaths: z.array(z.string()).max(200).optional()
        },
        annotations: MUTATION
      },
      handler: async (args) => {
        const workerId = requireBoundWorker(context, args.workerId);
        const payload = await request(context, `/api/tasks/${encodeURIComponent(args.taskId)}/complete`, {
          method: "POST",
          body: JSON.stringify({ ...args, workerId, touchedPaths: args.touchedPaths ?? [] })
        });
        return result("task_submit_for_review", payload);
      }
    },
    {
      name: "task_block",
      options: {
        title: "P0 Block Task",
        description: "Release the active lease at a safe checkpoint and persist a blocking reason.",
        inputSchema: {
          workerId: z.string().optional(), taskId: z.string().min(1), leaseEpoch: z.number().int().positive(), sessionEpoch: z.number().int().positive(), reason: z.string().min(1).max(4_000)
        },
        annotations: MUTATION
      },
      handler: async (args) => {
        const workerId = requireBoundWorker(context, args.workerId);
        const payload = await request(context, `/api/tasks/${encodeURIComponent(args.taskId)}/block`, {
          method: "POST", body: JSON.stringify({ ...args, workerId })
        });
        return result("task_block", payload);
      }
    },
    {
      name: "task_approve",
      options: {
        title: "P0 Approve Reviewed Task",
        description: "Reviewer/QA or Coordinator approves an IN_REVIEW task; merge evidence remains required.",
        inputSchema: { reviewerWorkerId: z.string().optional(), taskId: z.string().min(1) },
        annotations: MUTATION
      },
      handler: async (args) => {
        await requireRole(context, ["reviewer_qa", "coordinator"]);
        const reviewerWorkerId = requireBoundWorker(context, args.reviewerWorkerId);
        const payload = await request(context, `/api/tasks/${encodeURIComponent(args.taskId)}/approve`, {
          method: "POST", body: JSON.stringify({ reviewerWorkerId })
        });
        return result("task_approve", payload);
      }
    },
    {
      name: "task_create",
      options: {
        title: "P0 Create Scoped Task",
        description: "Coordinator creates a role-scoped READY task with bounded acceptance and write paths.",
        inputSchema: {
          id: z.string().min(1).max(160).optional(),
          parentTaskId: z.string().min(1).max(160).optional(),
          dependencyIds: z.array(z.string().min(1).max(160)).max(50).optional(),
          title: z.string().min(1).max(240), description: z.string().max(8_000).optional(),
          requiredRole: z.enum(["coordinator", "backend", "frontend", "reviewer_qa", "product_observer"]),
          priority: z.number().int().min(0).max(100).optional(), acceptanceCriteria: z.array(z.string()).max(20).optional(), allowedPaths: z.array(z.string()).max(50).optional()
        },
        annotations: MUTATION
      },
      handler: async (args) => {
        await requireRole(context, ["coordinator"]);
        const payload = await request(context, "/api/tasks", {
          method: "POST", body: JSON.stringify({ ...args, acceptanceCriteria: args.acceptanceCriteria ?? [], allowedPaths: args.allowedPaths ?? [] })
        });
        return result("task_create", payload);
      }
    },
    {
      name: "codebase_map_get",
      options: { title: "P0 Codebase Map", description: "Read the current lightweight codebase map and graph freshness.", inputSchema: {}, annotations: READ_ONLY },
      handler: async () => result("codebase_map_get", await request(context, "/api/codebase-map"))
    },
    {
      name: "task_capsule_build",
      options: { title: "P0 Build Task Capsule", description: "Build a bounded Task Capsule after verifying marker role access.", inputSchema: { taskId: z.string().min(1) }, annotations: { ...MUTATION, idempotentHint: true } },
      handler: async (args) => {
        await requireTaskAccess(context, args.taskId);
        return result("task_capsule_build", await request(context, `/api/tasks/${encodeURIComponent(args.taskId)}/capsule`, { method: "POST", body: "{}" }));
      }
    },
    {
      name: "task_capsule_get",
      options: { title: "P0 Get Task Capsule", description: "Read an existing bounded Task Capsule.", inputSchema: { taskId: z.string().min(1) }, annotations: READ_ONLY },
      handler: async (args) => {
        await requireTaskAccess(context, args.taskId);
        return result("task_capsule_get", await request(context, `/api/tasks/${encodeURIComponent(args.taskId)}/capsule`));
      }
    },
    {
      name: "research_brief_submit",
      options: {
        title: "P0 Submit Research Brief", description: "Product Observer submits a cited research brief.",
        inputSchema: { workerId: z.string().optional(), taskId: z.string().min(1).optional(), title: z.string().min(1).max(240), summary: z.string().min(1).max(8_000), citations: z.array(z.string().url()).min(1).max(30) },
        annotations: MUTATION
      },
      handler: async (args) => {
        const workerId = requireBoundWorker(context, args.workerId);
        await requireRole(context, ["product_observer"]);
        return result("research_brief_submit", await request(context, "/api/research-briefs", { method: "POST", body: JSON.stringify({ ...args, workerId }) }));
      }
    },
    {
      name: "task_merge",
      options: {
        title: "P0 Record Approved Merge", description: "Reviewer/QA or Coordinator records CI-passed merge evidence before DONE.",
        inputSchema: { taskId: z.string().min(1), mergeRef: z.string().min(1).max(240), ciPassed: z.boolean() }, annotations: MUTATION
      },
      handler: async (args) => {
        await requireRole(context, ["reviewer_qa", "coordinator"]);
        const actorId = requireBoundWorker(context);
        return result("task_merge", await request(context, `/api/tasks/${encodeURIComponent(args.taskId)}/merge`, { method: "POST", body: JSON.stringify({ ...args, actorId }) }));
      }
    },
    {
      name: "resource_acquire",
      options: {
        title: "P0 Acquire Resource Lease", description: "Acquire a thermal-aware resource lease for this bound worker.",
        inputSchema: { workerId: z.string().optional(), taskId: z.string().min(1).optional(), kind: z.enum(["HEAVY_LOCAL", "BROWSER_QA"]), ttlMs: z.number().int().min(1_000).max(3_600_000).optional() }, annotations: MUTATION
      },
      handler: async (args) => {
        const workerId = requireBoundWorker(context, args.workerId);
        return result("resource_acquire", await request(context, "/api/resources/acquire", { method: "POST", body: JSON.stringify({ ...args, workerId }) }));
      }
    },
    {
      name: "resource_release",
      options: { title: "P0 Release Resource Lease", description: "Release a resource lease owned by this connector worker.", inputSchema: { leaseId: z.string().min(1) }, annotations: { ...MUTATION, idempotentHint: true } },
      handler: async (args) => {
        const workerId = requireBoundWorker(context);
        const resources = await request(context, "/api/resources");
        const lease = resources.activeLeases?.find((candidate: any) => candidate.id === args.leaseId);
        if (!lease || lease.workerId !== workerId) throw new Error(`RESOURCE_PERMISSION_DENIED: ${args.leaseId} is not active for ${workerId}`);
        return result("resource_release", await request(context, `/api/resources/${encodeURIComponent(args.leaseId)}/release`, { method: "POST", body: JSON.stringify({ actorId: workerId }) }));
      }
    },
    {
      name: "recovery_run",
      options: { title: "P0 Recover Expired Leases", description: "Coordinator fences expired leases and persists Recovery Bundles.", inputSchema: { observedAt: z.string().datetime().optional() }, annotations: { ...MUTATION, idempotentHint: true } },
      handler: async (args) => {
        await requireRole(context, ["coordinator"]);
        return result("recovery_run", await request(context, "/api/recovery/run", { method: "POST", body: JSON.stringify(args) }));
      }
    }
  ];
}
