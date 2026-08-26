import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const codexProHome = process.env.CODEXPRO_HOME
  ? path.resolve(process.env.CODEXPRO_HOME)
  : path.join(os.homedir(), ".codexpro");
const tokenFileDefault = path.join(codexProHome, "http-token");
const managerProjectsFile = path.join(codexProHome, "manager-projects.json");
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const platformLabel = isWindows ? "Windows" : isMac ? "macOS" : process.platform;

function createWindow() {
  const smokeMode = process.env.CODEXPRO_MANAGER_SMOKE === "1";
  const win = new BrowserWindow({
    width: smokeMode ? 1900 : 1240,
    height: smokeMode ? 1000 : 820,
    minWidth: 940,
    minHeight: 650,
    backgroundColor: "#090b10",
    title: "CodexPro Manager",
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.CODEXPRO_MANAGER_DEV_URL;
    if (allowed ? !url.startsWith(allowed) : !url.startsWith("file:")) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.once("ready-to-show", () => {
    if (!smokeMode) win.show();
  });
  const devUrl = process.env.CODEXPRO_MANAGER_DEV_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(here, "..", "dist", "index.html"));

  if (smokeMode) {
    win.webContents.once("did-finish-load", async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 2800));
        const bridge = await win.webContents.executeJavaScript("typeof window.codexpro", true);
        if (bridge !== "object") throw new Error(`Preload bridge unavailable: ${bridge}`);
        const status = await win.webContents.executeJavaScript("window.codexpro.getStatus().then((value) => JSON.parse(JSON.stringify(value)))", true);
        const projects = await win.webContents.executeJavaScript("window.codexpro.listProjects().then((value) => JSON.parse(JSON.stringify(value)))", true);
        let inspection = null;
        if (status.local?.ok && projects[0]?.root) {
          inspection = await win.webContents.executeJavaScript(`window.codexpro.inspectProject(${JSON.stringify(projects[0].root)})`, true);
        }
        const image = await win.webContents.capturePage();
        const screenshot = process.env.CODEXPRO_MANAGER_SMOKE_SCREENSHOT;
        if (screenshot) fs.writeFileSync(screenshot, image.toPNG());
        console.log(JSON.stringify({ ok: true, status, projectCount: projects.length, inspection: inspection ? { workspace_id: inspection.workspace_id, root: inspection.root } : null }));
      } catch (error) {
        console.error(error instanceof Error ? error.stack || error.message : String(error));
        process.exitCode = 1;
      } finally {
        app.quit();
      }
    });
  }
}

async function runPowerShell(script) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
  );
  return stdout.trim();
}

function parseTaskArguments(args = "") {
  const value = String(args);
  const read = (name) => {
    const match = value.match(new RegExp(`--${name}\\s+(?:\"([^\"]+)\"|'([^']+)'|([^\\s]+))`, "i"));
    return match?.[1] || match?.[2] || match?.[3] || "";
  };
  return {
    root: read("root"),
    port: Number(read("port")) || 8793,
    hostname: read("hostname"),
    tokenFile: read("token-file") || tokenFileDefault,
    tunnel: read("tunnel") || "none"
  };
}

