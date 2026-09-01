import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { create9RouterProvider, createOpenAICompatibleProvider, createOpenRouterProvider, normalizeProviderBaseUrl } from "../manager/electron/provider-core/openai-compatible-provider.mjs";
import { runMcpAgentJob } from "../manager/electron/worker-core/mcp-agent-loop.mjs";
import { WorkerPluginRegistry } from "../manager/electron/worker-core/plugin-registry.mjs";
import { createApiWorkerPlugin } from "../manager/electron/worker-plugins/api-worker-plugin.mjs";
import { createWorkerMcpClients } from "../manager/electron/mcp/http-client.mjs";

const secret = "sk-" + "A".repeat(36);
const requests = [];
let completionTurn = 0;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyText = Buffer.concat(chunks).toString("utf8");
  const body = bodyText ? JSON.parse(bodyText) : {};
  requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
  if (req.url?.startsWith("/mcp")) {
    if (req.method === "DELETE") {
      res.statusCode = 200;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.setHeader("mcp-session-id", req.headers["mcp-session-id"] || `fixture-session-${requests.length}`);
    if (body.method === "initialize") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } }));
      return;
    }
    if (body.method === "tools/list") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "fixture_tool", description: "fixture", inputSchema: { type: "object" } }] } }));
      return;
    }
    if (body.method === "tools/call") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true, tool: body.params?.name } } }));
      return;
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", result: {} }));
    return;
  }
  if (req.url === "/v1/models") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "fixture/model", context_length: 32_000 }] }));
    return;
  }
  if (req.url === "/v1/redirect") {
    res.statusCode = 302;
    res.setHeader("location", "/v1/models");
    res.end();
    return;
  }
  if (req.url !== "/v1/chat/completions") {
    res.statusCode = 404;
    res.end("missing");
    return;
  }
  if (body.model === "fixture/error") {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: `[openai-compatible][400]: ${JSON.stringify({ error: { message: `The tool_choice parameter is unsupported: ${secret}` } })}` } }));
    return;
  }
  if (body.model === "fixture/redirect") {
    res.statusCode = 302;
    res.setHeader("location", "/v1/models");
    res.end();
    return;
  }
  if (body.model === "fixture/oversize") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("content-length", "2048");
    res.end(" ".repeat(2048));
    return;
  }
  if (body.model === "fixture/stream") {
    res.setHeader("content-type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ id: "stream-1", choices: [{ delta: { content: "xin " } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "stream-1", choices: [{ delta: { content: "chào" }, finish_reason: "stop" }], usage: { total_tokens: 5 } })}\n\n`);
    res.end("data: [DONE]\n\n");
    return;
  }
  completionTurn += 1;
  res.setHeader("content-type", "application/json");
  if (completionTurn === 1) {
    res.end(JSON.stringify({
      id: "completion-title",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call-title", type: "function", function: { name: "begin_repo_task", arguments: JSON.stringify({ task_id: "ignored", task_title: "Đọc tài liệu dự án", task_kind: "code", root: "ignored" }) } }]
        }
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }));
    return;
  }
  if (completionTurn === 2) {
    res.end(JSON.stringify({
      id: "completion-1",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call-read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) } }]
        }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
    }));
    return;
  }
  res.end(JSON.stringify({
    id: "completion-2",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Đã đọc README hoàn toàn qua MCP." } }],
    usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 }
  }));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP port");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;

