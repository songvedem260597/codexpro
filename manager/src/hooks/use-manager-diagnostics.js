import { useCallback, useEffect, useState } from "react";
import { logRendererDiagnostic } from "../diagnostic-log-view.jsx";

const EMPTY_DIAGNOSTIC_LOGS = {
  summary: { total: 0, info: 0, warn: 0, error: 0 },
  entries: [],
  sources: [],
  categories: [],
  queried_hours: 24,
  checked_at: ""
};

export function useManagerDiagnostics({ api, activePage, status, notify, setError }) {
  const [diagnosticLogs, setDiagnosticLogs] = useState(EMPTY_DIAGNOSTIC_LOGS);
  const [diagnosticFilters, setDiagnosticFilters] = useState({ level: "all", source: "all", category: "all", errorType: "all", hours: 24, query: "" });
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [selectedDiagnostic, setSelectedDiagnostic] = useState(null);
  const [operationsPerformance, setOperationsPerformance] = useState(null);
  const [operationsLogs, setOperationsLogs] = useState([]);
  const [uiPerformance, setUiPerformance] = useState({ fps: 60, longTasks: 0, maxLongTaskMs: 0 });

  const loadDiagnosticLogs = useCallback(async (showBusy = true) => {
    if (typeof api.getDiagnosticLogs !== "function") return;
    if (showBusy) setDiagnosticBusy(true);
    try {
      const next = await api.getDiagnosticLogs({ ...diagnosticFilters, limit: 1500 });
      setDiagnosticLogs(next || { summary: { total: 0, info: 0, warn: 0, error: 0 }, entries: [] });
      setSelectedDiagnostic(null);
    } catch (err) {
      logRendererDiagnostic(api, "error", "runtime", `Không tải được nhật ký: ${err?.message || String(err)}`, { action: "get-diagnostic-logs", error: err });
      setError(err?.message || String(err));
    } finally {
      if (showBusy) setDiagnosticBusy(false);
    }
  }, [api, diagnosticFilters, setError]);

  const clearDiagnosticLogHistory = useCallback(async () => {
    setDiagnosticBusy(true);
    try {
      await api.clearDiagnosticLogs?.();
      setSelectedDiagnostic(null);
      await loadDiagnosticLogs(false);
      notify("Đã xóa nhật ký chẩn đoán");
    } catch (err) {
      logRendererDiagnostic(api, "error", "runtime", `Không xóa được nhật ký: ${err?.message || String(err)}`, { action: "clear-diagnostic-logs", error: err });
      setError(err?.message || String(err));
    } finally {
      setDiagnosticBusy(false);
    }
  }, [api, loadDiagnosticLogs, notify, setError]);

  useEffect(() => {
    if (activePage !== "logs") return undefined;
    const timer = window.setTimeout(() => void loadDiagnosticLogs(false), 140);
    return () => window.clearTimeout(timer);
  }, [activePage, loadDiagnosticLogs]);

  useEffect(() => {
    if (activePage !== "control") return undefined;
    let cancelled = false;
    const loadOperations = async () => {
      const pids = (status?.processes || []).map((item) => Number(item?.pid)).filter(Boolean);
      try {
        const [nextPerformance, nextLogs] = await Promise.all([
          api.getOperationsPerformance?.(pids),
          api.getDiagnosticLogs?.({ level: "all", source: "all", category: "all", hours: 24, query: "", limit: 80 })
        ]);
        if (cancelled) return;
        if (nextPerformance) setOperationsPerformance(nextPerformance);
        if (Array.isArray(nextLogs?.entries)) setOperationsLogs(nextLogs.entries);
      } catch (err) {
        if (!cancelled) logRendererDiagnostic(api, "warn", "performance", `Không tải được Control Center: ${err?.message || String(err)}`, { action: "control-center-refresh", error: err });
      }
    };
    void loadOperations();
    const timer = window.setInterval(() => void loadOperations(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activePage, api, status?.processes]);

  useEffect(() => {
    if (activePage !== "control") return undefined;
    let frameCount = 0;
    let lastSampleAt = window.performance.now();
    let rafId = 0;
    const longTasks = [];
    const tick = () => {
      if (!document.hidden) frameCount += 1;
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    let observer = null;
    if (typeof PerformanceObserver !== "undefined") {
      try {
        observer = new PerformanceObserver((list) => {
          const now = window.performance.now();
          for (const entry of list.getEntries()) longTasks.push({ at: now, duration: Number(entry.duration) || 0 });
        });
        observer.observe({ type: "longtask", buffered: false });
      } catch {
        observer = null;
      }
    }
    const handleVisibilityChange = () => {
      if (document.hidden) return;
      frameCount = 0;
      lastSampleAt = window.performance.now();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const now = window.performance.now();
      const elapsed = Math.max(1, now - lastSampleAt);
      const fps = Math.min(120, frameCount * 1000 / elapsed);
      frameCount = 0;
      lastSampleAt = now;
      while (longTasks.length && now - longTasks[0].at > 10_000) longTasks.shift();
      setUiPerformance({
        fps: Number(fps.toFixed(1)),
        longTasks: longTasks.length,
        maxLongTaskMs: longTasks.reduce((max, item) => Math.max(max, item.duration), 0)
      });
    }, 1000);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      observer?.disconnect();
    };
  }, [activePage]);

  useEffect(() => {
    const onError = (event) => logRendererDiagnostic(api, "error", "runtime", event?.message || "Renderer error", { action: "window.error", filename: event?.filename, lineno: event?.lineno, colno: event?.colno, error: event?.error });
    const onRejection = (event) => logRendererDiagnostic(api, "error", "runtime", event?.reason?.message || String(event?.reason || "Unhandled promise rejection"), { action: "unhandledrejection", reason: event?.reason });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [api]);

  return {
    diagnosticLogs,
    diagnosticFilters,
    setDiagnosticFilters,
    diagnosticBusy,
    selectedDiagnostic,
    setSelectedDiagnostic,
    operationsPerformance,
    operationsLogs,
    uiPerformance,
    loadDiagnosticLogs,
    clearDiagnosticLogHistory
  };
}