async function windowsScheduledTask() {
  const script = [
    "$t=Get-ScheduledTask -TaskName 'CodexPro' -ErrorAction Stop",
    "$i=Get-ScheduledTaskInfo -TaskName 'CodexPro'",
    "$a=$t.Actions | Select-Object -First 1",
    "$auto=(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'CodexPro Manager' -ErrorAction SilentlyContinue).'CodexPro Manager'",
    "$tr=@($t.Triggers | ForEach-Object { [pscustomobject]@{ type=$_.CimClass.CimClassName; id=$_.Id; interval=$_.Repetition.Interval; delay=$_.Delay } })",
    "[pscustomobject]@{ state=[string]$t.State; lastRunTime=if($i.LastRunTime){$i.LastRunTime.ToString('o')}else{$null}; lastTaskResult=$i.LastTaskResult; execute=$a.Execute; arguments=$a.Arguments; workingDirectory=$a.WorkingDirectory; triggers=$tr; autoStartCommand=$auto } | ConvertTo-Json -Depth 5 -Compress"
  ].join("; ");
  try {
    return JSON.parse(await runPowerShell(script));
  } catch (error) {
    return { state: "NotFound", error: error instanceof Error ? error.message : String(error), arguments: "" };
  }
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

function recordsIn(dir) {
  return jsonFiles(dir)
    .map((file) => ({ file, value: readJson(file) }))
    .filter((item) => item.value && typeof item.value === "object")
    .sort((a, b) => String(b.value.updatedAt || "").localeCompare(String(a.value.updatedAt || "")));
}

function profileForRoot(root) {
  const profiles = recordsIn(path.join(codexProHome, "profiles"));
  if (root) {
    const resolved = path.resolve(root);
    const match = profiles.find((item) => typeof item.value.root === "string" && path.resolve(item.value.root) === resolved);
    if (match) return { ...match.value, profileFile: match.file };
  }
  const latest = profiles[0];
  return latest ? { ...latest.value, profileFile: latest.file } : null;
}

function currentRuntime() {
  const runtimes = recordsIn(path.join(codexProHome, "runtime"));
  const active = runtimes.find((item) => processAlive(item.value.pid));
  const selected = active || runtimes[0];
  return selected ? { ...selected.value, runtimeFile: selected.file, active: Boolean(active && active.file === selected.file) } : null;
}

async function portableServiceStatus() {
  const runtime = currentRuntime();
  const profile = profileForRoot(runtime?.root);
  const root = runtime?.root || profile?.root || managerProjects()[0] || "";
  return {
    state: runtime?.active ? "Running" : root ? "Stopped" : "NotConfigured",
    lastRunTime: runtime?.updatedAt || profile?.updatedAt || null,
    lastTaskResult: runtime?.active ? 0 : null,
    execute: "codexpro",
    arguments: "",
    workingDirectory: root,
    triggers: [],
    autoStartCommand: null,
    root,
    platform: platformLabel
  };
}

async function scheduledTask() {
  return isWindows ? windowsScheduledTask() : portableServiceStatus();
}

function readToken(tokenFile) {
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

async function health(base, token) {
  if (!base) return { ok: false, status: 0, latency: 0, error: "Chưa có endpoint" };
  const started = Date.now();
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/healthz`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5500)
    });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok && body.ok === true,
      status: response.status,
      latency: Date.now() - started,
      data: body
    };
  } catch (error) {
    return { ok: false, status: 0, latency: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

function connectorLink(config, token) {
  if (!config.hostname || !token) return "";
  const base = config.hostname.includes("://") ? config.hostname : `https://${config.hostname}`;
  const url = new URL(base);
  url.pathname = "/mcp";
  url.search = "";
  url.searchParams.set("codexpro_token", token);
  return url.toString();
}

function connectorLinkFromEndpoint(endpoint, token) {
  if (!endpoint) return "";
  const url = new URL(endpoint);
  url.pathname = "/mcp";
  url.search = "";
  if (token) url.searchParams.set("codexpro_token", token);
  return url.toString();
}

function portFromRuntime(runtime) {
  try {
    if (runtime?.localBase) return Number(new URL(runtime.localBase).port) || 8787;
  } catch {}
  return 8787;
}

function publicBaseFromEndpoint(endpoint) {
  try {
    const url = new URL(endpoint || "");
    return url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

async function processCommandForPid(pid) {
  if (!processAlive(pid)) return "";
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-ww", "-o", "command="], { maxBuffer: 2 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
}

function stripShellQuotes(value) {
  const text = String(value || "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}

function processOption(command, name) {
  const match = String(command || "").match(new RegExp(`--${name}\\s+(.+?)(?=\\s+--[a-z][a-z0-9-]*(?:\\s|$)|$)`, "i"));
  return stripShellQuotes(match?.[1] || "");
}

function processOptions(command, name) {
  const regex = new RegExp(`--${name}\\s+(.+?)(?=\\s+--[a-z][a-z0-9-]*(?:\\s|$)|$)`, "ig");
  const values = [];
  for (const match of String(command || "").matchAll(regex)) values.push(stripShellQuotes(match[1] || ""));
  return values.filter(Boolean);
}

function hasProcessFlag(command, name) {
  return new RegExp(`(?:^|\\s)--${name}(?=\\s|$)`, "i").test(String(command || ""));
}

function runtimeLaunchArgs(command, fallbackRoot) {
  if (!command) return ["start", "--root", fallbackRoot, "--headless"];
  const root = processOption(command, "root") || fallbackRoot;
  const args = ["start", "--root", root];
  for (const allowedRoot of processOptions(command, "allow-root")) args.push("--allow-root", allowedRoot);
  for (const name of ["host", "port", "tunnel", "hostname", "cloudflare-token-file", "token-file", "cloudflared", "bash", "write", "tool-mode", "bash-transcript", "codex-sessions", "bash-session", "tool-cards"]) {
    const value = processOption(command, name);
    if (value) args.push(`--${name}`, value);
  }
  for (const flag of ["headless", "no-profile", "no-copy-url", "require-bash-session"]) {
    if (hasProcessFlag(command, flag)) args.push(`--${flag}`);
  }
  if (!hasProcessFlag(command, "headless")) args.push("--headless");
  return args;
}

async function runtimeStatus() {
  const task = await scheduledTask();
  if (!isWindows) {
    const runtime = currentRuntime();
    const processCommand = await processCommandForPid(runtime?.pid);
    const profile = profileForRoot(runtime?.root || task.root);
    const root = processOption(processCommand, "root") || runtime?.root || profile?.root || task.root || managerProjects()[0] || "";
    const port = Number(processOption(processCommand, "port")) || Number(profile?.port) || portFromRuntime(runtime);
    const configuredTokenFile = processOption(processCommand, "token-file") || profile?.tokenFile || "";
    const resolvedTokenFile = configuredTokenFile
      ? (path.isAbsolute(configuredTokenFile) ? configuredTokenFile : path.resolve(root || os.homedir(), configuredTokenFile))
      : tokenFileDefault;
    const token = configuredTokenFile ? readToken(resolvedTokenFile) : typeof profile?.token === "string" && profile.token ? profile.token : readToken(resolvedTokenFile);
    const localBase = runtime?.localBase || `http://127.0.0.1:${port}`;
    const endpoint = runtime?.endpoint || "";
    const hostname = processOption(processCommand, "hostname") || profile?.hostname || publicBaseFromEndpoint(endpoint);
    const publicBase = publicBaseFromEndpoint(endpoint) || (hostname ? (hostname.includes("://") ? hostname : `https://${hostname}`).replace(/\/mcp\/?$/, "") : "");
    const [local, tunnel] = await Promise.all([
      health(localBase, token),
      publicBase ? health(publicBase, token) : Promise.resolve({ ok: false, status: 0, latency: 0, error: "Không dùng public tunnel" })
    ]);
    const processCandidates = [
      { pid: runtime?.pid, name: "codexpro" },
      { pid: runtime?.runtimePid, name: "node" },
      { pid: runtime?.tunnelPid, name: "cloudflared" }
    ].filter((item) => processAlive(item.pid));
    const config = {
      root,
      port,
      hostname,
      tokenFile: resolvedTokenFile,
      tunnel: processOption(processCommand, "tunnel") || runtime?.tunnel || profile?.tunnel || "none"
    };
    return {
      checkedAt: new Date().toISOString(),
      platform: platformLabel,
      task,
      config,
      local,
      tunnel,
      processes: processCandidates.map((item) => ({ pid: Number(item.pid), name: item.name })),
      mcpLink: endpoint ? connectorLinkFromEndpoint(endpoint, token) : connectorLink(config, token),
      tokenConfigured: Boolean(token),
      autoStart: app.getLoginItemSettings().openAtLogin
    };
  }
  const config = parseTaskArguments(task.arguments);
  const token = readToken(config.tokenFile);
  const localBase = `http://127.0.0.1:${config.port}`;
  const publicBase = config.hostname
    ? (config.hostname.includes("://") ? config.hostname : `https://${config.hostname}`).replace(/\/mcp\/?$/, "")
    : "";
  const [local, tunnel, processText] = await Promise.all([
    health(localBase, token),
    publicBase ? health(publicBase, token) : Promise.resolve({ ok: false, status: 0, latency: 0, error: "Không dùng public tunnel" }),
    runPowerShell("@((Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','cloudflared.exe') -and $_.CommandLine -match 'codexpro\\.mjs.*start|dist\\\\http\\.js|cloudflared.*codexpro' } | Select-Object ProcessId,Name,CommandLine)) | ConvertTo-Json -Depth 3 -Compress").catch(() => "[]")
  ]);
  let processes = [];
  try {
    const parsed = JSON.parse(processText || "[]");
    processes = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    processes = [];
  }
  return {
    checkedAt: new Date().toISOString(),
    task,
    config,
    local,
    tunnel,
    processes: processes.map((item) => ({ pid: item.ProcessId, name: item.Name })),
    mcpLink: connectorLink(config, token),
    tokenConfigured: Boolean(token),
    autoStart: Boolean(task.autoStartCommand)
  };
}

function jsonFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function managerProjects() {
  const value = readJson(managerProjectsFile);
  return Array.isArray(value?.roots) ? value.roots.filter((root) => typeof root === "string") : [];
}

function saveManagerProjects(roots) {
  fs.mkdirSync(codexProHome, { recursive: true });
  fs.writeFileSync(managerProjectsFile, `${JSON.stringify({ version: 1, roots }, null, 2)}\n`, { mode: 0o600 });
}

async function gitSummary(root) {
  try {
    const git = isWindows ? "git.exe" : "git";
    const { stdout: branchText } = await execFileAsync(git, ["-C", root, "branch", "--show-current"], { windowsHide: true });
    const { stdout: statusText } = await execFileAsync(git, ["-C", root, "status", "--porcelain"], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const { stdout: commitText } = await execFileAsync(git, ["-C", root, "log", "-1", "--pretty=format:%h%x09%s%x09%cI"], { windowsHide: true });
    const [hash = "", subject = "", date = ""] = commitText.trim().split("\t");
    return {
      isGit: true,
      branch: branchText.trim() || "detached",
      changes: statusText.split(/\r?\n/).filter(Boolean).length,
      commit: { hash, subject, date }
    };
  } catch {
    return { isGit: false, branch: "", changes: 0, commit: null };
  }
}

async function listProjects() {
  const task = await scheduledTask();
  const activeRoot = task.root || parseTaskArguments(task.arguments).root;
  const sources = new Map();
  for (const file of jsonFiles(path.join(codexProHome, "profiles"))) {
    const profile = readJson(file);
    if (typeof profile?.root === "string") sources.set(path.resolve(profile.root), "CodexPro profile");
  }
  for (const file of jsonFiles(path.join(codexProHome, "runtime"))) {
    const runtime = readJson(file);
    if (typeof runtime?.root === "string") sources.set(path.resolve(runtime.root), "CodexPro runtime");
  }
  for (const root of managerProjects()) sources.set(path.resolve(root), sources.get(path.resolve(root)) || "Đã thêm");
  if (activeRoot) sources.set(path.resolve(activeRoot), "Đang chạy");

  const projects = [];
  for (const [root, source] of sources) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    projects.push({
      root,
      name: path.basename(root),
      source,
      active: Boolean(activeRoot && path.resolve(activeRoot).toLowerCase() === root.toLowerCase()),
      ...(await gitSummary(root))
    });
  }
  return projects.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

async function mcpRequest(url, token, body, sessionId) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const text = await response.text();
  if (!text.trim()) return { payload: {}, sessionId: response.headers.get("mcp-session-id") || sessionId };
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
  const payload = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
  if (payload.error) throw new Error(payload.error.message || "MCP trả về lỗi");
  return { payload, sessionId: response.headers.get("mcp-session-id") || sessionId };
}

async function inspectThroughMcp(root) {
  const status = await runtimeStatus();
  if (!status.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  const profile = profileForRoot(status.config.root);
  const fileToken = readToken(status.config.tokenFile);
  const token = fileToken || (typeof profile?.token === "string" && profile.token ? profile.token : "");
  const url = `http://127.0.0.1:${status.config.port}/mcp`;
  const initialized = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "CodexPro Manager", version: "0.1.0" } }
  });
  const sessionId = initialized.sessionId;
  await mcpRequest(url, token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  const opened = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "open_workspace", arguments: { root } }
  }, sessionId);
  const workspaceId = opened.payload.result?.structuredContent?.workspace_id;
  const snapshot = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "workspace_snapshot", arguments: { workspace_id: workspaceId, max_depth: 2, max_files: 300 } }
  }, sessionId);
  return snapshot.payload.result?.structuredContent || opened.payload.result?.structuredContent || {};
}

