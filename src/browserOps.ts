import { CodexProError } from "./guard.js";

export type BrowserControlAction =
  | "status"
  | "list_tabs"
  | "open_tab"
  | "activate_tab"
  | "close_tab"
  | "snapshot"
  | "navigate"
  | "click"
  | "trusted_click"
  | "type"
  | "press"
  | "hover"
  | "scroll"
  | "wait_for"
  | "inspect_element"
  | "evaluate"
  | "batch"
  | "screenshot";

export interface BrowserControlOptions {
  action: BrowserControlAction;
  targetId?: string;
  url?: string;
  selector?: string;
  ref?: string;
  role?: string;
  name?: string;
  placeholder?: string;
  label?: string;
  testId?: string;
  nth?: number;
  text?: string;
  key?: string;
  expression?: string;
  state?: "attached" | "visible" | "hidden" | "detached";
  timeoutMs?: number;
  deltaX?: number;
  deltaY?: number;
  steps?: BrowserControlOptions[];
  maxChars?: number;
  fullPage?: boolean;
  delta?: boolean;
  trace?: boolean;
  traceMs?: number;
}

interface BrowserTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code?: number; message?: string };
}

type CdpEventListener = (event: { method: string; params: Record<string, any>; receivedAt: number }) => void;

export function normalizeBrowserDebugUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid browser debug URL: ${value}`);
  }
  if (parsed.protocol !== "http:") throw new Error("Browser debug URL must use http on loopback.");
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Browser debug URL must use a loopback host.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Browser debug URL cannot contain credentials, query parameters, or a fragment.");
  }
  if (parsed.pathname !== "/") throw new Error("Browser debug URL must be an origin, for example http://127.0.0.1:9223.");
  return parsed.origin;
}

function boundedText(value: unknown, max = 2_000): string {
  return String(value ?? "").slice(0, max);
}

function navigationUrl(value: unknown): string {
  const raw = boundedText(value, 8_000).trim();
  if (!raw) throw new CodexProError("A URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CodexProError(`Invalid browser URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new CodexProError("Browser navigation only allows http and https URLs.");
  }
  return parsed.toString();
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CodexProError(`Controlled Chrome is unavailable (${detail}). Start the CodexPro Browser task and verify port 9223.`);
  }
  if (!response.ok) throw new CodexProError(`Chrome DevTools returned HTTP ${response.status}.`);
  return await response.json() as T;
}

async function fetchOk(url: string, init: RequestInit = {}): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CodexProError(`Controlled Chrome is unavailable (${detail}). Start the CodexPro Browser task and verify port 9223.`);
  }
  if (!response.ok) throw new CodexProError(`Chrome DevTools returned HTTP ${response.status}.`);
}

async function listTargets(debugUrl: string): Promise<BrowserTarget[]> {
  const targets = await fetchJson<BrowserTarget[]>(`${debugUrl}/json/list`);
  return targets
    .filter((target) => target.type === "page" && target.id && target.webSocketDebuggerUrl)
    .map((target) => ({
      id: target.id,
      type: target.type,
      title: boundedText(target.title, 500),
      url: boundedText(target.url, 8_000),
      webSocketDebuggerUrl: target.webSocketDebuggerUrl
    }));
}

async function targetFor(debugUrl: string, targetId?: string): Promise<BrowserTarget> {
  const targets = await listTargets(debugUrl);
  if (!targets.length) throw new CodexProError("Controlled Chrome has no page tabs. Open a tab first.");
  if (!targetId) return targets[0];
  const target = targets.find((item) => item.id === targetId);
  if (!target) throw new CodexProError(`Unknown browser target_id: ${targetId}. Call browser_control action=list_tabs again.`);
  return target;
}

