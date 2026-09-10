import { randomBytes } from "node:crypto";

export function createDiagnosticIpcRegistrar({ ipcMain, diagnostic }) {
  if (!ipcMain?.handle) throw new Error("Diagnostic IPC registrar requires ipcMain.handle.");
  if (typeof diagnostic !== "function") throw new Error("Diagnostic IPC registrar requires a diagnostic logger.");

  const diagnosticThrottleState = new Map();

  function diagnosticAllowed(key, intervalMs) {
    if (!key || !(Number(intervalMs) > 0)) return true;
    const now = Date.now();
    const previous = Number(diagnosticThrottleState.get(key)) || 0;
    if (now - previous < Number(intervalMs)) return false;
    diagnosticThrottleState.set(key, now);
    if (diagnosticThrottleState.size > 1000) {
      for (const [candidate, at] of diagnosticThrottleState.entries()) {
        if (now - at > 60 * 60 * 1000) diagnosticThrottleState.delete(candidate);
      }
    }
    return true;
  }

  function diagnosticProjection(factory, args, fallback = {}) {
    if (typeof factory !== "function") return fallback;
    try {
      const value = factory(...args);
      return value && typeof value === "object" ? value : fallback;
    } catch (error) {
      return { diagnostic_projection_error: String(error?.message || error) };
    }
  }

  function handle(channel, options, handler) {
    const action = String(options?.action || channel.replace(/^codexpro:/, ""));
    const category = String(options?.category || "runtime");
    const successMessage = String(options?.successMessage || `${action} hoàn tất`);
    const failureMessage = String(options?.failureMessage || `${action} thất bại`);
    ipcMain.handle(channel, async (event, ...args) => {
      const startedAt = Date.now();
      const requestedIpcCallId = String(args?.[0]?.ipc_call_id || "").trim();
      const ipcCallId = /^ipc_[A-Za-z0-9_-]{6,160}$/.test(requestedIpcCallId)
        ? requestedIpcCallId
        : `ipc_${startedAt.toString(36)}_${randomBytes(3).toString("hex")}`;
      const context = {
        ipc_call_id: ipcCallId,
        ipc_channel: channel,
        ...diagnosticProjection(options?.details, args)
      };
      try {
        const result = await handler(event, ...args);
        const durationMs = Date.now() - startedAt;
        const envelopeError = result && typeof result === "object" && result.ok === false && result.error ? result.error : null;
        const resultContext = diagnosticProjection(options?.resultDetails, [result, ...args]);
        const resultDiagnostic = diagnosticProjection(options?.resultDiagnostic, [result, ...args], null);
        if (envelopeError) {
          const errorDiagnostic = diagnosticProjection(options?.errorDiagnostic, [envelopeError, ...args], null);
          diagnostic(errorDiagnostic?.level || "error", "manager", category, errorDiagnostic?.message || `${failureMessage}: ${envelopeError.message || "Lỗi không xác định"}`, {
            action,
            duration_ms: durationMs,
            ...context,
            error: envelopeError,
            ...(errorDiagnostic?.details || {})
          });
        } else if (resultDiagnostic && diagnosticAllowed(resultDiagnostic.dedupeKey, resultDiagnostic.throttleMs)) {
          diagnostic(resultDiagnostic.level || "warn", "manager", category, resultDiagnostic.message || `${action} cần chú ý`, {
            action,
            duration_ms: durationMs,
            ...context,
            ...resultContext,
            ...(resultDiagnostic.details || {})
          });
        } else if (options?.logSuccess) {
          diagnostic("info", "manager", category, successMessage, { action, duration_ms: durationMs, ...context, ...resultContext });
        } else if (Number(options?.slowMs) > 0 && durationMs >= Number(options.slowMs)) {
          diagnostic("warn", "manager", category, `${action} phản hồi chậm (${durationMs} ms)`, { action, duration_ms: durationMs, ...context, ...resultContext });
        }
        return result;
      } catch (error) {
        diagnostic("error", "manager", category, `${failureMessage}: ${error?.message || String(error)}`, {
          action,
          duration_ms: Date.now() - startedAt,
          ...context,
          error,
          error_details: error?.details && typeof error.details === "object" ? error.details : {}
        });
        throw error;
      }
    });
  }

  return { handle, allowed: diagnosticAllowed };
}
