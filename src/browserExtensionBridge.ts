import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { CodexProError } from "./guard.js";

const BRIDGE_HOST = "127.0.0.1";
export const BROWSER_EXTENSION_BRIDGE_PORT = 9224;
const PROFILE_TTL_MS = 45_000;
const COMMAND_TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 12 * 1024 * 1024;

export interface ExtensionProfileSummary {
  profile_id: string;
  email: string;
  label: string;
  active: boolean;
  connected: boolean;
  last_seen: string;
  tab_count: number;
}

interface ExtensionProfile {
  id: string;
  email: string;
  label: string;
  lastSeen: number;
  tabs: unknown[];
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
}

let singleton: BridgeState | undefined;

function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function extensionOrigin(req: IncomingMessage): string | undefined {
  const origin = String(req.headers.origin ?? "");
  return origin.startsWith("chrome-extension://") ? origin : undefined;
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
    lastSeen: 0,
    tabs: [],
    queued: []
  };
  profile.email = String(source.email ?? profile.email ?? "").trim().slice(0, 320);
  profile.label = String(source.label ?? profile.label ?? profile.email ?? `Chrome ${id.slice(0, 8)}`).trim().slice(0, 320);
  profile.lastSeen = Date.now();
  if (Array.isArray(body.tabs)) profile.tabs = body.tabs.slice(0, 500);
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

export function ensureBrowserExtensionBridge(): BridgeState {
  if (singleton) return singleton;
  const state = {} as BridgeState;
  state.profiles = new Map();
  state.pending = new Map();
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
    .map((profile) => ({
      profile_id: profile.id,
      email: profile.email,
      label: profile.label,
      active: state.activeProfileId === profile.id,
      connected: now - profile.lastSeen <= PROFILE_TTL_MS,
      last_seen: new Date(profile.lastSeen).toISOString(),
      tab_count: profile.tabs.length
    }))
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
    const timer = setTimeout(() => {
      state.pending.delete(command.id);
      reject(new CodexProError(`Timed out waiting for Chrome profile ${profile.label}.`));
    }, COMMAND_TIMEOUT_MS);
    state.pending.set(command.id, { resolve, reject, timer });
  });
  if (!deliver(state, profile, command)) profile.queued.push(command);
  return await result;
}