const CDP_SESSION_IDLE_MS = 30_000;
const CDP_CONNECT_TIMEOUT_MS = 2_500;
const CDP_CONNECT_ATTEMPTS = 3;
const CDP_CONNECT_BACKOFF_MS = 120;

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Map<string, Set<CdpEventListener>>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event: MessageEvent) => {
      let message: CdpResponse;
      try {
        message = JSON.parse(String(event.data)) as CdpResponse;
      } catch {
        return;
      }
      if (typeof message.method === "string") {
        const payload = { method: message.method, params: message.params ?? {}, receivedAt: Date.now() };
        for (const listener of [...(this.listeners.get(message.method) ?? []), ...(this.listeners.get("*") ?? [])]) {
          try { listener(payload); } catch {}
        }
        return;
      }
      if (typeof message.id !== "number") return;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new CodexProError(`Chrome DevTools error: ${message.error.message ?? message.error.code ?? "unknown"}`));
      else waiting.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => this.rejectPending(new CodexProError("Chrome DevTools connection closed.")));
    socket.addEventListener("error", () => this.rejectPending(new CodexProError("Chrome DevTools WebSocket failed.")));
  }

  static async connect(webSocketUrl: string, timeoutMs = CDP_CONNECT_TIMEOUT_MS): Promise<CdpClient> {
    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch {}
        reject(error);
      };
      const timer = setTimeout(() => fail(new CodexProError("Timed out connecting to the Chrome tab.", {
        code: "BROWSER_CDP_ATTACH_TIMEOUT",
        details: { timeout_ms: timeoutMs }
      })), Math.max(250, timeoutMs));
      timer.unref?.();
      socket.addEventListener("open", () => {
        if (settled) {
          try { socket.close(); } catch {}
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => fail(new CodexProError("Unable to connect to the Chrome tab.", {
        code: "BROWSER_CDP_ATTACH_FAILED"
      })), { once: true });
    });
    return new CdpClient(socket);
  }

  private rejectPending(error: Error): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  on(method: string, listener: CdpEventListener): () => void {
    const listeners = this.listeners.get(method) ?? new Set<CdpEventListener>();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(method);
    };
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 12_000): Promise<Record<string, any>> {
    if (!this.isOpen()) return Promise.reject(new CodexProError("Chrome DevTools connection is not open."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexProError(`Chrome DevTools timed out running ${method}.`));
      }, Math.max(100, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

const persistentClients = new Map<string, { client: CdpClient; timer: NodeJS.Timeout }>();
const persistentClientPromises = new Map<string, Promise<CdpClient>>();

function dropPersistentClient(webSocketUrl: string): void {
  const existing = persistentClients.get(webSocketUrl);
  if (!existing) return;
  clearTimeout(existing.timer);
  existing.client.close();
  persistentClients.delete(webSocketUrl);
}

function refreshPersistentClient(webSocketUrl: string, client: CdpClient): void {
  const previous = persistentClients.get(webSocketUrl);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => dropPersistentClient(webSocketUrl), CDP_SESSION_IDLE_MS);
  timer.unref?.();
  persistentClients.set(webSocketUrl, { client, timer });
}

async function connectPersistentClient(webSocketUrl: string): Promise<CdpClient> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CDP_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      return await CdpClient.connect(webSocketUrl, CDP_CONNECT_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= CDP_CONNECT_ATTEMPTS) break;
      const delayMs = CDP_CONNECT_BACKOFF_MS * (2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new CodexProError(`Unable to attach to the Chrome tab after ${CDP_CONNECT_ATTEMPTS} attempts.`, {
    code: "BROWSER_CDP_ATTACH_FAILED",
    details: {
      attempts: CDP_CONNECT_ATTEMPTS,
      connect_timeout_ms: CDP_CONNECT_TIMEOUT_MS
    },
    cause: lastError
  });
}

async function persistentClient(webSocketUrl: string): Promise<CdpClient> {
  const existing = persistentClients.get(webSocketUrl);
  if (existing?.client.isOpen()) {
    refreshPersistentClient(webSocketUrl, existing.client);
    return existing.client;
  }
  if (existing) dropPersistentClient(webSocketUrl);

  const inFlight = persistentClientPromises.get(webSocketUrl);
  if (inFlight) return await inFlight;

  const promise = connectPersistentClient(webSocketUrl).then((client) => {
    refreshPersistentClient(webSocketUrl, client);
    return client;
  });
  persistentClientPromises.set(webSocketUrl, promise);
  try {
    return await promise;
  } finally {
    if (persistentClientPromises.get(webSocketUrl) === promise) persistentClientPromises.delete(webSocketUrl);
  }
}

async function withTarget<T>(debugUrl: string, targetId: string | undefined, fn: (client: CdpClient, target: BrowserTarget) => Promise<T>): Promise<T> {
  const target = await targetFor(debugUrl, targetId);
  const webSocketUrl = target.webSocketDebuggerUrl!;
  const client = await persistentClient(webSocketUrl);
  try {
    const result = await fn(client, target);
    refreshPersistentClient(webSocketUrl, client);
    return result;
  } catch (error) {
    dropPersistentClient(webSocketUrl);
    throw error;
  }
}

async function evaluate(client: CdpClient, expression: string, timeoutMs = 12_000): Promise<any> {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }, timeoutMs);
  if (response.exceptionDetails) {
    throw new CodexProError(`Browser page script failed: ${response.exceptionDetails.text ?? "unknown error"}`);
  }
  return response.result?.value;
}

