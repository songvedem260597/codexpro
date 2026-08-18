import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

async function waitForJson(url, init = {}, predicate = () => true, timeoutMs = 15000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, init);
      const body = await response.json().catch(async () => ({ text: await response.text() }));
      if (response.ok && predicate(body)) return body;
      last = `${response.status} ${JSON.stringify(body)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}

function spawnLogged(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child._smokeStderr = () => stderr;
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-remote-smoke-'));
await fs.writeFile(path.join(root, 'remote.txt'), 'remote gateway reached local workspace\n', 'utf8');
for (const args of [
  ['init'],
  ['add', 'remote.txt'],
  ['-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke Test', 'commit', '-m', 'remote smoke fixture']
]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}

const localPort = await getFreePort();
const gatewayPort = await getFreePort();
const localToken = 'local-api-token-remote-smoke-0123456789';
const clientToken = 'gateway-client-token-remote-smoke-012345';
const nodeToken = 'gateway-node-token-remote-smoke-01234567';
const nodeId = 'smoke-node';
const localBase = `http://127.0.0.1:${localPort}`;
const gatewayBase = `http://127.0.0.1:${gatewayPort}`;

const localServer = spawnLogged('node', ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(localPort),
    CODEXPRO_HTTP_TOKEN: localToken,
    CODEXPRO_BASH_MODE: 'off',
    CODEXPRO_WRITE_MODE: 'handoff',
    CODEXPRO_TOOL_MODE: 'full',
    CODEXPRO_TOOL_CARDS: '0'
  }
});

let gateway;
let node;
try {
  await waitForJson(`${localBase}/v1/health`, {
    headers: { Authorization: `Bearer ${localToken}` }
  });

  gateway = spawnLogged('node', ['dist/gateway.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_GATEWAY_HOST: '127.0.0.1',
      CODEXPRO_GATEWAY_PORT: String(gatewayPort),
      CODEXPRO_GATEWAY_CLIENT_TOKEN: clientToken,
      CODEXPRO_GATEWAY_NODE_TOKEN: nodeToken,
      CODEXPRO_GATEWAY_DEFAULT_NODE: nodeId
    }
  });
  await waitForJson(`${gatewayBase}/healthz`);

  const offline = await fetch(`${gatewayBase}/v1/invoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ action: 'open_current_workspace', args: { include_tree: false } })
  });
  const offlineBody = await offline.json();
  if (offline.status !== 503 || offlineBody.error?.code !== 'node_offline') {
    throw new Error(`expected offline node to fail with 503, got ${offline.status} ${JSON.stringify(offlineBody)}`);
  }

  node = spawnLogged('node', ['dist/remoteNode.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_NODE_ID: nodeId,
      CODEXPRO_GATEWAY_URL: gatewayBase,
      CODEXPRO_GATEWAY_NODE_TOKEN: nodeToken,
      CODEXPRO_LOCAL_API_URL: localBase,
      CODEXPRO_HTTP_TOKEN: localToken
    }
  });

  await waitForJson(
    `${gatewayBase}/v1/nodes`,
    { headers: { Authorization: `Bearer ${clientToken}` } },
    (body) => body.nodes?.some?.((item) => item.nodeId === nodeId && item.online === true)
  );

  const unauthorized = await fetch(`${gatewayBase}/v1/nodes`);
  if (unauthorized.status !== 401) {
    throw new Error(`expected gateway client routes to require bearer auth, got ${unauthorized.status}`);
  }

  const open = await fetch(`${gatewayBase}/v1/invoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ action: 'open_current_workspace', args: { include_tree: false } })
  });
  const openBody = await open.json();
  const workspaceId = openBody.result?.workspace_id;
  if (open.status !== 200 || openBody.ok !== true || !workspaceId) {
    throw new Error(`remote open_current_workspace failed: ${open.status} ${JSON.stringify(openBody)}`);
  }

  const read = await fetch(`${gatewayBase}/v1/invoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      action: 'read',
      args: { workspace_id: workspaceId, path: 'remote.txt' }
    })
  });
  const readBody = await read.json();
  if (
    read.status !== 200 ||
    readBody.ok !== true ||
    readBody.tool !== 'read' ||
    !String(readBody.result?.text ?? '').includes('remote gateway reached local workspace')
  ) {
    throw new Error(`remote read failed: ${read.status} ${JSON.stringify(readBody)}`);
  }

  const badTool = await fetch(`${gatewayBase}/v1/invoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ action: 'not_a_real_tool', args: {} })
  });
  const badToolBody = await badTool.json();
  if (badTool.status !== 400 || badToolBody.ok !== false) {
    throw new Error(`remote invalid tool did not preserve local failure: ${badTool.status} ${JSON.stringify(badToolBody)}`);
  }

  console.log('✓ remote gateway smoke test passed');
} catch (error) {
  const details = [
    localServer?._smokeStderr?.() ? `\nlocal server:\n${localServer._smokeStderr()}` : '',
    gateway?._smokeStderr?.() ? `\ngateway:\n${gateway._smokeStderr()}` : '',
    node?._smokeStderr?.() ? `\nnode:\n${node._smokeStderr()}` : ''
  ].join('');
  throw new Error(`${error instanceof Error ? error.message : String(error)}${details}`);
} finally {
  await stopChild(node);
  await stopChild(gateway);
  await stopChild(localServer);
  await fs.rm(root, { recursive: true, force: true });
}
