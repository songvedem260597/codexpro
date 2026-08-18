import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedReviewCommand, controlPlaneToolDefinitions } from '../dist/controlPlaneOps.js';

assert.deepEqual(
  boundedReviewCommand('npx vitest run src'),
  { executable: 'npx', args: ['vitest', 'run', 'src'] },
  'review runner must accept a bounded Vitest target'
);
assert.deepEqual(
  boundedReviewCommand('npx tsx --test test/control-plane.test.ts test/http-server.test.ts'),
  { executable: 'npx', args: ['tsx', '--test', 'test/control-plane.test.ts', 'test/http-server.test.ts'] },
  'review runner must accept bounded TSX node-test targets declared by Change Submission'
);
assert.deepEqual(
  boundedReviewCommand('cd client && npm test'),
  { executable: 'npm', args: ['test'], relativeCwd: 'client' },
  'review runner must safely normalize a declared package-directory test'
);
assert.deepEqual(
  boundedReviewCommand('npm test (cwd client)'),
  { executable: 'npm', args: ['test'], relativeCwd: 'client' },
  'review runner must safely normalize the Change Submission cwd annotation'
);
assert.deepEqual(
  boundedReviewCommand('npm run build (cwd client)'),
  { executable: 'npm', args: ['run', 'build'], relativeCwd: 'client' },
  'review runner must preserve the existing command allowlist inside a cwd annotation'
);
assert.deepEqual(
  boundedReviewCommand('cd server && node --test test/api.test.js'),
  { executable: 'node', args: ['--test', 'test/api.test.js'], relativeCwd: 'server' },
  'review runner must accept the bounded Backend node test declared by Change Submission'
);
assert.deepEqual(
  boundedReviewCommand('cd server && node --test --test-name-pattern "categories endpoint" test/api.test.js'),
  { executable: 'node', args: ['--test', '--test-name-pattern', 'categories endpoint', 'test/api.test.js'], relativeCwd: 'server' },
  'review runner must preserve one bounded node test-name pattern inside the package directory'
);
for (const unsafeCommand of [
  'npx vitest run --config ../../tmp/evil.ts',
  'npx vitest run ../outside',
  'npx eslint .',
  'npx vitest run src && touch owned',
  'npx tsx --test ../outside',
  'npx tsx --test --inspect test/control-plane.test.ts',
  'npx tsx test/control-plane.test.ts',
  'npx tsx --test test/control-plane.test.ts && touch owned',
  'cd ../outside && npm test',
  'cd client; touch owned && npm test',
  'cd client && cd nested && npm test',
  'npm test (cwd ../outside)',
  'npm test (cwd client;touch-owned)',
  'cd client && npm test (cwd nested)',
  'cd server && node --test ../outside',
  'cd server && node --test --inspect test/api.test.js',
  'cd server && node --test test/api.test.js && touch owned',
  'cd server && node --test --test-name-pattern "categories; touch owned" test/api.test.js'
]) {
  assert.equal(boundedReviewCommand(unsafeCommand), null, `review runner must reject ${unsafeCommand}`);
}

