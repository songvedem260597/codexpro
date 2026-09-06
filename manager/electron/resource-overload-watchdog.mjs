export const RESOURCE_OVERLOAD_SAMPLE_INTERVAL_MS = 2_000;
export const RESOURCE_OVERLOAD_RAM_MB = 1_536;
export const RESOURCE_OVERLOAD_CPU_PERCENT = 180;
export const RESOURCE_OVERLOAD_SUSTAINED_SAMPLES = 3;
export const RESOURCE_OVERLOAD_COOLDOWN_MS = 60_000;
export const RESOURCE_OVERLOAD_HISTORY_SAMPLES = 6;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function kbToMb(value) {
  return Math.round((finiteNumber(value) / 1024) * 10) / 10;
}

function round1(value) {
  return Math.round(finiteNumber(value) * 10) / 10;
}

export function summarizeManagerAppMetrics(metrics = []) {
  const processes = (Array.isArray(metrics) ? metrics : []).map((metric) => ({
    pid: Math.max(0, Math.trunc(finiteNumber(metric?.pid))),
    type: String(metric?.type || "unknown").slice(0, 80),
    service_name: String(metric?.serviceName || "").slice(0, 120),
    cpu_percent: round1(metric?.cpu?.percentCPUUsage),
    working_set_mb: kbToMb(metric?.memory?.workingSetSize),
    peak_working_set_mb: kbToMb(metric?.memory?.peakWorkingSetSize),
    private_mb: kbToMb(metric?.memory?.privateBytes)
  }));
  const aggregateRamMb = round1(processes.reduce((sum, item) => sum + item.working_set_mb, 0));
  const aggregateCpuPercent = round1(processes.reduce((sum, item) => sum + item.cpu_percent, 0));
  return {
    process_count: processes.length,
    aggregate_ram_mb: aggregateRamMb,
    aggregate_cpu_percent: aggregateCpuPercent,
    processes: processes
      .sort((left, right) => (right.working_set_mb - left.working_set_mb) || (right.cpu_percent - left.cpu_percent))
      .slice(0, 12)
  };
}

export function createResourceOverloadTracker(options = {}) {
  const ramThresholdMb = Math.max(1, finiteNumber(options.ramThresholdMb) || RESOURCE_OVERLOAD_RAM_MB);
  const cpuThresholdPercent = Math.max(1, finiteNumber(options.cpuThresholdPercent) || RESOURCE_OVERLOAD_CPU_PERCENT);
  const sustainedSamples = Math.max(1, Math.trunc(finiteNumber(options.sustainedSamples) || RESOURCE_OVERLOAD_SUSTAINED_SAMPLES));
  const cooldownMs = Math.max(0, finiteNumber(options.cooldownMs) || RESOURCE_OVERLOAD_COOLDOWN_MS);
  const historySamples = Math.max(1, Math.trunc(finiteNumber(options.historySamples) || RESOURCE_OVERLOAD_HISTORY_SAMPLES));
  let ramStreak = 0;
  let cpuStreak = 0;
  let lastIncidentAt = -Infinity;
  const history = [];

  return {
    observe(metrics, at = Date.now()) {
      const sampledAt = Number.isFinite(Number(at)) ? Number(at) : Date.now();
      const summary = summarizeManagerAppMetrics(metrics);
      const ramHigh = summary.aggregate_ram_mb >= ramThresholdMb;
      const cpuHigh = summary.aggregate_cpu_percent >= cpuThresholdPercent;
      ramStreak = ramHigh ? ramStreak + 1 : 0;
      cpuStreak = cpuHigh ? cpuStreak + 1 : 0;
      history.push({
        sampled_at: new Date(sampledAt).toISOString(),
        aggregate_ram_mb: summary.aggregate_ram_mb,
        aggregate_cpu_percent: summary.aggregate_cpu_percent,
        ram_high: ramHigh,
        cpu_high: cpuHigh
      });
      while (history.length > historySamples) history.shift();

      const ramSustained = ramStreak >= sustainedSamples;
      const cpuSustained = cpuStreak >= sustainedSamples;
      if (!ramSustained && !cpuSustained) return null;
      if (sampledAt - lastIncidentAt < cooldownMs) return null;
      lastIncidentAt = sampledAt;

      return {
        trigger: ramSustained && cpuSustained ? "ram_and_cpu" : (ramSustained ? "ram" : "cpu"),
        thresholds: {
          ram_mb: ramThresholdMb,
          cpu_percent: cpuThresholdPercent,
          sustained_samples: sustainedSamples,
          sample_interval_ms: RESOURCE_OVERLOAD_SAMPLE_INTERVAL_MS,
          cooldown_ms: cooldownMs
        },
        sustained: {
          ram_samples: ramStreak,
          cpu_samples: cpuStreak
        },
        ...summary,
        recent_samples: history.map((item) => ({ ...item }))
      };
    }
  };
}
