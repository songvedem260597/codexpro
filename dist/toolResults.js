import { redactSensitiveText, redactStructured } from "./redact.js";
export const STRUCTURED_STRING_MAX_CHARS = 30_000;
export function errorText(error) {
    if (error instanceof Error)
        return redactSensitiveText(`${error.name}: ${error.message}`);
    return redactSensitiveText(String(error));
}
export function compactStructuredContent(value, depth = 0) {
    if (depth > 8 || value === null || value === undefined)
        return value;
    if (typeof value === "string") {
        if (value.length <= STRUCTURED_STRING_MAX_CHARS)
            return value;
        return `${value.slice(0, STRUCTURED_STRING_MAX_CHARS)}\n...[structured field truncated to ${STRUCTURED_STRING_MAX_CHARS} chars]`;
    }
    if (Array.isArray(value))
        return value.map((item) => compactStructuredContent(item, depth + 1));
    if (typeof value !== "object")
        return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        out[key] = compactStructuredContent(item, depth + 1);
    }
    return out;
}
export function errorEnvelope(error) {
    const message = errorText(error);
    if (!(error instanceof Error))
        return { name: "Error", message };
    const source = error;
    return redactStructured({
        name: error.name || "Error",
        message,
        code: typeof source.code === "string" ? source.code : undefined,
        details: source.details && typeof source.details === "object" && !Array.isArray(source.details)
            ? compactStructuredContent(source.details)
            : undefined,
        cause: source.cause instanceof Error ? `${source.cause.name}: ${source.cause.message}` : undefined
    });
}
export function textResult(text, structuredContent = {}, meta = {}) {
    return {
        content: [{ type: "text", text: redactSensitiveText(text) }],
        structuredContent: redactStructured(structuredContent),
        _meta: meta
    };
}
export function errorResult(error) {
    return {
        isError: true,
        content: [{ type: "text", text: errorText(error) }],
        structuredContent: { error: errorEnvelope(error) }
    };
}
//# sourceMappingURL=toolResults.js.map