const requests = [];
const safetySubmissionWorktree = realpathSync(mkdtempSync(join(tmpdir(), 'codexpro-submission-safety-')));
writeFileSync(join(safetySubmissionWorktree, 'server.js'), 'console.log("ready");\n');
mkdirSync(join(safetySubmissionWorktree, 'client', 'scripts'), { recursive: true });
writeFileSync(join(safetySubmissionWorktree, 'client', 'index.html'), '<!doctype html><title>runtime smoke fixture</title>\n');
writeFileSync(
  join(safetySubmissionWorktree, 'client', 'scripts', 'dev-server.mjs'),
  'import http from "node:http"; const port=Number(process.env.PORT); http.createServer((_req,res)=>{res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end("fixture");}).listen(port,"127.0.0.1");\n'
);
execFileSync('git', ['init', '-b', 'main'], { cwd: safetySubmissionWorktree, stdio: 'ignore' });
execFileSync('git', ['add', '.'], { cwd: safetySubmissionWorktree });
execFileSync('git', ['-c', 'user.name=CodexPro Contract', '-c', 'user.email=contract@codexpro.local', 'commit', '-m', 'fixture'], {
  cwd: safetySubmissionWorktree,
  stdio: 'ignore'
});
const safetySubmissionHead = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: safetySubmissionWorktree })).trim();
let overviewPayload = { workers: [{ id: 'coordinator-contract', role: 'coordinator' }], pendingInstructions: [] };
let tasksPayload = { tasks: [] };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1' && url.port && url.port !== '4317') {
    return originalFetch(input, init);
  }
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
  if (url.pathname === '/api/tasks/TASK-RUNNING/instructions' && init.method === 'POST') {
    return Response.json({ instruction: { taskId: 'TASK-RUNNING', revision: 2, status: 'PENDING' }, eventId: 12 }, { status: 201 });
  }
  if (url.pathname === '/api/tasks/TASK-BACKEND-IN-REVIEW/review/findings' && init.method === 'POST') {
    return Response.json({ finding: { id: 'FINDING-CONTRACT', status: 'OPEN' }, eventId: 3 }, { status: 201 });
  }
  if (url.pathname === '/api/review-findings/FINDING-CONTRACT' && init.method === 'POST') {
    return Response.json({ finding: { id: 'FINDING-CONTRACT', status: 'RESOLVED' }, eventId: 4 });
  }
  if (url.pathname === '/api/tasks/TASK-BACKEND-IN-REVIEW/review/request-changes' && init.method === 'POST') {
    return Response.json({ task: { id: 'TASK-BACKEND-IN-REVIEW', status: 'READY' }, eventId: 5 });
  }
  if (url.pathname === '/api/tasks/TASK-SCHEMA-BLOCKER/unblock-transient' && init.method === 'POST') {
    return Response.json({ task: { id: 'TASK-SCHEMA-BLOCKER', status: 'READY' }, eventId: 2 });
  }
  if (url.pathname === '/api/tasks/TASK-PATCH-BLOCKER/unblock-transient' && init.method === 'POST') {
    return Response.json({ task: { id: 'TASK-PATCH-BLOCKER', status: 'READY' }, eventId: 6 });
  }
  if (url.pathname === '/api/tasks/TASK-SUBMISSION-SAFETY/unblock-transient' && init.method === 'POST') {
    return Response.json({ task: { id: 'TASK-SUBMISSION-SAFETY', status: 'READY' }, eventId: 7 });
  }
  if (url.pathname === '/api/tasks/TASK-CHECKPOINT-SAFETY/unblock-transient' && init.method === 'POST') {
    return Response.json({ task: { id: 'TASK-CHECKPOINT-SAFETY', status: 'READY' }, eventId: 8 });
  }
  if (url.pathname === '/api/tasks/TASK-PRECLAIM-SAFETY/unblock-transient' && init.method === 'POST') {
    return Response.json({ task: { id: 'TASK-PRECLAIM-SAFETY', status: 'READY' }, eventId: 10 });
  }
  if (url.pathname === '/api/tasks/TASK-SCOPED-MUTATION-SAFETY/unblock-transient' && init.method === 'POST') {
    return Response.json({ task: { id: 'TASK-SCOPED-MUTATION-SAFETY', status: 'READY' }, eventId: 11 });
  }
  if (url.pathname === '/api/tasks/TASK-RUNTIME-SMOKE-SAFETY/unblock-transient' && init.method === 'POST') {
    return Response.json({ task: { id: 'TASK-RUNTIME-SMOKE-SAFETY', status: 'READY' }, eventId: 9 });
  }
  return Response.json({ error: { code: 'NOT_FOUND', message: 'not found' } }, { status: 404 });
};

