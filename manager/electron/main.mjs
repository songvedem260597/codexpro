import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, Notification, protocol, safeStorage, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHeadlessWorkerManager } from "./headless-workers.mjs";
import { appendDiagnosticLog, clearDiagnosticLogs, pruneDiagnosticLogs, readDiagnosticLogs } from "./diagnostic-log.mjs";
import { createMcpResponseQueue } from "./mcp-response-queue.mjs";
import { createRuntimeHealthDiagnosticTracker } from "./runtime-health-diagnostic.mjs";
import { syncUnpackedCodexProExtensions } from "./extension-sync.mjs";
import { collectTunnelOfflineEvidence } from "./tunnel-offline-diagnostic.mjs";
import { createInterruptionAlertTracker } from "./interruption-alert.mjs";
import { taskUnfinalizedIncidents, TASK_UNFINALIZED_REPEAT_MS } from "./task-unfinalized-diagnostic.mjs";
import { classifyUserReportedError } from "./user-reported-error.mjs";
import { createRuntimeRestartGuard } from "./runtime-restart-guard.mjs";
import { collectOperationsPerformance } from "./operations-metrics.mjs";
import { WorkerPluginRegistry } from "./worker-core/plugin-registry.mjs";
import { createApiWorkerStore } from "./worker-core/api-worker-store.mjs";
import { discoverApiWorkerModels } from "./worker-core/api-worker-model-discovery.mjs";
import { createWorkerMcpClients } from "./mcp/http-client.mjs";
import { create9RouterProvider, createOpenAICompatibleProvider, createOpenRouterProvider } from "./provider-core/openai-compatible-provider.mjs";
import { createApiWorkerPlugin } from "./worker-plugins/api-worker-plugin.mjs";
import { createChromeWorkerPlugin } from "./worker-plugins/chrome-worker-plugin.mjs";
import { buildTaskWorkflowPrompt, resolveTaskWorkflow } from "./task-workflow-registry.mjs";
import { createAppPluginRegistry } from "./app-plugins/app-plugin-registry.mjs";
import { createManagedAppPluginInstaller } from "./app-plugins/managed-app-plugin-installer.mjs";
import { createPluginSkillBundle } from "./app-plugins/plugin-skill-bundle.mjs";

protocol.registerSchemesAsPrivileged([{
  scheme: "codexpro-plugin",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true
  }
}]);

const execFileAsync = promisify(execFile);
const workerPluginRegistry = new WorkerPluginRegistry();
const pendingWorkerUpdates = new Map();
let workerUpdateFlushTimer = null;
const interruptionAlertTracker = createInterruptionAlertTracker();

function showManagerNotification(payload) {
  if (!Notification.isSupported()) return false;
  const title = String(payload?.title || "CodexPro").trim().slice(0, 120) || "CodexPro";
  const body = String(payload?.body || "").trim().slice(0, 500);
  new Notification({ title, body, silent: payload?.silent === true }).show();
  return true;
}

function flushWorkerUpdates() {
  workerUpdateFlushTimer = null;
  const updates = [...pendingWorkerUpdates.values()];
  pendingWorkerUpdates.clear();
  if (!updates.length) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    for (const update of updates) win.webContents.send("codexpro:worker-update", update);
  }
}

function queueWorkerUpdate(update) {
  const localWorkerId = String(update?.local_worker_id || "").trim();
  if (!localWorkerId) return;
  const interruptionAlert = interruptionAlertTracker.observeApiWorker(update);
  if (interruptionAlert && readManagerSettings().taskNotifications !== false) showManagerNotification(interruptionAlert);
  const activity = String(update?.activity || "idle");
  pendingWorkerUpdates.set(`api:${localWorkerId}`, {
    worker_id: `api:${localWorkerId}`,
    activity,
    current_task_id: activity === "working" ? String(update?.job_id || "") : "",
    current_task_title: activity === "working" ? String(update?.task_title || "") : "",
    current_workspace_root: activity === "working" ? String(update?.current_workspace_root || "") : "",
    last_task_id: String(update?.job_id || ""),
    last_task_title: String(update?.task_title || ""),
    last_request: String(update?.last_request || ""),
    last_result: String(update?.result?.text || ""),
    last_error: String(update?.error || ""),
    stream_text: String(update?.stream_text || ""),
    stream_revision: Math.max(0, Number(update?.stream_revision) || 0),
    stream_phase: String(update?.stream_phase || ""),
    stream_updated_at: String(update?.stream_updated_at || ""),
    stream_tool_status: String(update?.stream_tool_status || ""),
    workflow_id: String(update?.workflow_id || ""),
    workflow_version: String(update?.workflow_version || ""),
    workflow_evidence: String(update?.workflow_evidence || ""),
    started_at: String(update?.started_at || ""),
    finished_at: String(update?.finished_at || ""),
    usage: update?.result?.usage
  });
  if (!workerUpdateFlushTimer) workerUpdateFlushTimer = setTimeout(flushWorkerUpdates, 40);
}

workerPluginRegistry.register(createChromeWorkerPlugin({
  sendRequest: (payload) => sendProfileRequest(payload),
  readResponse: (payload) => getProfileResponse(payload),
  stopTask: (payload) => stopProfileTask(payload)
}));
const here = path.dirname(fileURLToPath(import.meta.url));
const MANAGER_VERSION = app.getVersion();
const MANAGER_RUN_ID = `mgr_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
const codexProHome = process.env.CODEXPRO_HOME
  ? path.resolve(process.env.CODEXPRO_HOME)
  : path.join(os.homedir(), ".codexpro");
const appPluginRegistry = createAppPluginRegistry({ home: codexProHome });
const managedAppPluginInstaller = createManagedAppPluginInstaller({
  home: codexProHome,
  registry: appPluginRegistry,
  templateRoot: path.join(here, "app-plugins", "templates", "taste-skill")
});
const diagnostic = (level, source, category, message, details = {}) => {
  void appendDiagnosticLog(codexProHome, {
    level,
    source,
    category,
    action: details?.action || "",
    message,
    duration_ms: details?.duration_ms,
    details: {
      manager_run_id: MANAGER_RUN_ID,
      manager_version: MANAGER_VERSION,
      process_id: process.pid,
      ...details
    }
  }).catch((error) => {
    console.error("[manager-diagnostic]", error?.message || error);
  });
};
function recordUserReportedError(payload, context = {}) {
  if (payload?.toolRetry || Number(payload?.toolRolloverCount) > 0 || payload?.user_report_logging === false) return null;
  const report = classifyUserReportedError(payload);
  if (!report.is_error) return report;
  diagnostic("error", "user", "user-reported-error", `Người dùng báo lỗi: ${report.summary}`, {
    action: "user-reported-error",
    classification: report.classification,
    report_origin: "chat_request",
    incident_fingerprint: report.incident_fingerprint,
    detection_confidence: report.detection_confidence,
    detection_signals: report.detection_signals,
    report_excerpt: report.excerpt,
    attachment_names: report.attachment_names,
    attachment_count: report.attachment_names.length,
    worker_id: String(payload?.workerId || payload?.worker_id || ""),
    profile_id: String(payload?.profileId || payload?.profile_id || ""),
    conversation_id: String(payload?.conversationId || payload?.conversation_id || ""),
    task_id: String(payload?.task_id || payload?.taskId || ""),
    request_scope: String(payload?.scope || "workspace"),
    ...context
  });
  return report;
}
const diagnosticThrottleState = new Map();
function diagnosticAllowed(key, intervalMs) {
  if (!key || !(Number(intervalMs) > 0)) return true;
  const now = Date.now();
  const previous = Number(diagnosticThrottleState.get(key)) || 0;
  if (now - previous < Number(intervalMs)) return false;
  diagnosticThrottleState.set(key, now);
  if (diagnosticThrottleState.size > 1000) {
    for (const [candidate, at] of diagnosticThrottleState.entries()) {
      if (now - at > 60 * 60 * 1000) diagnosticThrottleState.delete(candidate);
    }
  }
  return true;
}
function diagnosticProjection(factory, args, fallback = {}) {
  if (typeof factory !== "function") return fallback;
  try {
    const value = factory(...args);
    return value && typeof value === "object" ? value : fallback;
  } catch (error) {
    return { diagnostic_projection_error: String(error?.message || error) };
  }
}
function diagnosticIpcHandle(channel, options, handler) {
  const action = String(options?.action || channel.replace(/^codexpro:/, ""));
  const category = String(options?.category || "runtime");
  const successMessage = String(options?.successMessage || `${action} hoàn tất`);
  const failureMessage = String(options?.failureMessage || `${action} thất bại`);
  ipcMain.handle(channel, async (event, ...args) => {
    const startedAt = Date.now();
    const ipcCallId = `ipc_${startedAt.toString(36)}_${randomBytes(3).toString("hex")}`;
    const context = {
      ipc_call_id: ipcCallId,
      ipc_channel: channel,
      ...diagnosticProjection(options?.details, args)
    };
    try {
      const result = await handler(event, ...args);
      const durationMs = Date.now() - startedAt;
      const envelopeError = result && typeof result === "object" && result.ok === false && result.error ? result.error : null;
      const resultContext = diagnosticProjection(options?.resultDetails, [result, ...args]);
      const resultDiagnostic = diagnosticProjection(options?.resultDiagnostic, [result, ...args], null);
      if (envelopeError) {
        diagnostic("error", "manager", category, `${failureMessage}: ${envelopeError.message || "Lỗi không xác định"}`, {
          action,
          duration_ms: durationMs,
          ...context,
          error: envelopeError
        });
      } else if (resultDiagnostic && diagnosticAllowed(resultDiagnostic.dedupeKey, resultDiagnostic.throttleMs)) {
        diagnostic(resultDiagnostic.level || "warn", "manager", category, resultDiagnostic.message || `${action} cần chú ý`, {
          action,
          duration_ms: durationMs,
          ...context,
          ...resultContext,
          ...(resultDiagnostic.details || {})
        });
      } else if (options?.logSuccess) {
        diagnostic("info", "manager", category, successMessage, { action, duration_ms: durationMs, ...context, ...resultContext });
      } else if (Number(options?.slowMs) > 0 && durationMs >= Number(options.slowMs)) {
        diagnostic("warn", "manager", category, `${action} phản hồi chậm (${durationMs} ms)`, { action, duration_ms: durationMs, ...context, ...resultContext });
      }
      return result;
    } catch (error) {
      diagnostic("error", "manager", category, `${failureMessage}: ${error?.message || String(error)}`, {
        action,
        duration_ms: Date.now() - startedAt,
        ...context,
        error,
        error_details: error?.details && typeof error.details === "object" ? error.details : {}
      });
      throw error;
    }
  });
}

async function handleAppPluginProtocol(request) {
  try {
    const url = new URL(request.url);
    const resource = appPluginRegistry.resolveResource(url.hostname, url.pathname);
    const body = await fs.promises.readFile(resource.path);
    return new Response(body, {
      status: 200,
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
        "content-security-policy": [
          "default-src 'none'",
          "script-src codexpro-plugin: 'unsafe-inline' 'unsafe-eval'",
          "style-src codexpro-plugin: https: 'unsafe-inline'",
          "img-src codexpro-plugin: data: blob: https:",
          "font-src codexpro-plugin: data: https:",
          "connect-src codexpro-plugin: http: https: ws: wss:",
          "media-src codexpro-plugin: data: blob: https:",
          "worker-src codexpro-plugin: blob:"
        ].join("; "),
        "content-type": resource.mime_type,
        "x-content-type-options": "nosniff"
      }
    });
  } catch (error) {
    return new Response(`Không tải được plugin: ${error?.message || error}`, {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff"
      }
    });
  }
}
void pruneDiagnosticLogs(codexProHome).catch((error) => console.error("[manager-diagnostic-prune]", error?.message || error));
const tokenFileDefault = path.join(codexProHome, "http-token");
const managerProjectsFile = path.join(codexProHome, "manager-projects.json");
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const platformLabel = isWindows ? "Windows" : isMac ? "macOS" : process.platform;
const managerSettingsFile = path.join(codexProHome, "manager-settings.json");
const apiWorkerStore = createApiWorkerStore({ home: codexProHome, safeStorage });
workerPluginRegistry.register(createApiWorkerPlugin({
  listConfigurations: () => apiWorkerStore.list(),
  onUpdate: queueWorkerUpdate,
  createProvider: async ({ config }) => createProviderForApiWorker(config),
  createMcpClients: async ({ workerId }) => {
    const base = await readyRuntimeBaseStatus();
    if (!base.local?.ok) throw new Error("Local CodexPro MCP is offline; API worker cannot start.");
    return await createWorkerMcpClients({
      url: `http://127.0.0.1:${base.config.port}/mcp`,
      token: base.token,
      workerId
    });
  }
}));
const globalRulesFile = path.join(codexProHome, "CODEXPRO.md");
const managerChatCacheFile = path.join(codexProHome, "manager-chat-cache.json");
const managerAssetsDir = path.join(codexProHome, "manager-assets");
const managerChatLayoutLogFile = path.join(codexProHome, "manager-chat-layout.jsonl");
const managerChatLayoutPreviousLogFile = path.join(codexProHome, "manager-chat-layout.previous.jsonl");
const managerChatResponseAuditLogFile = path.join(codexProHome, "manager-chat-response-audit.jsonl");
const managerChatResponseAuditPreviousLogFile = path.join(codexProHome, "manager-chat-response-audit.previous.jsonl");
const MAX_CHAT_LAYOUT_LOG_BYTES = 2 * 1024 * 1024;
const MAX_CHAT_LAYOUT_LOG_ENTRY_BYTES = 32 * 1024;
let managerChatLayoutLogWrite = Promise.resolve();
const MAX_CHAT_RESPONSE_AUDIT_LOG_BYTES = 4 * 1024 * 1024;
const MAX_CHAT_RESPONSE_AUDIT_LOG_ENTRY_BYTES = 48 * 1024;
let managerChatResponseAuditLogWrite = Promise.resolve();
const MAX_CHAT_CACHE_ENTRIES = 30;
const MAX_CHAT_CACHE_MESSAGES = 12;
const MAX_CHAT_CACHE_TEXT_CHARS = 40000;
let managerChatCacheEntries = null;
let managerChatCacheIndex = null;
const MAX_REQUEST_ATTACHMENTS = 4;
const MAX_REQUEST_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_ATTACHMENTS_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_TEXT_PREVIEW_BYTES = 512 * 1024;
const MAX_GLOBAL_RULES_CHARS = 30000;
const DEFAULT_GLOBAL_RULES = `# CodexPro Global Rules

<!-- Rule trong file này áp dụng cho mọi repo/dự án được thao tác qua MCP CodexPro. -->
<!-- Thêm hoặc sửa rule bên dưới. Không lưu password, token hoặc API key trong file này. -->

- Đọc và tuân thủ file này trước khi đọc rule riêng của từng repo/dự án.
- Rule riêng của repo có thể bổ sung chi tiết nhưng không được âm thầm bỏ qua rule toàn cục này.
`;

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

const WORKER_EXTENSION_VERSION = "0.5.103";
const RUNTIME_BASE_CACHE_MS = 10000;
const RUNTIME_BASE_FAILURE_CACHE_MS = 500;
const RUNTIME_HEALTH_TIMEOUT_MS = 5500;
const SCHEDULED_TASK_CACHE_MS = 10 * 1000;
const REPO_SCAN_CACHE_MS = 10 * 60 * 1000;
const GIT_SUMMARY_CACHE_MS = 2 * 60 * 1000;
const GIT_SUMMARY_CACHE_RETENTION_MS = 30 * 60 * 1000;
const REPO_SCAN_MAX_DIRECTORIES = 50000;
const REPO_SCAN_MAX_DEPTH = 12;
const REPO_SCAN_TIMEOUT_MS = 12000;
let runtimeBaseCache = null;
let runtimeBasePromise = null;
let runtimeFreshnessPromise = null;
let runtimeFreshnessRetryTimer = null;
let scheduledTaskCache = null;
let scheduledTaskPromise = null;
const runtimeHealthDiagnosticTracker = createRuntimeHealthDiagnosticTracker();
const runtimeRestartGuard = createRuntimeRestartGuard({ sendCooldownMs: 30_000 });
const responseQueue = createMcpResponseQueue({
  maxConcurrent: 3,
  maxBackgroundConcurrent: 2,
  maxQueued: 64,
  onEvent: (event) => {
    if (event.type === "started" && Number(event.queue_wait_ms) >= 1_000) {
      diagnostic("warn", "manager", "queue", `MCP response đợi queue ${event.queue_wait_ms} ms`, {
        action: "response-queue-wait",
        response_queue_key: event.key,
        priority: event.priority,
        queue_wait_ms: event.queue_wait_ms,
        queue_active: event.active,
        queue_background_active: event.backgroundActive,
        queue_pending: event.queued,
        queue_coalesced: event.coalesced
      });
    } else if (event.type === "coalesced" && diagnosticAllowed(`response-queue-coalesced:${event.key}`, 10_000)) {
      diagnostic("info", "manager", "queue", "Đã gộp request polling phản hồi trùng nhau", {
        action: "response-queue-coalesced",
        response_queue_key: event.key,
        priority: event.priority,
        queue_active: event.active,
        queue_background_active: event.backgroundActive,
        queue_pending: event.queued,
        queue_coalesced: event.coalesced
      });
    } else if (event.type === "rejected") {
      diagnostic("error", "manager", "queue", "MCP response queue đã đầy", {
        action: "response-queue-full",
        response_queue_key: event.key,
        priority: event.priority,
        queue_active: event.active,
        queue_background_active: event.backgroundActive,
        queue_pending: event.queued,
        error_code: event.error_code
      });
    }
  }
});
let repoScanCache = null;
let repoScanPromise = null;
const headlessExtensionRoot = app.isPackaged
  ? path.join(process.resourcesPath, "chrome-extension")
  : path.resolve(here, "..", "..", "chrome-extension");
const headlessWorkers = createHeadlessWorkerManager({
  codexProHome,
  extensionRoot: headlessExtensionRoot,
  getBrowserProfiles: async () => {
    const base = await runtimeBaseStatus();
    if (!base.local.ok) throw new Error("Local MCP chưa sẵn sàng để kiểm tra Chrome profile nguồn.");
    return await listBrowserProfilesThroughMcp(base.config, base.token);
  },
  setSourceProfileLock: async (profileId, headlessWorkerId = "") => {
    const base = await runtimeBaseStatus();
    if (!base.local.ok) throw new Error("Local MCP chưa sẵn sàng để khóa ChatGPT trên profile nguồn.");
    return await localMcpTool(base.config, base.token, "browser_control", {
      action: "set_headless_lock",
      profile_id: profileId,
      headless_worker_id: String(headlessWorkerId || "").trim()
    }, 10000);
  },
  clearSourceProfileLock: async (profileId, headlessWorkerId = "") => {
    const base = await runtimeBaseStatus();
    if (!base.local.ok) return { ok: false, locked: true };
    return await localMcpTool(base.config, base.token, "browser_control", {
      action: "clear_headless_lock",
      profile_id: profileId,
      headless_worker_id: String(headlessWorkerId || "").trim()
    }, 10000);
  }
});

