import assert from 'node:assert/strict';
import { controlPlaneToolDefinitions } from '../dist/controlPlaneOps.js';

const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  requests.push({ pathname: url.pathname, method: init.method ?? 'GET', body: init.body ?? '' });
  if (url.pathname === '/api/overview') {
    return Response.json({ workers: [{ id: 'coordinator-contract', role: 'coordinator' }] });
  }
  if (url.pathname === '/api/tasks' && init.method === 'POST') {
    return Response.json({ task: { id: 'TASK-CHILD' }, eventId: 1 }, { status: 201 });
  }
  return Response.json({ error: { code: 'NOT_FOUND', message: 'not found' } }, { status: 404 });
};

try {
  const definitions = controlPlaneToolDefinitions({
    baseUrl: 'http://127.0.0.1:4317',
    workerId: 'coordinator-contract',
    token: 'control-plane-contract-smoke-token'
  });
  const taskCreate = definitions.find((definition) => definition.name === 'task_create');
  assert.ok(taskCreate, 'task_create must be exposed');
  const schemaKeys = Object.keys(taskCreate.options.inputSchema ?? {});
  for (const field of ['id', 'parentTaskId', 'dependencyIds']) {
    assert.ok(schemaKeys.includes(field), `task_create schema must expose ${field}`);
  }

  await taskCreate.handler({
    id: 'TASK-CHILD',
    parentTaskId: 'TASK-PARENT',
    dependencyIds: ['TASK-PREREQUISITE'],
    title: 'Contract child task',
    requiredRole: 'reviewer_qa',
    priority: 90,
    acceptanceCriteria: ['Preserve the durable DAG edge'],
    allowedPaths: []
  });

  const mutation = requests.find((request) => request.pathname === '/api/tasks' && request.method === 'POST');
  assert.ok(mutation, 'task_create must call the Control Plane task endpoint');
  const body = JSON.parse(String(mutation.body));
  assert.equal(body.id, 'TASK-CHILD');
  assert.equal(body.parentTaskId, 'TASK-PARENT');
  assert.deepEqual(body.dependencyIds, ['TASK-PREREQUISITE']);
  console.log('control plane contract smoke passed');
} finally {
  globalThis.fetch = originalFetch;
}
