const MCP_CALLERS = new Set([
  "runtime_freshness_list_profiles",
  "runtime_freshness_worker_history",
  "get_profile_response",
  "status_list_profiles",
  "status_worker_history",
  "other"
]);

function normalizeCaller(value) {
  const caller = String(value || "");
  return MCP_CALLERS.has(caller) ? caller : "other";
}

export function createMcpCausalTelemetry({ now = () => Date.now(), maxTrackedCalls = 256 } = {}) {
  let sequence = 0;
  let initializeInFlight = 0;
  let sessionsInFlight = 0;
  const sessionsByCaller = new Map();
  const activeCalls = new Map();
  const trackedCallLimit = Math.max(8, Math.floor(Number(maxTrackedCalls) || 256));

  function counters() {
    return {
      MCP_INITIALIZE_IN_FLIGHT: initializeInFlight,
      MCP_SESSIONS_IN_FLIGHT: sessionsInFlight,
      MCP_SESSIONS_IN_FLIGHT_BY_CALLER: Object.fromEntries(
        [...sessionsByCaller.entries()]
          .filter(([, count]) => count > 0)
          .sort(([left], [right]) => left.localeCompare(right))
      )
    };
  }

  function snapshot(call) {
    return {
      mcp_call_id: String(call?.mcp_call_id || ""),
      caller: normalizeCaller(call?.caller),
      ...counters(),
      open_started: String(call?.open_started || ""),
      initialized: String(call?.initialized || ""),
      tool_completed: String(call?.tool_completed || ""),
      close_started: String(call?.close_started || ""),
      close_completed: String(call?.close_completed || ""),
      duration_ms: Math.max(0, Number(call?.duration_ms) || 0),
      ...(call?.response_read_id ? { response_read_id: String(call.response_read_id) } : {}),
      ...(call?.runtime_freshness_iteration_id ? { runtime_freshness_iteration_id: String(call.runtime_freshness_iteration_id) } : {}),
      ...(call?.profile_id ? { profile_id: String(call.profile_id) } : {}),
      ...(call?.conversation_id ? { conversation_id: String(call.conversation_id) } : {}),
      ...(call?.task_id ? { task_id: String(call.task_id) } : {}),
      ...(call?.session_id ? { session_id: String(call.session_id) } : {})
    };
  }

  function flightSnapshot() {
    const current = Number(now()) || Date.now();
    const calls = [...activeCalls.values()]
      .sort((left, right) => Number(left?.open_started_ms || 0) - Number(right?.open_started_ms || 0))
      .slice(0, 12)
      .map((call) => ({
        ...snapshot(call),
        age_ms: Math.max(0, current - Number(call?.open_started_ms || current))
      }));
    const oldest = calls[0]?.age_ms;
    return {
      ...counters(),
      initialize_in_flight: initializeInFlight,
      session_tool_in_flight: sessionsInFlight,
      oldest_in_flight_age_ms: Number.isFinite(oldest) ? oldest : null,
      tracked_active_calls: activeCalls.size,
      calls
    };
  }

  function begin(callerValue, metadata = {}) {
    const caller = normalizeCaller(callerValue);
    const startedAtMs = Number(now()) || Date.now();
    sequence += 1;
    initializeInFlight += 1;
    sessionsInFlight += 1;
    sessionsByCaller.set(caller, (sessionsByCaller.get(caller) || 0) + 1);
    const call = {
      mcp_call_id: `mcp_${startedAtMs.toString(36)}_${sequence.toString(36)}`,
      caller,
      response_read_id: String(metadata.response_read_id || ""),
      runtime_freshness_iteration_id: String(metadata.runtime_freshness_iteration_id || ""),
      profile_id: String(metadata.profile_id || ""),
      conversation_id: String(metadata.conversation_id || ""),
      task_id: String(metadata.task_id || ""),
      session_id: "",
      open_started: new Date(startedAtMs).toISOString(),
      open_started_ms: startedAtMs,
      initialized: "",
      tool_completed: "",
      close_started: "",
      close_completed: "",
      duration_ms: 0,
      initialize_pending: true,
      session_pending: true
    };
    if (activeCalls.size < trackedCallLimit) activeCalls.set(call.mcp_call_id, call);
    return call;
  }

  function markInitialized(call) {
    if (!call) return counters();
    const current = Number(now()) || Date.now();
    if (call.initialize_pending) {
      initializeInFlight = Math.max(0, initializeInFlight - 1);
      call.initialize_pending = false;
    }
    if (!call.initialized) call.initialized = new Date(current).toISOString();
    call.duration_ms = Math.max(0, current - call.open_started_ms);
    return snapshot(call);
  }

  function markToolCompleted(call) {
    if (!call) return counters();
    const current = Number(now()) || Date.now();
    if (!call.tool_completed) call.tool_completed = new Date(current).toISOString();
    call.duration_ms = Math.max(0, current - call.open_started_ms);
    return snapshot(call);
  }

  function markCloseStarted(call) {
    if (!call) return counters();
    const current = Number(now()) || Date.now();
    if (!call.close_started) call.close_started = new Date(current).toISOString();
    call.duration_ms = Math.max(0, current - call.open_started_ms);
    return snapshot(call);
  }

  function markCloseCompleted(call) {
    if (!call) return counters();
    const current = Number(now()) || Date.now();
    if (call.initialize_pending) {
      initializeInFlight = Math.max(0, initializeInFlight - 1);
      call.initialize_pending = false;
    }
    if (!call.close_started) call.close_started = new Date(current).toISOString();
    if (!call.close_completed) call.close_completed = new Date(current).toISOString();
    if (call.session_pending) {
      sessionsInFlight = Math.max(0, sessionsInFlight - 1);
      const callerCount = Math.max(0, (sessionsByCaller.get(call.caller) || 0) - 1);
      if (callerCount) sessionsByCaller.set(call.caller, callerCount);
      else sessionsByCaller.delete(call.caller);
      call.session_pending = false;
    }
    activeCalls.delete(String(call.mcp_call_id || ""));
    call.duration_ms = Math.max(0, current - call.open_started_ms);
    return snapshot(call);
  }

  return {
    begin,
    counters,
    flightSnapshot,
    markInitialized,
    markToolCompleted,
    markCloseStarted,
    markCloseCompleted,
    snapshot,
    normalizeCaller
  };
}
