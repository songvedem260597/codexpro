#!/usr/bin/env node
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendDiagnosticLog, clearDiagnosticLogs, pruneDiagnosticLogs, readDiagnosticLogs } from "../manager/electron/diagnostic-log.mjs";
import { createMcpCausalTelemetry } from "../manager/electron/mcp-causal-telemetry.mjs";
import { createSendTraceLogger, readSendTraceTimeline } from "../manager/electron/send-trace-log.mjs";
import { readManagerHangWatchDiagnostics } from "../manager/electron/manager-hang-watch-diagnostics.mjs";
import { collectOperationsPerformance } from "../manager/electron/operations-metrics.mjs";
import { WorkerPluginRegistry } from "../manager/electron/worker-core/plugin-registry.mjs";
import { createApiWorkerStore } from "../manager/electron/worker-core/api-worker-store.mjs";
import { createApiWorkerChatHistoryStore } from "../manager/electron/worker-core/api-worker-chat-history.mjs";
import { discoverApiWorkerModels } from "../manager/electron/worker-core/api-worker-model-discovery.mjs";
import { createWorkerMcpClients } from "../manager/electron/mcp/http-client.mjs";
import { createManagerMcpClient } from "../manager/electron/mcp/manager-mcp-client.mjs";
import { create9RouterProvider, createOpenAICompatibleProvider, createOpenRouterProvider } from "../manager/electron/provider-core/openai-compatible-provider.mjs";
import { createApiWorkerPlugin } from "../manager/electron/worker-plugins/api-worker-plugin.mjs";
import { createProjectDiscovery } from "../manager/electron/project-discovery.mjs";
import { ALL_ALLOWED_WORKSPACES, createManagerSettingsStore } from "../manager/electron/manager-settings-store.mjs";
import { createManagerChatCache } from "../manager/electron/manager-chat-cache.mjs";
import { createAppPluginRegistry } from "../manager/electron/app-plugins/app-plugin-registry.mjs";
import { createManagedAppPluginInstaller } from "../manager/electron/app-plugins/managed-app-plugin-installer.mjs";
import { buildGitDiagramArchitecture } from "../manager/electron/app-plugins/gitdiagram-analyzer.mjs";
import { createPluginSkillBundle } from "../manager/electron/app-plugins/plugin-skill-bundle.mjs";
import {
  materializeApiWorkerRequest,
  MAX_REQUEST_ATTACHMENT_BYTES,
  MAX_REQUEST_ATTACHMENTS,
  MAX_REQUEST_ATTACHMENTS_TOTAL_BYTES,
  mimeTypeForFile,
  requestFilePreview,
  requestFileSummary
} from "../manager/electron/request-attachments.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "manager", "dist");

const WEB_PORT = Number(process.env.PORT || process.env.CODEXPRO_WEB_PORT || 8080);
const WEB_HOST = String(process.env.HOST || process.env.CODEXPRO_WEB_HOST || "0.0.0.0").trim();
const MCP_PORT = Number(process.env.CODEXPRO_MCP_PORT || 43115);
const MAX_API_WORKERS = Math.max(1, Math.min(16, Number(process.env.CODEXPRO_MAX_API_WORKERS || 4)));
const PUBLIC_URL = String(process.env.CODEXPRO_PUBLIC_URL || "").trim().replace(/\/$/, "");
const WEB_PASSWORD = String(process.env.CODEXPRO_WEB_PASSWORD || "").trim();

function resolveDefaultHome() {
  if (process.env.CODEXPRO_HOME) return path.resolve(process.env.CODEXPRO_HOME);
  if (process.platform !== "win32" && fs.existsSync("/data")) {
    return path.resolve("/data/.codexpro");
  }
  return path.join(os.homedir(), ".codexpro");
}

const codexProHome = resolveDefaultHome();
const workspacesRoot = path.join(codexProHome, "workspaces");
const uploadsRoot = path.join(codexProHome, "web-uploads");
fs.mkdirSync(codexProHome, { recursive: true });
fs.mkdirSync(workspacesRoot, { recursive: true });
fs.mkdirSync(uploadsRoot, { recursive: true });

