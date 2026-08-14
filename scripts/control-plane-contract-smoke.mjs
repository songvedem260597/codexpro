import assert from 'node:assert/strict';
import { boundedReviewCommand, controlPlaneToolDefinitions } from '../dist/controlPlaneOps.js';

assert.deepEqual(
  boundedReviewCommand('npx vitest run src'),
  { executable: 'npx', args: ['vitest', 'run', 'src'] },
  'review runner must accept a bounded Vitest target'
);
for (const unsafeCommand of [
  'npx vitest run --config ../../tmp/evil.ts',
  'npx vitest run ../outside',
  'npx eslint .',
  'npx vitest run src && touch owned'
]) {
  assert.equal(boundedReviewCommand(unsafeCommand), null, `review runner must reject ${unsafeCommand}`);
}

const requests = [];
let overviewPayload = { workers: [{ id: 'coordinator-contract', role: 'coordinator' }] };
let tasksPayload = { tasks: [] };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  requests.push({ pathname: url.pathname, method: init.method ?? 'GET', body: init.body ?? '' });
  if (url.pathname === '/api/overview') {
    return Response.json(overviewPayload);
  }
  if (url.pathname === '/api/tasks' && (init.method ?? 'GET') === 'GET') {
    return Response.json(tasksPayload);
  }
  if (url.pathname.endsWith('/receipts') && init.method === 'POST') {
    return Response.json({ eventId: requests.length }, { status: 201 });
  }
  if (url.pathname === '/api/tasks' && init.method === 'POST') {
    return Response.json({ task: { id: 'TASK-CHILD' }, eventId: 1 }, { status: 201 });
  }
  if (url.pathname === '/api/tasks/TASK-SCHEMA-BLOCKER/unblock-transient' && init.method === 'POST') {
    return Response.json({ task: { id: 'TASK-SCHEMA-BLOCKER', status: 'READY' }, eventId: 2 });
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
  const taskSubmitForReview = definitions.find((definition) => definition.name === 'task_submit_for_review');
  assert.ok(taskCreate, 'task_create must be exposed');
  assert.ok(taskSubmitForReview, 'task_submit_for_review must be exposed');
  const schemaKeys = Object.keys(taskCreate.options.inputSchema ?? {});
  for (const field of ['id', 'parentTaskId', 'dependencyIds']) {
    assert.ok(schemaKeys.includes(field), `task_create schema must expose ${field}`);
  }
  const submitSchemaKeys = Object.keys(taskSubmitForReview.options.inputSchema ?? {});
  assert.ok(submitSchemaKeys.includes('evidence'), 'task_submit_for_review must expose structured evidence');
  assert.ok(submitSchemaKeys.includes('touchedPaths'), 'task_submit_for_review must expose the full touched path list');
  assert.doesNotThrow(
    () => taskSubmitForReview.options.inputSchema.touchedPaths.parse([]),
    'read-only Coordinator/Reviewer tasks must allow an empty touched path list'
  );

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

  tasksPayload = {
    tasks: [{
      id: 'TASK-SCHEMA-BLOCKER',
      status: 'BLOCKED',
      requiredRole: 'frontend',
      checkpoint: {
        blockerKind: 'TRANSIENT',
        blockedReason: 'CONTROL_PLANE_READ_ONLY_SUBMISSION_SCHEMA_CONFLICT: task_submit_for_review requires touchedPaths, but this read-only task has allowedPaths=[]'
      }
    }]
  };
  const unblockTransient = definitions.find((definition) => definition.name === 'task_unblock_transient');
  assert.ok(unblockTransient, 'task_unblock_transient must be exposed');
  const resumed = await unblockTransient.handler({ taskId: 'TASK-SCHEMA-BLOCKER' });
  assert.equal(resumed.structuredContent.task.status, 'READY');
  const unblockMutation = requests.find((request) => request.pathname === '/api/tasks/TASK-SCHEMA-BLOCKER/unblock-transient');
  assert.ok(unblockMutation, 'typed Change Submission contract failure must be resumed automatically');
  assert.match(JSON.parse(String(unblockMutation.body)).evidenceHash, /^sha256:[a-f0-9]{64}$/u);

  overviewPayload = {
    workers: [{ id: 'reviewer-contract', role: 'reviewer_qa', sessionEpoch: 1 }],
    governance: {
      activeRulesetHash: 'sha256:review-rules',
      workerAcks: [{
        workerId: 'reviewer-contract',
        rulesetHash: 'sha256:review-rules',
        source: 'CODEXPRO_WORKER_CONNECTOR'
      }]
    },
    pendingInstructions: []
  };
  tasksPayload = {
    tasks: [
      {
        id: 'TASK-REVIEW-INTEGRATION',
        status: 'READY',
        readyForClaim: false,
        requiredRole: 'reviewer_qa',
        priority: 100
      },
      {
        id: 'TASK-BACKEND-IN-REVIEW',
        status: 'IN_REVIEW',
        readyForClaim: false,
        requiredRole: 'backend',
        priority: 80
      }
    ]
  };
  const reviewerDefinitions = controlPlaneToolDefinitions({
    baseUrl: 'http://127.0.0.1:4317',
    workerId: 'reviewer-contract',
    token: 'control-plane-contract-smoke-token'
  });
  const workerCycleStart = reviewerDefinitions.find((definition) => definition.name === 'worker_cycle_start');
  const reviewCiCheckRecord = reviewerDefinitions.find((definition) => definition.name === 'review_ci_check_record');
  assert.ok(workerCycleStart, 'worker_cycle_start must be exposed');
  assert.ok(reviewCiCheckRecord, 'review_ci_check_record must be exposed');
  const reviewCycle = await workerCycleStart.handler({});
  assert.equal(reviewCycle.structuredContent.state, 'REVIEW_READY');
  assert.equal(reviewCycle.structuredContent.reviewTasks[0].id, 'TASK-BACKEND-IN-REVIEW');
  assert.equal(
    requests.some((request) => request.pathname === '/api/tasks/TASK-REVIEW-INTEGRATION/claim'),
    false,
    'worker_cycle_start must not claim a READY task whose dependencies are incomplete'
  );
  console.log('control plane contract smoke passed');
} finally {
  globalThis.fetch = originalFetch;
}
