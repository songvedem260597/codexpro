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
  allowedRoots: [workspacesRoot]
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

// Clean up projectRoot (/app) if previously seeded, and leave only user workspaces
{
  const filtered = managerProjects().filter((p) => {
    const resolved = path.resolve(p);
    return resolved !== path.resolve(projectRoot) && resolved !== path.resolve(workspacesRoot);
  });
  saveManagerProjects(filtered);
}

const safeStorage = createHeadlessSafeStorage(codexProHome);
const rawApiWorkerStore = createApiWorkerStore({ home: codexProHome, safeStorage });
const apiWorkerChatHistoryStore = createApiWorkerChatHistoryStore({ home: codexProHome, safeStorage });

const cloudCredsFile = path.join(codexProHome, "cloud-credentials.json");
function readCloudCredentials() {
  try {
    if (!fs.existsSync(cloudCredsFile)) return {};
    const parsed = JSON.parse(fs.readFileSync(cloudCredsFile, "utf8"));
    return {
      openrouterApiKey: parsed?.openrouterCipher ? safeStorage.decryptString(Buffer.from(parsed.openrouterCipher, "base64")) : "",
      githubToken: parsed?.githubCipher ? safeStorage.decryptString(Buffer.from(parsed.githubCipher, "base64")) : ""
    };
  } catch {
    return {};
  }
}
function saveCloudCredentials({ openrouterApiKey, githubToken } = {}) {
  const current = readCloudCredentials();
  const nextOpenrouter = typeof openrouterApiKey === "string" && openrouterApiKey.trim() ? openrouterApiKey.trim() : current.openrouterApiKey || "";
  const nextGithub = typeof githubToken === "string" && githubToken.trim() ? githubToken.trim() : current.githubToken || "";
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    openrouterCipher: nextOpenrouter ? safeStorage.encryptString(nextOpenrouter).toString("base64") : "",
    githubCipher: nextGithub ? safeStorage.encryptString(nextGithub).toString("base64") : ""
  };
  fs.writeFileSync(cloudCredsFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  if (nextOpenrouter) {
    for (const item of rawApiWorkerStore.list()) {
      if (item.provider === "openrouter") {
        try {
          rawApiWorkerStore.save({ ...item, api_key: nextOpenrouter });
        } catch {}
      }
    }
  }
  cachedGithubProjectsAt = 0;
  return {
    openrouterConfigured: Boolean(nextOpenrouter),
    githubConfigured: Boolean(nextGithub)
  };
}
function resolveOpenRouterKey(workerId = "") {
  if (workerId) {
    try {
      const cred = rawApiWorkerStore.credential(workerId);
      if (cred) return cred;
    } catch {}
  }
  const envKey = String(process.env.OPENROUTER_API_KEY || "").trim();
  if (envKey) return envKey;
  const saved = readCloudCredentials().openrouterApiKey;
  if (saved) return saved;
  for (const w of rawApiWorkerStore.list()) {
    if (w.provider === "openrouter") {
      try {
        const c = rawApiWorkerStore.credential(w.id);
        if (c) return c;
      } catch {}
    }
  }
  return "";
}
function resolveGithubToken() {
  const envToken = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (envToken) return envToken;
  return readCloudCredentials().githubToken || "";
}

const DEFAULT_OPENROUTER_WORKERS = [
  {
    id: "openrouter-north-code",
    label: "OpenRouter · North Mini Code",
    provider: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    model: "cohere/north-mini-code:free",
    enabled: true,
    app_name: "CodexPro",
    app_url: ""
  },
  {
    id: "openrouter-nemotron-ultra",
    label: "OpenRouter · Nemotron 3 Ultra",
    provider: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    enabled: true,
    app_name: "CodexPro",
    app_url: ""
  },
  {
    id: "openrouter-nemotron-lightning",
    label: "OpenRouter · Nemotron 3.5 Lightning",
    provider: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    model: "nvidia/nemotron-3.5-lightning:free",
    enabled: true,
    app_name: "CodexPro",
    app_url: ""
  },
  {
    id: "openrouter-nemotron-super",
    label: "OpenRouter · Nemotron 3.5 Super",
    provider: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    model: "nvidia/nemotron-3.5-super-vl:free",
    enabled: true,
    app_name: "CodexPro",
    app_url: ""
  }
];

const apiWorkerStore = {
  ...rawApiWorkerStore,
  credential(id) {
    try {
      const c = rawApiWorkerStore.credential(id);
      if (c) return c;
    } catch {}
    return resolveOpenRouterKey(id);
  },
  list() {
    const fallbackKey = resolveOpenRouterKey();
    return rawApiWorkerStore.list().map((item) => {
      let ok = false;
      if (item.credential_available) {
        try {
          ok = Boolean(rawApiWorkerStore.credential(item.id));
        } catch {
          ok = false;
        }
      }
      if (!ok && item.provider === "openrouter" && fallbackKey) ok = true;
      return { ...item, credential_available: ok };
    });
  },
  save(payload) {
    const current = rawApiWorkerStore.list();
    const id = String(payload?.id || payload?.local_worker_id || payload?.worker_id || "").replace(/^api:/i, "").trim();
    const existing = current.find((item) => item.id === id);
    if (!existing && current.length >= MAX_API_WORKERS) {
      throw new Error(`Bản Server giới hạn tối đa ${MAX_API_WORKERS} API Worker để tối ưu RAM.`);
    }
    const nextModel = String(payload?.model || existing?.model || "").trim();
    let nextLabel = String(payload?.label || existing?.label || id).trim();
    if (existing && !payload?.label && existing.provider === "openrouter" && existing.label.startsWith("OpenRouter · ") && nextModel && nextModel !== existing.model) {
      const shortModel = nextModel.split("/").pop().replace(/:free$/i, "").replace(/[-_]+/g, " ").trim();
      if (shortModel) nextLabel = `OpenRouter · ${shortModel}`;
    }
    const merged = existing
      ? {
          ...existing,
          ...payload,
          id,
          label: nextLabel,
          provider: payload?.provider || existing.provider,
          base_url: payload?.base_url || existing.base_url,
          model: nextModel
        }
      : { ...payload, id, label: nextLabel, model: nextModel };
    const saved = rawApiWorkerStore.save(merged);
    if (merged?.provider === "openrouter" && payload?.api_key) {
      saveCloudCredentials({ openrouterApiKey: String(payload.api_key).trim() });
    }
    return saved;
  }
};

