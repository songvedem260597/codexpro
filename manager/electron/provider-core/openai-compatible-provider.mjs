import { normalizeModelId, normalizeProviderToolCalls } from "./provider-contract.mjs";

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function clean(value, maxLength = 1000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function isLoopback(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function normalizeProviderBaseUrl(value) {
  const url = new URL(String(value || ""));
  if (url.username || url.password) throw new Error("Provider URL must not contain credentials.");
  if (url.search || url.hash) throw new Error("Provider base URL must not contain a query string or fragment.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("Provider URL must use HTTPS; HTTP is allowed only for loopback development endpoints.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function endpoint(baseUrl, relativePath) {
  const url = new URL(relativePath.replace(/^\/+/, ""), normalizeProviderBaseUrl(baseUrl));
  if (url.origin !== normalizeProviderBaseUrl(baseUrl).origin) throw new Error("Provider endpoint escaped its configured origin.");
  return url;
}

function boundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(numeric, max)) : fallback;
}

function combinedSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("Provider response exceeded the configured size limit.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Provider response exceeded the configured size limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function safeProviderError(status, body) {
  const message = clean(body, 1200)
    .replace(/(?:sk|key|token)-[A-Za-z0-9._-]{8,}/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]");
  return new Error(`Provider HTTP ${status}${message ? `: ${message}` : ""}`);
}

function normalizeUsage(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    prompt_tokens: Number(source.prompt_tokens || 0),
    completion_tokens: Number(source.completion_tokens || 0),
    total_tokens: Number(source.total_tokens || 0),
    ...(Number.isFinite(Number(source.cost)) ? { cost: Number(source.cost) } : {})
  };
}

function normalizeCompletion(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
  const message = choice?.message && typeof choice.message === "object" ? choice.message : {};
  return {
    id: clean(payload?.id, 200),
    text: typeof message.content === "string" ? message.content : "",
    toolCalls: normalizeProviderToolCalls(message.tool_calls || []),
    finishReason: clean(choice?.finish_reason, 80),
    usage: normalizeUsage(payload?.usage),
    providerState: clean(payload?.id, 200) || undefined
  };
}

function createStreamAccumulator() {
  const toolCalls = new Map();
  let id = "";
  let text = "";
  let finishReason = "";
  let usage = {};
  return {
    push(payload, onDelta) {
      id ||= clean(payload?.id, 200);
      usage = payload?.usage || usage;
      const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
      finishReason = clean(choice?.finish_reason, 80) || finishReason;
      const delta = choice?.delta && typeof choice.delta === "object" ? choice.delta : {};
      if (typeof delta.content === "string") {
        text += delta.content;
        onDelta?.({ type: "text", text: delta.content });
      }
      for (const incoming of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const index = Number.isInteger(incoming?.index) ? incoming.index : toolCalls.size;
        const current = toolCalls.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
        current.id ||= clean(incoming?.id, 160);
        current.function.name += String(incoming?.function?.name || "");
        current.function.arguments += String(incoming?.function?.arguments || "");
        toolCalls.set(index, current);
      }
    },
    result() {
      return {
        id,
        text,
        toolCalls: normalizeProviderToolCalls([...toolCalls.values()]),
        finishReason,
        usage: normalizeUsage(usage),
        providerState: id || undefined
      };
    }
  };
}

async function readStreamingCompletion(response, maxBytes, onDelta) {
  const accumulator = createStreamAccumulator();
  if (!response.body) return accumulator.result();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  const consume = (event) => {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return;
    accumulator.push(JSON.parse(data), onDelta);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Provider response exceeded the configured size limit.");
      }
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      for (const event of events) consume(event);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally {
    reader.releaseLock();
  }
  return accumulator.result();
}

export function createOpenAICompatibleProvider(options = {}) {
  const baseUrl = normalizeProviderBaseUrl(options.baseUrl || "https://api.openai.com/v1");
  const model = normalizeModelId(options.model);
  const providerId = clean(options.id || "openai-compatible", 64).toLowerCase();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 10 * 60_000);
  const maxResponseBytes = boundedNumber(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1024, 64 * 1024 * 1024);
  const maxRequestBytes = boundedNumber(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 1024, 64 * 1024 * 1024);
  const getApiKey = typeof options.getApiKey === "function" ? options.getApiKey : async () => "";
  const requestHeaders = options.requestHeaders && typeof options.requestHeaders === "object" ? options.requestHeaders : {};
  const allowedHeaders = Object.fromEntries(Object.entries(requestHeaders)
    .filter(([name]) => ["http-referer", "x-title"].includes(name.toLowerCase()))
    .map(([name, value]) => [name, clean(value, 500)]));

  async function request(relativePath, init = {}, signal) {
    const apiKey = clean(await getApiKey(), 20_000);
    if (!apiKey) throw new Error(`Provider ${providerId} credential is unavailable.`);
    const requestBody = typeof init.body === "string" ? init.body : init.body;
    if (typeof requestBody === "string" && new TextEncoder().encode(requestBody).byteLength > maxRequestBytes) {
      throw new Error("Provider request exceeded the configured size limit.");
    }
    const response = await fetchImpl(endpoint(baseUrl, relativePath), {
      ...init,
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...allowedHeaders,
        authorization: `Bearer ${apiKey}`
      },
      signal: combinedSignal(signal, timeoutMs)
    });
    if (!response.ok) throw safeProviderError(response.status, await readBoundedBody(response, Math.min(maxResponseBytes, 64 * 1024)));
    return response;
  }

  return {
    manifest: {
      id: providerId,
      name: clean(options.name || "OpenAI-compatible", 100),
      kind: clean(options.kind || "openai-compatible", 64),
      version: "1",
      capabilities: { tool_calling: true, streaming: true, model_discovery: true, cancellation: true, usage: true }
    },

    async probe({ signal } = {}) {
      const models = await this.listModels({ signal });
      return { ok: true, provider_id: providerId, model, model_available: models.some((item) => item.id === model) };
    },

    async listModels({ signal } = {}) {
      const response = await request("models", { method: "GET", headers: undefined, body: undefined }, signal);
      const payload = JSON.parse(await readBoundedBody(response, maxResponseBytes));
      return (Array.isArray(payload?.data) ? payload.data : []).slice(0, 10_000).map((item) => ({
        id: clean(item?.id, 240),
        name: clean(item?.name || item?.id, 240),
        context_length: Number(item?.context_length || 0) || undefined
      })).filter((item) => item.id);
    },

    async complete(input = {}) {
      const messages = Array.isArray(input.messages) ? input.messages : [];
      if (!messages.length) throw new Error("Provider completion requires at least one message.");
      const stream = typeof input.onDelta === "function";
      const body = {
        ...(options.requestBody && typeof options.requestBody === "object" ? options.requestBody : {}),
        model: normalizeModelId(input.model || model),
        messages,
        ...(Array.isArray(input.tools) && input.tools.length ? { tools: input.tools, tool_choice: input.toolChoice || "auto" } : {}),
        ...(Number.isFinite(input.temperature) ? { temperature: input.temperature } : {}),
        ...(Number.isFinite(input.maxTokens) ? { max_tokens: input.maxTokens } : {}),
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {})
      };
      const response = await request("chat/completions", { method: "POST", body: JSON.stringify(body) }, input.signal);
      if (stream) return await readStreamingCompletion(response, maxResponseBytes, input.onDelta);
      return normalizeCompletion(JSON.parse(await readBoundedBody(response, maxResponseBytes)));
    }
  };
}

export function create9RouterProvider(options = {}) {
  return createOpenAICompatibleProvider({
    ...options,
    id: options.id || "9router",
    name: options.name || "9Router",
    kind: "9router",
    baseUrl: options.baseUrl || "http://localhost:20128/v1"
  });
}

export function createOpenRouterProvider(options = {}) {
  return createOpenAICompatibleProvider({
    ...options,
    id: options.id || "openrouter",
    name: options.name || "OpenRouter",
    kind: "openrouter",
    baseUrl: options.baseUrl || "https://openrouter.ai/api/v1",
    requestHeaders: {
      ...(options.appUrl ? { "HTTP-Referer": options.appUrl } : {}),
      ...(options.appName ? { "X-Title": options.appName } : {})
    },
    requestBody: options.routing && typeof options.routing === "object" ? { provider: options.routing } : undefined
  });
}
