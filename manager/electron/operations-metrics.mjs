import fs from "node:fs";
import os from "node:os";
import { runPowerShellProcess } from "./process-runner.mjs";

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

function collectLinuxProcessRows(pids) {
  const clkTck = 100;
  const rows = [];
  for (const pid of pids) {
    try {
      const statusText = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const nameMatch = statusText.match(/^Name:\s+(\S+)/m);
      const rssMatch = statusText.match(/^VmRSS:\s+(\d+)\s+kB/m);
      const statText = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const rparen = statText.lastIndexOf(")");
      const fields = rparen > 0 ? statText.slice(rparen + 2).trim().split(/\s+/) : [];
      const utime = Number(fields[11] || 0);
      const stime = Number(fields[12] || 0);
      const cpuSeconds = (utime + stime) / clkTck;
      const workingSet = rssMatch ? Number(rssMatch[1]) * 1024 : (pid === process.pid ? process.memoryUsage().rss : 0);
      rows.push({
        Id: pid,
        ProcessName: nameMatch ? nameMatch[1] : "node",
        CPU: cpuSeconds,
        WorkingSet64: workingSet
      });
    } catch {
      if (pid === process.pid) {
        const cpu = process.cpuUsage();
        rows.push({
          Id: pid,
          ProcessName: "node",
          CPU: (cpu.user + cpu.system) / 1e6,
          WorkingSet64: process.memoryUsage().rss
        });
      }
    }
  }
  return rows;
}

function resolveMemoryBounds(processes) {
  let totalMemoryBytes = os.totalmem();
  let freeMemoryBytes = os.freemem();
  if (process.platform !== "win32") {
    try {
      const maxRaw = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
      const curRaw = fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim();
      const maxBytes = Number(maxRaw);
      const curBytes = Number(curRaw);
      if (Number.isFinite(maxBytes) && maxBytes > 0 && maxBytes < totalMemoryBytes) {
        totalMemoryBytes = maxBytes;
        const used = Number.isFinite(curBytes) && curBytes > 0
          ? curBytes
          : processes.reduce((sum, p) => sum + (p.memoryBytes || 0), 0);
        freeMemoryBytes = Math.max(0, totalMemoryBytes - used);
      }
    } catch {}
  }
  return { totalMemoryBytes, freeMemoryBytes };
}

export async function collectOperationsPerformance(requestedPids = []) {
  const now = Date.now();
  const logicalCpuCount = Math.max(1, os.cpus()?.length || 1);
  const pids = [...new Set([process.pid, ...(Array.isArray(requestedPids) ? requestedPids : [])].map(normalizedPid).filter(Boolean))].slice(0, 48);
  let rows = [];
  if (process.platform === "win32") {
    const script = `$ids=@(${pids.join(",")}); $target=@(Get-Process -Id $ids -ErrorAction SilentlyContinue); $chrome=@(Get-Process chrome -ErrorAction SilentlyContinue); @($target + $chrome) | Sort-Object Id -Unique | Select-Object Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json -Compress`;
    try {
      const result = await runPowerShellProcess(script, {
        timeoutMs: 5_000,
        maxBuffer: 1024 * 1024
      });
      rows = parsePowerShellJson(result.stdout);
    } catch {
      rows = [];
    }
  } else {
    rows = collectLinuxProcessRows(pids);
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

  const { totalMemoryBytes, freeMemoryBytes } = resolveMemoryBounds(processes);
  return {
    checkedAt: new Date(now).toISOString(),
    managerPid: process.pid,
    logicalCpuCount,
    totalMemoryBytes,
    freeMemoryBytes,
    processes
  };
}