function seedApiWorkersFromEnv() {
  const rawJson = String(process.env.CODEXPRO_API_WORKERS_JSON || "").trim();
  const seedKey = resolveOpenRouterKey();
  if (rawJson) {
    try {
      const items = JSON.parse(rawJson);
      if (Array.isArray(items)) {
        for (const item of items.slice(0, MAX_API_WORKERS)) {
          if (item && typeof item === "object" && item.id && item.model) {
            try {
              rawApiWorkerStore.save({ ...item, ...(seedKey && !item.api_key ? { api_key: seedKey } : {}) });
            } catch (err) {
              console.error(`[CodexPro Web] Failed to seed API worker ${item.id}:`, err?.message || err);
            }
          }
        }
      }
    } catch (err) {
      console.error("[CodexPro Web] Invalid CODEXPRO_API_WORKERS_JSON:", err?.message || err);
    }
  }
  const existing = rawApiWorkerStore.list();
  if (existing.length === 0) {
    for (const item of DEFAULT_OPENROUTER_WORKERS.slice(0, MAX_API_WORKERS)) {
      try {
        rawApiWorkerStore.save({ ...item, ...(seedKey ? { api_key: seedKey } : {}) });
      } catch (err) {
        console.error(`[CodexPro Web] Failed to seed default OpenRouter worker ${item.id}:`, err?.message || err);
      }
    }
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

const ALLOWED_GITHUB_OWNER = "songvedem260597";
const DEFAULT_GITHUB_REPOS = [
  { full_name: "songvedem260597/codexpro-cloud-agent", name: "codexpro-cloud-agent", default_branch: "main" },
  { full_name: "songvedem260597/codexpro", name: "codexpro", default_branch: "win" },
  { full_name: "songvedem260597/edit0-desktop-generator", name: "edit0-desktop-generator", default_branch: "main" },
  { full_name: "songvedem260597/flora-desktop-generator", name: "flora-desktop-generator", default_branch: "main" }
];
let cachedGithubProjects = null;
let cachedGithubProjectsAt = 0;

async function githubApi(pathname, init = {}, signal) {
  const token = resolveGithubToken();
  if (!token) throw new Error("Chưa cấu hình GitHub Token trên Cloud Server.");
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "CodexPro-Cloud-WebServer/1.0",
      "x-github-api-version": "2022-11-28",
      ...(init.headers || {})
    }
  });
  return res;
}

async function listWebGithubProjects() {
  const now = Date.now();
  if (cachedGithubProjects && now - cachedGithubProjectsAt < 60_000) return cachedGithubProjects;
  let repos = [...DEFAULT_GITHUB_REPOS];
  if (resolveGithubToken()) {
    try {
      const res = await githubApi("/user/repos?per_page=30&sort=updated&affiliation=owner");
      if (res.ok) {
        const data = await res.json();
        const owned = (Array.isArray(data) ? data : []).filter((r) => String(r?.owner?.login || "").toLowerCase() === ALLOWED_GITHUB_OWNER.toLowerCase());
        if (owned.length) repos = owned;
      }
    } catch {}
  }
  const seen = new Set();
  const result = [];
  for (const r of [...repos, ...DEFAULT_GITHUB_REPOS]) {
    const fullName = String(r.full_name || "").trim();
    if (!fullName || seen.has(fullName.toLowerCase())) continue;
    seen.add(fullName.toLowerCase());
    const name = String(r.name || fullName.split("/")[1] || fullName);
    result.push({
      root: `github:${fullName}`,
      name,
      localName: name,
      repoFullName: fullName,
      githubRepo: fullName,
      branch: String(r.default_branch || "main"),
      isGit: true,
      clean: true,
      changes: 0,
      modified: 0,
      untracked: 0,
      ahead: 0,
      behind: 0,
      conflicted: 0
    });
  }
  cachedGithubProjects = result;
  cachedGithubProjectsAt = now;
  return result;
}