function keyCode(key: string): number {
  const codes: Record<string, number> = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32
  };
  return codes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
}

function locatorPayload(options: BrowserControlOptions): Record<string, unknown> {
  const selector = boundedText(options.selector, 2_000).trim();
  const ref = boundedText(options.ref || (selector.startsWith("@e") ? selector : ""), 80).trim();
  return {
    selector: ref ? "" : selector,
    ref,
    role: boundedText(options.role, 80).trim(),
    name: boundedText(options.name, 500).trim(),
    placeholder: boundedText(options.placeholder, 500).trim(),
    label: boundedText(options.label, 500).trim(),
    testId: boundedText(options.testId, 500).trim(),
    nth: Number.isInteger(options.nth) && Number(options.nth) >= 0 ? Number(options.nth) : 0
  };
}

function hasLocator(options: BrowserControlOptions): boolean {
  const locator = locatorPayload(options);
  return Boolean(locator.selector || locator.ref || locator.role || locator.name || locator.placeholder || locator.label || locator.testId);
}

function locatorExpression(options: BrowserControlOptions): string {
  if (!hasLocator(options)) throw new CodexProError("A selector, semantic ref, or locator is required. Call action=snapshot to obtain @e refs.");
  const locator = JSON.stringify(locatorPayload(options));
  return `(() => {
    const locator=${locator};
    const registry=globalThis.__codexproSemanticRegistry;
    if(locator.ref){const direct=registry?.refs?.get(locator.ref);return direct?.isConnected?direct:null;}
    if(locator.selector){try{return document.querySelector(locator.selector);}catch{return null;}}
    const implicitRole=(el)=>el.getAttribute('role')||({BUTTON:'button',A:'link',INPUT:(el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':'textbox'),TEXTAREA:'textbox',SELECT:'combobox'}[el.tagName]||'');
    const accessibleName=(el)=>String(el.getAttribute('aria-label')||el.getAttribute('title')||el.labels?.[0]?.innerText||el.innerText||el.textContent||el.getAttribute('placeholder')||el.getAttribute('name')||'').trim();
    let candidates=Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"],[data-testid],[data-test]'));
    if(locator.role)candidates=candidates.filter(el=>implicitRole(el).toLowerCase()===locator.role.toLowerCase());
    if(locator.name)candidates=candidates.filter(el=>accessibleName(el).toLowerCase().includes(locator.name.toLowerCase()));
    if(locator.placeholder)candidates=candidates.filter(el=>String(el.getAttribute('placeholder')||'').toLowerCase().includes(locator.placeholder.toLowerCase()));
    if(locator.label)candidates=candidates.filter(el=>String(el.labels?.[0]?.innerText||el.getAttribute('aria-label')||'').toLowerCase().includes(locator.label.toLowerCase()));
    if(locator.testId)candidates=candidates.filter(el=>String(el.getAttribute('data-testid')||el.getAttribute('data-test')||'')===locator.testId);
    return candidates[locator.nth]||null;
  })()`;
}

