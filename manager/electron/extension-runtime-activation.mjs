import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const EXTENSION_RUNTIME_SLOT_DIR = "extension-runtime-slots";
export const EXTENSION_RUNTIME_METADATA_FILE = "activation.json";
const ACTIVATABLE_TASK_STATES = new Set(["running", "blocked"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

function activationError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "ExtensionRuntimeActivationError";
  error.code = code;
  return error;
}

function normalizeSha(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeCommit(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePath(value) {
  return path.resolve(String(value || ""));
}

function samePath(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function realPath(value, code = "EXTENSION_PATH_INVALID") {
  try {
    const resolved = normalizePath(value);
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch (cause) {
    throw activationError(code, `Path does not exist or cannot be resolved: ${value}`, cause);
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validateProfileKey(value) {
  const profileId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(profileId)) {
    throw activationError("EXTENSION_PROFILE_INVALID", "Profile id is missing or unsafe.");
  }
  return profileId;
}

function treeEntries(root) {
  const base = realPath(root);
  const entries = [];
  const visit = (directory) => {
    const names = fs.readdirSync(directory).sort((a, b) => a.localeCompare(b, "en"));
    for (const name of names) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      const relative = path.relative(base, absolute).split(path.sep).join("/");
      if (stat.isSymbolicLink()) {
        throw activationError("EXTENSION_SYMLINK_REJECTED", `Extension runtime trees cannot contain symbolic links: ${relative}`);
      }
      if (stat.isDirectory()) {
        entries.push({ kind: "directory", relative, absolute });
        visit(absolute);
        continue;
      }
      if (!stat.isFile()) {
        throw activationError("EXTENSION_SPECIAL_FILE_REJECTED", `Extension runtime trees cannot contain special files: ${relative}`);
      }
      entries.push({ kind: "file", relative, absolute });
    }
  };
  visit(base);
  return { base, entries };
}

export function directorySha256(root) {
  const { entries } = treeEntries(root);
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.kind === "directory" ? "d\0" : "f\0");
    hash.update(entry.relative);
    hash.update("\0");
    if (entry.kind === "file") hash.update(fs.readFileSync(entry.absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function fileSha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (cause) {
    throw activationError(code, `Cannot read JSON file: ${filePath}`, cause);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporary, filePath);
}

export function extensionIdFromManifestKey(key) {
  const compact = String(key || "").replace(/\s+/g, "");
  if (!compact) throw activationError("EXTENSION_MANIFEST_KEY_MISSING", "Extension manifest key is required for stable identity.");
  let bytes;
  try {
    bytes = Buffer.from(compact, "base64");
  } catch (cause) {
    throw activationError("EXTENSION_MANIFEST_KEY_INVALID", "Extension manifest key is not valid base64.", cause);
  }
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    throw activationError("EXTENSION_MANIFEST_KEY_INVALID", "Extension manifest key is not valid base64.");
  }
  const prefix = createHash("sha256").update(bytes).digest().subarray(0, 16).toString("hex");
  return [...prefix].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join("");
}

function inspectExtensionTree(root, missingCode = "EXTENSION_ARTIFACT_MISSING") {
  const resolved = realPath(root, missingCode);
  const manifestPath = path.join(resolved, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw activationError(missingCode, `Extension manifest is missing: ${manifestPath}`);
  }
  const manifest = readJson(manifestPath, "EXTENSION_MANIFEST_INVALID");
  const workerRelative = String(manifest?.background?.service_worker || "");
  if (!workerRelative || path.isAbsolute(workerRelative) || workerRelative.split(/[\\/]+/).includes("..")) {
    throw activationError("EXTENSION_SERVICE_WORKER_INVALID", "Manifest background.service_worker must be a safe relative path.");
  }
  const workerPath = path.resolve(resolved, workerRelative);
  if (!isInside(resolved, workerPath) || !fs.existsSync(workerPath) || !fs.statSync(workerPath).isFile()) {
    throw activationError(missingCode, `Extension service worker is missing: ${workerPath}`);
  }
  treeEntries(resolved);
  return {
    root: resolved,
    manifest,
    extensionId: extensionIdFromManifestKey(manifest.key),
    serviceWorkerPath: workerPath,
    serviceWorkerSha256: fileSha256(workerPath),
    treeSha256: directorySha256(resolved)
  };
}

function runtimeSlotPaths(home, targetProfileId) {
  const profileId = validateProfileKey(targetProfileId);
  const profileRoot = path.resolve(String(home || ""), EXTENSION_RUNTIME_SLOT_DIR, profileId);
  return {
    profileId,
    profileRoot,
    currentRoot: path.join(profileRoot, "current"),
    metadataPath: path.join(profileRoot, EXTENSION_RUNTIME_METADATA_FILE),
    lockPath: path.join(profileRoot, "activation.lock")
  };
}

function acquireProfileLock(paths, request) {
  fs.mkdirSync(paths.profileRoot, { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(paths.lockPath, "wx");
    fs.writeFileSync(descriptor, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      task_id: String(request?.taskId || ""),
      acquired_at: new Date().toISOString()
    })}\n`);
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      throw activationError("EXTENSION_ACTIVATION_BUSY", `An extension activation is already running for profile ${paths.profileId}.`);
    }
    throw activationError("EXTENSION_ACTIVATION_LOCK_FAILED", "Could not acquire the extension activation lock.", cause);
  }
  return () => {
    try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(paths.lockPath); } catch {}
  };
}

function copyTree(source, destination) {
  treeEntries(source);
  fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
  treeEntries(destination);
}

function replaceCurrentDirectory(paths, preparedRoot, transactionId) {
  const displacedRoot = path.join(paths.profileRoot, `.displaced-${transactionId}`);
  if (fs.existsSync(displacedRoot)) fs.rmSync(displacedRoot, { recursive: true, force: true });
  if (fs.existsSync(paths.currentRoot)) fs.renameSync(paths.currentRoot, displacedRoot);
  try {
    fs.renameSync(preparedRoot, paths.currentRoot);
  } catch (cause) {
    if (fs.existsSync(displacedRoot) && !fs.existsSync(paths.currentRoot)) fs.renameSync(displacedRoot, paths.currentRoot);
    throw cause;
  }
  return displacedRoot;
}

function assertCanonicalUnchanged(root, expectedDigest) {
  const currentDigest = directorySha256(root);
  if (currentDigest !== expectedDigest) {
    throw activationError("EXTENSION_CANONICAL_SOURCE_CHANGED", "Canonical extension source changed during controlled activation.");
  }
}

function assertRuntimeIdentity(runtime, expected) {
  if (!runtime || String(runtime.profileId || "") !== expected.profileId) {
    throw activationError("EXTENSION_RUNTIME_PROFILE_MISMATCH", "Live runtime did not report the requested profile.");
  }
  if (Number(runtime.connectionCount) !== 1 || !Array.isArray(runtime.loadedExtensionRoots) || runtime.loadedExtensionRoots.length !== 1) {
    throw activationError("EXTENSION_RUNTIME_AMBIGUOUS", "Expected exactly one live extension connection and one loaded source root.");
  }
  if (String(runtime.extensionId || "") !== expected.extensionId) {
    throw activationError("EXTENSION_IDENTITY_MISMATCH", "Live extension id does not match the stable manifest identity.");
  }
  if (expected.root && !samePath(runtime.loadedExtensionRoots[0], expected.root)) {
    throw activationError("EXTENSION_RUNTIME_ROOT_MISMATCH", "Live extension is not loaded from the Manager-owned stable slot.");
  }
  const liveSha256 = normalizeSha(runtime.liveSha256);
  if (liveSha256 !== expected.sha256) {
    throw activationError("EXTENSION_LIVE_SHA_MISMATCH", `Live service-worker SHA256 is ${liveSha256 || "missing"}; expected ${expected.sha256}.`);
  }
  return { ...runtime, liveSha256 };
}

function normalizeTask(raw) {
  return {
    taskId: String(raw?.taskId ?? raw?.task_id ?? ""),
    ownerProfileId: String(raw?.ownerProfileId ?? raw?.owner_profile_id ?? raw?.owner_worker ?? ""),
    status: String(raw?.status ?? raw?.task_status ?? "").toLowerCase(),
    completionConfirmed: raw?.completionConfirmed === true || raw?.completion_confirmed === true,
    repositoryRoot: String(raw?.repositoryRoot ?? raw?.repository_root ?? raw?.root ?? ""),
    worktreeRoot: String(raw?.worktreeRoot ?? raw?.worktree_root ?? raw?.task_worktree_root ?? ""),
    worktreeBranch: String(raw?.worktreeBranch ?? raw?.worktree_branch ?? raw?.task_worktree_branch ?? ""),
    commitShas: [
      ...(Array.isArray(raw?.commitShas) ? raw.commitShas : []),
      ...(Array.isArray(raw?.commit_shas) ? raw.commit_shas : []),
      raw?.commitSha,
      raw?.commit_sha,
      raw?.checkpoint
    ].filter(Boolean).map(normalizeCommit)
  };
}

async function verifyActivationRequest(options) {
  const request = options?.request || {};
  const taskId = String(request.taskId || "");
  if (!/^cpt_[A-Za-z0-9]+$/.test(taskId)) {
    throw activationError("EXTENSION_TASK_ID_INVALID", "A valid task id is required.");
  }
  const ownerProfileId = validateProfileKey(request.taskOwnerProfileId);
  const targetProfileId = validateProfileKey(request.targetProfileId);
  const expectedSha256 = normalizeSha(request.expectedSha256);
  const sourceCommit = normalizeCommit(request.sourceCommit);
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw activationError("EXTENSION_EXPECTED_SHA_INVALID", "Expected service-worker SHA256 must contain 64 hexadecimal characters.");
  }
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw activationError("EXTENSION_SOURCE_COMMIT_INVALID", "Source commit must contain 40 hexadecimal characters.");
  }
  if (targetProfileId !== ownerProfileId && request.managerAuthorizedProfileOverride !== true) {
    throw activationError("EXTENSION_PROFILE_OVERRIDE_REQUIRED", "A different acceptance profile requires explicit Manager authorization.");
  }
  if (typeof options.loadTask !== "function") throw activationError("EXTENSION_TASK_PROVIDER_MISSING", "Manager task provider is required.");
  const task = normalizeTask(await options.loadTask(taskId));
  if (task.taskId !== taskId) throw activationError("EXTENSION_TASK_ID_MISMATCH", "Authoritative task id does not match the activation request.");
  if (task.ownerProfileId !== ownerProfileId) {
    throw activationError("EXTENSION_TASK_OWNER_MISMATCH", "Authoritative task owner does not match the activation request.");
  }
  if (task.completionConfirmed || !ACTIVATABLE_TASK_STATES.has(task.status)) {
    throw activationError("EXTENSION_TASK_NOT_ACTIVATABLE", `Task state ${task.status || "missing"} is not eligible for controlled acceptance activation.`);
  }
  if (!task.worktreeRoot || !task.worktreeBranch) {
    throw activationError("EXTENSION_TASK_WORKTREE_MISSING", "Authoritative task worktree identity is incomplete.");
  }
  const worktreeRoot = realPath(task.worktreeRoot, "EXTENSION_TASK_WORKTREE_MISSING");
  const artifact = inspectExtensionTree(request.artifactRoot);
  if (!isInside(worktreeRoot, artifact.root)) {
    throw activationError("EXTENSION_ARTIFACT_OUTSIDE_TASK_WORKTREE", "Extension artifact must be inside the authoritative task worktree.");
  }
  const artifactRelativePath = path.relative(worktreeRoot, artifact.root).split(path.sep).join("/");
  if (artifactRelativePath !== "chrome-extension") {
    throw activationError("EXTENSION_ARTIFACT_PATH_MISMATCH", "Controlled activation only accepts the task worktree's chrome-extension directory.");
  }
  const repositoryRoot = realPath(task.repositoryRoot, "EXTENSION_REPOSITORY_ROOT_MISSING");
  const canonicalRoot = realPath(options.canonicalExtensionRoot, "EXTENSION_CANONICAL_SOURCE_MISSING");
  const authoritativeCanonicalRoot = realPath(path.join(repositoryRoot, "chrome-extension"), "EXTENSION_CANONICAL_SOURCE_MISSING");
  if (!samePath(canonicalRoot, authoritativeCanonicalRoot)) {
    throw activationError("EXTENSION_CANONICAL_ROOT_MISMATCH", "Canonical extension root does not match authoritative coordination root.");
  }
  if (samePath(artifact.root, canonicalRoot) || isInside(canonicalRoot, artifact.root)) {
    throw activationError("EXTENSION_ARTIFACT_IS_CANONICAL", "Canonical extension source cannot be used as an unintegrated task artifact.");
  }
  if (artifact.serviceWorkerSha256 !== expectedSha256) {
    throw activationError("EXTENSION_ARTIFACT_SHA_MISMATCH", `Task artifact SHA256 is ${artifact.serviceWorkerSha256}; expected ${expectedSha256}.`);
  }
  if (!task.commitShas.includes(sourceCommit)) {
    throw activationError("EXTENSION_TASK_COMMIT_MISMATCH", "Source commit is not present in authoritative task provenance.");
  }
  if (typeof options.getGitHead !== "function") throw activationError("EXTENSION_GIT_PROVIDER_MISSING", "Manager Git identity provider is required.");
  const worktreeHead = normalizeCommit(await options.getGitHead(worktreeRoot));
  if (worktreeHead !== sourceCommit) {
    throw activationError("EXTENSION_WORKTREE_HEAD_MISMATCH", `Task worktree HEAD is ${worktreeHead || "missing"}; expected ${sourceCommit}.`);
  }
  if (typeof options.getGitBranch !== "function" || typeof options.getGitStatus !== "function") {
    throw activationError("EXTENSION_GIT_PROVIDER_MISSING", "Manager Git branch and status providers are required.");
  }
  const worktreeBranch = String(await options.getGitBranch(worktreeRoot)).trim();
  if (worktreeBranch !== task.worktreeBranch) {
    throw activationError("EXTENSION_WORKTREE_BRANCH_MISMATCH", `Task worktree branch is ${worktreeBranch || "missing"}; expected ${task.worktreeBranch}.`);
  }
  const artifactStatus = String(await options.getGitStatus(worktreeRoot, artifactRelativePath)).trim();
  if (artifactStatus) {
    throw activationError("EXTENSION_ARTIFACT_DIRTY", "Task extension artifact has uncommitted or untracked changes.");
  }
  return { request, task, taskId, ownerProfileId, targetProfileId, expectedSha256, sourceCommit, worktreeRoot, canonicalRoot, artifact };
}

async function rollbackFailedActivation({
  paths,
  previousSnapshot,
  previous,
  extensionId,
  canonicalRoot,
  canonicalDigest,
  stopProfile,
  startProfile,
  inspectRuntime,
  transactionId
}) {
  const rollback = { attempted: true, artifactRestored: false, profileRestarted: false, verified: false };
  try {
    await stopProfile({ profileId: paths.profileId, reason: "extension-activation-rollback" });
  } catch (error) {
    rollback.stopError = error?.message || String(error);
  }
  try {
    const restoreStage = path.join(paths.profileRoot, `.restore-${transactionId}`);
    if (fs.existsSync(restoreStage)) fs.rmSync(restoreStage, { recursive: true, force: true });
    copyTree(previousSnapshot, restoreStage);
    const displaced = replaceCurrentDirectory(paths, restoreStage, `rollback-${transactionId}`);
    if (fs.existsSync(displaced)) fs.rmSync(displaced, { recursive: true, force: true });
    rollback.artifactRestored = true;
    await startProfile({ profileId: paths.profileId, extensionRoot: paths.currentRoot, extensionId, reason: "extension-activation-rollback" });
    rollback.profileRestarted = true;
    const live = await inspectRuntime(paths.profileId);
    assertRuntimeIdentity(live, { profileId: paths.profileId, extensionId, root: paths.currentRoot, sha256: previous.serviceWorkerSha256 });
    assertCanonicalUnchanged(canonicalRoot, canonicalDigest);
    rollback.verified = true;
  } catch (error) {
    rollback.error = error?.message || String(error);
    rollback.errorCode = error?.code || "EXTENSION_ROLLBACK_FAILED";
  }
  return rollback;
}

export async function activateExtensionRuntime(options) {
  const paths = runtimeSlotPaths(options?.home, options?.request?.targetProfileId);
  const releaseLock = acquireProfileLock(paths, options?.request);
  let preparedRoot = "";
  let previousSnapshot = "";
  let transactionId = "";
  let runtimeChanged = false;
  let rollbackContext = null;
  try {
    const verified = await verifyActivationRequest(options);
    if (typeof options.inspectRuntime !== "function" || typeof options.stopProfile !== "function" || typeof options.startProfile !== "function") {
      throw activationError("EXTENSION_RUNTIME_ADAPTER_MISSING", "Manager profile inspection, stop, and start adapters are required.");
    }
    if (typeof options.prepareProfile === "function") {
      await options.prepareProfile({
        profileId: verified.targetProfileId,
        extensionId: verified.artifact.extensionId
      });
    }
    const canonicalDigest = directorySha256(verified.canonicalRoot);
    const before = await options.inspectRuntime(verified.targetProfileId);
    if (!before || String(before.profileId || "") !== verified.targetProfileId) {
      throw activationError("EXTENSION_RUNTIME_PROFILE_MISMATCH", "Pre-activation runtime did not report the requested profile.");
    }
    if (Number(before.connectionCount) !== 1 || !Array.isArray(before.loadedExtensionRoots) || before.loadedExtensionRoots.length !== 1) {
      throw activationError("EXTENSION_RUNTIME_AMBIGUOUS", "Expected exactly one pre-activation extension connection and source root.");
    }
    if (String(before.extensionId || "") !== verified.artifact.extensionId) {
      throw activationError("EXTENSION_IDENTITY_MISMATCH", "Existing runtime extension id does not match the task artifact.");
    }
    const previousRoot = realPath(before.loadedExtensionRoots[0], "EXTENSION_PREVIOUS_RUNTIME_MISSING");
    const currentExists = fs.existsSync(paths.currentRoot);
    if (!samePath(previousRoot, verified.canonicalRoot) && !(currentExists && samePath(previousRoot, realPath(paths.currentRoot)))) {
      throw activationError("EXTENSION_PREVIOUS_RUNTIME_UNTRUSTED", "Existing extension is not loaded from canonical source or this profile's Manager slot.");
    }
    const previous = inspectExtensionTree(previousRoot, "EXTENSION_PREVIOUS_RUNTIME_MISSING");
    if (previous.extensionId !== verified.artifact.extensionId) {
      throw activationError("EXTENSION_IDENTITY_MISMATCH", "Previous and candidate extension ids differ.");
    }
    if (normalizeSha(before.liveSha256) !== previous.serviceWorkerSha256) {
      throw activationError("EXTENSION_PREVIOUS_RUNTIME_SHA_MISMATCH", "Reported live runtime SHA does not match its loaded source.");
    }

    transactionId = randomUUID();
    preparedRoot = path.join(paths.profileRoot, `.stage-${transactionId}`);
    previousSnapshot = path.join(paths.profileRoot, `.previous-${transactionId}`);
    copyTree(verified.artifact.root, preparedRoot);
    copyTree(previous.root, previousSnapshot);
    rollbackContext = {
      previous,
      extensionId: verified.artifact.extensionId,
      canonicalRoot: verified.canonicalRoot,
      canonicalDigest
    };
    const staged = inspectExtensionTree(preparedRoot);
    if (staged.serviceWorkerSha256 !== verified.expectedSha256 || staged.treeSha256 !== verified.artifact.treeSha256) {
      throw activationError("EXTENSION_STAGE_VERIFICATION_FAILED", "Manager runtime slot staging did not preserve the exact task artifact.");
    }
    assertCanonicalUnchanged(verified.canonicalRoot, canonicalDigest);

    runtimeChanged = true;
    await options.stopProfile({ profileId: verified.targetProfileId, reason: "controlled-extension-activation" });
    const displacedRoot = replaceCurrentDirectory(paths, preparedRoot, transactionId);
    preparedRoot = "";
    if (fs.existsSync(displacedRoot)) fs.rmSync(displacedRoot, { recursive: true, force: true });
    try {
      await options.startProfile({
        profileId: verified.targetProfileId,
        extensionRoot: paths.currentRoot,
        extensionId: verified.artifact.extensionId,
        reason: "controlled-extension-activation"
      });
    } catch (cause) {
      throw activationError("EXTENSION_PROFILE_START_FAILED", "Chrome profile restart failed during controlled activation.", cause);
    }

    const live = assertRuntimeIdentity(await options.inspectRuntime(verified.targetProfileId), {
      profileId: verified.targetProfileId,
      extensionId: verified.artifact.extensionId,
      root: paths.currentRoot,
      sha256: verified.expectedSha256
    });
    assertCanonicalUnchanged(verified.canonicalRoot, canonicalDigest);
    const metadata = {
      version: 1,
      state: "active",
      transaction_id: transactionId,
      task_id: verified.taskId,
      task_owner_profile_id: verified.ownerProfileId,
      target_profile_id: verified.targetProfileId,
      source_commit: verified.sourceCommit,
      worktree_root: verified.worktreeRoot,
      worktree_branch: verified.task.worktreeBranch,
      artifact_source_root: verified.artifact.root,
      slot_root: paths.currentRoot,
      expected_service_worker_sha256: verified.expectedSha256,
      extension_id: verified.artifact.extensionId,
      previous_snapshot_root: previousSnapshot,
      previous_service_worker_sha256: previous.serviceWorkerSha256,
      previous_tree_sha256: previous.treeSha256,
      canonical_extension_root: verified.canonicalRoot,
      canonical_tree_sha256: canonicalDigest,
      activated_at: new Date().toISOString()
    };
    writeJsonAtomic(paths.metadataPath, metadata);
    return {
      taskId: verified.taskId,
      targetProfileId: verified.targetProfileId,
      slotRoot: paths.currentRoot,
      extensionId: verified.artifact.extensionId,
      liveSha256: live.liveSha256,
      canonicalTreeSha256: canonicalDigest,
      metadataPath: paths.metadataPath,
      rollbackAvailable: true
    };
  } catch (error) {
    if (runtimeChanged && rollbackContext && previousSnapshot && fs.existsSync(previousSnapshot) && transactionId) {
      error.rollback = await rollbackFailedActivation({
        paths,
        previousSnapshot,
        previous: rollbackContext.previous,
        extensionId: rollbackContext.extensionId,
        canonicalRoot: rollbackContext.canonicalRoot,
        canonicalDigest: rollbackContext.canonicalDigest,
        stopProfile: options.stopProfile,
        startProfile: options.startProfile,
        inspectRuntime: options.inspectRuntime,
        transactionId
      });
    }
    throw error;
  } finally {
    if (preparedRoot && fs.existsSync(preparedRoot)) fs.rmSync(preparedRoot, { recursive: true, force: true });
    releaseLock();
  }
}

export async function rollbackExtensionRuntime(options) {
  const paths = runtimeSlotPaths(options?.home, options?.targetProfileId);
  const releaseLock = acquireProfileLock(paths, { taskId: "rollback" });
  let restoreStage = "";
  try {
    if (!fs.existsSync(paths.metadataPath)) {
      throw activationError("EXTENSION_ROLLBACK_METADATA_MISSING", "No successful extension activation is available to roll back.");
    }
    const metadata = readJson(paths.metadataPath, "EXTENSION_ROLLBACK_METADATA_INVALID");
    if (metadata?.version !== 1 || metadata?.state !== "active" || String(metadata.target_profile_id || "") !== paths.profileId) {
      throw activationError("EXTENSION_ROLLBACK_METADATA_INVALID", "Extension activation metadata is not active for this profile.");
    }
    const canonicalRoot = realPath(options.canonicalExtensionRoot, "EXTENSION_CANONICAL_SOURCE_MISSING");
    if (!samePath(canonicalRoot, metadata.canonical_extension_root)) {
      throw activationError("EXTENSION_CANONICAL_ROOT_MISMATCH", "Rollback canonical root does not match activation provenance.");
    }
    assertCanonicalUnchanged(canonicalRoot, String(metadata.canonical_tree_sha256 || ""));
    const previous = inspectExtensionTree(metadata.previous_snapshot_root, "EXTENSION_PREVIOUS_RUNTIME_MISSING");
    if (previous.extensionId !== String(metadata.extension_id || "") ||
        previous.serviceWorkerSha256 !== normalizeSha(metadata.previous_service_worker_sha256) ||
        previous.treeSha256 !== normalizeSha(metadata.previous_tree_sha256)) {
      throw activationError("EXTENSION_ROLLBACK_ARTIFACT_MISMATCH", "Rollback snapshot does not match activation provenance.");
    }
    if (typeof options.inspectRuntime !== "function" || typeof options.stopProfile !== "function" || typeof options.startProfile !== "function") {
      throw activationError("EXTENSION_RUNTIME_ADAPTER_MISSING", "Manager profile inspection, stop, and start adapters are required.");
    }
    if (typeof options.prepareProfile === "function") {
      await options.prepareProfile({ profileId: paths.profileId, extensionId: previous.extensionId });
    }

    const transactionId = randomUUID();
    restoreStage = path.join(paths.profileRoot, `.restore-${transactionId}`);
    copyTree(previous.root, restoreStage);
    await options.stopProfile({ profileId: paths.profileId, reason: "controlled-extension-rollback" });
    const displaced = replaceCurrentDirectory(paths, restoreStage, transactionId);
    restoreStage = "";
    try {
      await options.startProfile({
        profileId: paths.profileId,
        extensionRoot: paths.currentRoot,
        extensionId: previous.extensionId,
        reason: "controlled-extension-rollback"
      });
    } catch (cause) {
      if (fs.existsSync(displaced)) {
        if (fs.existsSync(paths.currentRoot)) fs.rmSync(paths.currentRoot, { recursive: true, force: true });
        fs.renameSync(displaced, paths.currentRoot);
      }
      throw activationError("EXTENSION_ROLLBACK_PROFILE_START_FAILED", "Chrome profile restart failed during rollback.", cause);
    }
    if (fs.existsSync(displaced)) fs.rmSync(displaced, { recursive: true, force: true });
    const live = assertRuntimeIdentity(await options.inspectRuntime(paths.profileId), {
      profileId: paths.profileId,
      extensionId: previous.extensionId,
      root: paths.currentRoot,
      sha256: previous.serviceWorkerSha256
    });
    assertCanonicalUnchanged(canonicalRoot, metadata.canonical_tree_sha256);
    writeJsonAtomic(paths.metadataPath, {
      ...metadata,
      state: "rolled_back",
      rollback_transaction_id: transactionId,
      rolled_back_at: new Date().toISOString(),
      rollback_live_service_worker_sha256: live.liveSha256
    });
    return {
      targetProfileId: paths.profileId,
      slotRoot: paths.currentRoot,
      extensionId: previous.extensionId,
      liveSha256: live.liveSha256,
      canonicalTreeSha256: metadata.canonical_tree_sha256,
      metadataPath: paths.metadataPath
    };
  } finally {
    if (restoreStage && fs.existsSync(restoreStage)) fs.rmSync(restoreStage, { recursive: true, force: true });
    releaseLock();
  }
}