const MANAGER_VERSION = "0.2.145-web";
const MANAGER_RUN_ID = `web_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;

function createHeadlessSafeStorage(homeDir) {
  const keyFile = path.join(homeDir, ".web-secret-key");
  function getKey() {
    const envSecret = String(process.env.CODEXPRO_SECRET_KEY || "").trim();
    if (envSecret) {
      return createHash("sha256").update(envSecret).digest();
    }
    if (fs.existsSync(keyFile)) {
      const raw = fs.readFileSync(keyFile, "utf8").trim();
      if (raw) return createHash("sha256").update(raw).digest();
    }
    const generated = randomBytes(32).toString("hex");
    fs.writeFileSync(keyFile, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
    return createHash("sha256").update(generated).digest();
  }

  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "aes_256_gcm",
    encryptString(plainText) {
      const key = getKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(String(plainText || ""), "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      const payload = Buffer.concat([Buffer.from("W1", "utf8"), iv, tag, encrypted]);
      return payload;
    },
    decryptString(buffer) {
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      if (buf.length >= 30 && buf.subarray(0, 2).toString("utf8") === "W1") {
        const key = getKey();
        const iv = buf.subarray(2, 14);
        const tag = buf.subarray(14, 30);
        const ciphertext = buf.subarray(30);
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      }
      throw new Error("API key này được mã hóa bằng Windows DPAPI trên máy cũ. Hãy nhập lại API key một lần trên giao diện Web để lưu chuẩn Server.");
    }
  };
}

const tokenFile = path.join(codexProHome, "http-token");
function ensureMcpToken() {
  const envToken = String(process.env.CODEXPRO_TOKEN || process.env.CODEXPRO_AUTH_TOKEN || "").trim();
  if (envToken) {
    fs.writeFileSync(tokenFile, `${envToken}\n`, { encoding: "utf8", mode: 0o600 });
    return envToken;
  }
  if (fs.existsSync(tokenFile)) {
    const existing = fs.readFileSync(tokenFile, "utf8").trim();
    if (existing) return existing;
  }
  const generated = randomBytes(24).toString("hex");
  fs.writeFileSync(tokenFile, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
  return generated;
}

const mcpToken = ensureMcpToken();

function diagnostic(level, source, category, message, details = {}) {
  try {
    void appendDiagnosticLog(codexProHome, {
      level,
      source,
      category,
      action: String(details?.action || category || "event"),
      message,
      duration_ms: details?.duration_ms,
      details: {
        manager_run_id: MANAGER_RUN_ID,
        manager_version: MANAGER_VERSION,
        process_id: process.pid,
        ...details
      }
    });
  } catch {}
}

const sendTraceLogger = createSendTraceLogger({ home: codexProHome, component: "web-manager", runId: MANAGER_RUN_ID });
const diagnosticGateMap = new Map();
function diagnosticAllowed(key, intervalMs = 10_000) {
  const now = Date.now();
  const prev = diagnosticGateMap.get(key) || 0;
  if (now - prev < intervalMs) return false;
  diagnosticGateMap.set(key, now);
  return true;
}

const {
  readManagerSettings,
  applyWorkerImageFile,
  applyAppBackgroundFile,
  managerSettingsPayload,
  saveManagerSettingsPatch,
  createWorkerImagePack,
  selectWorkerImagePack,
  deleteWorkerImagePack,
  resetWorkerImage,
  resetAppBackground,
  resetManagerSettings
} = createManagerSettingsStore({ home: codexProHome, mimeTypeForFile });

function pathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const mcpRuntimeConfig = {
  root: workspacesRoot,
  port: MCP_PORT,
  mode: "agent",
  tunnel: "none",
  write: "workspace",
  bash: "full",
  tokenFile,
  allowedRoots: [workspacesRoot, projectRoot]
};

const {
  managerProjects,
  saveManagerProjects,
  githubRepoForRoot,
  listProjects
} = createProjectDiscovery({
  codexProHome,
  readTaskConfig: async () => mcpRuntimeConfig,
  readManagerSettings,
  diagnostic,
  allAllowedWorkspaces: ALL_ALLOWED_WORKSPACES,
  pathInside
});

// Seed projectRoot if no projects are registered yet
if (managerProjects().length === 0 && fs.existsSync(path.join(projectRoot, "package.json"))) {
  saveManagerProjects([projectRoot]);
}

const safeStorage = createHeadlessSafeStorage(codexProHome);
const rawApiWorkerStore = createApiWorkerStore({ home: codexProHome, safeStorage });
const apiWorkerChatHistoryStore = createApiWorkerChatHistoryStore({ home: codexProHome, safeStorage });

const apiWorkerStore = {
  ...rawApiWorkerStore,
  list() {
    return rawApiWorkerStore.list().map((item) => {
      let ok = false;
      if (item.credential_available) {
        try {
          ok = Boolean(rawApiWorkerStore.credential(item.id));
        } catch {
          ok = false;
        }
      }
      return { ...item, credential_available: ok };
    });
  },
  save(payload) {
    const current = rawApiWorkerStore.list();
    const id = String(payload?.id || "").trim();
    const isExisting = current.some((item) => item.id === id);
    if (!isExisting && current.length >= MAX_API_WORKERS) {
      throw new Error(`Bản Server giới hạn tối đa ${MAX_API_WORKERS} API Worker để tối ưu RAM.`);
    }
    return rawApiWorkerStore.save(payload);
  }
};

function seedApiWorkersFromEnv() {
  const rawJson = String(process.env.CODEXPRO_API_WORKERS_JSON || "").trim();
  if (!rawJson) return;
  try {
    const items = JSON.parse(rawJson);
    if (!Array.isArray(items)) return;
    for (const item of items.slice(0, MAX_API_WORKERS)) {
      if (item && typeof item === "object" && item.id && item.model) {
        try {
          rawApiWorkerStore.save(item);
        } catch (err) {
          console.error(`[CodexPro Web] Failed to seed API worker ${item.id}:`, err?.message || err);
        }
      }
    }
  } catch (err) {
    console.error("[CodexPro Web] Invalid CODEXPRO_API_WORKERS_JSON:", err?.message || err);
  }
}
seedApiWorkersFromEnv();

const sseClients = new Set();
function broadcastSse(channel, payload) {
  const frame = `event: ${channel}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

