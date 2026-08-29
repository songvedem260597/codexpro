import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { CodexProError } from "./guard.js";

const BRIDGE_HOST = "127.0.0.1";
const CODEXPRO_EXTENSION_ORIGIN = "chrome-extension://gndipignbnipohooclcbhjliikamjlpl";
export const BROWSER_EXTENSION_BRIDGE_PORT = 9224;
const PROFILE_TTL_MS = 45_000;
const COMMAND_TIMEOUT_MS = 25_000;
const CHECK_COMMAND_TIMEOUT_MS = 60_000;
const SETUP_COMMAND_TIMEOUT_MS = 300_000;
const SEND_COMMAND_TIMEOUT_MS = 180_000;
const COMMAND_EXPIRY_HEADROOM_MS = 5_000;
const READ_RESPONSE_TIMEOUT_MS = 75_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface ExtensionProfileSummary {
  profile_id: string;
  email: string;
  label: string;
  extension_version: string;
  connector_installed: boolean;
  connector_message: string;
  connector_checked_at: string;
  worker_id: string;
  headless: boolean;
  source_profile_id: string;
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
  conversation_tabs: Array<{
    id: number;
    title: string;
    url: string;
    active: boolean;
    busy: boolean;
    settling: boolean;
    network_state: string;
    network_source: string;
    network_last_started_at: string;
    network_last_completed_at: string;
    network_status_code: number;
    network_error: string;
    network_duration_ms: number;
  }>;
  recent_conversations: Array<{
    id: string;
    title: string;
    url: string;
    updated_at: number;
    open: boolean;
    active: boolean;
  }>;
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
  email: string;
  label: string;
  extensionVersion: string;
  connectorInstalled: boolean;
  connectorMessage: string;
  connectorCheckedAt: string;
  workspaceRoot: string;
  connectorWorkerId: string;
  headless: boolean;
  sourceProfileId: string;
  lastSeen: number;
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
  timer: NodeJS.Timeout;
}

interface BridgeState {
  server: http.Server;
  profiles: Map<string, ExtensionProfile>;
  pending: Map<string, PendingResult>;
  activeProfileId?: string;
  connectorInfo?: (profileId: string) => BrowserExtensionConnectorInfo;
  profileListeners: Set<(profiles: ExtensionProfileSummary[]) => void>;
  profileNotifyTimer?: NodeJS.Timeout;
}

const profileWorkspaceRoots = new Map<string, string>();
const profileWorkspaceBindings = new Map<string, string>();
let singleton: BridgeState | undefined;

function scheduleProfileNotification(state: BridgeState): void {
  if (state.profileNotifyTimer) return;
  state.profileNotifyTimer = setTimeout(() => {
    state.profileNotifyTimer = undefined;
    const profiles = listBrowserExtensionProfiles();
    for (const listener of state.profileListeners) {
      try { listener(profiles); } catch {}
    }
  }, 25);
  state.profileNotifyTimer.unref?.();
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
    email: "",
    label: "",
    extensionVersion: "",
    connectorInstalled: false,
    connectorMessage: "",
    connectorCheckedAt: "",
    workspaceRoot: profileWorkspaceRoots.get(id) || "",
    connectorWorkerId: "",
    headless: false,
    sourceProfileId: "",
    lastSeen: 0,
    tabs: [],
    recentConversations: [],
    queued: []
  };
  profile.email = String(source.email ?? profile.email ?? "").trim().slice(0, 320);
  profile.label = String(source.label ?? profile.label ?? profile.email ?? `Chrome ${id.slice(0, 8)}`).trim().slice(0, 320);
  profile.extensionVersion = String(source.version ?? profile.extensionVersion ?? "").trim().slice(0, 32);
  profile.headless = source.headless === true;
  profile.sourceProfileId = String(source.source_profile_id ?? profile.sourceProfileId ?? "").trim().slice(0, 160);
  if (source.connector_install && typeof source.connector_install === "object") {
    profile.connectorInstalled = source.connector_install.ok === true;
    profile.connectorMessage = String(source.connector_install.message ?? "").trim().slice(0, 500);
    profile.connectorCheckedAt = String(source.connector_install.at ?? "").trim().slice(0, 64);
    profile.connectorWorkerId = String(source.connector_install.worker_id ?? profile.connectorWorkerId ?? "").trim().slice(0, 80);
  }
  profile.lastSeen = Date.now();
  if (Array.isArray(body.tabs)) profile.tabs = body.tabs.slice(0, 500);
  if (Array.isArray(body.recent_conversations)) profile.recentConversations = body.recent_conversations.slice(0, 3);
  state.profiles.set(id, profile);
  scheduleProfileNotification(state);
  return profile;
}

function clearWaiter(profile: ExtensionProfile): void {
  if (profile.waiterTimer) clearTimeout(profile.waiterTimer);
  profile.waiterTimer = undefined;
  profile.waiter = undefined;
}

