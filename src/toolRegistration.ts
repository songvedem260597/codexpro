import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { CodexProError, type Workspace } from "./guard.js";
import {
  createRuntimeTraceContext,
  recordRuntimeTraceSpan as defaultRecordRuntimeTraceSpan,
  runWithRuntimeTraceContext,
  type RuntimeTraceContext,
  type RuntimeTraceSpanInput
} from "./analysis/runtimeTrace.js";
import { compactStructuredContent, errorResult } from "./toolResults.js";

export type CodexToolHandler = (args: any) => Promise<any> | any;

type ToolRegistrationHooks = {
  shouldRegisterTool: (config: CodexProConfig, name: string) => boolean;
  descriptorOptionsForConfig: (config: CodexProConfig, name: string, options: Record<string, unknown>) => Record<string, unknown>;
  assertRepoTaskGate: (server: McpServer, name: string) => void;
  runtimeTraceWorkspaceForServer: (server: McpServer) => Workspace | undefined;
  recordMcpUsage: (tool: string, args: unknown, result: unknown, status: "ok" | "error", durationMs: number) => void;
  recordRuntimeTraceSpan?: (workspace: Workspace, input: RuntimeTraceSpanInput) => Promise<unknown>;
};

export function createToolRegistrationRuntime(hooks: ToolRegistrationHooks) {
  const registeredToolHandlersByServer = new WeakMap<object, Map<string, CodexToolHandler>>();
  const registeredToolNamesByServer = new WeakMap<object, string[]>();
  const recordRuntimeTraceSpan = hooks.recordRuntimeTraceSpan ?? defaultRecordRuntimeTraceSpan;

  function validateToolArgs(name: string, options: Record<string, unknown>, args: unknown): any {
    const inputSchema = options.inputSchema;
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return args ?? {};
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(inputSchema)) {
      if (value && typeof (value as { safeParse?: unknown }).safeParse === "function") {
        shape[key] = value as z.ZodTypeAny;
      }
    }
    if (!Object.keys(shape).length) return {};
    const parsed = z.object(shape).safeParse(args ?? {});
    if (parsed.success) return parsed.data;
    const details = parsed.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "arguments"}: ${issue.message}`)
      .join("; ");
    throw new CodexProError(`Invalid arguments for ${name}: ${details}`);
  }

  function tagToolResult(result: any, name: string, options: Record<string, unknown>): any {
    if (!result || typeof result !== "object") return result;
    const structured = result.structuredContent;
    const base =
      structured && typeof structured === "object" && !Array.isArray(structured)
        ? structured
        : {};
    const tagged = {
      codexpro_tool: name,
      codexpro_title: options.title ?? name,
      ...base
    };
    const meta = (options._meta as Record<string, unknown> | undefined) ?? {};
    result.structuredContent = meta.ui || meta["openai/outputTemplate"] ? compactStructuredContent(tagged) : tagged;
    return result;
  }

  function toolCallLoggingEnabled(): boolean {
    return process.env.CODEXPRO_LOG_TOOL_CALLS === "1" || process.env.CODEXPRO_LOG_REQUESTS === "1";
  }

  function logToolCall(name: string, status: "ok" | "error", started: number): void {
    if (!toolCallLoggingEnabled()) return;
    console.error(`[CodexProTool] ${name} ${status} ${Date.now() - started}ms`);
  }

  function rememberRegisteredToolHandler(server: McpServer, name: string, handler: CodexToolHandler): void {
    const key = server as object;
    const handlers = registeredToolHandlersByServer.get(key) ?? new Map<string, CodexToolHandler>();
    if (!registeredToolHandlersByServer.has(key)) registeredToolHandlersByServer.set(key, handlers);
    handlers.set(name, handler);
  }

  function registeredToolHandler(server: McpServer, name: string): CodexToolHandler | undefined {
    return registeredToolHandlersByServer.get(server as object)?.get(name);
  }

  async function recordToolRuntimeTrace(
    server: McpServer,
    name: string,
    args: any,
    status: "ok" | "error",
    startedAtMs: number,
    endedAtMs: number,
    context?: RuntimeTraceContext
  ): Promise<void> {
    let workspace: Workspace | undefined;
    try {
      workspace = hooks.runtimeTraceWorkspaceForServer(server);
    } catch {
      workspace = undefined;
    }
    if (!workspace) return;
    const matchingContext = context?.workspaceId === workspace.id ? context : undefined;
    const rawAction = typeof args?.action === "string" ? args.action.trim() : "";
    await recordRuntimeTraceSpan(workspace, {
      ...(matchingContext ? { traceId: matchingContext.traceId, spanId: matchingContext.spanId } : {}),
      kind: "tool",
      name,
      ...(rawAction ? { action: rawAction.slice(0, 160) } : {}),
      source: "mcp-tool",
      status,
      startedAtMs,
      endedAtMs
    }).catch(() => undefined);
  }

  function registerToolCompat(
    server: McpServer,
    name: string,
    options: Record<string, unknown>,
    handler: CodexToolHandler
  ): void {
    const wrapped = async (args: any) => {
      const started = Date.now();
      const usageArgs = args ?? {};
      let initialWorkspace: Workspace | undefined;
      try {
        initialWorkspace = hooks.runtimeTraceWorkspaceForServer(server);
      } catch {
        initialWorkspace = undefined;
      }
      const traceContext = initialWorkspace ? createRuntimeTraceContext(initialWorkspace) : undefined;
      const invokeHandler = () => handler(usageArgs);
      try {
        const handled = traceContext
          ? await runWithRuntimeTraceContext(traceContext, invokeHandler)
          : await invokeHandler();
        const result = tagToolResult(handled, name, options);
        const status = result?.isError ? "error" : "ok";
        const durationMs = Date.now() - started;
        logToolCall(name, status, started);
        hooks.recordMcpUsage(name, usageArgs, result, status, durationMs);
        await recordToolRuntimeTrace(server, name, usageArgs, status, started, started + durationMs, traceContext);
        return result;
      } catch (error) {
        const result = tagToolResult(errorResult(error), name, options);
        const durationMs = Date.now() - started;
        logToolCall(name, "error", started);
        hooks.recordMcpUsage(name, usageArgs, result, "error", durationMs);
        await recordToolRuntimeTrace(server, name, usageArgs, "error", started, started + durationMs, traceContext);
        return result;
      }
    };

    const securitySchemes = [{ type: "noauth" }];
    const fullOptions: Record<string, unknown> = {
      securitySchemes,
      ...options,
      _meta: {
        securitySchemes,
        ...(options._meta as Record<string, unknown> | undefined)
      }
    };

    const s = server as any;
    if (typeof s.registerTool === "function") {
      s.registerTool(name, fullOptions, wrapped);
      return;
    }

    if (typeof s.tool === "function") {
      s.tool(name, (fullOptions.description as string | undefined) ?? name, fullOptions.inputSchema ?? {}, wrapped);
      return;
    }

    throw new Error("Unsupported MCP SDK: McpServer has neither registerTool nor tool.");
  }

  function rememberRegisteredTool(server: McpServer, name: string): void {
    const key = server as object;
    const names = registeredToolNamesByServer.get(key) ?? [];
    if (!registeredToolNamesByServer.has(key)) registeredToolNamesByServer.set(key, names);
    if (!names.includes(name)) names.push(name);
  }

  function registeredToolNames(server: McpServer): string[] {
    return [...(registeredToolNamesByServer.get(server as object) ?? [])];
  }

  function initializeServer(server: McpServer): void {
    registeredToolNamesByServer.set(server as object, []);
  }

  function registerCodexTool(
    config: CodexProConfig,
    server: McpServer,
    name: string,
    options: Record<string, unknown>,
    handler: CodexToolHandler
  ): void {
    if (!hooks.shouldRegisterTool(config, name)) return;
    const validatedHandler: CodexToolHandler = (args) => {
      hooks.assertRepoTaskGate(server, name);
      return handler(validateToolArgs(name, options, args));
    };
    registerToolCompat(server, name, hooks.descriptorOptionsForConfig(config, name, options), validatedHandler);
    rememberRegisteredTool(server, name);
    rememberRegisteredToolHandler(server, name, validatedHandler);
  }

  return {
    initializeServer,
    registerCodexTool,
    registeredToolHandler,
    registeredToolNames
  };
}