async function inspectGithubRepo(repoInput) {
  const raw = String(repoInput || "").replace(/^github:/i, "").trim();
  const repoFullName = raw.includes("/") ? raw : `${ALLOWED_GITHUB_OWNER}/${raw || "codexpro-cloud-agent"}`;
  if (!repoFullName.toLowerCase().startsWith(`${ALLOWED_GITHUB_OWNER.toLowerCase()}/`)) {
    throw new Error(`Chỉ cho phép truy cập GitHub repository của ${ALLOWED_GITHUB_OWNER}.`);
  }
  let defaultBranch = "main";
  let treeEntries = [];
  if (resolveGithubToken()) {
    const repoRes = await githubApi(`/repos/${repoFullName}`);
    if (repoRes.ok) {
      const repoData = await repoRes.json();
      defaultBranch = String(repoData.default_branch || "main");
    }
    const treeRes = await githubApi(`/repos/${repoFullName}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
    if (treeRes.ok) {
      const treeData = await treeRes.json();
      treeEntries = (Array.isArray(treeData.tree) ? treeData.tree : []).slice(0, 150);
    }
  }
  const files = treeEntries.filter((t) => t.type === "blob").map((t) => t.path);
  const nodes = files.slice(0, 80).map((f) => ({
    id: `file:${f}`,
    kind: "file",
    name: path.posix.basename(f),
    file: f
  }));
  return {
    workspace_id: `github:${repoFullName}`,
    root: `github:${repoFullName}`,
    name: repoFullName.split("/")[1],
    branch: defaultBranch,
    files,
    tree: treeEntries.slice(0, 120).map((t) => ({ path: t.path, type: t.type === "tree" ? "directory" : "file" })),
    codexgraph: {
      schema_version: "1.0",
      source: "GitHub REST Tree (0 MB RAM)",
      nodes,
      edges: [],
      coverage: { parsed_files: files.length, total_files: files.length },
      warnings: [],
      output_limited: treeEntries.length >= 150,
      returned: { nodes: nodes.length, edges: 0 },
      limits: { max_nodes: 80, max_edges: 0 },
      cache: { hit: true }
    }
  };
}

const FREE_OPENROUTER_FALLBACK_MODELS = [
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "dots-studio/dots-3-note-preview:free",
  "openrouter/free"
];

const webChatHistoryFile = path.join(codexProHome, "web-github-worker-history.json");
function readWebWorkerHistory(workerId) {
  try {
    if (!fs.existsSync(webChatHistoryFile)) return [];
    const all = JSON.parse(fs.readFileSync(webChatHistoryFile, "utf8"));
    const list = all?.[workerId];
    return Array.isArray(list) ? list.slice(-5) : [];
  } catch {
    return [];
  }
}
function saveWebWorkerHistory(workerId, messages) {
  try {
    const all = fs.existsSync(webChatHistoryFile) ? JSON.parse(fs.readFileSync(webChatHistoryFile, "utf8")) : {};
    all[workerId] = (Array.isArray(messages) ? messages : []).slice(-5);
    fs.writeFileSync(webChatHistoryFile, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  } catch {}
}

async function callOpenRouterWithFallback({ primaryModel, apiKey, messages, tools, signal }) {
  const models = [primaryModel, ...FREE_OPENROUTER_FALLBACK_MODELS.filter((m) => m !== primaryModel)];
  let lastError = null;
  for (const model of models) {
    signal?.throwIfAborted?.();
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "http-referer": PUBLIC_URL || "https://codexpro.local",
          "x-title": "CodexPro GitHub Cloud Worker"
        },
        body: JSON.stringify({
          model,
          messages,
          ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
          max_tokens: 2048,
          temperature: 0.2
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)])
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastError = new Error(`OpenRouter (${model}) HTTP ${res.status}: ${data?.error?.message || "upstream error"}`);
        if ([429, 500, 502, 503, 504, 404].includes(res.status)) continue;
        throw lastError;
      }
      const msg = data?.choices?.[0]?.message;
      if (!msg) {
        lastError = new Error(`OpenRouter (${model}) trả về phản hồi rỗng.`);
        continue;
      }
      return { message: msg, modelUsed: model, usage: data?.usage };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError || new Error("Không gọi được model OpenRouter free nào.");
}

async function runGithubRunnerTask({ workerId, config, repoFullName, jobId, prompt, signal, onStatus }) {
  const normalizedRepo = String(repoFullName || "").replace(/^github:/i, "").trim() || "songvedem260597/codexpro-cloud-agent";
  if (!/^songvedem260597\/[A-Za-z0-9._-]+$/i.test(normalizedRepo)) {
    throw new Error(`Worker chỉ được phép thao tác trên GitHub của ${ALLOWED_GITHUB_OWNER}.`);
  }
  const apiKey = apiWorkerStore.credential(workerId);
  if (!apiKey) throw new Error("Chưa có OpenRouter API Key cho worker này.");
  if (!resolveGithubToken()) throw new Error("Chưa cấu hình GitHub Token để thao tác Git & Actions Runner.");

  onStatus?.({ phase: "preparing", message: `Đang kết nối GitHub ${normalizedRepo}...` });
  const repoRes = await githubApi(`/repos/${normalizedRepo}`, {}, signal);
  if (!repoRes.ok) throw new Error(`Không đọc được repo ${normalizedRepo} (HTTP ${repoRes.status}).`);
  const repoInfo = await repoRes.json();
  const defaultBranch = String(repoInfo.default_branch || "main");
  let activeBranch = defaultBranch;
  let workingBranchCreated = false;
  const changedFiles = new Set();
  let runnerExecution = null;

  async function ensureWorkingBranch() {
    if (workingBranchCreated) return activeBranch;
    const refRes = await githubApi(`/repos/${normalizedRepo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, {}, signal);
    if (!refRes.ok) throw new Error(`Không lấy được SHA nhánh ${defaultBranch} (HTTP ${refRes.status}).`);
    const refData = await refRes.json();
    const baseSha = refData?.object?.sha;
    const branchName = `codexpro/${workerId.replace(/[^a-z0-9-]/gi, "")}-${jobId.slice(4, 12)}`;
    const createRes = await githubApi(`/repos/${normalizedRepo}/git/refs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha })
    }, signal);
    if (!createRes.ok && createRes.status !== 422) {
      throw new Error(`Không tạo được nhánh làm việc ${branchName} (HTTP ${createRes.status}).`);
    }
    activeBranch = branchName;
    workingBranchCreated = true;
    return activeBranch;
  }

  async function toolListFiles({ directory = "" } = {}) {
    const cleanDir = String(directory || "").replace(/^\/+|\/+$/g, "");
    onStatus?.({ phase: "tool", message: `github_list_files(${cleanDir || "/"}) trên ${normalizedRepo}@${activeBranch}` });
    const treeRes = await githubApi(`/repos/${normalizedRepo}/git/trees/${encodeURIComponent(activeBranch)}?recursive=1`, {}, signal);
    if (!treeRes.ok) throw new Error(`GitHub tree HTTP ${treeRes.status}`);
    const treeData = await treeRes.json();
    const all = (Array.isArray(treeData.tree) ? treeData.tree : [])
      .filter((item) => item.type === "blob" && (!cleanDir || item.path.startsWith(`${cleanDir}/`) || item.path === cleanDir))
      .map((item) => item.path)
      .slice(0, 120);
    return { repository: normalizedRepo, branch: activeBranch, files: all };
  }

  async function toolReadFile({ path: filePath = "" } = {}) {
    const cleanPath = String(filePath || "").replace(/^\/+/g, "").trim();
    if (!cleanPath || cleanPath.includes("..")) throw new Error("Đường dẫn file không hợp lệ.");
    onStatus?.({ phase: "tool", message: `github_read_file(${cleanPath})` });
    const encodedPath = cleanPath.split("/").map(encodeURIComponent).join("/");
    const fileRes = await githubApi(`/repos/${normalizedRepo}/contents/${encodedPath}?ref=${encodeURIComponent(activeBranch)}`, {}, signal);
    if (!fileRes.ok) throw new Error(`Không đọc được file ${cleanPath} (HTTP ${fileRes.status})`);
    const fileData = await fileRes.json();
    const content = Buffer.from(String(fileData.content || ""), "base64").toString("utf8").slice(0, 32_000);
    return { path: cleanPath, branch: activeBranch, sha: fileData.sha, content };
  }

  async function toolWriteFile({ path: filePath = "", content = "", commit_message = "" } = {}) {
    const cleanPath = String(filePath || "").replace(/^\/+/g, "").trim();
    if (!cleanPath || cleanPath.includes("..") || cleanPath.startsWith(".github/") || /(?:secret|token|password|\.env|\.key)/i.test(cleanPath)) {
      throw new Error(`Không cho phép ghi vào đường dẫn nhạy cảm: ${cleanPath}`);
    }
    if (changedFiles.size >= 10 && !changedFiles.has(cleanPath)) throw new Error("Vượt quá giới hạn 10 file thay đổi mỗi task.");
    const branch = await ensureWorkingBranch();
    onStatus?.({ phase: "tool", message: `github_write_file(${cleanPath}) → nhánh ${branch}` });
    const encodedPath = cleanPath.split("/").map(encodeURIComponent).join("/");
    let existingSha = "";
    const curRes = await githubApi(`/repos/${normalizedRepo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, {}, signal);
    if (curRes.ok) {
      const curData = await curRes.json();
      existingSha = curData?.sha || "";
    }
    const putRes = await githubApi(`/repos/${normalizedRepo}/contents/${encodedPath}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: String(commit_message || `chore(${workerId}): update ${cleanPath}`).slice(0, 140),
        content: Buffer.from(String(content || ""), "utf8").toString("base64"),
        branch,
        ...(existingSha ? { sha: existingSha } : {})
      })
    }, signal);
    if (!putRes.ok) throw new Error(`Ghi file ${cleanPath} lên GitHub thất bại (HTTP ${putRes.status}).`);
    changedFiles.add(cleanPath);
    return { ok: true, path: cleanPath, branch, changed_files_count: changedFiles.size };
  }

  async function toolRunRunnerTests({ workflow = "" } = {}) {
    onStatus?.({ phase: "running_ci_cloud", message: `Đang kích hoạt GitHub Actions Runner trên ${normalizedRepo}...` });
    const wfRes = await githubApi(`/repos/${normalizedRepo}/actions/workflows`, {}, signal);
    if (!wfRes.ok) throw new Error(`Không đọc được danh sách GitHub Actions workflows (HTTP ${wfRes.status}).`);
    const wfData = await wfRes.json();
    const workflows = Array.isArray(wfData.workflows) ? wfData.workflows.filter((w) => w.state === "active") : [];
    if (!workflows.length) throw new Error(`Repo ${normalizedRepo} chưa có GitHub Actions workflow nào.`);
    const preferred = workflows.find((w) => workflow && (w.path.endsWith(workflow) || w.name === workflow))
      || workflows.find((w) => /windows-ci\.yml|ci\.yml/i.test(w.path))
      || workflows[0];

    let dispatchRef = activeBranch;
    const startedBefore = Date.now() - 5000;
    let dispatchRes = await githubApi(`/repos/${normalizedRepo}/actions/workflows/${preferred.id}/dispatches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: dispatchRef })
    }, signal);
    if (!dispatchRes.ok && dispatchRef !== defaultBranch) {
      dispatchRef = defaultBranch;
      dispatchRes = await githubApi(`/repos/${normalizedRepo}/actions/workflows/${preferred.id}/dispatches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: dispatchRef })
      }, signal);
    }
    if (!dispatchRes.ok) {
      throw new Error(`Không dispatch được workflow ${preferred.name} trên GitHub Runner (HTTP ${dispatchRes.status}).`);
    }

    onStatus?.({ phase: "running_ci_cloud", message: `Đã gửi lệnh chạy ${preferred.name} (${dispatchRef}). Đang đợi GitHub Runner nhận job...` });
    let matchedRun = null;
    for (let attempt = 0; attempt < 36; attempt++) {
      await new Promise((r) => setTimeout(r, 4500));
      signal?.throwIfAborted?.();
      const runsRes = await githubApi(`/repos/${normalizedRepo}/actions/workflows/${preferred.id}/runs?per_page=5`, {}, signal);
      if (!runsRes.ok) continue;
      const runsData = await runsRes.json();
      const candidate = (runsData.workflow_runs || []).find((r) => Date.parse(r.created_at) >= startedBefore);
      if (!candidate) continue;
      matchedRun = candidate;
      onStatus?.({
        phase: "running_ci_cloud",
        message: `GitHub Runner (${preferred.name}): ${candidate.status}${candidate.conclusion ? ` · ${candidate.conclusion}` : ""}`,
        runUrl: candidate.html_url
      });
      if (candidate.status === "completed") {
        runnerExecution = {
          workflow: preferred.name,
          ref: dispatchRef,
          status: candidate.status,
          conclusion: candidate.conclusion,
          runId: candidate.id,
          runUrl: candidate.html_url
        };
        return runnerExecution;
      }
    }
    if (matchedRun) {
      runnerExecution = {
        workflow: preferred.name,
        ref: dispatchRef,
        status: matchedRun.status,
        conclusion: matchedRun.conclusion || "in_progress",
        runId: matchedRun.id,
        runUrl: matchedRun.html_url
      };
      return runnerExecution;
    }
    throw new Error("Đã gửi workflow_dispatch nhưng chưa tìm thấy run phản hồi trong thời gian chờ.");
  }

  const tools = [
    {
      type: "function",
      function: {
        name: "github_list_files",
        description: "List files in the GitHub repository via GitHub API (no local disk).",
        parameters: {
          type: "object",
          properties: { directory: { type: "string", description: "Optional subdirectory prefix, e.g. 'src' or 'test'" } }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "github_read_file",
        description: "Read a file from the GitHub repository via GitHub API.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative file path in the repo" } },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "github_write_file",
        description: "Create or update a file on an isolated GitHub branch (never touches local disk).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            commit_message: { type: "string" }
          },
          required: ["path", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "github_run_runner_tests",
        description: "Trigger and wait for GitHub Actions Runner CI tests on the repository.",
        parameters: {
          type: "object",
          properties: {
            workflow: { type: "string", description: "Optional workflow filename such as windows-ci.yml or ci.yml" }
          }
        }
      }
    }
  ];

  const messages = [
    {
      role: "system",
      content: [
        `Bạn là GitHub Cloud Worker (${config.label}) chạy trên CodexPro Cloud Server (512 MB RAM).`,
        `Quy tắc bắt buộc: Bạn CHỈ thao tác trực tiếp trên GitHub repository '${normalizedRepo}' (nhánh mặc định '${defaultBranch}') thông qua 4 công cụ GitHub API: github_list_files, github_read_file, github_write_file, github_run_runner_tests.`,
        "Tuyệt đối KHÔNG dùng ổ đĩa local hay shell local. Khi sửa code hoặc khi người dùng yêu cầu kiểm thử, hãy gọi github_run_runner_tests để chạy test bằng GitHub Actions Runner. Trả lời ngắn gọn bằng tiếng Việt."
      ].join(" ")
    },
    { role: "user", content: prompt }
  ];

  let finalAnswer = "";
  let modelUsed = config.model;
  let totalUsage = null;

  for (let turn = 0; turn < 8; turn++) {
    onStatus?.({ phase: "streaming", message: `Đang gọi OpenRouter (${modelUsed})...` });
    const { message: assistant, modelUsed: actualModel, usage } = await callOpenRouterWithFallback({
      primaryModel: config.model,
      apiKey,
      messages,
      tools,
      signal
    });
    modelUsed = actualModel;
    if (usage) totalUsage = usage;
    const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    messages.push({
      role: "assistant",
      content: typeof assistant.content === "string" ? assistant.content : "",
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    });
    if (typeof assistant.content === "string" && assistant.content.trim()) {
      finalAnswer = assistant.content.trim();
    }
    if (!toolCalls.length) break;

    for (const tc of toolCalls.slice(0, 4)) {
      let toolResult;
      try {
        const args = JSON.parse(tc.function?.arguments || "{}");
        const fn = tc.function?.name;
        if (fn === "github_list_files") toolResult = await toolListFiles(args);
        else if (fn === "github_read_file") toolResult = await toolReadFile(args);
        else if (fn === "github_write_file") toolResult = await toolWriteFile(args);
        else if (fn === "github_run_runner_tests") toolResult = await toolRunRunnerTests(args);
        else throw new Error(`Tool không được hỗ trợ: ${fn}`);
      } catch (err) {
        toolResult = { error: String(err?.message || err).slice(0, 240) };
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(toolResult).slice(0, 34_000)
      });
    }
  }

  if ((changedFiles.size > 0 || /\b(test|runner|ci|kiểm thử|chạy thử)\b/i.test(prompt)) && !runnerExecution) {
    try {
      await toolRunRunnerTests({});
    } catch (err) {
      runnerExecution = { error: String(err?.message || err) };
    }
  }

  let prUrl = "";
  if (changedFiles.size > 0 && workingBranchCreated && (!runnerExecution || runnerExecution.conclusion === "success")) {
    try {
      const prRes = await githubApi(`/repos/${normalizedRepo}/pulls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: `[${config.label}] ${prompt.slice(0, 64)}`,
          head: activeBranch,
          base: defaultBranch,
          body: `Tạo tự động bởi **${config.label}** (\`${modelUsed}\`) trên CodexPro Cloud Server.\n\n- Task ID: \`${jobId}\`\n- Files thay đổi: ${[...changedFiles].map((f) => `\`${f}\``).join(", ")}\n- GitHub Runner: ${runnerExecution?.runUrl || "Đã kiểm tra"}`
        })
      }, signal);
      if (prRes.ok) {
        const prData = await prRes.json();
        prUrl = String(prData.html_url || "");
      }
    } catch {}
  }

  const summaryLines = [
    finalAnswer || `Đã thực thi xong trên GitHub repository \`${normalizedRepo}\`.`,
    "",
    "---",
    `- **Model thực thi**: \`${modelUsed}\``,
    `- **GitHub Repo**: \`${normalizedRepo}\` (nhánh \`${activeBranch}\`)`,
    ...(changedFiles.size ? [`- **File đã sửa trên GitHub (${changedFiles.size})**: ${[...changedFiles].map((f) => `\`${f}\``).join(", ")}`] : []),
    ...(runnerExecution?.runUrl
      ? [`- **GitHub Actions Runner**: [${runnerExecution.workflow} #${runnerExecution.runId}](${runnerExecution.runUrl}) — Trạng thái: **${runnerExecution.conclusion || runnerExecution.status}**`]
      : runnerExecution?.error
        ? [`- **GitHub Actions Runner**: ${runnerExecution.error}`]
        : []),
    ...(prUrl ? [`- **Pull Request**: ${prUrl}`] : [])
  ];

  return {
    text: summaryLines.join("\n"),
    task_title: `GitHub · ${normalizedRepo.split("/")[1]}`,
    usage: totalUsage,
    runUrl: runnerExecution?.runUrl || "",
    pullRequestUrl: prUrl
  };
}