async function controlServer(action) {
  if (!["start", "restart"].includes(action)) throw new Error("Thao tác server không hợp lệ.");
  if (!isWindows) {
    const runtime = currentRuntime();
    const processCommand = await processCommandForPid(runtime?.pid);
    const profile = profileForRoot(runtime?.root);
    const root = processOption(processCommand, "root") || runtime?.root || profile?.root || managerProjects()[0] || "";
    if (!root) throw new Error("Chưa có workspace CodexPro. Hãy chạy codexpro setup hoặc thêm một dự án trước.");
    if (action === "start" && runtime?.active) return runtimeStatus();
    if (action === "restart" && processAlive(runtime?.pid)) {
      try { process.kill(Number(runtime.pid), "SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1400));
    }
    const { stdout } = await execFileAsync("/bin/zsh", ["-lc", "command -v codexpro"], { maxBuffer: 1024 * 1024 });
    const cli = stdout.trim();
    if (!cli) throw new Error("Không tìm thấy lệnh codexpro. Hãy cài CodexPro CLI trước.");
    const child = spawn(cli, runtimeLaunchArgs(processCommand, root), {
      cwd: root,
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return runtimeStatus();
  }
  if (action === "restart") {
    await runPowerShell("Stop-ScheduledTask -TaskName 'CodexPro' -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; Start-ScheduledTask -TaskName 'CodexPro' -ErrorAction Stop");
  } else {
    await runPowerShell("Start-ScheduledTask -TaskName 'CodexPro' -ErrorAction Stop");
  }
  await new Promise((resolve) => setTimeout(resolve, 2400));
  return runtimeStatus();
}

ipcMain.handle("codexpro:status", () => runtimeStatus());
ipcMain.handle("codexpro:control", (_event, action) => controlServer(action));
ipcMain.handle("codexpro:copy", (_event, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});
ipcMain.handle("codexpro:rotate-link", async () => {
  const choice = await dialog.showMessageBox({
    type: "warning",
    title: "Tạo link MCP mới",
    message: "Token cũ sẽ hết hiệu lực",
    detail: "CodexPro sẽ đổi token và restart. Các kết nối ChatGPT cũ phải được cập nhật bằng link mới.",
    buttons: ["Hủy", "Tạo link mới"],
    defaultId: 0,
    cancelId: 0
  });
  if (choice.response !== 1) return { cancelled: true };
  const task = await scheduledTask();
  const config = parseTaskArguments(task.arguments);
  const token = randomBytes(32).toString("hex");
  if (isWindows) {
    fs.mkdirSync(path.dirname(config.tokenFile), { recursive: true });
    fs.writeFileSync(config.tokenFile, `${token}\n`, { mode: 0o600 });
  } else {
    const runtime = currentRuntime();
    const processCommand = await processCommandForPid(runtime?.pid);
    const activeTokenFile = processOption(processCommand, "token-file");
    if (activeTokenFile) {
      const resolved = path.isAbsolute(activeTokenFile) ? activeTokenFile : path.resolve(runtime?.root || os.homedir(), activeTokenFile);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, `${token}\n`, { mode: 0o600 });
      try { fs.chmodSync(resolved, 0o600); } catch {}
    } else {
      const profile = profileForRoot(runtime?.root || task.root);
      if (!profile?.profileFile) throw new Error("Không tìm thấy profile CodexPro để cập nhật token.");
      const saved = readJson(profile.profileFile) || {};
      fs.writeFileSync(profile.profileFile, `${JSON.stringify({ ...saved, token, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      try { fs.chmodSync(profile.profileFile, 0o600); } catch {}
    }
  }
  await controlServer("restart");
  return { cancelled: false, ...(await runtimeStatus()) };
});
ipcMain.handle("codexpro:projects", () => listProjects());
ipcMain.handle("codexpro:choose-project", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Chọn repo hoặc dự án" });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("codexpro:add-project", async (_event, root) => {
  const resolved = path.resolve(String(root || ""));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error("Thư mục dự án không tồn tại.");
  const roots = [...new Set([...managerProjects(), resolved])];
  saveManagerProjects(roots);
  return listProjects();
});
ipcMain.handle("codexpro:remove-project", async (_event, root) => {
  const target = path.resolve(String(root || "")).toLowerCase();
  saveManagerProjects(managerProjects().filter((item) => path.resolve(item).toLowerCase() !== target));
  return listProjects();
});
ipcMain.handle("codexpro:inspect-project", (_event, root) => inspectThroughMcp(path.resolve(String(root || ""))));
ipcMain.handle("codexpro:open-folder", async (_event, root) => {
  const error = await shell.openPath(path.resolve(String(root || "")));
  if (error) throw new Error(error);
  return true;
});
ipcMain.handle("codexpro:open-external", async (_event, url) => {
  const parsed = new URL(String(url));
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Chỉ cho phép liên kết HTTP(S).");
  await shell.openExternal(parsed.toString());
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