try {
  assert.throws(() => normalizeProviderBaseUrl("http://provider.example/v1"), /HTTPS/);
  assert.throws(() => normalizeProviderBaseUrl("https://user:pass@provider.example/v1"), /credentials/);

  const provider = createOpenAICompatibleProvider({
    id: "fixture",
    baseUrl,
    model: "fixture/model",
    getApiKey: async () => secret,
    timeoutMs: 5_000,
    maxResponseBytes: 64 * 1024
  });
  const models = await provider.listModels();
  assert.deepEqual(models.map((item) => item.id), ["fixture/model"]);
  assert.equal(requests[0].authorization, `Bearer ${secret}`);

  const httpClients = await createWorkerMcpClients({
    url: `http://127.0.0.1:${address.port}/mcp`,
    token: "fixture-mcp-token",
    workerId: "api:fixture-main",
    timeoutMs: 5_000
  });
  try {
    assert.deepEqual((await httpClients.jobMcp.listTools()).map((tool) => tool.name), ["fixture_tool"]);
    assert.deepEqual(await httpClients.jobMcp.callTool("fixture_tool", { value: 1 }), { ok: true, tool: "fixture_tool" });
    assert.equal(requests.some((request) => request.url?.includes("codexpro_profile=api%3Afixture-main")), true, "job MCP session must bind the namespaced API worker id");
  } finally {
    await Promise.all([httpClients.jobMcp.close(), httpClients.controlMcp.close()]);
  }

  const calls = [];
  const controlMcp = {
    async callTool(name, args) {
      calls.push({ channel: "control", name, args });
      assert.equal(name, "prepare_repo_task");
      assert.equal(args.profile_id, "api:fixture-main");
      return { prepared: true };
    }
  };
  const jobMcp = {
    async listTools() {
      calls.push({ channel: "job", name: "tools/list" });
      return [
        { name: "begin_repo_task", description: "AI must choose and register a 4-6 word task title.", inputSchema: { type: "object", properties: { task_title: { type: "string" } }, required: ["task_title"] } },
        { name: "read", description: "Read an allowed workspace file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
        { name: "finalize_worker_job", description: "internal lifecycle", inputSchema: { type: "object" } }
      ];
    },
    async callTool(name, args) {
      calls.push({ channel: "job", name, args });
      if (name === "begin_repo_task") {
        return {
          verified: true,
          gate_active: true,
          global_rules_loaded: true,
          agents_loaded: true,
          agents_files: ["AGENTS.md"],
          codexgraph_active: true,
          policy_version: "worker-policy-v1",
          task_title: "Đọc tài liệu dự án",
          task_kind: "code",
          root: "C:\\fixture",
          worker_job: { missing_obligations: [] }
        };
      }
      if (name === "read") return { text: "# Fixture README\nMCP-only content" };
      if (name === "finalize_worker_job") return { finalized: true, job: { status: args.outcome } };
      throw new Error(`unexpected MCP tool ${name}`);
    }
  };

  const result = await runMcpAgentJob({
    provider,
    controlMcp,
    jobMcp,
    job: {
      id: "cpt_1234567890abcdef12345678",
      workerId: "api:fixture-main",
      kind: "code",
      scope: "workspace",
      root: "C:\\fixture"
    },
    request: "Đọc README và tóm tắt.",
    limits: { maxTurns: 4, maxToolCalls: 4 }
  });

  assert.equal(result.text, "Đã đọc README hoàn toàn qua MCP.");
  assert.equal(result.task_title, "Đọc tài liệu dự án");
  assert.equal(result.usage.total_tokens, 45);
  assert.deepEqual(calls.map((call) => `${call.channel}:${call.name}`), [
    "control:prepare_repo_task",
    "job:tools/list",
    "job:begin_repo_task",
    "job:read",
    "job:finalize_worker_job"
  ]);
  const completionRequests = requests.filter((request) => request.url === "/v1/chat/completions");
  assert.deepEqual(completionRequests[0].body.tools.map((tool) => tool.function.name), ["begin_repo_task"], "AI title bootstrap must expose only begin_repo_task");
  assert.equal(completionRequests[0].body.tool_choice, "auto", "thinking models must not receive unsupported tool_choice=required");
  assert.equal(completionRequests[1].body.tools[0].function.name, "read");
  assert.equal(completionRequests[1].body.tools.some((tool) => tool.function.name === "begin_repo_task" || tool.function.name === "finalize_worker_job"), false, "provider must not receive MCP lifecycle tools after bootstrap");
  assert.match(completionRequests[2].body.messages.findLast((message) => message.role === "tool")?.content || "", /MCP-only content/);

  const failingProvider = createOpenAICompatibleProvider({ baseUrl, model: "fixture/error", getApiKey: async () => secret });
  await assert.rejects(
    () => failingProvider.complete({ messages: [{ role: "user", content: "fail" }] }),
    (error) => /Provider HTTP 401: The tool_choice parameter is unsupported/.test(error.message) && !error.message.includes(secret) && !error.message.includes('\\"error\\"')
  );
  const redirectProvider = createOpenAICompatibleProvider({ baseUrl, model: "fixture/redirect", getApiKey: async () => secret });
  await assert.rejects(() => redirectProvider.complete({ messages: [{ role: "user", content: "redirect" }] }), /fetch|redirect/i);
  const oversizedProvider = createOpenAICompatibleProvider({ baseUrl, model: "fixture/oversize", getApiKey: async () => secret, maxResponseBytes: 1024 });
  await assert.rejects(() => oversizedProvider.complete({ messages: [{ role: "user", content: "oversize" }] }), /size limit/);
  const requestLimitedProvider = createOpenAICompatibleProvider({ baseUrl, model: "fixture/model", getApiKey: async () => secret, maxRequestBytes: 1024 });
  await assert.rejects(() => requestLimitedProvider.complete({ messages: [{ role: "user", content: "x".repeat(2_000) }] }), /request.*size limit/i);
  const streamDeltas = [];
  const streamProvider = createOpenAICompatibleProvider({ baseUrl, model: "fixture/stream", getApiKey: async () => secret });
  const streamed = await streamProvider.complete({ messages: [{ role: "user", content: "stream" }], onDelta: (delta) => streamDeltas.push(delta.text) });
  assert.equal(streamed.text, "xin chào");
  assert.deepEqual(streamDeltas, ["xin ", "chào"]);
  assert.equal(streamed.usage.total_tokens, 5);

  const nineRouter = create9RouterProvider({
    baseUrl,
    model: "fixture/model",
    getApiKey: async () => secret
  });
  assert.equal(nineRouter.manifest.kind, "9router");
  assert.equal(nineRouter.manifest.name, "9Router");
  assert.equal(nineRouter.manifest.capabilities.tool_calling, true);

  const openRouter = createOpenRouterProvider({
    baseUrl,
    model: "fixture/model",
    getApiKey: async () => secret,
    appName: "CodexPro",
    appUrl: "https://example.invalid/codexpro",
    routing: { allow_fallbacks: false }
  });
  assert.equal(openRouter.manifest.kind, "openrouter");
  assert.equal(openRouter.manifest.capabilities.tool_calling, true);

  const apiLifecycle = [];
  const apiCallArgs = [];
  const apiProviderInputs = [];
  const apiPlugin = createApiWorkerPlugin({
    configurations: [{ id: "fixture-api", label: "Fixture API", provider: "9router", model: "fixture/model", credential_available: true }],
    createProvider: async () => {
      let turn = 0;
      return {
        manifest: { id: "fixture-api-provider", name: "Fixture", kind: "fixture", capabilities: { tool_calling: true } },
        async complete(input) {
          apiProviderInputs.push(input);
          turn += 1;
          if (turn === 1) throw Object.assign(new Error("Provider HTTP 429: reset after 1ms"), { status: 429, retryAfterMs: 1 });
          if (turn <= 3) return { text: "Tôi chưa phát tool call.", toolCalls: [], usage: { total_tokens: 1 } };
          if (turn === 4) return { text: '{"task_title":"Trả lời yêu cầu API","root":"C:\\\\fixture"}', toolCalls: [], usage: { total_tokens: 2 } };
          return { text: "API worker hoàn tất.", toolCalls: [], usage: { total_tokens: 3 } };
        }
      };
    },
    createMcpClients: async () => ({
      controlMcp: {
        async callTool(name, args) { apiLifecycle.push(`control:${name}`); apiCallArgs.push({ name, args }); return { prepared: true }; },
        async close() { apiLifecycle.push("control:close"); }
      },
      jobMcp: {
        async listTools() { apiLifecycle.push("job:tools/list"); return [{ name: "begin_repo_task", description: "title", inputSchema: { type: "object", properties: { task_title: { type: "string" } }, required: ["task_title"] } }, { name: "read", description: "read", inputSchema: { type: "object" } }]; },
        async callTool(name, args) {
          apiLifecycle.push(`job:${name}`);
          apiCallArgs.push({ name, args });
          if (name === "begin_repo_task") return { verified: true, gate_active: true, global_rules_loaded: true, agents_loaded: true, codexgraph_active: true, task_title: "Trả lời yêu cầu API", task_kind: "code", root: "C:\\fixture", policy_version: "worker-policy-v1" };
          if (name === "finalize_worker_job") return { finalized: true, job: { status: args.outcome } };
          throw new Error(`unexpected API fixture tool ${name}`);
        },
        async close() { apiLifecycle.push("job:close"); }
      }
    })
  });
  const registry = new WorkerPluginRegistry();
  registry.register(apiPlugin);
  const before = await registry.list();
  assert.equal(before.workers[0].worker_id, "api:fixture-api");
  assert.equal(before.workers[0].worker_type, "api");
  const accepted = await registry.invoke("send", "api:fixture-api", {
    task_id: "cpt_abcdefabcdefabcdefabcdef",
    task_kind: "code",
    scope: "all_allowed",
    workspaceCandidates: ["C:\\fixture"],
    text: "Trả lời trong repo."
  });
  assert.equal(accepted.accepted, true);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await registry.invoke("read", "api:fixture-api");
    if (state.activity !== "working") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const after = await registry.invoke("read", "api:fixture-api");
  assert.equal(after.activity, "idle");
  assert.equal(after.task_title, "Trả lời yêu cầu API");
  assert.equal(after.result.text, "API worker hoàn tất.");
  const listedAfter = await registry.list();
  assert.equal(listedAfter.workers[0].last_result, "API worker hoàn tất.");
  assert.equal(listedAfter.workers[0].last_task_id, "cpt_abcdefabcdefabcdefabcdef");
  assert.deepEqual(apiCallArgs.find((call) => call.name === "prepare_repo_task")?.args, { profile_id: "api:fixture-api", task_id: "cpt_abcdefabcdefabcdefabcdef", scope: "all_allowed" });
  assert.equal(apiCallArgs.find((call) => call.name === "begin_repo_task")?.args.root, "C:\\fixture", "all-allowed API jobs must bind the AI-selected allowed workspace through MCP");
  assert.equal(apiProviderInputs[0].tools.length, 1, "bootstrap attempt one must expose only begin_repo_task");
  assert.equal(apiProviderInputs[1].tools.length, 1, "rate-limited bootstrap must retry the same MCP request");
  assert.equal(apiProviderInputs[2].tools.length, 1, "bootstrap retry must still prefer the MCP tool call");
  assert.deepEqual(apiProviderInputs[3].tools, [], "thinking-model fallback must request strict JSON without unsupported forced tool choice");
  assert.deepEqual(apiLifecycle, [
    "control:prepare_repo_task",
    "job:tools/list",
    "job:begin_repo_task",
    "job:finalize_worker_job",
    "job:close",
    "control:close"
  ]);
  const continued = await registry.invoke("send", "api:fixture-api", {
    task_id: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb",
    task_kind: "code",
    scope: "all_allowed",
    workspaceCandidates: ["C:\\fixture"],
    text: "Nhắn tiếp trong cùng repo."
  });
  assert.equal(continued.accepted, true);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await registry.invoke("read", "api:fixture-api")).activity !== "working") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(apiProviderInputs.at(-1).messages.some((message) => message.role === "assistant" && message.content === "API worker hoàn tất."), true, "Nhắn tiếp must preserve the previous worker response in the same repo");

  const rejectedLifecycle = [];
  let rejectedTurn = 0;
  await assert.rejects(() => runMcpAgentJob({
    provider: {
      manifest: { id: "malicious-fixture", name: "Malicious fixture", kind: "fixture", capabilities: { tool_calling: true } },
      async complete() {
        rejectedTurn += 1;
        if (rejectedTurn === 1) return { text: "", toolCalls: [{ id: "title", name: "begin_repo_task", arguments: { task_title: "Chặn tool nội bộ" } }] };
        return { text: "", toolCalls: [{ id: "bad", name: "finalize_worker_job", arguments: { outcome: "completed" } }] };
      }
    },
    controlMcp: { async callTool(name) { rejectedLifecycle.push(`control:${name}`); return { prepared: true }; } },
    jobMcp: {
      async listTools() { return [{ name: "begin_repo_task", description: "title", inputSchema: { type: "object" } }, { name: "read", description: "read", inputSchema: { type: "object" } }]; },
      async callTool(name, args) {
        rejectedLifecycle.push(`job:${name}:${args?.outcome || ""}`);
        if (name === "begin_repo_task") return { verified: true, task_title: "Chặn tool nội bộ", task_kind: "general" };
        if (name === "finalize_worker_job" && args.outcome === "failed") return { finalized: true };
        throw new Error("lifecycle bypass reached MCP");
      }
    },
    job: { id: "cpt_111111111111111111111111", workerId: "api:fixture-main", kind: "general", scope: "all_allowed" },
    request: "Attempt lifecycle bypass"
  }), /not allowed/);
  assert.deepEqual(rejectedLifecycle, ["control:prepare_repo_task", "job:begin_repo_task:", "job:finalize_worker_job:failed"]);

  const cancellationLifecycle = [];
  let cancellationTurn = 0;
  const cancellationRegistry = new WorkerPluginRegistry();
  cancellationRegistry.register(createApiWorkerPlugin({
    configurations: [{ id: "cancel-api", provider: "9router", model: "fixture/model", credential_available: true }],
    createProvider: async () => ({
      manifest: { id: "cancel-provider", name: "Cancel fixture", kind: "fixture", capabilities: { tool_calling: true } },
      async complete({ signal }) {
        cancellationTurn += 1;
        if (cancellationTurn === 1) return { text: "", toolCalls: [{ id: "cancel-title", name: "begin_repo_task", arguments: { task_title: "Hủy API worker" } }] };
        return await new Promise((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    }),
    createMcpClients: async () => ({
      controlMcp: { async callTool(name) { cancellationLifecycle.push(`control:${name}`); return { prepared: true }; }, async close() {} },
      jobMcp: {
        async listTools() { return [{ name: "begin_repo_task", description: "title", inputSchema: { type: "object" } }]; },
        async callTool(name, args) {
          cancellationLifecycle.push(`job:${name}:${args?.outcome || ""}`);
          if (name === "begin_repo_task") return { verified: true, task_title: "Hủy API worker", task_kind: "general" };
          if (name === "finalize_worker_job") return { finalized: true };
          throw new Error(`unexpected cancellation tool ${name}`);
        },
        async close() {}
      }
    })
  }));
  const cancelPayload = { task_id: "cpt_222222222222222222222222", task_kind: "general", scope: "all_allowed", text: "Wait" };
  await cancellationRegistry.invoke("send", "api:cancel-api", cancelPayload);
  await assert.rejects(() => cancellationRegistry.invoke("send", "api:cancel-api", { ...cancelPayload, task_id: "cpt_333333333333333333333333" }), /already running/);
  assert.equal((await cancellationRegistry.invoke("stop", "api:cancel-api")).stopped, true);
  assert.equal(cancellationLifecycle.includes("job:finalize_worker_job:cancelled"), true, "cancellation must finalize through MCP policy");

  console.log("✓ Provider plugin and MCP-only agent loop smoke test passed");
} finally {
  server.close();
  await once(server, "close");
}
