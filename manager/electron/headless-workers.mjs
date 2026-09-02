import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CODEXPRO_EXTENSION_ID = "gndipignbnipohooclcbhjliikamjlpl";
const PROFILE_COPY_EXCLUDES = new Set([
  "cache", "code cache", "gpucache", "dawncache", "grshadercache", "shadercache",
  "crashpad", "optimization_guide_model_store", "component_crx_cache"
]);

function readJson(filePath, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function safeId(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
}

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extensionStorageProfileId(profilePath) {
  const storageRoot = path.join(profilePath, "Local Extension Settings", CODEXPRO_EXTENSION_ID);
  if (!fs.existsSync(storageRoot)) return "";
  let entries = [];
  try {
    entries = fs.readdirSync(storageRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:log|ldb)$/i.test(entry.name))
      .map((entry) => {
        const filePath = path.join(storageRoot, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch {}
        return { filePath, mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch {
    return "";
  }
  const uuidPattern = /profileId[^0-9a-f]{0,96}["']?([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi;
  for (const entry of entries.slice(0, 8)) {
    try {
      const buffer = fs.readFileSync(entry.filePath);
      const text = buffer.toString("latin1");
      let match;
      let latest = "";
      while ((match = uuidPattern.exec(text))) latest = String(match[1] || "").toLowerCase();
      uuidPattern.lastIndex = 0;
      if (latest) return latest;
    } catch {}
  }
  return "";
}

export function createHeadlessWorkerManager(options = {}) {
  const codexProHome = path.resolve(options.codexProHome || path.join(os.homedir(), ".codexpro"));
  const extensionRoot = path.resolve(options.extensionRoot || "");
  const getBrowserProfiles = typeof options.getBrowserProfiles === "function"
    ? options.getBrowserProfiles
    : async () => [];
  const setSourceProfileLock = typeof options.setSourceProfileLock === "function"
    ? options.setSourceProfileLock
    : async () => ({ ok: true, locked: true });
  const clearSourceProfileLock = typeof options.clearSourceProfileLock === "function"
    ? options.clearSourceProfileLock
    : async () => ({ ok: true, locked: false });
  const stateFile = path.join(codexProHome, "headless-workers.json");
  const workersRoot = path.join(codexProHome, "headless-workers");
  const startingWorkers = new Set();
  const creatingSourceProfiles = new Set();
  let exclusiveEnforcementTail = Promise.resolve();

  function chromeUserDataRoot() {
    if (process.env.CODEXPRO_CHROME_USER_DATA_DIR) return path.resolve(process.env.CODEXPRO_CHROME_USER_DATA_DIR);
    if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
    if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");
    return path.join(os.homedir(), ".config", "google-chrome");
  }

  function chromeExecutableCandidates() {
    if (process.env.CODEXPRO_CHROME_PATH) return [path.resolve(process.env.CODEXPRO_CHROME_PATH)];
    if (process.platform === "darwin") {
      return [
        path.join(codexProHome, "browsers", "chrome-for-testing", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")
      ];
    }
    if (process.platform === "win32") {
      return unique([
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
        process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      ]);
    }
    return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  }

  function chromeExecutable() {
    return chromeExecutableCandidates().find((candidate) => candidate && fs.existsSync(candidate)) || "";
  }

  async function chromeVersion(chromePath) {
    try {
      const { stdout = "", stderr = "" } = await execFileAsync(chromePath, ["--version"], { windowsHide: true, timeout: 5000 });
      return String(stdout || stderr).match(/\d+\.\d+\.\d+\.\d+/)?.[0] || "";
    } catch {
      return "";
    }
  }

  function chromeUserAgent(version) {
    const chromeVersionValue = version || "120.0.0.0";
    if (process.platform === "win32") {
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersionValue} Safari/537.36`;
    }
    if (process.platform === "darwin") {
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersionValue} Safari/537.36`;
    }
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersionValue} Safari/537.36`;
  }

  async function waitForDevToolsPort(userDataDir, timeoutMs = 8000) {
    const filePath = path.join(userDataDir, "DevToolsActivePort");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const [portLine] = (await fs.promises.readFile(filePath, "utf8")).trim().split(/\r?\n/);
        const port = Number(portLine);
        if (Number.isInteger(port) && port > 0 && port < 65536) return port;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error("Chrome headless không mở DevTools endpoint đúng thời gian.");
  }

  async function createDevToolsTarget(port, targetUrl) {
    const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`;
    const response = await fetch(endpoint, { method: "PUT", signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(`Không tạo được headless page target (HTTP ${response.status}).`);
    const payload = await response.json();
    if (payload?.type !== "page" || !payload?.id) throw new Error("Chrome headless không trả về page target hợp lệ.");
    return payload;
  }

  function readState() {
    const value = readJson(stateFile, { version: 1, workers: [] });
    return {
      version: 1,
      workers: Array.isArray(value.workers) ? value.workers.filter((worker) => worker && typeof worker === "object") : []
    };
  }

  function saveState(state) {
    writeJson(stateFile, { version: 1, workers: state.workers });
  }

  function profileRoot(profileDirectory) {
    const root = chromeUserDataRoot();
    const resolved = path.resolve(root, String(profileDirectory || ""));
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Chrome profile không hợp lệ.");
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error("Không tìm thấy thư mục Chrome profile.");
    return resolved;
  }

  function listChromeProfiles() {
    const root = chromeUserDataRoot();
    if (!fs.existsSync(root)) return { root, chromePath: chromeExecutable(), profiles: [] };
    const localState = readJson(path.join(root, "Local State"), {});
    const cache = localState?.profile?.info_cache && typeof localState.profile.info_cache === "object"
      ? localState.profile.info_cache
      : {};
    const known = new Set(Object.keys(cache));
    for (const name of fs.readdirSync(root, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      if (name.name === "Default" || /^Profile \d+$/i.test(name.name)) known.add(name.name);
    }
    const profiles = [...known]
      .filter((profileDirectory) => fs.existsSync(path.join(root, profileDirectory)))
      .map((profileDirectory) => {
        const meta = cache[profileDirectory] || {};
        const profilePath = path.join(root, profileDirectory);
        const preferences = readJson(path.join(profilePath, "Preferences"), {});
        const securePreferences = readJson(path.join(profilePath, "Secure Preferences"), {});
        const extensionSettings = preferences?.extensions?.settings && typeof preferences.extensions.settings === "object"
          ? preferences.extensions.settings
          : {};
        const secureExtensionSettings = securePreferences?.extensions?.settings && typeof securePreferences.extensions.settings === "object"
          ? securePreferences.extensions.settings
          : {};
        const localExtensionState = path.join(profilePath, "Local Extension Settings", CODEXPRO_EXTENSION_ID);
        const codexProInstalled = Boolean(
          extensionSettings[CODEXPRO_EXTENSION_ID]
          || secureExtensionSettings[CODEXPRO_EXTENSION_ID]
          || fs.existsSync(localExtensionState)
        );
        return {
          profileDirectory,
          path: profilePath,
          name: String(meta.name || profileDirectory),
          userName: String(meta.user_name || ""),
          profileId: extensionStorageProfileId(profilePath),
          gaiaName: String(meta.gaia_name || ""),
          avatarIcon: String(meta.avatar_icon || ""),
          isUsingDefaultName: Boolean(meta.is_using_default_name),
          codexProInstalled
        };
      })
      .sort((left, right) => left.profileDirectory === "Default" ? -1 : right.profileDirectory === "Default" ? 1 : left.profileDirectory.localeCompare(right.profileDirectory));
    return { root, chromePath: chromeExecutable(), profiles };
  }

  function workerPayload(worker) {
    const pid = Number(worker.pid) || 0;
    return {
      ...worker,
      pid: processAlive(pid) ? pid : 0,
      running: processAlive(pid),
      userDataDir: path.join(workersRoot, worker.id, "user-data"),
      chromePath: chromeExecutable()
    };
  }

  function sourceProfileMatch(worker, profile) {
    if (!profile || profile.headless === true) return false;
    const exactSourceId = String(worker.sourceProfileId || "").trim();
    if (exactSourceId && String(profile.profile_id || "").trim() === exactSourceId) return true;
    const sourceUserName = String(worker.sourceUserName || "").trim().toLowerCase();
    const profileEmail = String(profile.email || "").trim().toLowerCase();
    return Boolean(sourceUserName && profileEmail && sourceUserName === profileEmail);
  }

  function refreshWorkerSourceProfileId(worker) {
    if (!worker) return "";
    const current = String(worker.sourceProfileId || "").trim();
    if (current) return current;
    const source = listChromeProfiles().profiles.find((profile) => profile.profileDirectory === worker.sourceProfileDirectory);
    const discovered = String(source?.profileId || "").trim();
    if (discovered) worker.sourceProfileId = discovered;
    return discovered;
  }

  function workerOwnsExclusiveSourceSession(worker, now = Date.now()) {
    if (!worker) return false;
    if (processAlive(Number(worker.pid) || 0)) return true;
    const startingAtMs = Date.parse(String(worker.startingAt || ""));
    return Number.isFinite(startingAtMs) && Math.max(0, now - startingAtMs) < 30_000;
  }

  function conflictingRunningWorker(worker, state = readState()) {
    const sourceProfileId = refreshWorkerSourceProfileId(worker);
    return state.workers.find((candidate) => {
      if (!candidate || candidate.id === worker.id || !workerOwnsExclusiveSourceSession(candidate)) return false;
      const candidateSourceId = refreshWorkerSourceProfileId(candidate);
      if (sourceProfileId && candidateSourceId && sourceProfileId === candidateSourceId) return true;
      return Boolean(worker.sourceProfileDirectory && candidate.sourceProfileDirectory === worker.sourceProfileDirectory);
    }) || null;
  }

  function findSourceProfile(worker, profiles) {
    return (Array.isArray(profiles) ? profiles : []).find((profile) => sourceProfileMatch(worker, profile)) || null;
  }

  function profileHasActiveTask(profile) {
    if (!profile) return false;
    if (String(profile.current_task_id || "").trim()) return true;
    if (Math.max(0, Number(profile.busy_request_count) || 0) > 0) return true;
    if (profile.activity === "working" || profile.activity === "settling") return true;
    return (Array.isArray(profile.conversation_tabs) ? profile.conversation_tabs : []).some((tab) =>
      tab?.busy === true || tab?.settling === true || String(tab?.network_state || "") === "generating"
    );
  }

  async function prepareSourceProfileForHeadless(worker, { lockSource = false } = {}) {
    const expectedSourceProfileId = refreshWorkerSourceProfileId(worker);
    let profiles;
    try {
      profiles = await getBrowserProfiles();
    } catch (error) {
      throw new Error(`Không kiểm tra được trạng thái Chrome profile nguồn nên chưa bật headless để đảm bảo an toàn: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sourceProfile = findSourceProfile(worker, profiles);
    if (!sourceProfile) {
      if (!expectedSourceProfileId) {
        throw new Error("Không xác định được profile_id của Chrome profile nguồn nên chưa thể bật headless an toàn. Hãy mở profile nguồn có CodexPro rồi thử lại.");
      }
      return { sourceProfile: null, sourceProfileId: expectedSourceProfileId, locked: false };
    }
    const label = String(sourceProfile.label || sourceProfile.email || worker.sourceProfileName || worker.sourceProfileDirectory || "profile nguồn");
    if (profileHasActiveTask(sourceProfile)) {
      const taskTitle = String(sourceProfile.current_task_title || sourceProfile.current_task_id || "task hiện tại").trim();
      throw new Error(`${label} đang làm ${taskTitle}. Phải chờ task hoàn tất rồi mới được bật headless.`);
    }
    worker.sourceProfileId = String(sourceProfile.profile_id || worker.sourceProfileId || "").trim();
    let locked = false;
    if (lockSource && sourceProfile.connected !== false) {
      const result = await setSourceProfileLock(sourceProfile.profile_id, worker.id || "");
      if (result?.ok === false || result?.locked === false) {
        throw new Error(`Không khóa được ChatGPT trên ${label}; headless chưa được bật.`);
      }
      locked = true;
    }
    return { sourceProfile, sourceProfileId: worker.sourceProfileId, locked };
  }

  function listWorkers() {
    const source = listChromeProfiles();
    const state = readState();
    let dirty = false;
    for (const worker of state.workers) {
      if (!String(worker.sourceProfileId || "").trim() && refreshWorkerSourceProfileId(worker)) dirty = true;
      const legacyDefaultLabel = worker.sourceProfileName ? `Headless · ${worker.sourceProfileName}` : "";
      if (legacyDefaultLabel && worker.label === legacyDefaultLabel) {
        worker.label = worker.sourceProfileName;
        dirty = true;
      }
      if (worker.pid && !processAlive(Number(worker.pid))) {
        worker.pid = 0;
        worker.lastStoppedAt = worker.lastStoppedAt || new Date().toISOString();
        dirty = true;
      }
    }
    if (dirty) saveState(state);
    return {
      supported: Boolean(source.chromePath),
      platform: process.platform,
      chromePath: source.chromePath,
      chromeUserDataRoot: source.root,
      sourceProfiles: source.profiles,
      workers: state.workers.map(workerPayload)
    };
  }

  async function copyProfileSnapshot(worker) {
    const sourceUserDataRoot = chromeUserDataRoot();
    const sourceProfileRoot = profileRoot(worker.sourceProfileDirectory);
    const targetUserDataRoot = path.join(workersRoot, worker.id, "user-data");
    const targetProfileRoot = path.join(targetUserDataRoot, worker.sourceProfileDirectory);
    await fs.promises.rm(targetUserDataRoot, { recursive: true, force: true });
    await fs.promises.mkdir(targetUserDataRoot, { recursive: true });
    const localState = path.join(sourceUserDataRoot, "Local State");
    if (fs.existsSync(localState)) await fs.promises.copyFile(localState, path.join(targetUserDataRoot, "Local State"));
    await fs.promises.cp(sourceProfileRoot, targetProfileRoot, {
      recursive: true,
      force: true,
      dereference: false,
      filter: (source) => {
        const base = path.basename(source).toLowerCase();
        if (PROFILE_COPY_EXCLUDES.has(base)) return false;
        if (/^singleton/i.test(base)) return false;
        return true;
      }
    });
    return {
      sourceProfileRoot,
      targetUserDataRoot,
      warning: fs.existsSync(path.join(sourceUserDataRoot, "SingletonLock"))
        ? "Chrome đang mở trong lúc snapshot. Nếu ChatGPT chưa đăng nhập ở worker, hãy đóng Chrome rồi Sync session lại."
        : ""
    };
  }

  async function stopWorker(workerId, { force = false } = {}) {
    const id = safeId(workerId);
    const state = readState();
    const worker = state.workers.find((item) => item.id === id);
    if (!worker) throw new Error("Không tìm thấy headless worker.");
    const pid = Number(worker.pid) || 0;
    if (processAlive(pid)) {
      if (!force) {
        let profiles;
        try {
          profiles = await getBrowserProfiles();
        } catch (error) {
          throw new Error(`Không kiểm tra được task của headless worker nên chưa dừng để tránh cắt task đang chạy: ${error instanceof Error ? error.message : String(error)}`);
        }
        const headlessProfile = (Array.isArray(profiles) ? profiles : []).find((profile) =>
          profile?.headless === true && String(profile.profile_id || "") === id
        );
        if (!headlessProfile) {
          throw new Error("Headless worker vẫn đang chạy nhưng chưa xác minh được trạng thái task; chưa dừng để tránh cắt task đang làm dở.");
        }
        if (profileHasActiveTask(headlessProfile)) {
          const taskTitle = String(headlessProfile.current_task_title || headlessProfile.current_task_id || "task hiện tại").trim();
          throw new Error(`${worker.label || id} đang làm ${taskTitle}. Phải chờ task hoàn tất rồi mới được dừng, sync hoặc xóa headless.`);
        }
      }
      if (process.platform === "win32") {
        await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
      } else {
        try { process.kill(pid, "SIGTERM"); } catch {}
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (processAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
    }
    worker.pid = 0;
    worker.startingAt = "";
    worker.lastStoppedAt = new Date().toISOString();
    saveState(state);
    const sourceProfileId = String(worker.sourceProfileId || "").trim();
    if (sourceProfileId) await clearSourceProfileLock(sourceProfileId, worker.id).catch(() => {});
    return workerPayload(worker);
  }

  async function syncWorker(workerId) {
    const id = safeId(workerId);
    const state = readState();
    const worker = state.workers.find((item) => item.id === id);
    if (!worker) throw new Error("Không tìm thấy headless worker.");
    const wasRunning = processAlive(Number(worker.pid) || 0);
    if (wasRunning) await stopWorker(id);
    const freshState = readState();
    const freshWorker = freshState.workers.find((item) => item.id === id);
    const result = await copyProfileSnapshot(freshWorker);
    freshWorker.lastSyncedAt = new Date().toISOString();
    freshWorker.lastSyncWarning = result.warning;
    freshWorker.pid = 0;
    saveState(freshState);
    if (wasRunning) await startWorker(id);
    return { ...workerPayload(freshWorker), warning: result.warning };
  }

  async function startWorker(workerId) {
    const id = safeId(workerId);
    if (startingWorkers.has(id)) throw new Error("Headless worker này đang trong quá trình khởi động.");
    startingWorkers.add(id);
    let sourceLockProfileId = "";
    try {
    const state = readState();
    const worker = state.workers.find((item) => item.id === id);
    if (!worker) throw new Error("Không tìm thấy headless worker.");
    if (processAlive(Number(worker.pid) || 0)) return workerPayload(worker);
    const conflict = conflictingRunningWorker(worker, state);
    if (conflict) throw new Error(`Không thể chạy song song hai headless worker cùng profile nguồn. ${conflict.label || conflict.id} đang chạy.`);
    worker.startingAt = new Date().toISOString();
    saveState(state);
    const preparedSource = await prepareSourceProfileForHeadless(worker, { lockSource: true });
    sourceLockProfileId = preparedSource.locked ? String(preparedSource.sourceProfileId || "") : "";
    saveState(state);
    const chromePath = chromeExecutable();
    if (!chromePath) throw new Error("Không tìm thấy Google Chrome. Có thể đặt CODEXPRO_CHROME_PATH để chỉ định file Chrome.");
    if (!worker.sourceHasCodexProExtension) throw new Error("Chrome profile nguồn chưa có CodexPro extension. Hãy bật CodexPro trong profile nguồn rồi Sync session lại.");
    const userDataDir = path.join(workersRoot, worker.id, "user-data");
    if (!fs.existsSync(path.join(userDataDir, worker.sourceProfileDirectory))) {
      const synced = await copyProfileSnapshot(worker);
      worker.lastSyncedAt = new Date().toISOString();
      worker.lastSyncWarning = synced.warning;
    }
    const bootstrap = new URL("http://127.0.0.1:9224/headless-bootstrap");
    bootstrap.searchParams.set("worker_id", worker.id);
    bootstrap.searchParams.set("label", worker.label || worker.sourceProfileName || worker.sourceProfileDirectory || worker.id.slice(-8));
    const version = await chromeVersion(chromePath);
    const userAgent = chromeUserAgent(version);
    await fs.promises.rm(path.join(userDataDir, "DevToolsActivePort"), { force: true }).catch(() => {});
    const args = [
      "--headless=new",
      `--user-agent=${userAgent}`,
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${worker.sourceProfileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--window-size=1280,900",
      "--remote-debugging-port=0"
    ];
    if (fs.existsSync(path.join(extensionRoot, "manifest.json"))) {
      args.push(`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`);
    }
    const child = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    worker.pid = Number(child.pid) || 0;
    worker.lastStartedAt = new Date().toISOString();
    worker.lastError = "";
    saveState(state);
    const debugPort = await waitForDevToolsPort(userDataDir);
    try {
      await prepareSourceProfileForHeadless(worker);
    } catch (error) {
      await stopWorker(id, { force: true }).catch(() => {});
      throw error;
    }
    await createDevToolsTarget(debugPort, bootstrap.toString());
    await new Promise((resolve) => setTimeout(resolve, 500));
    await createDevToolsTarget(debugPort, "https://chatgpt.com/");
    worker.debugPort = debugPort;
    worker.userAgent = userAgent;
    saveState(state);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (!processAlive(worker.pid)) {
      worker.pid = 0;
      worker.lastError = "Chrome headless đã thoát ngay sau khi khởi động.";
      saveState(state);
      throw new Error(worker.lastError);
    }
    worker.startingAt = "";
    saveState(state);
    sourceLockProfileId = "";
    return workerPayload(worker);
    } catch (error) {
      await stopWorker(id, { force: true }).catch(() => {});
      const failedState = readState();
      const failedWorker = failedState.workers.find((item) => item.id === id);
      if (failedWorker?.startingAt) {
        failedWorker.startingAt = "";
        saveState(failedState);
      }
      if (sourceLockProfileId) await clearSourceProfileLock(sourceLockProfileId, id).catch(() => {});
      throw error;
    } finally {
      startingWorkers.delete(id);
    }
  }

  async function enforceExclusiveUseUnlocked(browserProfiles = []) {
    const state = readState();
    const stopped = [];
    const lockedSources = [];
    const deferred = [];
    for (const worker of state.workers) {
      if (!processAlive(Number(worker.pid) || 0)) continue;
      const headlessProfile = (Array.isArray(browserProfiles) ? browserProfiles : []).find((profile) =>
        profile?.headless === true && String(profile.profile_id || "") === worker.id
      );
      const sourceProfileId = String(headlessProfile?.source_profile_id || worker.sourceProfileId || "").trim();
      if (sourceProfileId && sourceProfileId !== worker.sourceProfileId) {
        const latestState = readState();
        const latestWorker = latestState.workers.find((item) => item.id === worker.id);
        if (latestWorker) {
          latestWorker.sourceProfileId = sourceProfileId;
          saveState(latestState);
          worker.sourceProfileId = sourceProfileId;
        }
      }
      const sourceProfile = findSourceProfile(worker, browserProfiles);
      if (!sourceProfile || sourceProfile.connected === false) continue;
      lockedSources.push({ workerId: worker.id, sourceProfileId: String(sourceProfile.profile_id || "") });
      const sourceBusy = profileHasActiveTask(sourceProfile);
      const headlessBusy = profileHasActiveTask(headlessProfile);
      if (sourceBusy && headlessBusy) {
        deferred.push({ workerId: worker.id, sourceProfileId: String(sourceProfile.profile_id || ""), reason: "both_busy" });
        continue;
      }
      if (sourceBusy) {
        await stopWorker(worker.id);
        const latestState = readState();
        const latestWorker = latestState.workers.find((item) => item.id === worker.id);
        if (latestWorker) {
          latestWorker.lastError = `Đã tự dừng headless vì Chrome profile nguồn ${sourceProfile.label || sourceProfile.email || worker.sourceProfileName || worker.sourceProfileDirectory} đã có task trước khi khóa ChatGPT kịp áp dụng.`;
          saveState(latestState);
        }
        stopped.push({ workerId: worker.id, sourceProfileId: String(sourceProfile.profile_id || ""), reason: "source_busy" });
      }
    }
    return { stopped, lockedSources, deferred };
  }

  function enforceExclusiveUse(browserProfiles = []) {
    const snapshot = Array.isArray(browserProfiles) ? browserProfiles.map((profile) => ({ ...profile })) : [];
    const run = exclusiveEnforcementTail.then(
      () => enforceExclusiveUseUnlocked(snapshot),
      () => enforceExclusiveUseUnlocked(snapshot)
    );
    exclusiveEnforcementTail = run.catch(() => {});
    return run;
  }

  async function createWorker(payload = {}) {
    const sourceProfileDirectory = String(payload.sourceProfileDirectory || "").trim();
    if (creatingSourceProfiles.has(sourceProfileDirectory)) throw new Error("Profile nguồn này đang được tạo headless worker.");
    creatingSourceProfiles.add(sourceProfileDirectory);
    try {
    const source = listChromeProfiles().profiles.find((profile) => profile.profileDirectory === sourceProfileDirectory);
    if (!source) throw new Error("Chrome profile nguồn không tồn tại.");
    if (!source.codexProInstalled) throw new Error("Chrome profile nguồn chưa có CodexPro extension. Hãy bật CodexPro trong profile này trước khi tạo headless worker.");
    const existing = readState().workers.find((worker) => worker.sourceProfileDirectory === sourceProfileDirectory);
    if (existing) throw new Error(`Profile nguồn này đã có headless worker ${existing.label || existing.id}. Mỗi profile chỉ được có một headless worker.`);
    const autoStart = payload.autoStart !== false;
    const id = `headless-${randomBytes(6).toString("hex")}`;
    const preflightWorker = {
      id,
      sourceProfileDirectory,
      sourceProfileName: source.name,
      sourceUserName: source.userName,
      sourceProfileId: source.profileId || ""
    };
    if (autoStart) await prepareSourceProfileForHeadless(preflightWorker);
    const state = readState();
    const worker = {
      id,
      label: String(payload.label || source.name || source.userName || source.profileDirectory).trim().slice(0, 100),
      sourceProfileDirectory,
      sourceProfileName: source.name,
      sourceUserName: source.userName,
      sourceProfileId: preflightWorker.sourceProfileId,
      sourceHasCodexProExtension: source.codexProInstalled,
      autoStart,
      pid: 0,
      createdAt: new Date().toISOString(),
      lastSyncedAt: "",
      lastStartedAt: "",
      lastStoppedAt: "",
      lastSyncWarning: "",
      lastError: ""
    };
    state.workers.push(worker);
    saveState(state);
    await syncWorker(id);
    if (worker.autoStart) await startWorker(id);
    return workerPayload(readState().workers.find((item) => item.id === id));
    } finally {
      creatingSourceProfiles.delete(sourceProfileDirectory);
    }
  }

  async function assertProfileTaskExclusive(profileId) {
    const id = String(profileId || "").trim();
    if (!id) return { ok: true };
    const state = readState();
    for (const worker of state.workers) refreshWorkerSourceProfileId(worker);
    const running = state.workers.filter((worker) => workerOwnsExclusiveSourceSession(worker));
    const sourceLockedBy = running.find((worker) => String(worker.sourceProfileId || "").trim() === id);
    if (sourceLockedBy) {
      throw new Error(`Chrome vẫn dùng bình thường, nhưng ChatGPT và task CodexPro trên profile nguồn đang bị khóa vì headless ${sourceLockedBy.label || sourceLockedBy.id} đang chạy. Hãy dừng headless trước khi dùng ChatGPT.`);
    }
    const targetHeadless = running.find((worker) => worker.id === id);
    if (!targetHeadless) return { ok: true };
    const profiles = await getBrowserProfiles();
    const sourceProfile = findSourceProfile(targetHeadless, profiles);
    if (!sourceProfile || sourceProfile.connected === false) return { ok: true };
    if (profileHasActiveTask(sourceProfile)) {
      throw new Error(`${sourceProfile.label || targetHeadless.sourceProfileName || "Chrome profile nguồn"} đang có task; chưa được phép giao task cho headless.`);
    }
    return { ok: true, sourceProfileId: sourceProfile.profile_id };
  }

  async function deleteWorker(workerId) {
    const id = safeId(workerId);
    const state = readState();
    const worker = state.workers.find((item) => item.id === id);
    if (!worker) return { ok: true, removed: false };
    await stopWorker(id);
    const next = readState();
    next.workers = next.workers.filter((item) => item.id !== id);
    saveState(next);
    fs.rmSync(path.join(workersRoot, id), { recursive: true, force: true });
    await fetch(`http://127.0.0.1:9224/headless-profile/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(3000)
    }).catch(() => {});
    return { ok: true, removed: true, id };
  }

  async function setWorkerAutoStart(workerId, autoStart) {
    const id = safeId(workerId);
    const state = readState();
    const worker = state.workers.find((item) => item.id === id);
    if (!worker) throw new Error("Không tìm thấy headless worker.");
    worker.autoStart = Boolean(autoStart);
    saveState(state);
    return workerPayload(worker);
  }

  async function startAutoWorkers() {
    const state = readState();
    for (const worker of state.workers.filter((item) => item.autoStart)) {
      await startWorker(worker.id).catch((error) => {
        const fresh = readState();
        const target = fresh.workers.find((item) => item.id === worker.id);
        if (target) {
          target.lastError = error instanceof Error ? error.message : String(error);
          saveState(fresh);
        }
      });
    }
    return listWorkers();
  }

  return {
    listChromeProfiles,
    listWorkers,
    createWorker,
    syncWorker,
    startWorker,
    enforceExclusiveUse,
    assertProfileTaskExclusive,
    stopWorker,
    deleteWorker,
    setWorkerAutoStart,
    startAutoWorkers
  };
}
