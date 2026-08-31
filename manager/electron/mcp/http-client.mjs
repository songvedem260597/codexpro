const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}:[A-Za-z0-9][A-Za-z0-9._-]{0,94}$/;

function isLoopback(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function normalizeMcpUrl(value, profileId = "") {
  const url = new URL(String(value || ""));
  if (url.username || url.password || url.hash) throw new Error("MCP URL must not contain credentials or a fragment.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("MCP URL must use HTTPS; HTTP is allowed only for loopback.");
  }
  if (url.pathname === "/" || !url.pathname) url.pathname = "/mcp";
  if (url.pathname !== "/mcp") throw new Error("MCP URL must use the /mcp path.");
  if (profileId) {
    if (!WORKER_ID_PATTERN.test(profileId)) throw new Error("MCP worker profile id is invalid.");
    url.searchParams.set("codexpro_profile", profileId);
  }
  return url;
}

function bounded(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(Math.floor(numeric), max)) : fallback;
}

function signalWithTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("MCP response exceeded the configured size limit.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("MCP response exceeded the configured size limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseMcpPayload(text, contentType) {
  if (!text.trim()) return {};
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data) return JSON.parse(data);
  }
  return {};
}

function mcpToolError(result) {
  const message = result?.content?.find((item) => item?.type === "text")?.text || "CodexPro MCP returned an error.";
  const structured = result?.structuredContent?.error;
  const envelope = structured && typeof structured === "object" && !Array.isArray(structured) ? structured : {};
  const error = new Error(String(envelope.message || message));
  error.name = String(envelope.name || "CodexProMcpError");
  error.code = String(envelope.code || "MCP_TOOL_ERROR");
  error.details = envelope.details && typeof envelope.details === "object" ? envelope.details : envelope;
  return error;
}

export function createMcpHttpClient(options = {}) {
  const endpoint = normalizeMcpUrl(options.url, options.profileId);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const token = String(options.token || "").trim();
  const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 5 * 60_000);
  const maxResponseBytes = bounded(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1024, 64 * 1024 * 1024);
  const maxRequestBytes = bounded(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 1024, 64 * 1024 * 1024);
  let sessionId = "";
  let nextId = 1;

  async function request(body, requestOptions = {}) {
    const requestBody = JSON.stringify(body);
    if (new TextEncoder().encode(requestBody).byteLength > maxRequestBytes) throw new Error("MCP request exceeded the configured size limit.");
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        connection: "close",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {})
      },
      body: requestBody,
      signal: signalWithTimeout(requestOptions.signal, bounded(requestOptions.timeoutMs, timeoutMs, 1_000, 5 * 60_000))
    });
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    sessionId = response.headers.get("mcp-session-id") || sessionId;
    const payload = parseMcpPayload(await readBounded(response, maxResponseBytes), String(response.headers.get("content-type") || "").toLowerCase());
    if (payload?.error) throw new Error(String(payload.error.message || "CodexPro MCP returned an error."));
    return payload;
  }

  return {
    get sessionId() { return sessionId; },
    get profileId() { return String(options.profileId || ""); },

    async open(requestOptions = {}) {
      if (sessionId) return this;
      await request({
        jsonrpc: "2.0",
        id: nextId++,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: String(options.clientName || "CodexPro API Worker"), version: "1" }
        }
      }, requestOptions);
      await request({ jsonrpc: "2.0", method: "notifications/initialized" }, requestOptions);
      return this;
    },

    async listTools(requestOptions = {}) {
      if (!sessionId) await this.open(requestOptions);
      const payload = await request({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }, requestOptions);
      return Array.isArray(payload?.result?.tools) ? payload.result.tools : [];
    },

    async callTool(name, args = {}, requestOptions = {}) {
      if (!sessionId) await this.open(requestOptions);
      const payload = await request({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: String(name || ""), arguments: args }
      }, requestOptions);
      const result = payload?.result || {};
      if (result.isError) throw mcpToolError(result);
      if (result.structuredContent !== undefined) return result.structuredContent;
      return { content: Array.isArray(result.content) ? result.content : [] };
    },

    async close() {
      if (!sessionId) return;
      const closingSessionId = sessionId;
      sessionId = "";
      try {
        await fetchImpl(endpoint, {
          method: "DELETE",
          redirect: "error",
          headers: {
            accept: "application/json, text/event-stream",
            connection: "close",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            "mcp-session-id": closingSessionId
          },
          signal: AbortSignal.timeout(3_000)
        });
      } catch {
        // The server also expires abandoned sessions. Closing is best effort.
      }
    }
  };
}

export async function createWorkerMcpClients(options = {}) {
  const controlMcp = createMcpHttpClient({ ...options, profileId: "", clientName: "CodexPro API Worker Control" });
  const jobMcp = createMcpHttpClient({ ...options, profileId: options.workerId, clientName: "CodexPro API Worker Job" });
  try {
    await controlMcp.open({ signal: options.signal });
    await jobMcp.open({ signal: options.signal });
    return { controlMcp, jobMcp };
  } catch (error) {
    await Promise.allSettled([controlMcp.close(), jobMcp.close()]);
    throw error;
  }
}