function createProviderForApiWorker(config, overrides = {}) {
  const options = {
    id: `provider-${String(config.id || "api").toLowerCase()}`,
    baseUrl: config.base_url,
    model: config.model,
    getApiKey: typeof overrides.getApiKey === "function" ? overrides.getApiKey : async () => apiWorkerStore.credential(config.id),
    maxRequestBytes: 16 * 1024 * 1024
  };
  if (config.provider === "9router") return create9RouterProvider(options);
  if (config.provider === "openrouter") return createOpenRouterProvider({ ...options, appName: config.app_name || "CodexPro", appUrl: config.app_url || "" });
  return createOpenAICompatibleProvider(options);
}

const workerPluginRegistry = new WorkerPluginRegistry();
workerPluginRegistry.register(createApiWorkerPlugin({
  listConfigurations: () => apiWorkerStore.list(),
  chatHistoryStore: apiWorkerChatHistoryStore,
  onUpdate: (update) => {
    broadcastSse("codexpro:worker-update", update);
  },
  createProvider: async ({ config }) => createProviderForApiWorker(config),
  createMcpClients: async ({ workerId, signal }) => {
    signal?.throwIfAborted?.();
    const health = await checkLocalMcpHealth();
    if (!health.ok) throw new Error("Local CodexPro MCP is offline; API worker cannot start.");
    return await createWorkerMcpClients({
      url: `http://127.0.0.1:${MCP_PORT}/mcp`,
      token: mcpToken,
      workerId,
      signal
    });
  }
}));

const mcpCausalTelemetry = createMcpCausalTelemetry();
const {
  localMcpTool
} = createManagerMcpClient({
  managerVersion: MANAGER_VERSION,
  diagnostic,
  diagnosticAllowed,
  causalTelemetry: mcpCausalTelemetry,
  emitCausalTelemetry() {}
});

const managerChatCache = createManagerChatCache({ home: codexProHome });
const appPluginRegistry = createAppPluginRegistry({ home: codexProHome });
const electronTemplatesRoot = path.join(projectRoot, "manager", "electron", "app-plugins", "templates");
const managedAppPluginInstaller = createManagedAppPluginInstaller({
  home: codexProHome,
  registry: appPluginRegistry,
  templateRoot: path.join(electronTemplatesRoot, "taste-skill"),
  gitDiagramTemplateRoot: path.join(electronTemplatesRoot, "gitdiagram")
});

let mcpChildProcess = null;
async function checkLocalMcpHealth() {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/healthz`, {
      headers: { Authorization: `Bearer ${mcpToken}` },
      signal: controller.signal
    });
    clearTimeout(timer);
    const latency = Date.now() - started;
    if (!res.ok) return { ok: false, status: res.status, latency, latencyMs: latency, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: Boolean(data?.ok), status: res.status, latency, latencyMs: latency, data };
  } catch (error) {
    const latency = Date.now() - started;
    return { ok: false, status: 0, latency, latencyMs: latency, error: String(error?.message || error) };
  }
}

async function ensureLocalMcpServer() {
  const health = await checkLocalMcpHealth();
  if (health.ok) return health;
  if (mcpChildProcess && mcpChildProcess.exitCode === null) return health;

  const httpEntry = path.join(projectRoot, "dist", "http.js");
  if (!fs.existsSync(httpEntry)) {
    console.error(`[CodexPro Web] Missing ${httpEntry}; run npm run build first.`);
    return health;
  }

  const allowedRoots = [...new Set([workspacesRoot, projectRoot, ...managerProjects()])].filter((p) => fs.existsSync(p));
  console.error(`[CodexPro Web] Starting internal MCP server on 127.0.0.1:${MCP_PORT}...`);
  mcpChildProcess = spawn(process.execPath, [httpEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEXPRO_HOME: codexProHome,
      CODEXPRO_HOST: "127.0.0.1",
      CODEXPRO_PORT: String(MCP_PORT),
      CODEXPRO_HTTP_TOKEN: mcpToken,
      CODEXPRO_AUTH_TOKEN: mcpToken,
      CODEXPRO_ROOT: allowedRoots[0] || workspacesRoot,
      CODEXPRO_ALLOWED_ROOTS: allowedRoots.join(path.delimiter),
      CODEXPRO_MODE: "agent",
      CODEXPRO_WRITE_MODE: "workspace",
      CODEXPRO_BASH_MODE: "full",
      CODEXPRO_ALLOW_HOME: "1"
    },
    stdio: ["ignore", "inherit", "inherit"]
  });
  mcpChildProcess.on("exit", (code) => {
    console.error(`[CodexPro Web] Internal MCP server exited with code ${code}`);
    mcpChildProcess = null;
  });

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const check = await checkLocalMcpHealth();
    if (check.ok) return check;
  }
  return await checkLocalMcpHealth();
}

async function collectWebRuntimeStatus(reqOrigin = "") {
  const local = await checkLocalMcpHealth();
  const workerStatus = await workerPluginRegistry.list({ browserProfiles: [] });
  let workerJobs = [];
  if (local.ok) {
    try {
      const res = await localMcpTool(mcpRuntimeConfig, mcpToken, "worker_job_history", {
        statuses: ["prepared", "running", "completed", "failed", "cancelled", "blocked"],
        limit: 100
      }, 8000);
      if (Array.isArray(res?.jobs)) workerJobs = res.jobs;
    } catch {}
  }
  const publicBase = (PUBLIC_URL || reqOrigin || `http://127.0.0.1:${WEB_PORT}`).replace(/\/+$/, "");
  let publicHostname = "";
  try {
    publicHostname = new URL(publicBase).hostname;
  } catch {}
  const mcpLink = `${publicBase}/mcp?codexpro_token=${encodeURIComponent(mcpToken)}`;
  const processes = [
    { pid: process.pid, name: "node" },
    ...(mcpChildProcess?.pid ? [{ pid: mcpChildProcess.pid, name: "node" }] : [])
  ];
  return {
    checkedAt: new Date().toISOString(),
    task: {
      exists: true,
      taskName: "CodexProWebServer",
      state: local.ok ? "Running" : "Stopped",
      lastTaskResult: 0
    },
    config: {
      ...mcpRuntimeConfig,
      hostname: publicHostname
    },
    local,
    tunnel: {
      configured: Boolean(publicHostname),
      hostname: publicHostname,
      url: `${publicBase}/health`,
      ok: local.ok,
      status: local.ok ? 200 : 0,
      latency: local.latency,
      latencyMs: local.latencyMs,
      data: local.data
    },
    processes,
    browserProfiles: [],
    workerExtensionVersion: "0.5.137",
    workers: workerStatus.workers,
    workerSources: workerStatus.sources,
    workerJobs,
    taskHangIncidents: [],
    taskHangSummary: { active_count: 0, total_count: 0 },
    workerSnapshotAvailable: true,
    workerJobsAvailable: true,
    mcpLink,
    tokenConfigured: true,
    autoStart: true
  };
}

