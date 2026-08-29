import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!message.id || !this.pending.has(message.id)) continue;
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

function traceFile(home, workspaceId) {
  const safeId = String(workspaceId || 'workspace').replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(home, 'runtime-traces', `${safeId}.jsonl`);
}

async function readSpans(home, workspaceId) {
  const raw = await fs.readFile(traceFile(home, workspaceId), 'utf8');
  return {
    raw,
    spans: raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  };
}

const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-runtime-mcp-a-'));
const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-runtime-mcp-b-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-runtime-mcp-home-'));
await fs.writeFile(path.join(rootA, 'a.txt'), 'workspace-a\n', 'utf8');
await fs.writeFile(path.join(rootB, 'b.txt'), 'workspace-b\n', 'utf8');

const client = new McpStdioClient('node', [
  'dist/stdio.js',
  '--root', rootA,
  '--allow-root', rootA,
  '--allow-root', rootB,
  '--bash', 'off',
  '--tool-mode', 'standard'
], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_HOME: home,
    CODEXPRO_ROOT: rootA,
    CODEXPRO_ALLOWED_ROOTS: [rootA, rootB].join(path.delimiter)
  }
});

try {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'runtime-trace-mcp-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');

  const openedA = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
  assert.equal(openedA.isError, undefined);
  const workspaceA = openedA.structuredContent.workspace_id;

  const supertool = await client.request('tools/call', { name: 'codexpro', arguments: { action: 'server_config' } });
  assert.equal(supertool.isError, undefined);

  const failedRead = await client.request('tools/call', { name: 'read', arguments: { workspace_id: workspaceA, path: 'missing.txt' } });
  assert.equal(failedRead.isError, true, 'expected missing read to return an MCP tool error');

  const openedB = await client.request('tools/call', { name: 'open_workspace', arguments: { root: rootB, include_tree: false } });
  assert.equal(openedB.isError, undefined);
  const workspaceB = openedB.structuredContent.workspace_id;
  assert.notEqual(workspaceB, workspaceA);

  const readB = await client.request('tools/call', { name: 'read', arguments: { path: 'b.txt' } });
  assert.equal(readB.isError, undefined);

  const traceA = await readSpans(home, workspaceA);
  const traceB = await readSpans(home, workspaceB);

  assert(traceA.spans.some((span) => span.kind === 'tool' && span.name === 'open_current_workspace' && span.status === 'ok'), 'workspace A missing open_current_workspace trace');
  assert(traceA.spans.some((span) => span.kind === 'tool' && span.name === 'codexpro' && span.action === 'server_config' && span.status === 'ok'), 'workspace A missing supertool action trace');
  assert(traceA.spans.some((span) => span.kind === 'tool' && span.name === 'read' && span.status === 'error'), 'workspace A missing failed read trace');
  assert(traceB.spans.some((span) => span.kind === 'tool' && span.name === 'open_workspace' && span.status === 'ok'), 'workspace B missing open_workspace trace');
  assert(traceB.spans.some((span) => span.kind === 'tool' && span.name === 'read' && span.status === 'ok'), 'workspace B missing selected-workspace read trace');
  assert(traceA.spans.every((span) => span.workspaceId === workspaceA), 'workspace A trace file contains another workspace');
  assert(traceB.spans.every((span) => span.workspaceId === workspaceB), 'workspace B trace file contains another workspace');

  for (const raw of [traceA.raw, traceB.raw]) {
    assert(!raw.includes('missing.txt'), 'runtime trace leaked raw tool arguments');
    assert(!raw.includes('b.txt'), 'runtime trace leaked file path arguments');
    assert(!raw.includes('prompt'), 'runtime trace leaked prompt data');
    assert(!raw.includes('token'), 'runtime trace leaked token data');
  }

  console.log('✓ MCP runtime trace integration smoke test passed');
} finally {
  client.close();
  await Promise.all([
    fs.rm(rootA, { recursive: true, force: true }),
    fs.rm(rootB, { recursive: true, force: true }),
    fs.rm(home, { recursive: true, force: true })
  ]);
}
