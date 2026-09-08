import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for HTTP server\n${stderr}`)), 15000);
    timer.unref();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.includes('HTTP MCP listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code}\n${stderr}`));
    });
  });
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout waiting for process exit\n${stderr}`));
    }, timeoutMs);
    timer.unref();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
    throw new Error(`${name} failed: ${text}`);
  }
  return result;
}

async function expectToolErrorCode(client, name, args, expectedCode) {
  const result = await client.callTool({ name, arguments: args });
  const actualCode = String(result?.structuredContent?.error?.code || '');
  if (!result?.isError || actualCode !== expectedCode) {
    throw new Error(`expected ${name} to fail with ${expectedCode}, got ${actualCode || 'no-code'} ${JSON.stringify(result?.structuredContent)}`);
  }
  return result;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-prepared-worker-recovery-'));
const codexProHome = path.join(root, 'codexpro-home');
const primaryRoot = path.join(root, 'primary');
await fs.mkdir(codexProHome, { recursive: true });
await fs.mkdir(primaryRoot, { recursive: true });
await fs.writeFile(path.join(primaryRoot, 'gate.txt'), 'prepared recovery execution root\n', 'utf8');

function runGit(args) {
  const result = spawnSync('git', args, { cwd: primaryRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`prepared recovery git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return String(result.stdout || '').trim();
}

runGit(['init']);
runGit(['add', 'gate.txt']);
runGit(['-c', 'user.email=prepared-recovery@example.invalid', '-c', 'user.name=Prepared Recovery', 'commit', '-m', 'prepared recovery fixture']);

async function coordinationFile(coordinationRoot) {
  const canonical = await fs.realpath(coordinationRoot);
  const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 32);
  return { canonical, file: path.join(codexProHome, 'workspace-coordination', `${key}.json`) };
}

async function fileExists(file) {
  return await fs.stat(file).then(() => true, () => false);
}

