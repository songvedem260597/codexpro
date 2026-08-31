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

function cpuTimeSeconds(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const [dayText, clockText = dayText] = raw.includes("-") ? raw.split("-", 2) : ["0", raw];
  const days = raw.includes("-") ? Math.max(0, Number(dayText) || 0) : 0;
  const parts = clockText.split(":").map((part) => Math.max(0, Number(part) || 0));
  if (parts.length === 3) return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1];
  return days * 86400 + (parts[0] || 0);
}

function isChromeCommand(command) {
  const value = String(command || "").toLowerCase();
  return value.includes("google chrome") || value.includes("chromium") || /(?:^|\/)chrome$/.test(value);
}

function parsePosixProcessRows(text, requestedPids) {
  const requested = new Set(requestedPids);
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+((?:\d+-)?\d+(?::\d+){1,2}(?:\.\d+)?)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = normalizedPid(match[1]);
    const command = match[4];
    const chrome = isChromeCommand(command);
    if (!requested.has(pid) && !chrome) continue;
    rows.push({
      Id: pid,
      ProcessName: chrome ? "chrome" : command.split("/").at(-1) || "process",
      CPU: cpuTimeSeconds(match[2]),
      WorkingSet64: Math.max(0, Number(match[3]) || 0) * 1024
    });
  }
  return rows;
}

async function collectProcessRows(pids) {
  if (process.platform === "win32") {
    const script = `$ids=@(${pids.join(",")}); $target=@(Get-Process -Id $ids -ErrorAction SilentlyContinue); $chrome=@(Get-Process chrome -ErrorAction SilentlyContinue); @($target + $chrome) | Sort-Object Id -Unique | Select-Object Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json -Compress`;
    const result = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    return parsePowerShellJson(result.stdout);
  }

  const executable = process.platform === "darwin" ? "/bin/ps" : "ps";
  const result = await execFileAsync(executable, ["-axo", "pid=,time=,rss=,comm="], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024
  });
  return parsePosixProcessRows(result.stdout, pids);
}

export async function collectOperationsPerformance(requestedPids = []) {
  const now = Date.now();
  const logicalCpuCount = Math.max(1, os.cpus()?.length || 1);
  const pids = [...new Set([process.pid, ...requestedPids].map(normalizedPid).filter(Boolean))].slice(0, 48);
  let rows = [];
  try {
    rows = await collectProcessRows(pids);
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