function deliver(state: BridgeState, profile: ExtensionProfile, command: BridgeCommand | null): boolean {
  if (!profile.waiter) return false;
  const response = profile.waiter;
  clearWaiter(profile);
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify({ command, active_profile_id: state.activeProfileId ?? null }));
  return true;
}

function nextLiveCommand(state: BridgeState, profile: ExtensionProfile): BridgeCommand | null {
  while(profile.queued.length){
    const command=profile.queued.shift()!;
    if(command.expires_at_ms<=Date.now()||!state.pending.has(command.id))continue;
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
      clearTimeout(pending.timer);
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
  state.connectorInfo = options.connectorInfo;
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
  return [...state.profiles.values()]
    .map((profile) => {
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
      const conversationSummaries = conversationTabs
        .map((tab) => ({
          id: Number(tab.id),
          title: String(tab.title ?? "Đoạn chat chưa có tiêu đề").trim().slice(0, 300),
          url: String(tab.url ?? "").trim().slice(0, 2000),
          active: tab.active === true,
          busy: tab.busy === true,
          settling: tab.settling === true,
          network_state: tab.network_state === "generating" ? "generating" : tab.network_state === "completed" ? "completed" : tab.network_state === "failed" ? "failed" : "idle",
          network_source: String(tab.network_source ?? "").trim().slice(0, 32),
          network_generation_endpoint: String(tab.network_generation_endpoint ?? "").trim().slice(0, 500),
          network_last_started_at: String(tab.network_last_started_at ?? "").trim().slice(0, 64),
          network_last_completed_at: String(tab.network_last_completed_at ?? "").trim().slice(0, 64),
          network_status_code: Number(tab.network_status_code) || 0,
          network_error: String(tab.network_error ?? "").trim().slice(0, 500),
          network_duration_ms: Math.max(0, Number(tab.network_duration_ms) || 0),
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
            active: openTab?.active === true
          };
        })
        .filter((conversation) => /^[A-Za-z0-9-]{8,160}$/.test(conversation.id))
        .slice(0, 3);
      const activeChatTitle = String(recentConversations.find((conversation) => conversation.id === activeConversationId)?.title ?? titleConversation?.title ?? "").trim().slice(0, 300);
      return {
      profile_id: profile.id,
      email: profile.email,
      label: profile.label,
      extension_version: profile.extensionVersion,
      connector_installed: profile.connectorInstalled,
      connector_message: profile.connectorMessage,
      connector_checked_at: profile.connectorCheckedAt,
      worker_id: profile.connectorWorkerId,
      headless: profile.headless,
      source_profile_id: profile.sourceProfileId,
      active: state.activeProfileId === profile.id,
      connected: now - profile.lastSeen <= PROFILE_TTL_MS,
      last_seen: new Date(profile.lastSeen).toISOString(),
      tab_count: profile.tabs.length,
      chatgpt_tab_count: chatgptTabs.length,
      busy_request_count: busyRequestCount,
      busy_since: busySince,
      activity,
      active_chat_title: activeChatTitle,
      current_workspace_root: profile.workspaceRoot,
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

export async function runBrowserExtensionCommand(
  action: string,
  args: Record<string, unknown>,
  profileId?: string
): Promise<Record<string, any>> {
  const state = ensureBrowserExtensionBridge();
  const selectedId = profileId || state.activeProfileId;
  if (!selectedId) throw new CodexProError("No Chrome profile is ACTIVE. Open the CodexPro Profile Bridge extension in the desired profile and press ACTIVE.");
  const profile = state.profiles.get(selectedId);
  if (!profile || Date.now() - profile.lastSeen > PROFILE_TTL_MS) {
    throw new CodexProError("The selected Chrome profile bridge is offline. Open that profile and verify the CodexPro extension is enabled.");
  }
  const timeoutMs = action === "setup_chatgpt"
    ? SETUP_COMMAND_TIMEOUT_MS
    : action === "check_chatgpt"
      ? CHECK_COMMAND_TIMEOUT_MS
      : action === "send_chat_request"
        ? SEND_COMMAND_TIMEOUT_MS
        : action === "get_chat_response"
          ? READ_RESPONSE_TIMEOUT_MS
      : COMMAND_TIMEOUT_MS;
  const createdAtMs = Date.now();
  const command: BridgeCommand = {
    id: randomUUID(),
    action,
    args,
    created_at_ms: createdAtMs,
    expires_at_ms: createdAtMs + Math.max(1_000, timeoutMs - COMMAND_EXPIRY_HEADROOM_MS)
  };
  const result = new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(command.id);
      profile.queued = profile.queued.filter((queued) => queued.id !== command.id);
      reject(new CodexProError(`Timed out waiting for Chrome profile ${profile.label}.`));
    }, timeoutMs);
    state.pending.set(command.id, { resolve, reject, timer });
  });
  if (!deliver(state, profile, command)) profile.queued.push(command);
  return await result;
}
