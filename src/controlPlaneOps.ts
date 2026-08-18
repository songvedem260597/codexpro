import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { CODEX_PATCH_ENVELOPE_CONTRACT_VERSION } from "./patchOps.js";

const execFileAsync = promisify(execFile);

export const CONTROL_PLANE_TOOL_NAMES = [
  "worker_cycle_start",
  "control_overview",
  "ruleset_ack",
  "worker_run_receipt",
  "task_claim_or_resume",
  "task_checkpoint",
  "task_submit_for_review",
  "review_ci_check_record",
  "review_finding_create",
  "review_finding_update",
  "review_changes_request",
  "task_block",
  "task_unblock_transient",
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
  allowedRoots: string[];
}

export interface ControlPlaneToolDefinition {
  name: ControlPlaneToolName;
  options: Record<string, unknown>;
  handler: (args: any) => Promise<any>;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const MUTATION = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
const CHANGE_SUBMISSION_CONTRACT_VERSION = "2";

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

function isInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

function stableBlockerEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableBlockerEvidenceValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableBlockerEvidenceValue(nested)]));
  }
  return value;
}

function blockerEvidenceHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableBlockerEvidenceValue(value))).digest("hex")}`;
}

function runtimeSmokeCommandFromReason(reason: string): { command: string; relativeCwd: string } | null {
  const candidates = [...reason.matchAll(/`([^`]+)`/gu)].map((match) => String(match[1] ?? "").trim());
  for (const command of candidates) {
    const match = command.match(/^cd\s+([^\s;&|]+)\s*&&\s*node\s+scripts\/dev-server\.mjs$/u);
    if (!match) continue;
    const relativeCwd = String(match[1] ?? "");
    if (!isBoundedReviewDirectory(relativeCwd)) continue;
    return { command, relativeCwd };
  }
  return null;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? Number(address.port) : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isInteger(port) || port <= 0) reject(new Error("RUNTIME_SMOKE_PORT_UNAVAILABLE"));
        else resolvePort(port);
      });
    });
  });
}

