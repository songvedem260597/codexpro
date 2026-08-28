import { lookup } from "node:dns/promises";
import net from "node:net";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
  type Route
} from "playwright";
import { CodexProError } from "./guard.js";

const BROWSER_REF_ATTRIBUTE = "data-codexpro-ref";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CONSOLE_ENTRIES = 100;
const BROWSER_IDLE_CLOSE_MS = 10 * 60 * 1_000;

export type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

export interface BrowserElementSnapshot {
  ref: string;
  tag: string;
  role: string | null;
  type: string | null;
  name: string | null;
  text: string;
  placeholder: string | null;
  href: string | null;
  disabled: boolean;
}

export interface BrowserSnapshot {
  title: string;
  url: string;
  text: string;
  elements: BrowserElementSnapshot[];
  console: Array<{ level: string; text: string }>;
  truncated: boolean;
}

export interface BrowserOpenResult extends BrowserSnapshot {
  status: number | null;
  statusText: string | null;
}

function compactText(value: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };
  return { text: `${normalized.slice(0, maxChars)}\n...[browser text truncated]`, truncated: true };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "localhost.localdomain") return true;
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized === "0.0.0.0") return true;
  return normalized.startsWith("127.");
}

function ipv6Bytes(address: string): number[] | undefined {
  let normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const dotted = normalized.slice(lastColon + 1);
    if (!net.isIPv4(dotted)) return undefined;
    const octets = dotted.split(".").map(Number);
    normalized = `${normalized.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function mappedIpv4(bytes: number[]): string {
  return bytes.join(".");
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    return (
      parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      parts[0] >= 224
    );
  }
  if (net.isIPv6(address)) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return true;
    const allZero = bytes.every((byte) => byte === 0);
    const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
    const uniqueLocal = (bytes[0] & 0xfe) === 0xfc;
    const linkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
    const multicast = bytes[0] === 0xff;
    if (allZero || loopback || uniqueLocal || linkLocal || multicast) return true;

    const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    const ipv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0);
    if (ipv4Mapped || ipv4Compatible) return isPrivateAddress(mappedIpv4(bytes.slice(12)));

    const wellKnownNat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((byte) => byte === 0);
    const localNat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes[4] === 0x00 && bytes[5] === 0x01;
    if (wellKnownNat64 || localNat64) return isPrivateAddress(mappedIpv4(bytes.slice(12)));

    const sixToFour = bytes[0] === 0x20 && bytes[1] === 0x02;
    if (sixToFour) return isPrivateAddress(mappedIpv4(bytes.slice(2, 6)));
    return false;
  }
  return true;
}

async function assertAllowedNetworkUrl(rawUrl: string, navigation: boolean): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CodexProError(`Invalid browser URL: ${rawUrl}`);
  }

  if (!navigation && ["about:", "blob:", "data:"].includes(parsed.protocol)) return parsed;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CodexProError("Browser URLs must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new CodexProError("Browser URLs containing embedded credentials are blocked.");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "metadata.google.internal" || hostname.endsWith(".internal")) {
    throw new CodexProError(`Browser access to internal hostname ${hostname} is blocked.`);
  }
  if (isLoopbackHostname(hostname)) return parsed;

  const literalFamily = net.isIP(hostname);
  if (literalFamily && isPrivateAddress(hostname)) {
    throw new CodexProError(`Browser access to private network address ${hostname} is blocked.`);
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new CodexProError(`Browser could not resolve hostname ${hostname}.`);
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new CodexProError(`Browser access to hostname ${hostname} is blocked because it resolves to a private network address.`);
  }
  return parsed;
}

function timeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(180_000, Math.floor(value)));
}

function safeConsoleText(message: ConsoleMessage): { level: string; text: string } {
  return { level: message.type(), text: message.text().slice(0, 4_000) };
}

export class BrowserAutomation {
  private runtime: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private consoleEntries: Array<{ level: string; text: string }> = [];
  private blockedRequestUrl: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | undefined;

  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (!this.runtime && !this.context && !this.page) return;
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, BROWSER_IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      this.touchIdleTimer();
      release();
    }
  }

  private recordConsole(entry: { level: string; text: string }): void {
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
      this.consoleEntries.splice(0, this.consoleEntries.length - MAX_CONSOLE_ENTRIES);
    }
  }

  private async guardRoute(route: Route, request: Request): Promise<void> {
    try {
      await assertAllowedNetworkUrl(request.url(), false);
      await route.continue();
    } catch {
      this.blockedRequestUrl = request.url();
      await route.abort("blockedbyclient");
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.runtime || !this.runtime.isConnected()) {
      try {
        this.runtime = await chromium.launch({
          headless: process.env.CODEXPRO_BROWSER_HEADLESS !== "0",
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
          args: ["--disable-dev-shm-usage"]
        });
      } catch (error) {
        throw new CodexProError(
          `Playwright Chromium could not start. Run \"npx playwright install chromium\" on the CodexPro host. ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    this.context = await this.runtime.newContext({
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 }
    });
    await this.context.route("**/*", (route, request) => this.guardRoute(route, request));
    this.page = await this.context.newPage();
    this.page.on("console", (message) => this.recordConsole(safeConsoleText(message)));
    this.page.on("pageerror", (error) => this.recordConsole({ level: "pageerror", text: error.message.slice(0, 4_000) }));
    return this.page;
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new CodexProError("No browser page is open. Call browser_open first.");
    }
    return this.page;
  }

  private async snapshotUnlocked(maxTextChars = 12_000, maxElements = 120): Promise<BrowserSnapshot> {
    const page = this.requirePage();
    const raw = await page.evaluate(
      ({ attribute, maxElements: elementLimit }) => {
        const candidateSelector = [
          "a[href]",
          "button",
          "input:not([type=hidden])",
          "textarea",
          "select",
          "[role=button]",
          "[role=link]",
          "[contenteditable=true]",
          "[tabindex]:not([tabindex='-1'])"
        ].join(",");
        document.querySelectorAll(`[${attribute}]`).forEach((element) => element.removeAttribute(attribute));
        const visible = (element: Element): boolean => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        const elements = Array.from(document.querySelectorAll(candidateSelector))
          .filter(visible)
          .slice(0, elementLimit)
          .map((element, index) => {
            const html = element as HTMLElement;
            const input = element as HTMLInputElement;
            const ref = `e${index + 1}`;
            element.setAttribute(attribute, ref);
            const aria = element.getAttribute("aria-label")?.trim();
            const labelled = element.getAttribute("title")?.trim();
            const text = (html.innerText || input.value || "").replace(/\s+/g, " ").trim().slice(0, 300);
            return {
              ref,
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              type: element.getAttribute("type"),
              name: aria || labelled || element.getAttribute("name"),
              text: input.type === "password" ? "[password field]" : text,
              placeholder: element.getAttribute("placeholder"),
              href: element instanceof HTMLAnchorElement ? element.href : null,
              disabled: "disabled" in input ? Boolean(input.disabled) : element.getAttribute("aria-disabled") === "true"
            };
          });
        return {
          title: document.title,
          url: location.href,
          bodyText: document.body?.innerText ?? "",
          elements
        };
      },
      { attribute: BROWSER_REF_ATTRIBUTE, maxElements }
    );
    const compact = compactText(raw.bodyText, maxTextChars);
    return {
      title: raw.title,
      url: raw.url,
      text: compact.text,
      elements: raw.elements,
      console: this.consoleEntries.slice(-30),
      truncated: compact.truncated || raw.elements.length >= maxElements
    };
  }

  async open(
    rawUrl: string,
    options: { waitUntil?: BrowserWaitUntil; timeoutMs?: number; maxTextChars?: number; maxElements?: number } = {}
  ): Promise<BrowserOpenResult> {
    return this.exclusive(async () => {
      const url = await assertAllowedNetworkUrl(rawUrl, true);
      const page = await this.ensurePage();
      this.blockedRequestUrl = undefined;
      let response;
      try {
        response = await page.goto(url.toString(), {
          waitUntil: options.waitUntil ?? "domcontentloaded",
          timeout: timeoutMs(options.timeoutMs)
        });
      } catch (error) {
        if (this.blockedRequestUrl) {
          throw new CodexProError(`Browser blocked a private or internal request while opening ${url.hostname}.`);
        }
        throw new CodexProError(`Browser navigation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const snapshot = await this.snapshotUnlocked(options.maxTextChars, options.maxElements);
      return {
        ...snapshot,
        status: response?.status() ?? null,
        statusText: response?.statusText() ?? null
      };
    });
  }

  async snapshot(options: { maxTextChars?: number; maxElements?: number } = {}): Promise<BrowserSnapshot> {
    return this.exclusive(() => this.snapshotUnlocked(options.maxTextChars, options.maxElements));
  }

  private target(page: Page, ref: string | undefined, selector: string | undefined) {
    if (ref) {
      if (!/^e[1-9][0-9]{0,3}$/.test(ref)) throw new CodexProError("Browser ref must look like e1, e2, and so on.");
      return page.locator(`[${BROWSER_REF_ATTRIBUTE}="${ref}"]`);
    }
    if (selector?.trim()) return page.locator(selector.trim());
    throw new CodexProError("Provide ref from browser_snapshot or a CSS selector.");
  }

  async click(options: { ref?: string; selector?: string; timeoutMs?: number }): Promise<BrowserSnapshot> {
    return this.exclusive(async () => {
      const page = this.requirePage();
      const target = this.target(page, options.ref, options.selector);
      const count = await target.count();
      if (count !== 1) throw new CodexProError(`Browser target matched ${count} elements; expected exactly one.`);
      await target.click({ timeout: timeoutMs(options.timeoutMs) });
      await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs(options.timeoutMs), 10_000) }).catch(() => undefined);
      return this.snapshotUnlocked();
    });
  }

  async type(options: {
    ref?: string;
    selector?: string;
    value: string;
    clear?: boolean;
    pressEnter?: boolean;
    timeoutMs?: number;
  }): Promise<BrowserSnapshot> {
    return this.exclusive(async () => {
      const page = this.requirePage();
      const target = this.target(page, options.ref, options.selector);
      const count = await target.count();
      if (count !== 1) throw new CodexProError(`Browser target matched ${count} elements; expected exactly one.`);
      if (options.clear !== false) await target.fill(options.value, { timeout: timeoutMs(options.timeoutMs) });
      else await target.pressSequentially(options.value, { timeout: timeoutMs(options.timeoutMs) });
      if (options.pressEnter) {
        await target.press("Enter", { timeout: timeoutMs(options.timeoutMs) });
        await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs(options.timeoutMs), 10_000) }).catch(() => undefined);
      }
      return this.snapshotUnlocked();
    });
  }

  async select(options: { ref?: string; selector?: string; value: string; timeoutMs?: number }): Promise<BrowserSnapshot> {
    return this.exclusive(async () => {
      const page = this.requirePage();
      const target = this.target(page, options.ref, options.selector);
      const count = await target.count();
      if (count !== 1) throw new CodexProError(`Browser target matched ${count} elements; expected exactly one.`);
      await target.selectOption(options.value, { timeout: timeoutMs(options.timeoutMs) });
      return this.snapshotUnlocked();
    });
  }

  async screenshot(options: { fullPage?: boolean; timeoutMs?: number } = {}): Promise<{ data: Buffer; title: string; url: string }> {
    return this.exclusive(async () => {
      const page = this.requirePage();
      const data = await page.screenshot({
        type: "png",
        fullPage: options.fullPage ?? false,
        timeout: timeoutMs(options.timeoutMs)
      });
      return { data, title: await page.title(), url: page.url() };
    });
  }

  async close(): Promise<{ closed: boolean }> {
    return this.exclusive(async () => {
      const hadBrowser = Boolean(this.runtime || this.context || this.page);
      await this.context?.close().catch(() => undefined);
      await this.runtime?.close().catch(() => undefined);
      this.page = undefined;
      this.context = undefined;
      this.runtime = undefined;
      this.consoleEntries = [];
      this.blockedRequestUrl = undefined;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      return { closed: hadBrowser };
    });
  }
}

let sharedBrowserAutomation: BrowserAutomation | undefined;

export function getSharedBrowserAutomation(): BrowserAutomation {
  sharedBrowserAutomation ??= new BrowserAutomation();
  return sharedBrowserAutomation;
}

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
  result?: Record<string, any>;
  error?: { code?: number; message?: string };
}

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

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event: MessageEvent) => {
      let message: CdpResponse;
      try {
        message = JSON.parse(String(event.data)) as CdpResponse;
      } catch {
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

  static async connect(webSocketUrl: string): Promise<CdpClient> {
    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CodexProError("Timed out connecting to the Chrome tab.")), 8_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CodexProError("Unable to connect to the Chrome tab."));
      }, { once: true });
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

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
    if (!this.isOpen()) return Promise.reject(new CodexProError("Chrome DevTools connection is not open."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexProError(`Chrome DevTools timed out running ${method}.`));
      }, 12_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

const CDP_SESSION_IDLE_MS = 30_000;
const persistentClients = new Map<string, { client: CdpClient; timer: NodeJS.Timeout }>();

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

async function persistentClient(webSocketUrl: string): Promise<CdpClient> {
  const existing = persistentClients.get(webSocketUrl);
  if (existing?.client.isOpen()) {
    refreshPersistentClient(webSocketUrl, existing.client);
    return existing.client;
  }
  if (existing) dropPersistentClient(webSocketUrl);
  const client = await CdpClient.connect(webSocketUrl);
  refreshPersistentClient(webSocketUrl, client);
  return client;
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

async function evaluate(client: CdpClient, expression: string): Promise<any> {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (response.exceptionDetails) {
    throw new CodexProError(`Browser page script failed: ${response.exceptionDetails.text ?? "unknown error"}`);
  }
  return response.result?.value;
}

function selectorExpression(selector: string): string {
  const value = boundedText(selector, 2_000).trim();
  if (!value) throw new CodexProError("A CSS selector is required. Call action=snapshot to obtain selectors.");
  return JSON.stringify(value);
}

function keyCode(key: string): number {
  const codes: Record<string, number> = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32
  };
  return codes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
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
    if (action === "batch") {
      const steps = Array.isArray(options.steps) ? options.steps.slice(0, 50) : [];
      if (!steps.length) throw new CodexProError("batch requires at least one step.");
      const results: Record<string, any>[] = [];
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (!step || step.action === "batch" || ["status", "list_tabs", "open_tab", "activate_tab", "close_tab"].includes(step.action)) {
          throw new CodexProError(`Unsupported batch step at index ${index}: ${step?.action ?? "missing"}`);
        }
        results.push(await runBrowserControl(debugUrl, { ...step, targetId: target.id }));
      }
      return { action, target_id: target.id, ok: true, step_count: results.length, results };
    }

    if (action === "snapshot") {
      const maxChars = Math.max(500, Math.min(50_000, Math.floor(options.maxChars ?? 20_000)));
      const snapshot = await evaluate(client, `(() => {
        const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        const selectorFor = (el) => {
          if (el.id) return '#' + CSS.escape(el.id);
          for (const attr of ['data-testid','data-test','name','aria-label']) {
            const value = el.getAttribute(attr);
            if (value) { const candidate = el.tagName.toLowerCase() + '[' + attr + '=' + JSON.stringify(value) + ']'; try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch {} }
          }
          const parts = [];
          let node = el;
          while (node && node.nodeType === 1 && node !== document.documentElement) {
            let part = node.tagName.toLowerCase();
            const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((child) => child.tagName === node.tagName) : [];
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
            parts.unshift(part);
            const candidate = parts.join(' > ');
            try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch {}
            node = node.parentElement;
          }
          return parts.join(' > ');
        };
        const elements = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]'))
          .filter(visible).slice(0, 250).map((el) => ({
            tag: el.tagName.toLowerCase(), selector: selectorFor(el), type: el.getAttribute('type'),
            text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 300)
          }));
        return { title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, ${maxChars}), elements };
      })()`);
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
      const selector = selectorExpression(options.selector ?? "");
      const located = await evaluate(client, `(() => { const el = document.querySelector(${selector}); if (!el) return {ok:false,error:'Element not found'}; el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {ok:true,x:r.left+r.width/2,y:r.top+r.height/2,tag:el.tagName.toLowerCase(),text:(el.innerText||el.getAttribute('aria-label')||'').slice(0,300)}; })()`);
      if (!located?.ok) throw new CodexProError(`Browser ${action} failed: ${located?.error ?? "unknown error"}`);
      if (action === "click") {
        const result = await evaluate(client, `(() => { const el = document.querySelector(${selector}); if (!el) return {ok:false,error:'Element not found'}; el.click(); return {ok:true}; })()`);
        if (!result?.ok) throw new CodexProError(`Browser click failed: ${result?.error ?? "unknown error"}`);
      } else {
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: located.x, y: located.y, button: "none" });
        await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: located.x, y: located.y, button: "left", buttons: 1, clickCount: 1 });
        await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: located.x, y: located.y, button: "left", buttons: 0, clickCount: 1 });
      }
      return { action, target_id: target.id, selector: options.selector, ok: true, tag: located.tag, text: located.text };
    }

    if (action === "type") {
      const selector = selectorExpression(options.selector ?? "");
      const text = JSON.stringify(boundedText(options.text, 100_000));
      const result = await evaluate(client, `(() => {
        const el = document.querySelector(${selector}); if (!el) return {ok:false,error:'Element not found'};
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
      const selector = selectorExpression(options.selector ?? "");
      const point = await evaluate(client, `(() => { const el=document.querySelector(${selector}); if(!el)return null; el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,tag:el.tagName.toLowerCase()}; })()`);
      if (!point) throw new CodexProError("Browser hover failed: Element not found");
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
      return { action, target_id: target.id, selector: options.selector, ok: true, tag: point.tag };
    }

    if (action === "scroll") {
      let point = await evaluate(client, "({x:innerWidth/2,y:innerHeight/2})");
      if (options.selector) {
        const selector = selectorExpression(options.selector);
        point = await evaluate(client, `(() => { const el=document.querySelector(${selector}); if(!el)return null; el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
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
      const selector = options.selector ? JSON.stringify(boundedText(options.selector, 2_000)) : "null";
      const wantedText = options.text ? JSON.stringify(boundedText(options.text, 10_000)) : "null";
      const deadline = Date.now() + timeoutMs;
      let last: any = null;
      while (Date.now() <= deadline) {
        last = await evaluate(client, `(() => { const selector=${selector},wanted=${wantedText},state=${JSON.stringify(state)}; const el=selector?document.querySelector(selector):null; const attached=Boolean(el); const visible=Boolean(el&&(()=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';})()); const haystack=selector?(el?.innerText||el?.textContent||''):(document.body?.innerText||''); const textMatched=!wanted||String(haystack).includes(wanted); const matched=state==='attached'?attached&&textMatched:state==='visible'?visible&&textMatched:state==='hidden'?!visible:state==='detached'?!attached:false; return {matched,attached,visible,text_matched:textMatched}; })()`);
        if (last?.matched) return { action, target_id: target.id, selector: options.selector, text: options.text, state, waited_ms: timeoutMs - Math.max(0, deadline - Date.now()), ...last };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new CodexProError(`Browser wait_for timed out after ${timeoutMs} ms.`);
    }

    if (action === "inspect_element") {
      const selector = selectorExpression(options.selector ?? "");
      const result = await evaluate(client, `(() => { const el=document.querySelector(${selector}); if(!el)return {ok:false,error:'Element not found'}; const r=el.getBoundingClientRect(),s=getComputedStyle(el); return {ok:true,tag:el.tagName.toLowerCase(),text:(el.innerText||el.textContent||'').trim().slice(0,1000),value:typeof el.value==='string'?el.value.slice(0,1000):'',disabled:Boolean(el.disabled),checked:Boolean(el.checked),rect:{x:r.x,y:r.y,width:r.width,height:r.height},style:{display:s.display,visibility:s.visibility,opacity:s.opacity,pointerEvents:s.pointerEvents,position:s.position,zIndex:s.zIndex},attributes:Object.fromEntries(Array.from(el.attributes||[]).slice(0,40).map(a=>[a.name,String(a.value).slice(0,500)]))}; })()`);
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
  });
}