// Keep-awake self-ping while any API worker is actively working
if (PUBLIC_URL) {
  setInterval(async () => {
    try {
      const status = await workerPluginRegistry.list({ browserProfiles: [] });
      const anyWorking = (status?.workers || []).some((w) => w?.activity === "working");
      if (anyWorking) {
        await fetch(`${PUBLIC_URL}/health`).catch(() => {});
      }
    } catch {}
  }, 5 * 60 * 1000).unref();
}

async function handleWebRpc(method, args = [], reqOrigin = "") {
  switch (method) {
    case "codexpro:status":
      return await collectWebRuntimeStatus(reqOrigin);
    case "codexpro:workers": {
      const status = await collectWebRuntimeStatus(reqOrigin);
      return { workers: status.workers, sources: status.workerSources };
    }
    case "codexpro:worker-send": {
      const payload = args[0] || {};
      const prepared = await materializeApiWorkerRequest(payload);
      return await workerPluginRegistry.invoke("send", String(prepared?.workerId || prepared?.worker_id || ""), prepared);
    }
    case "codexpro:worker-read": {
      const payload = args[0] || {};
      return await workerPluginRegistry.invoke("read", String(payload?.workerId || payload?.worker_id || ""), payload);
    }
    case "codexpro:worker-stop": {
      const payload = args[0] || {};
      return await workerPluginRegistry.invoke("stop", String(payload?.workerId || payload?.worker_id || ""), payload);
    }
    case "codexpro:api-worker-configs":
      return apiWorkerStore.list();
    case "codexpro:list-api-worker-models":
      return await discoverApiWorkerModels(args[0] || {}, {
        getStoredCredential: async (id) => apiWorkerStore.credential(id),
        createProvider: async (config, getApiKey) => createProviderForApiWorker(config, { getApiKey })
      });
    case "codexpro:save-api-worker":
      return apiWorkerStore.save(args[0] || {});
    case "codexpro:delete-api-worker":
      return apiWorkerStore.remove(args[0]);
    case "codexpro:test-api-worker": {
      const id = String(args[0] || "");
      const config = apiWorkerStore.list().find((item) => item.id === id);
      if (!config) throw new Error("API worker configuration was not found.");
      return await createProviderForApiWorker(config).probe();
    }
    case "codexpro:control": {
      const action = String(args[0] || "");
      if (action === "restart" || action === "start") {
        if (mcpChildProcess && action === "restart") {
          mcpChildProcess.kill();
          mcpChildProcess = null;
        }
        await ensureLocalMcpServer();
      } else if (action === "stop" && mcpChildProcess) {
        mcpChildProcess.kill();
        mcpChildProcess = null;
      }
      return await collectWebRuntimeStatus();
    }
    case "codexpro:get-manager-settings":
      return managerSettingsPayload();
    case "codexpro:save-manager-settings":
      return saveManagerSettingsPatch(args[0] || {});
    case "codexpro:create-worker-image-pack":
      return createWorkerImagePack(args[0]);
    case "codexpro:select-worker-image-pack":
      return selectWorkerImagePack(args[0]);
    case "codexpro:delete-worker-image-pack":
      return deleteWorkerImagePack(args[0]);
    case "codexpro:reset-worker-image":
      return resetWorkerImage(args[0]?.packId, args[0]?.state);
    case "codexpro:reset-app-background":
      return resetAppBackground();
    case "codexpro:reset-manager-settings":
      return resetManagerSettings();
    case "codexpro:upload-web-asset": {
      const { kind, packId, state, name, dataBase64 } = args[0] || {};
      const ext = path.extname(String(name || ".png")).toLowerCase() || ".png";
      const buf = Buffer.from(String(dataBase64 || ""), "base64");
      const tempFile = path.join(uploadsRoot, `asset-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`);
      fs.writeFileSync(tempFile, buf);
      try {
        if (kind === "worker-image") return applyWorkerImageFile(packId, state, tempFile);
        if (kind === "app-background") return applyAppBackgroundFile(tempFile);
        throw new Error("Loại asset không hợp lệ.");
      } finally {
        try { fs.rmSync(tempFile, { force: true }); } catch {}
      }
    }
    case "codexpro:upload-request-files": {
      const items = Array.isArray(args[0]) ? args[0].slice(0, MAX_REQUEST_ATTACHMENTS) : [];
      const summaries = [];
      let totalBytes = 0;
      for (const item of items) {
        const safeName = path.basename(String(item?.name || "attachment.txt")).replace(/[^A-Za-z0-9._-]/g, "_");
        const buf = Buffer.from(String(item?.dataBase64 || ""), "base64");
        if (buf.length > MAX_REQUEST_ATTACHMENT_BYTES) throw new Error("Mỗi file được tối đa 8 MB.");
        totalBytes += buf.length;
        if (totalBytes > MAX_REQUEST_ATTACHMENTS_TOTAL_BYTES) throw new Error("Tổng file đính kèm được tối đa 10 MB.");
        const dir = path.join(uploadsRoot, `${Date.now()}-${randomBytes(3).toString("hex")}`);
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, safeName);
        fs.writeFileSync(dest, buf);
        summaries.push(requestFileSummary(dest));
      }
      return summaries;
    }
    case "codexpro:get-request-file-preview":
      return await requestFilePreview(args[0]);
    case "codexpro:get-chat-response-cache":
      return managerChatCache.get(args[0]);
    case "codexpro:save-chat-response-cache":
      return managerChatCache.save(args[0]);
    case "codexpro:get-chat-response-cache-metrics":
      return managerChatCache.metrics();
    case "codexpro:get-diagnostic-logs":
      return await readDiagnosticLogs(codexProHome, args[0] || {});
    case "codexpro:get-send-trace":
      return await readSendTraceTimeline(codexProHome, args[0] || {});
    case "codexpro:get-hang-watch-diagnostics":
      return await readManagerHangWatchDiagnostics({ codexProHome, liveState: null, incidentId: args[0]?.incident_id || "" });
    case "codexpro:clear-diagnostic-logs":
      return await clearDiagnosticLogs(codexProHome);
    case "codexpro:prune-diagnostic-logs":
      return await pruneDiagnosticLogs(codexProHome);
    case "codexpro:operations-performance":
      return await collectOperationsPerformance(Array.isArray(args[0]) ? args[0] : [process.pid]);
    case "codexpro:projects":
      return await listProjects();
    case "codexpro:add-project": {
      const input = String(args[0] || "").trim();
      if (!input) throw new Error("Hãy nhập đường dẫn thư mục hoặc URL GitHub repo.");
      let resolved = input;
      if (/^https?:\/\/github\.com\/[^/]+\/[^/]+/i.test(input)) {
        const repoName = input.replace(/\.git$/i, "").split("/").filter(Boolean).slice(-1)[0].replace(/[^A-Za-z0-9._-]/g, "-");
        const targetDir = path.join(workspacesRoot, repoName);
        if (!fs.existsSync(targetDir)) {
          const clone = spawnSync("git", ["clone", "--depth", "1", input, targetDir], { encoding: "utf8", timeout: 120_000 });
          if (clone.status !== 0) {
            throw new Error(`Clone repo thất bại: ${clone.stderr || clone.stdout || "git clone error"}`);
          }
        }
        resolved = targetDir;
      } else {
        resolved = path.resolve(input);
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`Thư mục dự án không tồn tại trên server: ${resolved}`);
      }
      const roots = [...new Set([...managerProjects(), resolved])];
      saveManagerProjects(roots);
      return await listProjects();
    }
    case "codexpro:remove-project": {
      const target = path.resolve(String(args[0] || "")).toLowerCase();
      saveManagerProjects(managerProjects().filter((item) => path.resolve(item).toLowerCase() !== target));
      return await listProjects();
    }
    case "codexpro:inspect-project": {
      const root = path.resolve(String(args[0] || ""));
      return await localMcpTool(mcpRuntimeConfig, mcpToken, "workspace_guide", { root }, 15_000);
    }
    case "codexpro:get-repo-task-status":
      return await localMcpTool(mcpRuntimeConfig, mcpToken, "repo_task_status", args[0] || {}, 10_000);
    case "codexpro:get-workspace-coordination":
      return await localMcpTool(mcpRuntimeConfig, mcpToken, "workspace_coordination_status", { root: args[0], task_id: args[1] || "" }, 10_000);
    case "codexpro:list-app-plugins":
      return appPluginRegistry.list().map((p) => p?.id && p?.url ? { ...p, url: `/api/app-plugins/${p.id}/` } : p);
    case "codexpro:list-app-plugin-catalog":
      return managedAppPluginInstaller.listCatalog();
    case "codexpro:analyze-app-plugin-repo": {
      const payload = args[0] || {};
      const root = path.resolve(String(payload?.root || ""));
      const inspection = await localMcpTool(mcpRuntimeConfig, mcpToken, "workspace_guide", { root }, 15_000);
      return buildGitDiagramArchitecture({ ...inspection, root });
    }
    case "codexpro:prepare-app-plugin-task": {
      const payload = args[0] || {};
      const bundle = createPluginSkillBundle({
        registry: appPluginRegistry,
        home: codexProHome,
        pluginId: payload?.pluginId,
        skillIds: payload?.skillIds
      });
      return { ...bundle, attachment: requestFileSummary(bundle.path) };
    }
    case "codexpro:install-catalog-app-plugin": {
      const result = await managedAppPluginInstaller.install(args[0]);
      const plugins = appPluginRegistry.list().map((p) => p?.id && p?.url ? { ...p, url: `/api/app-plugins/${p.id}/` } : p);
      return { ...result, plugins, catalog: managedAppPluginInstaller.listCatalog() };
    }
    case "codexpro:update-catalog-app-plugin": {
      const result = await managedAppPluginInstaller.update(args[0]);
      const plugins = appPluginRegistry.list().map((p) => p?.id && p?.url ? { ...p, url: `/api/app-plugins/${p.id}/` } : p);
      return { ...result, plugins, catalog: managedAppPluginInstaller.listCatalog() };
    }
    case "codexpro:reload-app-plugin": {
      const rawPlugin = appPluginRegistry.reload(args[0]);
      const plugin = rawPlugin?.id && rawPlugin?.url ? { ...rawPlugin, url: `/api/app-plugins/${rawPlugin.id}/` } : rawPlugin;
      const plugins = appPluginRegistry.list().map((p) => p?.id && p?.url ? { ...p, url: `/api/app-plugins/${p.id}/` } : p);
      return { plugin, plugins };
    }
    case "codexpro:uninstall-app-plugin": {
      const plugin = appPluginRegistry.uninstall(args[0]);
      const plugins = appPluginRegistry.list().map((p) => p?.id && p?.url ? { ...p, url: `/api/app-plugins/${p.id}/` } : p);
      return { plugin, plugins };
    }
    case "codexpro:reload-profiles":
      return await collectWebRuntimeStatus();
    default:
      return null;
  }
}