function semanticSnapshotExpression(maxChars: number, delta: boolean): string {
  return `(() => {
    const registry=globalThis.__codexproSemanticRegistry||(globalThis.__codexproSemanticRegistry={next:1,sequence:0,refs:new Map(),reverse:new WeakMap(),previous:new Map(),previousText:''});
    const visible=(el)=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
    const selectorFor=(el)=>{if(el.id)return '#'+CSS.escape(el.id);for(const attr of ['data-testid','data-test','name','aria-label']){const value=el.getAttribute(attr);if(value){const candidate=el.tagName.toLowerCase()+'['+attr+'='+JSON.stringify(value)+']';try{if(document.querySelectorAll(candidate).length===1)return candidate;}catch{}}}return '';};
    const implicitRole=(el)=>el.getAttribute('role')||({BUTTON:'button',A:'link',INPUT:(el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':'textbox'),TEXTAREA:'textbox',SELECT:'combobox'}[el.tagName]||'');
    const accessibleName=(el)=>String(el.getAttribute('aria-label')||el.getAttribute('title')||el.labels?.[0]?.innerText||el.innerText||el.textContent||el.getAttribute('placeholder')||el.getAttribute('name')||'').trim().slice(0,300);
    const current=new Map();
    const elements=Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"],[data-testid],[data-test]')).filter(visible).slice(0,500).map(el=>{
      let ref=registry.reverse.get(el);if(!ref){ref='@e'+registry.next++;registry.reverse.set(el,ref);}registry.refs.set(ref,el);
      const item={ref,tag:el.tagName.toLowerCase(),role:implicitRole(el),name:accessibleName(el),selector:selectorFor(el),type:el.getAttribute('type'),placeholder:String(el.getAttribute('placeholder')||'').slice(0,300),test_id:String(el.getAttribute('data-testid')||el.getAttribute('data-test')||'').slice(0,300),disabled:Boolean(el.disabled),checked:Boolean(el.checked),aria_pressed:el.getAttribute('aria-pressed'),data_state:el.getAttribute('data-state'),value_length:typeof el.value==='string'?el.value.length:0};
      current.set(ref,JSON.stringify(item));return item;
    });
    for(const [ref,el] of registry.refs){if(!el?.isConnected)registry.refs.delete(ref);}
    const removed_refs=[...registry.previous.keys()].filter(ref=>!current.has(ref));
    const changed_elements=${delta ? "elements.filter(item=>registry.previous.get(item.ref)!==current.get(item.ref))" : "elements"};
    const bodyText=String(document.body?.innerText||'').slice(0,${maxChars});
    const textChanged=bodyText!==registry.previousText;
    registry.previous=current;registry.previousText=bodyText;registry.sequence+=1;
    return {title:document.title,url:location.href,text:${delta ? "(textChanged?bodyText:'')" : "bodyText"},text_changed:textChanged,elements:changed_elements,element_count:elements.length,removed_refs,semantic_refs:true,delta:${delta ? "true" : "false"},snapshot_sequence:registry.sequence};
  })()`;
}

