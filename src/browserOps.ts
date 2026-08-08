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
