import { z } from "zod";
import { CodexProError } from "./guard.js";
import { createRuntimeTraceContext, recordRuntimeTraceSpan as defaultRecordRuntimeTraceSpan, runWithRuntimeTraceContext } from "./analysis/runtimeTrace.js";
import { compactStructuredContent, errorResult } from "./toolResults.js";
export function createToolRegistrationRuntime(hooks) {
    const registeredToolHandlersByServer = new WeakMap();
    const registeredToolNamesByServer = new WeakMap();
    const recordRuntimeTraceSpan = hooks.recordRuntimeTraceSpan ?? defaultRecordRuntimeTraceSpan;
    function validateToolArgs(name, options, args) {
        const inputSchema = options.inputSchema;
        if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema))
            return args ?? {};
        const shape = {};
        for (const [key, value] of Object.entries(inputSchema)) {
            if (value && typeof value.safeParse === "function") {
                shape[key] = value;
            }
        }
        if (!Object.keys(shape).length)
            return {};
        const parsed = z.object(shape).safeParse(args ?? {});
        if (parsed.success)
            return parsed.data;
        const details = parsed.error.issues
            .map((issue) => `${issue.path.length ? issue.path.join(".") : "arguments"}: ${issue.message}`)
            .join("; ");
        throw new CodexProError(`Invalid arguments for ${name}: ${details}`);
    }
    function tagToolResult(result, name, options) {
        if (!result || typeof result !== "object")
            return result;
        const structured = result.structuredContent;
        const base = structured && typeof structured === "object" && !Array.isArray(structured)
            ? structured
            : {};
        const tagged = {
            codexpro_tool: name,
            codexpro_title: options.title ?? name,
            ...base
        };
        const meta = options._meta ?? {};
        result.structuredContent = meta.ui || meta["openai/outputTemplate"] ? compactStructuredContent(tagged) : tagged;
        return result;
    }
    function toolCallLoggingEnabled() {
        return process.env.CODEXPRO_LOG_TOOL_CALLS === "1" || process.env.CODEXPRO_LOG_REQUESTS === "1";
    }
    function logToolCall(name, status, started) {
        if (!toolCallLoggingEnabled())
            return;
        console.error(`[CodexProTool] ${name} ${status} ${Date.now() - started}ms`);
    }
    function rememberRegisteredToolHandler(server, name, handler) {
        const key = server;
        const handlers = registeredToolHandlersByServer.get(key) ?? new Map();
        if (!registeredToolHandlersByServer.has(key))
            registeredToolHandlersByServer.set(key, handlers);
        handlers.set(name, handler);
    }
    function registeredToolHandler(server, name) {
        return registeredToolHandlersByServer.get(server)?.get(name);
    }
    async function recordToolRuntimeTrace(server, name, args, status, startedAtMs, endedAtMs, context) {
        let workspace;
        try {
            workspace = hooks.runtimeTraceWorkspaceForServer(server);
        }
        catch {
            workspace = undefined;
        }
        if (!workspace)
            return;
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
    function registerToolCompat(server, name, options, handler) {
        const wrapped = async (args) => {
            const started = Date.now();
            const usageArgs = args ?? {};
            let initialWorkspace;
            try {
                initialWorkspace = hooks.runtimeTraceWorkspaceForServer(server);
            }
            catch {
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
            }
            catch (error) {
                const result = tagToolResult(errorResult(error), name, options);
                const durationMs = Date.now() - started;
                logToolCall(name, "error", started);
                hooks.recordMcpUsage(name, usageArgs, result, "error", durationMs);
                await recordToolRuntimeTrace(server, name, usageArgs, "error", started, started + durationMs, traceContext);
                return result;
            }
        };
        const securitySchemes = [{ type: "noauth" }];
        const fullOptions = {
            securitySchemes,
            ...options,
            _meta: {
                securitySchemes,
                ...options._meta
            }
        };
        const s = server;
        if (typeof s.registerTool === "function") {
            s.registerTool(name, fullOptions, wrapped);
            return;
        }
        if (typeof s.tool === "function") {
            s.tool(name, fullOptions.description ?? name, fullOptions.inputSchema ?? {}, wrapped);
            return;
        }
        throw new Error("Unsupported MCP SDK: McpServer has neither registerTool nor tool.");
    }
    function rememberRegisteredTool(server, name) {
        const key = server;
        const names = registeredToolNamesByServer.get(key) ?? [];
        if (!registeredToolNamesByServer.has(key))
            registeredToolNamesByServer.set(key, names);
        if (!names.includes(name))
            names.push(name);
    }
    function registeredToolNames(server) {
        return [...(registeredToolNamesByServer.get(server) ?? [])];
    }
    function initializeServer(server) {
        registeredToolNamesByServer.set(server, []);
    }
    function registerCodexTool(config, server, name, options, handler) {
        if (!hooks.shouldRegisterTool(config, name))
            return;
        const validatedHandler = (args) => {
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
//# sourceMappingURL=toolRegistration.js.map