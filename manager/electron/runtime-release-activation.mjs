import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runGitProcess } from "./process-runner.mjs";

export const RUNTIME_RELEASE_METADATA_FILE = "runtime-release.json";
export const RUNTIME_RELEASE_PENDING_FILE = "pending-runtime-release.json";

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function runtimeBuildId(filePath) {
  const stat = fs.statSync(filePath);
  return `${Math.floor(stat.mtimeMs)}:${stat.size}`;
}

function realPath(value) {
  const resolved = path.resolve(String(value || ""));
  return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
}

function releaseRoot(home) {
  return path.resolve(home, "runtime-releases");
}

function assertDirectReleasePath(home, releasePath) {
  const root = realPath(releaseRoot(home));
  const candidate = realPath(releasePath);
  if (path.dirname(candidate).toLowerCase() !== root.toLowerCase()) {
    throw new Error(`Runtime release must be a direct child of ${root}`);
  }
  const name = path.basename(candidate);
  if (!name || name.startsWith(".stage-") || name === RUNTIME_RELEASE_PENDING_FILE) {
    throw new Error(`Runtime release path is not activatable: ${candidate}`);
  }
  return candidate;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export async function verifyRuntimeRelease({ home, releasePath, runGit = runGitProcess }) {
  const candidate = assertDirectReleasePath(home, releasePath);
  const metadataPath = path.join(candidate, RUNTIME_RELEASE_METADATA_FILE);
  if (!fs.existsSync(metadataPath)) throw new Error(`Runtime release metadata is missing: ${metadataPath}`);
  const metadata = readJson(metadataPath);
  if (metadata?.version !== 1 || metadata?.verified !== true) throw new Error("Runtime release metadata is not verified.");
  if (String(metadata.release_id || "") !== path.basename(candidate)) throw new Error("Runtime release id does not match its directory.");
  const sourceCommit = String(metadata.source_commit || "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Runtime release source commit is invalid.");

  const required = [
    path.join(candidate, "scripts", "codexpro.mjs"),
    path.join(candidate, "dist", "http.js"),
    path.join(candidate, "package.json"),
    path.join(candidate, "node_modules")
  ];
  for (const requiredPath of required) {
    if (!fs.existsSync(requiredPath)) throw new Error(`Runtime release is missing required path: ${requiredPath}`);
  }

  const distHttp = path.join(candidate, "dist", "http.js");
  const distSha = sha256File(distHttp);
  const buildId = runtimeBuildId(distHttp);
  if (distSha !== String(metadata.dist_http_sha256 || "").toLowerCase()) throw new Error("Runtime release dist/http.js SHA256 mismatch.");
  if (buildId !== String(metadata.runtime_build_id || "")) throw new Error("Runtime release build id mismatch.");

  const gitResult = await runGit(["-C", candidate, "rev-parse", "HEAD"], { timeoutMs: 5_000 });
  const gitHead = String(gitResult?.stdout || "").trim().toLowerCase();
  if (gitHead !== sourceCommit) throw new Error(`Runtime release Git identity mismatch: ${gitHead || "unknown"}`);

  return {
    ...metadata,
    release_path: candidate,
    dist_http_sha256: distSha,
    runtime_build_id: buildId,
    source_commit: sourceCommit
  };
}

export async function readPendingRuntimeRelease({ home, runGit = runGitProcess }) {
  const pointerPath = path.join(releaseRoot(home), RUNTIME_RELEASE_PENDING_FILE);
  if (!fs.existsSync(pointerPath)) return null;
  const pointer = readJson(pointerPath);
  if (pointer?.version !== 1 || pointer?.verified !== true) throw new Error("Pending runtime release pointer is not verified.");
  const release = await verifyRuntimeRelease({ home, releasePath: pointer.release_path, runGit });
  for (const field of ["release_id", "source_commit", "dist_http_sha256", "runtime_build_id"]) {
    if (String(pointer?.[field] || "") !== String(release?.[field] || "")) {
      throw new Error(`Pending runtime release ${field} mismatch.`);
    }
  }
  return { ...release, pending_path: pointerPath };
}

export function clearPendingRuntimeRelease(home, releaseId) {
  const pointerPath = path.join(releaseRoot(home), RUNTIME_RELEASE_PENDING_FILE);
  if (!fs.existsSync(pointerPath)) return false;
  const pointer = readJson(pointerPath);
  if (String(pointer?.release_id || "") !== String(releaseId || "")) return false;
  fs.unlinkSync(pointerPath);
  return true;
}

function normalizeWindowsPath(value) {
  return path.win32.normalize(String(value || "")).replace(/[\\/]+$/, "");
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countPathOccurrences(text, value) {
  const matches = String(text || "").match(new RegExp(regexEscape(value), "gi"));
  return matches ? matches.length : 0;
}

export function validateScheduledTaskAction(task, home) {
  if (!task || String(task.state || "").toLowerCase() === "notfound") throw new Error("CodexPro Scheduled Task was not found.");
  if (Number(task.actionCount ?? task.action_count ?? 1) !== 1) throw new Error("CodexPro Scheduled Task must have exactly one action.");
  const execute = String(task.execute || "");
  if (path.win32.basename(execute).toLowerCase() !== "wscript.exe") throw new Error("CodexPro Scheduled Task action is not the expected hidden wscript launcher.");
  const workingDirectory = normalizeWindowsPath(task.workingDirectory);
  if (!workingDirectory) throw new Error("CodexPro Scheduled Task working directory is missing.");
  const root = normalizeWindowsPath(path.join(home, "runtime-releases"));
  if (path.win32.dirname(workingDirectory).toLowerCase() !== root.toLowerCase()) {
    throw new Error("CodexPro Scheduled Task does not point to a managed runtime release.");
  }
  const args = String(task.arguments || "");
  if (countPathOccurrences(args, workingDirectory) < 2) throw new Error("CodexPro Scheduled Task arguments do not bind to the current runtime release.");
  if (!args.toLowerCase().includes("scripts\\codexpro-hidden.vbs") || !args.toLowerCase().includes("scripts\\codexpro.mjs") || !/\sstart(?:\s|$)/i.test(args)) {
    throw new Error("CodexPro Scheduled Task arguments do not match the expected CodexPro launcher contract.");
  }
  return { execute, arguments: args, workingDirectory };
}

export function retargetScheduledTaskAction(task, home, releasePath) {
  const before = validateScheduledTaskAction(task, home);
  const target = normalizeWindowsPath(assertDirectReleasePath(home, releasePath));
  const replacement = new RegExp(regexEscape(before.workingDirectory), "gi");
  const argumentsText = before.arguments.replace(replacement, () => target);
  if (argumentsText === before.arguments || countPathOccurrences(argumentsText, target) < 2) {
    throw new Error("CodexPro Scheduled Task action could not be retargeted safely.");
  }
  if (countPathOccurrences(argumentsText, before.workingDirectory) !== 0) throw new Error("Previous runtime release path remains in the retargeted action.");
  return { execute: before.execute, arguments: argumentsText, workingDirectory: target };
}

function psSingleQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

export function buildSetScheduledTaskActionPowerShell(action, taskName = "CodexPro") {
  return [
    "$ErrorActionPreference='Stop'",
    `$a=New-ScheduledTaskAction -Execute ${psSingleQuote(action.execute)} -Argument ${psSingleQuote(action.arguments)} -WorkingDirectory ${psSingleQuote(action.workingDirectory)}`,
    `Set-ScheduledTask -TaskName ${psSingleQuote(taskName)} -Action $a -ErrorAction Stop | Out-Null`
  ].join("; ");
}

export function startGuardedRuntimeReleaseActivation({ activeProfileCount, startRestart, activate }) {
  if (Math.max(0, finite(activeProfileCount)) !== 0) {
    return { started: false, reason: "active-profiles", retryAfterMs: 15_000 };
  }
  if (typeof startRestart !== "function") throw new Error("startRestart is required.");
  if (typeof activate !== "function") throw new Error("activate is required.");
  return startRestart(activate);
}

export async function executeRuntimeReleaseActivationTransaction(options) {
  const {
    home,
    releasePath,
    getScheduledTask,
    applyScheduledTaskAction,
    restartRuntime,
    verifyRunningRuntime,
    restoreScheduledTaskAction,
    verifyPreviousRuntime,
    clearPending = (releaseId) => clearPendingRuntimeRelease(home, releaseId),
    verifyRelease = (candidatePath) => verifyRuntimeRelease({ home, releasePath: candidatePath })
  } = options || {};
  if (![getScheduledTask, applyScheduledTaskAction, restartRuntime, verifyRunningRuntime, restoreScheduledTaskAction].every((fn) => typeof fn === "function")) {
    throw new Error("Runtime release activation dependencies are incomplete.");
  }

  const release = await verifyRelease(releasePath);
  const beforeTask = await getScheduledTask();
  const beforeAction = validateScheduledTaskAction(beforeTask, home);
  const afterAction = retargetScheduledTaskAction(beforeTask, home, release.release_path);
  let actionApplied = false;
  let rollback = { attempted: false, restored: false, runtime_restored: false, error: "" };

  try {
    await applyScheduledTaskAction(afterAction);
    actionApplied = true;
    const restartStatus = await restartRuntime();
    const running = await verifyRunningRuntime(release, restartStatus);
    clearPending(release.release_id);
    const status = running?.status || running;
    return {
      ...status,
      runtime_release_activation: {
        previous_release_path: beforeAction.workingDirectory,
        release_path: release.release_path,
        scheduled_task_action_before: beforeAction,
        scheduled_task_action_after: afterAction,
        release_id: release.release_id,
        source_commit: release.source_commit,
        dist_http_sha256: release.dist_http_sha256,
        runtime_build_id: release.runtime_build_id,
        rollback
      }
    };
  } catch (error) {
    if (actionApplied) {
      rollback = { attempted: true, restored: false, runtime_restored: false, error: "" };
      try {
        await restoreScheduledTaskAction(beforeAction);
        rollback.restored = true;
        const rollbackStatus = await restartRuntime({ rollback: true });
        if (typeof verifyPreviousRuntime === "function") await verifyPreviousRuntime(rollbackStatus);
        rollback.runtime_restored = true;
      } catch (rollbackError) {
        rollback.error = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      }
    }
    try { clearPending(release.release_id); } catch {}
    const failure = new Error(`Runtime release activation failed: ${error instanceof Error ? error.message : String(error)}`);
    failure.cause = error;
    failure.rollback = rollback;
    throw failure;
  }
}
