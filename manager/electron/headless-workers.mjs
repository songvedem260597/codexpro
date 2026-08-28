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

export function createHeadlessWorkerManager(options = {}) {
  const codexProHome = path.resolve(options.codexProHome || path.join(os.homedir(), ".codexpro"));
  const extensionRoot = path.resolve(options.extensionRoot || "");
  const stateFile = path.join(codexProHome, "headless-workers.json");
  const workersRoot = path.join(codexProHome, "headless-workers");

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
        const extensionSettings = preferences?.extensions?.settings && typeof preferences.extensions.settings === "object"
          ? preferences.extensions.settings
          : {};
        return {
          profileDirectory,
          path: profilePath,
          name: String(meta.name || profileDirectory),
          userName: String(meta.user_name || ""),
          gaiaName: String(meta.gaia_name || ""),
          avatarIcon: String(meta.avatar_icon || ""),
          isUsingDefaultName: Boolean(meta.is_using_default_name),
          codexProInstalled: Boolean(extensionSettings[CODEXPRO_EXTENSION_ID])
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

  function listWorkers() {
    const source = listChromeProfiles();
    const state = readState();
    let dirty = false;
    for (const worker of state.workers) {
      if (worker.pid && !processAlive(Number(worker.pid))) {
        worker.pid = 0;
        worker.lastStoppedAt = worker.lastStoppedAt || new Date().toISOString();
        dirty = true;
      }
    }
    if (dirty) saveState(state);
    return {
      supported: Boolean(source.chromePath && extensionRoot && fs.existsSync(extensionRoot)),
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
    const targetProfileRoot = path.join(targetUserDataRoot, "Default");
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
    const preferencesPath = path.join(targetProfileRoot, "Preferences");
    const preferences = readJson(preferencesPath, {});
    if (preferences && typeof preferences === "object") {
      preferences.profile = { ...(preferences.profile || {}), name: worker.label || preferences.profile?.name || "CodexPro Headless" };
      writeJson(preferencesPath, preferences);
    }
    return {
      sourceProfileRoot,
      targetUserDataRoot,
      warning: fs.existsSync(path.join(sourceUserDataRoot, "SingletonLock"))
        ? "Chrome đang mở trong lúc snapshot. Nếu ChatGPT chưa đăng nhập ở worker, hãy đóng Chrome rồi Sync session lại."
        : ""
    };
  }

  async function stopWorker(workerId) {
    const id = safeId(workerId);
    const state = readState();
    const worker = state.workers.find((item) => item.id === id);
    if (!worker) throw new Error("Không tìm thấy headless worker.");
    const pid = Number(worker.pid) || 0;
    if (processAlive(pid)) {
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
    worker.lastStoppedAt = new Date().toISOString();
    saveState(state);
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
    const state = readState();
    const worker = state.workers.find((item) => item.id === id);
    if (!worker) throw new Error("Không tìm thấy headless worker.");
    if (processAlive(Number(worker.pid) || 0)) return workerPayload(worker);
    const chromePath = chromeExecutable();
    if (!chromePath) throw new Error("Không tìm thấy Google Chrome. Có thể đặt CODEXPRO_CHROME_PATH để chỉ định file Chrome.");
    if (!extensionRoot || !fs.existsSync(extensionRoot)) throw new Error("Không tìm thấy CodexPro Chrome extension để chạy headless.");
    const userDataDir = path.join(workersRoot, worker.id, "user-data");
    if (!fs.existsSync(path.join(userDataDir, "Default"))) {
      const synced = await copyProfileSnapshot(worker);
      worker.lastSyncedAt = new Date().toISOString();
      worker.lastSyncWarning = synced.warning;
    }
    const bootstrap = new URL("http://127.0.0.1:9224/headless-bootstrap");
    bootstrap.searchParams.set("worker_id", worker.id);
    bootstrap.searchParams.set("label", worker.label || `Headless ${worker.id.slice(-8)}`);
    const args = [
      "--headless=new",
      `--user-data-dir=${userDataDir}`,
      "--profile-directory=Default",
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--window-size=1280,900",
      "--remote-debugging-port=0",
      bootstrap.toString(),
      "https://chatgpt.com/"
    ];
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
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (!processAlive(worker.pid)) {
      worker.pid = 0;
      worker.lastError = "Chrome headless đã thoát ngay sau khi khởi động.";
      saveState(state);
      throw new Error(worker.lastError);
    }
    return workerPayload(worker);
  }

  async function createWorker(payload = {}) {
    const sourceProfileDirectory = String(payload.sourceProfileDirectory || "").trim();
    const source = listChromeProfiles().profiles.find((profile) => profile.profileDirectory === sourceProfileDirectory);
    if (!source) throw new Error("Chrome profile nguồn không tồn tại.");
    const state = readState();
    const id = `headless-${randomBytes(6).toString("hex")}`;
    const worker = {
      id,
      label: String(payload.label || `Headless · ${source.name}`).trim().slice(0, 100),
      sourceProfileDirectory,
      sourceProfileName: source.name,
      sourceUserName: source.userName,
      autoStart: payload.autoStart !== false,
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
    stopWorker,
    deleteWorker,
    setWorkerAutoStart,
    startAutoWorkers
  };
}
