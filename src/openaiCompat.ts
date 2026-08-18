import type { Request, Response } from "express";

export const CODEXPRO_OPENAI_MODEL = "gpt-5.6-sol";
export const CODEXPRO_VARIANTS = ["light", "medium", "high"] as const;
export type CodexProVariant = (typeof CODEXPRO_VARIANTS)[number];

type JsonObject = Record<string, unknown>;

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CODEXPRO_OPENAI_UPSTREAM_BASE_URL must use http or https.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export interface OpenAiCompatConfig {
  model: string;
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  upstreamModel: string;
  timeoutMs: number;
}

export function loadOpenAiCompatConfig(): OpenAiCompatConfig {
  const rawBaseUrl = process.env.CODEXPRO_OPENAI_UPSTREAM_BASE_URL?.trim();
  const timeout = Number(process.env.CODEXPRO_OPENAI_UPSTREAM_TIMEOUT_MS ?? 120000);
  return {
    model: CODEXPRO_OPENAI_MODEL,
    upstreamBaseUrl: rawBaseUrl ? normalizedBaseUrl(rawBaseUrl) : undefined,
    upstreamApiKey: process.env.CODEXPRO_OPENAI_UPSTREAM_API_KEY?.trim() || undefined,
    upstreamModel: process.env.CODEXPRO_OPENAI_UPSTREAM_MODEL?.trim() || CODEXPRO_OPENAI_MODEL,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 && timeout <= 600000 ? Math.floor(timeout) : 120000
  };
}

export function modelsResponse() {
  return {
    object: "list",
    data: [
      {
        id: CODEXPRO_OPENAI_MODEL,
        object: "model",
        created: 0,
        owned_by: "codexpro"
      }
    ]
  };
}

function requestVariant(req: Request, body: JsonObject): CodexProVariant {
  const header = req.header("x-codexpro-variant")?.trim().toLowerCase();
  const bodyHeaders = body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
    ? body.headers as Record<string, unknown>
    : undefined;
  const embeddedHeader = typeof bodyHeaders?.["X-CodexPro-Variant"] === "string"
    ? String(bodyHeaders["X-CodexPro-Variant"]).trim().toLowerCase()
    : typeof bodyHeaders?.["x-codexpro-variant"] === "string"
      ? String(bodyHeaders["x-codexpro-variant"]).trim().toLowerCase()
      : undefined;
  const bodyVariant = typeof body.codexpro_variant === "string" ? body.codexpro_variant.trim().toLowerCase() : undefined;
  const reasoning = typeof body.reasoning_effort === "string" ? body.reasoning_effort.trim().toLowerCase() : undefined;
  const candidate = header || embeddedHeader || bodyVariant || reasoning || "medium";
  if (candidate === "low") return "light";
  if (candidate === "light" || candidate === "medium" || candidate === "high") return candidate;
  throw new Error("Unsupported CodexPro variant. Use light, medium, or high.");
}

function upstreamReasoningEffort(variant: CodexProVariant): "low" | "medium" | "high" {
  return variant === "light" ? "low" : variant;
}

export function sendOpenAiError(res: Response, status: number, message: string, code: string): void {
  res.status(status).json({
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      param: null,
      code
    }
  });
}

function copyResponseHeaders(upstream: globalThis.Response, res: Response): void {
  for (const name of ["content-type", "x-request-id", "openai-processing-ms"]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

export async function handleChatCompletions(req: Request, res: Response, config: OpenAiCompatConfig): Promise<void> {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendOpenAiError(res, 400, "Request body must be a JSON object.", "invalid_request");
    return;
  }
  const input = body as JsonObject;
  const requestedModel = typeof input.model === "string" && input.model.trim() ? input.model.trim() : config.model;
  if (requestedModel !== config.model) {
    sendOpenAiError(res, 404, `Model not found: ${requestedModel}`, "model_not_found");
    return;
  }
  if (!Array.isArray(input.messages)) {
    sendOpenAiError(res, 400, "messages must be an array.", "invalid_messages");
    return;
  }
  if (!config.upstreamBaseUrl) {
    sendOpenAiError(
      res,
      503,
      "CodexPro OpenAI-compatible model backend is not configured. Set CODEXPRO_OPENAI_UPSTREAM_BASE_URL.",
      "model_backend_unconfigured"
    );
    return;
  }

  let variant: CodexProVariant;
  try {
    variant = requestVariant(req, input);
  } catch (error) {
    sendOpenAiError(res, 400, error instanceof Error ? error.message : String(error), "invalid_variant");
    return;
  }

  const upstreamBody: JsonObject = {
    ...input,
    model: config.upstreamModel,
    reasoning_effort: upstreamReasoningEffort(variant)
  };
  delete upstreamBody.codexpro_variant;
  delete upstreamBody.headers;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.upstreamApiKey) headers.authorization = `Bearer ${config.upstreamApiKey}`;

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${config.upstreamBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    sendOpenAiError(res, 502, `Upstream model request failed: ${error instanceof Error ? error.message : String(error)}`, "upstream_unreachable");
    return;
  }

  res.status(upstream.status);
  copyResponseHeaders(upstream, res);
  res.setHeader("X-CodexPro-Model", config.model);
  res.setHeader("X-CodexPro-Variant", variant);

  if (!upstream.body) {
    res.end();
    return;
  }

  try {
    for await (const chunk of upstream.body as any) {
      res.write(Buffer.from(chunk));
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      sendOpenAiError(res, 502, `Upstream response failed: ${error instanceof Error ? error.message : String(error)}`, "upstream_response_error");
    } else {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