try {
  const definitions = controlPlaneToolDefinitions({
    baseUrl: 'http://127.0.0.1:4317',
    workerId: 'coordinator-contract',
    token: 'control-plane-contract-smoke-token',
    allowedRoots: [safetySubmissionWorktree]
  });
  const taskCreate = definitions.find((definition) => definition.name === 'task_create');
  const taskInstructionIssue = definitions.find((definition) => definition.name === 'task_instruction_issue');
  const taskSubmitForReview = definitions.find((definition) => definition.name === 'task_submit_for_review');
  const controlOverview = definitions.find((definition) => definition.name === 'control_overview');
  assert.ok(taskCreate, 'task_create must be exposed');
  assert.ok(taskInstructionIssue, 'task_instruction_issue must be exposed');
  assert.ok(taskSubmitForReview, 'task_submit_for_review must be exposed');
  assert.ok(controlOverview, 'control_overview must be exposed');
  overviewPayload.pendingInstructions = [{ taskId: 'TASK-RUNNING-UPDATE', revision: 2, status: 'PENDING', instruction: 'Apply the routed update.' }];
  tasksPayload = { tasks: [{ id: 'TASK-RUNNING-UPDATE', requiredRole: 'coordinator', status: 'RUNNING' }] };
  const protocolOverview = await controlOverview.handler({});
  const protocolText = protocolOverview.structuredContent.protocol.join('\n');
  assert.equal(protocolOverview.structuredContent.pendingInstructions[0].revision, 2, 'control_overview must expose pending instructions for the bound worker task');
  assert.match(protocolText, /acknowledge the highest applied revision/u);
  overviewPayload.pendingInstructions = [];
  tasksPayload = { tasks: [] };
  assert.match(protocolText, /do not call task_claim_or_resume again for the same automatic cycle/u);
  assert.doesNotMatch(protocolText, /then call task_claim_or_resume/u);
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

  await taskInstructionIssue.handler({
    requestTaskId: 'TASK-UPDATE-REQUEST',
    targetTaskId: 'TASK-RUNNING'
  });
  const instructionMutation = requests.find((request) => request.pathname === '/api/tasks/TASK-RUNNING/instructions' && request.method === 'POST');
  assert.ok(instructionMutation, 'task_instruction_issue must call the running task instruction endpoint');
  assert.deepEqual(JSON.parse(String(instructionMutation.body)), { requestTaskId: 'TASK-UPDATE-REQUEST' });

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

  tasksPayload = {
    tasks: [{
      id: 'TASK-PATCH-BLOCKER',
      status: 'BLOCKED',
      requiredRole: 'frontend',
      checkpoint: {
        blockerKind: 'TRANSIENT',
        blockedReason: 'CodexPro source mutation blocker: apply_patch rejected a bounded patch with Patch must include at least one file path.'
      }
    }]
  };
  const patchResumed = await unblockTransient.handler({ taskId: 'TASK-PATCH-BLOCKER' });
  assert.equal(patchResumed.structuredContent.task.status, 'READY');
  const patchUnblockMutation = requests.find((request) => request.pathname === '/api/tasks/TASK-PATCH-BLOCKER/unblock-transient');
  assert.ok(patchUnblockMutation, 'the installed patch envelope contract must resume a source-mutation tool blocker');
  const patchUnblockBody = JSON.parse(String(patchUnblockMutation.body));
  assert.match(patchUnblockBody.evidenceHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(patchUnblockBody.note, /patch envelope contract v1/u);

  overviewPayload = {
    workers: [
      { id: 'coordinator-contract', role: 'coordinator' },
      { id: 'backend-contract', role: 'backend', worktreePath: safetySubmissionWorktree },
      { id: 'frontend-contract', role: 'frontend', worktreePath: safetySubmissionWorktree }
    ]
  };
  tasksPayload = {
    tasks: [{
      id: 'TASK-SUBMISSION-SAFETY',
      status: 'BLOCKED',
      requiredRole: 'backend',
      checkpoint: {
        blockerKind: 'TRANSIENT',
        blockedReason: 'OpenAI safety layer blocked the task_submit_for_review tool call after implementation, tests, checkpoint, and commit completed successfully.'
      }
    }]
  };
  const safetySubmissionResumed = await unblockTransient.handler({ taskId: 'TASK-SUBMISSION-SAFETY' });
  assert.equal(safetySubmissionResumed.structuredContent.task.status, 'READY');
  const safetySubmissionMutation = requests.find((request) => request.pathname === '/api/tasks/TASK-SUBMISSION-SAFETY/unblock-transient');
  assert.ok(safetySubmissionMutation, 'a committed safety-layer-blocked submission must be resumed automatically');
  const safetySubmissionBody = JSON.parse(String(safetySubmissionMutation.body));
  assert.match(safetySubmissionBody.evidenceHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(safetySubmissionBody.note, /verified clean committed HEAD [a-f0-9]{40}/u);

  tasksPayload = {
    tasks: [{
      id: 'TASK-CHECKPOINT-SAFETY',
      status: 'BLOCKED',
      requiredRole: 'backend',
      checkpoint: {
        blockerKind: 'TRANSIENT',
        blockedReason: 'CodexPro task_checkpoint calls were blocked by the OpenAI safety layer after implementation, tests, and commit completed successfully.'
      }
    }]
  };
  const safetyCheckpointResumed = await unblockTransient.handler({ taskId: 'TASK-CHECKPOINT-SAFETY' });
  assert.equal(safetyCheckpointResumed.structuredContent.task.status, 'READY');
  const safetyCheckpointMutation = requests.find((request) => request.pathname === '/api/tasks/TASK-CHECKPOINT-SAFETY/unblock-transient');
  assert.ok(safetyCheckpointMutation, 'a committed safety-layer-blocked checkpoint must be resumed automatically');
  const safetyCheckpointBody = JSON.parse(String(safetyCheckpointMutation.body));
  assert.match(safetyCheckpointBody.evidenceHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(safetyCheckpointBody.note, /safety blocked task_checkpoint/u);

  tasksPayload = {
    tasks: [{
      id: 'TASK-PRECLAIM-SAFETY',
      status: 'BLOCKED',
      requiredRole: 'frontend',
      checkpoint: {
        blockerKind: 'TRANSIENT',
        blockedReason: 'The task_claim_or_resume call was blocked by OpenAI safety before any source mutation; the worktree is still clean.'
      }
    }]
  };
  const safetyPreclaimResumed = await unblockTransient.handler({ taskId: 'TASK-PRECLAIM-SAFETY' });
  assert.equal(safetyPreclaimResumed.structuredContent.task.status, 'READY');
  const safetyPreclaimMutation = requests.find((request) => request.pathname === '/api/tasks/TASK-PRECLAIM-SAFETY/unblock-transient');
  assert.ok(safetyPreclaimMutation, 'a safety-blocked redundant preclaim must resume only after the assigned worktree is verified clean');
  const safetyPreclaimBody = JSON.parse(String(safetyPreclaimMutation.body));
  assert.match(safetyPreclaimBody.evidenceHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(safetyPreclaimBody.note, /worktree is still clean at HEAD [a-f0-9]{40}/u);
  assert.match(safetyPreclaimBody.note, /fresh fenced retry/u);

  writeFileSync(join(safetySubmissionWorktree, 'server.js'), 'console.log("partially updated");\n');
  tasksPayload = {
    tasks: [{
      id: 'TASK-SCOPED-MUTATION-SAFETY',
      status: 'BLOCKED',
      requiredRole: 'frontend',
      allowedPaths: ['server.js', 'test/control-plane.test.ts'],
      checkpoint: {
        blockerKind: 'TRANSIENT',
        blockedReason: 'Required regression coverage in test/control-plane.test.ts was blocked by the OpenAI safety mechanism before mutation after a bounded source edit.'
      }
    }]
  };
  const scopedMutationResumed = await unblockTransient.handler({ taskId: 'TASK-SCOPED-MUTATION-SAFETY' });
  assert.equal(scopedMutationResumed.structuredContent.task.status, 'READY');
  const scopedMutation = requests.find((request) => request.pathname === '/api/tasks/TASK-SCOPED-MUTATION-SAFETY/unblock-transient');
  assert.ok(scopedMutation, 'a safety-blocked pre-mutation retry must preserve partial work only when every dirty path stays inside task.allowedPaths');
  const scopedMutationBody = JSON.parse(String(scopedMutation.body));
  assert.match(scopedMutationBody.evidenceHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(scopedMutationBody.note, /all 1 dirty worktree path\(s\) remain inside task\.allowedPaths/u);
  assert.match(scopedMutationBody.note, /same-task retry/u);
  execFileSync('git', ['checkout', '--', 'server.js'], { cwd: safetySubmissionWorktree });

  tasksPayload = {
    tasks: [{
      id: 'TASK-RUNTIME-SMOKE-SAFETY',
      status: 'BLOCKED',
      requiredRole: 'frontend',
      checkpoint: {
        blockerKind: 'TRANSIENT',
        commitSha: safetySubmissionHead,
        tests: [
          { command: 'cd client && npm test', status: 'PASS', summary: 'Client tests passed.' },
          { command: 'cd client && node scripts/dev-server.mjs', status: 'BLOCKED', summary: 'OpenAI safety checker blocked the smoke before execution.' }
        ],
        blockedReason: 'Implementation and regression tests are complete and committed. Required HTTP/runtime smoke could not be executed because the tool invocation `cd client && node scripts/dev-server.mjs` was blocked by the OpenAI safety checker before execution.'
      }
    }]
  };
  const runtimeSmokeResumed = await unblockTransient.handler({ taskId: 'TASK-RUNTIME-SMOKE-SAFETY' });
  assert.equal(runtimeSmokeResumed.structuredContent.task.status, 'READY');
  const runtimeSmokeMutation = requests.find((request) => request.pathname === '/api/tasks/TASK-RUNTIME-SMOKE-SAFETY/unblock-transient');
  assert.ok(runtimeSmokeMutation, 'a committed safety-checker-blocked runtime smoke must be resumed only after an objective smoke probe');
  const runtimeSmokeBody = JSON.parse(String(runtimeSmokeMutation.body));
  assert.match(runtimeSmokeBody.evidenceHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(runtimeSmokeBody.verifiedEvidence.kind, 'CODEXPRO_RUNTIME_SMOKE_VERIFIED');
  assert.equal(runtimeSmokeBody.verifiedEvidence.taskId, 'TASK-RUNTIME-SMOKE-SAFETY');
  assert.equal(runtimeSmokeBody.verifiedEvidence.command, 'cd client && node scripts/dev-server.mjs');
  assert.equal(runtimeSmokeBody.verifiedEvidence.status, 'PASS');
  assert.equal(runtimeSmokeBody.verifiedEvidence.httpStatus, 200);
  assert.equal(runtimeSmokeBody.verifiedEvidence.headSha, safetySubmissionHead);
  assert.match(runtimeSmokeBody.verifiedEvidence.summary, /received HTTP 200/u);
  assert.match(runtimeSmokeBody.note, /required runtime smoke now has objective PASS evidence/u);

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
  const reviewFindingCreate = reviewerDefinitions.find((definition) => definition.name === 'review_finding_create');
  const reviewFindingUpdate = reviewerDefinitions.find((definition) => definition.name === 'review_finding_update');
  const reviewChangesRequest = reviewerDefinitions.find((definition) => definition.name === 'review_changes_request');
  assert.ok(workerCycleStart, 'worker_cycle_start must be exposed');
  assert.ok(reviewCiCheckRecord, 'review_ci_check_record must be exposed');
  assert.ok(reviewFindingCreate, 'review_finding_create must be exposed');
  assert.ok(reviewFindingUpdate, 'review_finding_update must be exposed');
  assert.ok(reviewChangesRequest, 'review_changes_request must be exposed');
  const reviewCycle = await workerCycleStart.handler({});
  assert.equal(reviewCycle.structuredContent.state, 'REVIEW_READY');
  assert.equal(reviewCycle.structuredContent.reviewTasks[0].id, 'TASK-BACKEND-IN-REVIEW');
  assert.match(reviewCycle.structuredContent.nextAction, /create a durable review finding and request changes/u);
  assert.match(reviewCycle.structuredContent.nextAction, /remediation child tasks/u);
  const createdFinding = await reviewFindingCreate.handler({
    taskId: 'TASK-BACKEND-IN-REVIEW',
    severity: 'HIGH',
    category: 'contract',
    title: 'Contract finding',
    detail: 'The connector must preserve a durable review finding.'
  });
  assert.equal(createdFinding.structuredContent.finding.id, 'FINDING-CONTRACT');
  const requestedChanges = await reviewChangesRequest.handler({
    taskId: 'TASK-BACKEND-IN-REVIEW',
    note: 'Address FINDING-CONTRACT in a fresh fenced attempt.'
  });
  assert.equal(requestedChanges.structuredContent.task.status, 'READY');
  const updatedFinding = await reviewFindingUpdate.handler({
    findingId: 'FINDING-CONTRACT',
    status: 'RESOLVED',
    resolutionNote: 'Verified by the contract smoke.'
  });
  assert.equal(updatedFinding.structuredContent.finding.status, 'RESOLVED');
  assert.equal(
    requests.some((request) => request.pathname === '/api/tasks/TASK-REVIEW-INTEGRATION/claim'),
    false,
    'worker_cycle_start must not claim a READY task whose dependencies are incomplete'
  );
  console.log('control plane contract smoke passed');
} finally {
  globalThis.fetch = originalFetch;
  rmSync(safetySubmissionWorktree, { recursive: true, force: true });
}
