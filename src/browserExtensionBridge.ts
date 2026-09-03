import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexProError } from "./guard.js";
import { createRuntimeTraceContext, currentRuntimeTraceContext, recordRuntimeTraceSpan, runWithRuntimeTraceContext } from "./analysis/runtimeTrace.js";

const BRIDGE_HOST = "127.0.0.1";
const CODEXPRO_EXTENSION_ORIGIN = "chrome-extension://gndipignbnipohooclcbhjliikamjlpl";
export const BROWSER_EXTENSION_BRIDGE_PORT = 9224;
const PROFILE_TTL_MS = 3 * 60_000;
const PROFILE_RETENTION_MS = 24 * 60 * 60_000;
const PROFILE_RECONNECT_WAIT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 25_000;
const CHECK_COMMAND_TIMEOUT_MS = 120_000;
const SETUP_COMMAND_TIMEOUT_MS = 300_000;
const SEND_COMMAND_TIMEOUT_MS = 180_000;
const LONG_TASK_AUDIT_COMMAND_TIMEOUT_MS = 125_000;
const COMMAND_EXPIRY_HEADROOM_MS = 5_000;
const READ_RESPONSE_TIMEOUT_MS = 75_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const PROFILE_TASK_STATE_VERSION = 1;
const MAX_PERSISTED_PROFILE_TASKS = 200;
const PROFILE_TASK_EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024;
const PROFILE_TASK_EVENT_THROTTLE_MS = 30_000;
const PROFILE_REGISTRY_VERSION = 1;
const PROFILE_REGISTRY_WRITE_INTERVAL_MS = 30_000;

export interface BrowserProfilePersistenceRecord {
  id: string;
  enabled: boolean;
  enabledUpdatedAt: number;
  email: string;
  label: string;
  extensionVersion: string;
  connectorInstalled: boolean;
  connectorVerificationState?: string;
  connectorMessage: string;
  connectorCheckedAt: string;
  connectorServerFingerprint: string;
  workspaceRoot: string;
  connectorWorkerId: string;
  headless: boolean;
  sourceProfileId: string;
  lifecycleEvent: Record<string, unknown> | null;
  lifecycleEvents: Array<Record<string, unknown>>;
  lastSeen: number;
}

export function browserProfileDisplayLabel(value: unknown, headless = false): string {
  const label = String(value ?? "").trim();
  return headless ? label.replace(/^Headless\s*·\s*/i, "").trim() : label;
}

export function browserProfileRetentionState(
  profile: { headless?: boolean; lastSeen?: number; restored?: boolean },
  now = Date.now()
): { connected: boolean; visible: boolean; nextTransitionAt: number | null } {
  const lastSeen = Math.max(0, Number(profile?.lastSeen) || 0);
  const ageMs = Math.max(0, Number(now) - lastSeen);
  const connected = profile?.restored !== true && ageMs <= PROFILE_TTL_MS;
  const visible = profile?.headless === true ? connected : ageMs <= PROFILE_RETENTION_MS;
  const nextTransitionAt = connected
    ? lastSeen + PROFILE_TTL_MS
    : visible && profile?.headless !== true
      ? lastSeen + PROFILE_RETENTION_MS
      : null;
  return { connected, visible, nextTransitionAt };
}

export function browserProfilePersistenceSnapshot(
  profiles: Iterable<BrowserProfilePersistenceRecord>,
  now = Date.now()
): { version: number; saved_at: string; profiles: BrowserProfilePersistenceRecord[] } {
  const retained = [...profiles]
    .filter((profile) => profile?.headless !== true && browserProfileRetentionState(profile, now).visible)
    .map((profile) => ({
      id: String(profile.id || "").slice(0, 160),
      enabled: profile.enabled !== false,
      enabledUpdatedAt: Math.max(0, Number(profile.enabledUpdatedAt) || 0),
      email: String(profile.email || "").slice(0, 320),
      label: String(profile.label || "").slice(0, 320),
      extensionVersion: String(profile.extensionVersion || "").slice(0, 32),
      connectorInstalled: profile.connectorInstalled === true,
      connectorVerificationState: ['connected', 'missing', 'unknown'].includes(String(profile.connectorVerificationState)) ? profile.connectorVerificationState : 'unknown',
      connectorMessage: String(profile.connectorMessage || "").slice(0, 500),
      connectorCheckedAt: String(profile.connectorCheckedAt || "").slice(0, 64),
      connectorServerFingerprint: String(profile.connectorServerFingerprint || "").slice(0, 128),
      workspaceRoot: String(profile.workspaceRoot || "").slice(0, 4_096),
      connectorWorkerId: String(profile.connectorWorkerId || "").slice(0, 80),
      headless: false,
      sourceProfileId: String(profile.sourceProfileId || "").slice(0, 160),
      lifecycleEvent: profile.lifecycleEvent && typeof profile.lifecycleEvent === "object" && !Array.isArray(profile.lifecycleEvent)
        ? profile.lifecycleEvent
        : null,
      lifecycleEvents: Array.isArray(profile.lifecycleEvents)
        ? profile.lifecycleEvents.filter((event) => event && typeof event === "object" && !Array.isArray(event)).slice(-20)
        : [],
      lastSeen: Math.max(0, Number(profile.lastSeen) || 0)
    }))
    .filter((profile) => Boolean(profile.id))
    .slice(0, 100);
  return { version: PROFILE_REGISTRY_VERSION, saved_at: new Date(now).toISOString(), profiles: retained };
}

export interface ExtensionProfileSummary {
  profile_id: string;
  email: string;
  label: string;
  extension_version: string;
  connector_installed: boolean;
  connector_message: string;
  connector_checked_at: string;
  connector_verification_required?: boolean;
  connector_verification_state?: string;
  worker_id: string;
  headless: boolean;
  source_profile_id: string;
  lifecycle_event: Record<string, unknown> | null;
  lifecycle_events: Array<Record<string, unknown>>;
  connector_profile_bound: boolean;
  connector_update_required: boolean;
  active: boolean;
  connected: boolean;
  last_seen: string;
  tab_count: number;
  chatgpt_tab_count: number;
  busy_request_count: number;
  busy_since: string;
  activity: "working" | "settling" | "idle" | "no_chatgpt";
  active_chat_title: string;
  current_workspace_root: string;
  current_task_id: string;
  current_task_title: string;
  current_task_conversation_id: string;
  chatgpt_tabs: Array<{
    id: number;
    title: string;
    url: string;
    active: boolean;
  }>;
  conversation_tabs: Array<{
    id: number;
    title: string;
    url: string;
    active: boolean;
    busy: boolean;
    settling: boolean;
    activity_text: string;
    network_state: string;
    network_source: string;
    network_last_started_at: string;
    network_last_completed_at: string;
    network_status_code: number;
    network_error: string;
    network_duration_ms: number;
    network_stream_text: string;
    network_stream_revision: number;
    network_stream_record_id: number;
    network_stream_event_count: number;
    network_stream_updated_at: string;
    network_stream_in_progress: boolean;
    network_stream_error: string;
    network_stream_activity_text: string;
    connection_interrupted: boolean;
    message_delivery_timed_out: boolean;
    renderer_unresponsive: boolean;
    renderer_error: string;
    long_task_watchdog_hung: boolean;
    long_task_watchdog_attempt_key: string;
  }>;
  recent_conversations: Array<{
    id: string;
    title: string;
    url: string;
    updated_at: number;
    open: boolean;
    active: boolean;
    long_task_watchdog_hung: boolean;
    long_task_watchdog_attempt_key: string;
  }>;
}

export interface BrowserExtensionStreamUpdate {
  profile_id: string;
  tab_id: number;
  conversation_id: string;
  record_id: number;
  revision: number;
  text: string;
  event_count: number;
  updated_at: string;
  in_progress: boolean;
  error: string;
  activity_text: string;
}