async function syncInstalledWorkerExtension() {
  try {
    const result = await syncUnpackedCodexProExtensions({
      sourceRoot: headlessExtensionRoot,
      targetVersion: WORKER_EXTENSION_VERSION,
      codexProHome
    });
    if (result.synced.length) {
      diagnostic("info", "manager", "worker", `Đã đồng bộ worker extension lên ${WORKER_EXTENSION_VERSION}`, {
        action: "sync-worker-extension-files",
        source_root: result.sourceRoot,
        source_version: result.sourceVersion,
        target_version: result.targetVersion,
        synced_paths: result.synced.map((item) => item.path),
        backup_dir: result.backupDir || ""
      });
    }
    return result;
  } catch (error) {
    diagnostic("error", "manager", "worker", `Không thể đồng bộ worker extension lên ${WORKER_EXTENSION_VERSION}`, {
      action: "sync-worker-extension-files",
      source_root: headlessExtensionRoot,
      target_version: WORKER_EXTENSION_VERSION,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
const gitSummaryCache = new Map();
const gitSummaryPromises = new Map();

function versionAtLeast(version, target = WORKER_EXTENSION_VERSION) {
  const current = String(version || "").split(".").map(Number);
  const required = String(target || "").split(".").map(Number);
  const length = Math.max(current.length, required.length);
  for (let index = 0; index < length; index += 1) {
    const left = Number.isFinite(current[index]) ? current[index] : 0;
    const right = Number.isFinite(required[index]) ? required[index] : 0;
    if (left !== right) return left > right;
  }
  return true;
}

function appendManagerChatLayoutLog(payload) {
  let line = "";
  try {
    line = JSON.stringify({ loggedAt: new Date().toISOString(), ...(payload && typeof payload === "object" ? payload : {}) });
  } catch {
    return;
  }
  if (Buffer.byteLength(line, "utf8") > MAX_CHAT_LAYOUT_LOG_ENTRY_BYTES) return;
  managerChatLayoutLogWrite = managerChatLayoutLogWrite.then(async () => {
    await fs.promises.mkdir(codexProHome, { recursive: true });
    try {
      const stat = await fs.promises.stat(managerChatLayoutLogFile);
      if (stat.size >= MAX_CHAT_LAYOUT_LOG_BYTES) {
        await fs.promises.rm(managerChatLayoutPreviousLogFile, { force: true });
        await fs.promises.rename(managerChatLayoutLogFile, managerChatLayoutPreviousLogFile);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.promises.appendFile(managerChatLayoutLogFile, line + "\n", "utf8");
  }).catch((error) => {
    console.error("[manager-chat-layout]", error?.message || error);
    diagnostic("error", "manager", "logging", `Không ghi được chat layout log: ${error?.message || String(error)}`, { action: "write-chat-layout-log", error });
  });
}

function appendManagerChatResponseAuditLog(payload) {
  let line = "";
  try {
    line = JSON.stringify({ loggedAt: new Date().toISOString(), ...(payload && typeof payload === "object" ? payload : {}) });
  } catch {
    return;
  }
  if (Buffer.byteLength(line, "utf8") > MAX_CHAT_RESPONSE_AUDIT_LOG_ENTRY_BYTES) return;
  managerChatResponseAuditLogWrite = managerChatResponseAuditLogWrite.then(async () => {
    await fs.promises.mkdir(codexProHome, { recursive: true });
    try {
      const stat = await fs.promises.stat(managerChatResponseAuditLogFile);
      if (stat.size >= MAX_CHAT_RESPONSE_AUDIT_LOG_BYTES) {
        await fs.promises.rm(managerChatResponseAuditPreviousLogFile, { force: true });
        await fs.promises.rename(managerChatResponseAuditLogFile, managerChatResponseAuditPreviousLogFile);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.promises.appendFile(managerChatResponseAuditLogFile, line + "\n", "utf8");
  }).catch((error) => {
    console.error("[manager-chat-response-audit]", error?.message || error);
    diagnostic("error", "manager", "logging", `Không ghi được response audit log: ${error?.message || String(error)}`, { action: "write-chat-response-audit-log", error });
  });
}

const responseAuditDiagnosticState = new Map();

function responseAuditFingerprintSummary(value) {
  if (!value || typeof value !== "object") return null;
  return {
    fingerprint: String(value.fingerprint || ""),
    length: Number(value.length) || 0
  };
}

function recordChatResponseAuditDiagnostic(payload) {
  const record = payload && typeof payload === "object" ? payload : {};
  const comparison = String(record.comparison || "");
  const profileId = String(record.profileId || "");
  const conversationId = String(record.conversationId || "");
  if (!profileId || !conversationId || !comparison) return;
  const key = `${profileId}:${conversationId}`;
  const previous = responseAuditDiagnosticState.get(key);
  responseAuditDiagnosticState.set(key, comparison);
  if (previous === comparison) return;
  if (comparison === "match") {
    if (previous && previous !== "match") {
      diagnostic("info", "renderer", "chat-audit", "Nội dung Manager đã khớp lại với nguồn ChatGPT", {
        action: "chat-response-audit-recovered",
        profile_id: profileId,
        conversation_id: conversationId,
        request_id: String(record.requestId || ""),
        previous_comparison: previous,
        fetch_mode: String(record.fetchMode || ""),
        selected_source: String(record.selectedSource || ""),
        comparison_basis: String(record.comparisonBasis || "")
      });
    }
    return;
  }
  const terminal = ["completed", "failed", "cancelled"].includes(String(record.networkState || "").toLowerCase());
  const actionable = [
    "missing_in_manager_state",
    "manager_state_mismatch",
    "missing_in_manager_ui",
    "manager_ui_mismatch"
  ].includes(comparison) || (terminal && ["source_unavailable", "source_missing_latest_assistant"].includes(comparison));
  if (!actionable) return;
  const basis = record?.sources?.chatgptDom?.available
    ? record.sources.chatgptDom
    : record?.sources?.canonical?.available
      ? record.sources.canonical
      : record?.sources?.networkStream || {};
  diagnostic(comparison.includes("missing_in_manager") || comparison.includes("mismatch") ? "error" : "warn", "renderer", "chat-audit", `Sai lệch phản hồi ChatGPT: ${comparison}`, {
    action: "chat-response-audit-mismatch",
    profile_id: profileId,
    conversation_id: conversationId,
    request_id: String(record.requestId || ""),
    comparison,
    fetch_mode: String(record.fetchMode || ""),
    network_state: String(record.networkState || ""),
    selected_source: String(record.selectedSource || ""),
    comparison_basis: String(record.comparisonBasis || ""),
    source_message_count: Number(basis?.messageCount) || 0,
    manager_state_message_count: Number(record?.managerState?.messageCount) || 0,
    manager_ui_message_count: Number(record?.managerUi?.messageCount) || 0,
    expected_assistant: responseAuditFingerprintSummary(basis?.assistantAfterLatestUser || basis?.latestAssistant),
    manager_state_assistant: responseAuditFingerprintSummary(record?.managerState?.assistantAfterLatestUser || record?.managerState?.latestAssistant),
    manager_ui_assistant: responseAuditFingerprintSummary(record?.managerUi?.assistantAfterLatestUser || record?.managerUi?.latestAssistant)
  });
}

function mimeTypeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
    ".js": "text/javascript", ".jsx": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
    ".html": "text/html", ".css": "text/css", ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml",
    ".pdf": "application/pdf", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".zip": "application/zip"
  })[extension] || "application/octet-stream";
}

function requestFileSummary(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Không phải file hợp lệ: ${path.basename(resolved)}`);
  const mimeType = mimeTypeForFile(resolved);
  let previewDataUrl = "";
  if (mimeType.startsWith("image/")) {
    try {
      const image = nativeImage.createFromPath(resolved);
      if (!image.isEmpty()) {
        const { width, height } = image.getSize();
        const longest = Math.max(width, height, 1);
        const scale = Math.min(1, 96 / longest);
        const thumbnail = scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(width * scale)),
              height: Math.max(1, Math.round(height * scale)),
              quality: "good"
            })
          : image;
        previewDataUrl = thumbnail.toDataURL();
      }
    } catch {
      previewDataUrl = "";
    }
  }
  return { path: resolved, name: path.basename(resolved), size: stat.size, mimeType, previewDataUrl };
}

function canPreviewRequestFileAsText(mimeType) {
  return String(mimeType || "").startsWith("text/")
    || ["application/json", "application/xml", "application/yaml"].includes(String(mimeType || ""));
}

async function requestFilePreview(filePath) {
  const summary = requestFileSummary(filePath);
  if (summary.size > MAX_REQUEST_ATTACHMENT_BYTES) throw new Error("File lớn quá 8 MB nên không thể xem trước.");
  if (summary.mimeType.startsWith("image/")) {
    const bytes = await fs.promises.readFile(summary.path);
    return {
      kind: "image",
      name: summary.name,
      size: summary.size,
      mimeType: summary.mimeType,
      dataUrl: `data:${summary.mimeType};base64,${bytes.toString("base64")}`
    };
  }
  if (canPreviewRequestFileAsText(summary.mimeType)) {
    const handle = await fs.promises.open(summary.path, "r");
    try {
      const bytesToRead = Math.min(summary.size, MAX_REQUEST_TEXT_PREVIEW_BYTES);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      return {
        kind: "text",
        name: summary.name,
        size: summary.size,
        mimeType: summary.mimeType,
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated: summary.size > bytesRead
      };
    } finally {
      await handle.close();
    }
  }
  return { kind: "unsupported", name: summary.name, size: summary.size, mimeType: summary.mimeType };
}
async function chooseRequestFiles() {
  const result = await dialog.showOpenDialog({
    title: "Chọn file gửi cùng yêu cầu",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Tài liệu, mã nguồn và hình ảnh", extensions: ["txt", "md", "csv", "json", "js", "jsx", "ts", "tsx", "html", "css", "xml", "yaml", "yml", "pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg", "gif", "webp", "zip"] },
      { name: "Tất cả file", extensions: ["*"] }
    ]
  });
  if (result.canceled) return [];
  if (result.filePaths.length > MAX_REQUEST_ATTACHMENTS) throw new Error("Mỗi yêu cầu được đính kèm tối đa 4 file.");
  const files = result.filePaths.map(requestFileSummary);
  if (files.some((file) => file.size > MAX_REQUEST_ATTACHMENT_BYTES)) throw new Error("Mỗi file được tối đa 8 MB.");
  if (files.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_ATTACHMENTS_TOTAL_BYTES) throw new Error("Tổng file đính kèm được tối đa 10 MB.");
  return files;
}

async function materializeApiWorkerRequest(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const text = String(source.text || source.request || "").trim().slice(0, 20_000);
  const requestedFiles = Array.isArray(source.attachments) ? source.attachments.slice(0, MAX_REQUEST_ATTACHMENTS) : [];
  if (!text && !requestedFiles.length) throw new Error("Hãy nhập yêu cầu hoặc chọn ít nhất một file.");
  const files = requestedFiles.map((file) => requestFileSummary(file?.path));
  if (files.some((file) => file.size > MAX_REQUEST_ATTACHMENT_BYTES)) throw new Error("Mỗi file được tối đa 8 MB.");
  if (files.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_ATTACHMENTS_TOTAL_BYTES) throw new Error("Tổng file đính kèm được tối đa 10 MB.");

  const content = [{ type: "text", text: text || "Hãy xử lý các file đính kèm theo yêu cầu phù hợp với nội dung của chúng." }];
  for (const file of files) {
    if (file.mimeType.startsWith("image/")) {
      const bytes = await fs.promises.readFile(file.path);
      content.push({ type: "image_url", image_url: { url: `data:${file.mimeType};base64,${bytes.toString("base64")}` } });
      continue;
    }
    if (canPreviewRequestFileAsText(file.mimeType)) {
      const bytes = await fs.promises.readFile(file.path);
      const attachmentText = bytes.subarray(0, MAX_REQUEST_TEXT_PREVIEW_BYTES).toString("utf8");
      content[0].text += `\n\n<attachment name="${file.name}" mime="${file.mimeType}">\n${attachmentText}${bytes.length > MAX_REQUEST_TEXT_PREVIEW_BYTES ? "\n[Đã cắt bớt nội dung file; dùng MCP để đọc tiếp.]" : ""}\n</attachment>`;
      continue;
    }
    content[0].text += `\n\nFile đính kèm: ${file.name} (${file.mimeType}) tại ${file.path}. Hãy dùng MCP trong workspace đã khóa để đọc file này.`;
  }
  return { ...source, text, attachments: undefined, attachment_names: files.map((file) => file.name), messages: [{ role: "user", content }] };
}

const MANAGER_FONT_CHOICES = new Set(["system", "be-vietnam-pro", "manrope", "jetbrains-mono", "arial", "tahoma", "verdana", "trebuchet", "georgia", "cascadia"]);
const MANAGER_WORKING_BORDER_STYLES = new Set(["shine", "beam"]);
const WORKER_IMAGE_STATES = new Set(["idle", "working", "hung"]);
const WORKER_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_WORKER_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_WORKER_IMAGE_PACKS = 20;
const DEFAULT_WORKER_PACK_ID = "default";
const BUILT_IN_WORKER_PACK_IDS = new Set([DEFAULT_WORKER_PACK_ID, "co-sinh-vien-dam-dang"]);

function emptyWorkerImages() {
  return { idle: "", working: "", hung: "" };
}

function normalizeWorkerImages(value) {
  return {
    idle: String(value?.idle || ""),
    working: String(value?.working || ""),
    hung: String(value?.hung || "")
  };
}

function normalizeWorkerPacks(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((pack) => {
    const id = String(pack?.id || "").trim();
    const name = String(pack?.name || "").trim().slice(0, 60);
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(id) || BUILT_IN_WORKER_PACK_IDS.has(id) || !name || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name, images: normalizeWorkerImages(pack?.images) }];
  }).slice(0, MAX_WORKER_IMAGE_PACKS);
}

const ALL_ALLOWED_WORKSPACES = "__codexpro_all_allowed__";

function normalizeGlobalRules(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").slice(0, MAX_GLOBAL_RULES_CHARS);
}

function readGlobalRulesFile() {
  try {
    return normalizeGlobalRules(fs.readFileSync(globalRulesFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") return DEFAULT_GLOBAL_RULES;
    fs.mkdirSync(codexProHome, { recursive: true });
    fs.writeFileSync(globalRulesFile, DEFAULT_GLOBAL_RULES, "utf8");
    return DEFAULT_GLOBAL_RULES;
  }
}

function writeGlobalRulesFile(value) {
  const rules = normalizeGlobalRules(value);
  fs.mkdirSync(codexProHome, { recursive: true });
  fs.writeFileSync(globalRulesFile, rules.endsWith("\n") || !rules ? rules : `${rules}\n`, "utf8");
  return rules;
}

function defaultManagerSettings() {
  return {
    chatWidth: 940,
    chatHeight: 330,
    fontFamily: "system",
    headingFontFamily: "inherit",
    monoFontFamily: "inherit",
    fontSize: 14,
    fontWeight: 400,
    profileLayout: "rows",
    profileCardHeight: 390,
    workingBorderStyle: "shine",
    maxSubagents: 1,
    autoRecovery: false,
    autoUpdateWorkers: false,
    taskNotifications: true,
    globalRules: readGlobalRulesFile(),
    repoSelections: {},
    selectedWorkerPackId: DEFAULT_WORKER_PACK_ID,
    workerImagePacks: [],
    workerImages: emptyWorkerImages()
  };
}

function readManagerSettings() {
  const defaults = defaultManagerSettings();
  try {
    const parsed = JSON.parse(fs.readFileSync(managerSettingsFile, "utf8"));
    const legacyImages = normalizeWorkerImages(parsed?.workerImages);
    const hasLegacyImages = Object.values(legacyImages).some(Boolean);
    const workerImagePacks = normalizeWorkerPacks(parsed?.workerImagePacks);
    if (!workerImagePacks.length && hasLegacyImages) {
      workerImagePacks.push({ id: "legacy-custom", name: "Bộ tùy chỉnh hiện tại", images: legacyImages });
    }
    const requestedPackId = String(parsed?.selectedWorkerPackId || "");
    const selectedWorkerPackId = BUILT_IN_WORKER_PACK_IDS.has(requestedPackId) || workerImagePacks.some((pack) => pack.id === requestedPackId)
      ? requestedPackId
      : (workerImagePacks[0]?.id || DEFAULT_WORKER_PACK_ID);
    const selectedPack = workerImagePacks.find((pack) => pack.id === selectedWorkerPackId);
    return {
      chatWidth: Math.max(720, Math.min(1600, Number(parsed?.chatWidth) || defaults.chatWidth)),
      chatHeight: Math.max(180, Math.min(700, Number(parsed?.chatHeight) || defaults.chatHeight)),
      fontFamily: MANAGER_FONT_CHOICES.has(String(parsed?.fontFamily || "")) ? String(parsed.fontFamily) : defaults.fontFamily,
      headingFontFamily: parsed?.headingFontFamily === "inherit" || MANAGER_FONT_CHOICES.has(String(parsed?.headingFontFamily || "")) ? String(parsed.headingFontFamily) : defaults.headingFontFamily,
      monoFontFamily: parsed?.monoFontFamily === "inherit" || MANAGER_FONT_CHOICES.has(String(parsed?.monoFontFamily || "")) ? String(parsed.monoFontFamily) : defaults.monoFontFamily,
      fontSize: Math.max(12, Math.min(18, Number(parsed?.fontSize) || defaults.fontSize)),
      fontWeight: Math.max(400, Math.min(700, Math.round((Number(parsed?.fontWeight) || defaults.fontWeight) / 100) * 100)),
      profileLayout: parsed?.profileLayout === "cards" ? "cards" : defaults.profileLayout,
      profileCardHeight: Math.max(390, Math.min(760, Math.round((Number(parsed?.profileCardHeight) || defaults.profileCardHeight) / 10) * 10)),
      workingBorderStyle: MANAGER_WORKING_BORDER_STYLES.has(String(parsed?.workingBorderStyle || "")) ? String(parsed.workingBorderStyle) : defaults.workingBorderStyle,
      maxSubagents: Math.max(1, Math.min(1, Number(parsed?.maxSubagents) || defaults.maxSubagents)),
      autoRecovery: parsed?.autoRecovery === true,
      autoUpdateWorkers: parsed?.autoUpdateWorkers === true,
      taskNotifications: parsed?.taskNotifications !== false,
      globalRules: readGlobalRulesFile(),
      repoSelections: Object.fromEntries(Object.entries(parsed?.repoSelections && typeof parsed.repoSelections === "object" ? parsed.repoSelections : {})
        .filter(([profileId, root]) => /^[A-Za-z0-9._-]{1,160}$/.test(profileId) && typeof root === "string" && root.trim())
        .slice(0, 40)
        .map(([profileId, root]) => [profileId, root === ALL_ALLOWED_WORKSPACES ? ALL_ALLOWED_WORKSPACES : path.resolve(root)])),
      selectedWorkerPackId,
      workerImagePacks,
      workerImages: selectedPack ? { ...selectedPack.images } : emptyWorkerImages()
    };
  } catch {
    return defaults;
  }
}

function writeManagerSettings(settings) {
  fs.mkdirSync(codexProHome, { recursive: true });
  const { globalRules, ...storedSettings } = settings;
  writeGlobalRulesFile(globalRules);
  fs.writeFileSync(managerSettingsFile, `${JSON.stringify(storedSettings, null, 2)}\n`, "utf8");
}

function chatCacheKey(profileId, conversationId) {
  return `${profileId}:${conversationId}`;
}

function normalizeChatCacheMessage(message, index) {
  const role = message?.role === "user" ? "user" : message?.role === "assistant" ? "assistant" : "";
  const text = String(message?.text || "").trim().slice(0, MAX_CHAT_CACHE_TEXT_CHARS);
  if (!role || !text) return null;
  return {
    id: String(message?.id || `${role}-${index}`).slice(0, 220),
    role,
    text,
    truncated: Boolean(message?.truncated),
    pending: Boolean(message?.pending),
    uncertain: Boolean(message?.uncertain),
    provisional: Boolean(message?.provisional),
    endTurn: message?.endTurn === true ? true : message?.endTurn === false ? false : null,
    submissionState: ["pending", "submitted", "uncertain"].includes(String(message?.submissionState || "")) ? String(message.submissionState) : "",
    createdAt: String(message?.createdAt || "").slice(0, 80)
  };
}

function normalizeChatCacheEntry(value) {
  const profileId = String(value?.profileId || "").trim();
  const conversationId = String(value?.conversationId || "").trim();
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(profileId) || !/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) return null;
  const messages = (Array.isArray(value?.messages) ? value.messages : [])
    .map(normalizeChatCacheMessage)
    .filter(Boolean)
    .slice(-MAX_CHAT_CACHE_MESSAGES);
  const text = String(value?.text || "").trim().slice(0, MAX_CHAT_CACHE_TEXT_CHARS);
  if (!messages.length && !text) return null;
  return {
    profileId,
    conversationId,
    messages,
    text,
    truncated: Boolean(value?.truncated),
    networkCompletedAt: String(value?.networkCompletedAt || "").slice(0, 80),
    networkState: String(value?.networkState || "").slice(0, 32),
    responseReady: Boolean(value?.responseReady),
    responseSource: String(value?.responseSource || "").slice(0, 80),
    messageCount: Math.max(0, Math.floor(Number(value?.messageCount) || 0)),
    totalMessageCount: Math.max(0, Math.floor(Number(value?.totalMessageCount) || 0)),
    updatedAt: String(value?.updatedAt || new Date().toISOString()).slice(0, 80)
  };
}

function setManagerChatCacheMemory(entries) {
  const normalized = entries.map(normalizeChatCacheEntry).filter(Boolean).slice(-MAX_CHAT_CACHE_ENTRIES);
  managerChatCacheEntries = normalized;
  managerChatCacheIndex = new Map(normalized.map((entry) => [chatCacheKey(entry.profileId, entry.conversationId), entry]));
  return normalized;
}

function readManagerChatCache() {
  if (managerChatCacheEntries && managerChatCacheIndex) return managerChatCacheEntries;
  try {
    const parsed = JSON.parse(fs.readFileSync(managerChatCacheFile, "utf8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return setManagerChatCacheMemory(entries);
  } catch {
    return setManagerChatCacheMemory([]);
  }
}

function writeManagerChatCache(entries) {
  fs.mkdirSync(codexProHome, { recursive: true });
  const normalized = setManagerChatCacheMemory(entries);
  fs.writeFileSync(managerChatCacheFile, `${JSON.stringify({ version: 1, entries: normalized }, null, 2)}\n`, "utf8");
}

function getManagerChatCacheEntry(payload) {
  const profileId = String(payload?.profileId || "").trim();
  const conversationId = String(payload?.conversationId || "").trim();
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(profileId) || !/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) return null;
  const key = chatCacheKey(profileId, conversationId);
  readManagerChatCache();
  return managerChatCacheIndex.get(key) || null;
}

function saveManagerChatCacheEntry(payload) {
  const entry = normalizeChatCacheEntry(payload);
  if (!entry) return null;
  const key = chatCacheKey(entry.profileId, entry.conversationId);
  const entries = readManagerChatCache().filter((candidate) => chatCacheKey(candidate.profileId, candidate.conversationId) !== key);
  const saved = { ...entry, updatedAt: new Date().toISOString() };
  entries.push(saved);
  writeManagerChatCache(entries);
  return saved;
}

function imageDataUrl(filePath) {
  if (!filePath) return "";
  try {
    const resolved = path.resolve(filePath);
    const extension = path.extname(resolved).toLowerCase();
    if (!WORKER_IMAGE_EXTENSIONS.has(extension)) return "";
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_WORKER_IMAGE_BYTES) return "";
    const mimeType = mimeTypeForFile(resolved);
    return `data:${mimeType};base64,${fs.readFileSync(resolved).toString("base64")}`;
  } catch {
    return "";
  }
}

function managerSettingsPayload() {
  const settings = readManagerSettings();
  const workerImagePacks = settings.workerImagePacks.map((pack) => ({
    ...pack,
    images: { ...pack.images },
    imageDataUrls: {
      idle: imageDataUrl(pack.images.idle),
      working: imageDataUrl(pack.images.working),
      hung: imageDataUrl(pack.images.hung)
    }
  }));
  return {
    ...settings,
    workerImagePacks,
    workerImageDataUrls: {
      idle: imageDataUrl(settings.workerImages.idle),
      working: imageDataUrl(settings.workerImages.working),
      hung: imageDataUrl(settings.workerImages.hung)
    }
  };
}

function saveManagerSettingsPatch(patch = {}) {
  const current = readManagerSettings();
  const next = {
    ...current,
    workerImages: { ...current.workerImages },
    workerImagePacks: current.workerImagePacks.map((pack) => ({ ...pack, images: { ...pack.images } }))
  };
  if (Object.prototype.hasOwnProperty.call(patch, "chatWidth")) {
    next.chatWidth = Math.max(720, Math.min(1600, Number(patch.chatWidth) || current.chatWidth));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "chatHeight")) {
    next.chatHeight = Math.max(180, Math.min(700, Number(patch.chatHeight) || current.chatHeight));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "fontFamily") && MANAGER_FONT_CHOICES.has(String(patch.fontFamily))) {
    next.fontFamily = String(patch.fontFamily);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "headingFontFamily") && (patch.headingFontFamily === "inherit" || MANAGER_FONT_CHOICES.has(String(patch.headingFontFamily)))) {
    next.headingFontFamily = String(patch.headingFontFamily);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "monoFontFamily") && (patch.monoFontFamily === "inherit" || MANAGER_FONT_CHOICES.has(String(patch.monoFontFamily)))) {
    next.monoFontFamily = String(patch.monoFontFamily);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "fontSize")) {
    next.fontSize = Math.max(12, Math.min(18, Number(patch.fontSize) || current.fontSize));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "fontWeight")) {
    next.fontWeight = Math.max(400, Math.min(700, Math.round((Number(patch.fontWeight) || current.fontWeight) / 100) * 100));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "profileLayout")) {
    next.profileLayout = patch.profileLayout === "cards" ? "cards" : "rows";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "profileCardHeight")) {
    next.profileCardHeight = Math.max(390, Math.min(760, Math.round((Number(patch.profileCardHeight) || current.profileCardHeight) / 10) * 10));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "workingBorderStyle") && MANAGER_WORKING_BORDER_STYLES.has(String(patch.workingBorderStyle))) {
    next.workingBorderStyle = String(patch.workingBorderStyle);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "maxSubagents")) {
    next.maxSubagents = Math.max(1, Math.min(1, Number(patch.maxSubagents) || current.maxSubagents));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "autoRecovery")) next.autoRecovery = patch.autoRecovery === true;
  if (Object.prototype.hasOwnProperty.call(patch, "autoUpdateWorkers")) next.autoUpdateWorkers = patch.autoUpdateWorkers === true;
  if (Object.prototype.hasOwnProperty.call(patch, "taskNotifications")) next.taskNotifications = patch.taskNotifications !== false;
  if (Object.prototype.hasOwnProperty.call(patch, "globalRules")) {
    next.globalRules = normalizeGlobalRules(patch.globalRules);
  }
  if (patch?.repoSelections && typeof patch.repoSelections === "object") {
    next.repoSelections = { ...(current.repoSelections || {}) };
    for (const [profileId, root] of Object.entries(patch.repoSelections)) {
      if (!/^[A-Za-z0-9._-]{1,160}$/.test(profileId)) continue;
      if (typeof root === "string" && root.trim()) next.repoSelections[profileId] = root === ALL_ALLOWED_WORKSPACES ? ALL_ALLOWED_WORKSPACES : path.resolve(root);
      else delete next.repoSelections[profileId];
    }
  }
  writeManagerSettings(next);
  return managerSettingsPayload();
}

function findWorkerPack(settings, packId) {
  const normalizedPackId = String(packId || "");
  if (BUILT_IN_WORKER_PACK_IDS.has(normalizedPackId)) throw new Error("Hãy tạo một bộ ảnh riêng trước khi tải ảnh lên.");
  const pack = settings.workerImagePacks.find((item) => item.id === normalizedPackId);
  if (!pack) throw new Error("Không tìm thấy bộ ảnh worker.");
  return pack;
}

function createWorkerImagePack(name) {
  const normalizedName = String(name || "").trim().slice(0, 60);
  if (!normalizedName) throw new Error("Tên bộ ảnh không được để trống.");
  const settings = readManagerSettings();
  if (settings.workerImagePacks.length >= MAX_WORKER_IMAGE_PACKS) throw new Error(`Chỉ được tạo tối đa ${MAX_WORKER_IMAGE_PACKS} bộ ảnh worker.`);
  const id = `pack-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  settings.workerImagePacks.push({ id, name: normalizedName, images: emptyWorkerImages() });
  settings.selectedWorkerPackId = id;
  settings.workerImages = emptyWorkerImages();
  writeManagerSettings(settings);
  return managerSettingsPayload();
}

function selectWorkerImagePack(packId) {
  const settings = readManagerSettings();
  const normalizedPackId = String(packId || "");
  const builtIn = BUILT_IN_WORKER_PACK_IDS.has(normalizedPackId);
  const pack = builtIn
    ? null
    : settings.workerImagePacks.find((item) => item.id === normalizedPackId);
  if (!builtIn && !pack) throw new Error("Không tìm thấy bộ ảnh worker.");
  settings.selectedWorkerPackId = normalizedPackId;
  settings.workerImages = pack ? { ...pack.images } : emptyWorkerImages();
  writeManagerSettings(settings);
  return managerSettingsPayload();
}

function removeManagedWorkerImage(filePath) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) === path.resolve(managerAssetsDir)) fs.rmSync(resolved, { force: true });
}

function deleteWorkerImagePack(packId) {
  const settings = readManagerSettings();
  const normalizedPackId = String(packId || "");
  const index = settings.workerImagePacks.findIndex((pack) => pack.id === normalizedPackId);
  if (index < 0) throw new Error("Không tìm thấy bộ ảnh worker.");
  const [removed] = settings.workerImagePacks.splice(index, 1);
  Object.values(removed.images).forEach(removeManagedWorkerImage);
  if (settings.selectedWorkerPackId === normalizedPackId) {
    settings.selectedWorkerPackId = DEFAULT_WORKER_PACK_ID;
    settings.workerImages = emptyWorkerImages();
  }
  writeManagerSettings(settings);
  return managerSettingsPayload();
}

async function chooseWorkerImage(packId, state) {
  const normalizedState = String(state || "");
  if (!WORKER_IMAGE_STATES.has(normalizedState)) throw new Error("Trạng thái worker không hợp lệ.");
  const settings = readManagerSettings();
  const pack = findWorkerPack(settings, packId);
  const result = await dialog.showOpenDialog({
    title: `Chọn ảnh worker ${normalizedState}`,
    properties: ["openFile"],
    filters: [{ name: "Ảnh worker", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]
  });
  if (result.canceled || !result.filePaths[0]) return managerSettingsPayload();
  const source = path.resolve(result.filePaths[0]);
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error("Ảnh worker không hợp lệ.");
  if (stat.size > MAX_WORKER_IMAGE_BYTES) throw new Error("Ảnh worker được tối đa 10 MB.");
  const extension = path.extname(source).toLowerCase();
  if (!WORKER_IMAGE_EXTENSIONS.has(extension)) throw new Error("Chỉ hỗ trợ PNG, JPG, GIF hoặc WEBP.");
  fs.mkdirSync(managerAssetsDir, { recursive: true });
  const previousPath = pack.images[normalizedState];
  const destination = path.join(managerAssetsDir, `worker-${pack.id}-${normalizedState}${extension}`);
  if (path.resolve(source) !== path.resolve(destination)) {
    for (const candidate of fs.readdirSync(managerAssetsDir, { withFileTypes: true })) {
      if (candidate.isFile() && candidate.name.startsWith(`worker-${pack.id}-${normalizedState}.`)) {
        fs.rmSync(path.join(managerAssetsDir, candidate.name), { force: true });
      }
    }
    fs.copyFileSync(source, destination);
  }
  if (previousPath && path.resolve(previousPath) !== path.resolve(destination)) removeManagedWorkerImage(previousPath);
  pack.images[normalizedState] = destination;
  settings.selectedWorkerPackId = pack.id;
  settings.workerImages = { ...pack.images };
  writeManagerSettings(settings);
  return managerSettingsPayload();
}

function resetWorkerImage(packId, state) {
  const normalizedState = String(state || "");
  if (!WORKER_IMAGE_STATES.has(normalizedState)) throw new Error("Trạng thái worker không hợp lệ.");
  const settings = readManagerSettings();
  const pack = findWorkerPack(settings, packId);
  const currentPath = pack.images[normalizedState];
  pack.images[normalizedState] = "";
  settings.selectedWorkerPackId = pack.id;
  settings.workerImages = { ...pack.images };
  writeManagerSettings(settings);
  removeManagedWorkerImage(currentPath);
  return managerSettingsPayload();
}

function resetManagerSettings() {
  const current = readManagerSettings();
  for (const pack of current.workerImagePacks || []) Object.values(pack.images || {}).forEach(removeManagedWorkerImage);
  const defaults = { ...defaultManagerSettings(), repoSelections: { ...(current.repoSelections || {}) } };
  writeManagerSettings(defaults);
  return managerSettingsPayload();
}

async function clipboardImagePng() {
  if (typeof clipboard.readImage === "function") {
    const image = await Promise.resolve(clipboard.readImage());
    if (!image?.isEmpty?.()) return image.toPNG();
  }
  if (typeof clipboard.read === "function") {
    const items = await clipboard.read();
    for (const item of items || []) {
      const imageType = (item.types || []).find((type) => /^image\/(png|jpeg|jpg|webp)$/i.test(type));
      if (imageType) {
        const blob = await item.getType(imageType);
        if (blob instanceof Blob) {
          const buffer = Buffer.from(await blob.arrayBuffer());
          if (/^image\/png$/i.test(imageType)) return buffer;
          const image = nativeImage.createFromBuffer(buffer);
          if (!image.isEmpty()) return image.toPNG();
        }
      }
      if ((item.types || []).includes("text/uri-list")) {
        const blob = await item.getType("text/uri-list");
        if (!(blob instanceof Blob)) continue;
        const urls = (await blob.text()).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        for (const url of urls) {
          if (!url.startsWith("file://")) continue;
          const filePath = fileURLToPath(url);
          if (!/\.(png|jpe?g|gif|webp)$/i.test(filePath) || !fs.existsSync(filePath)) continue;
          const image = nativeImage.createFromBuffer(await fs.promises.readFile(filePath));
          if (!image.isEmpty()) return image.toPNG();
        }
      }
    }
  }
  return null;
}

async function captureClipboardImage() {
  const png = await clipboardImagePng();
  if (!png?.length) return null;
  if (png.length > MAX_REQUEST_ATTACHMENT_BYTES) throw new Error("Ảnh trong clipboard lớn quá 8 MB.");
  const directory = path.join(app.getPath("temp"), "codexpro-manager", "clipboard-images");
  await fs.promises.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `clipboard-${Date.now()}-${randomBytes(4).toString("hex")}.png`);
  await fs.promises.writeFile(filePath, png, { flag: "wx" });
  return requestFileSummary(filePath);
}

const browserProfileStreamControllers = new WeakMap();
let latestBrowserProfileStream = { connected: false, checkedAt: "", profiles: [] };
let lastBrowserProfileStreamErrorAt = 0;
const browserProfileDiagnosticState = new Map();

function activeBrowserTaskSummaries() {
  return (Array.isArray(latestBrowserProfileStream?.profiles) ? latestBrowserProfileStream.profiles : [])
    .filter((profile) => {
      const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
      return ["working", "completing"].includes(String(profile?.activity || "").toLowerCase())
        || tabs.some((tab) => tab?.busy || tab?.settling || String(tab?.network_state || "").toLowerCase() === "generating");
    })
    .map((profile) => ({
      task_id: String(profile?.current_task_id || ""),
      task_title: String(profile?.current_task_title || profile?.active_chat_title || "Task CodexPro"),
      workspace: String(profile?.current_workspace_root || "")
    }));
}

function profileDiagnosticSnapshot(profile) {
  const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
  const incidentTab = tabs.find((tab) => tab?.renderer_unresponsive || tab?.connection_interrupted || tab?.message_delivery_timed_out || String(tab?.network_state || "").toLowerCase() === "failed" || tab?.network_error) || null;
  const incidentConversationId = String(incidentTab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
  return {
    connected: Boolean(profile?.connected),
    extension_version: String(profile?.extension_version || ""),
    connector_installed: Boolean(profile?.connector_installed),
    connector_profile_bound: profile?.connector_profile_bound !== false,
    connector_update_required: Boolean(profile?.connector_update_required),
    connector_message: String(profile?.connector_message || "").slice(0, 500),
    connector_checked_at: String(profile?.connector_checked_at || "").slice(0, 64),
    renderer_unresponsive: Boolean(profile?.renderer_unresponsive || tabs.some((tab) => tab?.renderer_unresponsive)),
    connection_interrupted: tabs.some((tab) => tab?.connection_interrupted),
    message_delivery_timed_out: tabs.some((tab) => tab?.message_delivery_timed_out),
    network_failed: tabs.some((tab) => String(tab?.network_state || "").toLowerCase() === "failed" || tab?.network_error),
    incident_conversation_id: incidentConversationId,
    incident_tab_id: String(incidentTab?.id || ""),
    renderer_error: String(incidentTab?.renderer_error || ""),
    network_state: String(incidentTab?.network_state || ""),
    network_status_code: Number(incidentTab?.network_status_code) || 0,
    network_error: String(incidentTab?.network_error || ""),
    activity: String(profile?.activity || "idle"),
    task_id: String(profile?.current_task_id || ""),
    task_title: String(profile?.current_task_title || "").trim(),
    tab_count: Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs.length : 0
  };
}

function recordBrowserProfileTransitions(profiles, checkedAt) {
  const nextIds = new Set();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const profileId = String(profile?.profile_id || "").trim();
    if (!profileId) continue;
    nextIds.add(profileId);
    const current = profileDiagnosticSnapshot(profile);
    const previous = browserProfileDiagnosticState.get(profileId);
    const details = {
      action: "profile-state-transition",
      profile_id: profileId,
      checked_at: String(checkedAt || ""),
      ...current,
      ...(previous ? {
        previous_connector_installed: previous.connector_installed,
        previous_connector_profile_bound: previous.connector_profile_bound,
        previous_connector_update_required: previous.connector_update_required,
        previous_connector_message: previous.connector_message,
        previous_connector_checked_at: previous.connector_checked_at
      } : {})
    };
    if (previous) {
      if (previous.connected && !current.connected) {
        diagnostic("warn", "browser", "profile", "Chrome profile mất heartbeat", details);
      } else if (!previous.connected && current.connected) {
        diagnostic("info", "browser", "profile", "Chrome profile đã kết nối lại", details);
      }
      if (!previous.renderer_unresponsive && current.renderer_unresponsive) {
        diagnostic("error", "browser", "profile", "Chrome renderer không phản hồi", details);
      } else if (previous.renderer_unresponsive && !current.renderer_unresponsive) {
        diagnostic("info", "browser", "profile", "Chrome renderer đã phản hồi lại", details);
      }
      if (!previous.connection_interrupted && current.connection_interrupted) {
        diagnostic("warn", "browser", "chat", "ChatGPT báo Connection interrupted", {
          ...details,
          action: "chat-connection-interrupted",
          incident_fingerprint: `chat-connection-interrupted:${profileId}:${current.incident_conversation_id || "unknown"}`
        });
      } else if (previous.connection_interrupted && !current.connection_interrupted) {
        diagnostic("info", "browser", "chat", "ChatGPT đã hết trạng thái Connection interrupted", details);
      }
      if (!previous.message_delivery_timed_out && current.message_delivery_timed_out) {
        diagnostic("error", "browser", "chat", "ChatGPT báo Message delivery timed out", details);
      } else if (previous.message_delivery_timed_out && !current.message_delivery_timed_out) {
        diagnostic("info", "browser", "chat", "ChatGPT đã hết trạng thái Message delivery timed out", details);
      }
      if (!previous.network_failed && current.network_failed) {
        diagnostic("error", "browser", "network", "ChatGPT generation chuyển sang trạng thái lỗi", details);
      } else if (previous.network_failed && !current.network_failed) {
        diagnostic("info", "browser", "network", "ChatGPT generation đã thoát trạng thái lỗi", details);
      }
      if (previous.extension_version && current.extension_version && previous.extension_version !== current.extension_version) {
        diagnostic("info", "browser", "profile", `Worker extension đổi từ ${previous.extension_version} sang ${current.extension_version}`, details);
      }
      if (previous.connector_installed && !current.connector_installed) {
        diagnostic("warn", "browser", "profile", "CodexPro connector bị hạ xuống chưa xác minh", details);
      } else if (!previous.connector_installed && current.connector_installed) {
        diagnostic("info", "browser", "profile", "CodexPro connector đã được xác minh", details);
      }
      if (previous.connector_profile_bound && !current.connector_profile_bound) {
        diagnostic("warn", "browser", "profile", "CodexPro connector không còn khớp profile", details);
      } else if (!previous.connector_profile_bound && current.connector_profile_bound) {
        diagnostic("info", "browser", "profile", "CodexPro connector đã khớp lại profile", details);
      }
      if (!previous.connector_update_required && current.connector_update_required) {
        diagnostic("warn", "browser", "profile", "CodexPro connector cần cập nhật endpoint", details);
      } else if (previous.connector_update_required && !current.connector_update_required) {
        diagnostic("info", "browser", "profile", "CodexPro connector đã cập nhật endpoint", details);
      }
      if (current.task_title && current.task_title !== previous.task_title) {
        diagnostic("info", "browser", "task", "Profile đã nhận task title", details);
      }
    }
    const workingWithoutTitle = current.activity === "working" && !current.task_title;
    const previouslyMissingSameTask = previous?.activity === "working" && !previous?.task_title && previous?.task_id === current.task_id;
    if (workingWithoutTitle && !previouslyMissingSameTask) {
      diagnostic("warn", "browser", "task", "Profile đang làm việc nhưng chưa có task title", details);
    }
    browserProfileDiagnosticState.set(profileId, current);
  }
  for (const [profileId, previous] of browserProfileDiagnosticState.entries()) {
    if (nextIds.has(profileId)) continue;
    diagnostic("info", "browser", "profile", "Chrome profile đã rời danh sách realtime", {
      action: "profile-removed-from-stream",
      profile_id: profileId,
      checked_at: String(checkedAt || ""),
      ...previous
    });
    browserProfileDiagnosticState.delete(profileId);
  }
}

function cachedBrowserProfileForSend(profileId) {
  if (!latestBrowserProfileStream.connected) return null;
  return latestBrowserProfileStream.profiles.find((profile) => profile?.profile_id === profileId && profile?.connected) || null;
}

function startBrowserProfileEventStream(win) {
  browserProfileStreamControllers.get(win)?.abort();
  const controller = new AbortController();
  browserProfileStreamControllers.set(win, controller);
  win.once("closed", () => controller.abort());
  void (async () => {
    while (!controller.signal.aborted && !win.isDestroyed()) {
      try {
        const base = await runtimeBaseStatus();
        if (!base.local.ok) throw new Error("CodexPro local server is offline.");
        const response = await fetch(`http://127.0.0.1:${base.config.port}/browser-events`, {
          headers: base.token ? { authorization: `Bearer ${base.token}` } : {},
          signal: controller.signal
        });
        if (!response.ok || !response.body) throw new Error(`Browser event stream HTTP ${response.status}`);
        if (!latestBrowserProfileStream.connected && lastBrowserProfileStreamErrorAt) {
          diagnostic("info", "manager", "profile", "Luồng realtime profile đã kết nối lại", { action: "browser-profile-stream-recovered" });
          lastBrowserProfileStreamErrorAt = 0;
        }
        latestBrowserProfileStream = { ...latestBrowserProfileStream, connected: true };
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted && !win.isDestroyed()) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary).replace(/\r/g, "");
            buffer = buffer.slice(boundary + 2);
            const data = frame.split("\n").filter((line) => line.startsWith("data:" )).map((line) => line.slice(5).trim()).join("\n");
            if (!data) continue;
            const payload = JSON.parse(data);
            if (Array.isArray(payload?.profiles)) {
              latestBrowserProfileStream = { connected: true, checkedAt: String(payload.checked_at || ""), profiles: payload.profiles };
              recordBrowserProfileTransitions(payload.profiles, payload.checked_at);
              void headlessWorkers.enforceExclusiveUse(payload.profiles).catch((error) => {
                if (diagnosticAllowed(`headless-exclusive-stream:${String(error?.message || error).slice(0, 160)}`, 30_000)) {
                  diagnostic("warn", "manager", "worker", `Luồng realtime không áp được khóa độc quyền headless: ${error?.message || String(error)}`, {
                    action: "headless-exclusive-stream",
                    error
                  });
                }
              });
            }
            if (!win.isDestroyed()) win.webContents.send("codexpro:browser-profiles", payload);
          }
        }
      } catch (error) {
        latestBrowserProfileStream = { ...latestBrowserProfileStream, connected: false };
        if (controller.signal.aborted || win.isDestroyed()) break;
        const now = Date.now();
        if (!lastBrowserProfileStreamErrorAt || now - lastBrowserProfileStreamErrorAt >= 60_000) {
          diagnostic("warn", "manager", "profile", `Luồng realtime profile bị ngắt: ${error?.message || String(error)}`, {
            action: "browser-profile-stream-disconnected",
            error
          });
          lastBrowserProfileStreamErrorAt = now;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  })();
}

function createWindow() {
  const smokeMode = process.env.CODEXPRO_MANAGER_SMOKE === "1";
  const diagnosticSmokeMode = smokeMode && process.env.CODEXPRO_MANAGER_SMOKE_PAGE === "logs";
  const controlSmokeMode = smokeMode && process.env.CODEXPRO_MANAGER_SMOKE_PAGE === "control";
  const win = new BrowserWindow({
    width: smokeMode && !diagnosticSmokeMode ? 1900 : 1240,
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
  let unresponsiveAt = 0;
  win.on("unresponsive", () => {
    unresponsiveAt = Date.now();
    diagnostic("error", "electron", "window", "Cửa sổ Manager không phản hồi", { action: "window-unresponsive" });
  });
  win.on("responsive", () => {
    if (!unresponsiveAt) return;
    diagnostic("info", "electron", "window", "Cửa sổ Manager đã phản hồi lại", {
      action: "window-responsive",
      duration_ms: Date.now() - unresponsiveAt
    });
    unresponsiveAt = 0;
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame && errorCode === -3) return;
    diagnostic("error", "electron", "window", `Manager page load thất bại: ${errorDescription || errorCode}`, {
      action: "did-fail-load",
      error_code: errorCode,
      error_description: String(errorDescription || ""),
      url: String(validatedUrl || ""),
      is_main_frame: Boolean(isMainFrame)
    });
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    diagnostic("error", "electron", "window", `Manager preload thất bại: ${error?.message || String(error)}`, {
      action: "preload-error",
      preload_path: String(preloadPath || ""),
      error
    });
  });
  win.webContents.on("console-message", (_event, detailsOrLevel, legacyMessage, legacyLine, legacySourceId) => {
    const details = detailsOrLevel && typeof detailsOrLevel === "object"
      ? detailsOrLevel
      : { level: detailsOrLevel, message: legacyMessage, lineNumber: legacyLine, sourceId: legacySourceId };
    const level = String(details?.level || "").toLowerCase();
    const numericLevel = Number(details?.level);
    const isError = level === "error" || numericLevel >= 3;
    const isWarning = level === "warning" || level === "warn" || numericLevel === 2;
    if (!isError && !isWarning) return;
    const message = String(details?.message || "Renderer console message");
    const key = `renderer-console:${level}:${String(details?.sourceId || "")}:${message.slice(0, 180)}`;
    if (!diagnosticAllowed(key, 30_000)) return;
    diagnostic(isError ? "error" : "warn", "renderer", "runtime", `Renderer console: ${message}`, {
      action: "renderer-console",
      console_level: level || numericLevel,
      line_number: Number(details?.lineNumber) || 0,
      column_number: Number(details?.columnNumber) || 0,
      source_id: String(details?.sourceId || "")
    });
  });
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
  else void win.loadFile(path.join(here, "..", "dist", "index.html"), process.env.CODEXPRO_MANAGER_SMOKE_PAGE === "requests" ? { query: { page: "requests" } } : undefined);
  win.webContents.on("did-finish-load", () => startBrowserProfileEventStream(win));

  if (smokeMode) {
    win.webContents.once("did-finish-load", async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 2800));
        const bridge = await win.webContents.executeJavaScript("typeof window.codexpro", true);
        if (bridge !== "object") throw new Error(`Preload bridge unavailable: ${bridge}`);
        const status = await win.webContents.executeJavaScript("window.codexpro.getStatus().then((value) => JSON.parse(JSON.stringify(value)))", true);
        if (Array.isArray(status?.browserProfiles) && status.browserProfiles.length) {
          win.webContents.send("codexpro:browser-profiles", { checked_at: status.checkedAt, profiles: status.browserProfiles });
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        const projects = await win.webContents.executeJavaScript("window.codexpro.listProjects().then((value) => JSON.parse(JSON.stringify(value)))", true);
        if (controlSmokeMode) {
          const controlPageClicked = await win.webContents.executeJavaScript(`(() => {
            const button = [...document.querySelectorAll('nav button')].find((item) => /Điều phối/i.test(item.textContent || ''));
            button?.click();
            return Boolean(button);
          })()`, true);
          if (!controlPageClicked) throw new Error("Smoke không tìm thấy màn Điều phối.");
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        let inspection = null;
        if (status.local?.ok && projects[0]?.root) {
          inspection = await win.webContents.executeJavaScript(`window.codexpro.inspectProject(${JSON.stringify(projects[0].root)})`, true);
        }
        let inspectionUiProbe = null;
        if (process.env.CODEXPRO_MANAGER_SMOKE_INSPECTION === "1" && projects[0]?.root) {
          const inspectionClicked = await win.webContents.executeJavaScript(`(() => {
            const button = [...document.querySelectorAll('button')].find((item) => /Kiểm tra qua MCP/i.test(item.textContent || ''));
            button?.scrollIntoView({ block: 'center' });
            button?.click();
            return Boolean(button);
          })()`, true);
          if (!inspectionClicked) throw new Error("Smoke không tìm thấy nút Kiểm tra qua MCP.");
          const inspectionDeadline = Date.now() + 30000;
          while (Date.now() < inspectionDeadline) {
            inspectionUiProbe = await win.webContents.executeJavaScript(`(() => {
              const modal = document.querySelector('.codexgraph-modal');
              const shell = modal?.querySelector('.codexgraph-shell');
              const stage = modal?.querySelector('.codexgraph-stage');
              const sigma = modal?.querySelector('.codexgraph-sigma');
              const canvas = sigma?.querySelector('canvas');
              const metrics = [...(modal?.querySelectorAll('.codexgraph-metrics strong') || [])].map((node) => node.textContent?.trim() || '');
              const rect = (node) => node ? { width: Math.round(node.getBoundingClientRect().width), height: Math.round(node.getBoundingClientRect().height) } : null;
              return {
                open: Boolean(modal),
                shell: Boolean(shell),
                canvas: Boolean(canvas),
                modal: rect(modal),
                stage: rect(stage),
                sigma: rect(sigma),
                metrics,
                warning: modal?.querySelector('.codexgraph-warning')?.textContent?.trim() || '',
                title: modal?.querySelector('.codexgraph-summary h3')?.textContent?.trim() || '',
                toolbar: Boolean(modal?.querySelector('.codexgraph-toolbar')),
                detail: Boolean(modal?.querySelector('.codexgraph-detail'))
              };
            })()`, true);
            if (inspectionUiProbe?.open && inspectionUiProbe?.shell && inspectionUiProbe?.canvas) break;
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          if (!inspectionUiProbe?.open || !inspectionUiProbe?.shell || !inspectionUiProbe?.canvas) {
            throw new Error(`CodexGraph modal chưa render đầy đủ: ${JSON.stringify(inspectionUiProbe)}`);
          }
        }
        let settingsProbe = null;
        const fontRolesSmokeRequested = process.env.CODEXPRO_MANAGER_SMOKE_FONT_ROLES === "1";
        const settingsSmokeRequested = process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS === "1" || process.env.CODEXPRO_MANAGER_SMOKE_PAGE === "settings" || fontRolesSmokeRequested;
        if (settingsSmokeRequested) {
          const beforeSettings = await win.webContents.executeJavaScript("window.codexpro.getManagerSettings().then((value) => JSON.parse(JSON.stringify(value)))", true);
          let workerPackProbe = null;
          await win.webContents.executeJavaScript(`(() => {
            const button = [...document.querySelectorAll('nav button')].find((item) => /cài đặt/i.test(item.textContent || ''));
            button?.click();
            return Boolean(button);
          })()`, true);
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (fontRolesSmokeRequested) {
            await win.webContents.executeJavaScript(`(async () => { const choose = async (index, matcher) => { const row = [...document.querySelectorAll('.font-setting-row')][index]; const trigger = row?.querySelector('.app-dropdown-trigger'); if (!trigger) throw new Error('Thiếu dropdown font role ' + index); trigger.click(); await new Promise((resolve) => setTimeout(resolve, 100)); const liveRow = [...document.querySelectorAll('.font-setting-row')][index]; const option = [...(liveRow?.querySelectorAll('.app-dropdown-option') || [])].find((item) => matcher.test(item.textContent || '')); if (!option) throw new Error('Thiếu lựa chọn font role ' + index); option.click(); await new Promise((resolve) => setTimeout(resolve, 180)); }; await choose(0, /Be Vietnam Pro/i); await choose(1, /Manrope/i); await choose(2, /JetBrains Mono/i); })()`, true);
            await new Promise((resolve) => setTimeout(resolve, 650));
          }
          if (process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS === "1") {
            workerPackProbe = await win.webContents.executeJavaScript(`(async () => {
              const created = await window.codexpro.createWorkerImagePack('CodexPro smoke pack');
              const pack = created.workerImagePacks.find((item) => item.name === 'CodexPro smoke pack');
              if (!pack || created.selectedWorkerPackId !== pack.id) throw new Error('Không tạo/chọn được worker pack');
              const selectedBuiltIn = await window.codexpro.selectWorkerImagePack('co-sinh-vien-dam-dang');
              if (selectedBuiltIn.selectedWorkerPackId !== 'co-sinh-vien-dam-dang') throw new Error('Không đổi được sang worker pack sinh viên tích hợp');
              const selectedDefault = await window.codexpro.selectWorkerImagePack('default');
              if (selectedDefault.selectedWorkerPackId !== 'default') throw new Error('Không đổi về worker pack mặc định');
              const removed = await window.codexpro.deleteWorkerImagePack(pack.id);
              return {
                ok: removed.selectedWorkerPackId === 'default' && !removed.workerImagePacks.some((item) => item.id === pack.id),
                builtInSelected: selectedBuiltIn.selectedWorkerPackId,
                createdId: pack.id,
                finalCount: removed.workerImagePacks.length
              };
            })()`, true);
            await win.webContents.executeJavaScript(`(async () => {
              await window.codexpro.saveManagerSettings({ maxSubagents: 8, globalRules: '# CodexPro Global Rules\\n\\n- smoke-global-rule\\n', headingFontFamily: 'manrope', monoFontFamily: 'jetbrains-mono', fontWeight: 500 });
              const range = document.querySelector('.settings-range:not(.chat-height-range):not(.font-weight-range)');
              const heightRange = document.querySelector('.chat-height-range');
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              if (range) {
                setter?.call(range, '1180');
                range.dispatchEvent(new Event('input', { bubbles: true }));
                range.dispatchEvent(new Event('change', { bubbles: true }));
                range.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
              }
              if (heightRange) {
                setter?.call(heightRange, '520');
                heightRange.dispatchEvent(new Event('input', { bubbles: true }));
                heightRange.dispatchEvent(new Event('change', { bubbles: true }));
                heightRange.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
              const layoutTrigger = document.querySelector('.profile-layout-select .app-dropdown-trigger');
              layoutTrigger?.click();
              await new Promise((resolve) => setTimeout(resolve, 80));
              const cards = [...document.querySelectorAll('.profile-layout-select .app-dropdown-option')].find((item) => /Thẻ dọc/i.test(item.textContent || ''));
              cards?.click();
              await new Promise((resolve) => setTimeout(resolve, 120));
              const borderTrigger = document.querySelector('.profile-border-style-select .app-dropdown-trigger');
              borderTrigger?.click();
              await new Promise((resolve) => setTimeout(resolve, 80));
              const beam = [...document.querySelectorAll('.profile-border-style-select .app-dropdown-option')].find((item) => /Tia chạy quanh viền/i.test(item.textContent || ''));
              beam?.click();
              await new Promise((resolve) => setTimeout(resolve, 120));
              const trigger = document.querySelector('.font-setting-row .app-dropdown-trigger');
              trigger?.click();
              await new Promise((resolve) => setTimeout(resolve, 80));
              const bundledFont = [...document.querySelectorAll('.font-setting-row .app-dropdown-option')].find((item) => /Be Vietnam Pro/i.test(item.textContent || ''));
              bundledFont?.click();
            })()`, true);
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
          const afterSettings = await win.webContents.executeJavaScript("window.codexpro.getManagerSettings().then((value) => JSON.parse(JSON.stringify(value)))", true);
          let chatModalWidth = 0;
          let chatResponseHeight = 0;
          if (process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS === "1") {
            const chatButtonFound = await win.webContents.executeJavaScript(`(() => {
              const button = document.querySelector('.profile-chat:not(:disabled)');
              button?.click();
              return Boolean(button);
            })()`, true);
            if (chatButtonFound) {
              await new Promise((resolve) => setTimeout(resolve, 350));
              chatModalWidth = await win.webContents.executeJavaScript("Math.round(document.querySelector('.chat-modal')?.getBoundingClientRect().width || 0)", true);
              chatResponseHeight = await win.webContents.executeJavaScript("Math.round(document.querySelector('.chat-modal .chat-response.is-inline')?.getBoundingClientRect().height || 0)", true);
              await win.webContents.executeJavaScript("document.querySelector('.chat-modal-head > button')?.click()", true);
              await new Promise((resolve) => setTimeout(resolve, 120));
            }
          }
          const uiSettings = await win.webContents.executeJavaScript(`(() => {
            const settingsView = document.querySelector('.settings-view');
            const main = document.querySelector('main');
            const profileCard = document.querySelector('.profile-list.is-card-layout .browser-profile');
            const previewBeam = document.querySelector('.profile-layout-preview.working-border-beam .profile-layout-preview-item.is-working > .worker-active-border');
            const previewBeamStyle = previewBeam ? getComputedStyle(previewBeam) : null;
            const previewBeamHeadStyle = previewBeam ? getComputedStyle(previewBeam, '::before') : null;
            return {
              settingsVisible: !settingsView?.hidden,
              rangeValue: document.querySelector('.settings-range:not(.chat-height-range)')?.value || '',
              heightRangeValue: document.querySelector('.chat-height-range')?.value || '',
              numberValue: document.querySelector('input[aria-label="Độ rộng popup chat"]')?.value || '',
              heightNumberValue: document.querySelector('input[aria-label="Chiều cao khung chat bên trong"]')?.value || '',
              subagentValue: document.querySelector('.subagent-limit-field input')?.value || '',
              globalRulesValue: document.querySelector('.global-rules-editor')?.value || '',
              fontValue: document.querySelectorAll('.font-setting-row .app-dropdown-value-copy strong')?.[0]?.textContent?.trim() || '',
              headingFontValue: document.querySelectorAll('.font-setting-row .app-dropdown-value-copy strong')?.[1]?.textContent?.trim() || '',
              monoFontValue: document.querySelectorAll('.font-setting-row .app-dropdown-value-copy strong')?.[2]?.textContent?.trim() || '',
              fontWeightValue: document.querySelector('.font-weight-range')?.value || '',
              profileLayoutValue: document.querySelector('.profile-layout-select .app-dropdown-value-copy strong')?.textContent?.trim() || '',
              profileLayoutClass: document.querySelector('.profile-list')?.className || '',
              workingBorderStyleValue: document.querySelector('.profile-border-style-select .app-dropdown-value-copy strong')?.textContent?.trim() || '',
              previewBeamDisplay: previewBeamStyle?.display || '',
              previewBeamWidth: previewBeamHeadStyle?.width || '',
              previewBeamAnimation: previewBeamHeadStyle?.animationName || '',
              profileCardHeightValue: document.querySelector('input[aria-label="Chiều cao thẻ profile"]')?.value || '',
              profileCardHeightVar: document.querySelector('.app-shell')?.style.getPropertyValue('--profile-card-height') || '',
              profileCardMinHeight: profileCard ? Math.round(parseFloat(getComputedStyle(profileCard).minHeight) || 0) : 0,
              workerCards: document.querySelectorAll('.worker-setting-card').length,
              settingsWidth: Math.round(settingsView?.getBoundingClientRect().width || 0),
              mainContentWidth: Math.round((main?.clientWidth || 0) - 100),
              chatWidthVar: document.querySelector('.app-shell')?.style.getPropertyValue('--chat-modal-width') || '',
              chatHeightVar: document.querySelector('.app-shell')?.style.getPropertyValue('--chat-response-height') || '',
              fontVar: document.querySelector('.app-shell')?.style.getPropertyValue('--app-font-family') || '',
              headingFontVar: document.querySelector('.app-shell')?.style.getPropertyValue('--heading-font-family') || '',
              monoFontVar: document.querySelector('.app-shell')?.style.getPropertyValue('--mono-font-family') || '',
              bodyWeightVar: document.querySelector('.app-shell')?.style.getPropertyValue('--weight-body') || '',
              titleWeightVar: document.querySelector('.app-shell')?.style.getPropertyValue('--weight-title') || '',
              headingComputedFont: getComputedStyle(document.querySelector('.font-preview.is-title')).fontFamily,
              monoComputedFont: getComputedStyle(document.querySelector('.font-preview.is-mono')).fontFamily,
              bundledFontLoaded: document.fonts.check("400 14px 'Be Vietnam Pro'", 'Tiếng Việt Đặng Nguyễn Trường'),
              roleFontsLoaded: document.fonts.check("600 17px 'Manrope'", 'Tiêu đề giao diện') && document.fonts.check("400 12px 'JetBrains Mono'", 'cpt_task_id')
            };
          })()`, true);
          const fontRolesOk = !fontRolesSmokeRequested || (afterSettings.fontFamily === "be-vietnam-pro" && afterSettings.headingFontFamily === "manrope" && afterSettings.monoFontFamily === "jetbrains-mono" && /Be Vietnam Pro/i.test(uiSettings.fontValue) && /Manrope/i.test(uiSettings.headingFontValue) && /JetBrains Mono/i.test(uiSettings.monoFontValue) && uiSettings.bundledFontLoaded && uiSettings.roleFontsLoaded && /Be Vietnam Pro/i.test(uiSettings.fontVar) && /Manrope/i.test(uiSettings.headingFontVar) && /JetBrains Mono/i.test(uiSettings.monoFontVar) && /Manrope/i.test(uiSettings.headingComputedFont) && /JetBrains Mono/i.test(uiSettings.monoComputedFont));
          const profileCardHeightOk = process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS !== "1" || (afterSettings.profileCardHeight === Number(uiSettings.profileCardHeightValue) && uiSettings.profileCardHeightVar === `${afterSettings.profileCardHeight}px` && (!uiSettings.profileCardMinHeight || Math.abs(uiSettings.profileCardMinHeight - afterSettings.profileCardHeight) <= 2));
          const workingBorderStyleOk = process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS !== "1" || (afterSettings.workingBorderStyle === "beam" && /Tia chạy quanh viền/i.test(uiSettings.workingBorderStyleValue) && /working-border-beam/.test(uiSettings.profileLayoutClass) && uiSettings.previewBeamDisplay === "block" && parseFloat(uiSettings.previewBeamWidth) <= 44 && /worker-border-beam-move/.test(uiSettings.previewBeamAnimation));
          settingsProbe = {
            ok: fontRolesOk && profileCardHeightOk && workingBorderStyleOk && Boolean(uiSettings.settingsVisible) && Number(uiSettings.rangeValue) >= 720 && Number(uiSettings.heightRangeValue) >= 180 && uiSettings.workerCards === 3 && uiSettings.settingsWidth >= uiSettings.mainContentWidth - 4 && uiSettings.subagentValue === "1" && (process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS !== "1" || (workerPackProbe?.ok && afterSettings.maxSubagents === 1 && /smoke-global-rule/.test(afterSettings.globalRules || '') && /smoke-global-rule/.test(uiSettings.globalRulesValue || '') && afterSettings.chatWidth === 1180 && afterSettings.chatHeight === 520 && afterSettings.fontFamily === "be-vietnam-pro" && afterSettings.headingFontFamily === "manrope" && afterSettings.monoFontFamily === "jetbrains-mono" && afterSettings.profileLayout === "cards" && /Be Vietnam Pro/i.test(uiSettings.fontValue) && /Manrope/i.test(uiSettings.headingFontValue) && /JetBrains Mono/i.test(uiSettings.monoFontValue) && uiSettings.bundledFontLoaded && uiSettings.roleFontsLoaded && /Be Vietnam Pro/i.test(uiSettings.fontVar) && /Manrope/i.test(uiSettings.headingFontVar) && /JetBrains Mono/i.test(uiSettings.monoFontVar) && /Manrope/i.test(uiSettings.headingComputedFont) && /JetBrains Mono/i.test(uiSettings.monoComputedFont) && /Thẻ dọc/i.test(uiSettings.profileLayoutValue) && /is-card-layout/.test(uiSettings.profileLayoutClass) && uiSettings.numberValue === "1180" && uiSettings.heightNumberValue === "520" && (!chatModalWidth || Math.abs(chatModalWidth - 1180) <= 3) && (!chatResponseHeight || Math.abs(chatResponseHeight - 520) <= 3))),
            before: { maxSubagents: beforeSettings.maxSubagents, chatWidth: beforeSettings.chatWidth, chatHeight: beforeSettings.chatHeight, fontFamily: beforeSettings.fontFamily, headingFontFamily: beforeSettings.headingFontFamily, monoFontFamily: beforeSettings.monoFontFamily, profileLayout: beforeSettings.profileLayout, profileCardHeight: beforeSettings.profileCardHeight, workingBorderStyle: beforeSettings.workingBorderStyle },
            saved: { maxSubagents: afterSettings.maxSubagents, chatWidth: afterSettings.chatWidth, chatHeight: afterSettings.chatHeight, fontFamily: afterSettings.fontFamily, headingFontFamily: afterSettings.headingFontFamily, monoFontFamily: afterSettings.monoFontFamily, profileLayout: afterSettings.profileLayout, profileCardHeight: afterSettings.profileCardHeight, workingBorderStyle: afterSettings.workingBorderStyle },
            chatModalWidth,
            chatResponseHeight,
            ui: uiSettings,
            workerPackProbe
          };
          if (process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS === "1" || fontRolesSmokeRequested) {
            const restorePatch = process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS === "1"
              ? { maxSubagents: beforeSettings.maxSubagents, globalRules: beforeSettings.globalRules, chatWidth: beforeSettings.chatWidth, chatHeight: beforeSettings.chatHeight, fontFamily: beforeSettings.fontFamily, headingFontFamily: beforeSettings.headingFontFamily, monoFontFamily: beforeSettings.monoFontFamily, fontWeight: beforeSettings.fontWeight, profileLayout: beforeSettings.profileLayout, profileCardHeight: beforeSettings.profileCardHeight, workingBorderStyle: beforeSettings.workingBorderStyle }
              : { fontFamily: beforeSettings.fontFamily, headingFontFamily: beforeSettings.headingFontFamily, monoFontFamily: beforeSettings.monoFontFamily };
            await win.webContents.executeJavaScript(`window.codexpro.saveManagerSettings(${JSON.stringify(restorePatch)})`, true);
            const restoredSettings = await win.webContents.executeJavaScript("window.codexpro.getManagerSettings().then((value) => JSON.parse(JSON.stringify(value)))", true);
            settingsProbe.restored = { fontFamily: restoredSettings.fontFamily, headingFontFamily: restoredSettings.headingFontFamily, monoFontFamily: restoredSettings.monoFontFamily, profileCardHeight: restoredSettings.profileCardHeight, workingBorderStyle: restoredSettings.workingBorderStyle };
            settingsProbe.ok = settingsProbe.ok && restoredSettings.fontFamily === beforeSettings.fontFamily && restoredSettings.headingFontFamily === beforeSettings.headingFontFamily && restoredSettings.monoFontFamily === beforeSettings.monoFontFamily && (process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS !== "1" || (restoredSettings.profileCardHeight === beforeSettings.profileCardHeight && restoredSettings.workingBorderStyle === beforeSettings.workingBorderStyle));
          }
        }
        let diagnosticProbe = null;
        if (diagnosticSmokeMode) {
          const logPageClicked = await win.webContents.executeJavaScript(`(() => {
            const button = [...document.querySelectorAll('nav button')].find((item) => /nhật ký/i.test(item.textContent || ''));
            button?.click();
            return Boolean(button);
          })()`, true);
          if (!logPageClicked) throw new Error("Smoke không tìm thấy màn Nhật ký.");
          await new Promise((resolve) => setTimeout(resolve, 500));
          const dropdownOpened = await win.webContents.executeJavaScript(`(() => {
            const trigger = document.querySelector('.diagnostic-filter-trigger');
            trigger?.click();
            return Boolean(trigger);
          })()`, true);
          if (!dropdownOpened) throw new Error("Smoke không tìm thấy dropdown nhật ký custom.");
          await new Promise((resolve) => setTimeout(resolve, 180));
          diagnosticProbe = await win.webContents.executeJavaScript(`(() => {
            const panel = document.querySelector('.diagnostic-panel');
            const toolbar = document.querySelector('.diagnostic-toolbar');
            const filters = [...document.querySelectorAll('.diagnostic-filter-trigger')];
            const menu = document.querySelector('.diagnostic-filter-menu');
            const rect = (node) => node ? { left: Math.round(node.getBoundingClientRect().left), right: Math.round(node.getBoundingClientRect().right), top: Math.round(node.getBoundingClientRect().top), bottom: Math.round(node.getBoundingClientRect().bottom), width: Math.round(node.getBoundingClientRect().width), height: Math.round(node.getBoundingClientRect().height) } : null;
            const panelRect = rect(panel);
            const toolbarRect = rect(toolbar);
            const filterRects = filters.map(rect);
            return {
              visible: !document.querySelector('.diagnostic-page')?.hidden,
              customDropdownCount: filters.length,
              nativeSelectCount: document.querySelectorAll('.diagnostic-toolbar select').length,
              menuOpen: Boolean(menu),
              menuOptionCount: menu?.querySelectorAll('[role="option"]').length || 0,
              panel: panelRect,
              toolbar: toolbarRect,
              filters: filterRects,
              actions: rect(document.querySelector('.diagnostic-toolbar-actions')),
              noHorizontalOverflow: Boolean(panelRect && toolbarRect && toolbarRect.right <= panelRect.right + 1 && toolbarRect.left >= panelRect.left - 1 && filterRects.every((item) => item && item.right <= panelRect.right + 1))
            };
          })()`, true);
          if (!diagnosticProbe.visible || diagnosticProbe.customDropdownCount !== 4 || diagnosticProbe.nativeSelectCount !== 0 || !diagnosticProbe.menuOpen || diagnosticProbe.menuOptionCount < 4 || !diagnosticProbe.noHorizontalOverflow) {
            throw new Error(`Diagnostic dropdown smoke không đạt: ${JSON.stringify(diagnosticProbe)}`);
          }
        }
        const chatSmokeRequested = [
          process.env.CODEXPRO_MANAGER_SMOKE_CHAT_MODAL,
          process.env.CODEXPRO_MANAGER_SMOKE_RENAME,
          process.env.CODEXPRO_MANAGER_SMOKE_DROPDOWN,
          process.env.CODEXPRO_MANAGER_SMOKE_RESPONSE,
          process.env.CODEXPRO_MANAGER_SMOKE_COMPOSER_LAYOUT,
          process.env.CODEXPRO_MANAGER_SMOKE_SEND,
          process.env.CODEXPRO_MANAGER_SMOKE_PASTE_IMAGE,
          process.env.CODEXPRO_MANAGER_SMOKE_REALTIME_RESPONSE
        ].some((value) => value === "1");
        let chatModalProbe = null;
        if (chatSmokeRequested) {
          const preferredProfile = String(process.env.CODEXPRO_MANAGER_SMOKE_SCROLL_PROFILE || "").trim();
          const profileCardDeadline = Date.now() + 10_000;
          while (Date.now() < profileCardDeadline) {
            const profileCardsReady = await win.webContents.executeJavaScript("document.querySelectorAll('.browser-profile').length > 0", true);
            if (profileCardsReady) break;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          const clickProbe = await win.webContents.executeJavaScript(`(() => {
            const cards = [...document.querySelectorAll('.browser-profile')];
            const card = cards.find((item) => ${JSON.stringify(preferredProfile)} && item.querySelector('code')?.textContent?.includes(${JSON.stringify(preferredProfile)}))
              || cards.find((item) => !item.querySelector('.profile-chat')?.disabled);
            const button = card?.querySelector('.profile-chat:not(:disabled)');
            button?.click();
            return { cardFound: Boolean(card), buttonFound: Boolean(button), profile: card?.querySelector('code')?.textContent || '' };
          })()`, true);
          await new Promise((resolve) => setTimeout(resolve, 1400));
          chatModalProbe = await win.webContents.executeJavaScript(`(() => {
            const modal = document.querySelector('.chat-modal');
            const transcript = modal?.querySelector('.latest-response');
            const latestUser = [...(transcript?.querySelectorAll('.chat-transcript-message.is-user') || [])].at(-1);
            const scrollMetrics = (element) => element ? { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, distanceFromBottom: Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight) } : null;
            const latestUserRect = latestUser?.getBoundingClientRect();
            const transcriptRect = transcript?.getBoundingClientRect();
            const anchorTop = latestUserRect && transcriptRect ? latestUserRect.top - transcriptRect.top : null;
            const anchorCenter = anchorTop == null || !latestUserRect ? null : anchorTop + latestUserRect.height / 2;
            const anchorTarget = transcript ? transcript.clientHeight * 0.42 : null;
            return { open: Boolean(modal), profile: modal?.querySelector('.chat-modal-profile code')?.textContent || '', hasProjectDropdown: Boolean(modal?.querySelector('.project-dropdown')), selectedProject: modal?.querySelector('.project-dropdown-value strong')?.textContent?.trim() || '', hasChatSelector: Boolean(modal?.querySelector('.chat-dropdown, .chat-manage-actions')), hasResponse: Boolean(modal?.querySelector('.chat-response')), hasTextarea: Boolean(modal?.querySelector('textarea')), modalScroll: scrollMetrics(modal), transcriptScroll: scrollMetrics(transcript), turnAnchor: { active: Boolean(transcript?.classList.contains('has-turn-anchor')), latestUserTop: anchorTop == null ? null : Math.round(anchorTop), latestUserCenter: anchorCenter == null ? null : Math.round(anchorCenter), targetCenter: anchorTarget == null ? null : Math.round(anchorTarget), errorPx: anchorCenter == null || anchorTarget == null ? null : Math.round(anchorCenter - anchorTarget) } };
          })()`, true);
          chatModalProbe.click = clickProbe;
          await win.webContents.executeJavaScript("document.querySelector('.project-dropdown-trigger:not(:disabled)')?.click()", true);
          await new Promise((resolve) => setTimeout(resolve, 150));
          chatModalProbe.hasProjectSearch = await win.webContents.executeJavaScript("Boolean(document.querySelector('.project-dropdown-search input[type=search]'))", true);
          chatModalProbe.projectSearchStyle = await win.webContents.executeJavaScript(`(() => {
            const input = document.querySelector('.project-dropdown-search input[type=search]');
            if (!input) return null;
            input.focus();
            const style = getComputedStyle(input);
            return { borderWidth: style.borderWidth, boxShadow: style.boxShadow, outlineWidth: style.outlineWidth, backgroundColor: style.backgroundColor };
          })()`, true);
          await win.webContents.executeJavaScript("document.querySelector('.project-dropdown-trigger:not(:disabled)')?.click()", true);
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        let composerLayoutProbe = null;
        if (process.env.CODEXPRO_MANAGER_SMOKE_COMPOSER_LAYOUT === "1") {
          const readComposerLayout = () => win.webContents.executeJavaScript(`(() => {
            const modal = document.querySelector('.chat-modal');
            const card = modal?.querySelector('.chat-popup-card');
            const panel = card?.querySelector('.chat-response');
            const transcript = panel?.querySelector('.latest-response');
            const composer = card?.querySelector('.request-composer');
            const textarea = composer?.querySelector('textarea');
            const rect = (node) => node ? node.getBoundingClientRect() : null;
            const panelRect = rect(panel);
            const transcriptRect = rect(transcript);
            const composerRect = rect(composer);
            const textareaRect = rect(textarea);
            return {
              modalScrollTop: Math.round(modal?.scrollTop || 0),
              modalScrollHeight: Math.round(modal?.scrollHeight || 0),
              panelTop: panelRect ? Math.round(panelRect.top) : null,
              panelHeight: panelRect ? Math.round(panelRect.height) : null,
              transcriptTop: transcriptRect ? Math.round(transcriptRect.top) : null,
              transcriptHeight: transcriptRect ? Math.round(transcriptRect.height) : null,
              transcriptClientHeight: transcript?.clientHeight ?? null,
              transcriptScrollTop: Math.round(transcript?.scrollTop || 0),
              composerTop: composerRect ? Math.round(composerRect.top) : null,
              composerHeight: composerRect ? Math.round(composerRect.height) : null,
              textareaHeight: textareaRect ? Math.round(textareaRect.height) : null,
              textareaScrollHeight: textarea?.scrollHeight ?? null,
              draftLength: textarea?.value?.length || 0
            };
          })()`, true);
          const originalDraft = await win.webContents.executeJavaScript(`(() => {
            const textarea = document.querySelector('.chat-modal .request-composer textarea');
            if (!textarea || textarea.disabled) return null;
            textarea.focus({ preventScroll: true });
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            return textarea.value;
          })()`, true);
          if (originalDraft !== null) {
            const transcriptDeadline = Date.now() + 4000;
            while (Date.now() < transcriptDeadline) {
              const hasTranscript = await win.webContents.executeJavaScript("Boolean(document.querySelector('.chat-modal .chat-response .latest-response'))", true);
              if (hasTranscript) break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            const samples = [{ step: "focused", ...(await readComposerLayout()) }];
            for (const chunk of ["a", " bcdefghijklmnopqrstuvwxyz", " 0123456789".repeat(18)]) {
              win.webContents.insertText(chunk);
              await new Promise((resolve) => setTimeout(resolve, 140));
              samples.push({ step: `typed-${samples.length}`, ...(await readComposerLayout()) });
            }
            const noticePosition = await win.webContents.executeJavaScript(`(() => {
              const panel = document.querySelector('.chat-modal .chat-response');
              if (!panel) return '';
              const host = document.createElement('div');
              host.className = 'chat-response-notices qa-composer-layout-notice';
              host.innerHTML = '<div class="network-response-notice is-generating"><strong>QA network status</strong><span>Đang kiểm tra khung chat không đổi chiều cao khi status xuất hiện.</span></div>';
              panel.append(host);
              return getComputedStyle(host).position;
            })()`, true);
            await new Promise((resolve) => setTimeout(resolve, 160));
            samples.push({ step: "notice-added", ...(await readComposerLayout()) });
            await win.webContents.executeJavaScript("document.querySelector('.qa-composer-layout-notice')?.remove()", true);
            await new Promise((resolve) => setTimeout(resolve, 160));
            samples.push({ step: "notice-removed", ...(await readComposerLayout()) });
            const restored = await win.webContents.executeJavaScript(`(() => {
              const textarea = document.querySelector('.chat-modal .request-composer textarea');
              if (!textarea) return false;
              const oldValue = textarea.value;
              const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
              setter?.call(textarea, ${JSON.stringify(originalDraft)});
              if (textarea._valueTracker) textarea._valueTracker.setValue(oldValue);
              textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
              textarea.setSelectionRange(textarea.value.length, textarea.value.length);
              return textarea.value === ${JSON.stringify(originalDraft)};
            })()`, true);
            await new Promise((resolve) => setTimeout(resolve, 120));
            samples.push({ step: "restored", ...(await readComposerLayout()) });
            const baseline = samples[0];
            const stableGeometry = samples.every((sample) => (
              sample.panelHeight === baseline.panelHeight
              && sample.panelTop === baseline.panelTop
              && sample.modalScrollTop === baseline.modalScrollTop
              && sample.composerTop === baseline.composerTop
              && sample.composerHeight === baseline.composerHeight
              && sample.textareaHeight === baseline.textareaHeight
              && sample.transcriptClientHeight === baseline.transcriptClientHeight
              && sample.transcriptTop === baseline.transcriptTop
            ));
            composerLayoutProbe = {
              ok: Boolean(restored) && noticePosition === "absolute" && stableGeometry,
              noticePosition,
              stableGeometry,
              samples
            };
          } else composerLayoutProbe = { ok: false, error: "Không có textarea rảnh để test layout khi nhập." };
        }
        let renameProbe = null;
        if (process.env.CODEXPRO_MANAGER_SMOKE_RENAME === "1") {
          const renameTitle = String(process.env.CODEXPRO_MANAGER_SMOKE_RENAME_TITLE || "CodexPro rename UI probe").trim();
          renameProbe = await win.webContents.executeJavaScript(`(async () => {
            const modal = document.querySelector('.chat-modal');
            const button = [...(modal?.querySelectorAll('.chat-manage-actions button') || [])].find((item) => /đổi tên/i.test(item.textContent || ''));
            const beforeTitle = modal?.querySelector('.chat-dropdown-value strong')?.textContent?.trim() || '';
            if (!button || button.disabled) return { ok: false, error: 'Nút Đổi tên không bấm được.', beforeTitle };
            button.click();
            await new Promise((resolve) => setTimeout(resolve, 180));
            const input = modal.querySelector('.chat-rename-input');
            const save = modal.querySelector('.chat-rename-save');
            if (!input || !save) return { ok: false, error: 'Không mở được editor đổi tên.', beforeTitle };
            input.focus();
            const oldValue = input.value;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, ${JSON.stringify(renameTitle)});
            if (input._valueTracker) input._valueTracker.setValue(oldValue);
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(renameTitle)} }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 300));
            const currentSave = modal.querySelector('.chat-rename-save');
            const saveDisabledBeforeClick = Boolean(currentSave?.disabled);
            if (currentSave && !saveDisabledBeforeClick) currentSave.click();
            await new Promise((resolve) => setTimeout(resolve, 5200));
            const afterTitle = modal.querySelector('.chat-dropdown-value strong')?.textContent?.trim() || '';
            const toast = document.querySelector('.toast')?.textContent?.trim() || '';
            const error = modal.querySelector('.request-send-error')?.textContent?.trim() || document.querySelector('.alert')?.textContent?.trim() || '';
            return { ok: afterTitle === ${JSON.stringify(renameTitle)} && !error, beforeTitle, afterTitle, toast, error, saveDisabledBeforeClick, editorClosed: !modal.querySelector('.chat-rename-editor') };
          })()`, true);
        }
        if (process.env.CODEXPRO_MANAGER_SMOKE_DROPDOWN === "1") {
          await win.webContents.executeJavaScript("document.querySelector('.chat-dropdown-trigger:not(:disabled)')?.click()", true);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (process.env.CODEXPRO_MANAGER_SMOKE_RESPONSE === "1") {
          await win.webContents.executeJavaScript("if (!document.querySelector('.chat-response')) document.querySelector('.response-toggle:not(:disabled)')?.click()", true);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        let sendProbe = null;
        if (process.env.CODEXPRO_MANAGER_SMOKE_SEND === "1") {
          const sendConversationId = String(process.env.CODEXPRO_MANAGER_SMOKE_SEND_CONVERSATION_ID || "").trim();
          const sendText = String(process.env.CODEXPRO_MANAGER_SMOKE_SEND_TEXT || "CodexPro Manager UI send probe — trả lời OK.").trim();
          const sendAttachmentPath = String(process.env.CODEXPRO_MANAGER_SMOKE_SEND_ATTACHMENT_PATH || "").trim();
          let expectedAttachmentName = "";
          if (sendConversationId) {
            await win.webContents.executeJavaScript(`(async () => {
              const trigger = document.querySelector('.chat-dropdown-trigger:not(:disabled)');
              if (!trigger) return false;
              trigger.click();
              await new Promise((resolve) => setTimeout(resolve, 180));
              const option = document.querySelector('[data-conversation-id=${JSON.stringify(sendConversationId)}]');
              if (!option) return false;
              option.click();
              return true;
            })()`, true);
            await new Promise((resolve) => setTimeout(resolve, 1400));
          }
          if (sendAttachmentPath) {
            const resolvedAttachment = path.resolve(sendAttachmentPath);
            if (!fs.existsSync(resolvedAttachment)) throw new Error(`Không tìm thấy file smoke gửi kèm: ${resolvedAttachment}`);
            const attachmentImage = nativeImage.createFromPath(resolvedAttachment);
            if (attachmentImage.isEmpty()) throw new Error(`File smoke gửi kèm không phải ảnh hợp lệ: ${resolvedAttachment}`);
            expectedAttachmentName = path.basename(resolvedAttachment);
            const previousImage = typeof clipboard.readImage === "function" ? await Promise.resolve(clipboard.readImage()) : null;
            const previousText = typeof clipboard.readText === "function" ? String(await Promise.resolve(clipboard.readText()) || "") : "";
            try {
              if (typeof clipboard.writeImage === "function") await Promise.resolve(clipboard.writeImage(attachmentImage));
              else await clipboard.write([new ClipboardItem({ "image/png": new Blob([attachmentImage.toPNG()], { type: "image/png" }) })]);
              const pasteTargetReady = await win.webContents.executeJavaScript(`(() => {
                const scope = document.querySelector('.chat-modal') || document;
                const card = [...scope.querySelectorAll('.request-card')].find((item) => {
                  const textarea = item.querySelector('textarea');
                  const button = item.querySelector('.request-card-actions .button.primary');
                  return textarea && !textarea.disabled && button && !/đang trả lời/i.test(button.textContent || '');
                });
                const textarea = card?.querySelector('textarea');
                textarea?.focus();
                return Boolean(textarea);
              })()`, true);
              if (!pasteTargetReady) throw new Error("Không có textarea rảnh để dán ảnh smoke trước khi gửi.");
              win.webContents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] });
              win.webContents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: ["control"] });
              await new Promise((resolve) => setTimeout(resolve, 1400));
            } finally {
              if (previousImage && !previousImage.isEmpty() && typeof clipboard.writeImage === "function") clipboard.writeImage(previousImage);
              else if (typeof clipboard.writeText === "function") clipboard.writeText(previousText);
            }
          }
          await win.webContents.executeJavaScript("window.__codexproSmokeSendTarget = null", true);
          const sendProbePromise = win.webContents.executeJavaScript(`(async () => {
            const findCurrentCard = () => {
              const scope = document.querySelector('.chat-modal') || document;
              return [...scope.querySelectorAll('.request-card')].find((item) => {
                const textarea = item.querySelector('textarea');
                const button = item.querySelector('.request-card-actions .button.primary');
                return textarea && !textarea.disabled && button && !/đang trả lời/i.test(button.textContent || '');
              });
            };
            const card = findCurrentCard();
            if (!card) return { ok: false, error: 'Không có card rảnh để test gửi.' };
            const textarea = card.querySelector('textarea');
            const oldValue = textarea.value;
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            setter?.call(textarea, ${JSON.stringify(sendText)});
            if (textarea._valueTracker) textarea._valueTracker.setValue(oldValue);
            textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(sendText)} }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 350));
            let activeCard = findCurrentCard();
            const currentButton = activeCard?.querySelector('.request-card-actions .button.primary');
            if (!currentButton || currentButton.disabled) return { ok: false, error: 'Nút Gửi tin nhắn chưa sẵn sàng sau khi nhập.', textarea: activeCard?.querySelector('textarea')?.value || '' };
            const attachmentsBeforeSend = [...activeCard.querySelectorAll('.request-file-copy strong')].map((node) => node.textContent?.trim() || '').filter(Boolean);
            const sendDeadline = Date.now() + 45000;
            const probeStartedAt = Date.now();
            let sendStarted = false;
            let inputClearedAt = 0;
            currentButton.click();
            while (Date.now() < sendDeadline) {
              activeCard = findCurrentCard() || activeCard;
              const activeButton = activeCard?.querySelector('.request-card-actions .button.primary');
              const activeTextarea = activeCard?.querySelector('textarea');
              const attachmentCount = activeCard?.querySelectorAll('.request-file').length || 0;
              if (!inputClearedAt && (activeTextarea?.value || '') === '' && attachmentCount === 0) inputClearedAt = Date.now();
              const loading = Boolean(activeButton && (activeButton.disabled || /(?:đang tải|đang gửi|đang tạo)/i.test(activeButton.textContent || '')));
              if (loading) sendStarted = true;
              if (sendStarted && activeButton && !activeButton.disabled && !/(?:đang tải|đang gửi|đang tạo)/i.test(activeButton.textContent || '')) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const finalCard = findCurrentCard() || activeCard;
            const currentTextarea = finalCard?.querySelector('textarea');
            const toast = document.querySelector('.toast')?.textContent?.trim() || '';
            const error = finalCard?.querySelector('.request-send-error')?.textContent?.trim() || document.querySelector('.error-banner')?.textContent?.trim() || document.querySelector('.error')?.textContent?.trim() || '';
            const userMessages = [...(finalCard?.querySelectorAll('.chat-transcript-message.is-user .user-message-text') || [])].map((node) => node.textContent?.trim() || '').filter(Boolean);
            const userMessageVisible = userMessages.some((message) => message.includes(${JSON.stringify(sendText)}));
            const attachmentExpected = ${JSON.stringify(Boolean(sendAttachmentPath))};
            const attachmentPrepared = !attachmentExpected || attachmentsBeforeSend.length > 0;
            const attachmentCleared = (finalCard?.querySelectorAll('.request-file').length || 0) === 0;
            return {
              ok: (currentTextarea?.value || '') === '' && !error && userMessageVisible && attachmentPrepared && attachmentCleared,
              textarea: currentTextarea?.value || '',
              buttonText: finalCard?.querySelector('.request-card-actions .button.primary')?.textContent?.trim() || '',
              toast,
              error,
              userMessageVisible,
              userMessages: userMessages.slice(-5),
              attachmentExpected,
              expectedAttachmentName: ${JSON.stringify(expectedAttachmentName)},
              attachmentsBeforeSend,
              attachmentPrepared,
              attachmentCleared,
              sendStarted,
              probeStartedAt,
              inputClearedMs: inputClearedAt ? inputClearedAt - probeStartedAt : null,
              probeDurationMs: Date.now() - probeStartedAt,
              conversationTitle: finalCard?.querySelector('.chat-dropdown-value strong')?.textContent?.trim() || ''
            };
          })()`, true);
          sendProbe = await sendProbePromise;
          if (sendConversationId && chatModalProbe?.profile) {
            await new Promise((resolve) => setTimeout(resolve, 800));
            const actual = await win.webContents.executeJavaScript(`window.codexpro.getProfileResponse(${JSON.stringify({ profileId: chatModalProbe.profile, conversationId: sendConversationId, readDom: true })}).then((value) => JSON.parse(JSON.stringify(value)))`, true);
            const actualUserMessage = [...(actual?.messages || [])].reverse().find((message) => message?.role === "user" && String(message?.text || "").includes(sendText));
            sendProbe.actualUserMessageVisible = Boolean(actualUserMessage);
            sendProbe.actualUserMessageTail = String(actualUserMessage?.text || "").slice(-300);
            sendProbe.actualNetworkState = String(actual?.network_state || "");
            sendProbe.actualNetworkStartedAt = String(actual?.network_last_started_at || "");
            const actualNetworkStartedMs = Date.parse(sendProbe.actualNetworkStartedAt) || 0;
            sendProbe.clickToNetworkMs = actualNetworkStartedMs && sendProbe.probeStartedAt ? Math.max(0, actualNetworkStartedMs - sendProbe.probeStartedAt) : null;
            sendProbe.actualBusy = Boolean(actual?.busy);
            sendProbe.ok = Boolean(sendProbe.ok && sendProbe.actualUserMessageVisible);
          }
        }
        let pasteProbe = null;
        if (process.env.CODEXPRO_MANAGER_SMOKE_PASTE_IMAGE === "1") {
          const previousImage = typeof clipboard.readImage === "function" ? await Promise.resolve(clipboard.readImage()) : null;
          const previousText = typeof clipboard.readText === "function" ? String(await Promise.resolve(clipboard.readText()) || "") : "";
          const sampleBitmap = Buffer.alloc(24 * 24 * 4);
          for (let index = 0; index < sampleBitmap.length; index += 4) {
            sampleBitmap[index] = 0x3f;
            sampleBitmap[index + 1] = 0x85;
            sampleBitmap[index + 2] = 0xff;
            sampleBitmap[index + 3] = 0xff;
          }
          const sample = nativeImage.createFromBitmap(sampleBitmap, { width: 24, height: 24, scaleFactor: 1 });
          try {
            if (typeof clipboard.writeImage === "function") await Promise.resolve(clipboard.writeImage(sample));
            else await clipboard.write([new ClipboardItem({ "image/png": new Blob([sample.toPNG()], { type: "image/png" }) })]);
            const pasteTargetReady = await win.webContents.executeJavaScript(`(() => {
              const card = [...document.querySelectorAll('.request-card')].find((item) => {
                const textarea = item.querySelector('textarea');
                return textarea && !textarea.disabled;
              });
              const textarea = card?.querySelector('textarea');
              textarea?.focus();
              return Boolean(textarea);
            })()`, true);
            if (!pasteTargetReady) pasteProbe = { ok: false, error: 'Không có textarea rảnh để test paste ảnh.' };
            else {
              win.webContents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] });
              win.webContents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: ["control"] });
              await new Promise((resolve) => setTimeout(resolve, 1400));
              pasteProbe = await win.webContents.executeJavaScript(`(() => {
                const card = [...document.querySelectorAll('.request-card')].find((item) => item.querySelector('textarea:focus'))
                  || [...document.querySelectorAll('.request-card')].find((item) => item.querySelector('textarea'));
                const textarea = card?.querySelector('textarea');
                const attachment = card?.querySelector('.request-file');
                attachment?.scrollIntoView({ block: 'center' });
                const thumbnail = attachment?.querySelector('img.request-file-image');
                return {
                  ok: Boolean(thumbnail),
                  attachment: attachment?.querySelector('.request-file-copy strong')?.textContent?.trim() || '',
                  hasThumbnail: Boolean(thumbnail),
                  thumbnailSource: Boolean(thumbnail?.getAttribute('src')?.startsWith('data:image/')),
                  toast: document.querySelector('.toast')?.textContent?.trim() || '',
                  error: card?.querySelector('.request-send-error')?.textContent?.trim() || '',
                  placeholder: textarea?.getAttribute('placeholder') || ''
                };
              })()`, true);
            }
          } finally {
            if (previousImage && !previousImage.isEmpty() && typeof clipboard.writeImage === "function") clipboard.writeImage(previousImage);
            else if (typeof clipboard.writeText === "function") clipboard.writeText(previousText || "");
          }
        }
        let openProfileProbe = null;
        const openProfilePrefix = String(process.env.CODEXPRO_MANAGER_SMOKE_OPEN_PROFILE || "").trim();
        if (openProfilePrefix) {
          const fullscreenRequested = isMac && process.env.CODEXPRO_MANAGER_SMOKE_OPEN_PROFILE_FULLSCREEN === "1";
          let fullscreenBeforeOpen = false;
          if (fullscreenRequested) {
            win.show();
            app.focus({ steal: true });
            win.focus();
            await new Promise((resolve) => setTimeout(resolve, 250));
            win.setFullScreen(true);
            const fullscreenDeadline = Date.now() + 5000;
            while (!win.isFullScreen() && Date.now() < fullscreenDeadline) {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            fullscreenBeforeOpen = win.isFullScreen();
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          const beforeProfile = status.browserProfiles?.find((item) => item.profile_id.startsWith(openProfilePrefix));
          const beforeActiveTab = beforeProfile?.conversation_tabs?.find((item) => item.active) || beforeProfile?.conversation_tabs?.[0];
          const expectedConversationId = String(beforeActiveTab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
          const expectedTitle = String(beforeActiveTab?.title || beforeProfile?.active_chat_title || "");
          const ui = await win.webContents.executeJavaScript(`(async () => {
            const card = [...document.querySelectorAll('.browser-profile')].find((item) => item.querySelector('code')?.textContent?.includes(${JSON.stringify(openProfilePrefix)}));
            const chatButton = card?.querySelector('.profile-chat');
            if (!chatButton) return { ok: false, error: 'Không tìm thấy nút Chat.' };
            chatButton.click();
            await new Promise((resolve) => setTimeout(resolve, 500));
            const modal = document.querySelector('.chat-modal');
            const button = [...(modal?.querySelectorAll('.request-card-actions .button.secondary') || [])].find((item) => /Mở Chrome/i.test(item.textContent || ''));
            if (!button) return { ok: false, error: 'Không tìm thấy nút Mở Chrome trong popup.' };
            const disabledBefore = button.disabled;
            const textBefore = button.textContent?.trim() || '';
            button.click();
            await new Promise((resolve) => setTimeout(resolve, 7000));
            const currentButton = [...document.querySelectorAll('.chat-modal .request-card-actions .button.secondary')].find((item) => /Mở Chrome/i.test(item.textContent || ''));
            return { ok: true, disabledBefore, textBefore, disabledAfter: currentButton?.disabled ?? null, textAfter: currentButton?.textContent?.trim() || '', error: document.querySelector('.alert')?.textContent?.trim() || '' };
          })()`, true);
          const afterStatus = await win.webContents.executeJavaScript("window.codexpro.getStatus().then((value) => JSON.parse(JSON.stringify(value)))", true);
          const afterProfile = afterStatus.browserProfiles?.find((item) => item.profile_id.startsWith(openProfilePrefix));
          const afterActiveTab = afterProfile?.conversation_tabs?.find((item) => item.active) || afterProfile?.conversation_tabs?.[0];
          const afterConversationId = String(afterActiveTab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
          let foreground = null;
          if (isWindows) {
            try {
              foreground = JSON.parse(await runPowerShell(`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CodexProSmokeForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$h=[CodexProSmokeForeground]::GetForegroundWindow()
[uint32]$processId=0
[CodexProSmokeForeground]::GetWindowThreadProcessId($h,[ref]$processId)|Out-Null
if($processId -gt 0){$p=Get-Process -Id $processId;[pscustomobject]@{process=$p.ProcessName;title=$p.MainWindowTitle;processId=$p.Id}|ConvertTo-Json -Compress}else{[pscustomobject]@{process='';title='';processId=0}|ConvertTo-Json -Compress}
`));
            } catch {}
          } else if (isMac) {
            try {
              const bundleId = await macFrontmostBundleId();
              foreground = { process: bundleId === "com.google.Chrome" ? "chrome" : "", bundleId };
            } catch {}
          }
          const chromeForeground = isMac
            ? foreground?.bundleId === "com.google.Chrome"
            : String(foreground?.process || "").toLowerCase() === "chrome";
          openProfileProbe = {
            ok: Boolean(ui?.ok) && !ui?.error && !ui?.disabledBefore && chromeForeground && (!fullscreenRequested || fullscreenBeforeOpen) && beforeProfile?.tab_count === afterProfile?.tab_count && (!expectedConversationId || expectedConversationId === afterConversationId),
            beforeTabCount: beforeProfile?.tab_count ?? null,
            afterTabCount: afterProfile?.tab_count ?? null,
            expectedConversationId,
            afterConversationId,
            expectedTitle,
            fullscreenRequested,
            fullscreenBeforeOpen,
            foreground,
            ui
          };
        }
        let realtimeProbe = null;
        if (process.env.CODEXPRO_MANAGER_SMOKE_REALTIME_RESPONSE === "1") {
          const preferredProfile = String(process.env.CODEXPRO_MANAGER_SMOKE_SCROLL_PROFILE || "").trim();
          const profile = status.browserProfiles?.find((item) => preferredProfile && item.profile_id.startsWith(preferredProfile) && item.connected)
            || status.browserProfiles?.find((item) => item.connected && item.activity === "working" && item.conversation_tabs?.some((tab) => tab.busy));
          const tab = profile?.conversation_tabs?.find((item) => item.busy) || profile?.conversation_tabs?.find((item) => item.active);
          const conversationId = String(tab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
          if (profile?.profile_id && conversationId) {
            const started = Date.now();
            const response = await win.webContents.executeJavaScript(`window.codexpro.getProfileResponse(${JSON.stringify({ profileId: profile.profile_id, conversationId })}).then((value) => JSON.parse(JSON.stringify(value)))`, true);
            await new Promise((resolve) => setTimeout(resolve, 1800));
            const ui = await win.webContents.executeJavaScript(`(() => {
              const modal = document.querySelector('.chat-modal');
              const card = modal?.querySelector('.request-card');
              const modalProfile = modal?.querySelector('.chat-modal-profile code')?.textContent || '';
              if (!card || !modalProfile.includes(${JSON.stringify(profile.profile_id)})) return { text: '', status: '', found: false };
              return { found: true, text: card.querySelector('.chat-message-text')?.textContent || '', status: card.querySelector('.chat-response-head strong')?.textContent || '', bulletCount: card.querySelectorAll('.response-bullets li').length, numberedCount: card.querySelectorAll('.response-numbered li').length };
            })()`, true);
            realtimeProbe = { ok: Boolean(response?.text) && Boolean(ui?.text), busy: Boolean(response?.busy), textLength: Number(response?.text_length || response?.text?.length || 0), uiTextLength: String(ui?.text || '').length, bulletCount: Number(ui?.bulletCount || 0), numberedCount: Number(ui?.numberedCount || 0), latencyMs: Date.now() - started, tail: String(response?.text || "").slice(-220), uiTail: String(ui?.text || '').slice(-220), uiStatus: ui?.status || '' };
          } else realtimeProbe = { ok: false, error: "Không có profile WORKING để test realtime." };
        }
        const workerUpdateProbe = await win.webContents.executeJavaScript(`(() => {
          const button = document.querySelector('.reload-all');
          return button ? { text: button.textContent?.trim() || '', disabled: Boolean(button.disabled), primary: button.classList.contains('primary'), title: button.getAttribute('title') || '' } : null;
        })()`, true);
        const activeRepoProbe = await win.webContents.executeJavaScript(`(() => [...document.querySelectorAll('.browser-profile')].map((card) => ({
          profile: card.querySelector('code')?.textContent?.trim() || '',
          repo: card.querySelector('.active-repo-chip')?.textContent?.trim() || '',
          hasLegacyChatTitle: Boolean(card.querySelector('.active-chat-chip')),
          stillHasChatTitleChip: Boolean(card.querySelector('.active-chat-chip')),
          metaStillHasChat: /(?:^|\\s)Chat:/i.test(card.querySelector('.profile-meta')?.textContent || '')
        })))()`, true);
        const activeChatTitleProbe = activeRepoProbe;
        let toastProbe = null;
        if (process.env.CODEXPRO_MANAGER_SMOKE_TOAST === "1") {
          await win.webContents.executeJavaScript("document.querySelector('.copy-button')?.click()", true);
          await new Promise((resolve) => setTimeout(resolve, 180));
          toastProbe = await win.webContents.executeJavaScript(`(() => {
            const toast = document.querySelector('.toast');
            const send = document.querySelector('.chat-modal .request-card-actions .button.primary');
            const rect = (element) => element ? element.getBoundingClientRect().toJSON() : null;
            const a = toast?.getBoundingClientRect();
            const b = send?.getBoundingClientRect();
            const overlapsSend = Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
            return { text: toast?.textContent?.trim() || '', toast: rect(toast), send: rect(send), overlapsSend };
          })()`, true);
        }
        const scrollProfile = String(process.env.CODEXPRO_MANAGER_SMOKE_SCROLL_PROFILE || "").trim();
        if (scrollProfile) {
          await win.webContents.executeJavaScript(`(() => {
            const card = [...document.querySelectorAll('.request-card')].find((item) => item.querySelector('code')?.textContent?.includes(${JSON.stringify(scrollProfile)}));
            card?.scrollIntoView({ block: 'center' });
          })()`, true);
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        if (process.env.CODEXPRO_MANAGER_SMOKE_SCREENSHOT_WORKER === "1") {
          await win.webContents.executeJavaScript("document.querySelector('.worker-pack-toolbar')?.scrollIntoView({ block: 'center' })", true);
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        let attachmentPreviewProbe = null;
        if (process.env.CODEXPRO_MANAGER_SMOKE_ATTACHMENT_LIGHTBOX === "1") {
          await win.webContents.executeJavaScript("document.querySelector('.request-file')?.click()", true);
          await new Promise((resolve) => setTimeout(resolve, 550));
          attachmentPreviewProbe = await win.webContents.executeJavaScript(`(() => {
            const lightbox = document.querySelector('.attachment-lightbox');
            const image = lightbox?.querySelector('.attachment-lightbox-body.is-image img');
            const text = lightbox?.querySelector('.attachment-lightbox-body.is-text pre');
            return {
              open: Boolean(lightbox),
              image: Boolean(image),
              imageSource: Boolean(image?.getAttribute('src')?.startsWith('data:image/')),
              text: Boolean(text),
              title: lightbox?.querySelector('.attachment-lightbox-head strong')?.textContent?.trim() || ''
            };
          })()`, true);
          win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
          win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
          await new Promise((resolve) => setTimeout(resolve, 180));
          const escapeState = await win.webContents.executeJavaScript(`(() => ({
            lightboxOpen: Boolean(document.querySelector('.attachment-lightbox')),
            chatModalOpen: Boolean(document.querySelector('.chat-modal'))
          }))()`, true);
          attachmentPreviewProbe.escapeClosedLightbox = !escapeState.lightboxOpen;
          attachmentPreviewProbe.escapeKeptChatModal = escapeState.chatModalOpen;
          const textPreview = await requestFilePreview(path.join(app.getAppPath(), "package.json"));
          attachmentPreviewProbe.textPreviewKind = String(textPreview?.kind || "");
          attachmentPreviewProbe.textPreviewHasContent = Boolean(String(textPreview?.text || "").trim());
        }
        if (process.env.CODEXPRO_MANAGER_SMOKE_SCREENSHOT_FONT === "1") {
          await win.webContents.executeJavaScript(`(() => {
            const row = document.querySelector('.font-setting-row');
            row?.scrollIntoView({ block: 'start' });
            row?.querySelector('.app-dropdown-trigger')?.click();
          })()`, true);
          await new Promise((resolve) => setTimeout(resolve, 120));
          await win.webContents.executeJavaScript("document.querySelector('.font-setting-row .app-dropdown-menu')?.scrollTo({ top: 72, behavior: 'instant' })", true);
          await new Promise((resolve) => setTimeout(resolve, 100));
        } else if (process.env.CODEXPRO_MANAGER_SMOKE_SCREENSHOT_FONT_ROLES === "1") {
          await win.webContents.executeJavaScript("document.querySelector('.font-role-grid')?.closest('.settings-panel')?.scrollIntoView({ block: 'start' })", true);
          await new Promise((resolve) => setTimeout(resolve, 180));
        }
        const smokeScrollSelector = String(process.env.CODEXPRO_MANAGER_SMOKE_SCROLL_SELECTOR || "").trim();
        if (smokeScrollSelector) {
          await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(smokeScrollSelector)})?.scrollIntoView({ block: 'start' })`, true);
          await new Promise((resolve) => setTimeout(resolve, 220));
        }
        const screenshot = process.env.CODEXPRO_MANAGER_SMOKE_SCREENSHOT;
        if (screenshot) {
          win.show();
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        const image = await win.webContents.capturePage();
        if (screenshot) fs.writeFileSync(screenshot, image.toPNG());
        const smokeResult = { ok: true, status, projectCount: projects.length, projectIdentityProbe: projects.slice(0, 20).map((project) => ({ name: project.name, localName: project.localName, repoFullName: project.repoFullName, activityAt: project.activityAt, activityTimestamp: project.activityTimestamp, activityKind: project.activityKind })), inspection: inspection ? { workspace_id: inspection.workspace_id, root: inspection.root } : null, inspectionUiProbe, settingsProbe, diagnosticProbe, chatModalProbe, composerLayoutProbe, renameProbe, sendProbe, pasteProbe, attachmentPreviewProbe, openProfileProbe, realtimeProbe, workerUpdateProbe, activeChatTitleProbe, activeRepoProbe, toastProbe };
        const smokeResultFile = String(process.env.CODEXPRO_MANAGER_SMOKE_RESULT || "").trim();
        if (smokeResultFile) fs.writeFileSync(smokeResultFile, `${JSON.stringify(smokeResult, null, 2)}\n`, "utf8");
        console.log(JSON.stringify(smokeResult));
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

async function macFrontmostBundleId() {
  const { stdout: frontStdout } = await execFileAsync("/usr/bin/lsappinfo", ["front"], { maxBuffer: 256 * 1024 });
  const front = frontStdout.trim();
  if (!front) return "";
  const { stdout: infoStdout } = await execFileAsync("/usr/bin/lsappinfo", ["info", "-only", "bundleid", front], { maxBuffer: 256 * 1024 });
  return infoStdout.match(/"CFBundleIdentifier"="([^"]+)"/)?.[1] || "";
}

async function focusChromeWindowMac() {
  let foregroundBundleId = "";
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await execFileAsync("/usr/bin/open", ["-a", "Google Chrome"], { maxBuffer: 256 * 1024 });
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        foregroundBundleId = await macFrontmostBundleId();
        if (foregroundBundleId === "com.google.Chrome") {
          return {
            ok: true,
            activated: true,
            foreground_match: true,
            source: "launchservices",
            foreground_bundle_id: foregroundBundleId
          };
        }
      }
    }
    return {
      ok: false,
      activated: false,
      foreground_match: false,
      source: "launchservices",
      foreground_bundle_id: foregroundBundleId,
      reason: "chrome_not_frontmost"
    };
  } catch (error) {
    return {
      ok: false,
      activated: false,
      foreground_match: false,
      source: "launchservices",
      foreground_bundle_id: foregroundBundleId,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseTaskArguments(args = "") {
  const value = String(args);
  const read = (name) => {
    const match = value.match(new RegExp(`--${name}\\s+(?:\"([^\"]+)\"|'([^']+)'|([^\\s]+))`, "i"));
    return match?.[1] || match?.[2] || match?.[3] || "";
  };
  const readAll = (name) => [...value.matchAll(new RegExp(`--${name}\\s+(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, "gi"))]
    .map((match) => match[1] || match[2] || match[3] || "")
    .filter(Boolean);
  return {
    root: read("root"),
    port: Number(read("port")) || 8793,
    hostname: read("hostname"),
    tokenFile: read("token-file") || tokenFileDefault,
    tunnel: read("tunnel") || "none",
    allowedRoots: readAll("allow-root"),
    allowHome: /(?:^|\s)--allow-home(?:\s|$)/i.test(value)
  };
}

async function windowsScheduledTask(options = {}) {
  const forceRefresh = options?.forceRefresh === true;
  if (!forceRefresh && scheduledTaskCache && Date.now() - scheduledTaskCache.at < SCHEDULED_TASK_CACHE_MS) {
    return scheduledTaskCache.value;
  }
  if (forceRefresh) scheduledTaskCache = null;
  if (scheduledTaskPromise) return scheduledTaskPromise;
  const script = [
    "$t=Get-ScheduledTask -TaskName 'CodexPro' -ErrorAction Stop",
    "$i=Get-ScheduledTaskInfo -TaskName 'CodexPro'",
    "$a=$t.Actions | Select-Object -First 1",
    "$auto=(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'CodexPro Manager' -ErrorAction SilentlyContinue).'CodexPro Manager'",
    "$tr=@($t.Triggers | ForEach-Object { [pscustomobject]@{ type=$_.CimClass.CimClassName; id=$_.Id; interval=$_.Repetition.Interval; delay=$_.Delay } })",
    "[pscustomobject]@{ state=[string]$t.State; lastRunTime=if($i.LastRunTime){$i.LastRunTime.ToString('o')}else{$null}; lastTaskResult=$i.LastTaskResult; execute=$a.Execute; arguments=$a.Arguments; workingDirectory=$a.WorkingDirectory; triggers=$tr; autoStartCommand=$auto } | ConvertTo-Json -Depth 5 -Compress"
  ].join("; ");
  scheduledTaskPromise = (async () => {
    try {
      return JSON.parse(await runPowerShell(script));
    } catch (error) {
      return { state: "NotFound", error: error instanceof Error ? error.message : String(error), arguments: "" };
    }
  })();
  try {
    const value = await scheduledTaskPromise;
    scheduledTaskCache = { at: Date.now(), value };
    return value;
  } finally {
    scheduledTaskPromise = null;
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
  const recordedRuntime = currentRuntime();
  const runtime = recordedRuntime?.active ? recordedRuntime : await discoverPortableRuntime() || recordedRuntime;
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

async function scheduledTask(options = {}) {
  return isWindows ? windowsScheduledTask(options) : portableServiceStatus();
}

function readToken(tokenFile) {
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

async function health(base, token, attempts = 1) {
  if (!base) return { ok: false, status: 0, latency: 0, error: "Chưa có endpoint" };
  let lastResult = { ok: false, status: 0, latency: 0, error: "Không thể kết nối" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(`${base.replace(/\/$/, "")}/healthz`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(RUNTIME_HEALTH_TIMEOUT_MS)
      });
      const body = await response.json().catch(() => ({}));
      lastResult = {
        ok: response.ok && body.ok === true,
        status: response.status,
        latency: Date.now() - started,
        response_server: String(response.headers.get("server") || ""),
        cf_ray: String(response.headers.get("cf-ray") || ""),
        content_type: String(response.headers.get("content-type") || ""),
        data: body,
        timeout_ms: RUNTIME_HEALTH_TIMEOUT_MS,
        timed_out: false,
        ...(response.ok && body.ok === true ? {} : { error: `HTTP ${response.status}` })
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : "";
      lastResult = {
        ok: false,
        status: 0,
        latency: Date.now() - started,
        timeout_ms: RUNTIME_HEALTH_TIMEOUT_MS,
        timed_out: errorName === "TimeoutError" || /timed?\s*out|timeout/i.test(message),
        error_name: errorName,
        error_code: String(error?.code || ""),
        error: message
      };
    }
    if (lastResult.ok || attempt === attempts) return lastResult;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return lastResult;
}

async function recordRuntimeHealthDiagnostics({ healthCycleId, localBase, publicBase, local, tunnel, processSummaries }) {
  const localHealthEvent = runtimeHealthDiagnosticTracker.observe({
    target: "local",
    label: "Local MCP",
    base: localBase,
    result: local,
    healthCycleId,
    processes: processSummaries,
    slowMs: 1_000
  });
  const tunnelHealthEvent = runtimeHealthDiagnosticTracker.observe({
    target: "tunnel",
    label: "Public tunnel",
    base: publicBase,
    configured: Boolean(publicBase),
    result: tunnel,
    healthCycleId,
    processes: processSummaries,
    slowMs: 2_500
  });
  if (tunnelHealthEvent && publicBase && !tunnel.ok) {
    try {
      const offlineEvidence = await collectTunnelOfflineEvidence({
        home: codexProHome,
        publicBase,
        local,
        tunnel,
        processes: processSummaries,
        timeoutMs: 1_500
      });
      Object.assign(tunnelHealthEvent.details, offlineEvidence);
      tunnel.offline_diagnostic = offlineEvidence;
    } catch (error) {
      tunnelHealthEvent.details.offline_diagnostic_error = String(error?.message || error).slice(0, 500);
    }
  }
  for (const event of [localHealthEvent, tunnelHealthEvent]) {
    if (!event) continue;
    diagnostic(event.level, event.source, event.category, event.message, event.details);
    const interruptionAlert = interruptionAlertTracker.observeRuntimeHealth(event, activeBrowserTaskSummaries());
    if (interruptionAlert && readManagerSettings().taskNotifications !== false) showManagerNotification(interruptionAlert);
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

async function discoverPortableRuntime() {
  if (isWindows) return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid=,command="], { maxBuffer: 4 * 1024 * 1024 });
    const rows = String(stdout || "")
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
        return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3].trim() } : null;
      })
      .filter(Boolean);
    const launchers = rows
      .filter((row) => row.pid !== process.pid && /\bcodexpro(?:\.mjs)?\s+start\b/i.test(row.command))
      .sort((left, right) => right.pid - left.pid);
    for (const launcher of launchers) {
      if (!processAlive(launcher.pid)) continue;
      const root = processOption(launcher.command, "root");
      if (!root) continue;
      const port = Number(processOption(launcher.command, "port")) || 8787;
      const hostname = processOption(launcher.command, "hostname");
      const server = rows.find((row) => row.ppid === launcher.pid && /[\\/]dist[\\/]http\.js(?:\s|$)/i.test(row.command));
      const tunnelChild = rows.find((row) => row.ppid === launcher.pid && /\bcloudflared\b.*\btunnel\b/i.test(row.command));
      return {
        version: 1,
        root: path.resolve(root),
        pid: launcher.pid,
        runtimePid: server?.pid || null,
        tunnelPid: tunnelChild?.pid || null,
        updatedAt: "",
        endpoint: hostname ? `${hostname.includes("://") ? hostname : `https://${hostname}`}/mcp` : "",
        localBase: `http://127.0.0.1:${port}`,
        tunnel: processOption(launcher.command, "tunnel") || "none",
        active: true,
        discovered: true
      };
    }
  } catch {}
  return null;
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
  if (!command) return ["start", "--root", fallbackRoot, "--browser-control", "--headless"];
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
  if (!hasProcessFlag(command, "browser-control")) args.push("--browser-control");
  if (!hasProcessFlag(command, "headless")) args.push("--headless");
  return args;
}

async function runtimeBaseStatus(options = {}) {
  const forceRefresh = options?.forceRefresh === true;
  const cacheAge = runtimeBaseCache ? Date.now() - runtimeBaseCache.cachedAt : Number.POSITIVE_INFINITY;
  const cacheTtl = runtimeBaseCache?.value?.local?.ok ? RUNTIME_BASE_CACHE_MS : RUNTIME_BASE_FAILURE_CACHE_MS;
  if (!forceRefresh && runtimeBaseCache && cacheAge < cacheTtl) return runtimeBaseCache.value;
  if (forceRefresh) runtimeBaseCache = null;
  if (runtimeBasePromise) return runtimeBasePromise;
  runtimeBasePromise = (async () => {
    const healthCycleId = `health_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const task = await scheduledTask({ forceRefresh });

    if (!isWindows) {
      const recordedRuntime = currentRuntime();
      const runtime = recordedRuntime?.active ? recordedRuntime : await discoverPortableRuntime() || recordedRuntime;
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
        publicBase ? health(publicBase, token, 3) : Promise.resolve({ ok: false, status: 0, latency: 0, error: "Không dùng public tunnel" })
      ]);
      const processCandidates = [
        { pid: runtime?.pid, name: "codexpro" },
        { pid: runtime?.runtimePid, name: "node" },
        { pid: runtime?.tunnelPid, name: "cloudflared" }
      ].filter((item) => processAlive(item.pid));
      const processSummaries = processCandidates.map((item) => ({ pid: Number(item.pid), name: item.name }));
      await recordRuntimeHealthDiagnostics({ healthCycleId, localBase, publicBase, local, tunnel, processSummaries });
      const fallbackAllowedRoots = [...new Set([
        root,
        ...processOptions(processCommand, "allow-root"),
        ...(Array.isArray(profile?.allowedRoots) ? profile.allowedRoots : [])
      ].filter((value) => typeof value === "string" && value.trim()).map((value) => path.resolve(value)))];
      const config = {
        root,
        port,
        hostname,
        tokenFile: resolvedTokenFile,
        tunnel: processOption(processCommand, "tunnel") || runtime?.tunnel || profile?.tunnel || "none",
        allowedRoots: Array.isArray(local?.data?.allowedRoots) && local.data.allowedRoots.length
          ? local.data.allowedRoots.map((value) => path.resolve(value))
          : fallbackAllowedRoots
      };
      const value = {
        task,
        config,
        token,
        local,
        tunnel,
        processes: processSummaries,
        mcpLink: endpoint ? connectorLinkFromEndpoint(endpoint, token) : connectorLink(config, token),
        tokenConfigured: Boolean(token),
        autoStart: app.getLoginItemSettings().openAtLogin
      };
      runtimeBaseCache = { cachedAt: Date.now(), value };
      return value;
    }

    const config = parseTaskArguments(task.arguments);
    const token = readToken(config.tokenFile);
    const localBase = `http://127.0.0.1:${config.port}`;
    const publicBase = config.hostname
      ? (config.hostname.includes("://") ? config.hostname : `https://${config.hostname}`).replace(/\/mcp\/?$/, "")
      : "";
    const [local, tunnel, processText] = await Promise.all([
      health(localBase, token),
      publicBase ? health(publicBase, token, 3) : Promise.resolve({ ok: false, status: 0, latency: 0, error: "Không dùng public tunnel" }),
      runPowerShell("@((Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','cloudflared.exe') -and $_.CommandLine -match 'codexpro\\.mjs.*start|dist\\\\http\\.js|cloudflared.*codexpro' } | Select-Object ProcessId,Name,CommandLine)) | ConvertTo-Json -Depth 3 -Compress").catch(() => "[]")
    ]);
    let processes = [];
    try {
      const parsed = JSON.parse(processText || "[]");
      processes = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    } catch {
      processes = [];
    }
    const processSummaries = processes.map((item) => ({ pid: item.ProcessId, name: item.Name }));
    await recordRuntimeHealthDiagnostics({ healthCycleId, localBase, publicBase, local, tunnel, processSummaries });
    const value = {
      task,
      config,
      token,
      local,
      tunnel,
      processes: processSummaries,
      mcpLink: connectorLink(config, token),
      tokenConfigured: Boolean(token),
      autoStart: Boolean(task.autoStartCommand)
    };
    runtimeBaseCache = { cachedAt: Date.now(), value };
    return value;
  })();
  try {
    return await runtimeBasePromise;
  } finally {
    runtimeBasePromise = null;
  }
}

async function runtimeStatus(options = {}) {
  const base = await runtimeBaseStatus(options);
  const [browserProfileSnapshot, workerJobSnapshot] = base.local.ok
    ? await Promise.all([
      listBrowserProfilesThroughMcp(base.config, base.token).then((profiles) => ({
        available: true,
        profiles: Array.isArray(profiles) ? profiles : []
      })).catch((error) => {
        if (diagnosticAllowed(`runtime-list-profiles:${String(error?.message || error).slice(0, 160)}`, 30_000)) {
          diagnostic("warn", "manager", "profile", `Không đọc được danh sách profile trong runtime status: ${error?.message || String(error)}`, {
            action: "runtime-list-profiles-fallback",
            error
          });
        }
        return { available: false, profiles: [] };
      }),
      localMcpTool(base.config, base.token, "worker_job_history", {
        statuses: ["running", "completed", "failed", "cancelled", "blocked"],
        limit: 60
      }).then((result) => ({
        available: true,
        jobs: Array.isArray(result?.jobs) ? result.jobs : []
      })).catch(() => ({ available: false, jobs: [] }))
    ])
    : [{ available: false, profiles: [] }, { available: false, jobs: [] }];
  const browserProfilesRaw = browserProfileSnapshot.profiles;
  const exclusivity = await headlessWorkers.enforceExclusiveUse(browserProfilesRaw).catch((error) => {
    if (diagnosticAllowed(`headless-exclusive:${String(error?.message || error).slice(0, 160)}`, 30_000)) {
      diagnostic("warn", "manager", "worker", `Không kiểm tra được độc quyền headless/profile nguồn: ${error?.message || String(error)}`, {
        action: "headless-exclusive-check",
        error
      });
    }
    return { stopped: [], lockedSources: [], deferred: [] };
  });
  if (exclusivity.stopped.length) {
    diagnostic("warn", "manager", "worker", "Đã tự dừng headless vì profile nguồn đã có task trước khi khóa ChatGPT kịp áp dụng", {
      action: "headless-exclusive-stop",
      stopped: exclusivity.stopped
    });
  }
  if (exclusivity.lockedSources?.length) {
    diagnostic("info", "manager", "worker", "Chrome profile nguồn vẫn hoạt động bình thường; chỉ ChatGPT và task CodexPro bị khóa khi headless đang chạy", {
      action: "headless-exclusive-source-locked",
      locked_sources: exclusivity.lockedSources
    });
  }
  if (exclusivity.deferred?.length) {
    diagnostic("warn", "manager", "worker", "Tạm hoãn cưỡng chế độc quyền để không cắt task đang chạy", {
      action: "headless-exclusive-deferred",
      deferred: exclusivity.deferred
    });
  }
  const workerJobs = workerJobSnapshot.jobs;
  const browserProfilesVisible = browserProfilesRaw.filter((profile) => {
    const headless = profile.headless === true || String(profile.profile_id || "").startsWith("headless-");
    return profile.connected || !headless;
  });
  const browserProfiles = await Promise.all(browserProfilesVisible.map(async (profile) => {
    const workspaceRoot = String(profile.current_workspace_root || "").trim();
    if (!workspaceRoot) return { ...profile, current_workspace_repo: "" };
    return { ...profile, current_workspace_repo: await githubRepoForRoot(workspaceRoot) };
  }));
  const workerStatus = await workerPluginRegistry.list({ browserProfiles });
  for (const incident of taskUnfinalizedIncidents(workerJobs, { profiles: browserProfiles, workers: workerStatus.workers })) {
    if (!diagnosticAllowed(incident.fingerprint, TASK_UNFINALIZED_REPEAT_MS)) continue;
    diagnostic(incident.level, incident.source, incident.category, incident.message, {
      action: incident.action,
      ...incident.details
    });
  }
  return {
    checkedAt: new Date().toISOString(),
    task: base.task,
    config: base.config,
    local: base.local,
    tunnel: base.tunnel,
    processes: base.processes,
    browserProfiles,
    workers: workerStatus.workers,
    workerSources: workerStatus.sources,
    workerJobs,
    workerSnapshotAvailable: browserProfileSnapshot.available,
    workerJobsAvailable: workerJobSnapshot.available,
    mcpLink: base.mcpLink,
    tokenConfigured: base.tokenConfigured,
    autoStart: base.autoStart
  };
}

async function readyRuntimeBaseStatus() {
  let base = await runtimeBaseStatus();
  if (base.local.ok) return base;
  await new Promise((resolve) => setTimeout(resolve, 200));
  base = await runtimeBaseStatus({ forceRefresh: true });
  return base;
}

async function runtimeConnectionForSend() {
  const cached = runtimeBaseCache?.value;
  if (cached?.config?.port && cached?.token) {
    return { config: cached.config, token: cached.token, source: "runtime-cache" };
  }
  const task = await scheduledTask();
  const config = parseTaskArguments(task.arguments);
  const token = readToken(config.tokenFile);
  return { config, token, source: "scheduled-task" };
}

async function readyRuntimeStatus() {
  let status = await runtimeStatus();
  if (status.local.ok) return status;
  await new Promise((resolve) => setTimeout(resolve, 200));
  status = await runtimeStatus({ forceRefresh: true });
  return status;
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

function githubRemoteInfo(remoteUrl) {
  const value = String(remoteUrl || "").trim().replace(/\\/g, "/");
  if (!value) return { githubRepo: "", githubUrl: "" };
  let ownerRepo = "";
  const scpMatch = value.match(/^git@github\.com:([^/]+\/[^\s]+)$/i);
  if (scpMatch) {
    ownerRepo = scpMatch[1];
  } else {
    try {
      const parsed = new URL(value);
      if (parsed.hostname.toLowerCase() === "github.com") ownerRepo = parsed.pathname.replace(/^\/+|\/+$/g, "");
    } catch {
      const sshMatch = value.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^\s]+)$/i);
      if (sshMatch) ownerRepo = sshMatch[1];
    }
  }
  ownerRepo = ownerRepo.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(ownerRepo)) return { githubRepo: "", githubUrl: "" };
  return { githubRepo: ownerRepo, githubUrl: `https://github.com/${ownerRepo}` };
}

function githubRepoFromRemote(remoteUrl) {
  return githubRemoteInfo(remoteUrl).githubRepo;
}

function repoIdentityFromRemote(remoteUrl) {
  const value = String(remoteUrl || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!value) return { officialName: "", repoFullName: "" };
  const githubRepo = githubRepoFromRemote(value);
  if (githubRepo) return { officialName: githubRepo.split("/").pop() || "", repoFullName: githubRepo };
  const withoutQuery = value.split(/[?#]/, 1)[0];
  const parts = withoutQuery.replace(/\.git$/i, "").split(/[/:]/).filter(Boolean);
  const officialName = parts.pop() || "";
  const owner = parts.pop() || "";
  return { officialName, repoFullName: owner ? `${owner}/${officialName}` : officialName };
}

const githubRepoCache = new Map();
async function githubRepoForRoot(root) {
  const normalizedRoot = path.resolve(String(root || ""));
  const cached = githubRepoCache.get(normalizedRoot.toLowerCase());
  if (cached && Date.now() - cached.at < 15_000) return cached.value;
  let value = "";
  try {
    const git = isWindows ? "git.exe" : "git";
    const remote = await execFileAsync(git, ["-C", normalizedRoot, "remote", "get-url", "origin"], { windowsHide: true });
    value = githubRepoFromRemote(remote.stdout.trim());
  } catch {}
  githubRepoCache.set(normalizedRoot.toLowerCase(), { at: Date.now(), value });
  return value;
}

async function readGitSummary(root) {
  try {
    const git = isWindows ? "git.exe" : "git";
    const [statusResult, commitResult, remoteResult] = await Promise.allSettled([
      execFileAsync(git, ["-C", root, "status", "--porcelain=v2", "--branch"], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 }),
      execFileAsync(git, ["-C", root, "log", "-1", "--pretty=format:%h%x09%s%x09%cI"], { windowsHide: true }),
      execFileAsync(git, ["-C", root, "remote", "get-url", "origin"], { windowsHide: true })
    ]);
    if (statusResult.status !== "fulfilled") throw statusResult.reason;
    if (commitResult.status !== "fulfilled") throw commitResult.reason;
    const statusLines = statusResult.value.stdout.split(/\r?\n/).filter(Boolean);
    const branchHead = statusLines.find((line) => line.startsWith("# branch.head "))?.slice(14).trim() || "";
    const upstream = statusLines.find((line) => line.startsWith("# branch.upstream "))?.slice(18).trim() || "";
    const branch = !branchHead || branchHead === "(detached)" ? "detached" : branchHead;
    const changes = statusLines.filter((line) => !line.startsWith("# ")).length;
    const branchAb = statusLines.find((line) => line.startsWith("# branch.ab "))?.slice(12).trim() || "";
    const branchAbMatch = branchAb.match(/^\+(\d+)\s+-(\d+)$/);
    const ahead = Number(branchAbMatch?.[1] || 0);
    const behind = Number(branchAbMatch?.[2] || 0);
    const worktreeLines = statusLines.filter((line) => !line.startsWith("# "));
    const untracked = worktreeLines.filter((line) => line.startsWith("? ")).length;
    const conflicted = worktreeLines.filter((line) => line.startsWith("u ")).length;
    const modified = worktreeLines.filter((line) => line.startsWith("1 ") || line.startsWith("2 ")).length;
    const commitText = commitResult.value.stdout;
    const remoteUrl = remoteResult.status === "fulfilled" ? remoteResult.value.stdout.trim() : "";
    let pushedAt = "";
    let remoteCommitAt = "";
    if (upstream) {
      const [remoteCommit, pushReflog] = await Promise.allSettled([
        execFileAsync(git, ["-C", root, "log", "-1", "--pretty=format:%cI", upstream], { windowsHide: true }),
        execFileAsync(git, ["-C", root, "reflog", "show", "-1", "--format=%gI", upstream], { windowsHide: true })
      ]);
      if (remoteCommit.status === "fulfilled") remoteCommitAt = remoteCommit.value.stdout.trim();
      if (pushReflog.status === "fulfilled") pushedAt = pushReflog.value.stdout.trim();
    }
    const [hash = "", subject = "", date = ""] = commitText.trim().split("\t");
    const identity = repoIdentityFromRemote(remoteUrl);
    const github = githubRemoteInfo(remoteUrl);
    const latestActivity = [
      { kind: "commit", value: date, timestamp: Date.parse(date) || 0 },
      { kind: "push", value: pushedAt, timestamp: Date.parse(pushedAt) || 0 },
      { kind: "remote", value: remoteCommitAt, timestamp: Date.parse(remoteCommitAt) || 0 }
    ].sort((left, right) => right.timestamp - left.timestamp)[0];
    return {
      isGit: true,
      branch,
      changes,
      modified,
      untracked,
      conflicted,
      ahead,
      behind,
      commit: { hash, subject, date },
      remoteUrl,
      upstream,
      pushedAt,
      remoteCommitAt,
      activityAt: latestActivity?.value || date,
      activityTimestamp: latestActivity?.timestamp || 0,
      activityKind: latestActivity?.kind || "commit",
      ...github,
      ...identity
    };
  } catch {
    return { isGit: false, branch: "", changes: 0, modified: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0, commit: null, remoteUrl: "", upstream: "", pushedAt: "", remoteCommitAt: "", activityAt: "", activityTimestamp: 0, activityKind: "", githubRepo: "", githubUrl: "", officialName: "", repoFullName: "" };
  }
}

async function gitSummary(root) {
  const key = path.resolve(root).toLowerCase();
  const now = Date.now();
  const cached = gitSummaryCache.get(key);
  if (cached && now - cached.at < GIT_SUMMARY_CACHE_MS) return cached.value;
  if (gitSummaryPromises.has(key)) return gitSummaryPromises.get(key);
  const promise = readGitSummary(root).then((value) => {
    gitSummaryCache.set(key, { at: Date.now(), value });
    return value;
  });
  gitSummaryPromises.set(key, promise);
  try {
    return await promise;
  } finally {
    if (gitSummaryPromises.get(key) === promise) gitSummaryPromises.delete(key);
  }
}

function pruneGitSummaryCache(liveRoots) {
  const now = Date.now();
  for (const [key, cached] of gitSummaryCache) {
    if (!liveRoots.has(key) && now - cached.at > GIT_SUMMARY_CACHE_RETENTION_MS) gitSummaryCache.delete(key);
  }
}

const REPO_SCAN_SKIPPED_DIRECTORIES = new Set([
  "$recycle.bin", "system volume information", "windows", "program files", "program files (x86)", "programdata",
  "appdata", "node_modules", ".git", ".cache", ".gradle", ".idea", ".next", "dist", "build", "coverage", "vendor"
]);

function pathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function allowedWorkspaceRoots(config) {
  const requested = [config.root, ...(config.allowedRoots || []), ...(config.allowHome ? [os.homedir()] : [])].filter(Boolean);
  const roots = [];
  for (const candidate of requested) {
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue;
    if (!roots.some((root) => root.toLowerCase() === resolved.toLowerCase())) roots.push(resolved);
  }
  return roots;
}

function repoScanRoots(config) {
  const home = os.homedir();
  const requested = [config.root, ...(config.allowedRoots || []), ...(config.allowHome ? [home] : [])]
    .filter(Boolean)
    .map((root) => path.resolve(root));
  const roots = new Set();
  for (const root of requested) {
    if (!fs.existsSync(root)) continue;
    const parsed = path.parse(root);
    if (root.toLowerCase() === parsed.root.toLowerCase() && parsed.root.toLowerCase() === path.parse(home).root.toLowerCase()) {
      roots.add(root);
      roots.add(home);
      continue;
    }
    roots.add(root);
  }
  for (const folder of ["Desktop", "Documents", "Downloads", "Pictures", "Videos"]) {
    const candidate = path.join(home, folder);
    if (requested.some((allowed) => pathInside(candidate, allowed)) && fs.existsSync(candidate)) roots.add(candidate);
  }
  return [...roots];
}

async function discoverGitRepositories(scanRoots) {
  const cacheKey = [...scanRoots].map((root) => path.resolve(root).toLowerCase()).sort().join("|");
  if (repoScanCache?.key === cacheKey && Date.now() - repoScanCache.at < REPO_SCAN_CACHE_MS) return repoScanCache.roots;
  if (repoScanPromise?.key === cacheKey) return repoScanPromise.promise;
  const promise = (async () => {
    const started = Date.now();
    const queue = scanRoots.map((root) => ({ root: path.resolve(root), depth: 0, insideRepository: false }));
    const visited = new Set();
    const repositories = new Set();
    let scanned = 0;
    while (queue.length && scanned < REPO_SCAN_MAX_DIRECTORIES && Date.now() - started < REPO_SCAN_TIMEOUT_MS) {
      const batch = queue.splice(0, 32).filter((item) => {
        const key = item.root.toLowerCase();
        if (visited.has(key)) return false;
        visited.add(key);
        return true;
      });
      const entriesByRoot = await Promise.all(batch.map(async (item) => {
        try { return { item, entries: await fs.promises.readdir(item.root, { withFileTypes: true }) }; }
        catch { return { item, entries: [] }; }
      }));
      for (const { item, entries } of entriesByRoot) {
        scanned += 1;
        if (entries.some((entry) => entry.name.toLowerCase() === ".git" && (entry.isDirectory() || entry.isFile()))) {
          repositories.add(item.root);
          if (!item.insideRepository && item.depth < REPO_SCAN_MAX_DEPTH) {
            for (const entry of entries) {
              if (!entry.isDirectory() || entry.isSymbolicLink() || REPO_SCAN_SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
              queue.push({ root: path.join(item.root, entry.name), depth: item.depth + 1, insideRepository: true });
            }
          }
          continue;
        }
        if (item.insideRepository) continue;
        if (item.depth >= REPO_SCAN_MAX_DEPTH) continue;
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || REPO_SCAN_SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
          queue.push({ root: path.join(item.root, entry.name), depth: item.depth + 1, insideRepository: false });
        }
      }
    }
    const roots = [...repositories];
    repoScanCache = { key: cacheKey, at: Date.now(), roots };
    return roots;
  })();
  repoScanPromise = { key: cacheKey, promise };
  try { return await promise; }
  finally { if (repoScanPromise?.promise === promise) repoScanPromise = null; }
}

async function listProjects() {
  const startedAt = Date.now();
  const status = await runtimeBaseStatus();
  const chatGptWorkspaces = Array.isArray(status?.local?.data?.mcpSessions?.projectWorkspaces)
    ? status.local.data.mcpSessions.projectWorkspaces
    : [];
  const task = await scheduledTask();
  const parsedTaskConfig = parseTaskArguments(task.arguments);
  const liveConfig = status?.local?.data && typeof status.local.data === "object" ? status.local.data : {};
  const taskConfig = {
    ...parsedTaskConfig,
    root: parsedTaskConfig.root || liveConfig.defaultRoot || status?.config?.root || task?.root || "",
    allowedRoots: [...new Set([
      ...(parsedTaskConfig.allowedRoots || []),
      ...(Array.isArray(status?.config?.allowedRoots) ? status.config.allowedRoots : []),
      ...(Array.isArray(liveConfig.allowedRoots) ? liveConfig.allowedRoots : [])
    ].filter((value) => typeof value === "string" && value.trim()).map((value) => path.resolve(value)))]
  };
  const activeRoot = taskConfig.root;
  const selectedRoots = new Set(Object.values(readManagerSettings().repoSelections || {})
    .filter((root) => typeof root === "string" && root.trim() && root !== ALL_ALLOWED_WORKSPACES)
    .map((root) => path.resolve(root).toLowerCase()));
  const sources = new Map();

  for (const workspace of chatGptWorkspaces) {
    if (typeof workspace?.root !== "string" || !workspace.root) continue;
    const root = path.resolve(workspace.root);
    sources.set(root, {
      source: "ChatGPT",
      active: Number(workspace.sessionCount) > 0,
      sessionCount: Number(workspace.sessionCount) || 0,
      lastSeenAt: workspace.lastSeenAt || "",
      clients: Array.isArray(workspace.clients) ? workspace.clients : [],
      workers: Array.isArray(workspace.workers) ? workspace.workers : []
    });
  }

  for (const savedRoot of managerProjects()) {
    const root = path.resolve(savedRoot);
    if (!sources.has(root)) {
      sources.set(root, { source: "Đã ghim", active: false, sessionCount: 0, lastSeenAt: "", clients: [], workers: [] });
    }
  }

  if (activeRoot) {
    const root = path.resolve(activeRoot);
    const current = sources.get(root);
    sources.set(root, current
      ? { ...current, active: true }
      : { source: "Đang chạy", active: true, sessionCount: 0, lastSeenAt: "", clients: [], workers: [] });
  }
  const discoveryStartedAt = Date.now();
  const discoveredRoots = await discoverGitRepositories(repoScanRoots(taskConfig));
  const discoveryMs = Date.now() - discoveryStartedAt;
  for (const discoveredRoot of discoveredRoots) {
    const root = path.resolve(discoveredRoot);
    if (![...sources.keys()].some((known) => known.toLowerCase() === root.toLowerCase())) {
      sources.set(root, { source: "Tự quét", active: false, sessionCount: 0, lastSeenAt: "", clients: [], workers: [] });
    }
  }

  const entries = [...sources];
  pruneGitSummaryCache(new Set([...sources.keys()].map((root) => path.resolve(root).toLowerCase())));
  const projects = [];
  let nextIndex = 0;
  const summariesStartedAt = Date.now();
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (nextIndex < entries.length) {
      const [root, meta] = entries[nextIndex++];
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
      const summary = await gitSummary(root);
      const localName = path.basename(root);
      const activeByRuntime = Boolean(activeRoot && path.resolve(activeRoot).toLowerCase() === root.toLowerCase());
      projects.push({
        root,
        localName,
        name: summary.officialName || localName,
        source: meta.source,
        active: Boolean(meta.active || activeByRuntime),
        sessionCount: meta.sessionCount || 0,
        lastSeenAt: meta.lastSeenAt || "",
        clients: meta.clients || [],
        inUse: selectedRoots.has(path.resolve(root).toLowerCase()),
        workers: meta.workers || [],
        ...summary
      });
    }
  }));
  const summariesMs = Date.now() - summariesStartedAt;
  const totalMs = Date.now() - startedAt;
  if (totalMs >= 2_000) {
    diagnostic("warn", "manager", "projects", `list-projects phase breakdown (${totalMs} ms)`, {
      action: "list-projects-breakdown",
      total_ms: totalMs,
      discovery_ms: discoveryMs,
      summaries_ms: summariesMs,
      project_count: projects.length,
      discovered_count: discoveredRoots.length
    });
  }
  return projects.sort((a, b) =>
    Number(Boolean(b.active || b.inUse)) - Number(Boolean(a.active || a.inUse))
    || Number(b.activityTimestamp || 0) - Number(a.activityTimestamp || 0)
    || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))
    || Number(b.changes > 0) - Number(a.changes > 0)
    || a.name.localeCompare(b.name)
  );
}

