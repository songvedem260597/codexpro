import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  activateExtensionRuntime,
  directorySha256,
  extensionIdFromManifestKey,
  rollbackExtensionRuntime
} from "../electron/extension-runtime-activation.mjs";

const TASK_ID = "cpt_621f6c46cee2bad3881bfeac";
const OWNER_ID = "8a8b382e-346b-4c3a-a854-28fae2fa033a";
const PROFILE_ID = "e7f3768a-d55b-46af-aa06-af03450ab707";
const COMMIT = "b8b6fc2101383be1d5985001ff5a3518c3452632";
const MANIFEST_KEY = "dGVzdC1rZXk=";

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function makeExtension(root, marker) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({
    manifest_version: 3,
    name: "CodexPro test extension",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "service-worker.js" }
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "service-worker.js"), `globalThis.RUNTIME_MARKER = ${JSON.stringify(marker)};\n`);
  fs.writeFileSync(path.join(root, "asset.txt"), `${marker}\n`);
  return root;
}

function makeHarness(sandbox, overrides = {}) {
  const home = path.join(sandbox, "manager-home");
  const canonicalRoot = makeExtension(path.join(sandbox, "canonical", "chrome-extension"), "artifact-a");
  const worktreeRoot = path.join(sandbox, "worktree");
  const artifactRoot = makeExtension(path.join(worktreeRoot, "chrome-extension"), "artifact-b");
  const extensionId = extensionIdFromManifestKey(MANIFEST_KEY);
  const shaA = sha256(path.join(canonicalRoot, "service-worker.js"));
  const shaB = sha256(path.join(artifactRoot, "service-worker.js"));
  const runtime = {
    liveSha256: shaA,
    loadedRoots: [canonicalRoot],
    connectionCount: 1,
    extensionId
  };
  const task = {
    taskId: TASK_ID,
    ownerProfileId: OWNER_ID,
    status: "blocked",
    completionConfirmed: false,
    repositoryRoot: path.dirname(canonicalRoot),
    worktreeRoot,
    worktreeBranch: "codexpro/task/621f6c46cee2bad3881bfeac",
    commitShas: [COMMIT]
  };
  const calls = { reload: 0, prepare: 0, stop: 0, start: 0, events: [] };
  const inspectRuntime = async () => ({
    profileId: PROFILE_ID,
    extensionId: runtime.extensionId,
    loadedExtensionRoots: [...runtime.loadedRoots],
    connectionCount: runtime.connectionCount,
    liveSha256: runtime.liveSha256
  });
  const harness = {
    home,
    canonicalExtensionRoot: canonicalRoot,
    request: {
      taskId: TASK_ID,
      taskOwnerProfileId: OWNER_ID,
      targetProfileId: PROFILE_ID,
      artifactRoot,
      sourceCommit: COMMIT,
      expectedSha256: shaB,
      managerAuthorizedProfileOverride: true
    },
    loadTask: async () => ({ ...task }),
    getGitHead: async () => COMMIT,
    getGitBranch: async () => task.worktreeBranch,
    getGitStatus: async () => "",
    inspectRuntime,
    reloadExtension: async () => {
      calls.reload += 1;
      return inspectRuntime();
    },
    prepareProfile: async () => {
      calls.prepare += 1;
      calls.events.push("prepare");
    },
    stopProfile: async () => {
      calls.stop += 1;
      calls.events.push("stop");
    },
    startProfile: async ({ extensionRoot }) => {
      calls.start += 1;
      runtime.loadedRoots = [extensionRoot];
      runtime.liveSha256 = sha256(path.join(extensionRoot, "service-worker.js"));
    },
    calls,
    runtime,
    task,
    shaA,
    shaB,
    extensionId
  };
  return Object.assign(harness, overrides);
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-extension-activation-smoke-"));
try {
  // A-D: A is live, B is unintegrated, reload keeps A, and canonical source is immutable.
  const successHarness = makeHarness(path.join(sandbox, "success"));
  const canonicalBefore = directorySha256(successHarness.canonicalExtensionRoot);
  const reloaded = await successHarness.reloadExtension();
  assert.equal(reloaded.liveSha256, successHarness.shaA);
  assert.notEqual(reloaded.liveSha256, successHarness.shaB, "chrome.runtime.reload() on A is not activation B");

  // E-H: controlled activation stages B outside the repo, restarts, proves B, and has one identity.
  const activated = await activateExtensionRuntime(successHarness);
  assert.equal(activated.liveSha256, successHarness.shaB);
  assert.equal(activated.extensionId, successHarness.extensionId);
  assert.equal(activated.targetProfileId, PROFILE_ID);
  assert.equal(successHarness.runtime.loadedRoots.length, 1);
  assert.equal(successHarness.calls.prepare, 1);
  assert.deepEqual(successHarness.calls.events.slice(0, 2), ["prepare", "stop"]);
  assert.equal(path.resolve(successHarness.runtime.loadedRoots[0]), path.resolve(activated.slotRoot));
  assert.equal(directorySha256(successHarness.canonicalExtensionRoot), canonicalBefore);
  assert.ok(!path.resolve(activated.slotRoot).startsWith(path.resolve(successHarness.canonicalExtensionRoot)));

  // I: expected SHA mismatch rejects before profile shutdown.
  const mismatch = makeHarness(path.join(sandbox, "mismatch"));
  mismatch.request.expectedSha256 = "0".repeat(64);
  await rejectsCode(activateExtensionRuntime(mismatch), "EXTENSION_ARTIFACT_SHA_MISMATCH");
  assert.equal(mismatch.calls.stop, 0);

  const dirtyArtifact = makeHarness(path.join(sandbox, "dirty-artifact"));
  dirtyArtifact.getGitStatus = async () => " M chrome-extension/service-worker.js";
  await rejectsCode(activateExtensionRuntime(dirtyArtifact), "EXTENSION_ARTIFACT_DIRTY");
  assert.equal(dirtyArtifact.calls.stop, 0);

  const wrongBranch = makeHarness(path.join(sandbox, "wrong-branch"));
  wrongBranch.getGitBranch = async () => "codexpro/task/other";
  await rejectsCode(activateExtensionRuntime(wrongBranch), "EXTENSION_WORKTREE_BRANCH_MISMATCH");
  assert.equal(wrongBranch.calls.stop, 0);

  // J: task, owner, profile authorization, and completed state all fail closed.
  const wrongTask = makeHarness(path.join(sandbox, "wrong-task"));
  wrongTask.task.taskId = "cpt_wrong";
  await rejectsCode(activateExtensionRuntime(wrongTask), "EXTENSION_TASK_ID_MISMATCH");

  const wrongOwner = makeHarness(path.join(sandbox, "wrong-owner"));
  wrongOwner.request.taskOwnerProfileId = "wrong-owner";
  await rejectsCode(activateExtensionRuntime(wrongOwner), "EXTENSION_TASK_OWNER_MISMATCH");

  const unauthorizedProfile = makeHarness(path.join(sandbox, "wrong-profile"));
  unauthorizedProfile.request.managerAuthorizedProfileOverride = false;
  await rejectsCode(activateExtensionRuntime(unauthorizedProfile), "EXTENSION_PROFILE_OVERRIDE_REQUIRED");

  const completed = makeHarness(path.join(sandbox, "completed"));
  completed.task.status = "completed";
  completed.task.completionConfirmed = true;
  await rejectsCode(activateExtensionRuntime(completed), "EXTENSION_TASK_NOT_ACTIVATABLE");

  // K: missing and foreign/canonical artifacts reject before restart.
  const missing = makeHarness(path.join(sandbox, "missing"));
  fs.rmSync(missing.request.artifactRoot, { recursive: true, force: true });
  await rejectsCode(activateExtensionRuntime(missing), "EXTENSION_ARTIFACT_MISSING");

  const foreignArtifact = makeHarness(path.join(sandbox, "foreign-artifact"));
  foreignArtifact.request.artifactRoot = foreignArtifact.canonicalExtensionRoot;
  foreignArtifact.request.expectedSha256 = foreignArtifact.shaA;
  await rejectsCode(activateExtensionRuntime(foreignArtifact), "EXTENSION_ARTIFACT_OUTSIDE_TASK_WORKTREE");

  // A source-profile shutdown refusal happens before the slot changes and must not trigger rollback/start.
  const sourceShutdownRequired = makeHarness(path.join(sandbox, "source-shutdown-required"));
  sourceShutdownRequired.stopProfile = async () => {
    sourceShutdownRequired.calls.stop += 1;
    const error = new Error("source profile is still online");
    error.code = "EXTENSION_SOURCE_PROFILE_SHUTDOWN_REQUIRED";
    throw error;
  };
  const shutdownError = await activateExtensionRuntime(sourceShutdownRequired).then(() => null, (error) => error);
  assert.equal(shutdownError.code, "EXTENSION_SOURCE_PROFILE_SHUTDOWN_REQUIRED");
  assert.equal(shutdownError.rollback, undefined);
  assert.equal(sourceShutdownRequired.calls.stop, 1);
  assert.equal(sourceShutdownRequired.calls.start, 0);
  assert.deepEqual(sourceShutdownRequired.runtime.loadedRoots, [sourceShutdownRequired.canonicalExtensionRoot]);
  assert.deepEqual(
    fs.readdirSync(path.join(sourceShutdownRequired.home, "extension-runtime-slots", PROFILE_ID)),
    []
  );

  // A safely disabled source worker is the sanctioned first-bootstrap state:
  // the source root remains known from Chrome preferences, but no live bridge
  // connection exists. Activation must start the Manager-owned isolated
  // runtime from that trusted offline source identity.
  const offlineBootstrap = makeHarness(path.join(sandbox, "offline-bootstrap"));
  offlineBootstrap.runtime.connectionCount = 0;
  offlineBootstrap.runtime.liveSha256 = "";
  const offlineInspect = offlineBootstrap.inspectRuntime;
  offlineBootstrap.inspectRuntime = async () => ({
    ...await offlineInspect(),
    runtimeKind: offlineBootstrap.runtime.connectionCount === 0 ? "source-profile" : "manager-owned-isolated"
  });
  const offlineStart = offlineBootstrap.startProfile;
  offlineBootstrap.startProfile = async (args) => {
    await offlineStart(args);
    offlineBootstrap.runtime.connectionCount = 1;
  };
  const offlineActivated = await activateExtensionRuntime(offlineBootstrap);
  assert.equal(offlineActivated.liveSha256, offlineBootstrap.shaB, "offline source bootstrap must activate the exact candidate artifact");
  assert.equal(offlineBootstrap.calls.stop, 1, "offline source bootstrap must still pass through the sanctioned stop guard before slot replacement");
  assert.equal(offlineBootstrap.calls.start, 1, "offline source bootstrap must start exactly one Manager-owned isolated runtime");
  assert.equal(offlineBootstrap.runtime.connectionCount, 1, "offline source bootstrap must finish with one live extension connection");

  const offlineWrongKind = makeHarness(path.join(sandbox, "offline-wrong-kind"));
  offlineWrongKind.runtime.connectionCount = 0;
  offlineWrongKind.runtime.liveSha256 = "";
  const offlineWrongKindInspect = offlineWrongKind.inspectRuntime;
  offlineWrongKind.inspectRuntime = async () => ({ ...await offlineWrongKindInspect(), runtimeKind: "manager-owned-isolated" });
  await rejectsCode(activateExtensionRuntime(offlineWrongKind), "EXTENSION_RUNTIME_AMBIGUOUS");
  assert.equal(offlineWrongKind.calls.stop, 0, "zero-connection Manager-owned runtime must fail before stop/replacement");

  const offlineStaleIdentity = makeHarness(path.join(sandbox, "offline-stale-live-identity"));
  offlineStaleIdentity.runtime.connectionCount = 0;
  const offlineStaleInspect = offlineStaleIdentity.inspectRuntime;
  offlineStaleIdentity.inspectRuntime = async () => ({ ...await offlineStaleInspect(), runtimeKind: "source-profile" });
  await rejectsCode(activateExtensionRuntime(offlineStaleIdentity), "EXTENSION_RUNTIME_AMBIGUOUS");
  assert.equal(offlineStaleIdentity.calls.stop, 0, "offline source bootstrap with a stale live SHA must fail closed");

  // L: restart failure cannot report activation success and attempts restoration of A.
  const restartFailure = makeHarness(path.join(sandbox, "restart-failure"));
  restartFailure.startProfile = async () => {
    restartFailure.calls.start += 1;
    throw new Error("launch failed");
  };
  const restartError = await activateExtensionRuntime(restartFailure).then(() => null, (error) => error);
  assert.equal(restartError.code, "EXTENSION_PROFILE_START_FAILED");
  assert.equal(restartError.rollback?.attempted, true);
  assert.equal(restartError.rollback?.artifactRestored, true);
  assert.equal(restartError.rollback?.verified, false);

  // M: wrong live service-worker SHA fails and rolls back to verified A.
  const liveMismatch = makeHarness(path.join(sandbox, "live-mismatch"));
  let firstStart = true;
  const normalStart = liveMismatch.startProfile;
  liveMismatch.startProfile = async (args) => {
    await normalStart(args);
    if (firstStart) {
      firstStart = false;
      liveMismatch.runtime.liveSha256 = liveMismatch.shaA;
    }
  };
  const liveError = await activateExtensionRuntime(liveMismatch).then(() => null, (error) => error);
  assert.equal(liveError.code, "EXTENSION_LIVE_SHA_MISMATCH");
  assert.equal(liveError.rollback?.verified, true);
  assert.equal(liveMismatch.runtime.liveSha256, liveMismatch.shaA);

  const ambiguous = makeHarness(path.join(sandbox, "ambiguous"));
  ambiguous.runtime.connectionCount = 2;
  await rejectsCode(activateExtensionRuntime(ambiguous), "EXTENSION_RUNTIME_AMBIGUOUS");

  const identityMismatch = makeHarness(path.join(sandbox, "identity"));
  identityMismatch.runtime.extensionId = "a".repeat(32);
  await rejectsCode(activateExtensionRuntime(identityMismatch), "EXTENSION_IDENTITY_MISMATCH");

  // N: same-profile concurrent activation has a single lock winner.
  const concurrent = makeHarness(path.join(sandbox, "concurrent"));
  let releaseStart;
  const startBarrier = new Promise((resolve) => { releaseStart = resolve; });
  const concurrentStart = concurrent.startProfile;
  concurrent.startProfile = async (args) => {
    await startBarrier;
    return concurrentStart(args);
  };
  const winner = activateExtensionRuntime(concurrent);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await rejectsCode(activateExtensionRuntime(concurrent), "EXTENSION_ACTIVATION_BUSY");
  releaseStart();
  await winner;

  // O: rollback restores A in the stable slot and verifies live A; canonical remains unchanged.
  const rolledBack = await rollbackExtensionRuntime({
    home: successHarness.home,
    targetProfileId: PROFILE_ID,
    canonicalExtensionRoot: successHarness.canonicalExtensionRoot,
    inspectRuntime: successHarness.inspectRuntime,
    prepareProfile: successHarness.prepareProfile,
    stopProfile: successHarness.stopProfile,
    startProfile: successHarness.startProfile
  });
  assert.equal(rolledBack.liveSha256, successHarness.shaA);
  assert.equal(successHarness.runtime.liveSha256, successHarness.shaA);
  assert.equal(successHarness.calls.prepare, 2);
  assert.deepEqual(successHarness.calls.events.slice(-2), ["prepare", "stop"]);
  assert.equal(directorySha256(successHarness.canonicalExtensionRoot), canonicalBefore);

  console.log("extension-runtime-activation-smoke: ok");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