export function mergeBrowserExtensionStreamBatch(profileId: string, tabs: unknown[], streams: unknown[]): { changed: boolean; updates: BrowserExtensionStreamUpdate[] } {
  const profile = String(profileId || "").trim().slice(0, 160);
  const tabList = Array.isArray(tabs) ? tabs : [];
  const streamList = Array.isArray(streams) ? streams.slice(0, 12) : [];
  const updates: BrowserExtensionStreamUpdate[] = [];
  for (const value of streamList) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const stream = value as Record<string, any>;
    const tabId = Number(stream.tab_id);
    if (!Number.isInteger(tabId) || tabId < 0) continue;
    const tab = tabList.find((candidate: any) => Number(candidate?.id) === tabId) as Record<string, any> | undefined;
    if (!tab) continue;
    const recordId = Math.max(0, Number(stream.record_id) || 0);
    const revision = Math.max(0, Number(stream.revision) || 0);
    if (!recordId || !revision) continue;
    const currentRecordId = Math.max(0, Number(tab.network_stream_record_id) || 0);
    const currentRevision = Math.max(0, Number(tab.network_stream_revision) || 0);
    if (currentRecordId === recordId && revision <= currentRevision) continue;
    tab.network_stream_record_id = recordId;
    tab.network_stream_revision = revision;
    tab.network_stream_text = String(stream.text ?? "").slice(0, 200_000);
    tab.network_stream_event_count = Math.max(0, Number(stream.event_count) || 0);
    tab.network_stream_updated_at = String(stream.updated_at ?? "").slice(0, 64);
    tab.network_stream_in_progress = stream.in_progress === true;
    tab.network_stream_error = String(stream.error ?? "").slice(0, 500);
    tab.network_stream_activity_text = String(stream.activity_text ?? "").trim().slice(0, 220);
    if (stream.in_progress === true) {
      tab.busy = true;
      tab.network_state = "generating";
      tab.busy_source = "network_stream_push";
    } else if (String(tab.busy_source || "") === "network_stream_push") {
      tab.busy = false;
      if (tab.network_state === "generating") tab.network_state = "completed";
      tab.busy_source = "";
    }
    updates.push({
      profile_id: profile,
      tab_id: tabId,
      conversation_id: String(stream.conversation_id ?? "").slice(0, 180),
      record_id: recordId,
      revision,
      text: String(tab.network_stream_text ?? ""),
      event_count: Number(tab.network_stream_event_count) || 0,
      updated_at: String(tab.network_stream_updated_at ?? ""),
      in_progress: tab.network_stream_in_progress === true,
      error: String(tab.network_stream_error ?? ""),
      activity_text: String(tab.network_stream_activity_text ?? "")
    });
  }
  return { changed: updates.length > 0, updates };
}

export interface BrowserExtensionConnectorInfo {
  name: string;
  server_url: string;
  settings_url: string;
  authentication: "none";
  worker_id?: string;
}

export interface BrowserExtensionBridgeOptions {
  connectorInfo?: (profileId: string) => BrowserExtensionConnectorInfo;
}

interface ExtensionProfile {
  id: string;
  enabled: boolean;
  enabledUpdatedAt: number;
  email: string;
  label: string;
  extensionVersion: string;
  connectorInstalled: boolean;
  connectorVerificationState?: string;
  connectorMessage: string;
  connectorCheckedAt: string;
  connectorServerFingerprint: string;
  workspaceRoot: string;
  connectorWorkerId: string;
  headless: boolean;
  sourceProfileId: string;
  lifecycleEvent: Record<string, unknown> | null;
  lifecycleEvents: Array<Record<string, unknown>>;
  lastSeen: number;
  restored?: boolean;
  tabs: unknown[];
  recentConversations: unknown[];
  queued: BridgeCommand[];
  waiter?: ServerResponse;
  waiterTimer?: NodeJS.Timeout;
}

interface BridgeCommand {
  id: string;
  action: string;
  args: Record<string, unknown>;
  created_at_ms: number;
  expires_at_ms: number;
}

interface PendingResult {
  resolve: (value: Record<string, any>) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  timeoutMs: number;
  waitingForReconnect: boolean;
  dispatchedAtMs: number;
}

interface BridgeState {
  server: http.Server;
  profiles: Map<string, ExtensionProfile>;
  pending: Map<string, PendingResult>;
  activeProfileId?: string;
  connectorInfo?: (profileId: string) => BrowserExtensionConnectorInfo;
  profileListeners: Set<(profiles: ExtensionProfileSummary[]) => void>;
  streamListeners: Set<(updates: BrowserExtensionStreamUpdate[]) => void>;
  profileNotifyTimer?: NodeJS.Timeout;
  profileNotifySignature?: string;
  profileExpiryTimer?: NodeJS.Timeout;
  profileRegistryTimer?: NodeJS.Timeout;
  profileRegistryLastWrittenAt?: number;
}

const profileWorkspaceRoots = new Map<string, string>();
const profileWorkspaceBindings = new Map<string, string>();
const profileTaskIds = new Map<string, string>();
const profileTaskTitles = new Map<string, string>();
const profileTaskConversationIds = new Map<string, string>();
const profileTaskUpdatedAt = new Map<string, string>();
const profilePendingTasks = new Map<string, { taskId: string; root: string; scope: "workspace" | "all_allowed"; preparedAt: number }>();
const profileTaskEventSignatures = new Map<string, { signature: string; at: number }>();
let singleton: BridgeState | undefined;

function browserProfileTaskStatePath(): string {
  const configuredHome = String(process.env.CODEXPRO_HOME || "").trim();
  const home = configuredHome ? path.resolve(configuredHome) : path.join(os.homedir(), ".codexpro");
  return path.join(home, "browser-profile-tasks.json");
}

function browserProfileRegistryPath(): string {
  return path.join(path.dirname(browserProfileTaskStatePath()), "browser-profiles.json");
}

function persistBrowserProfileRegistry(state: BridgeState, now = Date.now()): void {
  try {
    const registryPath = browserProfileRegistryPath();
    const temporaryPath = `${registryPath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(browserProfilePersistenceSnapshot(state.profiles.values(), now), null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, registryPath);
    state.profileRegistryLastWrittenAt = now;
  } catch {
    // Profile retention is best-effort and must never make the bridge unavailable.
  }
}

function scheduleBrowserProfileRegistryPersistence(state: BridgeState): void {
  if (state.profileRegistryTimer) return;
  const now = Date.now();
  const delay = state.profileRegistryLastWrittenAt
    ? Math.max(250, PROFILE_REGISTRY_WRITE_INTERVAL_MS - (now - state.profileRegistryLastWrittenAt))
    : 250;
  state.profileRegistryTimer = setTimeout(() => {
    state.profileRegistryTimer = undefined;
    persistBrowserProfileRegistry(state);
  }, delay);
  state.profileRegistryTimer.unref?.();
}

function loadBrowserProfileRegistry(state: BridgeState, now = Date.now()): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(browserProfileRegistryPath(), "utf8")) as {
      version?: number;
      profiles?: BrowserProfilePersistenceRecord[];
    };
    if (Number(parsed?.version) !== PROFILE_REGISTRY_VERSION || !Array.isArray(parsed?.profiles)) return;
    for (const saved of browserProfilePersistenceSnapshot(parsed.profiles, now).profiles) {
      const profile: ExtensionProfile = {
        ...saved,
        restored: true,
        tabs: [],
        recentConversations: [],
        queued: []
      };
      state.profiles.set(profile.id, profile);
      if (profile.workspaceRoot) profileWorkspaceRoots.set(profile.id, profile.workspaceRoot);
    }
  } catch {
    // A missing or corrupt snapshot must behave like a clean first run.
  }
}

function browserProfileTaskEventLogPath(): string {
  return path.join(path.dirname(browserProfileTaskStatePath()), "profile-task-events.jsonl");
}

function headlessWorkerStatePath(): string {
  return path.join(path.dirname(browserProfileTaskStatePath()), "headless-workers.json");
}

function processAlive(pid: unknown): boolean {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function headlessExclusiveLock(profileId: string, workerId = ""): { locked: boolean; worker_id: string } {
  try {
    const state = JSON.parse(fs.readFileSync(headlessWorkerStatePath(), "utf8"));
    const workers = Array.isArray(state?.workers) ? state.workers : [];
    const now = Date.now();
    const worker = workers.find((item: any) => {
      if (!item) return false;
      const startingAtMs = Date.parse(String(item.startingAt || ""));
      const ownsSession = processAlive(item.pid)
        || (Number.isFinite(startingAtMs) && Math.max(0, now - startingAtMs) < 30_000);
      if (!ownsSession) return false;
      if (workerId && String(item.id || "") !== workerId) return false;
      return String(item.sourceProfileId || "") === profileId;
    });
    return { locked: Boolean(worker), worker_id: String(worker?.id || "") };
  } catch {
    return { locked: false, worker_id: "" };
  }
}

export function recordBrowserProfileTaskEvent(event: string, details: Record<string, unknown> = {}): void {
  try {
    const logPath = browserProfileTaskEventLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size >= PROFILE_TASK_EVENT_LOG_MAX_BYTES) {
      const previousPath = `${logPath}.1`;
      if (fs.existsSync(previousPath)) fs.rmSync(previousPath, { force: true });
      fs.renameSync(logPath, previousPath);
    }
    const safeDetails = Object.fromEntries(Object.entries(details).slice(0, 40).map(([key, value]) => [
      String(key).slice(0, 100),
      typeof value === "string" ? value.slice(0, 500) : typeof value === "number" || typeof value === "boolean" || value == null ? value : String(value).slice(0, 500)
    ]));
    fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), event: String(event).slice(0, 120), ...safeDetails })}\n`, "utf8");
  } catch {
    // Diagnostics must never break the profile bridge or MCP runtime.
  }
}

