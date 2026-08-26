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
const SEND_COMMAND_TIMEOUT_MS = 120_000;
const READ_RESPONSE_TIMEOUT_MS = 75_000;
const MAX_BODY_BYTES = 12 * 1024 * 1024;

export interface ExtensionProfileSummary {
  profile_id: string;
  email: string;
  label: string;
  extension_version: string;
  connector_installed: boolean;
  connector_message: string;
  connector_checked_at: string;
  active: boolean;
  connected: boolean;
  last_seen: string;
  tab_count: number;
  chatgpt_tab_count: number;
  busy_request_count: number;
  busy_since: string;
  activity: "working" | "idle" | "no_chatgpt";
  active_chat_title: string;
  conversation_tabs: Array<{
    id: number;
    title: string;
    url: string;
    active: boolean;
    busy: boolean;
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
}

export interface BrowserExtensionBridgeOptions {
  connectorInfo?: () => BrowserExtensionConnectorInfo;
}

interface ExtensionProfile {
  id: string;
  email: string;
  label: string;
  extensionVersion: string;
  connectorInstalled: boolean;
  connectorMessage: string;
  connectorCheckedAt: string;
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
  connectorInfo?: () => BrowserExtensionConnectorInfo;
}

let singleton: BridgeState | undefined;

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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
    lastSeen: 0,
    tabs: [],
    recentConversations: [],
    queued: []
  };
  profile.email = String(source.email ?? profile.email ?? "").trim().slice(0, 320);
  profile.label = String(source.label ?? profile.label ?? profile.email ?? `Chrome ${id.slice(0, 8)}`).trim().slice(0, 320);
  profile.extensionVersion = String(source.version ?? profile.extensionVersion ?? "").trim().slice(0, 32);
  if (source.connector_install && typeof source.connector_install === "object") {
    profile.connectorInstalled = source.connector_install.ok === true;
    profile.connectorMessage = String(source.connector_install.message ?? "").trim().slice(0, 500);
    profile.connectorCheckedAt = String(source.connector_install.at ?? "").trim().slice(0, 64);
  }
  profile.lastSeen = Date.now();
  if (Array.isArray(body.tabs)) profile.tabs = body.tabs.slice(0, 500);
  if (Array.isArray(body.recent_conversations)) profile.recentConversations = body.recent_conversations.slice(0, 3);
  state.profiles.set(id, profile);
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

function syncWaiters(state: BridgeState): void {
  for (const profile of state.profiles.values()) deliver(state, profile, null);
}

async function handleRequest(state: BridgeState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(req, res);
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
    const connector = state.connectorInfo();
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
    if (profile.queued.length) {
      sendJson(req, res, 200, { command: profile.queued.shift(), active_profile_id: state.activeProfileId ?? null });
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
      if (body.error) pending.reject(new CodexProError(`Chrome extension action failed: ${String(body.error).slice(0, 2_000)}`));
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
      const busyRequestCount = busyTabs.reduce((total, tab) => total + Math.max(1, Number(tab.busy_request_count) || 0), 0);
      const busySince = busyTabs
        .map((tab) => String(tab.busy_since ?? ""))
        .filter(Boolean)
        .sort()[0] ?? "";
      const activity: ExtensionProfileSummary["activity"] = busyRequestCount > 0 ? "working" : chatgptTabs.length ? "idle" : "no_chatgpt";
      const activeChatTitle = String((activeConversation ?? conversationTabs[0])?.title ?? "").trim().slice(0, 300);
      const conversationSummaries = conversationTabs
        .map((tab) => ({
          id: Number(tab.id),
          title: String(tab.title ?? "Đoạn chat chưa có tiêu đề").trim().slice(0, 300),
          url: String(tab.url ?? "").trim().slice(0, 2000),
          active: tab.active === true,
          busy: tab.busy === true
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
      return {
      profile_id: profile.id,
      email: profile.email,
      label: profile.label,
      extension_version: profile.extensionVersion,
      connector_installed: profile.connectorInstalled,
      connector_message: profile.connectorMessage,
      connector_checked_at: profile.connectorCheckedAt,
      active: state.activeProfileId === profile.id,
      connected: now - profile.lastSeen <= PROFILE_TTL_MS,
      last_seen: new Date(profile.lastSeen).toISOString(),
      tab_count: profile.tabs.length,
      chatgpt_tab_count: chatgptTabs.length,
      busy_request_count: busyRequestCount,
      busy_since: busySince,
      activity,
      active_chat_title: activeChatTitle,
      conversation_tabs: conversationSummaries,
      recent_conversations: recentConversations
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || b.last_seen.localeCompare(a.last_seen));
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
  const command: BridgeCommand = { id: randomUUID(), action, args };
  const result = new Promise<Record<string, any>>((resolve, reject) => {
    const timeoutMs = action === "setup_chatgpt"
      ? SETUP_COMMAND_TIMEOUT_MS
      : action === "check_chatgpt"
        ? CHECK_COMMAND_TIMEOUT_MS
        : action === "send_chat_request"
          ? SEND_COMMAND_TIMEOUT_MS
          : action === "get_chat_response"
            ? READ_RESPONSE_TIMEOUT_MS
        : COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      state.pending.delete(command.id);
      reject(new CodexProError(`Timed out waiting for Chrome profile ${profile.label}.`));
    }, timeoutMs);
    state.pending.set(command.id, { resolve, reject, timer });
  });
  if (!deliver(state, profile, command)) profile.queued.push(command);
  return await result;
}
