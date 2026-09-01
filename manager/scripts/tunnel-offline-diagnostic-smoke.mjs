import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyTunnelOfflineEvidence,
  readRecentCloudflaredOutput
} from "../electron/tunnel-offline-diagnostic.mjs";

const healthyPath = {
  local: { ok: true },
  cloudflaredRunning: true,
  dns: { ok: true },
  targetTcp: { ok: true },
  internetTcp: { ok: true },
  cloudflaredOutput: []
};

assert.deepEqual(
  classifyTunnelOfflineEvidence({ ...healthyPath, tunnel: { ok: false, timed_out: true, status: 0 } }),
  { suspected_cause: "public_http_path_timeout", diagnostic_confidence: "medium" },
  "a public timeout with healthy local/DNS/TCP evidence must be classified as the public HTTP/tunnel path, not a generic local-network outage"
);
assert.equal(
  classifyTunnelOfflineEvidence({ ...healthyPath, tunnel: { ok: false, status: 530 } }).suspected_cause,
  "cloudflare_tunnel_error_530",
  "Cloudflare 530 must remain distinguishable from a local MCP failure"
);
assert.equal(
  classifyTunnelOfflineEvidence({ ...healthyPath, tunnel: { ok: false, status: 502 } }).suspected_cause,
  "cloudflare_upstream_error_502",
  "Cloudflare 502 must remain distinguishable from a local MCP failure"
);
assert.equal(
  classifyTunnelOfflineEvidence({ ...healthyPath, local: { ok: false }, tunnel: { ok: false, timed_out: true } }).suspected_cause,
  "local_mcp_unhealthy"
);
assert.equal(
  classifyTunnelOfflineEvidence({ ...healthyPath, cloudflaredRunning: false, tunnel: { ok: false } }).suspected_cause,
  "cloudflared_not_running"
);
assert.equal(
  classifyTunnelOfflineEvidence({ ...healthyPath, dns: { ok: false }, tunnel: { ok: false, timed_out: true } }).suspected_cause,
  "public_hostname_dns_failed"
);
assert.equal(
  classifyTunnelOfflineEvidence({ ...healthyPath, internetTcp: { ok: false }, tunnel: { ok: false, timed_out: true } }).suspected_cause,
  "local_internet_connectivity_failed"
);
assert.equal(
  classifyTunnelOfflineEvidence({
    ...healthyPath,
    tunnel: { ok: false, timed_out: true },
    cloudflaredOutput: [{ line: "ERR Failed to serve tunnel connection error=connection to edge closed" }]
  }).suspected_cause,
  "cloudflared_edge_connection_unstable"
);

const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-tunnel-offline-"));
try {
  const now = Date.now();
  const records = [
    {
      schema_version: 1,
      timestamp: new Date(now - 60_000).toISOString(),
      level: "warn",
      action: "child-output",
      details: { child_name: "cloudflared", stream: "stderr", line: "WARN reconnecting edge connection" }
    },
    {
      schema_version: 1,
      timestamp: new Date(now - 30_000).toISOString(),
      level: "info",
      action: "child-output",
      details: { child_name: "other", stream: "stderr", line: "must not be included" }
    },
    {
      schema_version: 1,
      timestamp: new Date(now - 10_000).toISOString(),
      level: "error",
      action: "child-output",
      details: { child_name: "cloudflared", stream: "stderr", line: "ERR failed to serve tunnel connection" }
    }
  ];
  await fs.writeFile(path.join(home, "runtime-lifecycle.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const tail = readRecentCloudflaredOutput(home, { nowMs: now });
  assert.equal(tail.length, 2, "only recent cloudflared output must be correlated into tunnel incidents");
  assert.match(tail.at(-1).line, /failed to serve tunnel connection/i);
} finally {
  await fs.rm(home, { recursive: true, force: true });
}

const launcher = await fs.readFile(new URL("../../scripts/codexpro.mjs", import.meta.url), "utf8");
const managerMain = await fs.readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
assert.match(launcher, /record\(process\.stdout, 'stdout', chunk\)/, "cloudflared stdout must retain its stream name and actual output chunk");
assert.match(launcher, /record\(process\.stderr, 'stderr', chunk\)/, "cloudflared stderr must retain its stream name and actual output chunk");
assert.match(managerMain, /collectTunnelOfflineEvidence\([\s\S]*?Object\.assign\(tunnelHealthEvent\.details, offlineEvidence\)/, "Manager must attach correlated tunnel evidence to the first offline transition log");
assert.match(managerMain, /if \(!isWindows\)[\s\S]*?const processSummaries = processCandidates\.map[\s\S]*?await recordRuntimeHealthDiagnostics\(\{ healthCycleId, localBase, publicBase, local, tunnel, processSummaries \}\)/, "macOS and other portable runtimes must record the same tunnel outage evidence as Windows");

console.log("tunnel offline diagnostic smoke: ok");
