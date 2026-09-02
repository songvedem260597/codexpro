import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-coordination-status-"));
const repoRoot = path.join(scratchRoot, "repo");
process.env.CODEXPRO_HOME = path.join(scratchRoot, "home");

const {
  acquireWorkspaceIntegrationLease,
  claimWorkspacePaths,
  finalizeWorkspaceTask,
  readWorkspaceCoordinationStatus,
  recordWorkspacePathsTouched,
  registerWorkspaceTask
} = await import(pathToFileURL(path.join(projectRoot, "dist", "workspaceCoordination.js")).href);

const TASK = { taskId: "cpt_121212121212121212121212", workerId: "worker:status", title: "Status smoke task", root: repoRoot };
const gitExecutable = process.platform === "win32" ? "git.exe" : "git";
const git = (args, cwd = repoRoot) => execFileSync(gitExecutable, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try {
  fs.mkdirSync(repoRoot, { recursive: true });
  git(["init"]);
  git(["config", "user.name", "CodexPro Status Smoke"]);
  git(["config", "user.email", "status-smoke@example.invalid"]);
  fs.writeFileSync(path.join(repoRoot, "a.txt"), "a0\n", "utf8");
  git(["add", "a.txt"]);
  git(["commit", "-m", "initial"]);
  git(["branch", "-M", "main"]);

  const registered = await registerWorkspaceTask(TASK);
  assert.ok(registered.worktreeRoot && fs.existsSync(registered.worktreeRoot), "status test should have an isolated worktree");
  await claimWorkspacePaths(TASK, ["a.txt"]);
  fs.writeFileSync(path.join(registered.worktreeRoot, "a.txt"), "task-side edit\n", "utf8");
  await recordWorkspacePathsTouched(TASK, ["a.txt"]);

  fs.writeFileSync(path.join(repoRoot, "a.txt"), "external committed edit\n", "utf8");
  git(["add", "a.txt"]);
  git(["commit", "-m", "advance shared head"]);

  const stale = readWorkspaceCoordinationStatus(repoRoot);
  const task = stale.tasks.find((item) => item.task_id === TASK.taskId);
  assert.ok(task, "status snapshot should expose the task");
  assert.equal(task.stale_base, true, "a watched path changed after task start should be marked stale");
  assert.deepEqual(task.stale_paths, ["a.txt"]);
  assert.equal(task.base_behind, true);
  assert.equal(task.worktree_root, registered.worktreeRoot);
  assert.equal(stale.claims[0]?.path, "a.txt");
  assert.equal(stale.claims[0]?.task_id, TASK.taskId);

  const release = await acquireWorkspaceIntegrationLease(TASK, "main");
  const integrating = readWorkspaceCoordinationStatus(repoRoot);
  assert.equal(integrating.integration_lease?.task_id, TASK.taskId);
  assert.equal(integrating.tasks.find((item) => item.task_id === TASK.taskId)?.integration_status, "integrating");
  await release();

  await finalizeWorkspaceTask(TASK, "cancelled");
  console.log("workspace coordination status smoke passed");
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