async function mcpRequestCore(url, token, body, sessionId, timeoutMs = 15000) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      connection: "close",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const nextSessionId = response.headers.get("mcp-session-id") || sessionId;
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/event-stream") && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";
        for (const event of events) {
          const data = event.split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!data) continue;
          const payload = JSON.parse(data);
          if (payload.error) throw new Error(payload.error.message || "MCP trả về lỗi");
          await reader.cancel().catch(() => {});
          return { payload, sessionId: nextSessionId };
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!buffer.trim()) return { payload: {}, sessionId: nextSessionId };
    const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data) return { payload: {}, sessionId: nextSessionId };
    const payload = JSON.parse(data);
    if (payload.error) throw new Error(payload.error.message || "MCP trả về lỗi");
    return { payload, sessionId: nextSessionId };
  }
  const text = await response.text();
  if (!text.trim()) return { payload: {}, sessionId: nextSessionId };
  const payload = JSON.parse(text);
  if (payload.error) throw new Error(payload.error.message || "MCP trả về lỗi");
  return { payload, sessionId: nextSessionId };
}

async function mcpRequest(url, token, body, sessionId, timeoutMs = 15000) {
  const startedAt = Date.now();
  const method = String(body?.method || "request");
  const toolName = String(body?.params?.name || "");
  const toolAction = String(body?.params?.arguments?.action || "");
  const action = toolName ? `${toolName}${toolAction ? `:${toolAction}` : ""}` : method;
  try {
    const result = await mcpRequestCore(url, token, body, sessionId, timeoutMs);
    if (method === "tools/call") {
      const durationMs = Date.now() - startedAt;
      const routinePollingAction = new Set(["browser_control:list_profiles", "browser_control:get_chat_response"]).has(action);
      if (!routinePollingAction || durationMs >= 2_000) {
        diagnostic(routinePollingAction ? "warn" : "info", "mcp", "tool", routinePollingAction ? `MCP polling ${action} phản hồi chậm` : `MCP tool ${action} hoàn tất`, {
          action,
          duration_ms: durationMs
        });
      }
    }
    return result;
  } catch (error) {
    diagnostic("error", "mcp", method === "tools/call" ? "tool" : "transport", `MCP ${action} lỗi: ${error?.message || String(error)}`, {
      action,
      duration_ms: Date.now() - startedAt,
      error
    });
    throw error;
  }
}

