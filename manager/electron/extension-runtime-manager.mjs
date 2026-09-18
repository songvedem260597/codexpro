import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { createManagerMcpClient } from "./mcp/manager-mcp-client.mjs";
import { extensionIdFromManifestKey } from "./extension-runtime-activation.mjs";
import { runGitProcess, runPowerShellProcess } from "./process-runner.mjs";

const DEFAULT_PORT = 8793;
const DEFAULT_LIVE_WAIT_MS = 120_000;
const PROFILE_STORAGE_SCAN_LIMIT = 64 * 1024 * 1024;
const PROFILE_STORAGE_FILE_LIMIT = 16 * 1024 * 1024;
const MANAGED_BROWSER_PROFILE_DIR = "extension-runtime-browser-profiles";
const MANAGED_LIFECYCLE_BOOTSTRAP_DIR = "extension-runtime-storage-bootstrap";
const MANAGED_LIFECYCLE_BOOTSTRAP_TIMEOUT_MS = 15_000;

function managerError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "ExtensionRuntimeManagerError";
  error.code = code;
  return error;
}

function normalizePath(value) {
  return path.resolve(String(value || ""));
}

function samePath(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parent, child) {
  const relative = path.relative(normalizePath(parent), normalizePath(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function managedWorkerLifecycleBootstrapFiles({ manifestKey, callbackUrl }) {
  const key = String(manifestKey || "").trim();
  const callback = String(callbackUrl || "").trim();
  if (!key || !/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+$/.test(callback)) {
    throw managerError("EXTENSION_MANAGED_BOOTSTRAP_INPUT_INVALID", "Managed extension lifecycle bootstrap input is invalid.");
  }
  return {
    manifest: JSON.stringify({
      manifest_version: 3,
      name: "CodexPro Manager Storage Bootstrap",
      version: "1.0.0",
      key,
      permissions: ["storage"],
      host_permissions: ["http://127.0.0.1/*"]
    }, null, 2),
    html: "<!doctype html><meta charset=\"utf-8\"><script src=\"bootstrap.js\"></script>",
    script: [
      "(async()=>{",
      "  await chrome.storage.local.set({workerEnabled:true,workerEnabledUpdatedAt:Date.now(),workerDisablePending:false});",
      `  await fetch(${JSON.stringify(callback)},{method:"POST",cache:"no-store"});`,
      "})().catch(()=>{});"
    ].join("\n")
  };
}

export function parseCodexProTaskArguments(argumentsText = "", tokenFileDefault = "") {
  const value = String(argumentsText || "");
  const read = (name) => {
    const match = value.match(new RegExp(`--${name}\\s+(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, "i"));
    return match?.[1] || match?.[2] || match?.[3] || "";
  };
  return {
    root: read("root"),
    port: Number(read("port")) || DEFAULT_PORT,
    tokenFile: read("token-file") || tokenFileDefault
  };
}

export async function discoverCodexProRuntimeConfig({
  home = process.env.CODEXPRO_HOME ? path.resolve(process.env.CODEXPRO_HOME) : path.join(os.homedir(), ".codexpro"),
  runPowerShell = runPowerShellProcess
} = {}) {
  if (process.platform !== "win32") {
    throw managerError("EXTENSION_ACTIVATION_WINDOWS_REQUIRED", "Live Manager extension activation currently requires Windows Chrome.");
  }
  const script = [
    "$t=Get-ScheduledTask -TaskName 'CodexPro' -ErrorAction Stop",
    "$a=@($t.Actions)",
    "if($a.Count -ne 1){throw 'CodexPro Scheduled Task must have exactly one action.'}",
    "[pscustomobject]@{state=[string]$t.State;arguments=[string]$a[0].Arguments} | ConvertTo-Json -Compress"
  ].join("; ");
  let scheduled;
  try {
    const result = await runPowerShell(script, { timeoutMs: 8_000 });
    scheduled = JSON.parse(String(result?.stdout || "").trim());
  } catch (cause) {
    throw managerError("EXTENSION_MANAGER_RUNTIME_DISCOVERY_FAILED", "Could not discover the official CodexPro Scheduled Task runtime.", cause);
  }
  const tokenFileDefault = path.join(home, "http-token");
  const parsed = parseCodexProTaskArguments(scheduled?.arguments, tokenFileDefault);
  if (!parsed.root || !fs.existsSync(parsed.root)) {
    throw managerError("EXTENSION_MANAGER_ROOT_MISSING", "CodexPro Scheduled Task has no valid repository root.");
  }
  let token = "";
  try {
    token = fs.readFileSync(parsed.tokenFile, "utf8").trim();
  } catch (cause) {
    throw managerError("EXTENSION_MANAGER_TOKEN_MISSING", "CodexPro Manager token file is missing.", cause);
  }
  if (!token) throw managerError("EXTENSION_MANAGER_TOKEN_MISSING", "CodexPro Manager token file is empty.");
  return {
    home: normalizePath(home),
    root: normalizePath(parsed.root),
    port: parsed.port,
    tokenFile: normalizePath(parsed.tokenFile),
    token
  };
}

function scanContainsProfileId(storageRoot, profileId) {
  const needle = Buffer.from(String(profileId), "utf8");
  let scanned = 0;
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "LOCK") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (visit(absolute)) return true;
        continue;
      }
      if (!entry.isFile()) continue;
      const size = fs.statSync(absolute).size;
      if (size > PROFILE_STORAGE_FILE_LIMIT) continue;
      scanned += size;
      if (scanned > PROFILE_STORAGE_SCAN_LIMIT) {
        throw managerError("EXTENSION_PROFILE_STORAGE_SCAN_LIMIT", "Chrome profile binding scan exceeded its bounded read limit.");
      }
      if (fs.readFileSync(absolute).includes(needle)) return true;
    }
    return false;
  };
  return visit(storageRoot);
}

function seedManagerOwnedExtensionStorage(binding) {
  const sourceRoot = String(binding?.sourceExtensionStorageRoot || "");
  const destinationRoot = path.join(binding.profileRoot, "Local Extension Settings", binding.extensionId);
  if (!sourceRoot || !fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw managerError("EXTENSION_SOURCE_PROFILE_STORAGE_MISSING", "Source profile extension storage is unavailable for isolated activation bootstrap.");
  }
  if (!scanContainsProfileId(sourceRoot, binding.profileId)) {
    throw managerError("EXTENSION_SOURCE_PROFILE_ID_MISSING", "Source extension storage does not contain the requested profile identity.");
  }
  if (fs.existsSync(destinationRoot)) {
    if (!scanContainsProfileId(destinationRoot, binding.profileId)) {
      throw managerError("EXTENSION_MANAGED_PROFILE_ID_MISMATCH", "Existing Manager-owned extension storage belongs to a different profile identity.");
    }
    return { destinationRoot, seeded: false };
  }
  fs.mkdirSync(path.dirname(destinationRoot), { recursive: true });
  const stagedRoot = `${destinationRoot}.stage-${randomUUID()}`;
  try {
    fs.cpSync(sourceRoot, stagedRoot, {
      recursive: true,
      errorOnExist: true,
      filter: (candidate) => path.basename(candidate).toUpperCase() !== "LOCK" && !fs.lstatSync(candidate).isSymbolicLink()
    });
    if (!scanContainsProfileId(stagedRoot, binding.profileId)) {
      throw managerError("EXTENSION_MANAGED_PROFILE_SEED_FAILED", "Staged extension storage lost the requested profile identity.");
    }
    fs.renameSync(stagedRoot, destinationRoot);
  } catch (cause) {
    if (fs.existsSync(stagedRoot)) fs.rmSync(stagedRoot, { recursive: true, force: true });
    if (cause?.code?.startsWith?.("EXTENSION_")) throw cause;
    throw managerError("EXTENSION_MANAGED_PROFILE_SEED_FAILED", "Could not seed isolated extension storage.", cause);
  }
  return { destinationRoot, seeded: true };
}

function defaultChromeUserDataRoots() {
  const local = String(process.env.LOCALAPPDATA || "");
  if (!local) return [];
  return [
    path.join(local, "Google", "Chrome", "User Data"),
    path.join(local, "Google", "Chrome Beta", "User Data")
  ];
}

export function findChromeProfileBinding({
  profileId,
  extensionId,
  userDataRoots = defaultChromeUserDataRoots()
}) {
  const exactProfileId = String(profileId || "").trim();
  const exactExtensionId = String(extensionId || "").trim();
  if (!exactProfileId || !/^[a-p]{32}$/.test(exactExtensionId)) {
    throw managerError("EXTENSION_PROFILE_BINDING_INPUT_INVALID", "Profile and extension identities are required.");
  }
  const matches = [];
  for (const candidateRoot of userDataRoots) {
    if (!candidateRoot || !fs.existsSync(candidateRoot)) continue;
    const userDataRoot = fs.realpathSync(candidateRoot);
    for (const entry of fs.readdirSync(userDataRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || (entry.name !== "Default" && !/^Profile \d+$/.test(entry.name))) continue;
      const profileRoot = path.join(userDataRoot, entry.name);
      const storageRoot = path.join(profileRoot, "Local Extension Settings", exactExtensionId);
      if (!fs.existsSync(storageRoot) || !fs.statSync(storageRoot).isDirectory()) continue;
      if (!scanContainsProfileId(storageRoot, exactProfileId)) continue;
      matches.push({
        profileId: exactProfileId,
        extensionId: exactExtensionId,
        userDataRoot,
        profileDirectory: entry.name,
        profileRoot,
        securePreferencesPath: path.join(profileRoot, "Secure Preferences")
      });
    }
  }
  if (matches.length !== 1) {
    throw managerError(
      matches.length ? "EXTENSION_PROFILE_BINDING_AMBIGUOUS" : "EXTENSION_PROFILE_BINDING_MISSING",
      `Expected exactly one Chrome profile binding for ${exactProfileId}; found ${matches.length}.`
    );
  }
  return matches[0];
}

export function createManagerOwnedChromeBinding({ home, profileId, extensionId, sourceBinding }) {
  const managerHome = normalizePath(home);
  const exactProfileId = String(profileId || "").trim();
  const exactExtensionId = String(extensionId || "").trim();
  if (!managerHome || !/^[A-Za-z0-9_-]{1,128}$/.test(exactProfileId) || !/^[a-p]{32}$/.test(exactExtensionId)) {
    throw managerError("EXTENSION_MANAGED_PROFILE_INPUT_INVALID", "Manager-owned browser profile identity is invalid.");
  }
  const sourceUserDataValue = String(sourceBinding?.userDataRoot || "").trim();
  const sourceProfileValue = String(sourceBinding?.profileRoot || "").trim();
  if (!sourceBinding || !sourceUserDataValue || !sourceProfileValue ||
      String(sourceBinding.profileId || "") !== exactProfileId ||
      String(sourceBinding.extensionId || "") !== exactExtensionId) {
    throw managerError("EXTENSION_SOURCE_PROFILE_BINDING_INVALID", "Authoritative source profile binding is missing or inconsistent.");
  }
  const sourceUserDataRoot = normalizePath(sourceUserDataValue);
  const sourceProfileRoot = normalizePath(sourceProfileValue);
  const managedProfilesRoot = path.join(managerHome, MANAGED_BROWSER_PROFILE_DIR);
  const userDataRoot = path.join(managedProfilesRoot, exactProfileId, "user-data");
  const profileDirectory = "Default";
  const profileRoot = path.join(userDataRoot, profileDirectory);
  if (!isInside(managedProfilesRoot, userDataRoot) || samePath(userDataRoot, sourceUserDataRoot) ||
      isInside(sourceUserDataRoot, userDataRoot) || isInside(userDataRoot, sourceUserDataRoot)) {
    throw managerError("EXTENSION_REAL_USER_DATA_FORBIDDEN", "Chrome for Testing cannot use or nest inside a real Chrome User Data root.");
  }
  return {
    managerOwned: true,
    managerHome,
    profileId: exactProfileId,
    extensionId: exactExtensionId,
    userDataRoot,
    profileDirectory,
    profileRoot,
    securePreferencesPath: path.join(profileRoot, "Secure Preferences"),
    sourceUserDataRoot,
    sourceProfileRoot,
    sourceProfileDirectory: String(sourceBinding.profileDirectory || ""),
    sourceExtensionStorageRoot: path.join(sourceProfileRoot, "Local Extension Settings", exactExtensionId)
  };
}

export function readChromeLoadedExtensionRoot(binding) {
  let preferences;
  try {
    preferences = JSON.parse(fs.readFileSync(binding.securePreferencesPath, "utf8"));
  } catch (cause) {
    throw managerError("EXTENSION_CHROME_PREFERENCES_INVALID", "Could not read Chrome Secure Preferences.", cause);
  }
  const configured = String(preferences?.extensions?.settings?.[binding.extensionId]?.path || "");
  if (!configured) {
    throw managerError("EXTENSION_CHROME_SOURCE_ROOT_MISSING", "Chrome Secure Preferences has no unpacked source path for the expected extension.");
  }
  const resolved = path.isAbsolute(configured) ? configured : path.resolve(binding.profileRoot, configured);
  try {
    return fs.realpathSync(resolved);
  } catch (cause) {
    throw managerError("EXTENSION_CHROME_SOURCE_ROOT_MISSING", `Chrome extension source path does not exist: ${resolved}`, cause);
  }
}

function commandLineUserDataRoot(commandLine) {
  const match = String(commandLine || "").match(/(?:"--user-data-dir=([^"]+)"|--user-data-dir=(?:"([^"]+)"|([^\s]+)))/i);
  return match?.[1] || match?.[2] || match?.[3] || "";
}

export function commandLineExtensionRoots(commandLine) {
  const match = String(commandLine || "").match(/(?:"--load-extension=([^"]+)"|--load-extension=(?:"([^"]+)"|([^\s]+)))/i);
  const value = match?.[1] || match?.[2] || match?.[3] || "";
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function chromeActivationArguments(binding, extensionRoot) {
  const managedProfilesRoot = path.join(normalizePath(binding?.managerHome), MANAGED_BROWSER_PROFILE_DIR);
  if (binding?.managerOwned !== true || !binding?.managerHome ||
      !isInside(managedProfilesRoot, binding?.userDataRoot) ||
      samePath(binding?.userDataRoot, binding?.sourceUserDataRoot) ||
      isInside(binding?.sourceUserDataRoot, binding?.userDataRoot) ||
      isInside(binding?.userDataRoot, binding?.sourceUserDataRoot)) {
    throw managerError("EXTENSION_REAL_USER_DATA_FORBIDDEN", "Refusing to launch an alternate Chrome binary against real Chrome User Data.");
  }
  return [
    `--user-data-dir=${binding.userDataRoot}`,
    `--profile-directory=${binding.profileDirectory}`,
    `--load-extension=${fs.realpathSync(extensionRoot)}`,
    "--restore-last-session",
    "--no-first-run",
    "--no-default-browser-check"
  ];
}

export function selectChromeProcessCohort(processes, binding, defaultUserDataRoot = defaultChromeUserDataRoots()[0]) {
  const rows = (Array.isArray(processes) ? processes : []).map((item) => ({
    processId: Number(item.processId ?? item.ProcessId),
    parentProcessId: Number(item.parentProcessId ?? item.ParentProcessId),
    commandLine: String(item.commandLine ?? item.CommandLine ?? ""),
    executablePath: String(item.executablePath ?? item.ExecutablePath ?? "")
  })).filter((item) => Number.isInteger(item.processId) && item.processId > 0);
  const mains = rows.filter((item) => item.commandLine && !/(?:^|\s)--type=/i.test(item.commandLine));
  const candidates = mains.filter((item) => {
    const explicit = commandLineUserDataRoot(item.commandLine);
    if (explicit) return samePath(explicit, binding.userDataRoot);
    return defaultUserDataRoot && samePath(binding.userDataRoot, defaultUserDataRoot);
  });
  if (candidates.length !== 1) {
    throw managerError(
      candidates.length ? "EXTENSION_CHROME_PROCESS_AMBIGUOUS" : "EXTENSION_CHROME_PROCESS_MISSING",
      `Expected one Chrome browser process for the profile data root; found ${candidates.length}.`
    );
  }
  const main = candidates[0];
  const selected = new Set([main.processId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of rows) {
      if (!selected.has(item.processId) && selected.has(item.parentProcessId)) {
        selected.add(item.processId);
        changed = true;
      }
    }
  }
  const processIds = [...selected].sort((a, b) => b - a);
  if (!main.executablePath || !fs.existsSync(main.executablePath)) {
    throw managerError("EXTENSION_CHROME_EXECUTABLE_MISSING", "Chrome browser executable path is unavailable.");
  }
  return { main, processIds, executablePath: main.executablePath };
}

async function listChromeProcesses(runPowerShell) {
  const script = [
    "$p=@(Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath)",
    "@($p) | ConvertTo-Json -Compress"
  ].join("; ");
  const result = await runPowerShell(script, { timeoutMs: 10_000, maxBuffer: 4 * 1024 * 1024 });
  const text = String(result?.stdout || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function stopChromeProcesses(processIds, runPowerShell) {
  const exactIds = [...new Set(processIds.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
  if (!exactIds.length) throw managerError("EXTENSION_CHROME_STOP_TARGET_MISSING", "No validated Chrome processes were selected for restart.");
  const script = [
    `$targets=@(Get-Process -Id ${exactIds.join(",")} -ErrorAction SilentlyContinue)`,
    "if($targets.Count -gt 0){$targets | Stop-Process -Force -ErrorAction Stop}"
  ].join("; ");
  await runPowerShell(script, { timeoutMs: 12_000 });
}

function causalTelemetryNoop() {
  return {
    begin() { return {}; },
    markInitialized() {},
    markCloseStarted() {},
    markCloseCompleted() {},
    markToolCompleted() {}
  };
}

function readManifestExtensionId(canonicalExtensionRoot) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(canonicalExtensionRoot, "manifest.json"), "utf8"));
  } catch (cause) {
    throw managerError("EXTENSION_CANONICAL_MANIFEST_INVALID", "Canonical Chrome extension manifest could not be read.", cause);
  }
  return extensionIdFromManifestKey(manifest?.key);
}

function connectedProfileMatches(result, profileId) {
  return (Array.isArray(result?.profiles) ? result.profiles : [])
    .filter((profile) => String(profile?.profile_id || "") === profileId && profile?.connected === true);
}

export function createManagerExtensionRuntimeController(options = {}) {
  const home = normalizePath(options.home || (process.env.CODEXPRO_HOME ? process.env.CODEXPRO_HOME : path.join(os.homedir(), ".codexpro")));
  const canonicalExtensionRoot = normalizePath(options.canonicalExtensionRoot);
  const extensionId = readManifestExtensionId(canonicalExtensionRoot);
  const runPowerShell = options.runPowerShell || runPowerShellProcess;
  const runGit = options.runGit || runGitProcess;
  const spawnChrome = options.spawnChrome || ((executable, args) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    return child;
  });
  let runtimeConfig = options.runtimeConfig || null;
  let mcp = options.mcp || null;
  let sourceProfileBinding = null;
  let profileBinding = null;
  const managedTestingBrowserCandidate = normalizePath(
    options.activationBrowserExecutable || path.join(home, "chrome-for-testing", "current", "chrome.exe")
  );
  let managedTestingBrowser = "";

  async function ensureMcp() {
    if (!runtimeConfig) runtimeConfig = await discoverCodexProRuntimeConfig({ home, runPowerShell });
    if (!mcp) {
      const client = createManagerMcpClient({
        managerVersion: "extension-runtime-activation",
        causalTelemetry: causalTelemetryNoop()
      });
      mcp = async (toolName, args, timeoutMs = 15_000) => client.localMcpTool(
        { port: runtimeConfig.port },
        runtimeConfig.token,
        toolName,
        args,
        timeoutMs,
        { caller: "manager-extension-runtime-activation" }
      );
    }
    return mcp;
  }

  function sourceBindingFor(profileId) {
    if (!sourceProfileBinding || sourceProfileBinding.profileId !== profileId) {
      sourceProfileBinding = findChromeProfileBinding({
        profileId,
        extensionId,
        userDataRoots: options.userDataRoots
      });
    }
    return sourceProfileBinding;
  }

  function bindingFor(profileId) {
    if (!profileBinding || profileBinding.profileId !== profileId) {
      profileBinding = createManagerOwnedChromeBinding({
        home,
        profileId,
        extensionId,
        sourceBinding: sourceBindingFor(profileId)
      });
    }
    return profileBinding;
  }

  async function loadTask(taskId) {
    const call = await ensureMcp();
    const [repo, coordination] = await Promise.all([
      call("repo_task_status", { task_id: taskId }, 20_000),
      call("workspace_coordination_status", { task_id: taskId }, 20_000)
    ]);
    const tracking = repo?.tracking || {};
    const job = repo?.worker_job || {};
    if (coordination?.found !== true || String(coordination?.task_id || "") !== taskId ||
        String(tracking?.task_id || "") !== taskId || String(job?.job_id || "") !== taskId) {
      throw managerError("EXTENSION_TASK_NOT_FOUND", "Authoritative coordination and WorkerJob records do not agree on the requested task.");
    }
    const owners = [
      coordination.task_worker_id,
      tracking.owner_profile,
      tracking.owner_worker,
      job.worker_id
    ].map((value) => String(value || "")).filter(Boolean);
    if (!owners.length || owners.some((value) => value !== owners[0])) {
      throw managerError("EXTENSION_TASK_OWNER_PROVENANCE_MISMATCH", "Task owner provenance is missing or inconsistent.");
    }
    const worktreeRoots = [coordination.task_worktree_root, repo.worktree_root]
      .map((value) => String(value || "")).filter(Boolean);
    const branches = [coordination.task_worktree_branch, repo.worktree_branch]
      .map((value) => String(value || "")).filter(Boolean);
    if (worktreeRoots.length !== 2 || !samePath(worktreeRoots[0], worktreeRoots[1]) ||
        branches.length !== 2 || branches[0] !== branches[1]) {
      throw managerError("EXTENSION_TASK_WORKTREE_PROVENANCE_MISMATCH", "Task worktree provenance is missing or inconsistent.");
    }
    const executionState = String(job.execution_state || "").toLowerCase();
    return {
      taskId,
      ownerProfileId: owners[0],
      status: executionState === "blocked" ? "blocked" : String(coordination.task_status || job.status || "").toLowerCase(),
      completionConfirmed: job.completion_confirmed === true || String(coordination.task_status || "").toLowerCase() === "completed",
      repositoryRoot: String(coordination.root || repo.root || ""),
      worktreeRoot: worktreeRoots[0],
      worktreeBranch: branches[0],
      commitShas: [tracking.checkpoint, tracking.commit_sha, repo.tracking?.worktree_head].filter(Boolean)
    };
  }

  async function inspectRuntimeOnce(profileId) {
    const call = await ensureMcp();
    const binding = bindingFor(profileId);
    const sourceBinding = sourceBindingFor(profileId);
    const processes = await (options.listChromeProcesses ? options.listChromeProcesses() : listChromeProcesses(runPowerShell));
    let managedCohort = null;
    try {
      managedCohort = selectChromeProcessCohort(processes, binding, "");
    } catch (error) {
      if (error?.code !== "EXTENSION_CHROME_PROCESS_MISSING") throw error;
    }
    if (managedCohort && !samePath(managedCohort.executablePath, managedTestingBrowser || managedTestingBrowserCandidate)) {
      throw managerError("EXTENSION_MANAGED_BROWSER_IDENTITY_MISMATCH", "Manager-owned browser profile is running under an unexpected executable.");
    }
    const commandLineRoots = (managedCohort
      ? commandLineExtensionRoots(managedCohort.main.commandLine)
      : [])
      .filter((candidate) => {
        try {
          return readManifestExtensionId(fs.realpathSync(candidate)) === extensionId;
        } catch {
          return false;
        }
      })
      .map((candidate) => fs.realpathSync(candidate));
    if (managedCohort && commandLineRoots.length !== 1) {
      throw managerError("EXTENSION_MANAGED_RUNTIME_AMBIGUOUS", "Manager-owned browser must load exactly one matching extension slot.");
    }
    const loadedExtensionRoots = managedCohort ? commandLineRoots : [readChromeLoadedExtensionRoot(sourceBinding)];
    const profiles = await call("browser_control", { action: "list_profiles" }, 15_000);
    const matches = connectedProfileMatches(profiles, profileId);
    let tabs = {};
    if (matches.length === 1) {
      tabs = await call("browser_control", { action: "list_tabs", profile_id: profileId }, 20_000);
    }
    return {
      profileId,
      extensionId,
      loadedExtensionRoots,
      connectionCount: matches.length,
      liveSha256: String(tabs?.runtime_identity?.artifact_sha256 || "").toLowerCase(),
      extensionVersion: String(tabs?.runtime_identity?.extension_version_label || ""),
      runtimeBuildId: String(tabs?.runtime_identity?.runtime_build_id || ""),
      runtimeKind: managedCohort ? "manager-owned-isolated" : "source-profile",
      managerOwnedUserDataRoot: binding.userDataRoot,
      sourceUserDataRoot: sourceBinding.userDataRoot
    };
  }

  async function waitForRuntimeIdentity({ profileId, extensionRoot, timeoutMs = DEFAULT_LIVE_WAIT_MS }) {
    const expectedRoot = fs.realpathSync(extensionRoot);
    const manifest = JSON.parse(fs.readFileSync(path.join(expectedRoot, "manifest.json"), "utf8"));
    const workerPath = path.join(expectedRoot, String(manifest?.background?.service_worker || ""));
    const expectedSha256 = createHash("sha256").update(fs.readFileSync(workerPath)).digest("hex");
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const runtime = await inspectRuntimeOnce(profileId);
        if (runtime.connectionCount === 1 &&
            runtime.extensionId === extensionId &&
            runtime.loadedExtensionRoots.length === 1 &&
            samePath(runtime.loadedExtensionRoots[0], expectedRoot) &&
            runtime.liveSha256 === expectedSha256) {
          return runtime;
        }
        lastError = managerError("EXTENSION_LIVE_IDENTITY_PENDING", "Chrome has not exposed the expected extension runtime identity yet.");
      } catch (error) {
        lastError = error;
      }
      await sleep(500);
    }
    throw managerError("EXTENSION_LIVE_IDENTITY_TIMEOUT", "Timed out waiting for Chrome to bind the exact Manager extension slot.", lastError);
  }

  async function inspectChromeProcessCohort(profileId) {
    const binding = bindingFor(profileId);
    const processes = await (options.listChromeProcesses ? options.listChromeProcesses() : listChromeProcesses(runPowerShell));
    return selectChromeProcessCohort(processes, binding, "");
  }

  async function normalizeManagedWorkerLifecycle(binding) {
    if (typeof options.normalizeManagedWorkerLifecycle === "function") {
      await options.normalizeManagedWorkerLifecycle({ binding, extensionId });
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(canonicalExtensionRoot, "manifest.json"), "utf8"));
    const nonce = randomUUID().replace(/-/g, "");
    const callbackPath = `/bootstrap-${nonce}`;
    const bootstrapRoot = path.join(home, MANAGED_LIFECYCLE_BOOTSTRAP_DIR, binding.profileId, nonce);
    fs.mkdirSync(bootstrapRoot, { recursive: true });
    let callbackResolve;
    let callbackReject;
    let callbackSettled = false;
    const callbackPromise = new Promise((resolve, reject) => {
      callbackResolve = resolve;
      callbackReject = reject;
    });
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === callbackPath) {
        response.statusCode = 204;
        response.end();
        if (!callbackSettled) {
          callbackSettled = true;
          callbackResolve();
        }
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string" || !Number.isInteger(address.port)) {
        throw managerError("EXTENSION_MANAGED_BOOTSTRAP_LISTEN_FAILED", "Could not allocate the managed lifecycle bootstrap callback.");
      }
      const callbackUrl = `http://127.0.0.1:${address.port}${callbackPath}`;
      const files = managedWorkerLifecycleBootstrapFiles({ manifestKey: manifest.key, callbackUrl });
      fs.writeFileSync(path.join(bootstrapRoot, "manifest.json"), files.manifest);
      fs.writeFileSync(path.join(bootstrapRoot, "bootstrap.html"), files.html);
      fs.writeFileSync(path.join(bootstrapRoot, "bootstrap.js"), files.script);
      const args = chromeActivationArguments(binding, bootstrapRoot)
        .filter((value) => value !== "--restore-last-session");
      args.push(`chrome-extension://${extensionId}/bootstrap.html`);
      const child = spawnChrome(managedTestingBrowser, args);
      if (!child || child.pid === undefined) {
        throw managerError("EXTENSION_MANAGED_BOOTSTRAP_START_FAILED", "Managed lifecycle bootstrap Chrome did not return a process handle.");
      }
      const timer = setTimeout(() => {
        if (!callbackSettled) {
          callbackSettled = true;
          callbackReject(managerError(
            "EXTENSION_MANAGED_BOOTSTRAP_TIMEOUT",
            "Timed out normalizing isolated worker lifecycle state."
          ));
        }
      }, MANAGED_LIFECYCLE_BOOTSTRAP_TIMEOUT_MS);
      try {
        await callbackPromise;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
      try {
        await stopProfile({ profileId: binding.profileId });
      } catch (error) {
        if (error?.code !== "EXTENSION_CHROME_PROCESS_MISSING") throw error;
      }
      fs.rmSync(bootstrapRoot, { recursive: true, force: true });
    }
  }

  async function prepareProfile(profileId) {
    const binding = bindingFor(profileId);
    let candidate;
    try {
      candidate = fs.realpathSync(managedTestingBrowserCandidate);
    } catch (cause) {
      throw managerError("EXTENSION_TESTING_BROWSER_MISSING", "Manager Chrome for Testing executable is missing.", cause);
    }
    if (!options.activationBrowserExecutable) {
      const browserRoot = path.resolve(home, "chrome-for-testing");
      const relative = path.relative(browserRoot, candidate);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw managerError("EXTENSION_TESTING_BROWSER_UNTRUSTED", "Chrome for Testing must be installed inside the Manager-owned browser runtime root.");
      }
    }
    const script = [
      `$v=(Get-Item -LiteralPath ${quotePowerShell(candidate)}).VersionInfo`,
      "[pscustomobject]@{productName=$v.ProductName;productVersion=$v.ProductVersion;companyName=$v.CompanyName} | ConvertTo-Json -Compress"
    ].join("; ");
    let identity;
    try {
      identity = JSON.parse(String((await runPowerShell(script, { timeoutMs: 8_000 }))?.stdout || "").trim());
    } catch (cause) {
      throw managerError("EXTENSION_TESTING_BROWSER_IDENTITY_FAILED", "Could not verify Manager Chrome for Testing identity.", cause);
    }
    if (String(identity?.productName || "") !== "Google Chrome for Testing" ||
        String(identity?.companyName || "") !== "Google LLC" ||
        !/^\d+\.\d+\.\d+\.\d+$/.test(String(identity?.productVersion || ""))) {
      throw managerError("EXTENSION_TESTING_BROWSER_IDENTITY_MISMATCH", "Manager browser runtime is not an official Google Chrome for Testing executable.");
    }
    managedTestingBrowser = candidate;
    fs.mkdirSync(binding.profileRoot, { recursive: true });
    const seededStorage = seedManagerOwnedExtensionStorage(binding);
    await normalizeManagedWorkerLifecycle(binding);
    return {
      profileId,
      profileDirectory: binding.profileDirectory,
      userDataRoot: binding.userDataRoot,
      sourceUserDataRoot: binding.sourceUserDataRoot,
      isolation: "manager-owned-user-data",
      extensionStorageSeeded: seededStorage.seeded,
      executablePath: candidate,
      productVersion: String(identity.productVersion)
    };
  }

  async function stopProfile({ profileId }) {
    if (process.platform !== "win32" && options.allowNonWindows !== true) {
      throw managerError("EXTENSION_ACTIVATION_WINDOWS_REQUIRED", "Live Manager extension activation currently requires Windows Chrome.");
    }
    let cohort;
    try {
      cohort = await inspectChromeProcessCohort(profileId);
    } catch (error) {
      if (error?.code !== "EXTENSION_CHROME_PROCESS_MISSING") throw error;
      const call = await ensureMcp();
      const profiles = await call("browser_control", { action: "list_profiles" }, 15_000);
      if (connectedProfileMatches(profiles, profileId).length) {
        throw managerError(
          "EXTENSION_SOURCE_PROFILE_SHUTDOWN_REQUIRED",
          "Close or disable the source CodexPro Chrome profile before isolated activation; Manager will not terminate real Chrome."
        );
      }
      return { alreadyStopped: true, isolation: "manager-owned-user-data" };
    }
    if (!samePath(cohort.executablePath, managedTestingBrowser || managedTestingBrowserCandidate)) {
      throw managerError("EXTENSION_MANAGED_BROWSER_IDENTITY_MISMATCH", "Refusing to stop a browser outside the Manager-owned isolated runtime.");
    }
    await (options.stopChromeProcesses
      ? options.stopChromeProcesses(cohort.processIds)
      : stopChromeProcesses(cohort.processIds, runPowerShell));
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const remaining = await (options.listChromeProcesses ? options.listChromeProcesses() : listChromeProcesses(runPowerShell));
      const liveIds = new Set(remaining.map((item) => Number(item.processId ?? item.ProcessId)));
      if (cohort.processIds.every((pid) => !liveIds.has(pid))) return { stopped: true, isolation: "manager-owned-user-data" };
      await sleep(250);
    }
    throw managerError("EXTENSION_CHROME_STOP_TIMEOUT", "Validated Chrome process cohort did not stop before timeout.");
  }

  async function startProfile({ profileId, extensionRoot }) {
    const binding = bindingFor(profileId);
    if (!managedTestingBrowser || !fs.existsSync(managedTestingBrowser)) {
      throw managerError("EXTENSION_TESTING_BROWSER_MISSING", "Validated Manager Chrome for Testing is unavailable for profile restart.");
    }
    seedManagerOwnedExtensionStorage(binding);
    const args = chromeActivationArguments(binding, extensionRoot);
    const child = spawnChrome(managedTestingBrowser, args);
    if (!child || child.pid === undefined) {
      throw managerError("EXTENSION_CHROME_START_FAILED", "Chrome launch did not return a process handle.");
    }
    await waitForRuntimeIdentity({ profileId, extensionRoot });
  }

  return {
    home,
    canonicalExtensionRoot,
    extensionId,
    loadTask,
    getGitHead: async (root) => String((await runGit(["-C", root, "rev-parse", "HEAD"], { timeoutMs: 8_000 }))?.stdout || "").trim(),
    getGitBranch: async (root) => String((await runGit(["-C", root, "branch", "--show-current"], { timeoutMs: 8_000 }))?.stdout || "").trim(),
    getGitStatus: async (root, relativePath) => String((await runGit(
      ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "--", relativePath],
      { timeoutMs: 8_000 }
    ))?.stdout || "").trim(),
    inspectRuntime: inspectRuntimeOnce,
    inspectChromeProcessCohort,
    prepareProfile: ({ profileId }) => prepareProfile(profileId),
    stopProfile,
    startProfile,
    runtimeConfig: () => runtimeConfig
  };
}