function createWebGithubApiWorkerPlugin() {
  const runs = new Map();
  const publish = (workerConfigId, state) => {
    if (runs.get(workerConfigId) !== state) return;
    try {
      broadcastSse("codexpro:worker-update", {
        local_worker_id: workerConfigId,
        job_id: state.jobId,
        task_title: state.title,
        current_workspace_root: state.root,
        last_request: state.request,
        activity: state.activity,
        started_at: state.startedAt,
        finished_at: state.finishedAt,
        result: state.result,
        error: state.error,
        stream_text: state.streamText,
        stream_revision: state.streamRevision,
        stream_phase: state.streamPhase,
        stream_updated_at: state.streamUpdatedAt,
        stream_tool_status: state.streamToolStatus,
        events: state.events.slice(-30),
        chat_history: state.history.slice(-5)
      });
    } catch {}
  };

  return {
    manifest: {
      id: "api",
      name: "GitHub Cloud API Workers",
      version: "1",
      worker_type: "api",
      protocol: "codexpro-github-runner-v1",
      credential_type: "secret-reference",
      capabilities: ["send", "read", "stop", "github-runner"]
    },
    async list() {
      const configs = apiWorkerStore.list().filter((c) => c?.enabled !== false);
      return configs.map((config) => {
        const id = String(config.id);
        const run = runs.get(id);
        const history = run?.history || readWebWorkerHistory(id);
        const latestUser = [...history].reverse().find((m) => m.role === "user")?.content || "";
        const latestAssistant = history.at(-1)?.role === "assistant" ? history.at(-1).content : "";
        return {
          local_worker_id: id,
          label: String(config.label || id),
          provider: String(config.provider || "openrouter"),
          model: String(config.model || ""),
          available_models: FREE_OPENROUTER_FALLBACK_MODELS,
          connected: config.credential_available !== false,
          activity: run?.activity || "idle",
          current_task_id: run?.activity === "working" ? run.jobId : "",
          current_task_title: run?.activity === "working" ? run.title : "",
          last_task_title: run?.title || "",
          current_workspace_root: run?.activity === "working" ? run.root : "",
          run_id: run?.jobId || "",
          last_task_id: run?.jobId || "",
          last_result: run?.result?.text || latestAssistant,
          last_request: run?.request || latestUser,
          chat_history: history.slice(-5),
          stream_text: run?.streamText || "",
          stream_revision: run?.streamRevision || 0,
          stream_phase: run?.streamPhase || "idle",
          stream_updated_at: run?.streamUpdatedAt || "",
          stream_tool_status: run?.streamToolStatus || "",
          started_at: run?.startedAt || "",
          finished_at: run?.finishedAt || "",
          capabilities: ["send", "read", "stop", "tool-calling", "github-runner"],
          last_error: run?.error || "",
          usage: run?.result?.usage
        };
      });
    },
    async send(payload) {
      const workerConfigId = String(payload.local_worker_id || "").trim();
      let config = apiWorkerStore.list().find((item) => item.id === workerConfigId && item.enabled !== false);
      if (!config) throw new Error(`API worker ${workerConfigId} chưa được cấu hình.`);
      const existing = runs.get(workerConfigId);
      if (existing?.activity === "working") throw new Error(`Worker ${config.label} đang bận xử lý task khác.`);
      const requestedModel = String(payload.model || "").trim();
      if (requestedModel && requestedModel !== config.model) {
        try {
          const updated = apiWorkerStore.save({ id: workerConfigId, model: requestedModel });
          if (updated) config = { ...config, ...updated };
          else config = { ...config, model: requestedModel };
        } catch {
          config = { ...config, model: requestedModel };
        }
      }
      if ((payload.attachments?.length || 0) > 0) {
        throw new Error("Worker trên Cloud Server chỉ thao tác trực tiếp trên GitHub và test bằng Runner; không nhận file local.");
      }
      const request = String(payload.text || payload.request || "").trim().slice(0, 4000);
      if (!request) throw new Error("Nội dung yêu cầu không được để trống.");
      const rawRepo = String(payload.github_repo || payload.root || "songvedem260597/codexpro-cloud-agent").replace(/^github:/i, "").trim();
      const repoFullName = rawRepo.includes("/") ? rawRepo : `${ALLOWED_GITHUB_OWNER}/${rawRepo}`;
      if (!repoFullName.toLowerCase().startsWith(`${ALLOWED_GITHUB_OWNER.toLowerCase()}/`)) {
        throw new Error(`Worker chỉ thao tác trên GitHub của ${ALLOWED_GITHUB_OWNER}.`);
      }
      const jobId = String(payload.task_id || payload.taskId || `cpt_${randomBytes(12).toString("hex")}`).trim();
      const root = `github:${repoFullName}`;
      const prevHistory = readWebWorkerHistory(workerConfigId);
      const controller = new AbortController();
      const title = `GitHub · ${repoFullName.split("/")[1]}`;
      const state = {
        jobId,
        title,
        scope: "github",
        root,
        request,
        history: [...prevHistory, { role: "user", content: request }].slice(-5),
        activity: "working",
        startedAt: new Date().toISOString(),
        finishedAt: "",
        result: undefined,
        error: "",
        streamText: "",
        streamRevision: 1,
        streamPhase: "preparing",
        streamUpdatedAt: new Date().toISOString(),
        streamToolStatus: `GitHub ${repoFullName}`,
        events: [],
        controller
      };
      runs.set(workerConfigId, state);
      saveWebWorkerHistory(workerConfigId, state.history);
      publish(workerConfigId, state);

      cachedWorkerJobsAt = 0;
      localMcpTool(mcpRuntimeConfig, mcpToken, "worker_job_prepare", {
        job_id: jobId,
        worker_id: `api:${workerConfigId}`,
        kind: "code",
        scope: "workspace",
        root,
        request,
        title
      }, 5000).catch(() => {});

      state.promise = runGithubRunnerTask({
        workerId: workerConfigId,
        config,
        repoFullName,
        jobId,
        prompt: request,
        signal: controller.signal,
        onStatus: ({ phase, message, runUrl }) => {
          state.streamPhase = String(phase || "working");
          state.streamToolStatus = String(message || "");
          if (runUrl) state.events.push({ type: "github_run", url: runUrl });
          state.streamRevision += 1;
          state.streamUpdatedAt = new Date().toISOString();
          publish(workerConfigId, state);
        }
      }).then((result) => {
        state.result = result;
        state.title = result.task_title || title;
        state.history = [...prevHistory, { role: "user", content: request }, { role: "assistant", content: result.text }].slice(-5);
        saveWebWorkerHistory(workerConfigId, state.history);
        state.activity = "idle";
        state.streamText = result.text;
        state.streamPhase = "complete";
        state.streamToolStatus = "";
        state.finishedAt = new Date().toISOString();
        state.streamRevision += 1;
        state.streamUpdatedAt = new Date().toISOString();
        publish(workerConfigId, state);
        cachedWorkerJobsAt = 0;
        localMcpTool(mcpRuntimeConfig, mcpToken, "worker_job_complete", {
          job_id: jobId,
          worker_id: `api:${workerConfigId}`,
          title: state.title,
          summary: result.text.slice(0, 500)
        }, 5000).catch(() => {});
      }).catch((error) => {
        const msg = String(error?.message || error).slice(0, 1000);
        state.error = msg;
        state.activity = controller.signal.aborted ? "idle" : "failed";
        state.streamPhase = controller.signal.aborted ? "cancelled" : "error";
        state.finishedAt = new Date().toISOString();
        state.streamRevision += 1;
        state.streamUpdatedAt = new Date().toISOString();
        publish(workerConfigId, state);
        cachedWorkerJobsAt = 0;
        localMcpTool(mcpRuntimeConfig, mcpToken, "worker_job_fail", {
          job_id: jobId,
          worker_id: `api:${workerConfigId}`,
          error: msg
        }, 5000).catch(() => {});
      });

      return { accepted: true, worker_id: `api:${workerConfigId}`, job_id: jobId };
    },
    async read(payload) {
      const id = String(payload.local_worker_id || "").trim();
      const state = runs.get(id);
      if (!state) return { activity: "idle", chat_history: readWebWorkerHistory(id) };
      return {
        job_id: state.jobId,
        task_title: state.title,
        current_workspace_root: state.root,
        last_request: state.request,
        activity: state.activity,
        started_at: state.startedAt,
        finished_at: state.finishedAt,
        result: state.result,
        error: state.error,
        stream_text: state.streamText,
        stream_revision: state.streamRevision,
        stream_phase: state.streamPhase,
        stream_updated_at: state.streamUpdatedAt,
        stream_tool_status: state.streamToolStatus,
        events: state.events.slice(-30),
        chat_history: state.history.slice(-5)
      };
    },
    async stop(payload) {
      const id = String(payload.local_worker_id || "").trim();
      const state = runs.get(id);
      if (!state || state.activity !== "working") return { stopped: false, reason: "not_running" };
      state.controller.abort(new Error("Đã dừng GitHub Runner task."));
      await state.promise?.catch(() => {});
      return { stopped: true, job_id: state.jobId };
    }
  };
}