function sanitizedTraceUrl(value: unknown): string {
  const raw = boundedText(value, 8_000);
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "<redacted>");
    return boundedText(url.toString(), 2_000);
  } catch {
    return boundedText(raw.split(/[?#]/, 1)[0], 2_000);
  }
}

function sanitizeTraceEvent(event: { method: string; params: Record<string, any>; receivedAt: number }): Record<string, unknown> | null {
  const { method, params, receivedAt } = event;
  if (method === "Network.requestWillBeSent") return { at: receivedAt, event: method, request_id: boundedText(params.requestId, 160), method: boundedText(params.request?.method, 16), url: sanitizedTraceUrl(params.request?.url), resource_type: boundedText(params.type, 40) };
  if (method === "Network.responseReceived") return { at: receivedAt, event: method, request_id: boundedText(params.requestId, 160), status: Number(params.response?.status) || 0, url: sanitizedTraceUrl(params.response?.url), mime_type: boundedText(params.response?.mimeType, 160), resource_type: boundedText(params.type, 40) };
  if (method === "Network.loadingFinished") return { at: receivedAt, event: method, request_id: boundedText(params.requestId, 160), encoded_bytes: Number(params.encodedDataLength) || 0 };
  if (method === "Network.loadingFailed") return { at: receivedAt, event: method, request_id: boundedText(params.requestId, 160), error: boundedText(params.errorText, 500), canceled: Boolean(params.canceled) };
  if (method === "Runtime.consoleAPICalled") return { at: receivedAt, event: method, level: boundedText(params.type, 40), text: (Array.isArray(params.args) ? params.args.map((item: any) => boundedText(item?.value ?? item?.description, 300)).join(" ") : "").slice(0, 1_000) };
  if (method === "Log.entryAdded") return { at: receivedAt, event: method, level: boundedText(params.entry?.level, 40), source: boundedText(params.entry?.source, 80), text: boundedText(params.entry?.text, 1_000), url: sanitizedTraceUrl(params.entry?.url) };
  if (["Page.lifecycleEvent", "Page.domContentEventFired", "Page.loadEventFired", "Page.frameNavigated"].includes(method)) return { at: receivedAt, event: method, name: boundedText(params.name, 80), url: sanitizedTraceUrl(params.frame?.url) };
  return null;
}

async function withCdpTrace<T extends Record<string, any>>(client: CdpClient, options: BrowserControlOptions, operation: () => Promise<T>): Promise<T> {
  if (!options.trace) return await operation();
  const events: Record<string, unknown>[] = [];
  const startedAt = Date.now();
  const unsubscribe = client.on("*", (event) => {
    const safe = sanitizeTraceEvent(event);
    if (safe && events.length < 500) events.push(safe);
  });
  await Promise.allSettled([client.send("Network.enable"), client.send("Runtime.enable"), client.send("Log.enable"), client.send("Page.enable"), client.send("Page.setLifecycleEventsEnabled", { enabled: true })]);
  try {
    const result = await operation();
    const traceMs = Math.max(0, Math.min(10_000, Math.floor(options.traceMs ?? 750)));
    if (traceMs) await new Promise((resolve) => setTimeout(resolve, traceMs));
    return { ...result, cdp_trace: { started_at: new Date(startedAt).toISOString(), duration_ms: Date.now() - startedAt, event_count: events.length, truncated: events.length >= 500, events } };
  } finally {
    unsubscribe();
  }
}

const targetMutationTails = new Map<string, Promise<void>>();

function mutatesPage(options: BrowserControlOptions): boolean {
  if (options.action === "batch") return (options.steps ?? []).some(mutatesPage);
  return ["navigate", "click", "trusted_click", "type", "press", "hover", "scroll"].includes(options.action);
}

async function serializeTargetMutation<T>(targetId: string, options: BrowserControlOptions, operation: () => Promise<T>): Promise<T> {
  if (!mutatesPage(options)) return await operation();
  const previous = targetMutationTails.get(targetId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  targetMutationTails.set(targetId, tail);
  await previous.catch(() => {});
  try { return await operation(); }
  finally {
    release();
    if (targetMutationTails.get(targetId) === tail) targetMutationTails.delete(targetId);
  }
}

export async function runBrowserControl(debugUrlInput: string, options: BrowserControlOptions): Promise<Record<string, any>> {
  const debugUrl = normalizeBrowserDebugUrl(debugUrlInput);
  const action = options.action;

  if (action === "status") {
    const version = await fetchJson<Record<string, unknown>>(`${debugUrl}/json/version`);
    const tabs = await listTargets(debugUrl);
    return { action, connected: true, debug_url: debugUrl, browser: version.Browser ?? null, protocol_version: version["Protocol-Version"] ?? null, tab_count: tabs.length, persistent_cdp: true, cdp_idle_ms: CDP_SESSION_IDLE_MS };
  }

  if (action === "list_tabs") {
    const tabs = await listTargets(debugUrl);
    return { action, tabs: tabs.map(({ webSocketDebuggerUrl: _, ...target }) => target), tab_count: tabs.length };
  }

  if (action === "open_tab") {
    const url = navigationUrl(options.url);
    const target = await fetchJson<BrowserTarget>(`${debugUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    return { action, target_id: target.id, title: target.title, url: target.url };
  }

  if (action === "activate_tab" || action === "close_tab") {
    if (!options.targetId) throw new CodexProError(`target_id is required for ${action}.`);
    await fetchOk(`${debugUrl}/json/${action === "activate_tab" ? "activate" : "close"}/${encodeURIComponent(options.targetId)}`);
    return { action, target_id: options.targetId, ok: true };
  }

  return await withTarget(debugUrl, options.targetId, async (client, target) => {
    const executeResolved = async (options: BrowserControlOptions): Promise<Record<string, any>> => {
      const action = options.action;
    if (action === "batch") {
      const steps = Array.isArray(options.steps) ? options.steps.slice(0, 50) : [];
      if (!steps.length) throw new CodexProError("batch requires at least one step.");
      const results: Record<string, any>[] = [];
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (!step || step.action === "batch" || ["status", "list_tabs", "open_tab", "activate_tab", "close_tab"].includes(step.action)) {
          throw new CodexProError(`Unsupported batch step at index ${index}: ${step?.action ?? "missing"}`);
        }
        results.push(await executeResolved({ ...step, targetId: target.id, trace: false }));
      }
      return { action, target_id: target.id, ok: true, step_count: results.length, results };
    }

    if (action === "snapshot") {
      const maxChars = Math.max(500, Math.min(50_000, Math.floor(options.maxChars ?? 20_000)));
      const snapshot = await evaluate(client, semanticSnapshotExpression(maxChars, Boolean(options.delta)));
      return { action, target_id: target.id, ...snapshot };
    }

    if (action === "navigate") {
      const url = navigationUrl(options.url);
      await client.send("Page.enable");
      await client.send("Page.navigate", { url });
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (await evaluate(client, "document.readyState === 'complete'")) break;
      }
      return { action, target_id: target.id, url: await evaluate(client, "location.href"), title: await evaluate(client, "document.title") };
    }

    if (action === "click" || action === "trusted_click") {
      const element = locatorExpression(options);
      const located = await evaluate(client, `(() => { const el = ${element}; if (!el) return {ok:false,error:'Element not found'}; el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {ok:true,x:r.left+r.width/2,y:r.top+r.height/2,tag:el.tagName.toLowerCase(),text:(el.innerText||el.getAttribute('aria-label')||'').slice(0,300)}; })()`);
      if (!located?.ok) throw new CodexProError(`Browser ${action} failed: ${located?.error ?? "unknown error"}`);
      if (action === "click") {
        const result = await evaluate(client, `(() => { const el = ${element}; if (!el) return {ok:false,error:'Element not found'}; el.click(); return {ok:true}; })()`);
        if (!result?.ok) throw new CodexProError(`Browser click failed: ${result?.error ?? "unknown error"}`);
      } else {
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: located.x, y: located.y, button: "none" });
        await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: located.x, y: located.y, button: "left", buttons: 1, clickCount: 1 });
        await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: located.x, y: located.y, button: "left", buttons: 0, clickCount: 1 });
      }
      return { action, target_id: target.id, selector: options.selector, ref: options.ref || (String(options.selector || "").startsWith("@e") ? options.selector : undefined), ok: true, tag: located.tag, text: located.text };
    }

    if (action === "type") {
      const element = locatorExpression(options);
      const text = JSON.stringify(boundedText(options.text, 100_000));
      const result = await evaluate(client, `(() => {
        const el = ${element}; if (!el) return {ok:false,error:'Element not found'};
        el.scrollIntoView({block:'center',inline:'center'}); el.focus(); const value = ${text};
        if (el.isContentEditable) { el.textContent = value; }
        else { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto,'value')?.set; if (setter) setter.call(el,value); else el.value=value; }
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value})); el.dispatchEvent(new Event('change',{bubbles:true}));
        return {ok:true,tag:el.tagName.toLowerCase(),length:value.length};
      })()`);
      if (!result?.ok) throw new CodexProError(`Browser type failed: ${result?.error ?? "unknown error"}`);
      return { action, target_id: target.id, selector: options.selector, ...result };
    }

    if (action === "press") {
      const key = boundedText(options.key, 40).trim();
      if (!key) throw new CodexProError("A key is required.");
      const code = keyCode(key);
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      return { action, target_id: target.id, key, ok: true };
    }

    if (action === "hover") {
      const element = locatorExpression(options);
      const point = await evaluate(client, `(() => { const el=${element}; if(!el)return null; el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,tag:el.tagName.toLowerCase()}; })()`);
      if (!point) throw new CodexProError("Browser hover failed: Element not found");
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
      return { action, target_id: target.id, selector: options.selector, ok: true, tag: point.tag };
    }

    if (action === "scroll") {
      let point = await evaluate(client, "({x:innerWidth/2,y:innerHeight/2})");
      if (hasLocator(options)) {
        const element = locatorExpression(options);
        point = await evaluate(client, `(() => { const el=${element}; if(!el)return null; el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
        if (!point) throw new CodexProError("Browser scroll failed: Element not found");
      }
      const deltaX = Number.isFinite(options.deltaX) ? Number(options.deltaX) : 0;
      const deltaY = Number.isFinite(options.deltaY) ? Number(options.deltaY) : 600;
      await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY });
      return { action, target_id: target.id, selector: options.selector, delta_x: deltaX, delta_y: deltaY, ok: true };
    }

    if (action === "wait_for") {
      const state = options.state ?? "visible";
      const timeoutMs = Math.max(100, Math.min(60_000, Math.floor(options.timeoutMs ?? 10_000)));
      const wantedText = options.text ? JSON.stringify(boundedText(options.text, 10_000)) : "null";
      const element = hasLocator(options) ? locatorExpression(options) : "document.body";
      const startedAt = Date.now();
      const last = await evaluate(client, `new Promise((resolve) => {
        const wanted=${wantedText},state=${JSON.stringify(state)},deadline=Date.now()+${timeoutMs};
        const check=()=>{const el=${element};const attached=Boolean(el);const visible=Boolean(el&&(()=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';})());const haystack=el?(el.innerText||el.textContent||''):(document.body?.innerText||'');const textMatched=!wanted||String(haystack).includes(wanted);const matched=state==='attached'?attached&&textMatched:state==='visible'?visible&&textMatched:state==='hidden'?!visible:state==='detached'?!attached:false;if(matched){cleanup();resolve({matched,attached,visible,text_matched:textMatched});return true;}return false;};
        let timer;const observer=new MutationObserver(()=>check());const cleanup=()=>{observer.disconnect();clearTimeout(timer);};if(check())return;observer.observe(document.documentElement||document,{subtree:true,childList:true,attributes:true,characterData:true});timer=setTimeout(()=>{cleanup();resolve({matched:false,timed_out:true});},Math.max(0,deadline-Date.now()));
      })`, timeoutMs + 2_000);
      if (!last?.matched) throw new CodexProError(`Browser wait_for timed out after ${timeoutMs} ms.`);
      return { action, target_id: target.id, selector: options.selector, ref: options.ref, text: options.text, state, waited_ms: Date.now() - startedAt, ...last };
    }

    if (action === "inspect_element") {
      const element = locatorExpression(options);
      const result = await evaluate(client, `(() => { const el=${element}; if(!el)return {ok:false,error:'Element not found'}; const r=el.getBoundingClientRect(),s=getComputedStyle(el); return {ok:true,tag:el.tagName.toLowerCase(),text:(el.innerText||el.textContent||'').trim().slice(0,1000),value:typeof el.value==='string'?el.value.slice(0,1000):'',disabled:Boolean(el.disabled),checked:Boolean(el.checked),rect:{x:r.x,y:r.y,width:r.width,height:r.height},style:{display:s.display,visibility:s.visibility,opacity:s.opacity,pointerEvents:s.pointerEvents,position:s.position,zIndex:s.zIndex},attributes:Object.fromEntries(Array.from(el.attributes||[]).slice(0,40).map(a=>[a.name,String(a.value).slice(0,500)]))}; })()`);
      if (!result?.ok) throw new CodexProError(`Browser inspect_element failed: ${result?.error ?? "unknown error"}`);
      return { action, target_id: target.id, selector: options.selector, ...result };
    }

    if (action === "evaluate") {
      const expression = boundedText(options.expression, 100_000).trim();
      if (!expression) throw new CodexProError("A JavaScript expression is required.");
      const value = await evaluate(client, expression);
      return { action, target_id: target.id, value };
    }

    if (action === "screenshot") {
      await client.send("Page.enable");
      const capture = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: Boolean(options.fullPage) });
      return { action, target_id: target.id, mime_type: "image/png", image_base64: capture.data };
    }

      throw new CodexProError(`Unsupported browser action: ${action}`);
    };
    return await serializeTargetMutation(target.id, options, () => withCdpTrace(client, options, () => executeResolved(options)));
  });
}