const WEB_BRIDGE_JS = `(() => {
  if (window.codexpro) return;
  const listeners = new Map();
  function onEvent(channel, cb) {
    if (typeof cb !== "function") return () => {};
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
    return () => listeners.get(channel)?.delete(cb);
  }
  function emitEvent(channel, data) {
    const set = listeners.get(channel);
    if (!set) return;
    for (const cb of set) {
      try { cb(data); } catch (e) { console.error(e); }
    }
  }
  try {
    const es = new EventSource("/api/manager/events");
    for (const ch of ["codexpro:worker-update", "codexpro:browser-profiles", "codexpro:browser-stream", "codexpro:flush-chat-response-cache"]) {
      es.addEventListener(ch, (ev) => {
        try { emitEvent(ch, JSON.parse(ev.data)); } catch {}
      });
    }
  } catch (e) {
    console.warn("[CodexPro Web] SSE unavailable:", e);
  }

  async function rpc(method, ...args) {
    const res = await fetch("/api/manager/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, args })
    });
    const data = await res.json();
    if (!res.ok || data?.ok === false) {
      const err = new Error(data?.error?.message || data?.message || "CodexPro Web RPC failed.");
      err.code = data?.error?.code || "WEB_RPC_FAILED";
      throw err;
    }
    return data.result;
  }

  function pickFiles({ accept = "*/*", multiple = false } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.multiple = multiple;
      input.style.display = "none";
      document.body.appendChild(input);
      input.onchange = async () => {
        const files = Array.from(input.files || []);
        input.remove();
        const encoded = await Promise.all(files.map((file) => new Promise((resFile, rejFile) => {
          const reader = new FileReader();
          reader.onload = () => {
            const str = String(reader.result || "");
            const idx = str.indexOf(",");
            resFile({ name: file.name, size: file.size, type: file.type, dataBase64: idx >= 0 ? str.slice(idx + 1) : str });
          };
          reader.onerror = rejFile;
          reader.readAsDataURL(file);
        })));
        resolve(encoded);
      };
      input.oncancel = () => { input.remove(); resolve([]); };
      input.click();
    });
  }

  window.codexpro = {
    getStatus: () => rpc("codexpro:status"),
    listWorkers: () => rpc("codexpro:workers"),
    sendWorkerRequest: (p) => rpc("codexpro:worker-send", p),
    readWorkerResponse: (p) => rpc("codexpro:worker-read", p),
    stopWorkerTask: (p) => rpc("codexpro:worker-stop", p),
    listApiWorkers: () => rpc("codexpro:api-worker-configs"),
    listApiWorkerModels: (p) => rpc("codexpro:list-api-worker-models", p),
    saveApiWorker: (p) => rpc("codexpro:save-api-worker", p),
    deleteApiWorker: (id) => rpc("codexpro:delete-api-worker", id),
    testApiWorker: (id) => rpc("codexpro:test-api-worker", id),
    onBrowserProfiles: (cb) => onEvent("codexpro:browser-profiles", cb),
    onBrowserStream: (cb) => onEvent("codexpro:browser-stream", cb),
    ackBrowserStream: () => {},
    onWorkerUpdate: (cb) => onEvent("codexpro:worker-update", cb),
    controlServer: (action) => rpc("codexpro:control", action),
    copyText: async (text) => {
      try { await navigator.clipboard.writeText(String(text || "")); return true; }
      catch { return false; }
    },
    logChatLayout: () => {},
    logChatResponseAudit: () => {},
    logDiagnostic: () => {},
    sendTraceEvent: () => {},
    getDiagnosticLogs: (o) => rpc("codexpro:get-diagnostic-logs", o),
    getSendTrace: (o) => rpc("codexpro:get-send-trace", o),
    getHangWatchDiagnostics: (o) => rpc("codexpro:get-hang-watch-diagnostics", o),
    clearDiagnosticLogs: () => rpc("codexpro:clear-diagnostic-logs"),
    pruneDiagnosticLogs: () => rpc("codexpro:prune-diagnostic-logs"),
    getOperationsPerformance: (pids) => rpc("codexpro:operations-performance", pids),
    showNotification: () => true,
    rotateLink: () => rpc("codexpro:status"),
    listProjects: () => rpc("codexpro:projects"),
    checkProfile: () => rpc("codexpro:status"),
    checkVisualWatchdog: async () => ({}),
    forgetProfile: () => rpc("codexpro:status"),
    setupProfile: () => rpc("codexpro:status"),
    openProfileChat: () => ({}),
    recoverProfileChat: () => ({}),
    auditLongRunningProfileChat: () => ({}),
    stopProfileTask: () => ({}),
    reloadProfiles: () => rpc("codexpro:reload-profiles"),
    getManagerSettings: () => rpc("codexpro:get-manager-settings"),
    saveManagerSettings: (patch) => rpc("codexpro:save-manager-settings", patch),
    createWorkerImagePack: (name) => rpc("codexpro:create-worker-image-pack", name),
    selectWorkerImagePack: (id) => rpc("codexpro:select-worker-image-pack", id),
    deleteWorkerImagePack: (id) => rpc("codexpro:delete-worker-image-pack", id),
    chooseWorkerImage: async (payload) => {
      const files = await pickFiles({ accept: "image/png,image/jpeg,image/gif,image/webp" });
      if (!files.length) return rpc("codexpro:get-manager-settings");
      return rpc("codexpro:upload-web-asset", { kind: "worker-image", packId: payload?.packId, state: payload?.state, ...files[0] });
    },
    resetWorkerImage: (payload) => rpc("codexpro:reset-worker-image", payload),
    chooseAppBackground: async () => {
      const files = await pickFiles({ accept: "image/png,image/jpeg,image/gif,image/webp" });
      if (!files.length) return rpc("codexpro:get-manager-settings");
      return rpc("codexpro:upload-web-asset", { kind: "app-background", ...files[0] });
    },
    resetAppBackground: () => rpc("codexpro:reset-app-background"),
    resetManagerSettings: () => rpc("codexpro:reset-manager-settings"),
    chooseRequestFiles: async () => {
      const files = await pickFiles({ multiple: true });
      if (!files.length) return [];
      return rpc("codexpro:upload-request-files", files);
    },
    getRequestFilePreview: (filePath) => rpc("codexpro:get-request-file-preview", filePath),
    captureClipboardImage: async () => null,
    sendProfileRequest: () => { throw new Error("Bản Server chỉ chạy qua API Worker."); },
    resumeProfileTask: () => ({}),
    abandonProfileTask: () => ({}),
    renameProfileChat: () => ({}),
    getProfileResponse: () => ({}),
    getChatResponseCache: (p) => rpc("codexpro:get-chat-response-cache", p),
    saveChatResponseCache: (p) => rpc("codexpro:save-chat-response-cache", p),
    getChatResponseCacheMetrics: () => rpc("codexpro:get-chat-response-cache-metrics"),
    onChatResponseCacheFlushRequest: (cb) => onEvent("codexpro:flush-chat-response-cache", cb),
    ackChatResponseCacheFlush: () => {},
    getRepoTaskStatus: (p) => rpc("codexpro:get-repo-task-status", p),
    getWorkspaceCoordination: (r, t) => rpc("codexpro:get-workspace-coordination", r, t),
    listAppPlugins: () => rpc("codexpro:list-app-plugins"),
    listAppPluginCatalog: () => rpc("codexpro:list-app-plugin-catalog"),
    analyzeAppPluginRepo: (p) => rpc("codexpro:analyze-app-plugin-repo", p),
    prepareAppPluginTask: (p) => rpc("codexpro:prepare-app-plugin-task", p),
    installCatalogAppPlugin: (id) => rpc("codexpro:install-catalog-app-plugin", id),
    updateCatalogAppPlugin: (id) => rpc("codexpro:update-catalog-app-plugin", id),
    installAppPlugin: async () => ({ cancelled: true, plugins: await rpc("codexpro:list-app-plugins") }),
    reloadAppPlugin: (id) => rpc("codexpro:reload-app-plugin", id),
    uninstallAppPlugin: (id) => rpc("codexpro:uninstall-app-plugin", id),
    chooseProject: async () => {
      const val = window.prompt("Nhập đường dẫn thư mục trên server hoặc URL GitHub repo (ví dụ https://github.com/user/repo) để clone tự động:");
      return val ? val.trim() : null;
    },
    addProject: (root) => rpc("codexpro:add-project", root),
    removeProject: (root) => rpc("codexpro:remove-project", root),
    inspectProject: (root) => rpc("codexpro:inspect-project", root),
    openFolder: async () => true,
    openExternal: async (url) => { window.open(url, "_blank", "noopener,noreferrer"); return true; }
  };
})();
`;