const workerPluginRegistry = new WorkerPluginRegistry();
workerPluginRegistry.register(createWebGithubApiWorkerPlugin());

const mcpCausalTelemetry = createMcpCausalTelemetry();
const {
  openLocalMcpSession,
  closeLocalMcpSession,
  localMcpToolInSession,
  localMcpTool
} = createManagerMcpClient({
  managerVersion: MANAGER_VERSION,
  diagnostic,
  diagnosticAllowed,
  causalTelemetry: mcpCausalTelemetry,
  emitCausalTelemetry() {}
});

let inspectInFlight = null;
async function inspectThroughMcp(root) {
  if (inspectInFlight) return await inspectInFlight;
  inspectInFlight = (async () => {
    let session;
    try {
      session = await openLocalMcpSession(mcpRuntimeConfig, mcpToken);
      const openedContent = await localMcpToolInSession(session, "open_workspace", {
        root,
        include_tree: true,
        max_depth: 2,
        max_files: 120
      }, 20000);
      const workspaceId = openedContent?.workspace_id;
      if (!workspaceId) throw new Error("CodexPro không trả về workspace_id khi mở dự án.");
      const graphContent = await localMcpToolInSession(session, "code_graph", {
        workspace_id: workspaceId,
        max_nodes: 1500,
        max_edges: 4000
      }, 20000);
      return {
        ...openedContent,
        codexgraph: {
          schema_version: graphContent?.schema_version,
          source: graphContent?.source || "CodexGraph",
          nodes: graphContent?.nodes || [],
          edges: graphContent?.edges || [],
          coverage: graphContent?.coverage || {},
          warnings: graphContent?.warnings || [],
          output_limited: Boolean(graphContent?.output_limited),
          returned: graphContent?.returned || {},
          limits: graphContent?.limits || {},
          cache: graphContent?.cache || {}
        }
      };
    } finally {
      await closeLocalMcpSession(session);
    }
  })();
  try {
    return await inspectInFlight;
  } finally {
    inspectInFlight = null;
  }
}

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

  const allowedRoots = [...new Set([workspacesRoot, ...managerProjects()])].filter((p) => fs.existsSync(p));
  console.error(`[CodexPro Web] Starting internal MCP server on 127.0.0.1:${MCP_PORT}...`);
  mcpChildProcess = spawn(process.execPath, [httpEntry], {
    cwd: workspacesRoot,
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
      CODEXPRO_ALLOW_HOME: "0"
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

let cachedWorkerJobs = [];
let cachedWorkerJobsAt = 0;
let statusInFlight = null;

async function collectWebRuntimeStatus(reqOrigin = "") {
  if (statusInFlight) return await statusInFlight;
  statusInFlight = (async () => {
    const local = await checkLocalMcpHealth();
    const workerStatus = await workerPluginRegistry.list({ browserProfiles: [] });
    const now = Date.now();
    if (local.ok && now - cachedWorkerJobsAt >= 15_000) {
      cachedWorkerJobsAt = now;
      try {
        const res = await localMcpTool(mcpRuntimeConfig, mcpToken, "worker_job_history", {
          statuses: ["prepared", "running", "completed", "failed", "cancelled", "blocked"],
          limit: 50
        }, 6000);
        if (Array.isArray(res?.jobs)) cachedWorkerJobs = res.jobs;
      } catch {}
    }
    const workerJobs = cachedWorkerJobs;
  const publicBase = (PUBLIC_URL || reqOrigin || `http://127.0.0.1:${WEB_PORT}`).replace(/\/+$/, "");
  let publicHostname = "";
  try {
    publicHostname = new URL(publicBase).hostname;
  } catch {}
  const mcpLink = `${publicBase}/mcp?codexpro_token=${encodeURIComponent(mcpToken)}`;
  const processes = mcpChildProcess?.pid ? [{ pid: mcpChildProcess.pid, name: "node" }] : [];
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
  })();
  try {
    return await statusInFlight;
  } finally {
    statusInFlight = null;
  }
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
      const workerId = String(payload?.workerId || payload?.worker_id || "");
      return await workerPluginRegistry.invoke("send", workerId, {
        ...payload,
        workerId,
        worker_id: workerId
      });
    }
    case "codexpro:worker-read": {
      const payload = args[0] || {};
      return await workerPluginRegistry.invoke("read", String(payload?.workerId || payload?.worker_id || ""), payload);
    }
    case "codexpro:worker-stop": {
      const payload = args[0] || {};
      return await workerPluginRegistry.invoke("stop", String(payload?.workerId || payload?.worker_id || ""), payload);
    }
    case "codexpro:set-cloud-credentials": {
      const res = saveCloudCredentials(args[0] || {});
      seedApiWorkersFromEnv();
      return {
        ...res,
        workers: apiWorkerStore.list(),
        projects: await listWebGithubProjects()
      };
    }
    case "codexpro:reset-openrouter-workers": {
      const seedKey = resolveOpenRouterKey();
      for (const old of rawApiWorkerStore.list()) {
        try { rawApiWorkerStore.remove(old.id); } catch {}
      }
      for (const item of DEFAULT_OPENROUTER_WORKERS.slice(0, MAX_API_WORKERS)) {
        rawApiWorkerStore.save({ ...item, ...(seedKey ? { api_key: seedKey } : {}) });
      }
      return apiWorkerStore.list();
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
    case "codexpro:operations-performance": {
      const requested = Array.isArray(args[0]) ? args[0] : [];
      return await collectOperationsPerformance([process.pid, mcpChildProcess?.pid, ...requested].filter(Boolean));
    }
    case "codexpro:projects":
      return { projects: await listWebGithubProjects() };
    case "codexpro:add-project": {
      const input = String(args[0] || "").trim();
      const match = input.match(/(?:github\.com\/|^)(songvedem260597\/[A-Za-z0-9._-]+)/i);
      if (!match) {
        throw new Error("Bản Cloud Server chỉ thêm được GitHub repository của songvedem260597 (không clone ổ đĩa local).");
      }
      const fullName = match[1].replace(/\.git$/i, "");
      const name = fullName.split("/")[1];
      if (!DEFAULT_GITHUB_REPOS.some((r) => r.full_name.toLowerCase() === fullName.toLowerCase())) {
        DEFAULT_GITHUB_REPOS.unshift({ full_name: fullName, name, default_branch: "main" });
      }
      cachedGithubProjectsAt = 0;
      return { projects: await listWebGithubProjects() };
    }
    case "codexpro:remove-project": {
      const target = String(args[0] || "").replace(/^github:/i, "").trim().toLowerCase();
      const idx = DEFAULT_GITHUB_REPOS.findIndex((r) => r.full_name.toLowerCase() === target);
      if (idx >= 0) DEFAULT_GITHUB_REPOS.splice(idx, 1);
      cachedGithubProjectsAt = 0;
      return { projects: await listWebGithubProjects() };
    }
    case "codexpro:inspect-project": {
      const raw = String(args[0] || "").trim();
      return await inspectGithubRepo(raw);
    }
    case "codexpro:get-repo-task-status": {
      const payload = args[0] || {};
      const taskId = String(payload?.taskId || payload?.task_id || "").trim();
      return await localMcpTool(mcpRuntimeConfig, mcpToken, "repo_task_status", { ...payload, ...(taskId ? { task_id: taskId } : {}) }, 15_000);
    }
    case "codexpro:get-workspace-coordination": {
      const workspaceRoot = String(args[0] || "").trim();
      const normalizedTaskId = String(args[1] || "").trim();
      return await localMcpTool(mcpRuntimeConfig, mcpToken, "workspace_coordination_status", {
        root: workspaceRoot,
        ...(normalizedTaskId ? { task_id: normalizedTaskId } : {})
      }, 15_000);
    }
    case "codexpro:list-app-plugins":
      return appPluginRegistry.list().map((p) => p?.id && p?.url ? { ...p, url: `/api/app-plugins/${p.id}/` } : p);
    case "codexpro:list-app-plugin-catalog":
      return managedAppPluginInstaller.listCatalog();
    case "codexpro:analyze-app-plugin-repo": {
      const payload = args[0] || {};
      const root = path.resolve(String(payload?.root || ""));
      const inspection = await inspectThroughMcp(root);
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
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch("/api/manager/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args })
      });
      const rawText = await res.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        const err = new Error("Server đang khởi động lại hoặc quá tải tạm thời, vui lòng đợi vài giây rồi thử lại.");
        err.code = "WEB_UPSTREAM_UNAVAILABLE";
        throw err;
      }
      if (!res.ok || data?.ok === false) {
        const err = new Error(data?.error?.message || data?.message || "CodexPro Web RPC failed.");
        err.code = data?.error?.code || "WEB_RPC_FAILED";
        throw err;
      }
      return data.result;
    }
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
    isWebServer: true,
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
      const mcpRunning = Boolean(mcpChildProcess && mcpChildProcess.exitCode === null);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, mcpRunning, maxApiWorkers: MAX_API_WORKERS }));
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
