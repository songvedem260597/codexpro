function normalizedNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function safeHealthEndpoint(base) {
  try {
    const url = new URL(String(base || ""));
    if (!/^https?:$/.test(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.pathname = "/healthz";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function probeDetails({ target, label, base, result, healthCycleId, processes, previousOk, transition }) {
  const processList = Array.isArray(processes) ? processes : [];
  return {
    action: transition === "offline"
      ? "health-probe-offline"
      : transition === "still-offline"
        ? "health-probe-still-offline"
        : transition === "recovered"
          ? "health-probe-recovered"
          : "health-probe-slow",
    health_cycle_id: String(healthCycleId || ""),
    probe_target: String(target || ""),
    probe_label: String(label || target || ""),
    endpoint: safeHealthEndpoint(base),
    ok: result?.ok === true,
    status: normalizedNumber(result?.status),
    latency_ms: normalizedNumber(result?.latency),
    timeout_ms: normalizedNumber(result?.timeout_ms),
    timed_out: result?.timed_out === true,
    error_name: String(result?.error_name || ""),
    error_code: String(result?.error_code || ""),
    error: String(result?.error || ""),
    previous_ok: typeof previousOk === "boolean" ? previousOk : null,
    transition,
    process_count: processList.length,
    process_ids: processList.map((item) => normalizedNumber(item?.pid || item?.ProcessId)).filter((pid) => pid > 0),
    processes: processList.map((item) => ({
      pid: normalizedNumber(item?.pid || item?.ProcessId),
      name: String(item?.name || item?.Name || "")
    })).filter((item) => item.pid > 0 || item.name)
  };
}

export function createRuntimeHealthDiagnosticTracker(options = {}) {
  const repeatFailureMs = Math.max(1_000, normalizedNumber(options.repeatFailureMs, 30_000));
  const repeatSlowMs = Math.max(1_000, normalizedNumber(options.repeatSlowMs, 60_000));
  const states = new Map();

  return {
    observe(input = {}) {
      const target = String(input.target || "").trim();
      if (!target) return null;
      if (input.configured === false) {
        states.delete(target);
        return null;
      }

      const now = normalizedNumber(input.observedAt, Date.now());
      const result = input.result && typeof input.result === "object" ? input.result : {};
      const ok = result.ok === true;
      const latency = normalizedNumber(result.latency);
      const slowMs = Math.max(1, normalizedNumber(input.slowMs, target === "local" ? 1_000 : 2_500));
      const previous = states.get(target);
      let transition = "";
      let level = "info";

      if (!ok) {
        if (!previous || previous.ok) {
          transition = "offline";
        } else if (now - previous.lastFailureLogAt >= repeatFailureMs) {
          transition = "still-offline";
        }
        level = "warn";
      } else if (previous && !previous.ok) {
        transition = "recovered";
      } else if (latency >= slowMs && (!previous || now - previous.lastSlowLogAt >= repeatSlowMs)) {
        transition = "slow";
        level = "warn";
      }

      states.set(target, {
        ok,
        lastFailureLogAt: !ok && transition ? now : normalizedNumber(previous?.lastFailureLogAt),
        lastSlowLogAt: ok && transition === "slow" ? now : normalizedNumber(previous?.lastSlowLogAt)
      });

      if (!transition) return null;
      const details = probeDetails({
        target,
        label: input.label,
        base: input.base,
        result,
        healthCycleId: input.healthCycleId,
        processes: input.processes,
        previousOk: previous?.ok,
        transition
      });
      const label = String(input.label || target);
      const message = transition === "recovered"
        ? `${label} health probe đã hồi phục sau ${latency} ms`
        : transition === "slow"
          ? `${label} health probe phản hồi chậm (${latency} ms)`
          : result.timed_out
            ? `${label} health probe timeout sau ${latency} ms`
            : `${label} health probe thất bại${result.error ? `: ${result.error}` : ""}`;
      return { level, source: "manager", category: "health", message, details };
    },
    reset() {
      states.clear();
    }
  };
}
