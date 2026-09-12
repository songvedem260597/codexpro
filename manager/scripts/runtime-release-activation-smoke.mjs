import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  buildSetScheduledTaskActionPowerShell,
  executeRuntimeReleaseActivationTransaction,
  retargetScheduledTaskAction,
  startGuardedRuntimeReleaseActivation,
  validateScheduledTaskAction,
  verifyRuntimeRelease
} from "../electron/runtime-release-activation.mjs";

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function buildId(filePath) {
  const stat = fs.statSync(filePath);
  return `${Math.floor(stat.mtimeMs)}:${stat.size}`;
}

function makeRelease(home, name, commit, verified = true) {
  const root = path.join(home, "runtime-releases", name);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "codexpro.mjs"), "console.log('runtime');\n");
  fs.writeFileSync(path.join(root, "scripts", "codexpro-hidden.vbs"), "' hidden\n");
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"runtime"}\n');
  fs.writeFileSync(path.join(root, "dist", "http.js"), `export const release = ${JSON.stringify(name)};\n`);
  const dist = path.join(root, "dist", "http.js");
  fs.writeFileSync(path.join(root, "runtime-release.json"), `${JSON.stringify({
    version: 1,
    release_id: name,
    source_commit: commit,
    source_repository: "https://example.invalid/codexpro.git",
    created_at: "2026-09-12T00:00:00.000Z",
    dist_http_sha256: sha256(dist),
    runtime_build_id: buildId(dist),
    verified
  }, null, 2)}\n`);
  return root;
}

