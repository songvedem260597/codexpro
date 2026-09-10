import assert from "node:assert/strict";
import { z } from "zod";
import { CodexProError } from "../src/guard.js";
import { createToolRegistrationRuntime } from "../src/toolRegistration.js";

function modernServer() {
  const registrations = [];
  return {
    registrations,
    registerTool(name, options, handler) {
      registrations.push({ name, options, handler });
    }
  };
}

function legacyServer() {
  const registrations = [];
  return {
    registrations,
    tool(name, description, inputSchema, handler) {
      registrations.push({ name, description, inputSchema, handler });
    }
  };
}

function createHarness(overrides = {}) {
  const usage = [];
  const traces = [];
  const events = [];
  const filtered = new Set(overrides.filtered ?? []);
  const runtime = createToolRegistrationRuntime({
    shouldRegisterTool: (_config, name) => !filtered.has(name),
    descriptorOptionsForConfig: (_config, name, options) => {
      events.push(`descriptor:${name}`);
      return overrides.descriptorOptionsForConfig?.(_config, name, options) ?? options;
    },
    assertRepoTaskGate: (_server, name) => {
      events.push(`gate:${name}`);
      if (overrides.gateError) throw overrides.gateError;
    },
    runtimeTraceWorkspaceForServer: () => overrides.workspace ?? { id: "ws_tool_registration", root: "C:/fixture" },
    recordMcpUsage: (tool, args, result, status, durationMs) => {
      usage.push({ tool, args, result, status, durationMs });
      overrides.recordMcpUsage?.(tool, args, result, status, durationMs);
    },
    recordRuntimeTraceSpan: async (workspace, input) => {
      traces.push({ workspace, input });
      if (overrides.traceError) throw overrides.traceError;
      return { workspace, input };
    }
  });
  return { runtime, usage, traces, events };
}

const config = {};

{
  const { runtime, usage, traces, events } = createHarness();
  const server = modernServer();
  runtime.initializeServer(server);
  runtime.registerCodexTool(config, server, "echo", {
    title: "Echo Tool",
    description: "Echo input",
    inputSchema: { value: z.string() },
    _meta: { marker: true }
  }, async (args) => {
    events.push("handler:echo");
    return { content: [{ type: "text", text: args.value }], structuredContent: { value: args.value } };
  });

  assert.deepEqual(runtime.registeredToolNames(server), ["echo"]);
  assert.equal(typeof runtime.registeredToolHandler(server, "echo"), "function");
  assert.equal(server.registrations.length, 1);
  const registration = server.registrations[0];
  assert.equal(registration.name, "echo");
  assert.deepEqual(registration.options.securitySchemes, [{ type: "noauth" }]);
  assert.deepEqual(registration.options._meta.securitySchemes, [{ type: "noauth" }]);
  assert.equal(registration.options._meta.marker, true);

  const result = await registration.handler({ value: "ok", ignored: "strip-me" });
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
  assert.deepEqual(result.structuredContent, { codexpro_tool: "echo", codexpro_title: "Echo Tool", value: "ok" });
  assert.deepEqual(events.slice(-2), ["gate:echo", "handler:echo"], "repo gate must run before the handler");
  assert.equal(usage.at(-1).tool, "echo");
  assert.deepEqual(usage.at(-1).args, { value: "ok", ignored: "strip-me" }, "usage must receive raw SDK args");
  assert.equal(usage.at(-1).status, "ok");
  assert.equal(traces.at(-1).input.status, "ok");
  assert.equal(traces.at(-1).input.name, "echo");
  assert.equal(traces.at(-1).input.source, "mcp-tool");
  assert.equal(traces.at(-1).workspace.id, "ws_tool_registration");
}

{
  const { runtime, events } = createHarness();
  const server = modernServer();
  runtime.initializeServer(server);
  let handlerCalled = false;
  runtime.registerCodexTool(config, server, "validated", { inputSchema: { count: z.number().int() } }, () => {
    handlerCalled = true;
    return { structuredContent: {} };
  });
  const directHandler = runtime.registeredToolHandler(server, "validated");
  assert.throws(
    () => directHandler({ count: "bad" }),
    (error) => error instanceof CodexProError && error.message.includes("Invalid arguments for validated: count: Expected number, received string")
  );
  assert.equal(handlerCalled, false);
  assert.equal(events.at(-1), "gate:validated", "gate must run before zod validation");
  const wrappedError = await server.registrations[0].handler({ count: "bad" });
  assert.equal(wrappedError.isError, true);
  assert.equal(wrappedError.structuredContent.codexpro_tool, "validated");
  assert.equal(wrappedError.structuredContent.error.name, "CodexProError");
  assert.match(wrappedError.structuredContent.error.message, /Invalid arguments for validated: count: Expected number, received string/);
}

{
  const { runtime } = createHarness();
  const noSchema = modernServer();
  runtime.initializeServer(noSchema);
  runtime.registerCodexTool(config, noSchema, "no_schema", {}, (args) => ({ structuredContent: { args } }));
  assert.deepEqual((await noSchema.registrations[0].handler({ keep: true })).structuredContent.args, { keep: true });
  assert.deepEqual((await noSchema.registrations[0].handler(null)).structuredContent.args, {});

  const emptySchema = modernServer();
  runtime.initializeServer(emptySchema);
  runtime.registerCodexTool(config, emptySchema, "empty_schema", { inputSchema: {} }, (args) => ({ structuredContent: { args } }));
  assert.deepEqual((await emptySchema.registrations[0].handler({ removed: true })).structuredContent.args, {});
}

