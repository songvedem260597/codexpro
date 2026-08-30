import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cpuSamples = new Map();

function normalizedPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function parsePowerShellJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export async function collectOperationsPerformance(requestedPids = []) {
  const now = Date.now();
  const logicalCpuCount = Math.max(1, os.cpus()?.length || 1);
  const pids = [...new Set([process.pid, ...requestedPids].map(normalizedPid).filter(Boolean))].slice(0, 48);
  const script = `$ids=@(${pids.join(",")}); $target=@(Get-Process -Id $ids -ErrorAction SilentlyContinue); $chrome=@(Get-Process chrome -ErrorAction SilentlyContinue); @($target + $chrome) | Sort-Object Id -Unique | Select-Object Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json -Compress`;
  let rows = [];
  try {
    const result = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    rows = parsePowerShellJson(result.stdout);
  } catch {
    rows = [];
  }

  const livePids = new Set();
  const processes = rows.map((row) => {
    const pid = normalizedPid(row?.Id);
    livePids.add(pid);
    const cpuSeconds = Math.max(0, Number(row?.CPU) || 0);
    const previous = cpuSamples.get(pid);
    const elapsedMs = previous ? Math.max(1, now - previous.at) : 0;
    const deltaCpuSeconds = previous ? Math.max(0, cpuSeconds - previous.cpuSeconds) : 0;
    const cpuPercent = elapsedMs
      ? Math.min(999, (deltaCpuSeconds * 1000 / elapsedMs) * 100 / logicalCpuCount)
      : 0;
    cpuSamples.set(pid, { at: now, cpuSeconds });
    return {
      pid,
      name: String(row?.ProcessName || "process"),
      cpuPercent: Number(cpuPercent.toFixed(1)),
      cpuSeconds: Number(cpuSeconds.toFixed(1)),
      memoryBytes: Math.max(0, Number(row?.WorkingSet64) || 0)
    };
  }).filter((row) => row.pid > 0);

  for (const pid of cpuSamples.keys()) {
    if (!livePids.has(pid) && now - Number(cpuSamples.get(pid)?.at || 0) > 60_000) cpuSamples.delete(pid);
  }

  return {
    checkedAt: new Date(now).toISOString(),
    managerPid: process.pid,
    logicalCpuCount,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    processes
  };
}
