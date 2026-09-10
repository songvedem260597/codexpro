export function createManagerMcpClient(options = {}) {
  const managerVersion = String(options.managerVersion || "");
  const diagnostic = typeof options.diagnostic === "function" ? options.diagnostic : () => {};
  const diagnosticAllowed = typeof options.diagnosticAllowed === "function" ? options.diagnosticAllowed : () => true;
  const causalTelemetry = options.causalTelemetry;
  const emitCausalTelemetry = typeof options.emitCausalTelemetry === "function" ? options.emitCausalTelemetry : () => {};
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutSignal = typeof options.timeoutSignal === "function"
    ? options.timeoutSignal
    : (timeoutMs) => AbortSignal.timeout(timeoutMs);

  async function mcpRequestCore(url, token, body, sessionId, timeoutMs = 15000) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        connection: "close",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {})
      },
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs)
    });
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    const nextSessionId = response.headers.get("mcp-session-id") || sessionId;
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/event-stream") && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() || "";
          for (const event of events) {
            const data = event.split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (!data) continue;
            const payload = JSON.parse(data);
            if (payload.error) throw new Error(payload.error.message || "MCP trả về lỗi");
            await reader.cancel().catch(() => {});
            return { payload, sessionId: nextSessionId };
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!buffer.trim()) return { payload: {}, sessionId: nextSessionId };
      const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data) return { payload: {}, sessionId: nextSessionId };
      const payload = JSON.parse(data);
      if (payload.error) throw new Error(payload.error.message || "MCP trả về lỗi");
      return { payload, sessionId: nextSessionId };
    }
    const text = await response.text();
    if (!text.trim()) return { payload: {}, sessionId: nextSessionId };
    const payload = JSON.parse(text);
    if (payload.error) throw new Error(payload.error.message || "MCP trả về lỗi");
    return { payload, sessionId: nextSessionId };
  }

  async function mcpRequest(url, token, body, sessionId, timeoutMs = 15000) {
    const startedAt = Date.now();
    const method = String(body?.method || "request");
    const toolName = String(body?.params?.name || "");
    const toolAction = String(body?.params?.arguments?.action || "");
    const action = toolName ? `${toolName}${toolAction ? `:${toolAction}` : ""}` : method;
    try {
      const result = await mcpRequestCore(url, token, body, sessionId, timeoutMs);
      if (method === "tools/call") {
        const durationMs = Date.now() - startedAt;
        const routinePollingAction = new Set(["browser_control:list_profiles", "browser_control:get_chat_response"]).has(action);
        if (!routinePollingAction || durationMs >= 2_000) {
          diagnostic(routinePollingAction ? "warn" : "info", "mcp", "tool", routinePollingAction ? `MCP polling ${action} phản hồi chậm` : `MCP tool ${action} hoàn tất`, {
            action,
            duration_ms: durationMs
          });
        }
      }
      return result;
    } catch (error) {
      diagnostic("error", "mcp", method === "tools/call" ? "tool" : "transport", `MCP ${action} lỗi: ${error?.message || String(error)}`, {
        action,
        duration_ms: Date.now() - startedAt,
        error
      });
      throw error;
    }
  }

  async function openLocalMcpSession(config, token, telemetryOptions = {}) {
    const url = `http://127.0.0.1:${config.port}/mcp`;
    const causalCall = causalTelemetry.begin(telemetryOptions?.caller, {
      runtime_freshness_iteration_id: telemetryOptions?.runtime_freshness_iteration_id,
      response_read_id: telemetryOptions?.response_read_id
    });
    emitCausalTelemetry("open_started", causalCall);
    const startedAt = Date.now();
    const phaseTimings = {};
    let phaseStartedAt = Date.now();
    try {
      const initialized = await mcpRequest(url, token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "CodexPro Manager", version: managerVersion } }
      });
      phaseTimings.initialize_ms = Date.now() - phaseStartedAt;
      const session = { url, token, sessionId: initialized.sessionId, nextId: 2, phaseTimings, causalTelemetryCall: causalCall };
      phaseStartedAt = Date.now();
      await mcpRequest(url, token, { jsonrpc: "2.0", method: "notifications/initialized" }, session.sessionId);
      phaseTimings.initialized_notification_ms = Date.now() - phaseStartedAt;
      phaseTimings.open_total_ms = Date.now() - startedAt;
      causalTelemetry.markInitialized(causalCall);
      emitCausalTelemetry("initialized", causalCall);
      return session;
    } catch (error) {
      causalTelemetry.markCloseCompleted(causalCall);
      emitCausalTelemetry("close_completed", causalCall, true);
      throw error;
    }
  }

  async function closeLocalMcpSession(session) {
    const causalCall = session?.causalTelemetryCall;
    if (!session?.url || !session?.sessionId) {
      if (causalCall) {
        causalTelemetry.markCloseCompleted(causalCall);
        emitCausalTelemetry("close_completed", causalCall, true);
      }
      return;
    }
    if (causalCall) {
      causalTelemetry.markCloseStarted(causalCall);
      emitCausalTelemetry("close_started", causalCall);
    }
    const startedAt = Date.now();
    try {
      await fetchImpl(session.url, {
        method: "DELETE",
        headers: {
          accept: "application/json, text/event-stream",
          connection: "close",
          ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
          "mcp-session-id": session.sessionId
        },
        signal: timeoutSignal(3000)
      });
      if (causalCall) {
        causalTelemetry.markCloseCompleted(causalCall);
        emitCausalTelemetry("close_completed", causalCall);
      }
      const durationMs = Date.now() - startedAt;
      if (durationMs >= 1000 && diagnosticAllowed("mcp-close-session-slow", 30_000)) {
        diagnostic("warn", "mcp", "transport", `Đóng MCP session chậm (${durationMs} ms)`, {
          action: "close-mcp-session-slow",
          duration_ms: durationMs
        });
      }
    } catch (error) {
      if (causalCall) {
        causalTelemetry.markCloseCompleted(causalCall);
        emitCausalTelemetry("close_completed", causalCall);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (process.env.CODEXPRO_MANAGER_MCP_DEBUG === "1") {
        console.error(`[manager-mcp] close session failed: ${message}`);
      }
      if (diagnosticAllowed(`mcp-close-session:${message.slice(0, 160)}`, 60_000)) {
        diagnostic("warn", "mcp", "transport", `Không đóng sạch được MCP session: ${message}`, {
          action: "close-mcp-session",
          error
        });
      }
    }
  }

  async function localMcpToolInSession(session, toolName, args, timeoutMs = 15000) {
    const startedAt = Date.now();
    let called;
    try {
      called = await mcpRequest(session.url, session.token, {
        jsonrpc: "2.0",
        id: session.nextId++,
        method: "tools/call",
        params: { name: toolName, arguments: args }
      }, session.sessionId, timeoutMs);
    } finally {
      if (session?.phaseTimings) {
        session.phaseTimings.tool_call_ms = Math.max(0, Number(session.phaseTimings.tool_call_ms) || 0) + (Date.now() - startedAt);
        session.phaseTimings.tool_call_count = Math.max(0, Number(session.phaseTimings.tool_call_count) || 0) + 1;
      }
      if (session?.causalTelemetryCall) {
        causalTelemetry.markToolCompleted(session.causalTelemetryCall);
        emitCausalTelemetry("tool_completed", session.causalTelemetryCall);
      }
    }
    const result = called.payload.result;
    if (result?.isError) {
      const message = result.content?.find((item) => item.type === "text")?.text || "CodexPro MCP trả về lỗi.";
      const structured = result.structuredContent?.error;
      const envelope = structured && typeof structured === "object" && !Array.isArray(structured) ? structured : { name: "CodexProMcpError", message };
      const error = new Error(String(envelope.message || message));
      error.name = String(envelope.name || "CodexProMcpError");
      error.code = String(envelope.code || "MCP_TOOL_ERROR");
      error.details = envelope.details && typeof envelope.details === "object" ? envelope.details : envelope;
      throw error;
    }
    return result?.structuredContent || {};
  }

  async function localMcpTool(config, token, toolName, args, timeoutMs = 15000, telemetryOptions = {}) {
    const debug = process.env.CODEXPRO_MANAGER_MCP_DEBUG === "1";
    const startedAt = Date.now();
    const toolAction = String(args?.action || "");
    const toolActionName = toolAction ? `${toolName}:${toolAction}` : toolName;
    let session = null;
    try {
      if (debug) console.error(`[manager-mcp] ${toolActionName}: open session`);
      session = await openLocalMcpSession(config, token, telemetryOptions);
      if (debug) console.error(`[manager-mcp] ${toolActionName}: tools/call`);
      const result = await localMcpToolInSession(session, toolName, args, timeoutMs);
      const totalMs = Date.now() - startedAt;
      if (totalMs >= 2000 || Number(session.phaseTimings?.initialize_ms) >= 1000) {
        diagnostic("warn", "mcp", "transport", `MCP session ${toolActionName} phản hồi chậm (${totalMs} ms)`, {
          action: "mcp-session-breakdown",
          tool_action: toolActionName,
          duration_ms: totalMs,
          mcp_session_phase_timings: { ...session.phaseTimings, total_ms: totalMs }
        });
      }
      if (debug) console.error(`[manager-mcp] ${toolActionName}: tools/call complete`);
      return result;
    } finally {
      if (session) void closeLocalMcpSession(session);
    }
  }

  return {
    mcpRequestCore,
    mcpRequest,
    openLocalMcpSession,
    closeLocalMcpSession,
    localMcpToolInSession,
    localMcpTool
  };
}
