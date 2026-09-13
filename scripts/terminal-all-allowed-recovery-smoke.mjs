import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-terminal-all-allowed-recovery-"));
const primaryRoot = path.join(scratchRoot, "repo");
const remoteRoot = path.join(scratchRoot, "origin.git");
const codexProHome = path.join(scratchRoot, "codexpro-home");
process.env.CODEXPRO_HOME = codexProHome;

function git(args, cwd = primaryRoot) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return String(result.stdout || "").trim();
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    server.on("error", reject);
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for HTTP server\n${stderr}`)), 15_000);
    timer.unref();
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("HTTP MCP listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code}\n${stderr}`));
    });
  });
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const content = result.content?.find?.((part) => part.type === "text")?.text || JSON.stringify(result.structuredContent);
    throw new Error(`${name} failed: ${content}`);
  }
  return result;
}

async function expectToolErrorCode(client, name, args, expectedCode) {
  const result = await client.callTool({ name, arguments: args });
  const actualCode = String(result?.structuredContent?.error?.code || "");
  assert.equal(result?.isError, true, `${name} should fail closed`);
  assert.equal(actualCode, expectedCode, `${name} returned ${actualCode || "no error code"}`);
  return result;
}

async function expectErrorCode(operation, expectedCode) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, expectedCode);
    return true;
  });
}

function context(taskId, workerId, root = primaryRoot) {
  return { taskId, workerId, title: `Recovery fixture ${taskId.slice(-4)}`, root };
}

await fs.mkdir(primaryRoot, { recursive: true });
await fs.mkdir(codexProHome, { recursive: true });
await fs.writeFile(path.join(primaryRoot, "owned.txt"), "initial\n", "utf8");
await fs.writeFile(path.join(primaryRoot, "verify.mjs"), "console.log('verification pass');\n", "utf8");
git(["init"]);
git(["config", "user.name", "CodexPro Recovery Smoke"]);
git(["config", "user.email", "recovery-smoke@example.invalid"]);
git(["add", "owned.txt", "verify.mjs"]);
git(["commit", "-m", "initial recovery fixture"]);
git(["branch", "-M", "win"]);
git(["init", "--bare", remoteRoot], scratchRoot);
git(["remote", "add", "origin", remoteRoot]);
git(["push", "-u", "origin", "win"]);
const initialHead = git(["rev-parse", "HEAD"]);

const coordination = await import(pathToFileURL(path.join(projectRoot, "dist", "workspaceCoordination.js")).href);
const {
  acquireWorkspaceIntegrationLease,
  claimWorkspacePaths,
  finalizeWorkspaceTask,
  readWorkspaceCoordination,
  recoverWorkspaceTask,
  registerWorkspaceTask,
  releaseWorkspacePaths
} = coordination;

const port = await getFreePort();
const token = createHash("sha256").update("terminal all allowed recovery smoke").digest("hex");
const taskId = "cpt_717171717171717171717171";
const owner = "terminal-recovery-owner";
const child = spawn(process.execPath, ["dist/http.js"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CODEXPRO_ROOT: primaryRoot,
    CODEXPRO_ALLOWED_ROOTS: scratchRoot,
    CODEXPRO_HOST: "127.0.0.1",
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_BASH_MODE: "full",
    CODEXPRO_WRITE_MODE: "workspace",
    CODEXPRO_HOME: codexProHome
  },
  stdio: ["ignore", "pipe", "pipe"]
});

