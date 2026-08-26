import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type McpUsageStatus = "ok" | "error";

export const CODEXPRO_MODEL = "gpt-5.6-sol";
export const CODEXPRO_REASONING_EFFORT = "high";
export const CODEXPRO_INPUT_USD_PER_MILLION = 4.0;
export const CODEXPRO_OUTPUT_USD_PER_MILLION = 20.0;

function serializeForEstimate(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value ?? "");
  }
}

export function estimateMcpTokens(value: unknown): number {
  const text = serializeForEstimate(value);
  if (!text) return 0;
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) <= 127) asciiChars += 1;
    else nonAsciiChars += 1;
  }
  return Math.max(1, Math.ceil(asciiChars / 3.8 + nonAsciiChars / 1.6));
}

export function estimateMcpCostUsd(mcpRequestTokens: number, mcpResponseTokens: number): number {
  // From the model's billing perspective the directions are reversed:
  // ChatGPT -> MCP tool arguments are model output, while MCP -> ChatGPT tool
  // results become model input/context on the following model turn.
  const modelInputEquivalent = Math.max(0, mcpResponseTokens);
  const modelOutputEquivalent = Math.max(0, mcpRequestTokens);
  return (
    modelInputEquivalent * CODEXPRO_INPUT_USD_PER_MILLION
    + modelOutputEquivalent * CODEXPRO_OUTPUT_USD_PER_MILLION
  ) / 1_000_000;
}

export function resolveMcpUsageLogPath(): string | null {
  const override = process.env.CODEXPRO_USAGE_LOG?.trim();
  if (override) {
    if (["0", "off", "false", "disabled"].includes(override.toLowerCase())) return null;
    return path.resolve(override);
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "CodexPro", "mcp-usage.jsonl");
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "codexpro", "mcp-usage.jsonl");
}

export async function recordMcpUsage(tool: string, args: unknown, result: unknown, status: McpUsageStatus, durationMs: number): Promise<void> {
  const logPath = resolveMcpUsageLogPath();
  if (!logPath) return;
  try {
    const inputText = serializeForEstimate(args);
    const outputText = serializeForEstimate(result);
    const inputTokens = estimateMcpTokens(inputText);
    const outputTokens = estimateMcpTokens(outputText);
    const estimatedCostUsd = estimateMcpCostUsd(inputTokens, outputTokens);
    const workspaceId = args && typeof args === "object" && typeof (args as Record<string, unknown>).workspace_id === "string"
      ? String((args as Record<string, unknown>).workspace_id)
      : undefined;
    const record = {
      schema_version: 1,
      timestamp: new Date().toISOString(),
      source: "codexpro",
      model: CODEXPRO_MODEL,
      reasoning_effort: CODEXPRO_REASONING_EFFORT,
      tool,
      status,
      duration_ms: Math.max(0, Math.round(durationMs)),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      model_input_equivalent_tokens: outputTokens,
      model_output_equivalent_tokens: inputTokens,
      estimated_cost_usd: estimatedCostUsd,
      input_usd_per_million: CODEXPRO_INPUT_USD_PER_MILLION,
      output_usd_per_million: CODEXPRO_OUTPUT_USD_PER_MILLION,
      cost_estimate_kind: "gpt-5.6-sol-rate-card-equivalent",
      input_bytes: Buffer.byteLength(inputText, "utf8"),
      output_bytes: Buffer.byteLength(outputText, "utf8"),
      estimate_kind: "mcp_payload_heuristic"
    };
    await fsp.mkdir(path.dirname(logPath), { recursive: true });
    await fsp.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Usage accounting must never make an MCP tool fail.
  }
}
