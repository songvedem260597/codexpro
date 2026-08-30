import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1))), '..');
const built = (relative) => pathToFileURL(path.join(repoRoot, 'dist', relative)).href;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-runtime-events-'));
const oldHome = process.env.CODEXPRO_HOME;
process.env.CODEXPRO_HOME = tmp;

try {
  const eventsApi = await import(built('runtimeEvents.js'));
  const workspace = { id: 'ws_runtime_events_smoke' };
  const taskId = 'cpt_aaaaaaaaaaaaaaaaaaaaaaaa';
  const taskTitle = 'Runtime event smoke';
  const startedAt = Date.now() - 100;

  await eventsApi.recordRuntimeEvent(workspace, {
    type: 'task.started',
    source: 'repo-task',
    taskId,
    taskTitle,
    traceId: 'trace-a',
    spanId: 'span-task',
    timestampMs: startedAt,
    payload: {
      scope: 'workspace',
      prompt: 'must-not-persist',
      authorization: 'must-not-persist'
    }
  });

  await eventsApi.recordRuntimeEvent(workspace, {
    type: 'tool.started',
    source: 'mcp-runtime',
    taskId,
    taskTitle,
    traceId: 'trace-a',
    spanId: 'span-read',
    parentSpanId: 'span-task',
    timestampMs: startedAt + 10,
    payload: { tool: 'read', action: 'file' }
  });

  await eventsApi.recordRuntimeEvent(workspace, {
    type: 'tool.failed',
    source: 'mcp-runtime',
    taskId,
    taskTitle,
    traceId: 'trace-a',
    spanId: 'span-read',
    parentSpanId: 'span-task',
    timestampMs: startedAt + 20,
    payload: { tool: 'read', action: 'file', durationMs: 10 }
  });

  await eventsApi.recordRuntimeEvent(workspace, {
    type: 'tool.started',
    source: 'mcp-runtime',
    taskId,
    taskTitle,
    traceId: 'trace-a',
    spanId: 'span-build',
    parentSpanId: 'span-task',
    timestampMs: startedAt + 30,
    payload: { tool: 'bash', action: 'build' }
  });

  let events = await eventsApi.loadRuntimeEvents(workspace, 100);
  assert.equal(events.length, 4);
  assert(events.every((event) => event.workspaceId === workspace.id));
  assert(events.every((event) => event.eventId && event.timestamp));

  let state = eventsApi.reduceTaskRuntimeState(events, taskId);
  assert(state, 'task state was not reconstructed');
  assert.equal(state.status, 'running');
  assert.equal(state.taskTitle, taskTitle);
  assert.equal(state.activeToolCount, 1);
  assert.equal(state.activeTools[0].name, 'bash');
  assert.equal(state.lastFailure?.tool, 'read');

  await Promise.all(Array.from({ length: 30 }, (_, index) => eventsApi.recordRuntimeEvent(workspace, {
    type: 'task.checkpointed',
    source: 'smoke',
    taskId,
    taskTitle,
    timestampMs: startedAt + 40 + index,
    payload: { index }
  })));

  await eventsApi.recordRuntimeEvent(workspace, {
    type: 'tool.completed',
    source: 'mcp-runtime',
    taskId,
    taskTitle,
    traceId: 'trace-a',
    spanId: 'span-build',
    parentSpanId: 'span-task',
    timestampMs: startedAt + 80,
    payload: { tool: 'bash', action: 'build', durationMs: 50 }
  });

  await eventsApi.recordRuntimeEvent(workspace, {
    type: 'task.completed',
    source: 'repo-task',
    taskId,
    taskTitle,
    timestampMs: startedAt + 90
  });

  events = await eventsApi.loadRuntimeEvents(workspace, 100);
  assert.equal(events.length, 36, 'concurrent event appends lost or corrupted records');
  state = eventsApi.reduceTaskRuntimeState(events, taskId);
  assert.equal(state?.status, 'completed');
  assert.equal(state?.activeToolCount, 0);
  assert(state?.completedAt);
  const loadedState = await eventsApi.loadTaskRuntimeState(workspace, taskId);
  assert.equal(loadedState?.status, 'completed');
  assert.equal(loadedState?.activeToolCount, 0);

  const limited = await eventsApi.loadRuntimeEvents(workspace, 5);
  assert.equal(limited.length, 5);

  const raw = await fs.readFile(eventsApi.runtimeEventPath(workspace), 'utf8');
  assert(!raw.includes('must-not-persist'), 'runtime events persisted a filtered sensitive payload');
  assert(!raw.includes('"prompt"'), 'runtime events persisted prompt payload');
  assert(!raw.includes('"authorization"'), 'runtime events persisted authorization payload');
  for (const line of raw.trim().split(/\r?\n/)) JSON.parse(line);

  console.log('✓ runtime event store and reducer smoke test passed');
} finally {
  if (oldHome === undefined) delete process.env.CODEXPRO_HOME;
  else process.env.CODEXPRO_HOME = oldHome;
  await fs.rm(tmp, { recursive: true, force: true });
}