const port = await getFreePort();
const token = createHash('sha256').update('prepared worker recovery smoke').digest('hex');
const taskId = 'cpt_343434343434343434343434';
const wrongTaskId = 'cpt_353535353535353535353535';
const profileId = 'prepared-recovery-gate';
const child = spawn(process.execPath, ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: primaryRoot,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_BASH_MODE: 'safe',
    CODEXPRO_WRITE_MODE: 'workspace',
    CODEXPRO_HOME: codexProHome
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

const clients = [];
async function createClient(name, boundProfileId = '') {
  const client = new Client({ name, version: '0.0.0' });
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  if (boundProfileId) url.searchParams.set('codexpro_profile', boundProfileId);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

try {
  await waitForListening(child);
  const manager = await createClient('prepared-recovery-manager');
  const worker = await createClient('prepared-recovery-worker', profileId);

  const preparedPrimary = await callTool(manager, 'prepare_repo_task', {
    profile_id: profileId,
    task_id: taskId,
    root: primaryRoot,
    scope: 'workspace'
  });
  if (!preparedPrimary.structuredContent.prepared) throw new Error('manager could not prepare primary-root recovery fixture');

  const beganPrimary = await callTool(worker, 'begin_repo_task', {
    task_id: taskId,
    task_title: 'Exercise prepared worker recovery',
    task_kind: 'code',
    root: primaryRoot,
    scope: 'workspace'
  });
  const isolatedRoot = String(beganPrimary.structuredContent.worktree_root || '');
  if (!isolatedRoot || path.resolve(isolatedRoot) === path.resolve(primaryRoot)) {
    throw new Error(`primary begin did not create an isolated task worktree: ${JSON.stringify(beganPrimary.structuredContent)}`);
  }

  const primaryCoordination = await coordinationFile(primaryRoot);
  const isolatedCoordination = await coordinationFile(isolatedRoot);
  if (!await fileExists(primaryCoordination.file)) throw new Error('primary begin did not persist authoritative coordination state');
  if (await fileExists(isolatedCoordination.file)) throw new Error('primary begin unexpectedly created coordination state keyed by its task worktree');

  const preparedIsolated = await callTool(manager, 'prepare_repo_task', {
    profile_id: profileId,
    task_id: taskId,
    root: isolatedRoot,
    scope: 'workspace'
  });
  if (!preparedIsolated.structuredContent.prepared || path.resolve(preparedIsolated.structuredContent.root || '') !== path.resolve(isolatedRoot)) {
    throw new Error(`manager did not preserve the prepared isolated execution root: ${JSON.stringify(preparedIsolated.structuredContent)}`);
  }

  const preparedStatus = await callTool(worker, 'worker_job_status', { task_id: taskId });
  if (preparedStatus.structuredContent.job?.status !== 'prepared' || path.resolve(preparedStatus.structuredContent.job?.root || '') !== path.resolve(isolatedRoot)) {
    throw new Error(`split-state WorkerJob fixture was not prepared at the isolated root: ${JSON.stringify(preparedStatus.structuredContent)}`);
  }

  await expectToolErrorCode(worker, 'begin_repo_task', {
    task_id: taskId,
    task_title: 'Exercise prepared worker recovery',
    task_kind: 'code',
    root: primaryRoot,
    scope: 'workspace'
  }, 'REPO_TASK_ROOT_MISMATCH');
  await expectToolErrorCode(worker, 'begin_repo_task', {
    task_id: wrongTaskId,
    task_title: 'Reject wrong prepared task id',
    task_kind: 'code',
    root: isolatedRoot,
    scope: 'workspace'
  }, 'REPO_TASK_MISMATCH');

  const duplicateRoot = path.join(root, 'duplicate-coordination');
  await fs.mkdir(duplicateRoot, { recursive: true });
  const duplicateCoordination = await coordinationFile(duplicateRoot);
  const primaryState = JSON.parse(await fs.readFile(primaryCoordination.file, 'utf8'));
  await fs.mkdir(path.dirname(duplicateCoordination.file), { recursive: true });
  await fs.writeFile(duplicateCoordination.file, `${JSON.stringify({
    ...primaryState,
    root: duplicateCoordination.canonical,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
  await expectToolErrorCode(worker, 'begin_repo_task', {
    task_id: taskId,
    task_title: 'Exercise prepared worker recovery',
    task_kind: 'code',
    root: isolatedRoot,
    scope: 'workspace'
  }, 'WORKSPACE_TASK_ROOT_AMBIGUOUS');
  await fs.rm(duplicateCoordination.file, { force: true });

  const ownerMismatchState = JSON.parse(await fs.readFile(primaryCoordination.file, 'utf8'));
  const authoritativeOwner = ownerMismatchState.tasks?.[taskId]?.workerId;
  ownerMismatchState.tasks[taskId].workerId = 'different-prepared-recovery-owner';
  await fs.writeFile(primaryCoordination.file, `${JSON.stringify(ownerMismatchState, null, 2)}\n`, 'utf8');
  await expectToolErrorCode(worker, 'begin_repo_task', {
    task_id: taskId,
    task_title: 'Exercise prepared worker recovery',
    task_kind: 'code',
    root: isolatedRoot,
    scope: 'workspace'
  }, 'WORKSPACE_TASK_OWNER_MISMATCH');
  ownerMismatchState.tasks[taskId].workerId = authoritativeOwner;
  await fs.writeFile(primaryCoordination.file, `${JSON.stringify(ownerMismatchState, null, 2)}\n`, 'utf8');

  const recovered = await callTool(worker, 'begin_repo_task', {
    task_id: taskId,
    task_title: 'Exercise prepared worker recovery',
    task_kind: 'code',
    root: isolatedRoot,
    scope: 'workspace'
  });
  if (!recovered.structuredContent.verified
    || recovered.structuredContent.prepared_recovery !== true
    || path.resolve(recovered.structuredContent.root || '') !== path.resolve(isolatedRoot)
    || path.resolve(recovered.structuredContent.worktree_root || '') !== path.resolve(isolatedRoot)
    || path.resolve(recovered.structuredContent.coordination_root || '') !== path.resolve(primaryRoot)) {
    throw new Error(`prepared WorkerJob recovery did not preserve execution root and reuse authoritative coordination: ${JSON.stringify(recovered.structuredContent)}`);
  }

  const runningStatus = await callTool(worker, 'worker_job_status', { task_id: taskId });
  if (runningStatus.structuredContent.job?.status !== 'running' || path.resolve(runningStatus.structuredContent.job?.root || '') !== path.resolve(isolatedRoot)) {
    throw new Error(`prepared WorkerJob was not reactivated in place: ${JSON.stringify(runningStatus.structuredContent)}`);
  }
  if (await fileExists(isolatedCoordination.file)) throw new Error('prepared recovery created duplicate isolated-root coordination state');

  const executionRead = await callTool(worker, 'read', { path: 'gate.txt' });
  if (!String(executionRead.structuredContent.text || '').includes('prepared recovery execution root')) {
    throw new Error('recovered gate did not read from the isolated execution workspace');
  }

  const primaryBeforeFinalize = JSON.parse(await fs.readFile(primaryCoordination.file, 'utf8'));
  const now = new Date().toISOString();
  primaryBeforeFinalize.tasks[taskId].claimedPaths = ['gate.txt'];
  primaryBeforeFinalize.claims = {
    'gate.txt': { taskId, claimedAt: now, updatedAt: now }
  };
  primaryBeforeFinalize.integrationQueue = [{
    taskId,
    branch: primaryBeforeFinalize.tasks[taskId].baseBranch || 'master',
    enqueuedAt: now
  }];
  primaryBeforeFinalize.integrationLease = { taskId, acquiredAt: now };
  await fs.writeFile(primaryCoordination.file, `${JSON.stringify(primaryBeforeFinalize, null, 2)}\n`, 'utf8');

  const progress = await callTool(worker, 'report_worker_job_progress', {
    task_id: taskId,
    stage: 'verifying',
    summary: 'Prepared recovery regression reached finalization with authoritative coordination reused.',
    progress_percent: 99,
    completed_parts: ['prepared recovery', 'execution root verification'],
    remaining_parts: []
  });
  if (!progress.structuredContent.reported || progress.structuredContent.job?.remaining_parts?.length !== 0) {
    throw new Error(`prepared recovery could not report terminal progress: ${JSON.stringify(progress.structuredContent)}`);
  }

  const finalized = await callTool(worker, 'finalize_worker_job', {
    task_id: taskId,
    outcome: 'completed',
    summary: 'prepared worker recovery regression complete'
  });
  if (!finalized.structuredContent.finalized || finalized.structuredContent.job?.status !== 'completed') {
    throw new Error(`prepared recovery could not finalize through the authoritative task: ${JSON.stringify(finalized.structuredContent)}`);
  }

  const finalizedState = JSON.parse(await fs.readFile(primaryCoordination.file, 'utf8'));
  if (finalizedState.tasks?.[taskId]?.status !== 'completed') throw new Error('authoritative primary-root WorkspaceTask did not complete');
  if (Object.values(finalizedState.claims || {}).some((claim) => claim?.taskId === taskId)) throw new Error('prepared recovery finalization did not release authoritative claims');
  if ((finalizedState.integrationQueue || []).some((entry) => entry?.taskId === taskId)) throw new Error('prepared recovery finalization did not clear the authoritative integration queue');
  if (finalizedState.integrationLease?.taskId === taskId) throw new Error('prepared recovery finalization did not release the authoritative integration lease');
  if (await fileExists(isolatedCoordination.file)) throw new Error('finalization created duplicate isolated-root coordination state');

  console.log('prepared worker recovery smoke passed');
} finally {
  for (const client of clients.reverse()) await client.close().catch(() => {});
  child.kill('SIGTERM');
  await waitForExit(child).catch(() => {});
}
