import { redactSensitiveText, redactStructured } from "./redact.js";

export const STRUCTURED_STRING_MAX_CHARS = 30_000;

export function errorText(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(`${error.name}: ${error.message}`);
  return redactSensitiveText(String(error));
}

export function compactStructuredContent<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length <= STRUCTURED_STRING_MAX_CHARS) return value as T;
    return `${value.slice(0, STRUCTURED_STRING_MAX_CHARS)}\n...[structured field truncated to ${STRUCTURED_STRING_MAX_CHARS} chars]` as T;
  }
  if (Array.isArray(value)) return value.map((item) => compactStructuredContent(item, depth + 1)) as T;
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = compactStructuredContent(item, depth + 1);
  }
  return out as T;
}

export function errorEnvelope(error: unknown): Record<string, unknown> {
  const message = errorText(error);
  if (!(error instanceof Error)) return { name: "Error", message };
  const source = error as Error & { code?: unknown; details?: unknown; cause?: unknown };
  return redactStructured({
    name: error.name || "Error",
    message,
    code: typeof source.code === "string" ? source.code : undefined,
    details: source.details && typeof source.details === "object" && !Array.isArray(source.details)
      ? compactStructuredContent(source.details as Record<string, unknown>)
      : undefined,
    cause: source.cause instanceof Error ? `${source.cause.name}: ${source.cause.message}` : undefined
  }) as Record<string, unknown>;
}

export function textResult(text: string, structuredContent: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): any {
  return {
    content: [{ type: "text", text: redactSensitiveText(text) }],
    structuredContent: redactStructured(structuredContent),
    _meta: meta
  };
}

export function errorResult(error: unknown): any {
  return {
    isError: true,
    content: [{ type: "text", text: errorText(error) }],
    structuredContent: { error: errorEnvelope(error) }
  };
}
