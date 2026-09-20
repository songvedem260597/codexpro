import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { extensionIdFromManifestKey } from "../electron/extension-runtime-activation.mjs";
import {
  chromeActivationArguments,
  commandLineExtensionRoots,
  createManagerOwnedChromeBinding,
  createManagerExtensionRuntimeController,
  findChromeProfileBinding,
  managedWorkerLifecycleBootstrapFiles,
  parseCodexProTaskArguments,
  readChromeLoadedExtensionRoot,
  selectChromeProcessCohort
} from "../electron/extension-runtime-manager.mjs";

const PROFILE_ID = "e7f3768a-d55b-46af-aa06-af03450ab707";
const OWNER_ID = "8a8b382e-346b-4c3a-a854-28fae2fa033a";
const TASK_ID = "cpt_621f6c46cee2bad3881bfeac";
const COMMIT = "b8b6fc2101383be1d5985001ff5a3518c3452632";
const KEY = "dGVzdC1rZXk=";
const EXTENSION_ID = extensionIdFromManifestKey(KEY);

function makeExtension(root, body = "runtime") {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    version: "1.0.0",
    key: KEY,
    background: { service_worker: "service-worker.js" }
  }));
  fs.writeFileSync(path.join(root, "service-worker.js"), body);
}

function makeProfile(userDataRoot, directory, sourceRoot, profileId = PROFILE_ID) {
  const profileRoot = path.join(userDataRoot, directory);
  const storage = path.join(profileRoot, "Local Extension Settings", EXTENSION_ID);
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, "000001.log"), Buffer.concat([
    Buffer.from([0, 1, 2]),
    Buffer.from(profileId),
    Buffer.from([3, 4, 5])
  ]));
  fs.writeFileSync(path.join(profileRoot, "Secure Preferences"), JSON.stringify({
    extensions: { settings: { [EXTENSION_ID]: { path: sourceRoot } } }
  }));
  return profileRoot;
}

function scanContainsProfileIdForTest(root, profileId) {
  const needle = Buffer.from(profileId);
  const visit = (directory) => fs.readdirSync(directory, { withFileTypes: true }).some((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return visit(absolute);
    return entry.isFile() && fs.readFileSync(absolute).includes(needle);
  });
  return visit(root);
}

