import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1))), '..');
const built = (relative) => pathToFileURL(path.join(repoRoot, 'dist', relative)).href;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-runtime-trace-'));
const oldHome = process.env.CODEXPRO_HOME;
process.env.CODEXPRO_HOME = tmp;

try {
  const traceApi = await import(built('analysis/runtimeTrace.js'));
  const workspace = { id: 'ws_runtime_trace_smoke', root: path.join(tmp, 'repo'), openedAt: new Date().toISOString() };
  await fs.mkdir(workspace.root, { recursive: true });

  assert.equal(traceApi.currentRuntimeTraceContext(), undefined, 'trace context leaked outside an operation');
  const parentContext = traceApi.createRuntimeTraceContext(workspace);
  await traceApi.runWithRuntimeTraceContext(parentContext, async () => {
    await Promise.resolve();
    assert.equal(traceApi.currentRuntimeTraceContext()?.spanId, parentContext.spanId, 'trace context did not survive await');
    const childContext = traceApi.createRuntimeTraceContext(workspace, traceApi.currentRuntimeTraceContext());
    assert.equal(childContext.traceId, parentContext.traceId, 'child context did not inherit trace id');
    assert.equal(childContext.parentSpanId, parentContext.spanId, 'child context did not link to parent span');
    assert.notEqual(childContext.spanId, parentContext.spanId, 'child context reused parent span id');
    await traceApi.runWithRuntimeTraceContext(childContext, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(traceApi.currentRuntimeTraceContext()?.spanId, childContext.spanId, 'child trace context did not survive timer');
    });
    assert.equal(traceApi.currentRuntimeTraceContext()?.spanId, parentContext.spanId, 'parent trace context was not restored after child');
  });
  assert.equal(traceApi.currentRuntimeTraceContext(), undefined, 'trace context leaked after operation');

  const startedAtMs = Date.now() - 25;
  const first = await traceApi.recordRuntimeTraceSpan(workspace, {
    kind: 'tool',
    name: 'browser_control',
    action: 'send_chat_request',
    source: 'mcp-tool',
    status: 'ok',
    startedAtMs,
    endedAtMs: startedAtMs + 20
  });
  assert.equal(first.workspaceId, workspace.id);
  assert.equal(first.durationMs, 20);

  await Promise.all(Array.from({ length: 40 }, (_, index) => traceApi.recordRuntimeTraceSpan(workspace, {
    traceId: first.traceId,
    parentSpanId: first.spanId,
    kind: index % 2 ? 'browser-extension' : 'tool',
    name: index % 2 ? 'extension-command' : 'read',
    action: index % 2 ? 'check_chatgpt' : undefined,
    source: index % 2 ? 'browser-extension-bridge' : 'mcp-tool',
    status: index === 17 ? 'error' : 'ok',
    startedAtMs: startedAtMs + index,
    endedAtMs: startedAtMs + index + 3
  })));

  const spans = await traceApi.loadRuntimeTraceSpans(workspace, 100);
  assert.equal(spans.length, 41, 'concurrent trace appends lost or corrupted spans');
  assert(spans.every((span) => span.workspaceId === workspace.id), 'trace reader leaked another workspace');
  assert(spans.some((span) => span.status === 'error'), 'error status was not persisted');
  assert(spans.every((span) => span.durationMs >= 0), 'negative duration persisted');

  const limited = await traceApi.loadRuntimeTraceSpans(workspace, 5);
  assert.equal(limited.length, 5, 'trace load limit was not enforced');

  const raw = await fs.readFile(traceApi.runtimeTracePath(workspace), 'utf8');
  assert(!raw.includes('prompt'), 'runtime trace must not persist prompt content');
  assert(!raw.includes('args'), 'runtime trace must not persist raw tool args');
  assert(!raw.includes('token'), 'runtime trace must not persist tokens');
  for (const line of raw.trim().split(/\r?\n/)) JSON.parse(line);

  console.log('✓ runtime trace storage smoke test passed');
} finally {
  if (oldHome === undefined) delete process.env.CODEXPRO_HOME;
  else process.env.CODEXPRO_HOME = oldHome;
  await fs.rm(tmp, { recursive: true, force: true });
}
