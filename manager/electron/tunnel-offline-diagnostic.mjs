import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const CLOUDFLARED_LOG_MAX_AGE_MS = 3 * 60 * 1000;

function boundedText(value, maxLength = 1_000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function withTimeout(promise, timeoutMs) {
  const timeout = Math.max(250, Number(timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS);
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${timeout} ms`)), timeout);
      timer.unref?.();
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function dnsProbe(hostname, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  if (!hostname) return { ok: false, addresses: [], error: "missing hostname" };
  try {
    const records = await withTimeout(dns.lookup(hostname, { all: true }), timeoutMs);
    return {
      ok: records.length > 0,
      addresses: records.map((record) => String(record?.address || "")).filter(Boolean).slice(0, 8),
      error: ""
    };
  } catch (error) {
    return { ok: false, addresses: [], error: boundedText(error?.message || error, 240) };
  }
}

function tcpProbe(host, port = 443, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  if (!host) return Promise.resolve({ ok: false, latency_ms: 0, error: "missing host" });
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (ok, error = "") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latency_ms: Date.now() - startedAt, error: boundedText(error, 240) });
    };
    socket.setTimeout(Math.max(250, Number(timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS), () => finish(false, "timeout"));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(false, error?.message || error));
  });
}

function runtimeLifecyclePaths(home) {
  const current = path.join(home, "runtime-lifecycle.jsonl");
  return [`${current}.1`, current];
}

export function readRecentCloudflaredOutput(home, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const maxAgeMs = Math.max(5_000, Number(options.maxAgeMs) || CLOUDFLARED_LOG_MAX_AGE_MS);
  const cutoff = nowMs - maxAgeMs;
  const lines = [];
  for (const file of runtimeLifecyclePaths(path.resolve(home))) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      try {
        const record = JSON.parse(rawLine);
        const timestampMs = Date.parse(record?.timestamp || "");
        if (!Number.isFinite(timestampMs) || timestampMs < cutoff) continue;
        if (record?.action !== "child-output") continue;
        if (String(record?.details?.child_name || "").toLowerCase() !== "cloudflared") continue;
        const line = boundedText(record?.details?.line || record?.message || "", 800);
        if (line) lines.push({ timestamp: String(record.timestamp || ""), level: String(record.level || ""), line });
      } catch {}
    }
  }
  return lines.slice(-12);
}

export function classifyTunnelOfflineEvidence(input = {}) {
  const local = input.local || {};
  const tunnel = input.tunnel || {};
  const cloudflaredRunning = input.cloudflaredRunning === true;
  const dnsResult = input.dns || {};
  const targetTcp = input.targetTcp || {};
  const internetTcp = input.internetTcp || {};
  const recentOutput = Array.isArray(input.cloudflaredOutput) ? input.cloudflaredOutput : [];
  const outputText = recentOutput.map((item) => item?.line || "").join(" ").toLowerCase();
  const status = Number(tunnel?.status) || 0;

  if (!local?.ok) {
    return { suspected_cause: "local_mcp_unhealthy", diagnostic_confidence: "high" };
  }
  if (!cloudflaredRunning) {
    return { suspected_cause: "cloudflared_not_running", diagnostic_confidence: "high" };
  }
  if (/unable to reach the origin service|connect.*127\.0\.0\.1|connection refused|origin.*failed/.test(outputText)) {
    return { suspected_cause: "cloudflared_origin_connection_failed", diagnostic_confidence: "high" };
  }
  if (/failed to serve tunnel connection|edge.*connection|connection.*edge|register tunnel connection|reconnect|quic.*timeout|http2.*timeout/.test(outputText)) {
    return { suspected_cause: "cloudflared_edge_connection_unstable", diagnostic_confidence: "high" };
  }
  if (status === 530) {
    return { suspected_cause: "cloudflare_tunnel_error_530", diagnostic_confidence: "high" };
  }
  if (status === 502) {
    return { suspected_cause: "cloudflare_upstream_error_502", diagnostic_confidence: "high" };
  }
  if (dnsResult?.ok === false) {
    return { suspected_cause: "public_hostname_dns_failed", diagnostic_confidence: "high" };
  }
  if (internetTcp?.ok === false) {
    return { suspected_cause: "local_internet_connectivity_failed", diagnostic_confidence: "high" };
  }
  if (targetTcp?.ok === false) {
    return { suspected_cause: "cloudflare_edge_unreachable", diagnostic_confidence: "medium" };
  }
  if (tunnel?.timed_out && dnsResult?.ok && targetTcp?.ok && internetTcp?.ok) {
    return { suspected_cause: "public_http_path_timeout", diagnostic_confidence: "medium" };
  }
  if (status >= 500) {
    return { suspected_cause: "public_tunnel_http_5xx", diagnostic_confidence: "medium" };
  }
  return { suspected_cause: "public_tunnel_unhealthy_unknown", diagnostic_confidence: "low" };
}

export async function collectTunnelOfflineEvidence(options = {}) {
  const publicBase = String(options.publicBase || "");
  let hostname = "";
  try {
    hostname = new URL(publicBase).hostname;
  } catch {}
  const processes = Array.isArray(options.processes) ? options.processes : [];
  const cloudflaredRunning = processes.some((item) => {
    const name = String(item?.name || item?.Name || "").toLowerCase();
    return name === "cloudflared.exe" || name === "cloudflared";
  });
  const [dnsResult, targetTcp, internetTcp] = await Promise.all([
    dnsProbe(hostname, options.timeoutMs),
    tcpProbe(hostname, 443, options.timeoutMs),
    tcpProbe("1.1.1.1", 443, options.timeoutMs)
  ]);
  const cloudflaredOutput = readRecentCloudflaredOutput(options.home, { nowMs: options.nowMs });
  const classification = classifyTunnelOfflineEvidence({
    local: options.local,
    tunnel: options.tunnel,
    cloudflaredRunning,
    dns: dnsResult,
    targetTcp,
    internetTcp,
    cloudflaredOutput
  });
  return {
    ...classification,
    local_ok: options.local?.ok === true,
    cloudflared_running: cloudflaredRunning,
    public_hostname: hostname,
    dns_ok: dnsResult.ok === true,
    dns_addresses: dnsResult.addresses || [],
    dns_error: dnsResult.error || "",
    target_tcp_443_ok: targetTcp.ok === true,
    target_tcp_443_latency_ms: Number(targetTcp.latency_ms) || 0,
    target_tcp_443_error: targetTcp.error || "",
    internet_tcp_443_ok: internetTcp.ok === true,
    internet_tcp_443_latency_ms: Number(internetTcp.latency_ms) || 0,
    internet_tcp_443_error: internetTcp.error || "",
    cloudflare_server: String(options.tunnel?.response_server || ""),
    cloudflare_ray: String(options.tunnel?.cf_ray || ""),
    cloudflared_recent_output: cloudflaredOutput
  };
}