const clients = [];
async function createClient(name, profileId = "") {
  const client = new Client({ name, version: "0.0.0" });
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  if (profileId) url.searchParams.set("codexpro_profile", profileId);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

try {
  await waitForListening(child);
  const managerA = await createClient("terminal-recovery-manager-a");
  const managerB = await createClient("terminal-recovery-manager-b");
  const worker = await createClient("terminal-recovery-worker", owner);

  const managerTools = new Set((await managerA.listTools()).tools.map((tool) => tool.name));
  const workerTools = new Set((await worker.listTools()).tools.map((tool) => tool.name));
  assert.equal(managerTools.has("recover_repo_task"), true, "Manager must expose terminal recovery");
  assert.equal(workerTools.has("recover_repo_task"), false, "worker sessions must not expose Manager recovery");

  const prepared = await callTool(managerA, "prepare_repo_task", {
    profile_id: owner,
    task_id: taskId,
    scope: "all_allowed"
  });
  assert.equal(prepared.structuredContent.root_unbound, true);

  const began = await callTool(worker, "begin_repo_task", {
    task_id: taskId,
    task_title: "Recover terminal existing task",
    task_kind: "code",
    task_size: "large",
    root: primaryRoot,
    scope: "all_allowed"
  });
  const worktreeRoot = String(began.structuredContent.worktree_root || "");
  const worktreeBranch = String(began.structuredContent.worktree_branch || "");
  assert.ok(worktreeRoot && worktreeBranch);
  assert.notEqual(path.resolve(worktreeRoot), path.resolve(primaryRoot));

  await callTool(worker, "report_worker_job_progress", {
    task_id: taskId,
    stage: "started",
    progress_percent: 10,
    summary: "Durable recovery fixture checklist recorded.",
    completed_parts: [],
    remaining_parts: ["implementation", "delivery"],
    checklist: [
      { id: "implementation", title: "Implement lifecycle recovery fixture", status: "in_progress" },
      { id: "delivery", title: "Complete repository delivery", status: "pending" }
    ]
  });
  await callTool(worker, "write", { path: "owned.txt", content: "terminal recovery implementation\n" });
  await callTool(worker, "bash", { command: "git add owned.txt" });
  await callTool(worker, "bash", { command: "git commit -m \"terminal recovery implementation\"" });
  await callTool(worker, "bash", { command: "node --check verify.mjs" });
  await callTool(worker, "report_worker_job_progress", {
    task_id: taskId,
    stage: "verifying",
    progress_percent: 95,
    summary: "Implementation committed and verified; delivery remains.",
    completed_parts: ["implementation", "verification"],
    remaining_parts: ["delivery"],
    checklist: [
      { id: "implementation", title: "Implement lifecycle recovery fixture", status: "completed", evidence: "committed" },
      { id: "delivery", title: "Complete repository delivery", status: "in_progress" }
    ]
  });
  const checkpointHead = git(["rev-parse", "HEAD"], worktreeRoot);
  assert.notEqual(checkpointHead, initialHead);
  assert.equal(git(["status", "--short"], worktreeRoot), "");

  const releaseFailedIntegration = await acquireWorkspaceIntegrationLease({ taskId, workerId: owner, root: primaryRoot }, "win");
  await releaseFailedIntegration();
  const provenanceBeforeFailure = readWorkspaceCoordination(primaryRoot).tasks[taskId];
  assert.equal(provenanceBeforeFailure.integrationStatus, "failed");
  assert.deepEqual(provenanceBeforeFailure.claimedPaths, ["owned.txt"]);
  assert.deepEqual(provenanceBeforeFailure.touchedPaths, ["owned.txt"]);
  assert.ok(provenanceBeforeFailure.commitShas.includes(checkpointHead));
  assert.equal(provenanceBeforeFailure.lastVerificationStatus, "passed");

  const workerBeforeFailure = await callTool(worker, "worker_job_status", { task_id: taskId });
  const progressSequence = workerBeforeFailure.structuredContent.job.progress_sequence;
  const progressReportCount = workerBeforeFailure.structuredContent.job.progress_reports.length;
  await callTool(worker, "finalize_worker_job", {
    task_id: taskId,
    outcome: "failed",
    summary: "integration failed after implementation",
    error: "fixture delivery failure"
  });
  const failedState = readWorkspaceCoordination(primaryRoot);
  assert.equal(failedState.tasks[taskId].status, "failed");
  assert.equal(failedState.tasks[taskId].integrationStatus, "failed");
  assert.equal(Object.values(failedState.claims).some((claim) => claim.taskId === taskId), false);

  await expectToolErrorCode(managerA, "recover_repo_task", {
    profile_id: "wrong-terminal-owner",
    task_id: taskId
  }, "REPO_TASK_RECOVERY_OWNER_MISMATCH");

  const completedId = "cpt_727272727272727272727272";
  const completedOwner = "completed-recovery-owner";
  const completedWorker = await createClient("completed-recovery-worker", completedOwner);
  await callTool(managerA, "prepare_repo_task", { profile_id: completedOwner, task_id: completedId, root: primaryRoot, scope: "workspace" });
  await callTool(completedWorker, "begin_repo_task", {
    task_id: completedId,
    task_title: "Reject completed recovery task",
    task_kind: "code",
    task_size: "small",
    root: primaryRoot,
    scope: "workspace"
  });
  await callTool(completedWorker, "finalize_worker_job", { task_id: completedId, outcome: "completed", summary: "no source changes" });
  await expectToolErrorCode(managerA, "recover_repo_task", { profile_id: completedOwner, task_id: completedId }, "REPO_TASK_RECOVERY_COMPLETED");

  const missingId = "cpt_737373737373737373737373";
  const missing = await registerWorkspaceTask(context(missingId, "missing-owner"));
  await finalizeWorkspaceTask(context(missingId, "missing-owner"), "failed");
  const hiddenWorktree = `${missing.worktreeRoot}-missing`;
  await fs.rename(missing.worktreeRoot, hiddenWorktree);
  try {
    await expectErrorCode(recoverWorkspaceTask({ taskId: missingId, workerId: "missing-owner" }), "WORKSPACE_TASK_RECOVERY_WORKTREE_MISSING");
  } finally {
    await fs.rename(hiddenWorktree, missing.worktreeRoot);
  }

  const branchMismatchId = "cpt_747474747474747474747474";
  const branchMismatch = await registerWorkspaceTask(context(branchMismatchId, "branch-owner"));
  await finalizeWorkspaceTask(context(branchMismatchId, "branch-owner"), "failed");
  git(["switch", "-c", "foreign-branch"], branchMismatch.worktreeRoot);
  await expectErrorCode(recoverWorkspaceTask({ taskId: branchMismatchId, workerId: "branch-owner" }), "WORKSPACE_TASK_RECOVERY_BRANCH_MISMATCH");
  git(["switch", branchMismatch.worktreeBranch], branchMismatch.worktreeRoot);

  const claimTargetId = "cpt_757575757575757575757575";
  const claimForeignId = "cpt_767676767676767676767676";
  await registerWorkspaceTask(context(claimTargetId, "claim-target-owner"));
  await claimWorkspacePaths(context(claimTargetId, "claim-target-owner"), ["claimed-conflict.txt"]);
  await finalizeWorkspaceTask(context(claimTargetId, "claim-target-owner"), "failed");
  await registerWorkspaceTask(context(claimForeignId, "claim-foreign-owner"));
  await claimWorkspacePaths(context(claimForeignId, "claim-foreign-owner"), ["claimed-conflict.txt"]);
  await expectErrorCode(recoverWorkspaceTask({ taskId: claimTargetId, workerId: "claim-target-owner" }), "WORKSPACE_TASK_RECOVERY_CLAIM_CONFLICT");
  await releaseWorkspacePaths(context(claimForeignId, "claim-foreign-owner"), ["claimed-conflict.txt"]);
  await finalizeWorkspaceTask(context(claimForeignId, "claim-foreign-owner"), "cancelled");

  const writerTargetId = "cpt_777777777777777777777777";
  const writerForeignId = "cpt_787878787878787878787878";
  await registerWorkspaceTask(context(writerTargetId, "shared-writer-owner"));
  await finalizeWorkspaceTask(context(writerTargetId, "shared-writer-owner"), "failed");
  await registerWorkspaceTask(context(writerForeignId, "shared-writer-owner"));
  await expectErrorCode(recoverWorkspaceTask({ taskId: writerTargetId, workerId: "shared-writer-owner" }), "WORKSPACE_TASK_RECOVERY_WRITER_CONFLICT");
  await finalizeWorkspaceTask(context(writerForeignId, "shared-writer-owner"), "cancelled");

  const leaseTargetId = "cpt_797979797979797979797979";
  const leaseForeignId = "cpt_808080808080808080808080";
  await registerWorkspaceTask(context(leaseTargetId, "lease-target-owner"));
  await finalizeWorkspaceTask(context(leaseTargetId, "lease-target-owner"), "failed");
  await registerWorkspaceTask(context(leaseForeignId, "lease-foreign-owner"));
  const releaseForeignLease = await acquireWorkspaceIntegrationLease(context(leaseForeignId, "lease-foreign-owner"));
  await expectErrorCode(recoverWorkspaceTask({ taskId: leaseTargetId, workerId: "lease-target-owner" }), "WORKSPACE_TASK_RECOVERY_INTEGRATION_BUSY");
  await releaseForeignLease();
  await finalizeWorkspaceTask(context(leaseForeignId, "lease-foreign-owner"), "cancelled");

  const rePrepared = await callTool(managerA, "prepare_repo_task", {
    profile_id: owner,
    task_id: taskId,
    scope: "all_allowed"
  });
  assert.equal(rePrepared.structuredContent.root_unbound, true, "ordinary all_allowed re-prepare must reproduce the unbound root");
  const splitStatus = await callTool(worker, "worker_job_status", { task_id: taskId });
  assert.equal(splitStatus.structuredContent.job.status, "prepared");
  assert.equal(splitStatus.structuredContent.job.root, "");

  const recoveryCalls = await Promise.all([
    callTool(managerA, "recover_repo_task", { profile_id: owner, task_id: taskId }),
    callTool(managerB, "recover_repo_task", { profile_id: owner, task_id: taskId })
  ]);
  assert.equal(recoveryCalls.every((result) => result.structuredContent.recovered === true), true);
  assert.equal(recoveryCalls.some((result) => result.structuredContent.recovery_deduplicated === true), true);
  for (const recovered of recoveryCalls) {
    assert.equal(recovered.structuredContent.task_id, taskId);
    assert.equal(recovered.structuredContent.profile_id, owner);
    assert.equal(recovered.structuredContent.scope, "all_allowed");
    assert.equal(path.resolve(recovered.structuredContent.root), path.resolve(worktreeRoot));
    assert.equal(recovered.structuredContent.root_unbound, false);
    assert.equal(recovered.structuredContent.worktree_head, checkpointHead);
    assert.equal(recovered.structuredContent.worktree_branch, worktreeBranch);
  }

  const recoveredCoordination = readWorkspaceCoordination(primaryRoot);
  const recoveredTask = recoveredCoordination.tasks[taskId];
  assert.equal(recoveredTask.status, "running");
  assert.equal(recoveredTask.finishedAt, undefined);
  assert.equal(recoveredTask.integrationStatus, "idle");
  for (const field of [
    "workerId",
    "baseHead",
    "baseBranch",
    "baseRemoteHead",
    "worktreeRoot",
    "worktreeBranch",
    "lastSourceChangeAt",
    "lastCommitAt",
    "lastVerificationAt",
    "lastVerificationStatus",
    "lastVerificationLabel",
    "lastVerificationHead",
    "lastVerificationTree",
    "integrationFinishedAt"
  ]) {
    assert.equal(recoveredTask[field], provenanceBeforeFailure[field], `${field} must be preserved`);
  }
  for (const field of ["claimedPaths", "touchedPaths", "commitShas", "verificationRuns"]) {
    assert.deepEqual(recoveredTask[field], provenanceBeforeFailure[field], `${field} must be preserved`);
  }
  assert.equal(recoveredCoordination.claims["owned.txt"]?.taskId, taskId);
  assert.equal(git(["rev-parse", "HEAD"], worktreeRoot), checkpointHead);
  assert.equal(git(["branch", "--show-current"], worktreeRoot), worktreeBranch);
  assert.equal(git(["status", "--short"], worktreeRoot), "");

  const preparedStatus = await callTool(worker, "worker_job_status", { task_id: taskId });
  assert.equal(preparedStatus.structuredContent.job.status, "prepared");
  assert.equal(path.resolve(preparedStatus.structuredContent.job.root), path.resolve(worktreeRoot));
  assert.equal(preparedStatus.structuredContent.job.progress_sequence, progressSequence);
  assert.equal(preparedStatus.structuredContent.job.progress_reports.length, progressReportCount);
  assert.equal(preparedStatus.structuredContent.job.events.some((entry) => entry.type === "finalized"), true);
  assert.equal(preparedStatus.structuredContent.job.events.some((entry) => entry.type === "terminal_recovery_prepared"), true);

  const resumed = await callTool(worker, "begin_repo_task", {
    task_id: taskId,
    task_title: "Recover terminal existing task",
    task_kind: "code",
    task_size: "large",
    root: worktreeRoot,
    scope: "all_allowed"
  });
  assert.equal(resumed.structuredContent.prepared_recovery, true);
  assert.equal(resumed.structuredContent.gate_active, true);
  assert.equal(resumed.structuredContent.task_id, taskId);
  assert.equal(path.resolve(resumed.structuredContent.root), path.resolve(worktreeRoot));
  assert.equal(path.resolve(resumed.structuredContent.coordination_root), path.resolve(primaryRoot));

  const runningWorker = await callTool(worker, "worker_job_status", { task_id: taskId });
  assert.equal(runningWorker.structuredContent.job.status, "running");
  assert.equal(runningWorker.structuredContent.job.job_id, taskId);
  assert.equal(runningWorker.structuredContent.job.worker_id, owner);
  assert.equal(runningWorker.structuredContent.job.progress_sequence, progressSequence);
  assert.equal(runningWorker.structuredContent.job.progress_reports.length, progressReportCount);
  assert.equal(runningWorker.structuredContent.job.events.some((entry) => entry.type === "finalized"), true);
  assert.equal(runningWorker.structuredContent.job.events.some((entry) => entry.type === "terminal_recovery_prepared"), true);
  const gateStatus = await callTool(worker, "repo_task_status", { task_id: taskId });
  assert.equal(gateStatus.structuredContent.gate_active, true);
  const deliveryStatus = await callTool(managerA, "workspace_coordination_status", { root: primaryRoot, task_id: taskId });
  assert.equal(deliveryStatus.structuredContent.task_status, "running");
  assert.equal(deliveryStatus.structuredContent.missing_claim_count, 0);
  assert.equal(deliveryStatus.structuredContent.safe_for_delivery, true);

  const coordinationFiles = (await fs.readdir(path.join(codexProHome, "workspace-coordination"))).filter((name) => name.endsWith(".json"));
  assert.equal(coordinationFiles.length, 1, "recovery must not create a duplicate coordination root");
  console.log("terminal all_allowed recovery smoke passed");
} finally {
  for (const client of clients.reverse()) await client.close().catch(() => undefined);
  child.kill("SIGTERM");
  await waitForExit(child);
  await fs.rm(scratchRoot, { recursive: true, force: true });
}