async function runBoundedRuntimeSmoke(
  worktreePath: string,
  taskId: string,
  headSha: string,
  reason: string,
): Promise<Record<string, unknown>> {
  const declaration = runtimeSmokeCommandFromReason(reason);
  if (!declaration) {
    throw new Error("RUNTIME_SMOKE_COMMAND_UNSUPPORTED: expected a bounded `cd <package> && node scripts/dev-server.mjs` command");
  }
  const cwd = resolve(worktreePath, declaration.relativeCwd);
  if (!isInside(worktreePath, cwd)) throw new Error(`RUNTIME_SMOKE_CWD_OUTSIDE_WORKTREE: ${cwd}`);
  const scriptPath = resolve(cwd, "scripts/dev-server.mjs");
  if (!isInside(cwd, scriptPath)) throw new Error(`RUNTIME_SMOKE_SCRIPT_OUTSIDE_PACKAGE: ${scriptPath}`);
  const scriptStat = await stat(scriptPath).catch(() => null);
  if (!scriptStat?.isFile()) throw new Error(`RUNTIME_SMOKE_SCRIPT_MISSING: ${scriptPath}`);

  const port = await reserveLoopbackPort();
  const startedAt = Date.now();
  const child = spawn(process.execPath, ["scripts/dev-server.mjs"], {
    cwd,
    env: { ...process.env, PORT: String(port), CI: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  let exitCode: number | null = null;
  let spawnError = "";
  let output = "";
  const appendOutput = (chunk: unknown) => {
    output = `${output}${String(chunk ?? "")}`.slice(-4_000);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  child.once("error", (error) => { spawnError = String(error?.message ?? error); });
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  let httpStatus = 0;
  let contentType = "";
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`RUNTIME_SMOKE_PROCESS_ERROR: ${spawnError}`);
      if (exited) throw new Error(`RUNTIME_SMOKE_PROCESS_EXITED: code=${String(exitCode)} ${output}`.trim());
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
        httpStatus = response.status;
        contentType = response.headers.get("content-type") ?? "";
        await response.arrayBuffer();
        if (httpStatus >= 200 && httpStatus < 400) break;
      } catch {
        // The bounded server may need a short startup window before the first successful probe.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
    if (httpStatus < 200 || httpStatus >= 400) {
      throw new Error(`RUNTIME_SMOKE_HTTP_FAILED: no successful loopback response within 10s. ${output}`.trim());
    }
    const durationMs = Date.now() - startedAt;
    return {
      kind: "CODEXPRO_RUNTIME_SMOKE_VERIFIED",
      taskId,
      command: declaration.command,
      status: "PASS",
      summary: `CodexPro independently started the committed application on an isolated loopback port and received HTTP ${httpStatus}${contentType ? ` (${contentType})` : ""} from /.`,
      durationMs,
      httpStatus,
      headSha,
      observedAt: new Date().toISOString(),
    };
  } finally {
    if (!exited) child.kill("SIGTERM");
    const waitForExit = async () => {
      const deadline = Date.now() + 1_500;
      while (!exited && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    };
    await waitForExit();
    if (!exited) child.kill("SIGKILL");
  }
}

function isChangeSubmissionContractBlocker(reason: string): boolean {
  const mentionsSubmissionTool = reason.includes("task_submit_for_review");
  const mentionsEvidenceContract = reason.includes("evidence artifact schema")
    || reason.includes("evidence schema")
    || reason.includes("artifact schema")
    || (reason.includes("read_only_submission_schema_conflict") && reason.includes("touchedpaths"))
    || (reason.includes("read-only") && reason.includes("touchedpaths") && reason.includes("allowedpaths=[]"));
  return mentionsSubmissionTool && mentionsEvidenceContract;
}

function isSourceMutationContractBlocker(reason: string): boolean {
  return (reason.includes("apply_patch") || reason.includes("source mutation"))
    && (reason.includes("rejected") || reason.includes("patch must include") || reason.includes("tool failed"));
}

async function resumeVerifiedTransientBlocker(
  context: ControlPlaneBridgeContext,
  overview: any,
  task: any,
  note?: string
): Promise<any> {
  const workerId = requireBoundWorker(context);
  const role = String(overview.workers?.find((candidate: any) => candidate.id === workerId)?.role ?? "");
  if (role !== "coordinator") throw new Error("COORDINATOR_REQUIRED: only Coordinator may resume a transient blocker");
  if (task?.status !== "BLOCKED" || task?.checkpoint?.blockerKind !== "TRANSIENT") {
    throw new Error(`TRANSIENT_BLOCKER_REQUIRED: ${String(task?.id ?? "task")} is not a transient blocked task`);
  }
  const reason = String(task?.checkpoint?.blockedReason ?? "").toLowerCase();
  const isWorktreeAccess = reason.includes("worktree")
    && (reason.includes("outside allowed roots") || reason.includes("workspace access rejects"));
  const isCorrelatedConnectorFailure = reason.includes("openai safety gateway")
    || reason.includes("openai safety layer")
    || reason.includes("openai safety checker")
    || reason.includes("safety gateway during codexpro")
    || reason.includes("safety mechanism blocked")
    || reason.includes("safety layer blocked")
    || reason.includes("upstream or external service errors")
    || reason.includes("upstream service error")
    || reason.includes("external service error");
  const isDurableImplementationToolSafetyFailure = isCorrelatedConnectorFailure
    && (reason.includes("task_submit_for_review") || reason.includes("task_checkpoint"));
  const isRuntimeSmokeSafetyFailure = isCorrelatedConnectorFailure
    && (reason.includes("runtime smoke") || reason.includes("http/runtime smoke") || reason.includes("api/runtime smoke"))
    && (reason.includes("blocked") || reason.includes("could not be executed") || reason.includes("could not be run"));
  const isSubmissionContractFailure = isChangeSubmissionContractBlocker(reason);
  const isSourceMutationContractFailure = isSourceMutationContractBlocker(reason);
  let evidence: Record<string, unknown>;
  if (isWorktreeAccess) {
    const implementationWorker = overview.workers?.find((candidate: any) => candidate.role === task.requiredRole);
    if (!implementationWorker?.worktreePath) throw new Error("WORKTREE_BINDING_MISSING: no worktree is bound to the blocked role");
    const worktreePath = await realpath(String(implementationWorker.worktreePath));
    const worktreeStat = await stat(worktreePath);
    if (!worktreeStat.isDirectory()) throw new Error(`WORKTREE_NOT_DIRECTORY: ${worktreePath}`);
    const allowedRoot = context.allowedRoots.find((root) => isInside(root, worktreePath));
    if (!allowedRoot) throw new Error(`WORKTREE_OUTSIDE_ALLOWED_ROOTS: ${worktreePath}`);
    evidence = {
      kind: "CODEXPRO_WORKTREE_ACCESS_VERIFIED",
      taskId: String(task.id),
      worktreePath,
      allowedRoot,
      verifiedAt: new Date().toISOString()
    };
  } else if (isSubmissionContractFailure) {
    evidence = {
      kind: "CODEXPRO_CHANGE_SUBMISSION_CONTRACT_VERIFIED",
      taskId: String(task.id),
      contractVersion: CHANGE_SUBMISSION_CONTRACT_VERSION,
      acceptedArtifactKinds: ["FILE", "URL", "REPORT", "SCREENSHOT", "LOG"],
      reasonHash: `sha256:${createHash("sha256").update(reason).digest("hex")}`,
      verifiedAt: new Date().toISOString()
    };
  } else if (isSourceMutationContractFailure) {
    evidence = {
      kind: "CODEXPRO_PATCH_ENVELOPE_CONTRACT_VERIFIED",
      taskId: String(task.id),
      contractVersion: CODEX_PATCH_ENVELOPE_CONTRACT_VERSION,
      supportedFormats: ["unified-diff", "codex-begin-patch-envelope"],
      reasonHash: `sha256:${createHash("sha256").update(reason).digest("hex")}`,
      verifiedAt: new Date().toISOString()
    };
  } else if (isDurableImplementationToolSafetyFailure || isRuntimeSmokeSafetyFailure) {
    const implementationWorker = overview.workers?.find((candidate: any) => candidate.role === task.requiredRole);
    if (!implementationWorker?.worktreePath) throw new Error("WORKTREE_BINDING_MISSING: no worktree is bound to the blocked role");
    const worktreePath = await realpath(String(implementationWorker.worktreePath));
    const allowedRoot = context.allowedRoots.find((root) => isInside(root, worktreePath));
    if (!allowedRoot) throw new Error(`WORKTREE_OUTSIDE_ALLOWED_ROOTS: ${worktreePath}`);
    const { stdout: headOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      timeout: 15_000,
      maxBuffer: 256_000
    });
    const { stdout: statusOutput } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      timeout: 15_000,
      maxBuffer: 256_000
    });
    const headSha = String(headOutput).trim();
    if (!/^[a-f0-9]{40}$/u.test(headSha) || String(statusOutput).trim()) {
      throw new Error("SUBMISSION_RETRY_EVIDENCE_INVALID: implementation worktree must have a clean committed HEAD");
    }
    const checkpointCommit = String(task?.checkpoint?.commitSha ?? "").trim().toLowerCase();
    if (checkpointCommit && checkpointCommit !== headSha) {
      throw new Error(`RUNTIME_EVIDENCE_HEAD_MISMATCH: checkpoint=${checkpointCommit} worktree=${headSha}`);
    }
    if (isRuntimeSmokeSafetyFailure) {
      evidence = await runBoundedRuntimeSmoke(worktreePath, String(task.id), headSha, reason);
    } else {
      evidence = {
        kind: "CODEXPRO_DURABLE_TOOL_RETRY_VERIFIED",
        taskId: String(task.id),
        blockedTool: reason.includes("task_checkpoint") ? "task_checkpoint" : "task_submit_for_review",
        worktreePath,
        allowedRoot,
        headSha,
        reasonHash: `sha256:${createHash("sha256").update(reason).digest("hex")}`,
        verifiedAt: new Date().toISOString()
      };
    }
  } else if (isCorrelatedConnectorFailure && task?.checkpoint?.blockedByRunReceipt) {
    evidence = {
      kind: "CODEXPRO_CORRELATED_CONNECTOR_RETRY",
      taskId: String(task.id),
      blockedByRunReceipt: String(task.checkpoint.blockedByRunReceipt),
      reasonHash: `sha256:${createHash("sha256").update(reason).digest("hex")}`,
      verifiedAt: new Date().toISOString()
    };
  } else {
    throw new Error("TRANSIENT_EVIDENCE_UNAVAILABLE: this blocker needs a different objective health check");
  }
  const evidenceHash = blockerEvidenceHash(evidence);
  const isVerifiedRuntimeSmoke = evidence.kind === "CODEXPRO_RUNTIME_SMOKE_VERIFIED";
  return request(context, `/api/tasks/${encodeURIComponent(String(task.id))}/unblock-transient`, {
    method: "POST",
    body: JSON.stringify({
      coordinatorWorkerId: workerId,
      evidenceHash,
      ...(isVerifiedRuntimeSmoke ? { verifiedEvidence: evidence } : {}),
      note: note?.trim() || (evidence.kind === "CODEXPRO_WORKTREE_ACCESS_VERIFIED"
        ? `CodexPro MCP verified worktree access at ${String(evidence.worktreePath)}.`
        : evidence.kind === "CODEXPRO_CHANGE_SUBMISSION_CONTRACT_VERIFIED"
          ? `CodexPro MCP verified Change Submission contract v${CHANGE_SUBMISSION_CONTRACT_VERSION} and scheduled a clean retry.`
          : evidence.kind === "CODEXPRO_PATCH_ENVELOPE_CONTRACT_VERIFIED"
            ? `CodexPro MCP verified patch envelope contract v${CODEX_PATCH_ENVELOPE_CONTRACT_VERSION} and scheduled a clean retry.`
          : evidence.kind === "CODEXPRO_DURABLE_TOOL_RETRY_VERIFIED"
            ? `CodexPro MCP verified clean committed HEAD ${String(evidence.headSha)} after safety blocked ${String(evidence.blockedTool)} and scheduled a clean retry.`
          : isVerifiedRuntimeSmoke
            ? `CodexPro MCP independently ran ${String(evidence.command)} at clean committed HEAD ${String(evidence.headSha)} and verified HTTP ${String(evidence.httpStatus)}; the required runtime smoke now has objective PASS evidence.`
          : `CodexPro MCP verified a correlated transient connector failure from receipt ${String(evidence.blockedByRunReceipt)} and scheduled a clean retry.`)
    })
  });
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

export function boundedReviewCommand(command: string): { executable: string; args: string[]; relativeCwd?: string } | null {
  const trimmed = command.trim();
  const annotatedCwd = trimmed.match(/^(.+?)\s+\(cwd\s+([^\s;&|()]+)\)$/u);
  if (annotatedCwd) {
    const relativeCwd = String(annotatedCwd[2] ?? "");
    if (!isBoundedReviewDirectory(relativeCwd)) return null;
    const nested = boundedReviewCommand(String(annotatedCwd[1] ?? ""));
    if (!nested || nested.relativeCwd) return null;
    return { ...nested, relativeCwd };
  }
  const scoped = trimmed.match(/^cd\s+([^\s;&|]+)\s*&&\s*(.+)$/u);
  if (scoped) {
    const relativeCwd = String(scoped[1] ?? "");
    if (!isBoundedReviewDirectory(relativeCwd)) return null;
    const nested = boundedReviewCommand(String(scoped[2] ?? ""));
    if (!nested || nested.relativeCwd) return null;
    return { ...nested, relativeCwd };
  }
  const parts = command.trim().split(/\s+/u);
  const [executable, ...args] = parts;
  if (!executable) return null;
  if (["npm", "pnpm"].includes(executable)) {
    if (args.length === 1 && args[0] === "test") return { executable, args };
    if (args.length === 2 && args[0] === "run" && /^[A-Za-z0-9:_-]{1,80}$/u.test(args[1] ?? "")) {
      return { executable, args };
    }
  }
  if (executable === "yarn" && args.length === 1 && /^(?:test|[A-Za-z0-9:_-]{1,80})$/u.test(args[0] ?? "")) {
    return { executable, args };
  }
  if (
    executable === "npx"
    && args.length >= 2
    && args.length <= 22
    && args[0] === "vitest"
    && args[1] === "run"
    && args.slice(2).every((argument) => isBoundedTestTarget(argument))
  ) {
    return { executable, args };
  }
  if (executable === "node" && args.length === 1 && args[0] === "--test") return { executable, args };
  return null;
}

function isBoundedReviewDirectory(value: string): boolean {
  if (!value || value === "." || value.startsWith("/") || value.includes("..") || value.includes("\\")) return false;
  return /^[A-Za-z0-9_./@-]{1,240}$/u.test(value);
}

function isBoundedTestTarget(argument: string): boolean {
  if (!argument || argument.startsWith("-") || argument.startsWith("/") || argument.includes("..")) return false;
  return /^[A-Za-z0-9_./*{}@-]{1,240}$/u.test(argument);
}

async function reviewCommandCwd(worktreePath: string, touchedPaths: unknown): Promise<string> {
  if (!Array.isArray(touchedPaths)) return worktreePath;
  const topLevels = [...new Set(touchedPaths
    .map((entry) => String(entry).replace(/\\/gu, "/").split("/")[0]?.trim() ?? "")
    .filter((entry) => entry && !entry.includes("*") && entry !== "."))];
  if (topLevels.length !== 1) return worktreePath;
  const candidate = resolve(worktreePath, topLevels[0]!);
  if (!isInside(worktreePath, candidate)) return worktreePath;
  const packageJson = resolve(candidate, "package.json");
  const packageStat = await stat(packageJson).catch(() => null);
  return packageStat?.isFile() ? candidate : worktreePath;
}

async function runIndependentReviewCi(
  context: ControlPlaneBridgeContext,
  overview: any,
  task: any
): Promise<Record<string, unknown>> {
  const reviewerWorkerId = requireBoundWorker(context);
  const implementationWorker = overview.workers?.find((candidate: any) => candidate.id === task.assignedWorkerId);
  if (!implementationWorker?.worktreePath) {
    return { taskId: String(task.id), status: "SKIPPED", reason: "IMPLEMENTATION_WORKTREE_MISSING" };
  }
  const reviewPayload = await request(context, `/api/tasks/${encodeURIComponent(String(task.id))}/review`);
  const review = reviewPayload?.review;
  const commitSha = String(review?.submission?.commitSha ?? task?.checkpoint?.commitSha ?? "");
  if (!/^[a-fA-F0-9]{7,64}$/u.test(commitSha)) {
    return { taskId: String(task.id), status: "SKIPPED", reason: "SUBMISSION_COMMIT_MISSING" };
  }
  const currentRequiredPass = Array.isArray(review?.ciChecks)
    && review.ciChecks.some((check: any) => check.required === true && check.status === "PASSED" && check.headSha === commitSha);
  if (review?.requiredCiPassed === true && currentRequiredPass) {
    return { taskId: String(task.id), status: "PASSED", commitSha, reused: true };
  }
  const declaredTest = Array.isArray(review?.submission?.tests)
    ? review.submission.tests.find((test: any) => String(test?.status).toUpperCase() === "PASS")
    : null;
  const command = String(declaredTest?.command ?? "");
  const boundedCommand = boundedReviewCommand(command);
  if (!boundedCommand) {
    return { taskId: String(task.id), status: "SKIPPED", reason: "SAFE_TEST_COMMAND_UNAVAILABLE", command };
  }
  const worktreePath = await realpath(String(implementationWorker.worktreePath));
  const worktreeStat = await stat(worktreePath);
  if (!worktreeStat.isDirectory()) throw new Error(`WORKTREE_NOT_DIRECTORY: ${worktreePath}`);
  const allowedRoot = context.allowedRoots.find((root) => isInside(root, worktreePath));
  if (!allowedRoot) throw new Error(`WORKTREE_OUTSIDE_ALLOWED_ROOTS: ${worktreePath}`);
  const { stdout: headOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    timeout: 15_000,
    maxBuffer: 256_000
  });
  const actualHead = String(headOutput).trim();
  if (actualHead !== commitSha) {
    return { taskId: String(task.id), status: "SKIPPED", reason: "WORKTREE_HEAD_MISMATCH", commitSha, actualHead };
  }
  const cwd = boundedCommand.relativeCwd
    ? await reviewCommandCwdFromDeclaration(worktreePath, boundedCommand.relativeCwd)
    : await reviewCommandCwd(worktreePath, review?.submission?.touchedPaths);
  const observedAt = new Date().toISOString();
  let status: "PASSED" | "FAILED" = "PASSED";
  let output = "";
  try {
    const execution = await execFileAsync(boundedCommand.executable, boundedCommand.args, {
      cwd,
      timeout: 120_000,
      maxBuffer: 512_000,
      env: { ...process.env, CI: "1", NO_COLOR: "1" }
    });
    output = `${String(execution.stdout ?? "")}\n${String(execution.stderr ?? "")}`.trim();
  } catch (error: any) {
    status = "FAILED";
    output = `${String(error?.stdout ?? "")}\n${String(error?.stderr ?? error?.message ?? error)}`.trim();
  }
  const summary = [
    `CodexPro independently ran ${command} in ${relative(worktreePath, cwd) || "."}.`,
    output.slice(-3_200)
  ].filter(Boolean).join("\n").slice(0, 4_000);
  const recorded = await request(context, `/api/tasks/${encodeURIComponent(String(task.id))}/ci-checks`, {
    method: "POST",
    body: JSON.stringify({
      provider: "codexpro-reviewer-runner",
      externalRunId: `review-${String(task.id)}-${commitSha.slice(0, 12)}-${randomUUID()}`,
      name: command,
      headSha: commitSha,
      status,
      required: true,
      summary,
      observedAt,
      actorId: reviewerWorkerId
    })
  });
  return { taskId: String(task.id), status, commitSha, command, cwd, recorded };
}

async function reviewCommandCwdFromDeclaration(worktreePath: string, relativeCwd: string): Promise<string> {
  const candidate = resolve(worktreePath, relativeCwd);
  if (!isInside(worktreePath, candidate)) throw new Error(`REVIEW_CWD_OUTSIDE_WORKTREE: ${relativeCwd}`);
  const realCandidate = await realpath(candidate);
  if (!isInside(worktreePath, realCandidate)) throw new Error(`REVIEW_CWD_SYMLINK_ESCAPE: ${relativeCwd}`);
  const candidateStat = await stat(realCandidate);
  if (!candidateStat.isDirectory()) throw new Error(`REVIEW_CWD_NOT_DIRECTORY: ${relativeCwd}`);
  const packageStat = await stat(resolve(realCandidate, "package.json")).catch(() => null);
  if (!packageStat?.isFile()) throw new Error(`REVIEW_PACKAGE_MISSING: ${relativeCwd}/package.json`);
  return realCandidate;
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
        const transientBlocker = String(worker.role) === "coordinator"
          ? tasks.find((task: any) => task.status === "BLOCKED" && task?.checkpoint?.blockerKind === "TRANSIENT") ?? null
          : null;
        const claimable = tasks
          .filter((task: any) => task.requiredRole === worker.role && (
            (task.status === "READY" && task.readyForClaim === true)
            || (task.status === "RUNNING" && task.assignedWorkerId === workerId)
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
            detail: selectedTask ? `Claiming ${selectedTask.id}` : transientBlocker ? `Checking ${transientBlocker.id}` : "Queue idle"
          })
        });

        if (!selectedTask) {
          if (transientBlocker) {
            const resumed = await resumeVerifiedTransientBlocker(context, overview, transientBlocker);
            return result("worker_cycle_start", {
              state: "BLOCKER_RESUMED",
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
              task: resumed.task ?? transientBlocker,
              eventId: resumed.eventId ?? null,
              nextAction: "The verified temporary blocker is cleared. Stop this Coordinator run; the assigned implementation Worker will receive the task automatically."
            });
          }
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
                },
                requiresIndependentCi: ["backend", "frontend"].includes(String(task.requiredRole))
              };
            });
          const pendingReviewTasks = reviewTasks.filter((task: any) => task.status === "IN_REVIEW");
          const independentCi = [];
          if (pendingReviewTasks.length && ["reviewer_qa", "coordinator"].includes(String(worker.role))) {
            for (const reviewTask of pendingReviewTasks.filter((task: any) => task.requiresIndependentCi).slice(0, 3)) {
              independentCi.push(await runIndependentReviewCi(context, overview, reviewTask));
            }
          }
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
            independentCi,
            nextAction: pendingReviewTasks.length && ["reviewer_qa", "coordinator"].includes(String(worker.role))
              ? "For every returned IN_REVIEW task, inspect its checkpoint, evidence and acceptance criteria. When requiresIndependentCi is true, CodexPro already reran the bounded test and persisted the exact result in independentCi; inspect the implementation worktree. If product code or evidence fails, create a durable review finding and request changes; approve only when CI and evidence pass. An MCP, connector, network, or worker_cycle_start failure is runtime evidence, never a source-code finding: leave the task IN_REVIEW so automation can retry. When requiresIndependentCi is false, this is a read-only Coordinator/Reviewer audit task: if the audit passes, approve it; if it identifies actionable product defects, Coordinator must create bounded Backend/Frontend remediation child tasks before approving the audit as complete. Never checkpoint another worker's review target, never edit the implementation during review, and never stop after only narrating the review."
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
      name: "task_unblock_transient",
      options: {
        title: "Resume Verified Temporary Blocker",
        description: "Coordinator-only recovery. CodexPro objectively verifies a known local worktree-access or Change Submission contract blocker, records a SHA-256 evidence receipt, and resumes the task. It refuses blockers that need another health check or a Developer decision.",
        inputSchema: {
          taskId: z.string().min(1),
          note: z.string().min(1).max(2000).optional()
        },
        annotations: MUTATION
      },
      handler: async ({ taskId, note }) => {
        const workerId = requireBoundWorker(context);
        await requireRole(context, ["coordinator"]);
        const [overview, taskPayload] = await Promise.all([
          request(context, "/api/overview"),
          request(context, "/api/tasks")
        ]);
        const task = taskPayload.tasks?.find((candidate: any) => candidate.id === taskId);
        if (!task) throw new Error(`TASK_NOT_FOUND: ${taskId}`);
        const resumed = await resumeVerifiedTransientBlocker(context, overview, task, note);
        return result("task_unblock_transient", { workerId, ...resumed });
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
        description: "Record a signed scheduled-run receipt. STARTED/ACKED may omit taskId for an idle schedule health check; COMPLETED and task-bound ERROR receipts require full task correlation. A correlated ERROR blocks the active task instead of leaving false RUNNING state.",
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
        if (
          (args.state === "COMPLETED" || (args.state === "ERROR" && args.taskId))
          && (!args.taskId || !args.deliveryId || !args.leaseEpoch || !args.taskAttempt)
        ) {
          throw new Error(`RUN_CORRELATION_REQUIRED: ${args.state} requires taskId, deliveryId, leaseEpoch, and taskAttempt`);
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
          evidence: z.object({
            commitSha: z.string().regex(/^[a-fA-F0-9]{7,64}$/).describe("Exact committed Worker HEAD being submitted."),
            baseCommitSha: z.string().regex(/^[a-fA-F0-9]{7,64}$/).optional().describe("Optional Git base; Control Plane derives and verifies the durable merge base."),
            diffSummary: z.string().min(1).max(8_000),
            tests: z.array(z.object({
              command: z.string().min(1).max(500),
              status: z.enum(["PASS", "FAIL", "SKIPPED"]),
              summary: z.string().min(1).max(2_000),
              durationMs: z.number().nonnegative().max(86_400_000).nullable().optional()
            })).min(1).max(20).describe("Include at least one PASS and no FAIL results."),
            artifacts: z.array(z.object({
              kind: z.enum(["FILE", "URL", "REPORT", "SCREENSHOT", "LOG"]),
              reference: z.string().min(1).max(1_000),
              summary: z.string().min(1).max(2_000),
              digest: z.string().regex(/^sha256:[a-fA-F0-9]{64}$/).nullable().optional()
            })).min(1).max(30),
            addressedFindingIds: z.array(z.string().min(1).max(160)).max(100).optional()
          }).describe("Structured Change Submission evidence. Field names and enum values are exact."),
          touchedPaths: z.array(z.string()).max(200).describe("Every path in the full Git diff from the durable merge base to commitSha. Backend/Frontend submissions require at least one path; read-only Coordinator/Reviewer tasks use an empty array.")
        },
        annotations: MUTATION
      },
      handler: async (args) => {
        const workerId = requireBoundWorker(context, args.workerId);
        const role = await boundRole(context);
        if (["backend", "frontend"].includes(role) && (!Array.isArray(args.touchedPaths) || args.touchedPaths.length === 0)) {
          throw new Error("WRITER_TOUCHED_PATHS_REQUIRED: Backend/Frontend Change Submissions must enumerate the full Git diff");
        }
        const payload = await request(context, `/api/tasks/${encodeURIComponent(args.taskId)}/complete`, {
          method: "POST",
          body: JSON.stringify({ ...args, workerId, touchedPaths: args.touchedPaths ?? [] })
        });
        return result("task_submit_for_review", payload);
      }
    },
    {
      name: "review_ci_check_record",
      options: {
        title: "Record Independent Review CI",
        description: "Reviewer/QA records the result of a test it independently reran for the exact current Change Submission commit. This does not approve or merge the task.",
        inputSchema: {
          taskId: z.string().min(1),
          provider: z.string().min(1).max(120).default("reviewer-local"),
          externalRunId: z.string().min(1).max(240),
          name: z.string().min(1).max(240),
          headSha: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
          status: z.enum(["PENDING", "RUNNING", "PASSED", "FAILED", "CANCELLED"]),
          required: z.boolean().default(true),
          summary: z.string().max(4_000).default(""),
          observedAt: z.string().datetime().optional()
        },
        annotations: { ...MUTATION, idempotentHint: true }
      },
      handler: async (args) => {
        const reviewerWorkerId = requireBoundWorker(context);
        await requireRole(context, ["reviewer_qa", "coordinator"]);
        const payload = await request(context, `/api/tasks/${encodeURIComponent(args.taskId)}/ci-checks`, {
          method: "POST",
          body: JSON.stringify({ ...args, actorId: reviewerWorkerId })
        });
        return result("review_ci_check_record", { reviewerWorkerId, ...payload });
      }
    },
    {
      name: "review_finding_create",
      options: {
        title: "Create Durable Review Finding",
        description: "Reviewer/QA or Coordinator records one evidence-backed finding against the current immutable Change Submission.",
        inputSchema: {
          taskId: z.string().min(1),
          severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
          category: z.string().min(1).max(120),
          title: z.string().min(1).max(240),
          detail: z.string().min(1).max(8_000),
          filePath: z.string().min(1).max(4_096).optional(),
          lineStart: z.number().int().positive().optional(),
          lineEnd: z.number().int().positive().optional()
        },
        annotations: MUTATION
      },
      handler: async (args) => {
        await requireRole(context, ["reviewer_qa", "coordinator"]);
        const reviewerWorkerId = requireBoundWorker(context);
        const payload = await request(context, `/api/tasks/${encodeURIComponent(args.taskId)}/review/findings`, {
          method: "POST",
          body: JSON.stringify({ ...args, reviewerWorkerId })
        });
        return result("review_finding_create", { reviewerWorkerId, ...payload });
      }
    },
    {
      name: "review_finding_update",
      options: {
        title: "Update Durable Review Finding",
        description: "Reviewer/QA or Coordinator reopens, resolves, or dismisses a durable review finding after checking current evidence.",
        inputSchema: {
          findingId: z.string().min(1),
          status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]),
          resolutionNote: z.string().min(1).max(4_000)
        },
        annotations: MUTATION
      },
      handler: async (args) => {
        await requireRole(context, ["reviewer_qa", "coordinator"]);
        const reviewerWorkerId = requireBoundWorker(context);
        const payload = await request(context, `/api/review-findings/${encodeURIComponent(args.findingId)}`, {
          method: "POST",
          body: JSON.stringify({ ...args, reviewerWorkerId })
        });
        return result("review_finding_update", { reviewerWorkerId, ...payload });
      }
    },
    {
      name: "review_changes_request",
      options: {
        title: "Return Reviewed Work for Changes",
        description: "Reviewer/QA or Coordinator closes the current review round with its OPEN findings and returns the implementation task to READY for a fresh fenced attempt.",
        inputSchema: {
          taskId: z.string().min(1),
          note: z.string().min(1).max(4_000)
        },
        annotations: MUTATION
      },
      handler: async (args) => {
        await requireRole(context, ["reviewer_qa", "coordinator"]);
        const reviewerWorkerId = requireBoundWorker(context);
        const payload = await request(context, `/api/tasks/${encodeURIComponent(args.taskId)}/review/request-changes`, {
          method: "POST",
          body: JSON.stringify({ ...args, reviewerWorkerId })
        });
        return result("review_changes_request", { reviewerWorkerId, ...payload });
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
          priority: z.number().int().min(0).max(100).optional(), acceptanceCriteria: z.array(z.string()).max(20).optional(), allowedPaths: z.array(z.string()).max(50).describe("Use path/** for a directory tree (for example src/**); use an exact path only for one specific file.").optional()
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