function storageTextForTest(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "LOCK")
    .map((entry) => {
      try { return fs.readFileSync(path.join(root, entry.name)).toString("latin1"); } catch { return ""; }
    })
    .join("\n");
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-extension-manager-smoke-"));
try {
  const parsed = parseCodexProTaskArguments(
    '"launcher.vbs" "root" "node.exe" scripts/codexpro.mjs start --root "C:\\repo path" --port 9901 --token-file "C:\\secret token"',
    "fallback"
  );
  assert.equal(parsed.root, "C:\\repo path");
  assert.equal(parsed.port, 9901);
  assert.equal(parsed.tokenFile, "C:\\secret token");

  const repositoryRoot = path.join(sandbox, "canonical");
  const canonicalRoot = path.join(repositoryRoot, "chrome-extension");
  const worktreeRoot = path.join(sandbox, "worktree");
  const artifactRoot = path.join(worktreeRoot, "chrome-extension");
  makeExtension(canonicalRoot, "artifact-a");
  makeExtension(artifactRoot, "artifact-b");
  const userDataRoot = path.join(sandbox, "Chrome", "User Data");
  makeProfile(userDataRoot, "Profile 57", canonicalRoot);

  const binding = findChromeProfileBinding({
    profileId: PROFILE_ID,
    extensionId: EXTENSION_ID,
    userDataRoots: [userDataRoot]
  });
  assert.equal(binding.profileDirectory, "Profile 57");
  assert.equal(readChromeLoadedExtensionRoot(binding), fs.realpathSync(canonicalRoot));

  assert.throws(
    () => findChromeProfileBinding({
      profileId: "wrong-profile-identity",
      extensionId: EXTENSION_ID,
      userDataRoots: [userDataRoot]
    }),
    (error) => error?.code === "EXTENSION_PROFILE_BINDING_MISSING",
    "wrong profile identity must fail closed"
  );

  // Guard the real source profile: isolated activation must never copy or mutate browser cookies.
  const sourceCookiePath = path.join(binding.profileRoot, "Network", "Cookies");
  fs.mkdirSync(path.dirname(sourceCookiePath), { recursive: true });
  fs.writeFileSync(sourceCookiePath, "real-user-cookie-sentinel");
  const sourceStorageFile = path.join(binding.profileRoot, "Local Extension Settings", EXTENSION_ID, "000001.log");
  const sourceStorageBefore = fs.readFileSync(sourceStorageFile);
  const managedHome = path.join(sandbox, "managed-home");
  const managedBinding = createManagerOwnedChromeBinding({
    home: managedHome,
    profileId: PROFILE_ID,
    extensionId: EXTENSION_ID,
    sourceBinding: binding
  });
  assert.notEqual(managedBinding.userDataRoot, binding.userDataRoot);
  assert.equal(managedBinding.profileDirectory, "Default");
  assert.ok(managedBinding.userDataRoot.startsWith(path.resolve(managedHome)));
  assert.equal(managedBinding.sourceProfileRoot, binding.profileRoot);
  assert.throws(
    () => chromeActivationArguments(binding, artifactRoot),
    (error) => error?.code === "EXTENSION_REAL_USER_DATA_FORBIDDEN"
  );

  const duplicateRoot = path.join(sandbox, "Chrome Beta", "User Data");
  makeProfile(duplicateRoot, "Default", canonicalRoot);
  assert.throws(
    () => findChromeProfileBinding({
      profileId: PROFILE_ID,
      extensionId: EXTENSION_ID,
      userDataRoots: [userDataRoot, duplicateRoot]
    }),
    (error) => error?.code === "EXTENSION_PROFILE_BINDING_AMBIGUOUS"
  );

  const executablePath = process.execPath;
  const processes = [
    { ProcessId: 100, ParentProcessId: 1, CommandLine: `"${executablePath}" "--load-extension=${artifactRoot}"`, ExecutablePath: executablePath },
    { ProcessId: 101, ParentProcessId: 100, CommandLine: `"${executablePath}" --type=renderer`, ExecutablePath: executablePath },
    { ProcessId: 102, ParentProcessId: 101, CommandLine: `"${executablePath}" --type=utility`, ExecutablePath: executablePath },
    { ProcessId: 200, ParentProcessId: 1, CommandLine: `"${executablePath}" --user-data-dir="${path.join(sandbox, "other")}"`, ExecutablePath: executablePath }
  ];
  const cohort = selectChromeProcessCohort(processes, binding, userDataRoot);
  assert.deepEqual(cohort.processIds, [102, 101, 100]);
  assert.equal(cohort.executablePath, executablePath);
  assert.deepEqual(
    commandLineExtensionRoots(`chrome.exe --load-extension="${artifactRoot}" --no-first-run`),
    [artifactRoot]
  );
  assert.deepEqual(
    commandLineExtensionRoots(`chrome.exe "--load-extension=${artifactRoot}" --no-first-run`),
    [artifactRoot]
  );
  const activationArguments = chromeActivationArguments(managedBinding, artifactRoot);
  assert.ok(activationArguments.includes(`--profile-directory=${managedBinding.profileDirectory}`));
  assert.ok(activationArguments.includes(`--user-data-dir=${managedBinding.userDataRoot}`));
  assert.ok(!activationArguments.includes(`--user-data-dir=${binding.userDataRoot}`));
  assert.ok(activationArguments.includes(`--load-extension=${fs.realpathSync(artifactRoot)}`));
  assert.ok(activationArguments.includes("--restore-last-session"));
  assert.equal(fs.readFileSync(sourceCookiePath, "utf8"), "real-user-cookie-sentinel");
  assert.throws(
    () => selectChromeProcessCohort([...processes, { ...processes[0], ProcessId: 300 }], binding, userDataRoot),
    (error) => error?.code === "EXTENSION_CHROME_PROCESS_AMBIGUOUS"
  );

  const liveSha = createHash("sha256").update(fs.readFileSync(path.join(canonicalRoot, "service-worker.js"))).digest("hex");
  const mcp = async (toolName) => {
    if (toolName === "repo_task_status") {
      return {
        root: worktreeRoot,
        tracking: {
          task_id: TASK_ID,
          owner_profile: OWNER_ID,
          owner_worker: OWNER_ID,
          checkpoint: COMMIT,
          commit_sha: COMMIT
        },
        worker_job: {
          job_id: TASK_ID,
          worker_id: OWNER_ID,
          status: "running",
          execution_state: "blocked",
          completion_confirmed: false
        }
      };
    }
    if (toolName === "workspace_coordination_status") {
      return {
        found: true,
        task_id: TASK_ID,
        task_worker_id: OWNER_ID,
        task_status: "running",
        root: repositoryRoot,
        task_worktree_root: worktreeRoot,
        task_worktree_branch: "codexpro/task/621"
      };
    }
    throw new Error(`unexpected tool ${toolName}`);
  };
  const mcpAdapter = async (toolName, args) => {
    if (toolName !== "browser_control") return mcp(toolName, args);
    if (args.action === "list_profiles") return { profiles: [{ profile_id: PROFILE_ID, connected: true }] };
    return { runtime_identity: { artifact_sha256: liveSha, extension_version_label: "1.0.0", runtime_build_id: "fixture" } };
  };
  const controller = createManagerExtensionRuntimeController({
    home: path.join(sandbox, "home"),
    canonicalExtensionRoot: canonicalRoot,
    runtimeConfig: { root: repositoryRoot, port: 8793, token: "test" },
    mcp: mcpAdapter,
    userDataRoots: [userDataRoot],
    listChromeProcesses: async () => processes,
    defaultUserDataRoot: userDataRoot,
    allowNonWindows: true,
    runGit: async () => ({ stdout: `${COMMIT}\n` })
  });
  const task = await controller.loadTask(TASK_ID);
  assert.equal(task.taskId, TASK_ID);
  assert.equal(task.ownerProfileId, OWNER_ID);
  assert.equal(task.status, "blocked");
  assert.deepEqual(task.commitShas, [COMMIT, COMMIT]);
  const runtime = await controller.inspectRuntime(PROFILE_ID);
  assert.equal(runtime.connectionCount, 1);
  assert.equal(runtime.liveSha256, liveSha);
  // Branded Chrome ignores --load-extension. Do not trust its command line as live provenance.
  assert.equal(runtime.loadedExtensionRoots[0], fs.realpathSync(canonicalRoot));

  const missingStorageUserDataRoot = path.join(sandbox, "Missing Storage Chrome", "User Data");
  const missingStorageProfileRoot = makeProfile(missingStorageUserDataRoot, "Profile 57", canonicalRoot);
  const missingStorageController = createManagerExtensionRuntimeController({
    home: path.join(sandbox, "missing-storage-managed-home"),
    canonicalExtensionRoot: canonicalRoot,
    runtimeConfig: { root: repositoryRoot, port: 8793, token: "test" },
    mcp: mcpAdapter,
    userDataRoots: [missingStorageUserDataRoot],
    listChromeProcesses: async () => [],
    activationBrowserExecutable: executablePath,
    allowNonWindows: true,
    normalizeManagedWorkerLifecycle: async () => {},
    runPowerShell: async () => ({ stdout: JSON.stringify({
      productName: "Google Chrome for Testing",
      productVersion: "152.0.7977.84",
      companyName: "Google LLC"
    }) })
  });
  await missingStorageController.inspectRuntime(PROFILE_ID);
  fs.rmSync(path.join(missingStorageProfileRoot, "Local Extension Settings", EXTENSION_ID), { recursive: true, force: true });
  await assert.rejects(
    missingStorageController.prepareProfile({ profileId: PROFILE_ID }),
    (error) => error?.code === "EXTENSION_SOURCE_PROFILE_STORAGE_MISSING",
    "missing source storage must fail closed"
  );

  const wrongManagedUserDataRoot = path.join(sandbox, "Wrong Managed Chrome", "User Data");
  makeProfile(wrongManagedUserDataRoot, "Profile 57", canonicalRoot);
  const wrongManagedHome = path.join(sandbox, "wrong-managed-home");
  const wrongManagedStorage = path.join(
    wrongManagedHome,
    "extension-runtime-browser-profiles",
    PROFILE_ID,
    "user-data",
    "Default",
    "Local Extension Settings",
    EXTENSION_ID
  );
  fs.mkdirSync(wrongManagedStorage, { recursive: true });
  fs.writeFileSync(path.join(wrongManagedStorage, "000001.log"), "different-profile-identity");
  const wrongManagedController = createManagerExtensionRuntimeController({
    home: wrongManagedHome,
    canonicalExtensionRoot: canonicalRoot,
    runtimeConfig: { root: repositoryRoot, port: 8793, token: "test" },
    mcp: mcpAdapter,
    userDataRoots: [wrongManagedUserDataRoot],
    activationBrowserExecutable: executablePath,
    allowNonWindows: true,
    normalizeManagedWorkerLifecycle: async () => {},
    runPowerShell: async () => ({ stdout: JSON.stringify({
      productName: "Google Chrome for Testing",
      productVersion: "152.0.7977.84",
      companyName: "Google LLC"
    }) })
  });
  await assert.rejects(
    wrongManagedController.prepareProfile({ profileId: PROFILE_ID }),
    (error) => error?.code === "EXTENSION_MANAGED_PROFILE_ID_MISMATCH",
    "Manager-owned wrong identity must fail closed"
  );

  let testingProcesses = [...processes];
  let stoppedTestingProcessIds = [];
  const testingBrowserController = createManagerExtensionRuntimeController({
    home: path.join(sandbox, "testing-browser-home"),
    canonicalExtensionRoot: canonicalRoot,
    runtimeConfig: { root: repositoryRoot, port: 8793, token: "test" },
    mcp: mcpAdapter,
    userDataRoots: [userDataRoot],
    listChromeProcesses: async () => testingProcesses,
    stopChromeProcesses: async (processIds) => {
      stoppedTestingProcessIds = [...processIds];
      const stopped = new Set(processIds);
      testingProcesses = testingProcesses.filter((item) => !stopped.has(Number(item.ProcessId)));
    },
    defaultUserDataRoot: userDataRoot,
    activationBrowserExecutable: executablePath,
    allowNonWindows: true,
    normalizeManagedWorkerLifecycle: async () => {},
    runPowerShell: async () => ({ stdout: JSON.stringify({
      productName: "Google Chrome for Testing",
      productVersion: "152.0.7977.84",
      companyName: "Google LLC"
    }) })
  });
  const preparedBrowser = await testingBrowserController.prepareProfile({ profileId: PROFILE_ID });
  assert.equal(preparedBrowser.executablePath, fs.realpathSync(executablePath));
  assert.equal(preparedBrowser.isolation, "manager-owned-user-data");
  assert.notEqual(preparedBrowser.userDataRoot, binding.userDataRoot);
  assert.equal(fs.readFileSync(sourceCookiePath, "utf8"), "real-user-cookie-sentinel");
  assert.equal(fs.existsSync(path.join(preparedBrowser.userDataRoot, "Default", "Network", "Cookies")), false);
  assert.equal(fs.readFileSync(sourceStorageFile).equals(sourceStorageBefore), true, "prepareProfile must not mutate source extension storage");
  assert.equal(
    scanContainsProfileIdForTest(
      path.join(preparedBrowser.userDataRoot, "Default", "Local Extension Settings", EXTENSION_ID),
      PROFILE_ID
    ),
    true
  );
  await assert.rejects(
    testingBrowserController.stopProfile({ profileId: PROFILE_ID }),
    (error) => error?.code === "EXTENSION_SOURCE_PROFILE_SHUTDOWN_REQUIRED"
  );
  assert.deepEqual(stoppedTestingProcessIds, []);
  testingProcesses.push(
    {
      ProcessId: 400,
      ParentProcessId: 1,
      CommandLine: `"${executablePath}" "--user-data-dir=${preparedBrowser.userDataRoot}" --profile-directory=Default "--load-extension=${artifactRoot}"`,
      ExecutablePath: executablePath
    },
    { ProcessId: 401, ParentProcessId: 400, CommandLine: `"${executablePath}" --type=renderer`, ExecutablePath: executablePath }
  );
  const testingRuntime = await testingBrowserController.inspectRuntime(PROFILE_ID);
  assert.equal(testingRuntime.loadedExtensionRoots[0], fs.realpathSync(artifactRoot));
  assert.equal(testingRuntime.runtimeKind, "manager-owned-isolated");
  await testingBrowserController.stopProfile({ profileId: PROFILE_ID });
  assert.deepEqual(stoppedTestingProcessIds, [401, 400]);
  assert.equal(fs.readFileSync(sourceCookiePath, "utf8"), "real-user-cookie-sentinel");

  const wrongBrowserController = createManagerExtensionRuntimeController({
    home: path.join(sandbox, "wrong-browser-home"),
    canonicalExtensionRoot: canonicalRoot,
    runtimeConfig: { root: repositoryRoot, port: 8793, token: "test" },
    mcp: mcpAdapter,
    userDataRoots: [userDataRoot],
    activationBrowserExecutable: executablePath,
    allowNonWindows: true,
    runPowerShell: async () => ({ stdout: JSON.stringify({
      productName: "Google Chrome",
      productVersion: "152.0.7977.84",
      companyName: "Google LLC"
    }) })
  });
  await assert.rejects(
    wrongBrowserController.prepareProfile({ profileId: PROFILE_ID }),
    (error) => error?.code === "EXTENSION_TESTING_BROWSER_IDENTITY_MISMATCH"
  );

  const missingBrowserController = createManagerExtensionRuntimeController({
    home: path.join(sandbox, "missing-browser-home"),
    canonicalExtensionRoot: canonicalRoot,
    runtimeConfig: { root: repositoryRoot, port: 8793, token: "test" },
    mcp: mcpAdapter,
    userDataRoots: [userDataRoot],
    activationBrowserExecutable: path.join(sandbox, "missing", "chrome.exe"),
    allowNonWindows: true
  });
  await assert.rejects(
    missingBrowserController.prepareProfile({ profileId: PROFILE_ID }),
    (error) => error?.code === "EXTENSION_TESTING_BROWSER_MISSING"
  );

  const wrongOwnerController = createManagerExtensionRuntimeController({
    home: path.join(sandbox, "wrong-owner-home"),
    canonicalExtensionRoot: canonicalRoot,
    runtimeConfig: { root: repositoryRoot, port: 8793, token: "test" },
    mcp: async (toolName, args) => {
      const value = await mcpAdapter(toolName, args);
      if (toolName === "workspace_coordination_status") return { ...value, task_worker_id: "wrong" };
      return value;
    },
    userDataRoots: [userDataRoot],
    allowNonWindows: true
  });
  await assert.rejects(
    wrongOwnerController.loadTask(TASK_ID),
    (error) => error?.code === "EXTENSION_TASK_OWNER_PROVENANCE_MISMATCH"
  );

  const disabledUserDataRoot = path.join(sandbox, "Chrome Disabled", "User Data");
  const disabledProfileRoot = makeProfile(disabledUserDataRoot, "Profile 57", canonicalRoot);
  const disabledSourceStorage = path.join(disabledProfileRoot, "Local Extension Settings", EXTENSION_ID);
  const disabledSourceLog = path.join(disabledSourceStorage, "000001.log");
  fs.appendFileSync(
    disabledSourceLog,
    Buffer.from("active=false;workerDisablePending=true;workerEnabled=false;")
  );
  const disabledSourceBefore = fs.readFileSync(disabledSourceLog);
  const disabledCookiePath = path.join(disabledProfileRoot, "Network", "Cookies");
  fs.mkdirSync(path.dirname(disabledCookiePath), { recursive: true });
  fs.writeFileSync(disabledCookiePath, "disabled-source-cookie-sentinel");
  const bootstrapFiles = managedWorkerLifecycleBootstrapFiles({
    manifestKey: KEY,
    callbackUrl: "http://127.0.0.1:45678/bootstrap-test"
  });
  assert.match(bootstrapFiles.script, /workerEnabled:true/);
  assert.match(bootstrapFiles.script, /workerEnabledUpdatedAt:Date\.now\(\)/);
  assert.match(bootstrapFiles.script, /workerDisablePending:false/);
  const lifecycleWrite = bootstrapFiles.script.match(/chrome\.storage\.local\.set\((\{[^;]+\})\)/)?.[1] || "";
  assert.doesNotMatch(lifecycleWrite, /\bactive\s*:/, "isolated bootstrap must not override active routing state");

  const disabledController = createManagerExtensionRuntimeController({
    home: path.join(sandbox, "disabled-managed-home"),
    canonicalExtensionRoot: canonicalRoot,
    runtimeConfig: { root: repositoryRoot, port: 8793, token: "test" },
    mcp: mcpAdapter,
    userDataRoots: [disabledUserDataRoot],
    defaultUserDataRoot: disabledUserDataRoot,
    activationBrowserExecutable: executablePath,
    allowNonWindows: true,
    normalizeManagedWorkerLifecycle: async ({ binding }) => {
      const managedStorage = path.join(binding.profileRoot, "Local Extension Settings", EXTENSION_ID);
      const managedLog = path.join(managedStorage, "000001.log");
      const current = fs.readFileSync(managedLog, "latin1")
        .replace("workerEnabled=false", "workerEnabled=true ")
        .replace("workerDisablePending=true", "workerDisablePending=false");
      fs.writeFileSync(managedLog, Buffer.from(current, "latin1"));
    },
    runPowerShell: async () => ({ stdout: JSON.stringify({
      productName: "Google Chrome for Testing",
      productVersion: "152.0.7977.84",
      companyName: "Google LLC"
    }) })
  });
  const preparedDisabled = await disabledController.prepareProfile({ profileId: PROFILE_ID });
  const disabledManagedStorage = path.join(
    preparedDisabled.userDataRoot,
    "Default",
    "Local Extension Settings",
    EXTENSION_ID
  );
  const disabledManagedText = storageTextForTest(disabledManagedStorage);
  assert.equal(
    scanContainsProfileIdForTest(disabledManagedStorage, PROFILE_ID),
    true,
    "isolated storage must preserve exact profile identity"
  );
  const isolatedCanRegister = !disabledManagedText.includes("workerEnabled=false");
  assert.equal(
    isolatedCanRegister,
    true,
    "isolated runtime must not inherit source workerEnabled=false because profileInfo/pollLoop suppress bridge registration when disabled"
  );
  assert.equal(
    fs.readFileSync(disabledSourceLog).equals(disabledSourceBefore),
    true,
    "seeding must not mutate source extension storage"
  );
  assert.equal(
    fs.readFileSync(disabledCookiePath, "utf8"),
    "disabled-source-cookie-sentinel",
    "seeding must not mutate source cookies"
  );

  console.log("extension-runtime-manager-smoke: ok");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