async function openLocalMcpSession(config, token) {
  const url = `http://127.0.0.1:${config.port}/mcp`;
  const startedAt = Date.now();
  const phaseTimings = {};
  let phaseStartedAt = Date.now();
  const initialized = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "CodexPro Manager", version: MANAGER_VERSION } }
  });
  phaseTimings.initialize_ms = Date.now() - phaseStartedAt;
  const session = { url, token, sessionId: initialized.sessionId, nextId: 2, phaseTimings };
  phaseStartedAt = Date.now();
  await mcpRequest(url, token, { jsonrpc: "2.0", method: "notifications/initialized" }, session.sessionId);
  phaseTimings.initialized_notification_ms = Date.now() - phaseStartedAt;
  phaseTimings.open_total_ms = Date.now() - startedAt;
  return session;
}

async function closeLocalMcpSession(session) {
  if (!session?.url || !session?.sessionId) return;
  const startedAt = Date.now();
  try {
    await fetch(session.url, {
      method: "DELETE",
      headers: {
        accept: "application/json, text/event-stream",
        connection: "close",
        ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
        "mcp-session-id": session.sessionId
      },
      signal: AbortSignal.timeout(3000)
    });
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 1000 && diagnosticAllowed("mcp-close-session-slow", 30_000)) {
      diagnostic("warn", "mcp", "transport", `Đóng MCP session chậm (${durationMs} ms)`, {
        action: "close-mcp-session-slow",
        duration_ms: durationMs
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.CODEXPRO_MANAGER_MCP_DEBUG === "1") {
      console.error(`[manager-mcp] close session failed: ${message}`);
    }
    if (diagnosticAllowed(`mcp-close-session:${message.slice(0, 160)}`, 60_000)) {
      diagnostic("warn", "mcp", "transport", `Không đóng sạch được MCP session: ${message}`, {
        action: "close-mcp-session",
        error
      });
    }
  }
}

async function localMcpToolInSession(session, toolName, args, timeoutMs = 15000) {
  const startedAt = Date.now();
  let called;
  try {
    called = await mcpRequest(session.url, session.token, {
      jsonrpc: "2.0",
      id: session.nextId++,
      method: "tools/call",
      params: { name: toolName, arguments: args }
    }, session.sessionId, timeoutMs);
  } finally {
    if (session?.phaseTimings) {
      session.phaseTimings.tool_call_ms = Math.max(0, Number(session.phaseTimings.tool_call_ms) || 0) + (Date.now() - startedAt);
      session.phaseTimings.tool_call_count = Math.max(0, Number(session.phaseTimings.tool_call_count) || 0) + 1;
    }
  }
  const result = called.payload.result;
  if (result?.isError) {
    const message = result.content?.find((item) => item.type === "text")?.text || "CodexPro MCP trả về lỗi.";
    const structured = result.structuredContent?.error;
    const envelope = structured && typeof structured === "object" && !Array.isArray(structured) ? structured : { name: "CodexProMcpError", message };
    const error = new Error(String(envelope.message || message));
    error.name = String(envelope.name || "CodexProMcpError");
    error.code = String(envelope.code || "MCP_TOOL_ERROR");
    error.details = envelope.details && typeof envelope.details === "object" ? envelope.details : envelope;
    throw error;
  }
  return result?.structuredContent || {};
}

async function localMcpTool(config, token, toolName, args, timeoutMs = 15000) {
  const debug = process.env.CODEXPRO_MANAGER_MCP_DEBUG === "1";
  const startedAt = Date.now();
  const toolAction = String(args?.action || "");
  const toolActionName = toolAction ? `${toolName}:${toolAction}` : toolName;
  let session = null;
  try {
    if (debug) console.error(`[manager-mcp] ${toolActionName}: open session`);
    session = await openLocalMcpSession(config, token);
    if (debug) console.error(`[manager-mcp] ${toolActionName}: tools/call`);
    const result = await localMcpToolInSession(session, toolName, args, timeoutMs);
    const totalMs = Date.now() - startedAt;
    if (totalMs >= 2000 || Number(session.phaseTimings?.initialize_ms) >= 1000) {
      diagnostic("warn", "mcp", "transport", `MCP session ${toolActionName} phản hồi chậm (${totalMs} ms)`, {
        action: "mcp-session-breakdown",
        tool_action: toolActionName,
        duration_ms: totalMs,
        mcp_session_phase_timings: { ...session.phaseTimings, total_ms: totalMs }
      });
    }
    if (debug) console.error(`[manager-mcp] ${toolActionName}: tools/call complete`);
    return result;
  } finally {
    if (session) void closeLocalMcpSession(session);
  }
}

function managerErrorEnvelope(error) {
  const source = error && typeof error === "object" ? error : {};
  return {
    name: String(source.name || "Error").slice(0, 120),
    message: String(source.message || error || "CodexPro Manager action failed.").slice(0, 4000),
    code: String(source.code || "MANAGER_ACTION_FAILED").slice(0, 160),
    details: source.details && typeof source.details === "object" ? source.details : {}
  };
}

async function ipcResult(operation) {
  try { return { ok: true, value: await operation() }; }
  catch (error) { return { ok: false, error: managerErrorEnvelope(error) }; }
}

async function listBrowserProfilesThroughMcp(config, token) {
  const result = await localMcpTool(config, token, "browser_control", { action: "list_profiles" });
  return Array.isArray(result.profiles) ? result.profiles : [];
}

async function setupChatGptProfile(profileId) {
  const id = String(profileId || "").trim();
  if (!id || id.length > 160 || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("Chrome profile id không hợp lệ.");
  const status = await readyRuntimeStatus();
  if (!status.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  const profile = status.browserProfiles.find((item) => item.profile_id === id);
  if (!profile?.connected) throw new Error("Chrome profile này đang offline. Hãy mở Chrome và bật extension CodexPro.");
  if (!versionAtLeast(profile.extension_version)) {
    throw new Error(`Worker extension của profile này chưa phải bản ${WORKER_EXTENSION_VERSION}. Hãy bấm Update worker extension rồi thử lại.`);
  }
  const token = readToken(status.config.tokenFile);
  return await localMcpTool(status.config, token, "browser_control", {
    action: "setup_chatgpt",
    profile_id: id
  }, 305000);
}

async function checkChatGptProfile(profileId) {
  const id = String(profileId || "").trim();
  if (!id || id.length > 160 || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("Chrome profile id không hợp lệ.");
  const status = await readyRuntimeStatus();
  if (!status.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  const profile = status.browserProfiles.find((item) => item.profile_id === id);
  if (!profile?.connected) throw new Error("Chrome profile này đang offline.");
  const token = readToken(status.config.tokenFile);
  return await localMcpTool(status.config, token, "browser_control", {
    action: "check_chatgpt",
    profile_id: id
  }, 65000);
}

async function focusChromeWindow(chatTitle) {
  if (isMac) return focusChromeWindowMac();
  const title = String(chatTitle || "").trim();
  if (!title) return { ok: false, reason: "missing_title" };
  const encodedTitle = Buffer.from(title, "utf8").toString("base64");
  const script = `
$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTitle}'))
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CodexProWindowFocus {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
$found=[IntPtr]::Zero
$foundTitle=''
for($attempt=0;$attempt -lt 45 -and $found -eq [IntPtr]::Zero;$attempt++){
  [CodexProWindowFocus]::EnumWindows({param($h,$l)
    if(-not [CodexProWindowFocus]::IsWindowVisible($h)){return $true}
    $sb=New-Object Text.StringBuilder 512
    [CodexProWindowFocus]::GetWindowText($h,$sb,$sb.Capacity)|Out-Null
    $windowTitle=$sb.ToString()
    if(-not $windowTitle){return $true}
    [uint32]$processId=0
    [CodexProWindowFocus]::GetWindowThreadProcessId($h,[ref]$processId)|Out-Null
    try{$process=Get-Process -Id $processId -ErrorAction Stop}catch{return $true}
    if($process.ProcessName -eq 'chrome' -and ($windowTitle -eq ($target+' - Google Chrome') -or $windowTitle.StartsWith($target+' - '))){
      $script:found=$h
      $script:foundTitle=$windowTitle
      return $false
    }
    return $true
  },[IntPtr]::Zero)|Out-Null
  if($found -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 100}
}
if($found -eq [IntPtr]::Zero){[pscustomobject]@{ok=$false;title=$target;reason='window_not_found'}|ConvertTo-Json -Compress;exit 0}

[uint32]$targetPid=0
$targetThread=[CodexProWindowFocus]::GetWindowThreadProcessId($found,[ref]$targetPid)
$currentThread=[CodexProWindowFocus]::GetCurrentThreadId()
$attachedTarget=$false
$attachedForeground=$false
for($attempt=0;$attempt -lt 4;$attempt++){
  [CodexProWindowFocus]::ShowWindowAsync($found,3)|Out-Null
  $foregroundBefore=[CodexProWindowFocus]::GetForegroundWindow()
  [uint32]$foregroundPid=0
  $foregroundThread=if($foregroundBefore -ne [IntPtr]::Zero){[CodexProWindowFocus]::GetWindowThreadProcessId($foregroundBefore,[ref]$foregroundPid)}else{0}
  if($foregroundThread -gt 0 -and $foregroundThread -ne $currentThread){$attachedForeground=[CodexProWindowFocus]::AttachThreadInput($currentThread,$foregroundThread,$true)}
  if($targetThread -gt 0 -and $targetThread -ne $currentThread){$attachedTarget=[CodexProWindowFocus]::AttachThreadInput($currentThread,$targetThread,$true)}
  [CodexProWindowFocus]::BringWindowToTop($found)|Out-Null
  [CodexProWindowFocus]::SetWindowPos($found,[IntPtr](-1),0,0,0,0,0x0053)|Out-Null
  [CodexProWindowFocus]::SetWindowPos($found,[IntPtr](-2),0,0,0,0,0x0053)|Out-Null
  [CodexProWindowFocus]::SetActiveWindow($found)|Out-Null
  [CodexProWindowFocus]::SetForegroundWindow($found)|Out-Null
  Start-Sleep -Milliseconds 160
  $foreground=[CodexProWindowFocus]::GetForegroundWindow()
  if($attachedTarget){[CodexProWindowFocus]::AttachThreadInput($currentThread,$targetThread,$false)|Out-Null;$attachedTarget=$false}
  if($attachedForeground){[CodexProWindowFocus]::AttachThreadInput($currentThread,$foregroundThread,$false)|Out-Null;$attachedForeground=$false}
  if($foreground -eq $found -and [CodexProWindowFocus]::IsZoomed($found)){break}
  Start-Sleep -Milliseconds 100
}
$foreground=[CodexProWindowFocus]::GetForegroundWindow()
$maximized=[CodexProWindowFocus]::IsZoomed($found)
$foregroundMatch=($foreground -eq $found)
[pscustomobject]@{ok=([bool]$foregroundMatch -and [bool]$maximized);activated=[bool]$foregroundMatch;maximized=[bool]$maximized;foreground_match=[bool]$foregroundMatch;title=$foundTitle;hwnd=$found.ToInt64();foreground=$foreground.ToInt64();target_pid=$targetPid}|ConvertTo-Json -Compress
`;
  try {
    return JSON.parse(await runPowerShell(script));
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function isMissingChromeTabError(error) {
  return /No tab with id|tab (?:was )?(?:closed|removed|not found)|không (?:còn|tìm thấy) tab/i.test(error instanceof Error ? error.message : String(error || ""));
}

async function openProfileChat(payload) {
  const openStartedAt = Date.now();
  const openPhaseTimings = {};
  const timedOpenPhase = async (name, work) => {
    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      openPhaseTimings[name] = Math.max(0, Number(openPhaseTimings[name]) || 0) + (Date.now() - startedAt);
    }
  };
  const profileId = String(payload?.profileId || "").trim();
  const conversationId = String(payload?.conversationId || "").trim();
  const targetId = String(payload?.targetId ?? "").trim();
  const targetConversationId = String(payload?.targetConversationId || "").trim();
  const title = String(payload?.title || "").trim();
  const selectionReason = String(payload?.selectionReason || "").trim();
  const activeTargetId = String(payload?.activeTargetId ?? "").trim();
  const activeConversationId = String(payload?.activeConversationId || "").trim();
  if (!profileId || profileId.length > 160 || !/^[A-Za-z0-9._-]+$/.test(profileId)) throw new Error("Chrome profile id không hợp lệ.");
  if (conversationId && !/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) throw new Error("Đoạn chat đích không hợp lệ.");
  if (targetId && !/^\d+$/.test(targetId)) throw new Error("Tab Chrome đích không hợp lệ.");
  await headlessWorkers.assertProfileTaskExclusive(profileId);

  let resolvedTargetId = targetId;
  let createdTab = null;
  let staleTargetRecovered = false;
  let staleRecoveryReason = "";
  let session = null;
  try {
    const base = await timedOpenPhase("runtime_connection_ms", () => runtimeConnectionForSend());
    if (!base?.config?.port || !base?.token) throw new Error("Local MCP chưa sẵn sàng.");
    session = await timedOpenPhase("mcp_session_open_ms", () => openLocalMcpSession(base.config, base.token));
    const callBrowserControl = (args, timeoutMs) => localMcpToolInSession(session, "browser_control", args, timeoutMs);
    const openFreshChat = async () => {
      if (!staleRecoveryReason) staleRecoveryReason = "missing_tab";
      createdTab = await timedOpenPhase("stale_recovery_open_tab_ms", () => callBrowserControl({
        action: "open_tab",
        profile_id: profileId,
        url: "https://chatgpt.com/"
      }, 30000));
      resolvedTargetId = String(createdTab?.target_id ?? "").trim();
      if (!/^\d+$/.test(resolvedTargetId)) throw new Error("Đã yêu cầu tạo chat mới nhưng extension không trả về tab mới.");
      staleTargetRecovered = true;
      return createdTab;
    };

    if (!resolvedTargetId) {
      createdTab = await timedOpenPhase("open_tab_ms", () => callBrowserControl({
        action: "open_tab",
        profile_id: profileId,
        url: conversationId ? `https://chatgpt.com/c/${conversationId}` : "https://chatgpt.com/"
      }, 30000));
      resolvedTargetId = String(createdTab?.target_id ?? "").trim();
      if (!/^\d+$/.test(resolvedTargetId)) throw new Error("Đã yêu cầu mở ChatGPT nhưng extension không trả về tab mới.");
    }

    let navigation = null;
    if (!createdTab && conversationId && targetConversationId !== conversationId) {
      try {
        navigation = await timedOpenPhase("navigate_ms", () => callBrowserControl({
          action: "navigate",
          profile_id: profileId,
          target_id: resolvedTargetId,
          url: `https://chatgpt.com/c/${conversationId}`
        }, 30000));
      } catch (error) {
        if (!isMissingChromeTabError(error)) throw error;
        staleRecoveryReason = "navigate_missing_tab";
        await openFreshChat();
      }
    }

    let activation = null;
    let activationError = null;
    try {
      activation = await timedOpenPhase("activate_tab_ms", () => callBrowserControl({
        action: "activate_tab",
        profile_id: profileId,
        target_id: resolvedTargetId,
        conversation_id: conversationId || targetConversationId || undefined
      }, 32000));
    } catch (error) {
      if (/CONVERSATION_VERIFY_FAILED/i.test(error instanceof Error ? error.message : String(error || ""))) throw error;
      if (!createdTab && isMissingChromeTabError(error)) {
        staleRecoveryReason = "activate_missing_tab";
        await openFreshChat();
        activation = await timedOpenPhase("stale_recovery_activate_ms", () => callBrowserControl({
          action: "activate_tab",
          profile_id: profileId,
          target_id: resolvedTargetId,
          conversation_id: conversationId || targetConversationId || undefined
        }, 32000));
      } else {
        activationError = error;
      }
    }

    // chrome.windows.update({ focused: true }) may report success before Windows
    // has actually transferred foreground ownership. Always verify/force the
    // native foreground window so a hidden Chrome window is never treated as open.
    const windowFocus = await timedOpenPhase("window_focus_ms", () => focusChromeWindow(title || createdTab?.title || "ChatGPT"));
    if (!windowFocus?.ok) {
      if (activationError) {
        const reason = activationError instanceof Error ? activationError.message : String(activationError);
        throw new Error(`Không mở được profile Chrome vì extension chưa phản hồi lệnh activate tab: ${reason}`);
      }
      throw new Error("Đã chọn đúng tab nhưng Windows chưa đưa Chrome lên trước. Hãy thử lại một lần.");
    }

    return {
      ok: true,
      profile_id: profileId,
      conversation_id: staleTargetRecovered ? "" : conversationId || targetConversationId,
      target_id: Number(resolvedTargetId),
      target_conversation_id: staleTargetRecovered ? "" : targetConversationId,
      target_title: title,
      selection_reason: selectionReason,
      active_target_id: activeTargetId,
      active_conversation_id: activeConversationId,
      tab_created: Boolean(createdTab),
      stale_target_recovered: staleTargetRecovered,
      stale_recovery_reason: staleRecoveryReason,
      created_tab: createdTab,
      navigation,
      activation: activation || { ok: true, acknowledgement_delayed: true },
      activation_acknowledgement_delayed: Boolean(activationError),
      window_focus: windowFocus,
      runtime_connection_source: base.source,
      open_phase_timings: {
        ...openPhaseTimings,
        mcp_session: { ...(session.phaseTimings || {}) },
        total_ms: Date.now() - openStartedAt
      }
    };
  } catch (error) {
    if (error && typeof error === "object") {
      error.details = {
        ...(error.details && typeof error.details === "object" ? error.details : {}),
        requested_target_id: targetId,
        resolved_target_id: resolvedTargetId,
        stale_target_recovered: staleTargetRecovered,
        stale_recovery_reason: staleRecoveryReason,
        open_phase_timings: {
          ...openPhaseTimings,
          mcp_session: { ...(session?.phaseTimings || {}) },
          total_ms: Date.now() - openStartedAt
        }
      };
    }
    throw error;
  } finally {
    if (session) void closeLocalMcpSession(session);
  }
}

async function recoverProfileChatTab(payload) {
  const profileId = String(payload?.profileId || "").trim();
  const conversationId = String(payload?.conversationId || "").trim();
  const targetId = String(payload?.targetId ?? "").trim();
  const title = String(payload?.title || "").trim();
  const silent = payload?.silent === true;
  const newChat = payload?.newChat === true;
  const discardOnly = payload?.discardOnly === true;
  if (!profileId || profileId.length > 160 || !/^[A-Za-z0-9._-]+$/.test(profileId)) throw new Error("Chrome profile id không hợp lệ.");
  if (targetId && !/^\d+$/.test(targetId)) throw new Error("Tab Chrome không hợp lệ.");
  const base = await runtimeConnectionForSend();
  if (!base?.config?.port || !base?.token) throw new Error("Local MCP chưa sẵn sàng.");
  if (discardOnly) {
    if (!targetId) throw new Error("Không tìm thấy tab cũ cần đóng.");
    try {
      const closed = await localMcpTool(base.config, base.token, "browser_control", {
        action: "close_tab",
        profile_id: profileId,
        target_id: targetId
      }, 15000);
      return { ...closed, ok: true, discarded: true, target_id: Number(targetId) };
    } catch (error) {
      if (isMissingChromeTabError(error)) return { ok: true, discarded: true, already_closed: true, target_id: Number(targetId) };
      throw error;
    }
  }
  if (!newChat && !/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) throw new Error("Đoạn chat cần khôi phục không hợp lệ.");
  if (!newChat && !targetId) throw new Error("Khong tim thay tab Chrome can khoi phuc.");
  const result = await localMcpTool(base.config, base.token, "browser_control", {
    action: "recover_chat_tab",
    profile_id: profileId,
    conversation_id: conversationId || undefined,
    target_id: targetId || undefined,
    new_chat: newChat
  }, 60000);
  const windowFocus = silent ? { ok: false, skipped: true, source: "auto-recovery" } : await focusChromeWindow(title);
  return { ...result, window_focus: windowFocus };
}
async function auditLongRunningProfileChat(payload) {
  const profileId = String(payload?.profileId || "").trim();
  const conversationId = String(payload?.conversationId || "").trim();
  const targetId = String(payload?.targetId ?? "").trim();
  const taskId = String(payload?.taskId || "").trim().slice(0, 160);
  const startedAt = String(payload?.startedAt || "").trim().slice(0, 80);
  const attemptKey = String(payload?.attemptKey || "").trim().slice(0, 300);
  if (!profileId || profileId.length > 160 || !/^[A-Za-z0-9._-]+$/.test(profileId)) throw new Error("Chrome profile id không hợp lệ.");
  if (!/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) throw new Error("Đoạn chat cần kiểm tra không hợp lệ.");
  if (!targetId || !/^\d+$/.test(targetId)) throw new Error("Không tìm thấy tab Chrome cần kiểm tra.");
  if (!attemptKey) throw new Error("Thiếu khóa audit task chạy lâu.");
  const base = await runtimeConnectionForSend();
  if (!base?.config?.port || !base?.token) throw new Error("Local MCP chưa sẵn sàng.");
  return await localMcpTool(base.config, base.token, "browser_control", {
    action: "audit_long_running_chat",
    profile_id: profileId,
    conversation_id: conversationId,
    target_id: targetId,
    task_id: taskId || undefined,
    started_at: startedAt || undefined,
    attempt_key: attemptKey
  }, 135000);
}
async function stopProfileTask(payload) {
  const profileId = String(payload?.profileId || "").trim();
  const conversationId = String(payload?.conversationId || "").trim();
  const targetId = String(payload?.targetId ?? "").trim();
  const taskId = String(payload?.taskId || "").trim();
  if (!profileId || profileId.length > 160 || !/^[A-Za-z0-9._-]+$/.test(profileId)) throw new Error("Chrome profile id không hợp lệ.");
  if (conversationId && !/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) throw new Error("Đoạn chat cần dừng không hợp lệ.");
  if (!targetId || !/^\d+$/.test(targetId)) throw new Error("Không tìm thấy tab Chrome cần dừng.");
  const base = await readyRuntimeBaseStatus();
  if (!base.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  return await localMcpTool(base.config, base.token, "browser_control", {
    action: "stop_chat_generation",
    profile_id: profileId,
    conversation_id: conversationId || undefined,
    target_id: targetId,
    task_id: /^cpt_[a-f0-9]{24}$/.test(taskId) ? taskId : undefined
  }, 15000);
}

async function reloadChromeProfiles() {
  let status = await readyRuntimeStatus();
  for (let attempt = 0; attempt < 2 && (!status.local.ok || status.workerSnapshotAvailable === false); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    status = await runtimeStatus({ forceRefresh: true });
  }
  if (!status.local.ok || status.workerSnapshotAvailable === false) {
    return { ok: true, mode: "runtime_unavailable", count: 0, failed: 0, deferred: 0, outdated: 0, version: WORKER_EXTENSION_VERSION };
  }
  const connectedProfiles = status.browserProfiles.filter((profile) => profile.connected);
  if (!connectedProfiles.length) throw new Error("Không có Chrome profile nào đang kết nối.");
  const outdated = connectedProfiles.filter((profile) => !versionAtLeast(profile.extension_version));
  if (!outdated.length) return { ok: true, mode: "up_to_date", count: 0, failed: 0, deferred: 0, outdated: 0, version: WORKER_EXTENSION_VERSION };
  if (!status.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  await syncInstalledWorkerExtension();

  const safeToReload = (profile) => {
    const tabs = Array.isArray(profile.conversation_tabs) ? profile.conversation_tabs : [];
    const hasBusyTab = tabs.some((tab) => tab?.busy || tab?.settling || String(tab?.network_state || "") === "generating");
    return ["idle", "no_chatgpt"].includes(profile.activity) && Number(profile.busy_request_count || 0) === 0 && !hasBusyTab;
  };
  const reloadable = outdated.filter(safeToReload);
  const deferred = outdated.filter((profile) => !safeToReload(profile));
  if (!reloadable.length) {
    return {
      ok: true,
      mode: "deferred_busy",
      count: 0,
      failed: 0,
      deferred: deferred.length,
      outdated: outdated.length,
      version: WORKER_EXTENSION_VERSION
    };
  }

  const token = readToken(status.config.tokenFile);
  const legacy = reloadable.filter((profile) => {
    const [major = 0, minor = 0] = String(profile.extension_version || "").split(".").map(Number);
    return !(major > 0 || (major === 0 && minor >= 4));
  });
  const modern = reloadable.filter((profile) => !legacy.includes(profile));

  const legacyResults = await Promise.allSettled(legacy.map((profile) => localMcpTool(status.config, token, "browser_control", {
    action: "open_tab",
    profile_id: profile.profile_id,
    url: "chrome-extension://gndipignbnipohooclcbhjliikamjlpl/popup.html?codexpro_reload=1"
  }, 20000)));
  const modernResults = await Promise.allSettled(modern.map((profile) => localMcpTool(status.config, token, "browser_control", {
    action: "reload_extension",
    profile_id: profile.profile_id
  }, 20000)));

  const attemptedProfiles = [...legacy, ...modern];
  const results = [...legacyResults, ...modernResults];
  const reloadAcceptedIds = new Set(results.flatMap((result, index) => result.status === "fulfilled" ? [attemptedProfiles[index].profile_id] : []));
  const racedBusy = results.filter((result) => result.status === "rejected" && /WORKER_BUSY/i.test(String(result.reason?.message || result.reason || ""))).length;
  let confirmedIds = new Set();
  if (reloadAcceptedIds.size) {
    const confirmationDeadline = Date.now() + 15000;
    while (Date.now() < confirmationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const refreshed = await runtimeStatus();
      confirmedIds = new Set(refreshed.browserProfiles
        .filter((profile) => reloadAcceptedIds.has(profile.profile_id) && profile.connected && versionAtLeast(profile.extension_version))
        .map((profile) => profile.profile_id));
      if (confirmedIds.size === reloadAcceptedIds.size) break;
    }
  }
  const updated = confirmedIds.size;
  const unconfirmed = reloadAcceptedIds.size - updated;
  const hardFailures = results.length - reloadAcceptedIds.size - racedBusy + unconfirmed;
  const deferredCount = deferred.length + racedBusy;
  if (!updated && hardFailures) {
    throw new Error(`Worker đã nhận lệnh reload nhưng chưa xác nhận chạy bản ${WORKER_EXTENSION_VERSION}. Hãy kiểm tra đường dẫn extension trong chrome://extensions.`);
  }
  if (!updated) {
    return {
      ok: true,
      mode: "deferred_busy",
      count: 0,
      failed: 0,
      deferred: deferredCount,
      outdated: outdated.length,
      version: WORKER_EXTENSION_VERSION
    };
  }
  return {
    ok: true,
    mode: legacy.length ? (modern.length ? "mixed_update" : "bootstrap_reload") : "extension_reload",
    count: updated,
    failed: hardFailures,
    deferred: deferredCount,
    outdated: outdated.length,
    version: WORKER_EXTENSION_VERSION
  };
}

const profileSendOperations = new Map();

async function sendProfileRequestUnlocked(payload) {
  const sendDebug = process.env.CODEXPRO_MANAGER_MCP_DEBUG === "1";
  if (sendDebug) console.error('[manager-send] start');
  const profileId = String(payload?.profileId || "").trim();
  const conversationId = String(payload?.conversationId || "").trim();
  const newChat = Boolean(payload?.newChat);
  const text = String(payload?.text || "").trim();
  const requestedWorkflow = String(payload?.workflow || "").trim();
  const taskWorkflow = resolveTaskWorkflow(requestedWorkflow, text);
  const requestedScope = payload?.scope === "all_allowed" ? "all_allowed" : "workspace";
  const requestedProjectRoot = String(payload?.projectRoot || "").trim();
  const requestedWorkspaceCandidates = Array.isArray(payload?.workspaceCandidates) ? payload.workspaceCandidates.slice(0, 80) : [];
  const requestedFiles = Array.isArray(payload?.attachments) ? payload.attachments.slice(0, MAX_REQUEST_ATTACHMENTS) : [];
  const previousTaskId = String(payload?.previousTaskId || "").trim();
  if (previousTaskId && !/^cpt_[a-f0-9]{24}$/.test(previousTaskId)) throw new Error("CodexPro task id trước đó không hợp lệ.");
  const taskId = previousTaskId || `cpt_${randomBytes(12).toString("hex")}`;
  const taskIdReused = Boolean(previousTaskId);
  const toolRetry = Boolean(payload?.toolRetry);
  const toolRolloverCount = Math.max(0, Math.min(1, Number(payload?.toolRolloverCount) || 0));
  if (!profileId || profileId.length > 160 || !/^[A-Za-z0-9._-]+$/.test(profileId)) throw new Error("Chrome profile id không hợp lệ.");
  if (!newChat && !/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) throw new Error("Đoạn chat đích không hợp lệ.");
  if (!text && !requestedFiles.length) throw new Error("Hãy nhập yêu cầu hoặc chọn ít nhất một file.");
  if (requestedScope === "workspace" && !requestedProjectRoot) throw new Error("Hãy chọn thư mục hoặc dự án cần làm trước khi gửi yêu cầu.");
  if (text.length > 20000) throw new Error("Yêu cầu dài quá 20.000 ký tự.");
  await headlessWorkers.assertProfileTaskExclusive(profileId);
  const sendStartedAt = Date.now();
  const files = requestedFiles.map((file) => requestFileSummary(file?.path));
  if (files.some((file) => file.size > MAX_REQUEST_ATTACHMENT_BYTES)) throw new Error("Mỗi file được tối đa 8 MB.");
  if (files.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_ATTACHMENTS_TOTAL_BYTES) throw new Error("Tổng file đính kèm được tối đa 10 MB.");
  const attachmentsPromise = Promise.all(files.map(async (file) => ({
    name: file.name,
    mime_type: file.mimeType,
    data_base64: (await fs.promises.readFile(file.path)).toString("base64")
  })));
  if (sendDebug) console.error('[manager-send] before runtimeConnectionForSend');
  let base = await runtimeConnectionForSend();
  if (sendDebug) console.error(`[manager-send] runtime source=${base.source}`);
  if (!base.token) throw new Error("CodexPro chưa có token local MCP.");
  let allowedRoots = allowedWorkspaceRoots(base.config);
  if (!allowedRoots.length) throw new Error("CodexPro chưa có vùng workspace nào được cấp quyền.");
  const isCodexProWorkspaceRequest = (config) => {
    if (requestedScope !== "workspace" || !requestedProjectRoot) return false;
    const runtimeRoot = String(config?.root || "").trim();
    return Boolean(runtimeRoot && path.resolve(requestedProjectRoot).toLowerCase() === path.resolve(runtimeRoot).toLowerCase());
  };
  let codexProWorkspaceExpanded = isCodexProWorkspaceRequest(base.config);
  let requestScope = codexProWorkspaceExpanded ? "all_allowed" : requestedScope;
  const resolveWorkspaceCandidates = () => [...new Set(requestedWorkspaceCandidates
    .map((root) => String(root || "").trim())
    .filter(Boolean)
    .map((root) => path.resolve(root))
    .filter((root) => fs.existsSync(root) && fs.statSync(root).isDirectory() && allowedRoots.some((allowedRoot) => pathInside(root, allowedRoot))))];
  let workspaceCandidates = resolveWorkspaceCandidates();
  let selectedProject = null;
  let initialWorkspaceRoot = "";
  if (requestedScope === "workspace") {
    const resolvedProjectRoot = path.resolve(requestedProjectRoot);
    if (!fs.existsSync(resolvedProjectRoot) || !fs.statSync(resolvedProjectRoot).isDirectory()) throw new Error("Thư mục đã chọn không còn tồn tại.");
    if (!allowedRoots.some((root) => pathInside(resolvedProjectRoot, root))) throw new Error("Thư mục đã chọn nằm ngoài vùng workspace được CodexPro cấp quyền.");
    selectedProject = { root: resolvedProjectRoot };
    initialWorkspaceRoot = resolvedProjectRoot;
  }
  let session;
  try {
    session = await openLocalMcpSession(base.config, base.token);
  } catch (fastError) {
    if (sendDebug) console.error('[manager-send] fast MCP connect failed; falling back to full runtime health');
    const refreshed = await readyRuntimeBaseStatus();
    if (!refreshed.local.ok) throw new Error("Local MCP chưa sẵn sàng.", { cause: fastError });
    base = { config: refreshed.config, token: refreshed.token, source: "health-fallback" };
    allowedRoots = allowedWorkspaceRoots(base.config);
    if (!allowedRoots.length) throw new Error("CodexPro chưa có vùng workspace nào được cấp quyền.");
    codexProWorkspaceExpanded = isCodexProWorkspaceRequest(base.config);
    requestScope = codexProWorkspaceExpanded ? "all_allowed" : requestedScope;
    workspaceCandidates = resolveWorkspaceCandidates();
    if (requestedScope === "workspace") {
      const resolvedProjectRoot = path.resolve(requestedProjectRoot);
      if (!allowedRoots.some((root) => pathInside(resolvedProjectRoot, root))) throw new Error("Thư mục đã chọn nằm ngoài vùng workspace được CodexPro cấp quyền.");
      selectedProject = { root: resolvedProjectRoot };
      initialWorkspaceRoot = resolvedProjectRoot;
    }
    session = await openLocalMcpSession(base.config, base.token);
  }
  try {
  const streamedProfile = cachedBrowserProfileForSend(profileId);
  const [attachments, profileResult] = await Promise.all([
    attachmentsPromise,
    streamedProfile ? Promise.resolve(null) : localMcpToolInSession(session, "browser_control", { action: "list_profiles" })
  ]);
  let profiles = Array.isArray(profileResult?.profiles) ? profileResult.profiles : [];
  let profile = streamedProfile || profiles.find((item) => item.profile_id === profileId);
  let profilePreflightSource = streamedProfile ? "browser-event-stream" : "list-profiles";
  if (!profile?.connected) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const refreshedProfiles = await localMcpToolInSession(session, "browser_control", { action: "list_profiles" });
    profiles = Array.isArray(refreshedProfiles.profiles) ? refreshedProfiles.profiles : [];
    profile = profiles.find((item) => item.profile_id === profileId);
    profilePreflightSource = "list-profiles-refresh";
  }
  if (!profile) throw new Error("Profile Chrome này không còn được CodexPro nhận diện.");
  const profileHadChatGptTab = Boolean(
    (Array.isArray(profile.chatgpt_tabs) && profile.chatgpt_tabs.length)
    || (Array.isArray(profile.conversation_tabs) && profile.conversation_tabs.length)
  );
  if (!versionAtLeast(profile.extension_version)) {
    if (sendDebug) console.error(`[manager-send] updating worker ${profile.extension_version || "unknown"} -> ${WORKER_EXTENSION_VERSION}`);
    await syncInstalledWorkerExtension();
    await localMcpToolInSession(session, "browser_control", {
      action: "reload_extension",
      profile_id: profileId
    }, 75000);
    const updateDeadline = Date.now() + 15000;
    while (Date.now() < updateDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const updateProfiles = await localMcpToolInSession(session, "browser_control", { action: "list_profiles" });
      profile = (Array.isArray(updateProfiles.profiles) ? updateProfiles.profiles : []).find((item) => item.profile_id === profileId);
      if (profile?.connected && versionAtLeast(profile.extension_version)) break;
    }
    if (!profile?.connected || !versionAtLeast(profile.extension_version)) {
      throw new Error(`Không thể tự update worker extension lên ${WORKER_EXTENSION_VERSION}. Hãy mở chrome://extensions và reload CodexPro.`);
    }
  }
  if (profile.connector_update_required || profile.connector_profile_bound === false) {
    if (sendDebug) console.error(`[manager-send] rebinding CodexPro connector to profile ${profileId}`);
    await localMcpToolInSession(session, "browser_control", {
      action: "setup_chatgpt",
      profile_id: profileId
    }, 310000);
    const connectorDeadline = Date.now() + 20000;
    while (Date.now() < connectorDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const connectorProfiles = await localMcpToolInSession(session, "browser_control", { action: "list_profiles" });
      profile = (Array.isArray(connectorProfiles.profiles) ? connectorProfiles.profiles : []).find((item) => item.profile_id === profileId);
      if (profile?.connected && profile.connector_installed && profile.connector_profile_bound) break;
    }
    if (!profile?.connected || !profile.connector_installed || !profile.connector_profile_bound) {
      throw new Error("CodexPro connector chưa được gắn đúng profile Chrome. Hãy cập nhật connector rồi gửi lại.");
    }
  }
  let selectedConversationTab = newChat ? null : (profile.conversation_tabs || []).find((tab) => String(tab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] === conversationId);
  if (!newChat && (selectedConversationTab?.connection_interrupted || selectedConversationTab?.message_delivery_timed_out)) {
    await localMcpToolInSession(session, "browser_control", {
      action: "get_chat_response",
      profile_id: profileId,
      conversation_id: conversationId,
      target_id: selectedConversationTab.id,
      read_dom: true,
      recover_stale_dom: true
    }, 75000);
    const recoveredProfiles = await localMcpToolInSession(session, "browser_control", { action: "list_profiles" });
    profile = (Array.isArray(recoveredProfiles.profiles) ? recoveredProfiles.profiles : []).find((item) => item.profile_id === profileId) || profile;
    selectedConversationTab = (profile.conversation_tabs || []).find((tab) => String(tab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] === conversationId) || null;
    if (selectedConversationTab?.connection_interrupted || selectedConversationTab?.message_delivery_timed_out) {
      throw new Error("ChatGPT vẫn đang phục hồi lượt trả lời bị gián đoạn. Hãy thử gửi lại sau vài giây.");
    }
  }
  const selectedNetworkState = String(selectedConversationTab?.network_state || "");
  if (selectedConversationTab?.busy || selectedNetworkState === "generating") throw new Error("Đoạn chat này đang xử lý yêu cầu khác. Hãy chờ trạng thái về ĐANG RẢNH.");
  if (!newChat) {
    const allowedConversationIds = new Set([
      ...(profile.recent_conversations || []).map((conversation) => String(conversation.id || "")),
      ...(profile.conversation_tabs || []).map((tab) => String(tab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "")
    ]);
    if (!allowedConversationIds.has(conversationId)) throw new Error("Đoạn chat không còn thuộc 3 chat gần nhất của profile này.");
  }
  if (sendDebug) console.error('[manager-send] before send_chat_request tool');
  const currentWorkspaceRoot = String(profile.current_workspace_root || "").trim();
  const workspaceSelectSkipped = (!codexProWorkspaceExpanded && requestScope === "all_allowed") || Boolean(currentWorkspaceRoot && initialWorkspaceRoot && path.resolve(currentWorkspaceRoot).toLowerCase() === path.resolve(initialWorkspaceRoot).toLowerCase());
  if (!workspaceSelectSkipped) {
    await localMcpToolInSession(session, "browser_control", {
      action: "select_workspace",
      profile_id: profileId,
      root: initialWorkspaceRoot
    }, 75000);
  }
  const preparedTask = await localMcpToolInSession(session, "prepare_repo_task", {
    profile_id: profileId,
    task_id: taskId,
    ...(requestScope === "workspace" ? { root: initialWorkspaceRoot } : {}),
    scope: requestScope
  }, 15000);
  if (preparedTask?.prepared !== true || String(preparedTask?.task_id || "") !== taskId) {
    throw new Error("CodexPro server không xác nhận task gate trước khi gửi request.");
  }
  const taskScopeLines = codexProWorkspaceExpanded
    ? [
        `Workspace chính đã được CodexPro Manager chọn cho yêu cầu này: ${selectedProject.root}`,
        "Vì workspace chính là CodexPro, Manager tự kèm quyền truy cập TẤT CẢ VÙNG ĐƯỢC CẤP QUYỀN để có thể đọc/đối chiếu source tham chiếu bên ngoài repo chính khi cần.",
        `Các vùng CodexPro hiện được phép truy cập: ${allowedRoots.join(" ; ")}`,
        `Task ID bắt buộc: ${taskId}`,
        "BẮT BUỘC tự đặt task_title tự nhiên, dễ hiểu, dài 4-6 từ và mô tả đúng việc đang làm; không dùng tên chung chung như Làm sao, Sửa đi, Làm đi, Check giúp.",
        "BẮT BUỘC tự phân loại task_kind: dùng general nếu chỉ hỏi đáp/nghiên cứu web/giải thích và không đụng source; dùng code nếu cần đọc, sửa, build hoặc test repo.",
        `Nếu task_kind=general: BẮT BUỘC gọi tool MCP CodexPro "codexpro" với action="begin_repo_task" và args={"task_id":"${taskId}","task_title":"<tên task 4-6 từ do bạn tự đặt>","task_kind":"general","scope":"all_allowed"}.`,
        `Nếu task_kind=code: BẮT BUỘC gọi tool MCP CodexPro "codexpro" với action="begin_repo_task" và args={"task_id":"${taskId}","task_title":"<tên task 4-6 từ do bạn tự đặt>","task_kind":"code","root":"${selectedProject.root.replace(/\\/g, "\\\\")}","scope":"all_allowed"} trước mọi câu trả lời. Workspace CodexPro vẫn là workspace chính để sửa/build/test.`,
        "Nếu task_kind=code, BẮT BUỘC sử dụng MCP CodexPro để kiểm tra thật. Nếu task_kind=general, không được gọi tool workspace chỉ để tạo bằng chứng giả.",
        "Sau khi begin_repo_task với task_kind=code thành công, bạn ĐƯỢC PHÉP dùng open_workspace để chuyển sang bất kỳ repo/thư mục nào nằm trong các vùng đã cấp quyền ở trên nhằm ĐỌC và đối chiếu source tham chiếu (ví dụ DeepSeek Harness), rồi quay lại workspace CodexPro để sửa/build/test. Không được truy cập đường dẫn ngoài các vùng đó và không sửa source tham chiếu ngoài workspace chính trừ khi người dùng yêu cầu rõ."
      ]
    : requestScope === "all_allowed"
    ? [
        "CodexPro Manager đang ở chế độ TẤT CẢ VÙNG ĐƯỢC CẤP QUYỀN. Không có repo hoặc đường dẫn cụ thể bị khóa cho yêu cầu này.",
        `Các vùng CodexPro hiện được phép truy cập: ${allowedRoots.join(" ; ")}`,
        ...(workspaceCandidates.length ? [`Các repo/thư mục Manager đang biết: ${workspaceCandidates.join(" ; ")}`] : []),
        `Task ID bắt buộc: ${taskId}`,
        "BẮT BUỘC tự đặt task_title tự nhiên, dễ hiểu, dài 4-6 từ và mô tả đúng việc đang làm; không dùng tên chung chung như Làm sao, Sửa đi, Làm đi, Check giúp.",
        "BẮT BUỘC tự phân loại task_kind: dùng general nếu chỉ hỏi đáp/nghiên cứu web/giải thích và không đụng source; dùng code nếu cần đọc, sửa, build hoặc test repo.",
        `Nếu task_kind=general: BẮT BUỘC gọi tool MCP CodexPro "codexpro" với action="begin_repo_task" và args={"task_id":"${taskId}","task_title":"<tên task 4-6 từ do bạn tự đặt>","task_kind":"general","scope":"all_allowed"}. Không truyền root vì task này không dùng workspace.`,
        `Nếu task_kind=code: BẮT BUỘC tự chọn đúng repo/thư mục thực sự liên quan tới yêu cầu rồi gọi tool MCP CodexPro "codexpro" với action="begin_repo_task" và args={"task_id":"${taskId}","task_title":"<tên task 4-6 từ do bạn tự đặt>","task_kind":"code","root":"<đường dẫn repo/thư mục thực sự cần thao tác>","scope":"all_allowed"}. Không được mặc định dùng workspace CodexPro hiện tại/default chỉ vì nó đang mở; nếu chưa biết repo cụ thể, chọn vùng được cấp quyền hẹp nhất phù hợp để tìm từ đó.`,
        "Nếu task_kind=code, BẮT BUỘC sử dụng MCP CodexPro để kiểm tra thật. Nếu task_kind=general, không được gọi tool workspace chỉ để tạo bằng chứng giả.",
        "Sau khi begin_repo_task với task_kind=code thành công, bạn ĐƯỢC PHÉP dùng open_workspace để chuyển giữa các workspace nằm bên trong những vùng CodexPro đã được cấp quyền ở trên nhằm tìm đúng dự án hoặc file. Không được truy cập đường dẫn nằm ngoài các vùng đó."
      ]
    : [
        `Workspace đã được CodexPro Manager khóa cho yêu cầu này: ${selectedProject.root}`,
        `Task ID bắt buộc: ${taskId}`,
        "BẮT BUỘC tự đặt task_title tự nhiên, dễ hiểu, dài 4-6 từ và mô tả đúng việc đang làm; không dùng tên chung chung như Làm sao, Sửa đi, Làm đi, Check giúp.",
        "BẮT BUỘC tự phân loại task_kind: dùng general nếu chỉ hỏi đáp/nghiên cứu web/giải thích và không đụng source; dùng code nếu cần đọc, sửa, build hoặc test repo.",
        `BẮT BUỘC gọi tool MCP CodexPro "codexpro" với action="begin_repo_task" và args={"task_id":"${taskId}","task_title":"<tên task 4-6 từ do bạn tự đặt>","task_kind":"<general hoặc code>","root":"${selectedProject.root.replace(/\\/g, "\\\\")}"} trước mọi câu trả lời. Phải thay cả hai placeholder bằng giá trị thật. task_kind=general chỉ ghi title, không đọc CODEXPRO.md và không chạy CodexGraph; task_kind=code mới nạp rule, chạy CodexGraph và mở tool workspace.`,
        "Nếu task_kind=code, BẮT BUỘC sử dụng MCP CodexPro để kiểm tra thật. Nếu task_kind=general, không được gọi tool workspace chỉ để tạo bằng chứng giả.",
        "Sau khi begin_repo_task với task_kind=code thành công, hãy đọc và thao tác đúng workspace đã khóa. Không chuyển sang workspace khác."
      ];
  const taskText = [
    ...(newChat ? ["@CodexPro"] : ["Hãy sử dụng MCP CodexPro đã được kích hoạt trong đoạn chat này."]),
    ...taskScopeLines,
    ...(toolRetry ? ["Đây là lần gửi lại vì phản hồi trước không trả task title qua CodexPro. Phải gọi codexpro action=begin_repo_task với task_title và task_kind ngay."] : []),
    ...(taskWorkflow ? ["", buildTaskWorkflowPrompt(taskWorkflow.id)] : []),
    "",
    text ? `Yêu cầu của người dùng:\n${text}` : "Yêu cầu của người dùng nằm trong file đính kèm."
  ].join("\n");
  const dispatchStartedAt = Date.now();
  const taskDispatchedAt = new Date(dispatchStartedAt).toISOString();
  const result = await localMcpToolInSession(session, "browser_control", {
    action: "send_chat_request",
    profile_id: profileId,
    conversation_id: newChat ? undefined : conversationId,
    new_chat: newChat,
    text: taskText,
    attachments,
    one_shot_recovery: payload?.oneShotRecovery === true
  }, 235000);
  if (sendDebug) console.error('[manager-send] after send_chat_request tool');
  if (taskWorkflow) {
    diagnostic("info", "worker", "task-workflow", `Đã giao checklist ${taskWorkflow.label} cho Chrome worker`, {
      action: "task-workflow-started",
      workflow_id: taskWorkflow.id,
      workflow_version: taskWorkflow.version,
      task_id: taskId,
      profile_id: profileId,
      workspace_root: initialWorkspaceRoot,
      request_scope: requestScope
    });
  }
  return { ...result, repo_task_id: taskId, repo_task_id_reused: taskIdReused, repo_task_dispatched_at: taskDispatchedAt, repo_task_scope: requestScope, repo_task_policy: "title_always_code_evidence_on_demand", repo_task_retry_count: toolRetry ? 1 : 0, repo_task_rollover_count: toolRolloverCount, manager_preflight_ms: Math.max(0, dispatchStartedAt - sendStartedAt), manager_total_ms: Math.max(0, Date.now() - sendStartedAt), workspace_select_skipped: workspaceSelectSkipped, codexpro_workspace_expanded_scope: codexProWorkspaceExpanded, runtime_connection_source: base.source, profile_preflight_source: profilePreflightSource, profile_had_chatgpt_tab: profileHadChatGptTab, chatgpt_tab_auto_opened: !profileHadChatGptTab && Boolean(result?.target_id), workflow_id: taskWorkflow?.id, workflow_version: taskWorkflow?.version };
  } finally {
    await closeLocalMcpSession(session);
  }
}

async function sendProfileRequest(payload) {
  const profileId = String(payload?.profileId || "").trim();
  if(profileSendOperations.has(profileId))throw new Error("Profile này đang gửi một yêu cầu khác. Hãy chờ network ACK trước khi gửi tiếp.");
  const operation=runtimeRestartGuard.runSend(()=>sendProfileRequestUnlocked(payload));
  profileSendOperations.set(profileId,operation);
  try{return await operation;}
  finally{if(profileSendOperations.get(profileId)===operation)profileSendOperations.delete(profileId);}
}

async function getRepoTaskStatus(payload) {
  const taskId = String(payload?.taskId || "").trim();
  if (!/^cpt_[a-f0-9]{24}$/.test(taskId)) throw new Error("CodexPro task id không hợp lệ.");
  const base = await runtimeBaseStatus();
  if (!base.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  return await localMcpTool(base.config, base.token, "repo_task_status", { task_id: taskId }, 15000);
}

async function renameProfileChat(payload) {
  const profileId = String(payload?.profileId || "").trim();
  const conversationId = String(payload?.conversationId || "").trim();
  const title = String(payload?.title || "").trim();
  if (!profileId || profileId.length > 160 || !/^[A-Za-z0-9._-]+$/.test(profileId)) throw new Error("Chrome profile id không hợp lệ.");
  if (!/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) throw new Error("Đoạn chat đích không hợp lệ.");
  if (!title || title.length > 120) throw new Error("Tên đoạn chat phải từ 1 đến 120 ký tự.");
  const status = await readyRuntimeStatus();
  if (!status.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  const profile = status.browserProfiles.find((item) => item.profile_id === profileId);
  if (!profile?.connected) throw new Error("Extension của profile này đang mất heartbeat với CodexPro.");
  const allowedConversationIds = new Set([
    ...(profile.recent_conversations || []).map((conversation) => String(conversation.id || "")),
    ...(profile.conversation_tabs || []).map((tab) => String(tab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "")
  ]);
  if (!allowedConversationIds.has(conversationId)) throw new Error("Đoạn chat không còn thuộc 3 chat gần nhất của profile này.");
  const token = readToken(status.config.tokenFile);
  return await localMcpTool(status.config, token, "browser_control", {
    action: "rename_chat",
    profile_id: profileId,
    conversation_id: conversationId,
    title
  }, 30000);
}

async function getProfileResponse(payload) {
  const profileId = String(payload?.profileId || "").trim();
  const conversationId = String(payload?.conversationId || "").trim();
  const taskId = String(payload?.taskId || "").trim();
  if (!profileId || profileId.length > 160 || !/^[A-Za-z0-9._-]+$/.test(profileId)) throw new Error("Chrome profile id không hợp lệ.");
  if (!/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) throw new Error("Đoạn chat đích không hợp lệ.");
  const managerStartedAt = Date.now();
  const canonicalOnly = payload?.canonicalOnly === true;
  const readDom = canonicalOnly || payload?.readDom !== false;
  const recoverStaleDom = payload?.recoverStaleDom === true;
  const priority = payload?.priority === "interactive" ? "interactive" : "background";
  const responseQueueKey = `${profileId}:${conversationId}:${canonicalOnly ? "canonical" : readDom ? recoverStaleDom ? "dom-recovery" : "dom" : "network"}`;
  return responseQueue.run(responseQueueKey, async (queueContext) => {
    const runtimeBaseStartedAt = Date.now();
    const base = await runtimeBaseStatus();
    const runtimeBaseMs = Date.now() - runtimeBaseStartedAt;
    if (!base.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
    const localMcpStartedAt = Date.now();
    const result = await localMcpTool(base.config, base.token, "browser_control", {
      action: "get_chat_response",
      profile_id: profileId,
      conversation_id: conversationId,
      // Keep canonical recovery compatible with an already-running pre-canonical_only server.
      // New workers return before touching DOM when canonical_only is present; old servers strip
      // the unknown flag but still perform the existing canonical + DOM response read.
      read_dom: payload?.canonicalOnly === true || payload?.readDom !== false,
      canonical_only: payload?.canonicalOnly === true,
      recover_stale_dom: payload?.recoverStaleDom === true,
      task_id: /^cpt_[a-f0-9]{24}$/.test(taskId) ? taskId : undefined
    }, 80000);
    const responseProfileId = String(result?.profile_id || "").trim();
    const responseConversationId = String(result?.conversation_id || "").trim()
      || String(result?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1]
      || "";
    if (responseProfileId !== profileId || responseConversationId !== conversationId) {
      throw new Error(`RESPONSE_OWNERSHIP_MISMATCH: expected ${profileId}:${conversationId}, received ${responseProfileId || "(missing-profile)"}:${responseConversationId || "(missing-conversation)"}.`);
    }
    return {
      ...result,
      response_profile_id: responseProfileId,
      response_conversation_id: responseConversationId,
      manager_phase_timings: {
        queue_wait_ms: Math.max(0, Number(queueContext.queueWaitMs) || 0),
        queue_active_at_enqueue: Math.max(0, Number(queueContext.activeAtEnqueue) || 0),
        queue_queued_at_enqueue: Math.max(0, Number(queueContext.queuedAtEnqueue) || 0),
        queue_coalesced: Math.max(0, Number(queueContext.coalesced) || 0),
        queue_priority: queueContext.priority,
        runtime_base_ms: Math.max(0, runtimeBaseMs),
        local_mcp_ms: Math.max(0, Date.now() - localMcpStartedAt),
        manager_total_ms: Math.max(0, Date.now() - managerStartedAt)
      }
    };
  }, { priority, lane: profileId });
}

async function inspectThroughMcp(root) {
  const status = await readyRuntimeStatus();
  if (!status.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  const profile = profileForRoot(status.config.root);
  const fileToken = readToken(status.config.tokenFile);
  const token = fileToken || (typeof profile?.token === "string" && profile.token ? profile.token : "");
  let session;
  try {
    session = await openLocalMcpSession(status.config, token);
    const openedContent = await localMcpToolInSession(session, "open_workspace", {
      root,
      include_tree: true,
      max_depth: 2,
      max_files: 300
    }, 30000);
    const workspaceId = openedContent.workspace_id;
    if (!workspaceId) throw new Error("CodexPro không trả về workspace_id khi mở dự án.");
    const graphContent = await localMcpToolInSession(session, "code_graph", {
      workspace_id: workspaceId,
      max_nodes: 15000,
      max_edges: 40000
    }, 30000);
    return {
      ...openedContent,
      codexgraph: {
        schema_version: graphContent.schema_version,
        source: graphContent.source || "CodexGraph",
        nodes: graphContent.nodes || [],
        edges: graphContent.edges || [],
        coverage: graphContent.coverage || {},
        warnings: graphContent.warnings || [],
        output_limited: Boolean(graphContent.output_limited),
        returned: graphContent.returned || {},
        limits: graphContent.limits || {},
        cache: graphContent.cache || {}
      }
    };
  } finally {
    await closeLocalMcpSession(session);
  }
}

async function controlServer(action) {
  if (!["start", "restart"].includes(action)) throw new Error("Thao tác server không hợp lệ.");
  if (!isWindows) {
    const recordedRuntime = currentRuntime();
    const runtime = recordedRuntime?.active ? recordedRuntime : await discoverPortableRuntime() || recordedRuntime;
    const processCommand = await processCommandForPid(runtime?.pid);
    const profile = profileForRoot(runtime?.root);
    const root = processOption(processCommand, "root") || runtime?.root || profile?.root || managerProjects()[0] || "";
    if (!root) throw new Error("Chưa có workspace CodexPro. Hãy chạy codexpro setup hoặc thêm một dự án trước.");
    const browserControlEnabled = hasProcessFlag(processCommand, "browser-control") || profile?.browserControl === true;
    if (action === "start" && runtime?.active && browserControlEnabled) return runtimeStatus();
    if ((action === "restart" || (action === "start" && runtime?.active && !browserControlEnabled)) && processAlive(runtime?.pid)) {
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
  const current = await runtimeStatus({ forceRefresh: true });
  if (action === "start" && current.local.ok) return current;
  runtimeBaseCache = null;
  if (action === "restart") {
    const task = await scheduledTask({ forceRefresh: true });
    const config = parseTaskArguments(task.arguments);
    const rootLiteral = String(config.root || "").replace(/'/g, "''");
    const stopTree = [
      "Stop-ScheduledTask -TaskName 'CodexPro' -ErrorAction SilentlyContinue",
      "Start-Sleep -Milliseconds 500",
      `$root='${rootLiteral}'`,
      "$targets=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match 'codexpro\\.mjs' -and (!$root -or $_.CommandLine -like ('*'+$root+'*')) }",
      "$targets | ForEach-Object { & taskkill.exe /pid $_.ProcessId /t /f 2>$null | Out-Null }",
      "Start-Sleep -Seconds 1",
      "Start-ScheduledTask -TaskName 'CodexPro' -ErrorAction Stop"
    ].join("; ");
    await runPowerShell(stopTree);
  } else {
    await runPowerShell("Start-ScheduledTask -TaskName 'CodexPro' -ErrorAction Stop");
  }
  await new Promise((resolve) => setTimeout(resolve, 2400));
  runtimeBaseCache = null;
  return runtimeStatus({ forceRefresh: true });
}

function expectedRuntimeBuildId(config) {
  const root = String(config?.root || "").trim();
  if (!root) return "";
  try {
    const stat = fs.statSync(path.join(root, "dist", "http.js"));
    return `${Math.floor(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return "";
  }
}

function activeRuntimeProfiles(profiles) {
  return (Array.isArray(profiles) ? profiles : []).filter((profile) => {
    const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
    return ["working", "completing"].includes(String(profile?.activity || "").toLowerCase())
      || tabs.some((tab) => tab?.busy || tab?.settling || String(tab?.network_state || "").toLowerCase() === "generating");
  });
}

function scheduleRuntimeFreshnessRetry(delayMs = 15_000) {
  if (runtimeFreshnessRetryTimer) return;
  runtimeFreshnessRetryTimer = setTimeout(() => {
    runtimeFreshnessRetryTimer = null;
    runtimeFreshnessPromise = null;
    void ensureFreshRuntimeAfterManagerStart();
  }, delayMs);
  runtimeFreshnessRetryTimer.unref?.();
}

async function waitForRuntimeBuild(expectedBuildId, initialStatus, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let status = initialStatus;
  while (true) {
    const buildId = String(status?.local?.data?.runtimeBuildId || "").trim();
    if (status?.local?.ok && buildId === expectedBuildId) return status;
    if (Date.now() >= deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, 750));
    status = await runtimeBaseStatus({ forceRefresh: true }).catch(() => null);
  }
}

function ensureFreshRuntimeAfterManagerStart() {
  if (process.env.CODEXPRO_MANAGER_SMOKE === "1") {
    return Promise.resolve({ checked: true, restarted: false, reason: "smoke-mode" });
  }
  if (runtimeFreshnessPromise) return runtimeFreshnessPromise;
  runtimeFreshnessPromise = (async () => {
    if (managerSmokeMode && process.env.CODEXPRO_MANAGER_SMOKE_ALLOW_RUNTIME_RESTART !== "1") {
      diagnostic("info", "manager", "runtime", "Manager smoke bỏ qua tự động restart runtime đang dùng", {
        action: "runtime-build-refresh-skipped",
        reason: "smoke-mode"
      });
      return { checked: false, restarted: false, reason: "smoke-mode" };
    }
    const base = await runtimeBaseStatus({ forceRefresh: true });
    if (!base.local.ok) return { checked: true, restarted: false, reason: "runtime-offline" };
    const expectedBuildId = expectedRuntimeBuildId(base.config);
    const activeBuildId = String(base.local.data?.runtimeBuildId || "").trim();
    if (!expectedBuildId || activeBuildId === expectedBuildId) {
      return { checked: true, restarted: false, reason: expectedBuildId ? "current" : "build-unavailable" };
    }
    const profiles = await listBrowserProfilesThroughMcp(base.config, base.token).catch((error) => {
      diagnostic("warn", "manager", "runtime", "Chưa xác minh được profile trước khi đồng bộ runtime; Manager sẽ hoãn restart", {
        action: "runtime-build-refresh-profile-check-failed",
        active_build_id: activeBuildId,
        expected_build_id: expectedBuildId,
        error
      });
      return null;
    });
    if (!profiles) {
      scheduleRuntimeFreshnessRetry();
      return { checked: true, restarted: false, reason: "profile-check-failed" };
    }
    const activeProfiles = activeRuntimeProfiles(profiles);
    if (activeProfiles.length) {
      diagnostic("warn", "manager", "runtime", "Runtime CodexPro đang chạy bản cũ nhưng còn task hoạt động; Manager hoãn restart", {
        action: "runtime-build-refresh-deferred",
        active_build_id: activeBuildId,
        expected_build_id: expectedBuildId,
        active_profile_count: activeProfiles.length,
        active_profiles: activeProfiles.map((profile) => ({
          profile_id: String(profile?.profile_id || ""),
          activity: String(profile?.activity || ""),
          task_title: String(profile?.current_task_title || profile?.last_task_title || ""),
          active_target_ids: (Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [])
            .filter((tab) => tab?.busy || tab?.settling || String(tab?.network_state || "").toLowerCase() === "generating")
            .map((tab) => String(tab?.id || "")),
          active_network_states: (Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [])
            .filter((tab) => tab?.busy || tab?.settling || String(tab?.network_state || "").toLowerCase() === "generating")
            .map((tab) => String(tab?.network_state || "")),
          active_tab_titles: (Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [])
            .filter((tab) => tab?.busy || tab?.settling || String(tab?.network_state || "").toLowerCase() === "generating")
            .map((tab) => String(tab?.title || ""))
        }))
      });
      scheduleRuntimeFreshnessRetry();
      return { checked: true, restarted: false, reason: "active-profiles", activeProfileCount: activeProfiles.length };
    }
    const restartDecision = runtimeRestartGuard.startRestart(async () => {
      const restartAttempt = await controlServer("restart");
      return await waitForRuntimeBuild(expectedBuildId, restartAttempt);
    });
    if (!restartDecision.started) {
      const guardState = runtimeRestartGuard.snapshot();
      diagnostic("warn", "manager", "runtime", "Runtime CodexPro cần cập nhật nhưng đang trong cửa sổ gửi tin; Manager hoãn restart", {
        action: "runtime-build-refresh-send-guard",
        active_build_id: activeBuildId,
        expected_build_id: expectedBuildId,
        guard_reason: restartDecision.reason,
        active_send_count: guardState.activeSendCount,
        restart_in_progress: guardState.restartInProgress,
        retry_after_ms: restartDecision.retryAfterMs
      });
      scheduleRuntimeFreshnessRetry(Math.max(1_000, restartDecision.retryAfterMs || 5_000));
      return { checked: true, restarted: false, reason: restartDecision.reason };
    }
    diagnostic("warn", "manager", "runtime", "Runtime CodexPro đang chạy bản cũ và mọi profile đã rảnh; Manager sẽ restart server", {
      action: "runtime-build-mismatch",
      active_build_id: activeBuildId,
      expected_build_id: expectedBuildId,
      runtime_started_at: String(base.local.data?.runtimeStartedAt || "")
    });
    const restarted = await restartDecision.promise;
    const restartedBuildId = String(restarted?.local?.data?.runtimeBuildId || "").trim();
    if (!restarted?.local?.ok || restartedBuildId !== expectedBuildId) {
      throw new Error(`Runtime restart không nạp đúng build ${expectedBuildId}; đang chạy ${restartedBuildId || "unknown"}.`);
    }
    diagnostic("info", "manager", "runtime", "Runtime CodexPro đã restart sang build mới", {
      action: "runtime-build-refreshed",
      previous_build_id: activeBuildId,
      runtime_build_id: restartedBuildId,
      runtime_started_at: String(restarted?.local?.data?.runtimeStartedAt || "")
    });
    return { checked: true, restarted: true, runtimeBuildId: restartedBuildId };
  })().catch((error) => {
    diagnostic("error", "manager", "runtime", `Không đồng bộ được runtime CodexPro: ${error?.message || String(error)}`, {
      action: "runtime-build-refresh-failed",
      error
    });
    return { checked: true, restarted: false, reason: "refresh-failed", error: error?.message || String(error) };
  });
  return runtimeFreshnessPromise;
}

diagnosticIpcHandle("codexpro:status", { category: "status", action: "runtime-status", slowMs: 5_000 }, () => runtimeStatus());
diagnosticIpcHandle("codexpro:workers", { category: "status", action: "list-workers", slowMs: 5_000 }, async () => {
  const status = await runtimeStatus();
  return { workers: status.workers, sources: status.workerSources };
});
diagnosticIpcHandle("codexpro:worker-send", {
  category: "worker",
  action: "worker-send",
  logSuccess: true,
  successMessage: "Worker đã nhận job",
  failureMessage: "Không gửi được job tới worker",
  details: (payload) => ({ worker_id: String(payload?.workerId || payload?.worker_id || ""), task_id: String(payload?.task_id || payload?.taskId || ""), task_kind: String(payload?.task_kind || payload?.taskKind || ""), workflow_id: String(payload?.workflow || "") })
}, async (_event, payload) => {
  const prepared = await materializeApiWorkerRequest(payload);
  recordUserReportedError(prepared, { request_channel: "worker_job" });
  return await workerPluginRegistry.invoke("send", String(prepared?.workerId || prepared?.worker_id || ""), prepared);
});
diagnosticIpcHandle("codexpro:worker-read", {
  category: "worker",
  action: "worker-read",
  failureMessage: "Không đọc được trạng thái worker",
  details: (payload) => ({ worker_id: String(payload?.workerId || payload?.worker_id || "") })
}, (_event, payload) => workerPluginRegistry.invoke("read", String(payload?.workerId || payload?.worker_id || ""), payload));
diagnosticIpcHandle("codexpro:worker-stop", {
  category: "worker",
  action: "worker-stop",
  logSuccess: true,
  successMessage: "Đã gửi lệnh dừng worker",
  failureMessage: "Không dừng được worker",
  details: (payload) => ({ worker_id: String(payload?.workerId || payload?.worker_id || "") })
}, (_event, payload) => workerPluginRegistry.invoke("stop", String(payload?.workerId || payload?.worker_id || ""), payload));
diagnosticIpcHandle("codexpro:api-worker-configs", { category: "settings", action: "list-api-workers" }, () => apiWorkerStore.list());
diagnosticIpcHandle("codexpro:list-api-worker-models", {
  category: "settings",
  action: "list-api-worker-models",
  slowMs: 15_000,
  logSuccess: true,
  successMessage: "Đã tải danh sách model cho API worker",
  failureMessage: "Không tải được danh sách model",
  details: (payload) => ({ id: String(payload?.id || ""), provider: String(payload?.provider || ""), credential_supplied: Boolean(payload?.api_key || payload?.apiKey) }),
  resultDetails: (result) => ({ model_count: Array.isArray(result?.models) ? result.models.length : 0 })
}, (_event, payload) => discoverApiWorkerModels(payload, {
  getStoredCredential: async (id) => apiWorkerStore.credential(id),
  createProvider: async (config, getApiKey) => createProviderForApiWorker(config, { getApiKey })
}));
diagnosticIpcHandle("codexpro:save-api-worker", {
  category: "settings",
  action: "save-api-worker",
  logSuccess: true,
  successMessage: "Đã lưu API worker",
  failureMessage: "Không lưu được API worker",
  details: (payload) => ({ id: String(payload?.id || ""), provider: String(payload?.provider || ""), model: String(payload?.model || ""), credential_changed: Boolean(payload?.api_key || payload?.apiKey || payload?.clear_credential || payload?.clearCredential) })
}, (_event, payload) => apiWorkerStore.save(payload));
diagnosticIpcHandle("codexpro:delete-api-worker", {
  category: "settings",
  action: "delete-api-worker",
  logSuccess: true,
  successMessage: "Đã xóa API worker",
  failureMessage: "Không xóa được API worker",
  details: (id) => ({ id: String(id || "") })
}, (_event, id) => apiWorkerStore.remove(id));
diagnosticIpcHandle("codexpro:test-api-worker", {
  category: "settings",
  action: "test-api-worker",
  slowMs: 15_000,
  logSuccess: true,
  successMessage: "API worker kết nối thành công",
  failureMessage: "API worker không kết nối được",
  details: (id) => ({ id: String(id || "") })
}, async (_event, id) => {
  const config = apiWorkerStore.list().find((item) => item.id === String(id || ""));
  if (!config) throw new Error("API worker configuration was not found.");
  return await createProviderForApiWorker(config).probe();
});
diagnosticIpcHandle("codexpro:control", {
  category: "status",
  action: "control-server",
  logSuccess: true,
  successMessage: "Điều khiển server hoàn tất",
  failureMessage: "Không điều khiển được server",
  details: (action) => ({ requested_action: String(action || "") })
}, (_event, action) => controlServer(action));
ipcMain.handle("codexpro:copy", (_event, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});
ipcMain.on("codexpro:log-chat-layout", (_event, payload) => appendManagerChatLayoutLog(payload));
ipcMain.on("codexpro:log-chat-response-audit", (_event, payload) => {
  appendManagerChatResponseAuditLog(payload);
  recordChatResponseAuditDiagnostic(payload);
});
ipcMain.on("codexpro:log-diagnostic", (_event, payload) => diagnostic(
  payload?.level,
  payload?.source || "renderer",
  payload?.category || "runtime",
  payload?.message || "Renderer diagnostic event",
  { ...(payload?.details && typeof payload.details === "object" ? payload.details : {}), action: payload?.action || payload?.details?.action || "" }
));
ipcMain.handle("codexpro:get-diagnostic-logs", (_event, options) => readDiagnosticLogs(codexProHome, options || {}));
ipcMain.handle("codexpro:clear-diagnostic-logs", () => clearDiagnosticLogs(codexProHome));
ipcMain.handle("codexpro:prune-diagnostic-logs", () => pruneDiagnosticLogs(codexProHome));
diagnosticIpcHandle("codexpro:operations-performance", { category: "performance", action: "operations-performance", slowMs: 2_500 }, (_event, pids) => collectOperationsPerformance(Array.isArray(pids) ? pids : []));
ipcMain.handle("codexpro:notify", (_event, payload) => {
  return showManagerNotification(payload);
});
diagnosticIpcHandle("codexpro:rotate-link", {
  category: "settings",
  action: "rotate-mcp-link",
  logSuccess: true,
  successMessage: "Tạo link MCP mới hoàn tất",
  failureMessage: "Không tạo được link MCP mới"
}, async () => {
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
diagnosticIpcHandle("codexpro:projects", { category: "projects", action: "list-projects", slowMs: 5_000 }, () => listProjects());
diagnosticIpcHandle("codexpro:check-profile", {
  category: "profile",
  action: "check-profile",
  slowMs: 10_000,
  failureMessage: "Kiểm tra Chrome profile thất bại",
  details: (profileId) => ({ profile_id: String(profileId || "") }),
  resultDetails: (result) => ({
    connected: result?.connected,
    connector_installed: result?.installed ?? result?.connector_installed,
    connector_profile_bound: result?.connector_profile_bound,
    connector_update_required: result?.connector_update_required,
    connector_message: String(result?.message || result?.connector_message || ""),
    connector_checked_at: String(result?.checked_at || result?.connector_checked_at || ""),
    connector_check_diagnostic: result?.diagnostic && typeof result.diagnostic === "object" ? result.diagnostic : {},
    renderer_unresponsive: result?.renderer_unresponsive,
    extension_version: String(result?.extension_version || ""),
    tab_count: Number(result?.tab_count) || (Array.isArray(result?.conversation_tabs) ? result.conversation_tabs.length : 0)
  }),
  resultDiagnostic: (result) => result?.connected === false || (result?.installed ?? result?.connector_installed) === false || result?.connector_profile_bound === false || result?.connector_update_required || result?.renderer_unresponsive
    ? { level: result?.renderer_unresponsive ? "error" : "warn", message: "Kiểm tra profile phát hiện trạng thái bất thường" }
    : null
}, (_event, profileId) => checkChatGptProfile(profileId));
diagnosticIpcHandle("codexpro:setup-profile", {
  category: "profile",
  action: "setup-profile",
  logSuccess: true,
  successMessage: "Cập nhật CodexPro cho Chrome profile hoàn tất",
  failureMessage: "Cập nhật CodexPro cho Chrome profile thất bại",
  details: (profileId) => ({ profile_id: String(profileId || "") }),
  resultDetails: (result) => ({
    connected: result?.connected,
    connector_installed: result?.connector_installed,
    connector_profile_bound: result?.connector_profile_bound,
    extension_version: String(result?.extension_version || ""),
    message: String(result?.message || "")
  })
}, (_event, profileId) => setupChatGptProfile(profileId));
diagnosticIpcHandle("codexpro:open-profile-chat", {
  category: "profile",
  action: "open-profile-chat",
  logSuccess: true,
  successMessage: "Mở Chrome profile hoàn tất",
  failureMessage: "Không mở được Chrome profile",
  details: (payload) => ({ profile_id: String(payload?.profileId || payload?.profile_id || ""), conversation_id: String(payload?.conversationId || payload?.conversation_id || ""), target_id: String(payload?.targetId || ""), target_conversation_id: String(payload?.targetConversationId || ""), target_title: String(payload?.title || ""), selection_reason: String(payload?.selectionReason || ""), active_target_id: String(payload?.activeTargetId || ""), active_conversation_id: String(payload?.activeConversationId || "") }),
  resultDetails: (result) => ({ result_profile_id: String(result?.profile_id || ""), result_conversation_id: String(result?.conversation_id || ""), result_target_id: String(result?.target_id || ""), tab_created: Boolean(result?.tab_created), stale_target_recovered: Boolean(result?.stale_target_recovered), stale_recovery_reason: String(result?.stale_recovery_reason || ""), created_tab_id: String(result?.created_tab?.target_id || ""), navigation_target_id: String(result?.navigation?.target_id || ""), navigation_url: String(result?.navigation?.url || ""), activation_target_id: String(result?.activation?.target_id || ""), activation_window_id: String(result?.activation?.window_id || ""), activation_window_focused: Boolean(result?.activation?.window_focused), window_focused: Boolean(result?.window_focused || result?.window_focus?.ok), activation_acknowledgement_delayed: Boolean(result?.activation_acknowledgement_delayed), runtime_connection_source: String(result?.runtime_connection_source || ""), open_phase_timings: result?.open_phase_timings || {}, window_focus: result?.window_focus || null })
}, (_event, payload) => openProfileChat(payload));
diagnosticIpcHandle("codexpro:recover-profile-chat", {
  category: "chat",
  action: "recover-profile-chat",
  logSuccess: true,
  successMessage: "Khôi phục tab ChatGPT hoàn tất",
  failureMessage: "Khôi phục tab ChatGPT thất bại",
  details: (payload) => ({ profile_id: String(payload?.profileId || payload?.profile_id || ""), conversation_id: String(payload?.conversationId || payload?.conversation_id || ""), target_id: String(payload?.targetId || "") }),
  resultDetails: (result) => ({ replaced_tab_id: String(result?.replaced_tab_id || ""), new_tab_id: String(result?.tab_id || result?.new_tab_id || ""), window_focused: Boolean(result?.window_focused || result?.window_focus?.ok) })
}, async (event, payload) => {
  const result = await recoverProfileChatTab(payload);
  const owner = BrowserWindow.fromWebContents(event.sender);
  if ((result?.window_focused || result?.window_focus?.ok) && owner && !owner.isDestroyed()) owner.minimize();
  return result;
});
diagnosticIpcHandle("codexpro:audit-long-running-profile-chat", {
  category: "chat",
  action: "audit-long-running-profile-chat",
  logSuccess: true,
  successMessage: "Kiểm tra task ChatGPT chạy quá 30 phút hoàn tất",
  failureMessage: "Kiểm tra task ChatGPT chạy lâu thất bại",
  details: (payload) => ({ profile_id: String(payload?.profileId || ""), task_id: String(payload?.taskId || ""), conversation_id: String(payload?.conversationId || ""), target_id: String(payload?.targetId || ""), attempt_key: String(payload?.attemptKey || "") }),
  resultDetails: (result) => ({ status: String(result?.status || ""), already_attempted: Boolean(result?.already_attempted), renderer_unresponsive: Boolean(result?.renderer_unresponsive), retry_allowed: result?.retry_allowed !== false, recovery_tab_id: String(result?.recovery_tab_id || ""), preflight: result?.preflight || null, reload_probe: result?.reload_probe || null }),
  resultDiagnostic: (result) => result?.renderer_unresponsive
    ? { level: "error", message: "Task chạy lâu vẫn treo sau một lần reload; watchdog đã dừng" }
    : result?.status === "active_without_reload"
      ? { level: "info", message: "Task chạy lâu vẫn hoạt động; watchdog không reload" }
      : null
}, (_event, payload) => auditLongRunningProfileChat(payload));
diagnosticIpcHandle("codexpro:stop-profile-task", {
  category: "chat",
  action: "stop-profile-task",
  logSuccess: true,
  successMessage: "Đã gửi lệnh dừng task ChatGPT",
  failureMessage: "Không dừng được task ChatGPT",
  details: (payload) => ({ profile_id: String(payload?.profileId || payload?.profile_id || ""), conversation_id: String(payload?.conversationId || payload?.conversation_id || ""), target_id: String(payload?.targetId || "") }),
  resultDetails: (result) => ({ stopped: Boolean(result?.stopped), reason: String(result?.reason || ""), target_id: String(result?.target_id || ""), conversation_id: String(result?.conversation_id || "") })
}, (_event, payload) => stopProfileTask(payload));
diagnosticIpcHandle("codexpro:reload-profiles", {
  category: "profile",
  action: "reload-profiles",
  logSuccess: true,
  successMessage: "Reload worker extension hoàn tất",
  failureMessage: "Reload worker extension thất bại",
  resultDetails: (result) => ({ mode: String(result?.mode || ""), count: Number(result?.count) || 0, failed: Number(result?.failed) || 0, deferred: Number(result?.deferred) || 0, outdated: Number(result?.outdated) || 0, version: String(result?.version || "") }),
  resultDiagnostic: (result) => Number(result?.failed) > 0 ? { level: "error", message: `Reload worker còn ${Number(result.failed)} profile thất bại` } : Number(result?.deferred) > 0 ? { level: "warn", message: `Reload worker bỏ qua ${Number(result.deferred)} profile đang bận` } : null
}, () => reloadChromeProfiles());
diagnosticIpcHandle("codexpro:get-manager-settings", { category: "settings", action: "get-manager-settings" }, () => managerSettingsPayload());
diagnosticIpcHandle("codexpro:save-manager-settings", {
  category: "settings",
  action: "save-manager-settings",
  logSuccess: true,
  successMessage: "Lưu cài đặt Manager hoàn tất",
  failureMessage: "Lưu cài đặt Manager thất bại",
  details: (patch) => ({ changed_keys: Object.keys(patch && typeof patch === "object" ? patch : {}).slice(0, 30) })
}, (_event, patch) => saveManagerSettingsPatch(patch));
diagnosticIpcHandle("codexpro:create-worker-image-pack", { category: "settings", action: "create-worker-image-pack", failureMessage: "Tạo bộ ảnh worker thất bại" }, (_event, name) => createWorkerImagePack(name));
diagnosticIpcHandle("codexpro:select-worker-image-pack", { category: "settings", action: "select-worker-image-pack", failureMessage: "Chọn bộ ảnh worker thất bại" }, (_event, packId) => selectWorkerImagePack(packId));
diagnosticIpcHandle("codexpro:delete-worker-image-pack", { category: "settings", action: "delete-worker-image-pack", failureMessage: "Xóa bộ ảnh worker thất bại" }, (_event, packId) => deleteWorkerImagePack(packId));
diagnosticIpcHandle("codexpro:choose-worker-image", { category: "settings", action: "choose-worker-image", failureMessage: "Chọn ảnh worker thất bại", details: (payload) => ({ state: String(payload?.state || "") }) }, (_event, payload) => chooseWorkerImage(payload?.packId, payload?.state));
diagnosticIpcHandle("codexpro:reset-worker-image", { category: "settings", action: "reset-worker-image", failureMessage: "Khôi phục ảnh worker thất bại", details: (payload) => ({ state: String(payload?.state || "") }) }, (_event, payload) => resetWorkerImage(payload?.packId, payload?.state));
diagnosticIpcHandle("codexpro:reset-manager-settings", {
  category: "settings",
  action: "reset-manager-settings",
  logSuccess: true,
  successMessage: "Khôi phục cài đặt Manager hoàn tất",
  failureMessage: "Khôi phục cài đặt Manager thất bại"
}, () => resetManagerSettings());
diagnosticIpcHandle("codexpro:headless-workers", { category: "worker", action: "headless-workers", failureMessage: "Đọc danh sách headless worker thất bại" }, () => headlessWorkers.listWorkers());
diagnosticIpcHandle("codexpro:create-headless-worker", { category: "worker", action: "create-headless-worker", failureMessage: "Tạo headless worker thất bại" }, (_event, payload) => headlessWorkers.createWorker(payload));
diagnosticIpcHandle("codexpro:sync-headless-worker", { category: "worker", action: "sync-headless-worker", failureMessage: "Đồng bộ headless worker thất bại" }, (_event, workerId) => headlessWorkers.syncWorker(workerId));
diagnosticIpcHandle("codexpro:start-headless-worker", { category: "worker", action: "start-headless-worker", failureMessage: "Khởi động headless worker thất bại" }, (_event, workerId) => headlessWorkers.startWorker(workerId));
diagnosticIpcHandle("codexpro:stop-headless-worker", { category: "worker", action: "stop-headless-worker", failureMessage: "Dừng headless worker thất bại" }, (_event, workerId) => headlessWorkers.stopWorker(workerId));
diagnosticIpcHandle("codexpro:delete-headless-worker", { category: "worker", action: "delete-headless-worker", failureMessage: "Xóa headless worker thất bại" }, (_event, workerId) => headlessWorkers.deleteWorker(workerId));
diagnosticIpcHandle("codexpro:set-headless-worker-autostart", { category: "worker", action: "set-headless-worker-autostart", failureMessage: "Cập nhật autostart headless worker thất bại" }, (_event, payload) => headlessWorkers.setWorkerAutoStart(payload?.workerId, payload?.autoStart));
diagnosticIpcHandle("codexpro:choose-request-files", { category: "chat", action: "choose-request-files", failureMessage: "Chọn file đính kèm thất bại" }, () => chooseRequestFiles());
diagnosticIpcHandle("codexpro:get-request-file-preview", { category: "chat", action: "get-request-file-preview", failureMessage: "Đọc preview file đính kèm thất bại" }, (_event, filePath) => requestFilePreview(filePath));
diagnosticIpcHandle("codexpro:capture-clipboard-image", { category: "chat", action: "capture-clipboard-image", failureMessage: "Đọc ảnh clipboard thất bại" }, () => captureClipboardImage());
diagnosticIpcHandle("codexpro:send-profile-request", {
  category: "chat",
  action: "send-profile-request",
  logSuccess: true,
  successMessage: "ChatGPT đã nhận yêu cầu gửi",
  failureMessage: "Gửi yêu cầu ChatGPT thất bại",
  details: (payload) => ({ profile_id: String(payload?.profileId || ""), conversation_id: String(payload?.conversationId || ""), new_chat: Boolean(payload?.newChat), attachment_count: Array.isArray(payload?.attachments) ? payload.attachments.length : 0, request_scope: String(payload?.scope || "workspace"), workflow_id: String(payload?.workflow || ""), tool_retry: Boolean(payload?.toolRetry), tool_rollover_count: Number(payload?.toolRolloverCount) || 0 }),
  resultDetails: (result) => {
    const value = result?.ok ? result.value : result;
    const sendTimings = value?.send_phase_timings && typeof value.send_phase_timings === 'object' ? value.send_phase_timings : {};
    const bridgeTimings = value?.bridge_phase_timings && typeof value.bridge_phase_timings === 'object' ? value.bridge_phase_timings : {};
    return {
      profile_id: String(value?.profile_id || ""),
      conversation_id: String(value?.conversation_id || ""),
      request_id: String(value?.request_id || value?.generation_request_id || ""),
      repo_task_id: String(value?.repo_task_id || ""),
      submission_state: String(value?.submission_state || ""),
      submitted_by: String(value?.submitted_by || ""),
      generation_state: String(value?.generation_state || value?.network_state || ""),
      generation_endpoint: String(value?.generation_endpoint || ""),
      network_status_code: Number(value?.network_status_code) || 0,
      network_error: String(value?.network_error || ""),
      manager_preflight_ms: Number(value?.manager_preflight_ms) || 0,
      manager_total_ms: Number(value?.manager_total_ms) || 0,
      send_command_queue_ms: Number(sendTimings.command_queue_ms) || 0,
      send_find_tab_ms: Number(sendTimings.find_tab_ms) || 0,
      send_network_capture_probe_ms: Number(sendTimings.network_capture_probe_ms) || 0,
      send_network_state_ms: Number(sendTimings.network_state_ms) || 0,
      send_dom_activity_ms: Number(sendTimings.dom_activity_ms) || 0,
      send_attachment_ownership_ms: Number(sendTimings.attachment_ownership_ms) || 0,
      send_conversation_limit_ms: Number(sendTimings.conversation_limit_ms) || 0,
      send_prepare_ms: Number(sendTimings.prepare_ms) || 0,
      send_attachment_upload_ms: Number(sendTimings.attachment_upload_ms) || 0,
      send_trusted_submit_ms: Number(sendTimings.trusted_submit_ms) || 0,
      send_network_ack_after_submit_error_ms: Number(sendTimings.network_ack_after_submit_error_ms) || 0,
      send_submit_lifecycle_ack_ms: Number(sendTimings.submit_lifecycle_ack_ms) || 0,
      send_attempt_inspect_ms: Number(sendTimings.attempt_inspect_ms) || 0,
      send_fallback_prepare_ms: Number(sendTimings.fallback_prepare_ms) || 0,
      send_fallback_submit_ms: Number(sendTimings.fallback_submit_ms) || 0,
      send_post_fallback_lifecycle_ack_ms: Number(sendTimings.post_fallback_lifecycle_ack_ms) || 0,
      send_network_ack_ms: Number(sendTimings.network_ack_ms) || 0,
      send_conversation_url_ms: Number(sendTimings.conversation_url_ms) || 0,
      send_extension_total_ms: Number(sendTimings.extension_total_ms) || 0,
      bridge_queue_wait_ms: Number(bridgeTimings.queue_wait_ms) || 0,
      bridge_extension_roundtrip_ms: Number(bridgeTimings.extension_roundtrip_ms) || 0,
      bridge_total_ms: Number(bridgeTimings.bridge_total_ms) || 0,
      submission_ack_source: String(value?.submission_ack_source || value?.network_ack_source || ''),
      submit_lifecycle_endpoint: String(value?.submit_lifecycle_endpoint || ''),
      runtime_connection_source: String(value?.runtime_connection_source || ""),
      profile_preflight_source: String(value?.profile_preflight_source || ""),
      profile_had_chatgpt_tab: Boolean(value?.profile_had_chatgpt_tab),
      chatgpt_tab_auto_opened: Boolean(value?.chatgpt_tab_auto_opened)
    };
  },
  resultDiagnostic: (result, payload) => {
    const value = result?.ok ? result.value : result;
    const submissionState = String(value?.submission_state || "").toLowerCase();
    const generationState = String(value?.generation_state || value?.network_state || "").toLowerCase();
    if (submissionState === "uncertain") return { level: "warn", message: "Trạng thái gửi ChatGPT không chắc chắn" };
    if (generationState === "failed" || value?.network_error) return { level: "error", message: "ChatGPT nhận yêu cầu nhưng generation lỗi network" };
    return null;
  }
}, (_event, payload) => {
  recordUserReportedError(payload, { request_channel: "chat_composer" });
  return ipcResult(() => sendProfileRequest(payload));
});
diagnosticIpcHandle("codexpro:rename-profile-chat", {
  category: "chat",
  action: "rename-profile-chat",
  failureMessage: "Đổi tên chat thất bại",
  details: (payload) => ({ profile_id: String(payload?.profileId || ""), conversation_id: String(payload?.conversationId || "") })
}, (_event, payload) => renameProfileChat(payload));
diagnosticIpcHandle("codexpro:get-profile-response", {
  category: "chat",
  action: "get-profile-response",
  slowMs: 2_000,
  failureMessage: "Đọc phản hồi ChatGPT thất bại",
  details: (payload) => ({ profile_id: String(payload?.profileId || ""), conversation_id: String(payload?.conversationId || ""), read_dom: payload?.readDom !== false, recover_stale_dom: Boolean(payload?.recoverStaleDom), canonical_only: Boolean(payload?.canonicalOnly) }),
  resultDetails: (result) => ({
    request_id: String(result?.request_id || result?.generation_request_id || ""),
    network_state: String(result?.network_state || ""),
    network_source: String(result?.network_source || ""),
    network_status_code: Number(result?.network_status_code) || 0,
    network_error: String(result?.network_error || ""),
    network_duration_ms: Number(result?.network_duration_ms) || 0,
    response_ready: Boolean(result?.response_ready),
    response_source: String(result?.response_source || ""),
    message_count: Number(result?.message_count) || (Array.isArray(result?.messages) ? result.messages.length : 0),
    dom_available: result?.dom_available,
    dom_skipped: Boolean(result?.dom_skipped),
    dom_error: String(result?.dom_error || ""),
    canonical_available: Boolean(result?.canonical_available),
    canonical_generation_matches: result?.canonical_generation_matches !== false,
    short_dom_response_unverified: Boolean(result?.short_dom_response_unverified),
    network_stream_available: Boolean(result?.network_stream_available),
    network_stream_in_progress: Boolean(result?.network_stream_in_progress),
    response_phase_timings: result?.response_phase_timings && typeof result.response_phase_timings === "object" ? result.response_phase_timings : {},
    bridge_phase_timings: result?.bridge_phase_timings && typeof result.bridge_phase_timings === "object" ? result.bridge_phase_timings : {},
    manager_phase_timings: result?.manager_phase_timings && typeof result.manager_phase_timings === "object" ? result.manager_phase_timings : {}
  }),
  resultDiagnostic: (result, payload) => {
    const networkState = String(result?.network_state || "").toLowerCase();
    const key = `${String(payload?.profileId || "")}:${String(payload?.conversationId || "")}`;
    if (networkState === "failed" || result?.network_error) return { level: "error", message: "Đọc phản hồi phát hiện generation lỗi network", dedupeKey: `response-network-failed:${key}`, throttleMs: 30_000 };
    if (result?.dom_error) return { level: "warn", message: "Đọc phản hồi gặp lỗi DOM", dedupeKey: `response-dom-error:${key}:${String(result.dom_error).slice(0, 120)}`, throttleMs: 30_000 };
    if (result?.canonical_generation_matches === false) return { level: "warn", message: "Bỏ canonical cũ không thuộc lượt hiện tại", dedupeKey: `response-stale-canonical:${key}`, throttleMs: 10_000 };
    if (result?.short_dom_response_unverified) return { level: "warn", message: "Không công nhận phản hồi DOM quá ngắn khi canonical chưa xác minh", dedupeKey: `response-short-dom:${key}`, throttleMs: 10_000 };
    if (networkState === "completed" && !result?.response_ready && !result?.network_stream_in_progress) return { level: "warn", message: "Network đã hoàn tất nhưng chưa có phản hồi xác minh", dedupeKey: `response-missing-final:${key}`, throttleMs: 30_000 };
    return null;
  }
}, (_event, payload) => getProfileResponse(payload));
diagnosticIpcHandle("codexpro:get-chat-response-cache", { category: "chat", action: "get-chat-response-cache", failureMessage: "Đọc cache phản hồi thất bại", details: (payload) => ({ profile_id: String(payload?.profileId || ""), conversation_id: String(payload?.conversationId || "") }) }, (_event, payload) => getManagerChatCacheEntry(payload));
diagnosticIpcHandle("codexpro:save-chat-response-cache", { category: "chat", action: "save-chat-response-cache", failureMessage: "Lưu cache phản hồi thất bại", details: (payload) => ({ profile_id: String(payload?.profileId || ""), conversation_id: String(payload?.conversationId || ""), message_count: Array.isArray(payload?.messages) ? payload.messages.length : 0 }) }, (_event, payload) => saveManagerChatCacheEntry(payload));
diagnosticIpcHandle("codexpro:get-repo-task-status", {
  category: "tool",
  action: "get-repo-task-status",
  logSuccess: true,
  successMessage: "Đã kiểm tra task title và CodexPro gate",
  slowMs: 5_000,
  failureMessage: "Xác minh task CodexPro thất bại",
  details: (payload) => ({ profile_id: String(payload?.profileId || ""), conversation_id: String(payload?.conversationId || ""), task_id: String(payload?.taskId || "") }),
  resultDetails: (result) => ({ verified: Boolean(result?.verified), task_id: String(result?.task_id || ""), task_title: String(result?.task_title || ""), task_kind: String(result?.task_kind || ""), verification_reason: String(result?.reason || result?.verification_reason || "") }),
  resultDiagnostic: (result) => result?.verified === false || !String(result?.task_title || "").trim()
    ? { level: "warn", message: result?.verified === false ? "Task CodexPro chưa được xác minh" : "Task CodexPro đã verified nhưng thiếu task title" }
    : null
}, (_event, payload) => getRepoTaskStatus(payload));
diagnosticIpcHandle("codexpro:list-app-plugins", {
  category: "app-plugin",
  action: "list-app-plugins"
}, () => appPluginRegistry.list());
diagnosticIpcHandle("codexpro:list-app-plugin-catalog", {
  category: "app-plugin",
  action: "list-app-plugin-catalog"
}, () => managedAppPluginInstaller.listCatalog());
diagnosticIpcHandle("codexpro:prepare-app-plugin-task", {
  category: "app-plugin",
  action: "prepare-app-plugin-task",
  logSuccess: true,
  successMessage: "Đã tạo gói skill cho task plugin",
  failureMessage: "Không tạo được gói skill cho task plugin",
  details: (payload) => ({ plugin_id: String(payload?.pluginId || ""), skill_count: Array.isArray(payload?.skillIds) ? payload.skillIds.length : 0 })
}, (_event, payload) => {
  const bundle = createPluginSkillBundle({
    registry: appPluginRegistry,
    home: codexProHome,
    pluginId: payload?.pluginId,
    skillIds: payload?.skillIds
  });
  return { ...bundle, attachment: requestFileSummary(bundle.path) };
});
diagnosticIpcHandle("codexpro:install-catalog-app-plugin", {
  category: "app-plugin",
  action: "install-catalog-app-plugin",
  logSuccess: true,
  successMessage: "Đã cài plugin từ catalog",
  failureMessage: "Cài plugin từ catalog thất bại",
  details: (id) => ({ plugin_id: String(id || "") }),
  resultDetails: (result) => ({ plugin_id: result?.plugin?.id || "", skill_count: Number(result?.skill_count) || 0, source_commit: result?.source_commit || "" })
}, async (_event, id) => {
  const result = await managedAppPluginInstaller.install(id);
  return { ...result, plugins: appPluginRegistry.list(), catalog: managedAppPluginInstaller.listCatalog() };
});
diagnosticIpcHandle("codexpro:update-catalog-app-plugin", {
  category: "app-plugin",
  action: "update-catalog-app-plugin",
  logSuccess: true,
  successMessage: "Đã cập nhật plugin từ catalog",
  failureMessage: "Cập nhật plugin từ catalog thất bại",
  details: (id) => ({ plugin_id: String(id || "") }),
  resultDetails: (result) => ({ plugin_id: result?.plugin?.id || "", skill_count: Number(result?.skill_count) || 0, source_commit: result?.source_commit || "" })
}, async (_event, id) => {
  const result = await managedAppPluginInstaller.update(id);
  return { ...result, plugins: appPluginRegistry.list(), catalog: managedAppPluginInstaller.listCatalog() };
});
diagnosticIpcHandle("codexpro:install-app-plugin", {
  category: "app-plugin",
  action: "install-app-plugin",
  logSuccess: true,
  successMessage: "Đã cài app plugin",
  failureMessage: "Cài app plugin thất bại",
  resultDetails: (result) => ({ plugin_id: result?.plugin?.id || "", repo_root: result?.plugin?.repo_root || "", cancelled: result?.cancelled === true })
}, async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Chọn repo có .codexpro-plugin/plugin.json",
    properties: ["openDirectory"]
  };
  const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true, plugins: appPluginRegistry.list() };
  const plugin = appPluginRegistry.install(selection.filePaths[0]);
  return { cancelled: false, plugin, plugins: appPluginRegistry.list() };
});
diagnosticIpcHandle("codexpro:reload-app-plugin", {
  category: "app-plugin",
  action: "reload-app-plugin",
  logSuccess: true,
  successMessage: "Đã reload app plugin",
  failureMessage: "Reload app plugin thất bại",
  details: (id) => ({ plugin_id: String(id || "") })
}, (_event, id) => {
  const plugin = appPluginRegistry.reload(id);
  return { plugin, plugins: appPluginRegistry.list() };
});
diagnosticIpcHandle("codexpro:uninstall-app-plugin", {
  category: "app-plugin",
  action: "uninstall-app-plugin",
  logSuccess: true,
  successMessage: "Đã gỡ app plugin khỏi Manager",
  failureMessage: "Gỡ app plugin thất bại",
  details: (id) => ({ plugin_id: String(id || "") })
}, (_event, id) => {
  const plugin = appPluginRegistry.uninstall(id);
  return { plugin, plugins: appPluginRegistry.list() };
});
diagnosticIpcHandle("codexpro:choose-project", { category: "projects", action: "choose-project", failureMessage: "Mở hộp chọn dự án thất bại" }, async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Chọn repo hoặc dự án" });
  return result.canceled ? null : result.filePaths[0];
});

diagnosticIpcHandle("codexpro:add-project", {
  category: "projects",
  action: "add-project",
  logSuccess: true,
  successMessage: "Thêm dự án hoàn tất",
  failureMessage: "Thêm dự án thất bại",
  details: (root) => ({ root: String(root || "") })
}, async (_event, root) => {
  const resolved = path.resolve(String(root || ""));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error("Thư mục dự án không tồn tại.");
  const roots = [...new Set([...managerProjects(), resolved])];
  saveManagerProjects(roots);
  return listProjects();
});
diagnosticIpcHandle("codexpro:remove-project", {
  category: "projects",
  action: "remove-project",
  logSuccess: true,
  successMessage: "Xóa dự án khỏi danh sách hoàn tất",
  failureMessage: "Xóa dự án khỏi danh sách thất bại",
  details: (root) => ({ root: String(root || "") })
}, async (_event, root) => {
  const target = path.resolve(String(root || "")).toLowerCase();
  saveManagerProjects(managerProjects().filter((item) => path.resolve(item).toLowerCase() !== target));
  return listProjects();
});
diagnosticIpcHandle("codexpro:inspect-project", {
  category: "projects",
  action: "inspect-project",
  slowMs: 15_000,
  failureMessage: "Phân tích dự án qua MCP thất bại",
  details: (root) => ({ root: String(root || "") })
}, (_event, root) => inspectThroughMcp(path.resolve(String(root || ""))));
diagnosticIpcHandle("codexpro:open-folder", { category: "projects", action: "open-folder", failureMessage: "Mở thư mục thất bại", details: (root) => ({ root: String(root || "") }) }, async (_event, root) => {
  const error = await shell.openPath(path.resolve(String(root || "")));
  if (error) throw new Error(error);
  return true;
});
diagnosticIpcHandle("codexpro:open-external", { category: "runtime", action: "open-external", failureMessage: "Mở liên kết ngoài thất bại", details: (url) => ({ url: String(url || "") }) }, async (_event, url) => {
  const parsed = new URL(String(url));
  if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) throw new Error("Chỉ cho phép liên kết HTTP(S) hoặc mailto.");
  await shell.openExternal(parsed.toString());
  return true;
});

const managerSmokeMode = process.env.CODEXPRO_MANAGER_SMOKE === "1";
const hasSingleInstanceLock = managerSmokeMode || app.requestSingleInstanceLock();

process.on("uncaughtExceptionMonitor", (error, origin) => {
  diagnostic("error", "electron", "runtime", `Main process exception: ${error?.message || String(error)}`, {
    action: "uncaught-exception",
    origin,
    error
  });
});
process.on("warning", (warning) => {
  diagnostic("warn", "electron", "runtime", `Node warning: ${warning?.message || String(warning)}`, {
    action: "process-warning",
    warning
  });
});
app.on("render-process-gone", (_event, webContents, details) => {
  diagnostic("error", "electron", "window", `Renderer đã dừng: ${details?.reason || "unknown"}`, {
    action: "render-process-gone",
    web_contents_id: webContents?.id,
    reason: details?.reason,
    exit_code: details?.exitCode
  });
});
app.on("child-process-gone", (_event, details) => {
  diagnostic(details?.reason === "clean-exit" ? "info" : "error", "electron", "runtime", `Tiến trình con đã dừng: ${details?.type || "unknown"} · ${details?.reason || "unknown"}`, {
    action: "child-process-gone",
    type: details?.type,
    reason: details?.reason,
    exit_code: details?.exitCode,
    name: details?.name
  });
});

if (!hasSingleInstanceLock) {
  diagnostic("warn", "electron", "runtime", "Manager không khởi động vì đã có một instance khác", { action: "single-instance-rejected" });
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    protocol.handle("codexpro-plugin", handleAppPluginProtocol);
    diagnostic("info", "electron", "runtime", "CodexPro Manager đã khởi động", {
      action: "manager-started",
      platform: process.platform,
      architecture: process.arch,
      electron_version: process.versions.electron,
      chrome_version: process.versions.chrome,
      node_version: process.versions.node
    });
    if (isMac && app.isPackaged) {
      try {
        app.setLoginItemSettings({ openAtLogin: true });
      } catch (error) {
        console.warn("Không thể bật tự khởi động cùng macOS:", error instanceof Error ? error.message : String(error));
      }
      void controlServer("start").catch((error) => {
        console.warn("Không thể tự khởi động CodexPro runtime:", error instanceof Error ? error.message : String(error));
      });
    }
    createWindow();
    setImmediate(() => readManagerChatCache());
    void ensureFreshRuntimeAfterManagerStart();
    void headlessWorkers.startAutoWorkers().catch((error) => {
      console.warn("Không thể tự khởi động headless worker:", error instanceof Error ? error.message : String(error));
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    diagnostic("info", "electron", "runtime", "CodexPro Manager đang thoát", { action: "manager-before-quit" });
  });
}