function taskFor(home, releasePath) {
  const winRelease = path.win32.normalize(releasePath);
  return {
    state: "Ready",
    actionCount: 1,
    execute: "C:\\Windows\\System32\\wscript.exe",
    arguments: `"${winRelease}\\scripts\\codexpro-hidden.vbs" "${winRelease}" "C:\\Program Files\\nodejs\\node.exe" "scripts\\codexpro.mjs" start --headless --root "C:\\repo" --port 8793`,
    workingDirectory: winRelease,
    triggers: [{ id: "CodexProRecovery", interval: "PT1M" }],
    settings: { MultipleInstances: "IgnoreNew" }
  };
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-runtime-activation-smoke-"));
try {
  const home = path.join(sandbox, "home");
  fs.mkdirSync(path.join(home, "runtime-releases"), { recursive: true });
  const commit = "a".repeat(40);
  const oldRelease = makeRelease(home, "old-release", "b".repeat(40));
  const newRelease = makeRelease(home, "new-release", commit);
  const partialRelease = makeRelease(home, "partial-release", "c".repeat(40), false);
  fs.writeFileSync(path.join(oldRelease, "sentinel.txt"), "old-release-must-survive\n");
  const sentinelBefore = sha256(path.join(oldRelease, "sentinel.txt"));
  const runGit = async () => ({ stdout: `${commit}\n` });

  const verified = await verifyRuntimeRelease({ home, releasePath: newRelease, runGit });
  assert.equal(verified.release_id, "new-release");
  assert.equal(verified.source_commit, commit);
  await assert.rejects(verifyRuntimeRelease({ home, releasePath: partialRelease, runGit: async () => ({ stdout: `${"c".repeat(40)}\n` }) }), /not verified/);

  const originalTask = taskFor(home, oldRelease);
  const taskSnapshot = JSON.stringify(originalTask);
  const before = validateScheduledTaskAction(originalTask, home);
  assert.equal(before.workingDirectory.toLowerCase(), path.win32.normalize(oldRelease).toLowerCase());
  assert.throws(
    () => validateScheduledTaskAction({ ...originalTask, execute: "C:\\Program Files\\nodejs\\node.exe" }, home),
    /expected hidden wscript launcher/,
    "unexpected Scheduled Task action must fail closed"
  );
  assert.throws(
    () => validateScheduledTaskAction({ ...originalTask, actionCount: 2 }, home),
    /exactly one action/,
    "multiple task actions must fail closed"
  );

  const after = retargetScheduledTaskAction(originalTask, home, newRelease);
  assert.equal(after.workingDirectory.toLowerCase(), path.win32.normalize(newRelease).toLowerCase());
  assert.equal(after.execute, originalTask.execute);
  assert.ok(after.arguments.toLowerCase().includes(path.win32.normalize(newRelease).toLowerCase()));
  assert.ok(!after.arguments.toLowerCase().includes(path.win32.normalize(oldRelease).toLowerCase()));
  assert.equal(JSON.stringify(originalTask), taskSnapshot, "retargeting must not mutate unrelated task configuration");
  const ps = buildSetScheduledTaskActionPowerShell(after);
  assert.match(ps, /New-ScheduledTaskAction/);
  assert.match(ps, /Set-ScheduledTask -TaskName 'CodexPro' -Action \$a/);
  assert.doesNotMatch(ps, /-Trigger|-Settings|-Principal/);

  let guardCalls = 0;
  let activationCalls = 0;
  const activeBlocked = startGuardedRuntimeReleaseActivation({
    activeProfileCount: 1,
    startRestart: () => { guardCalls += 1; return { started: true }; },
    activate: () => { activationCalls += 1; }
  });
  assert.equal(activeBlocked.started, false);
  assert.equal(activeBlocked.reason, "active-profiles");
  assert.equal(guardCalls, 0, "active profiles must prevent even entering restart guard");
  assert.equal(activationCalls, 0);

  const sendGuardBlocked = startGuardedRuntimeReleaseActivation({
    activeProfileCount: 0,
    startRestart: () => ({ started: false, reason: "send-cooldown", retryAfterMs: 1000 }),
    activate: () => { activationCalls += 1; }
  });
  assert.equal(sendGuardBlocked.started, false);
  assert.equal(sendGuardBlocked.reason, "send-cooldown");
  assert.equal(activationCalls, 0, "send/restart guard must prevent activation");

  const idleAllowed = startGuardedRuntimeReleaseActivation({
    activeProfileCount: 0,
    startRestart: (activate) => ({ started: true, promise: Promise.resolve().then(activate) }),
    activate: async () => { activationCalls += 1; return "activated"; }
  });
  assert.equal(idleAllowed.started, true);
  assert.equal(await idleAllowed.promise, "activated");
  assert.equal(activationCalls, 1, "idle state must permit activation through the existing restart guard");

  let appliedAction = null;
  let restoredAction = null;
  let restartCount = 0;
  let previousVerified = false;
  let pendingCleared = 0;
  const rollbackError = await executeRuntimeReleaseActivationTransaction({
    home,
    releasePath: newRelease,
    verifyRelease: async () => verified,
    getScheduledTask: async () => originalTask,
    applyScheduledTaskAction: async (action) => { appliedAction = action; },
    restartRuntime: async () => { restartCount += 1; return { local: { ok: true } }; },
    verifyRunningRuntime: async () => { throw new Error("health verification failed"); },
    restoreScheduledTaskAction: async (action) => { restoredAction = action; },
    verifyPreviousRuntime: async () => { previousVerified = true; },
    clearPending: () => { pendingCleared += 1; }
  }).then(() => null, (error) => error);
  assert.ok(rollbackError instanceof Error);
  assert.equal(rollbackError.rollback.attempted, true);
  assert.equal(rollbackError.rollback.restored, true);
  assert.equal(rollbackError.rollback.runtime_restored, true);
  assert.equal(restartCount, 2, "failed health verification must restart staged then previous runtime during rollback");
  assert.equal(previousVerified, true);
  assert.equal(restoredAction.workingDirectory.toLowerCase(), path.win32.normalize(oldRelease).toLowerCase());
  assert.equal(appliedAction.workingDirectory.toLowerCase(), path.win32.normalize(newRelease).toLowerCase());
  assert.equal(pendingCleared, 1);

  let successPendingCleared = 0;
  const success = await executeRuntimeReleaseActivationTransaction({
    home,
    releasePath: newRelease,
    verifyRelease: async () => verified,
    getScheduledTask: async () => originalTask,
    applyScheduledTaskAction: async (action) => { appliedAction = action; },
    restartRuntime: async () => ({ local: { ok: true, data: { runtimeBuildId: verified.runtime_build_id } } }),
    verifyRunningRuntime: async (_release, status) => ({ status }),
    restoreScheduledTaskAction: async () => { throw new Error("rollback must not run on success"); },
    clearPending: () => { successPendingCleared += 1; }
  });
  assert.equal(success.local.ok, true);
  assert.equal(success.runtime_release_activation.release_path, newRelease);
  assert.equal(successPendingCleared, 1);
  assert.equal(sha256(path.join(oldRelease, "sentinel.txt")), sentinelBefore, "successful activation transaction must not modify the old release directory");

  console.log("runtime-release-activation-smoke: ok");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