{
  const { runtime } = createHarness();
  const server = modernServer();
  runtime.initializeServer(server);
  runtime.registerCodexTool(config, server, "merge_order", { title: "Outer Title" }, () => ({
    structuredContent: { codexpro_tool: "inner_tool", codexpro_title: "Inner Title", keep: true }
  }));
  const result = await server.registrations[0].handler({});
  assert.equal(result.structuredContent.codexpro_tool, "inner_tool", "existing structuredContent must win merge order");
  assert.equal(result.structuredContent.codexpro_title, "Inner Title");
  assert.equal(result.structuredContent.keep, true);
}

{
  const { runtime } = createHarness({
    descriptorOptionsForConfig: (_config, _name, options) => ({
      ...options,
      _meta: { ...(options._meta ?? {}), "openai/outputTemplate": "ui://fixture" }
    })
  });
  const server = modernServer();
  runtime.initializeServer(server);
  runtime.registerCodexTool(config, server, "ui_tool", { title: "UI Tool" }, () => ({
    structuredContent: { long: "x".repeat(30_001) }
  }));
  const result = await server.registrations[0].handler({});
  assert.equal(result.structuredContent.long.length, 30_000 + "\n...[structured field truncated to 30000 chars]".length);
  assert.ok(result.structuredContent.long.endsWith("\n...[structured field truncated to 30000 chars]"));
}

{
  const { runtime, usage, traces } = createHarness();
  const server = modernServer();
  runtime.initializeServer(server);
  runtime.registerCodexTool(config, server, "throws", { title: "Throws" }, () => {
    throw new Error("boom");
  });
  const result = await server.registrations[0].handler({ action: "  explode  " });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.codexpro_tool, "throws");
  assert.equal(result.structuredContent.error.message, "Error: boom");
  assert.equal(usage.at(-1).status, "error");
  assert.equal(traces.at(-1).input.status, "error");
  assert.equal(traces.at(-1).input.action, "explode");
}

{
  const { runtime } = createHarness({ traceError: new Error("trace sink unavailable") });
  const server = modernServer();
  runtime.initializeServer(server);
  runtime.registerCodexTool(config, server, "trace_tolerant", {}, () => ({ structuredContent: { ok: true } }));
  const result = await server.registrations[0].handler({});
  assert.equal(result.structuredContent.ok, true, "trace recording failures must not fail the tool");
}

{
  const { runtime } = createHarness();
  const server = modernServer();
  runtime.initializeServer(server);
  const customTop = [{ type: "oauth2" }];
  const customMeta = [{ type: "custom-meta" }];
  runtime.registerCodexTool(config, server, "security_merge", {
    securitySchemes: customTop,
    _meta: { securitySchemes: customMeta, marker: "kept" }
  }, () => ({ structuredContent: {} }));
  assert.equal(server.registrations[0].options.securitySchemes, customTop, "options must retain top-level merge precedence");
  assert.equal(server.registrations[0].options._meta.securitySchemes, customMeta, "_meta must retain merge precedence");
  assert.equal(server.registrations[0].options._meta.marker, "kept");
}

{
  const { runtime } = createHarness();
  const server = legacyServer();
  runtime.initializeServer(server);
  const schema = { value: z.string() };
  runtime.registerCodexTool(config, server, "legacy", { description: "Legacy description", inputSchema: schema }, (args) => ({ structuredContent: args }));
  assert.equal(server.registrations.length, 1);
  assert.equal(server.registrations[0].name, "legacy");
  assert.equal(server.registrations[0].description, "Legacy description");
  assert.equal(server.registrations[0].inputSchema, schema);
  assert.equal((await server.registrations[0].handler({ value: "ok" })).structuredContent.value, "ok");
}

{
  const { runtime } = createHarness();
  const unsupported = {};
  runtime.initializeServer(unsupported);
  assert.throws(
    () => runtime.registerCodexTool(config, unsupported, "unsupported", {}, () => ({})),
    /Unsupported MCP SDK: McpServer has neither registerTool nor tool\./
  );
  assert.deepEqual(runtime.registeredToolNames(unsupported), []);
  assert.equal(runtime.registeredToolHandler(unsupported, "unsupported"), undefined);
}

{
  const { runtime, events } = createHarness({ filtered: ["blocked"] });
  const server = modernServer();
  runtime.initializeServer(server);
  runtime.registerCodexTool(config, server, "blocked", {}, () => ({}));
  assert.equal(server.registrations.length, 0);
  assert.deepEqual(runtime.registeredToolNames(server), []);
  assert.equal(runtime.registeredToolHandler(server, "blocked"), undefined);
  assert.equal(events.length, 0, "filter must prevent descriptor/gate/handler registration work");
}

{
  const { runtime } = createHarness();
  const server = modernServer();
  runtime.initializeServer(server);
  runtime.registerCodexTool(config, server, "duplicate", {}, () => ({ structuredContent: { version: 1 } }));
  const firstHandler = runtime.registeredToolHandler(server, "duplicate");
  runtime.registerCodexTool(config, server, "duplicate", {}, () => ({ structuredContent: { version: 2 } }));
  const secondHandler = runtime.registeredToolHandler(server, "duplicate");
  assert.deepEqual(runtime.registeredToolNames(server), ["duplicate"], "registered tool names must remain unique and ordered");
  assert.notEqual(firstHandler, secondHandler, "registered handler lookup must track the latest registration");
}

console.log("tool-registration smoke passed");
