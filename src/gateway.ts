#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

const MIN_TOKEN_BYTES = 24;
const NODE_ONLINE_TTL_MS = 45_000;
const NODE_POLL_WAIT_MS = 20_000;
const INVOCATION_TIMEOUT_MS = 120_000;
const MAX_QUEUE_PER_NODE = 100;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface GatewayJob {
  requestId: string;
  nodeId: string;
  action: string;
  args: Record<string, unknown>;
  createdAt: number;
}

interface GatewayResult {
  status: number;
  body: unknown;
}

interface PendingInvocation {
  nodeId: string;
  timer: NodeJS.Timeout;
  resolve: (value: GatewayResult) => void;
}

const InvokeRequest = z.object({
  nodeId: z.string().regex(NODE_ID_PATTERN).optional(),
  action: z.string().trim().min(1).max(128),
  args: z.record(z.any()).optional()
}).strict();

const NodePollRequest = z.object({
  nodeId: z.string().regex(NODE_ID_PATTERN)
}).strict();

const NodeResultRequest = z.object({
  nodeId: z.string().regex(NODE_ID_PATTERN),
  requestId: z.string().uuid(),
  status: z.number().int().min(100).max(599),
  body: z.any()
}).strict();

function requiredToken(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required.`);
  if (Buffer.byteLength(value) < MIN_TOKEN_BYTES) {
    throw new Error(`${name} must be at least ${MIN_TOKEN_BYTES} bytes.`);
  }
  return value;
}

function tokenMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function bearerToken(req: Request): string | undefined {
  return req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
}

function authMiddleware(expected: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (tokenMatches(expected, bearerToken(req))) {
      next();
      return;
    }
    res.status(401).json({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } });
  };
}

function jsonError(res: Response, status: number, code: string, message: string, issues?: unknown): void {
  res.status(status).json({ ok: false, error: { code, message, ...(issues ? { issues } : {}) } });
}

async function main(): Promise<void> {
  const host = process.env.CODEXPRO_GATEWAY_HOST?.trim() || "0.0.0.0";
  const port = Number(process.env.CODEXPRO_GATEWAY_PORT ?? 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CODEXPRO_GATEWAY_PORT must be a valid port.");

  const clientToken = requiredToken("CODEXPRO_GATEWAY_CLIENT_TOKEN");
  const nodeToken = requiredToken("CODEXPRO_GATEWAY_NODE_TOKEN");
  const defaultNode = process.env.CODEXPRO_GATEWAY_DEFAULT_NODE?.trim() || "";
  if (defaultNode && !NODE_ID_PATTERN.test(defaultNode)) {
    throw new Error("CODEXPRO_GATEWAY_DEFAULT_NODE must use letters, numbers, dot, underscore, or dash.");
  }

  const app = express();
  const clientAuth = authMiddleware(clientToken);
  const nodeAuth = authMiddleware(nodeToken);
  const queues = new Map<string, GatewayJob[]>();
  const waiters = new Map<string, Array<(job: GatewayJob | null) => void>>();
  const pending = new Map<string, PendingInvocation>();
  const lastSeen = new Map<string, number>();

  function markNodeSeen(nodeId: string): void {
    lastSeen.set(nodeId, Date.now());
  }

  function nodeOnline(nodeId: string): boolean {
    const seen = lastSeen.get(nodeId);
    return Boolean(seen && Date.now() - seen <= NODE_ONLINE_TTL_MS);
  }

  function enqueue(job: GatewayJob): boolean {
    const waiting = waiters.get(job.nodeId);
    const waiter = waiting?.shift();
    if (waiter) {
      if (!waiting?.length) waiters.delete(job.nodeId);
      waiter(job);
      return true;
    }

    const queue = queues.get(job.nodeId) ?? [];
    if (queue.length >= MAX_QUEUE_PER_NODE) return false;
    queue.push(job);
    queues.set(job.nodeId, queue);
    return true;
  }

  async function nextJob(nodeId: string): Promise<GatewayJob | null> {
    const queue = queues.get(nodeId);
    while (queue?.length) {
      const immediate = queue.shift();
      if (!queue.length) queues.delete(nodeId);
      if (immediate && pending.has(immediate.requestId)) return immediate;
    }

    return await new Promise<GatewayJob | null>((resolve) => {
      const wrapped = (job: GatewayJob | null) => {
        clearTimeout(timer);
        resolve(job);
      };
      const nodeWaiters = waiters.get(nodeId) ?? [];
      nodeWaiters.push(wrapped);
      waiters.set(nodeId, nodeWaiters);
      const timer = setTimeout(() => {
        const current = waiters.get(nodeId) ?? [];
        const index = current.indexOf(wrapped);
        if (index >= 0) current.splice(index, 1);
        if (current.length) waiters.set(nodeId, current);
        else waiters.delete(nodeId);
        resolve(null);
      }, NODE_POLL_WAIT_MS);
      timer.unref();
    });
  }

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "CodexPro Gateway", version: 1 });
  });

  app.post("/v1/node/poll", nodeAuth, express.json({ limit: "8kb" }), async (req, res) => {
    const parsed = NodePollRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      jsonError(res, 400, "invalid_node", "Invalid node poll request.", parsed.error.flatten());
      return;
    }
    const { nodeId } = parsed.data;
    markNodeSeen(nodeId);
    const job = await nextJob(nodeId);
    markNodeSeen(nodeId);
    if (!job) {
      res.status(204).end();
      return;
    }
    res.json({ ok: true, job });
  });

  app.post("/v1/node/result", nodeAuth, express.json({ limit: "8mb" }), (req, res) => {
    const parsed = NodeResultRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      jsonError(res, 400, "invalid_result", "Invalid node result.", parsed.error.flatten());
      return;
    }
    const { nodeId, requestId, status, body } = parsed.data;
    markNodeSeen(nodeId);
    const record = pending.get(requestId);
    if (!record || record.nodeId !== nodeId) {
      jsonError(res, 404, "request_not_found", "Pending invocation was not found.");
      return;
    }
    clearTimeout(record.timer);
    pending.delete(requestId);
    record.resolve({ status, body });
    res.json({ ok: true });
  });

  app.get("/v1/nodes", clientAuth, (_req, res) => {
    const now = Date.now();
    const nodes = [...lastSeen.entries()]
      .map(([nodeId, seenAt]) => ({
        nodeId,
        online: now - seenAt <= NODE_ONLINE_TTL_MS,
        lastSeenAt: new Date(seenAt).toISOString(),
        queued: queues.get(nodeId)?.length ?? 0
      }))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    res.json({ ok: true, nodes, defaultNode: defaultNode || null });
  });

  app.get("/v1/health", clientAuth, (_req, res) => {
    res.json({
      ok: true,
      name: "CodexPro Gateway",
      version: 1,
      defaultNode: defaultNode || null,
      onlineNodes: [...lastSeen.keys()].filter(nodeOnline).length
    });
  });

  app.post("/v1/invoke", clientAuth, express.json({ limit: "2mb" }), async (req, res) => {
    const parsed = InvokeRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      jsonError(res, 400, "invalid_request", "Invalid gateway invocation.", parsed.error.flatten());
      return;
    }

    const nodeId = parsed.data.nodeId ?? defaultNode;
    if (!nodeId) {
      jsonError(res, 400, "node_required", "nodeId is required when CODEXPRO_GATEWAY_DEFAULT_NODE is not configured.");
      return;
    }
    if (!nodeOnline(nodeId)) {
      jsonError(res, 503, "node_offline", `CodexPro node is offline: ${nodeId}`);
      return;
    }

    const requestId = randomUUID();
    const resultPromise = new Promise<GatewayResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({
          status: 504,
          body: { ok: false, error: { code: "gateway_timeout", message: "CodexPro node did not return a result before timeout." } }
        });
      }, INVOCATION_TIMEOUT_MS);
      timer.unref();
      pending.set(requestId, { nodeId, timer, resolve });
    });

    const queued = enqueue({
      requestId,
      nodeId,
      action: parsed.data.action,
      args: parsed.data.args ?? {},
      createdAt: Date.now()
    });
    if (!queued) {
      const record = pending.get(requestId);
      if (record) clearTimeout(record.timer);
      pending.delete(requestId);
      jsonError(res, 429, "node_queue_full", `Too many pending jobs for node: ${nodeId}`);
      return;
    }

    const result = await resultPromise;
    if (result.body && typeof result.body === "object") {
      res.status(result.status).json(result.body);
      return;
    }
    res.status(result.status).send(String(result.body ?? ""));
  });

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!error || typeof error !== "object" || !("type" in error)) {
      next(error);
      return;
    }
    const type = String((error as { type?: unknown }).type ?? "");
    if (type !== "entity.parse.failed" && type !== "entity.too.large") {
      next(error);
      return;
    }
    jsonError(
      res,
      type === "entity.too.large" ? 413 : 400,
      type === "entity.too.large" ? "payload_too_large" : "invalid_json",
      type === "entity.too.large" ? "Request body is too large." : "Request body must be valid JSON."
    );
  });

  app.listen(port, host, () => {
    console.error(`[CodexProGateway] listening on http://${host}:${port}`);
    console.error(`[CodexProGateway] defaultNode=${defaultNode || "(none)"}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