function connectorFingerprint(serverUrl: string): string {
  return createHash("sha256").update(String(serverUrl || ""), "utf8").digest("hex");
}

function expectedConnectorFingerprint(state: BridgeState, profileId: string): string {
  try {
    return state.connectorInfo ? connectorFingerprint(state.connectorInfo(profileId).server_url) : "";
  } catch {
    return "";
  }
}

function validPersistedProfileId(value: string): boolean {
  return /^[A-Za-z0-9_-]{2,160}$/.test(value);
}

function conversationIdFromUrl(value: unknown): string {
  try {
    return new URL(String(value || "")).pathname.match(/^\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
  } catch {
    return "";
  }
}

function inferProfileTaskConversationId(profileId: string): string {
  const profile = singleton?.profiles.get(profileId);
  const tabs = Array.isArray(profile?.tabs)
    ? profile.tabs.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    : [];
  const candidates = tabs
    .map((tab) => ({
      id: conversationIdFromUrl(tab.url),
      codexActivity: /^CodexPro đang\b/i.test(String(tab.activity_text || "").trim()),
      working: tab.busy === true || tab.settling === true || tab.network_state === "generating" || tab.network_stream_in_progress === true,
      active: tab.active === true,
      startedAt: Date.parse(String(tab.network_last_started_at || "")) || 0
    }))
    .filter((tab) => Boolean(tab.id))
    .sort((left, right) =>
      Number(right.codexActivity && right.working) - Number(left.codexActivity && left.working)
      || Number(right.working) - Number(left.working)
      || Number(right.active) - Number(left.active)
      || right.startedAt - left.startedAt
    );
  return candidates[0]?.id || "";
}

function profileTaskConversationCandidateLog(profileId: string): string {
  const profile = singleton?.profiles.get(profileId);
  const tabs = Array.isArray(profile?.tabs)
    ? profile.tabs.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    : [];
  return JSON.stringify(tabs.slice(0, 8).map((tab) => ({
    id: conversationIdFromUrl(tab.url),
    title: String(tab.title || "").slice(0, 120),
    active: tab.active === true,
    busy: tab.busy === true,
    settling: tab.settling === true,
    network_state: String(tab.network_state || ""),
    network_stream_in_progress: tab.network_stream_in_progress === true,
    activity_text: String(tab.activity_text || "").slice(0, 120)
  }))).slice(0, 500);
}

function loadBrowserProfileTasks(): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(browserProfileTaskStatePath(), "utf8")) as {
      profiles?: Record<string, {
        task_id?: unknown;
        task_title?: unknown;
        task_conversation_id?: unknown;
        updated_at?: unknown;
        pending_task_id?: unknown;
        pending_root?: unknown;
        pending_scope?: unknown;
        pending_prepared_at?: unknown;
      }>;
    };
    for (const [profileId, value] of Object.entries(parsed.profiles || {}).slice(-MAX_PERSISTED_PROFILE_TASKS)) {
      if (!validPersistedProfileId(profileId)) continue;
      const taskId = String(value?.task_id || "").trim();
      const taskTitle = String(value?.task_title || "").trim();
      const taskConversationId = String(value?.task_conversation_id || "").trim();
      const updatedAt = String(value?.updated_at || "").trim();
      if (/^cpt_[a-f0-9]{24}$/.test(taskId) && taskTitle.length >= 4 && taskTitle.length <= 56) {
        const wordCount = taskTitle.split(/\s+/).filter(Boolean).length;
        if (wordCount >= 2 && wordCount <= 6) {
          profileTaskIds.set(profileId, taskId);
          profileTaskTitles.set(profileId, taskTitle);
          if (/^[A-Za-z0-9-]{8,160}$/.test(taskConversationId)) profileTaskConversationIds.set(profileId, taskConversationId);
          profileTaskUpdatedAt.set(profileId, updatedAt || new Date(0).toISOString());
        }
      }
      const pendingTaskId = String(value?.pending_task_id || "").trim();
      const pendingRoot = String(value?.pending_root || "").trim();
      const pendingScope = value?.pending_scope === "all_allowed" ? "all_allowed" : value?.pending_scope === "workspace" ? "workspace" : "";
      const pendingPreparedAt = Date.parse(String(value?.pending_prepared_at || ""));
      if (/^cpt_[a-f0-9]{24}$/.test(pendingTaskId) && pendingScope && Number.isFinite(pendingPreparedAt)) {
        profilePendingTasks.set(profileId, {
          taskId: pendingTaskId,
          root: pendingRoot,
          scope: pendingScope,
          preparedAt: pendingPreparedAt
        });
      }
    }
  } catch {
    // Missing or malformed state must not prevent the local bridge from starting.
  }
}

