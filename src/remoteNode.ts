#!/usr/bin/env node
import os from "node:os";

const MIN_TOKEN_BYTES = 24;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RETRY_DELAY_MS = 2_000;
const LOCAL_INVOKE_TIMEOUT_MS = 120_000;

interface GatewayJob {
  requestId: string;
  nodeId: string;
  action: string;
  args: Record<string, unknown>;
  createdAt: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredToken(name: string): string {
  const value = required(name);
  if (Buffer.byteLength(value) < MIN_TOKEN_BYTES) {
    throw new Error(`${name} must be at least ${MIN_TOKEN_BYTES} bytes.`);
  }
  return value;
}

function normalizedBaseUrl(name: string, fallback?: string): string {
  const raw = process.env[name]?.trim() || fallback || "";
  if (!raw) throw new Error(`${name} is required.`);
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https.`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function defaultNodeId(): string {
  const cleaned = os.hostname().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "").slice(0, 64);
  return cleaned || "codexpro-node";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return await response.json();
  return await response.text();
}

async function main(): Promise<void> {
  const gatewayUrl = normalizedBaseUrl("CODEXPRO_GATEWAY_URL");
  const localApiUrl = normalizedBaseUrl("CODEXPRO_LOCAL_API_URL", "http://127.0.0.1:8787");
  const gatewayNodeToken = requiredToken("CODEXPRO_GATEWAY_NODE_TOKEN");
  const localApiToken = requiredToken("CODEXPRO_HTTP_TOKEN");
  const nodeId = process.env.CODEXPRO_NODE_ID?.trim() || defaultNodeId();
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new Error("CODEXPRO_NODE_ID must use letters, numbers, dot, underscore, or dash and be at most 64 characters.");
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  async function gatewayFetch(path: string, init: RequestInit): Promise<Response> {
    return await fetch(`${gatewayUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${gatewayNodeToken}`,
        ...(init.headers ?? {})
      }
    });
  }

  async function reportResult(job: GatewayJob, status: number, body: unknown): Promise<void> {
    const response = await gatewayFetch("/v1/node/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId, requestId: job.requestId, status, body })
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gateway result upload failed: ${response.status} ${detail}`);
    }
  }

  async function execute(job: GatewayJob): Promise<void> {
    try {
      const response = await fetch(`${localApiUrl}/v1/invoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localApiToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ action: job.action, args: job.args ?? {} }),
        signal: AbortSignal.timeout(LOCAL_INVOKE_TIMEOUT_MS)
      });
      const body = await parseResponse(response);
      await reportResult(job, response.status, body);
    } catch (error) {
      await reportResult(job, 502, {
        ok: false,
        error: {
          code: "local_api_unreachable",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  console.error(`[CodexProNode] nodeId=${nodeId}`);
  console.error(`[CodexProNode] gateway=${gatewayUrl}`);
  console.error(`[CodexProNode] localApi=${localApiUrl}`);

  while (!stopping) {
    try {
      const response = await gatewayFetch("/v1/node/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId })
      });

      if (response.status === 204) continue;
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Gateway rejected node authentication with ${response.status}.`);
      }
      if (!response.ok) {
        console.error(`[CodexProNode] gateway poll failed: ${response.status} ${await response.text()}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      const payload = await response.json() as { job?: GatewayJob };
      if (!payload.job) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      await execute(payload.job);
    } catch (error) {
      if (stopping) break;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[CodexProNode] ${message}`);
      if (/rejected node authentication/.test(message)) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