function checkWebAuth(req, res) {
  if (!WEB_PASSWORD) return true;
  const authHeader = String(req.headers.authorization || "");
  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const pass = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
    if (pass === WEB_PASSWORD) return true;
  }
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="CodexPro Server"',
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end("Yêu cầu mật khẩu truy cập CodexPro Web Server.");
  return false;
}

function proxyToMcp(req, res) {
  const options = {
    hostname: "127.0.0.1",
    port: MCP_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${MCP_PORT}` }
  };
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
  req.pipe(proxyReq);
}

const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf"
};

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    // 1. Public Health & MCP endpoints
    if (pathname === "/health" || pathname === "/healthz") {
      const health = await checkLocalMcpHealth();
      res.writeHead(health.ok ? 200 : 503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: health.ok, latencyMs: health.latencyMs, maxApiWorkers: MAX_API_WORKERS }));
      return;
    }
    if (pathname === "/mcp") {
      proxyToMcp(req, res);
      return;
    }

    if (!checkWebAuth(req, res)) return;

    // 2. Web Bridge script
    if (pathname === "/web-bridge.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(WEB_BRIDGE_JS);
      return;
    }

    // 2b. App Plugin static resources (/api/app-plugins/:id/*)
    if (pathname.startsWith("/api/app-plugins/")) {
      const rest = pathname.slice("/api/app-plugins/".length);
      const slashIdx = rest.indexOf("/");
      const pluginId = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
      const resourcePath = slashIdx >= 0 ? rest.slice(slashIdx) : "/";
      try {
        const resource = appPluginRegistry.resolveResource(pluginId, resourcePath);
        const body = await fs.promises.readFile(resource.path);
        res.writeHead(200, {
          "Content-Type": resource.mime_type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        res.end(body);
      } catch (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end(`Không tải được plugin: ${err?.message || err}`);
      }
      return;
    }

    // 3. SSE stream for live API Worker updates
    if (pathname === "/api/manager/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      const keepAlive = setInterval(() => {
        try { res.write(": ping\n\n"); } catch { clearInterval(keepAlive); sseClients.delete(res); }
      }, 20_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    // 4. RPC endpoint for window.codexpro
    if (pathname === "/api/manager/rpc" && req.method === "POST") {
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 32 * 1024 * 1024) {
          res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: { message: "Payload quá lớn." } }));
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
      const host = String(req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${WEB_PORT}`).split(",")[0].trim();
      const reqOrigin = `${proto}://${host}`;
      try {
        const result = await handleWebRpc(String(body.method || ""), Array.isArray(body.args) ? body.args : [], reqOrigin);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({
          ok: false,
          error: {
            name: String(err?.name || "Error"),
            message: String(err?.message || err),
            code: String(err?.code || "WEB_RPC_FAILED")
          }
        }));
      }
      return;
    }

    // 5. Serve static files from manager/dist
    let targetFile = path.join(distDir, pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
    if (!pathInside(targetFile, distDir) || !fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
      targetFile = path.join(distDir, "index.html");
    }

    if (path.basename(targetFile) === "index.html") {
      let html = fs.readFileSync(targetFile, "utf8");
      html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, "");
      html = html.replace('<script type="module"', '<script src="/web-bridge.js"></script>\n    <script type="module"');
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }

    const ext = path.extname(targetFile).toLowerCase();
    const mime = MIME_BY_EXT[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": ext === ".js" || ext === ".css" || ext === ".woff2" ? "public, max-age=31536000, immutable" : "no-cache"
    });
    fs.createReadStream(targetFile).pipe(res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Internal Server Error: ${error?.message || error}`);
    }
  }
});

async function start() {
  await ensureLocalMcpServer();
  server.listen(WEB_PORT, WEB_HOST, () => {
    console.error(`[CodexPro Web] Listening on http://${WEB_HOST}:${WEB_PORT}`);
    console.error(`[CodexPro Web] Home directory: ${codexProHome}`);
    console.error(`[CodexPro Web] Max API Workers: ${MAX_API_WORKERS}`);
  });
}

start().catch((error) => {
  console.error("[CodexPro Web] Fatal startup error:", error);
  process.exit(1);
});
