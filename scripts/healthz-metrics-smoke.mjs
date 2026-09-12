import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await getFreePort();
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-healthz-targeted-'));
const root = process.cwd();
const token = 'healthz-targeted-token-0123456789abcdef';
const child = spawn(process.execPath, ['dist/http.js'], {
  cwd: root,
  env: {
    ...process.env,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_BASH_MODE: 'safe',
    CODEXPRO_WRITE_MODE: 'handoff',
    CODEXPRO_TOOL_MODE: 'full',
    CODEXPRO_TOOL_CARDS: '0',
    CODEXPRO_HOME: home,
    CODEXPRO_BROWSER_CONTROL: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  let listening = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.ok) {
        listening = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  if (!listening) throw new Error(`target HTTP runtime did not start: ${stderr.slice(-1000)}`);

  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'healthz-targeted', version: '1.0.0' }
      }
    })
  });
  const sessionId = initialize.headers.get('mcp-session-id') || '';
  const initializeText = await initialize.text();
  if (!initialize.ok || !sessionId) {
    throw new Error(`MCP initialize failed status=${initialize.status} session=${sessionId} body=${initializeText.slice(0, 500)}`);
  }

  await delay(2_300);
  const health = await fetch(`${baseUrl}/healthz`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!health.ok) throw new Error(`healthz returned ${health.status}`);
  const payload = await health.json();
  const metrics = payload.runtimeMetrics || {};

  if (!(Number(payload.pid) > 0)) throw new Error(`healthz pid must be >0: ${payload.pid}`);
  for (const key of [
    'rss_bytes',
    'heap_used_bytes',
    'heap_total_bytes',
    'external_bytes',
    'cpu_user_micros',
    'active_request_count',
    'active_mcp_session_count',
    'active_resource_count'
  ]) {
    if (!(Number(metrics[key]) > 0)) throw new Error(`runtimeMetrics.${key} must be >0: ${metrics[key]}`);
  }
  for (const key of [
    'array_buffers_bytes',
    'cpu_system_micros',
    'event_loop_delay_peak_ms',
    'event_loop_delay_mean_ms'
  ]) {
    if (!Number.isFinite(Number(metrics[key])) || Number(metrics[key]) < 0) {
      throw new Error(`runtimeMetrics.${key} must be a non-negative finite number: ${metrics[key]}`);
    }
  }
  if (Number(metrics.active_mcp_session_count) < 1) {
    throw new Error(`expected a live MCP session, got ${metrics.active_mcp_session_count}`);
  }
  if (Number(metrics.active_resource_count) > 100_000) {
    throw new Error(`active resource count is unexpectedly unbounded: ${metrics.active_resource_count}`);
  }

  console.log(JSON.stringify({
    HEALTHZ_TARGETED_TEST: 'PASS',
    HEALTHZ_HANDLER_EXECUTED: true,
    pid: payload.pid,
    mcp_session_created: Boolean(sessionId),
    runtimeMetrics: metrics
  }, null, 2));
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2_000)
  ]);
  await fs.rm(home, { recursive: true, force: true });
}