function persistBrowserProfileTasks(): void {
  try {
    const profileIds = [...new Set([...profileTaskTitles.keys(), ...profileTaskConversationIds.keys(), ...profilePendingTasks.keys()])];
    const profiles = profileIds
      .map((profileId) => {
        const pendingTask = profilePendingTasks.get(profileId);
        return {
          profileId,
          taskId: profileTaskIds.get(profileId) || "",
          taskTitle: profileTaskTitles.get(profileId) || "",
          taskConversationId: profileTaskConversationIds.get(profileId) || "",
          updatedAt: profileTaskUpdatedAt.get(profileId) || new Date(0).toISOString(),
          pendingTaskId: pendingTask?.taskId || "",
          pendingRoot: pendingTask?.root || "",
          pendingScope: pendingTask?.scope || "",
          pendingPreparedAt: pendingTask ? new Date(pendingTask.preparedAt).toISOString() : ""
        };
      })
      .filter((entry) => validPersistedProfileId(entry.profileId) && (
        (/^cpt_[a-f0-9]{24}$/.test(entry.taskId) && Boolean(entry.taskTitle))
        || (/^cpt_[a-f0-9]{24}$/.test(entry.pendingTaskId) && Boolean(entry.pendingScope))
      ))
      .sort((left, right) => Math.max(Date.parse(left.updatedAt) || 0, Date.parse(left.pendingPreparedAt) || 0) - Math.max(Date.parse(right.updatedAt) || 0, Date.parse(right.pendingPreparedAt) || 0))
      .slice(-MAX_PERSISTED_PROFILE_TASKS);
    const stateFile = browserProfileTaskStatePath();
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({
      version: PROFILE_TASK_STATE_VERSION,
      profiles: Object.fromEntries(profiles.map((entry) => [entry.profileId, {
        ...(entry.taskId && entry.taskTitle ? {
          task_id: entry.taskId,
          task_title: entry.taskTitle,
          task_conversation_id: entry.taskConversationId,
          updated_at: entry.updatedAt
        } : {}),
        ...(entry.pendingTaskId && entry.pendingScope ? {
          pending_task_id: entry.pendingTaskId,
          pending_root: entry.pendingRoot,
          pending_scope: entry.pendingScope,
          pending_prepared_at: entry.pendingPreparedAt
        } : {})
      }]))
    }, null, 2)}\n`, "utf8");
  } catch {
    // The in-memory title/pending gate remains usable if persistence is temporarily unavailable.
  }
}

loadBrowserProfileTasks();

export function browserProfileNotificationSignature(profiles: ExtensionProfileSummary[]): string {
  return JSON.stringify((Array.isArray(profiles) ? profiles : []).map(({ last_seen: _lastSeen, ...profile }) => profile));
}

function scheduleProfileNotification(state: BridgeState): void {
  if (state.profileNotifyTimer) return;
  state.profileNotifyTimer = setTimeout(() => {
    state.profileNotifyTimer = undefined;
    const profiles = listBrowserExtensionProfiles();
    const signature = browserProfileNotificationSignature(profiles);
    if (signature === state.profileNotifySignature) return;
    state.profileNotifySignature = signature;
    for (const listener of state.profileListeners) {
      try { listener(profiles); } catch {}
    }
  }, 25);
  state.profileNotifyTimer.unref?.();
}

function scheduleProfileExpiryNotification(state: BridgeState): void {
  if (state.profileExpiryTimer) clearTimeout(state.profileExpiryTimer);
  state.profileExpiryTimer = undefined;
  const now = Date.now();
  const nextExpiry = [...state.profiles.values()]
    .map((profile) => browserProfileRetentionState(profile, now).nextTransitionAt)
    .filter((expiresAt): expiresAt is number => expiresAt != null)
    .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > now)
    .sort((left, right) => left - right)[0];
  if (!Number.isFinite(nextExpiry)) return;
  state.profileExpiryTimer = setTimeout(() => {
    state.profileExpiryTimer = undefined;
    scheduleProfileNotification(state);
    scheduleProfileExpiryNotification(state);
  }, Math.max(1, nextExpiry - Date.now() + 25));
  state.profileExpiryTimer.unref?.();
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function extensionOrigin(req: IncomingMessage): string | undefined {
  const origin = String(req.headers.origin ?? "");
  return origin.startsWith("chrome-extension://") ? origin : undefined;
}

function trustedConnectorRequest(req: IncomingMessage): boolean {
  return extensionOrigin(req) === CODEXPRO_EXTENSION_ORIGIN;
}

function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = extensionOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CodexPro-Extension");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Cache-Control", "no-store");
}

function allowedRequest(req: IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const host = String(req.headers.host ?? "").toLowerCase();
  if (host !== `${BRIDGE_HOST}:${BROWSER_EXTENSION_BRIDGE_PORT}` && host !== `localhost:${BROWSER_EXTENSION_BRIDGE_PORT}`) return false;
  return Boolean(extensionOrigin(req)) && req.headers["x-codexpro-extension"] === "profile-bridge-v1";
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, value: unknown): void {
  setCors(req, res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new CodexProError("Browser extension bridge request is too large.");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    throw new CodexProError("Browser extension bridge received invalid JSON.");
  }
}

function boundedBridgeValue(value: unknown, maxChars = 2_000): string {
  return String(value ?? "").slice(0, maxChars);
}

function bridgeErrorEnvelope(value: unknown): Record<string, unknown> {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const message = boundedBridgeValue(source.message ?? value ?? "Chrome extension action failed.");
  const detailsSource = source.details && typeof source.details === "object" && !Array.isArray(source.details)
    ? source.details as Record<string, unknown>
    : {};
  const details = Object.fromEntries(Object.entries(detailsSource).slice(0, 40).map(([key, item]) => [
    boundedBridgeValue(key, 100),
    typeof item === "string" ? boundedBridgeValue(item, 4_000) : item
  ]));
  return {
    name: boundedBridgeValue(source.name || "CodexProExtensionError", 120),
    message,
    code: boundedBridgeValue(source.code, 160) || undefined,
    stage: boundedBridgeValue(source.stage, 160) || undefined,
    action: boundedBridgeValue(source.action, 160) || undefined,
    details
  };
}

function profileFromBody(state: BridgeState, body: Record<string, any>): ExtensionProfile {
  const source = body.profile && typeof body.profile === "object" ? body.profile : body;
  const id = String(source.id ?? "").trim().slice(0, 160);
  if (!id) throw new CodexProError("Browser extension profile id is required.");
  const existing = state.profiles.get(id);
  const profile: ExtensionProfile = existing ?? {
    id,
    enabled: true,
    enabledUpdatedAt: 0,
    email: "",
    label: "",
    extensionVersion: "",
    connectorInstalled: false,
    connectorMessage: "",
    connectorCheckedAt: "",
    connectorServerFingerprint: "",
    workspaceRoot: profileWorkspaceRoots.get(id) || "",
    connectorWorkerId: "",
    headless: false,
    sourceProfileId: "",
    lifecycleEvent: null,
    lifecycleEvents: [],
    lastSeen: 0,
    tabs: [],
    recentConversations: [],
    queued: []
  };
  const incomingEnabledUpdatedAt = Math.max(0, Number(source.worker_enabled_updated_at) || 0);
  if (!profile.enabledUpdatedAt || incomingEnabledUpdatedAt >= profile.enabledUpdatedAt) {
    profile.enabled = source.enabled !== false;
    profile.enabledUpdatedAt = incomingEnabledUpdatedAt;
  }
  if (!profile.enabled && state.activeProfileId === id) state.activeProfileId = undefined;
  profile.email = String(source.email ?? profile.email ?? "").trim().slice(0, 320);
  profile.headless = source.headless === true;
  profile.label = browserProfileDisplayLabel(
    source.label ?? profile.label ?? profile.email ?? `Chrome ${id.slice(0, 8)}`,
    profile.headless
  ).slice(0, 320);
  profile.extensionVersion = String(source.version ?? profile.extensionVersion ?? "").trim().slice(0, 32);
  profile.sourceProfileId = String(source.source_profile_id ?? profile.sourceProfileId ?? "").trim().slice(0, 160);
  profile.lifecycleEvent = source.lifecycle_event && typeof source.lifecycle_event === "object" && !Array.isArray(source.lifecycle_event)
    ? source.lifecycle_event
    : profile.lifecycleEvent;
  profile.lifecycleEvents = Array.isArray(source.lifecycle_events)
    ? source.lifecycle_events
      .filter((event: unknown): event is Record<string, unknown> => Boolean(event) && typeof event === "object" && !Array.isArray(event))
      .slice(-20)
    : profile.lifecycleEvents;
  if (source.connector_install && typeof source.connector_install === "object") {
    const incomingInstalled = source.connector_install.ok === true;
    const incomingCheckedAt = String(source.connector_install.at ?? "").trim().slice(0, 64);
    const incomingCheckedAtMs = Date.parse(incomingCheckedAt);
    const currentCheckedAtMs = Date.parse(profile.connectorCheckedAt);
    // Both upgrades and downgrades must be monotonic. Commands/heartbeats may
    // finish out of order and carry the pre-check snapshot of the profile.
    const acceptObservation = !Number.isFinite(currentCheckedAtMs)
      || (Number.isFinite(incomingCheckedAtMs) && (incomingCheckedAtMs > currentCheckedAtMs
        || incomingCheckedAtMs === currentCheckedAtMs && (profile.connectorInstalled === incomingInstalled || !incomingInstalled)));
    if (acceptObservation) {
      profile.connectorInstalled = incomingInstalled;
      profile.connectorVerificationState = ['connected', 'disconnected', 'missing'].includes(source.connector_install.verification_state)
        ? source.connector_install.verification_state : 'unknown';
      profile.connectorMessage = String(source.connector_install.message ?? "").trim().slice(0, 500);
      profile.connectorCheckedAt = incomingCheckedAt;
      profile.connectorServerFingerprint = String(source.connector_server_fingerprint ?? profile.connectorServerFingerprint ?? "").trim().slice(0, 128);
      profile.connectorWorkerId = String(source.connector_install.worker_id ?? profile.connectorWorkerId ?? "").trim().slice(0, 80);
    }
  }
  profile.lastSeen = Date.now();
  profile.restored = false;
  if (Array.isArray(body.tabs)) profile.tabs = body.tabs.slice(0, 500);
  else if (Array.isArray(body.tab_inventory)) {
    const existingTabsById = new Map(
      profile.tabs.filter((tab: any) => Number.isInteger(Number(tab?.id))).map((tab: any) => [Number(tab.id), tab])
    );
    profile.tabs = body.tab_inventory
      .slice(0, 500)
      .filter((tab: any) => tab && typeof tab === "object" && Number.isInteger(Number(tab.id)))
      .map((tab: any) => ({ ...(existingTabsById.get(Number(tab.id)) || {}), ...tab }));
  }
  if (Array.isArray(body.recent_conversations)) profile.recentConversations = body.recent_conversations.slice(0, 3);
  const observedCodexProToolActivity = profile.tabs.some((tab: any) =>
    Boolean(tab?.busy || tab?.settling) && /^CodexPro đang\b/i.test(String(tab?.activity_text ?? "").trim())
  );
  if (observedCodexProToolActivity && !profileTaskTitles.get(id)) {
    const activeTab = profile.tabs.find((tab: any) => tab?.active) as any || profile.tabs.find((tab: any) => tab?.busy || tab?.settling) as any;
    const signature = [activeTab?.url, activeTab?.activity_text, activeTab?.network_state].map((value) => String(value || "").slice(0, 240)).join("|");
    const previous = profileTaskEventSignatures.get(id);
    if (!previous || previous.signature !== signature || profile.lastSeen - previous.at >= PROFILE_TASK_EVENT_THROTTLE_MS) {
      profileTaskEventSignatures.set(id, { signature, at: profile.lastSeen });
      const pendingTask = profilePendingTasks.get(id);
      recordBrowserProfileTaskEvent("profile_activity_without_task", {
        profile_id: id,
        conversation_url: String(activeTab?.url || ""),
        activity_text: String(activeTab?.activity_text || ""),
        network_state: String(activeTab?.network_state || ""),
        pending_task_id: pendingTask?.taskId,
        pending_task_root: pendingTask?.root,
        pending_task_scope: pendingTask?.scope,
        pending_task_age_ms: pendingTask ? Math.max(0, profile.lastSeen - pendingTask.preparedAt) : undefined,
        connector_fingerprint_present: Boolean(profile.connectorServerFingerprint),
        connector_fingerprint_expected: Boolean(expectedConnectorFingerprint(state, id))
      });
    }
  }
  state.profiles.set(id, profile);
  scheduleBrowserProfileRegistryPersistence(state);
  scheduleProfileNotification(state);
  scheduleProfileExpiryNotification(state);
  return profile;
}

function clearWaiter(profile: ExtensionProfile): void {
  if (profile.waiterTimer) clearTimeout(profile.waiterTimer);
  profile.waiterTimer = undefined;
  profile.waiter = undefined;
}

function armPendingCommandTimeout(
  state: BridgeState,
  profile: ExtensionProfile,
  command: BridgeCommand,
  timeoutMs: number,
  message: string
): void {
  const pending = state.pending.get(command.id);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    state.pending.delete(command.id);
    profile.queued = profile.queued.filter((queued) => queued.id !== command.id);
    pending.reject(new CodexProError(message));
  }, timeoutMs);
  pending.timer.unref?.();
}

function markCommandDispatched(state: BridgeState, profile: ExtensionProfile, command: BridgeCommand): void {
  const pending = state.pending.get(command.id);
  if (!pending) return;
  if (!pending.dispatchedAtMs) pending.dispatchedAtMs = Date.now();
  if (!pending.waitingForReconnect) return;
  pending.waitingForReconnect = false;
  armPendingCommandTimeout(
    state,
    profile,
    command,
    pending.timeoutMs,
    `Timed out waiting for Chrome profile ${profile.label}.`
  );
}

function pruneExpiredProfiles(state: BridgeState, now = Date.now()): void {
  let removed = false;
  for (const [id, profile] of state.profiles) {
    if (browserProfileRetentionState(profile, now).visible || profile.waiter || profile.queued.length) continue;
    state.profiles.delete(id);
    removed = true;
    profileWorkspaceRoots.delete(id);
    profileWorkspaceBindings.delete(id);
    if (state.activeProfileId === id) state.activeProfileId = undefined;
  }
  if (removed) scheduleBrowserProfileRegistryPersistence(state);
}

function deliver(state: BridgeState, profile: ExtensionProfile, command: BridgeCommand | null): boolean {
  if (!profile.waiter) return false;
  if (command) markCommandDispatched(state, profile, command);
  const response = profile.waiter;
  clearWaiter(profile);
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify({ command, active_profile_id: state.activeProfileId ?? null }));
  return true;
}

function nextLiveCommand(state: BridgeState, profile: ExtensionProfile): BridgeCommand | null {
  if (!profile.enabled) return null;
  while(profile.queued.length){
    const command=profile.queued.shift()!;
    if(command.expires_at_ms<=Date.now()||!state.pending.has(command.id))continue;
    markCommandDispatched(state, profile, command);
    return command;
  }
  return null;
}

function syncWaiters(state: BridgeState): void {
  for (const profile of state.profiles.values()) deliver(state, profile, null);
}

function forgetHeadlessProfile(state: BridgeState, profileId: string): boolean {
  const profile = state.profiles.get(profileId);
  if (!profile || !profile.headless) return false;
  if (profile.waiter) deliver(state, profile, null);
  for (const command of profile.queued) {
    const pending = state.pending.get(command.id);
    if (!pending) continue;
    clearTimeout(pending.timer);
    state.pending.delete(command.id);
    pending.reject(new CodexProError("Headless Chrome profile " + (profile.label || profile.id) + " was removed."));
  }
  profile.queued = [];
  state.profiles.delete(profile.id);
  profileWorkspaceRoots.delete(profile.id);
  profileWorkspaceBindings.delete(profile.id);
  if (state.activeProfileId === profile.id) state.activeProfileId = undefined;
  return true;
}

function pruneExpiredHeadlessProfiles(state: BridgeState, now = Date.now()): void {
  for (const profile of [...state.profiles.values()]) {
    if (profile.headless && now - profile.lastSeen > PROFILE_TTL_MS) forgetHeadlessProfile(state, profile.id);
  }
}

async function handleRequest(state: BridgeState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(req, res);
  if (req.method === "GET" && String(req.url || "").startsWith("/headless-lock")) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    const url = new URL(String(req.url || "/headless-lock"), `http://${BRIDGE_HOST}:${BROWSER_EXTENSION_BRIDGE_PORT}`);
    const profileId = String(url.searchParams.get("profile_id") || "").trim().slice(0, 160);
    const workerId = String(url.searchParams.get("worker_id") || "").trim().slice(0, 160);
    const lock = profileId ? headlessExclusiveLock(profileId, workerId) : { locked: false, worker_id: "" };
    sendJson(req, res, 200, { ok: true, profile_id: profileId, ...lock });
    return;
  }
  if (req.method === "GET" && String(req.url || "").startsWith("/headless-bootstrap")) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end("<!doctype html><meta charset=\"utf-8\"><title>CodexPro Headless</title><body>CodexPro headless worker bootstrap.</body>");
    return;
  }
  if (req.method === "DELETE" && String(req.url || "").startsWith("/headless-profile/")) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    const profileId = decodeURIComponent(String(req.url || "").slice("/headless-profile/".length)).trim().slice(0, 160);
    const removed = profileId ? forgetHeadlessProfile(state, profileId) : false;
    sendJson(req, res, removed ? 200 : 404, { ok: removed, profile_id: profileId });
    return;
  }
  if (req.method === "OPTIONS") {
    if (!extensionOrigin(req)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST" || !allowedRequest(req)) {
    sendJson(req, res, 403, { error: "Browser extension bridge request denied." });
    return;
  }

  const body = await readJson(req);
  if (req.url === "/activate") {
    const profile = profileFromBody(state, body);
    state.activeProfileId = profile.id;
    scheduleProfileNotification(state);
    syncWaiters(state);
    sendJson(req, res, 200, { ok: true, active_profile_id: profile.id });
    return;
  }

  if (req.url === "/stream") {
    const profileId = String(body.profile_id ?? "").trim().slice(0, 160);
    const profile = profileId ? state.profiles.get(profileId) : undefined;
    if (!profile) {
      sendJson(req, res, 202, { ok: true, ignored: true, reason: "profile_not_registered" });
      return;
    }
    const { changed, updates } = mergeBrowserExtensionStreamBatch(profile.id, profile.tabs, body.streams);
    profile.lastSeen = Date.now();
    if (updates.length) {
      for (const listener of state.streamListeners) {
        try { listener(updates); } catch {}
      }
    }
    scheduleProfileExpiryNotification(state);
    sendJson(req, res, 200, { ok: true, profile_id: profile.id, changed });
    return;
  }

  if (req.url === "/register") {
    const profile = profileFromBody(state, body);
    sendJson(req, res, 200, { ok: true, active_profile_id: state.activeProfileId ?? null, profile_id: profile.id });
    return;
  }

  if (req.url === "/connector") {
    if (!trustedConnectorRequest(req)) {
      sendJson(req, res, 403, { error: "Install the signed CodexPro extension before requesting the private MCP URL." });
      return;
    }
    const profile = profileFromBody(state, body);
    if (!state.connectorInfo) {
      sendJson(req, res, 503, { error: "CodexPro does not have a public MCP URL ready for browser setup." });
      return;
    }
    const connector = state.connectorInfo(profile.id);
    sendJson(req, res, 200, {
      ok: true,
      profile_id: profile.id,
      connector
    });
    return;
  }

  if (req.url === "/poll") {
    const profile = profileFromBody(state, body);
    if (body.active === true && !state.activeProfileId) state.activeProfileId = profile.id;
    const queuedCommand = nextLiveCommand(state, profile);
    if (queuedCommand) {
      sendJson(req, res, 200, { command: queuedCommand, active_profile_id: state.activeProfileId ?? null });
      return;
    }
    if (profile.waiter) {
      profile.waiter.statusCode = 409;
      profile.waiter.end(JSON.stringify({ error: "Replaced by a newer extension poll." }));
      clearWaiter(profile);
    }
    profile.waiter = res;
    profile.waiterTimer = setTimeout(() => deliver(state, profile, null), 20_000);
    res.on("close", () => {
      if (profile.waiter === res && !res.writableEnded) clearWaiter(profile);
    });
    return;
  }

  if (req.url === "/result") {
    profileFromBody(state, body);
    const commandId = String(body.command_id ?? "");
    const pending = state.pending.get(commandId);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      state.pending.delete(commandId);
      if (body.error) {
        const envelope = bridgeErrorEnvelope(body.error);
        pending.reject(new CodexProError(`Chrome extension action failed: ${String(envelope.message)}`, {
          code: String(envelope.code || "EXTENSION_ACTION_FAILED"),
          details: envelope
        }));
      }
      else pending.resolve(body.result && typeof body.result === "object" ? body.result : { value: body.result });
    }
    sendJson(req, res, 200, { ok: true });
    return;
  }

  sendJson(req, res, 404, { error: "Unknown browser extension bridge endpoint." });
}

