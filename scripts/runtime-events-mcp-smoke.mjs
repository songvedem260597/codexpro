import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

const repoRoot = path.resolve('.');
const built = (relative) => pathToFileURL(path.join(repoRoot, 'dist', relative)).href;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-runtime-event-mcp-root-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-runtime-event-mcp-home-'));
const oldHome = process.env.CODEXPRO_HOME;
await fs.writeFile(path.join(root, 'ok.txt'), 'runtime-events\n', 'utf8');

const client = new McpStdioClient('node', [
  'dist/stdio.js',
  '--root', root,
  '--allow-root', root,
  '--bash', 'off',
  '--tool-mode', 'standard'
], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CODEXPRO_HOME: home,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root
  }
});

try {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'runtime-events-mcp-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');

  const taskId = 'cpt_bbbbbbbbbbbbbbbbbbbbbbbb';
  const taskTitle = 'Runtime event integration';
  const prepared = await client.request('tools/call', {
    name: 'prepare_repo_task',
    arguments: { profile_id: 'runtime-events-smoke', task_id: taskId, root, scope: 'workspace' }
  });
  assert.equal(prepared.isError, undefined, JSON.stringify(prepared));
  const began = await client.request('tools/call', {
    name: 'begin_repo_task',
    arguments: { task_id: taskId, task_title: taskTitle, task_kind: 'code', root }
  });
  assert.equal(began.isError, undefined, JSON.stringify(began));
  const workspaceId = began.structuredContent.workspace_id;

  const okRead = await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'ok.txt' }
  });
  assert.equal(okRead.isError, undefined);

  const failedRead = await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'missing-sensitive-name.txt' }
  });
  assert.equal(failedRead.isError, true);

  process.env.CODEXPRO_HOME = home;
  const eventsApi = await import(built('runtimeEvents.js'));
  const workspace = { id: workspaceId };
  const events = await eventsApi.loadRuntimeEvents(workspace, 200);
  const taskEvents = events.filter((event) => event.taskId === taskId);

  assert(taskEvents.some((event) => event.type === 'task.started' && event.taskTitle === taskTitle), 'missing durable task.started event');
  assert(taskEvents.some((event) => event.type === 'tool.started' && event.payload?.tool === 'read'), 'missing tool.started event');
  assert(taskEvents.some((event) => event.type === 'tool.completed' && event.payload?.tool === 'read'), 'missing tool.completed event');
  assert(taskEvents.some((event) => event.type === 'tool.failed' && event.payload?.tool === 'read'), 'missing tool.failed event');

  const pairedSpans = new Map();
  for (const event of taskEvents.filter((item) => item.type.startsWith('tool.'))) {
    if (!event.spanId) continue;
    const list = pairedSpans.get(event.spanId) ?? [];
    list.push(event.type);
    pairedSpans.set(event.spanId, list);
  }
  assert([...pairedSpans.values()].some((types) => types.includes('tool.started') && types.includes('tool.completed')), 'completed tool lifecycle was not correlated by span id');
  assert([...pairedSpans.values()].some((types) => types.includes('tool.started') && types.includes('tool.failed')), 'failed tool lifecycle was not correlated by span id');

  const state = eventsApi.reduceTaskRuntimeState(events, taskId);
  assert(state, 'task state was not reconstructable from MCP events');
  assert.equal(state.status, 'running');
  assert.equal(state.activeToolCount, 0);
  assert.equal(state.lastFailure?.tool, 'read');

  const raw = await fs.readFile(eventsApi.runtimeEventPath(workspace), 'utf8');
  assert(!raw.includes('missing-sensitive-name.txt'), 'runtime event store leaked raw tool arguments');
  assert(!raw.includes('ok.txt'), 'runtime event store leaked file paths');

  console.log('✓ MCP runtime event integration smoke test passed');
} finally {
  client.close();
  if (oldHome === undefined) delete process.env.CODEXPRO_HOME;
  else process.env.CODEXPRO_HOME = oldHome;
  await Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(home, { recursive: true, force: true })
  ]);
}