export function ensureBrowserExtensionBridge(options: BrowserExtensionBridgeOptions = {}): BridgeState {
  if (singleton) {
    if (options.connectorInfo) singleton.connectorInfo = options.connectorInfo;
    return singleton;
  }
  const state = {} as BridgeState;
  state.profiles = new Map();
  state.pending = new Map();
  state.profileListeners = new Set();
  state.streamListeners = new Set();
  state.connectorInfo = options.connectorInfo;
  loadBrowserProfileRegistry(state);
  scheduleProfileExpiryNotification(state);
  state.server = http.createServer((req, res) => {
    handleRequest(state, req, res).catch((error) => {
      if (!res.headersSent) sendJson(req, res, 400, { error: error instanceof Error ? error.message : String(error) });
      else if (!res.writableEnded) res.end();
    });
  });
  state.server.on("error", (error) => {
    console.error(`[CodexProBrowserBridge] ${error instanceof Error ? error.message : String(error)}`);
  });
  state.server.listen(BROWSER_EXTENSION_BRIDGE_PORT, BRIDGE_HOST);
  singleton = state;
  return state;
}

export function listBrowserExtensionProfiles(): ExtensionProfileSummary[] {
  const state = ensureBrowserExtensionBridge();
  const now = Date.now();
  pruneExpiredHeadlessProfiles(state, now);
  pruneExpiredProfiles(state, now);
  const visibleProfiles = [...state.profiles.values()]
    .filter((profile) => profile.enabled && browserProfileRetentionState(profile, now).visible);
  if (state.activeProfileId && !visibleProfiles.some((profile) => profile.id === state.activeProfileId && browserProfileRetentionState(profile, now).connected)) {
    state.activeProfileId = undefined;
  }
  return visibleProfiles
    .map((profile) => {
      const { connected } = browserProfileRetentionState(profile, now);
      const tabs = profile.tabs
        .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
      const chatgptTabs = tabs.filter((tab) => String(tab.url ?? "").startsWith("https://chatgpt.com/"));
      const conversationTabs = chatgptTabs.filter((tab) => {
        try {
          return new URL(String(tab.url ?? "")).pathname.startsWith("/c/");
        } catch {
          return false;
        }
      });
      const activeConversation = conversationTabs.find((tab) => tab.active === true);
      const busyTabs = chatgptTabs.filter((tab) => tab.busy === true);
      const settlingTabs = chatgptTabs.filter((tab) => tab.settling === true);
      const busyRequestCount = busyTabs.reduce((total, tab) => total + Math.max(1, Number(tab.busy_request_count) || 0), 0);
      const busySince = busyTabs
        .map((tab) => String(tab.busy_since ?? ""))
        .filter(Boolean)
        .sort()[0] ?? "";
      const activity: ExtensionProfileSummary["activity"] = busyRequestCount > 0 ? "working" : settlingTabs.length ? "settling" : chatgptTabs.length ? "idle" : "no_chatgpt";
      const titleConversation = activeConversation ?? conversationTabs[0];
      let activeConversationId = "";
      try { activeConversationId = new URL(String(titleConversation?.url ?? "")).pathname.match(/^\/c\/([A-Za-z0-9-]{8,160})/)?.[1] ?? ""; } catch {}
      const chatgptTabSummaries = chatgptTabs
        .map((tab) => ({
          id: Number(tab.id),
          title: String(tab.title ?? "ChatGPT").trim().slice(0, 300),
          url: String(tab.url ?? "").trim().slice(0, 2000),
          active: tab.active === true
        }))
        .filter((tab) => Number.isInteger(tab.id) && tab.id >= 0);
      const conversationSummaries = conversationTabs
        .map((tab) => ({
          id: Number(tab.id),
          title: String(tab.title ?? "Đoạn chat chưa có tiêu đề").trim().slice(0, 300),
          url: String(tab.url ?? "").trim().slice(0, 2000),
          active: tab.active === true,
          busy: tab.busy === true,
          settling: tab.settling === true,
          activity_text: String(tab.activity_text ?? "").trim().slice(0, 220),
          network_state: tab.network_state === "generating" ? "generating" : tab.network_state === "completed" ? "completed" : tab.network_state === "failed" ? "failed" : "idle",
          network_source: String(tab.network_source ?? "").trim().slice(0, 32),
          network_generation_endpoint: String(tab.network_generation_endpoint ?? "").trim().slice(0, 500),
          network_last_started_at: String(tab.network_last_started_at ?? "").trim().slice(0, 64),
          network_last_completed_at: String(tab.network_last_completed_at ?? "").trim().slice(0, 64),
          network_status_code: Number(tab.network_status_code) || 0,
          network_error: String(tab.network_error ?? "").trim().slice(0, 500),
          network_duration_ms: Math.max(0, Number(tab.network_duration_ms) || 0),
          network_stream_text: String(tab.network_stream_text ?? '').slice(0, 200_000),
          network_stream_revision: Math.max(0, Number(tab.network_stream_revision) || 0),
          network_stream_record_id: Math.max(0, Number(tab.network_stream_record_id) || 0),
          network_stream_event_count: Math.max(0, Number(tab.network_stream_event_count) || 0),
          network_stream_updated_at: String(tab.network_stream_updated_at ?? '').trim().slice(0, 64),
          network_stream_in_progress: tab.network_stream_in_progress === true,
          network_stream_error: String(tab.network_stream_error ?? '').trim().slice(0, 500),
          network_stream_activity_text: String(tab.network_stream_activity_text ?? '').trim().slice(0, 220),
          connection_interrupted: tab.connection_interrupted === true,
          message_delivery_timed_out: tab.message_delivery_timed_out === true,
          renderer_unresponsive: tab.renderer_unresponsive === true,
          renderer_error: String(tab.renderer_error ?? "").trim().slice(0, 300),
          long_task_watchdog_hung: tab.long_task_watchdog_hung === true,
          long_task_watchdog_attempt_key: String(tab.long_task_watchdog_attempt_key ?? "").trim().slice(0, 300),
          network_recent_posts: Array.isArray(tab.network_recent_posts) ? tab.network_recent_posts.slice(-12) : []
        }))
        .filter((tab) => Number.isInteger(tab.id) && tab.id >= 0);
      const recentConversations = profile.recentConversations
        .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
        .map((conversation) => {
          const id = String(conversation.id ?? "").trim();
          const openTab = conversationTabs.find((tab) => {
            try {
              return new URL(String(tab.url ?? "")).pathname === `/c/${id}`;
            } catch {
              return false;
            }
          });
          return {
            id,
            title: String(conversation.title ?? "Đoạn chat chưa có tiêu đề").trim().slice(0, 300),
            url: `https://chatgpt.com/c/${id}`,
            updated_at: Number(conversation.updated_at) || 0,
            open: Boolean(openTab),
            active: openTab?.active === true,
            long_task_watchdog_hung: openTab?.long_task_watchdog_hung === true || conversation.long_task_watchdog_hung === true,
            long_task_watchdog_attempt_key: String(openTab?.long_task_watchdog_attempt_key ?? conversation.long_task_watchdog_attempt_key ?? "").trim().slice(0, 300)
          };
        })
        .filter((conversation) => /^[A-Za-z0-9-]{8,160}$/.test(conversation.id))
        .slice(0, 3);
      const activeChatTitle = String(recentConversations.find((conversation) => conversation.id === activeConversationId)?.title ?? titleConversation?.title ?? "").trim().slice(0, 300);
      const observedCodexProToolActivity = conversationSummaries.some((tab) =>
        (tab.busy || tab.settling) && /^CodexPro đang\b/i.test(tab.activity_text)
      );
      const expectedFingerprint = expectedConnectorFingerprint(state, profile.id);
      const connectorProfileBound = expectedFingerprint
        ? Boolean(profile.connectorServerFingerprint && profile.connectorServerFingerprint === expectedFingerprint)
        : profile.connectorInstalled;
      const checkedAtMs = Date.parse(profile.connectorCheckedAt);
      const connectorVerificationRequired = !['connected', 'disconnected', 'missing'].includes(profile.connectorVerificationState || '')
        || !Number.isFinite(checkedAtMs)
        || checkedAtMs > Date.now();
      const connectorUpdateRequired = Boolean(!connectorVerificationRequired && profile.connectorVerificationState === 'connected' && expectedFingerprint
        && profile.connectorServerFingerprint !== expectedFingerprint);
      const connectorInstalled = profile.connectorInstalled && connectorProfileBound && !connectorVerificationRequired && profile.connectorVerificationState === 'connected';
      const connectorMessage = connectorVerificationRequired
        ? (profile.connectorVerificationState === 'unknown' && !profile.connectorInstalled && profile.connectorMessage
          ? profile.connectorMessage : "Chưa xác minh lại CodexPro trong ChatGPT.")
        : connectorUpdateRequired
        ? observedCodexProToolActivity
          ? "CodexPro đang gọi tool qua connector cũ chưa gắn đúng profile. Cần cập nhật connector."
          : "CodexPro hiện có đang dùng URL cũ, chưa gắn đúng profile Chrome."
        : profile.connectorMessage;
      return {
      profile_id: profile.id,
      email: profile.email,
      label: profile.label,
      extension_version: profile.extensionVersion,
      connector_installed: connectorInstalled,
      connector_message: connectorMessage,
      connector_checked_at: profile.connectorCheckedAt,
      connector_verification_required: connectorVerificationRequired,
      connector_verification_state: connectorVerificationRequired ? 'unknown' : profile.connectorVerificationState,
      worker_id: profile.connectorWorkerId,
      headless: profile.headless,
      source_profile_id: profile.sourceProfileId,
      lifecycle_event: profile.lifecycleEvent,
      lifecycle_events: profile.lifecycleEvents.slice(-20),
      connector_profile_bound: connectorProfileBound,
      connector_update_required: connectorUpdateRequired,
      active: connected && state.activeProfileId === profile.id,
      connected,
      last_seen: new Date(profile.lastSeen).toISOString(),
      tab_count: profile.tabs.length,
      chatgpt_tab_count: chatgptTabs.length,
      busy_request_count: busyRequestCount,
      busy_since: busySince,
      activity,
      active_chat_title: activeChatTitle,
      current_workspace_root: profile.workspaceRoot,
      current_task_id: profileTaskIds.get(profile.id) || "",
      current_task_title: profileTaskTitles.get(profile.id) || "",
      current_task_conversation_id: profileTaskConversationIds.get(profile.id) || "",
      chatgpt_tabs: chatgptTabSummaries,
      conversation_tabs: conversationSummaries,
      recent_conversations: recentConversations
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || b.last_seen.localeCompare(a.last_seen));
}

export function subscribeBrowserExtensionProfiles(listener: (profiles: ExtensionProfileSummary[]) => void): () => void {
  const state = ensureBrowserExtensionBridge();
  state.profileListeners.add(listener);
  return () => state.profileListeners.delete(listener);
}

export function subscribeBrowserExtensionStreams(listener: (updates: BrowserExtensionStreamUpdate[]) => void): () => void {
  const state = ensureBrowserExtensionBridge();
  state.streamListeners.add(listener);
  return () => state.streamListeners.delete(listener);
}

export function setBrowserExtensionProfileWorkspace(profileId: string, root: string): void {
  const id = String(profileId || "").trim();
  const workspaceRoot = String(root || "").trim();
  if (!id) return;
  if (workspaceRoot) profileWorkspaceRoots.set(id, workspaceRoot);
  else profileWorkspaceRoots.delete(id);
  const profile = singleton?.profiles.get(id);
  if (profile) profile.workspaceRoot = workspaceRoot;
  if (singleton) scheduleProfileNotification(singleton);
}

export function setBrowserExtensionProfileTask(profileId: string, taskId: string, title: string): void {
  const id = String(profileId || "").trim();
  const normalizedTaskId = String(taskId || "").trim();
  const taskTitle = String(title || "").trim();
  if (!id) return;
  const pendingTask = profilePendingTasks.get(id);
  const pendingCleared = Boolean(pendingTask && (!normalizedTaskId || pendingTask.taskId === normalizedTaskId));
  if (pendingCleared) profilePendingTasks.delete(id);
  const previousTaskId = profileTaskIds.get(id) || "";
  const inferredConversationId = normalizedTaskId ? inferProfileTaskConversationId(id) : "";
  const nextConversationId = normalizedTaskId === previousTaskId
    ? inferredConversationId || profileTaskConversationIds.get(id) || ""
    : inferredConversationId;
  const changed = previousTaskId !== normalizedTaskId
    || profileTaskTitles.get(id) !== taskTitle
    || profileTaskConversationIds.get(id) !== nextConversationId;
  if (!changed) {
    if (pendingCleared) persistBrowserProfileTasks();
    if (singleton) scheduleProfileNotification(singleton);
    return;
  }
  if (normalizedTaskId) profileTaskIds.set(id, normalizedTaskId);
  else profileTaskIds.delete(id);
  if (nextConversationId) profileTaskConversationIds.set(id, nextConversationId);
  else profileTaskConversationIds.delete(id);
  if (taskTitle) {
    profileTaskTitles.set(id, taskTitle);
    profileTaskUpdatedAt.set(id, new Date().toISOString());
  } else {
    profileTaskTitles.delete(id);
    profileTaskUpdatedAt.delete(id);
  }
  persistBrowserProfileTasks();
  recordBrowserProfileTaskEvent("profile_task_persisted", {
    profile_id: id,
    task_id: normalizedTaskId,
    task_title: taskTitle,
    task_conversation_id: nextConversationId,
    task_conversation_binding_source: normalizedTaskId ? (inferredConversationId ? "live_tab_inference" : nextConversationId ? "persisted_existing" : "unbound") : "cleared",
    task_conversation_candidates: profileTaskConversationCandidateLog(id),
    task_title_source: "ai"
  });
  if (singleton) scheduleProfileNotification(singleton);
}

export function setBrowserExtensionProfilePendingTask(
  profileId: string,
  taskId: string,
  root: string,
  scope: "workspace" | "all_allowed",
  preparedAt = Date.now()
): void {
  const id = String(profileId || "").trim();
  const normalizedTaskId = String(taskId || "").trim();
  if (!id || !normalizedTaskId) return;
  profilePendingTasks.set(id, {
    taskId: normalizedTaskId,
    root: String(root || "").trim(),
    scope,
    preparedAt
  });
  persistBrowserProfileTasks();
}

export function getBrowserExtensionProfilePendingTask(profileId: string): {
  task_id: string;
  root: string;
  scope: "workspace" | "all_allowed";
  prepared_at: string;
  age_ms: number;
} | undefined {
  const pendingTask = profilePendingTasks.get(String(profileId || "").trim());
  if (!pendingTask) return undefined;
  return {
    task_id: pendingTask.taskId,
    root: pendingTask.root,
    scope: pendingTask.scope,
    prepared_at: new Date(pendingTask.preparedAt).toISOString(),
    age_ms: Math.max(0, Date.now() - pendingTask.preparedAt)
  };
}

export function getBrowserExtensionPendingTaskOwner(taskId: string): {
  profile_id: string;
  task_id: string;
  root: string;
  scope: "workspace" | "all_allowed";
  prepared_at: string;
  age_ms: number;
} | undefined {
  const normalizedTaskId = String(taskId || "").trim();
  if (!/^cpt_[a-f0-9]{24}$/.test(normalizedTaskId)) return undefined;
  let owner: {
    profile_id: string;
    task_id: string;
    root: string;
    scope: "workspace" | "all_allowed";
    prepared_at: string;
    age_ms: number;
  } | undefined;
  for (const [profileId, pendingTask] of profilePendingTasks) {
    if (pendingTask.taskId !== normalizedTaskId) continue;
    if (owner) return undefined;
    owner = {
      profile_id: profileId,
      task_id: pendingTask.taskId,
      root: pendingTask.root,
      scope: pendingTask.scope,
      prepared_at: new Date(pendingTask.preparedAt).toISOString(),
      age_ms: Math.max(0, Date.now() - pendingTask.preparedAt)
    };
  }
  return owner;
}

export function setBrowserExtensionProfileWorkspaceBinding(profileId: string, root: string): void {
  const id = String(profileId || "").trim();
  const workspaceRoot = String(root || "").trim();
  if (!id) return;
  if (workspaceRoot) profileWorkspaceBindings.set(id, workspaceRoot);
  else profileWorkspaceBindings.delete(id);
}

export function getBrowserExtensionProfileWorkspaceBinding(profileId: string): string {
  return profileWorkspaceBindings.get(String(profileId || "").trim()) || "";
}

async function runBrowserExtensionCommandCore(
  action: string,
  args: Record<string, unknown>,
  profileId?: string
): Promise<Record<string, any>> {
  const state = ensureBrowserExtensionBridge();
  const selectedId = profileId || state.activeProfileId;
  if (!selectedId) throw new CodexProError("No Chrome profile is ACTIVE. Open the CodexPro Profile Bridge extension in the desired profile and press ACTIVE.");
  const profile = state.profiles.get(selectedId);
  if (!profile) {
    throw new CodexProError("The selected Chrome profile bridge is offline. Open that profile and verify the CodexPro extension is enabled.");
  }
  const waitingForReconnect = Date.now() - profile.lastSeen > PROFILE_TTL_MS;
  const timeoutMs = action === "setup_chatgpt"
    ? SETUP_COMMAND_TIMEOUT_MS
    : action === "check_chatgpt"
      ? CHECK_COMMAND_TIMEOUT_MS
      : action === "send_chat_request"
        ? SEND_COMMAND_TIMEOUT_MS
        : action === "audit_long_running_chat"
          ? LONG_TASK_AUDIT_COMMAND_TIMEOUT_MS
        : action === "get_chat_response"
          ? READ_RESPONSE_TIMEOUT_MS
      : COMMAND_TIMEOUT_MS;
  const createdAtMs = Date.now();
  const command: BridgeCommand = {
    id: randomUUID(),
    action,
    args,
    created_at_ms: createdAtMs,
    expires_at_ms: createdAtMs
      + (waitingForReconnect ? PROFILE_RECONNECT_WAIT_MS : 0)
      + Math.max(1_000, timeoutMs - COMMAND_EXPIRY_HEADROOM_MS)
  };
  let pendingRecord: PendingResult;
  const result = new Promise<Record<string, any>>((resolve, reject) => {
    pendingRecord = { resolve, reject, timeoutMs, waitingForReconnect, dispatchedAtMs: 0 };
    state.pending.set(command.id, pendingRecord);
    armPendingCommandTimeout(
      state,
      profile,
      command,
      waitingForReconnect ? PROFILE_RECONNECT_WAIT_MS : timeoutMs,
      waitingForReconnect
        ? `Chrome profile ${profile.label} did not reconnect to CodexPro in time.`
        : `Timed out waiting for Chrome profile ${profile.label}.`
    );
  });
  if (!deliver(state, profile, command)) profile.queued.push(command);
  const resolved = await result;
  const completedAtMs = Date.now();
  const dispatchedAtMs = pendingRecord!.dispatchedAtMs || completedAtMs;
  return {
    ...resolved,
    bridge_phase_timings: {
      queue_wait_ms: Math.max(0, dispatchedAtMs - createdAtMs),
      extension_roundtrip_ms: Math.max(0, completedAtMs - dispatchedAtMs),
      bridge_total_ms: Math.max(0, completedAtMs - createdAtMs)
    }
  };
}

export async function runBrowserExtensionCommand(
  action: string,
  args: Record<string, unknown>,
  profileId?: string
): Promise<Record<string, any>> {
  const parent = currentRuntimeTraceContext();
  if (!parent) return runBrowserExtensionCommandCore(action, args, profileId);

  const workspace = { id: parent.workspaceId };
  const context = createRuntimeTraceContext(workspace, parent);
  const startedAtMs = Date.now();
  try {
    const result = await runWithRuntimeTraceContext(context, () => runBrowserExtensionCommandCore(action, args, profileId));
    const endedAtMs = Date.now();
    await recordRuntimeTraceSpan(workspace, {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      kind: "browser-extension",
      name: "extension-command",
      action: String(action || "").slice(0, 160),
      source: "browser-extension-bridge",
      status: "ok",
      startedAtMs,
      endedAtMs
    }).catch(() => undefined);
    return result;
  } catch (error) {
    const endedAtMs = Date.now();
    await recordRuntimeTraceSpan(workspace, {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      kind: "browser-extension",
      name: "extension-command",
      action: String(action || "").slice(0, 160),
      source: "browser-extension-bridge",
      status: "error",
      startedAtMs,
      endedAtMs
    }).catch(() => undefined);
    throw error;
  }
}
