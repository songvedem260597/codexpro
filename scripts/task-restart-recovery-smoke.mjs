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
    const timer = setTimeout(() => reject(new Error(`timeout waiting for HTTP server\n${stderr}`)), 15_000);
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

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('timeout waiting for HTTP server exit'));
    }, timeoutMs);
    timer.unref();
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const message = result.content?.find?.((part) => part.type === 'text')?.text || JSON.stringify(result.structuredContent);
    const error = new Error(`${name} failed: ${message}`);
    error.result = result;
    throw error;
  }
  return result;
}

async function expectToolErrorCode(client, name, args, expectedCode) {
  const result = await client.callTool({ name, arguments: args });
  const actualCode = String(result?.structuredContent?.error?.code || '');
  if (!result?.isError || actualCode !== expectedCode) {
    throw new Error(`${name} expected ${expectedCode}, got ${actualCode || 'success'}: ${JSON.stringify(result?.structuredContent)}`);
  }
  return result;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return String(result.stdout || '').trim();
}

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-running-restart-'));
const codexProHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-running-restart-home-'));
const taskRoot = path.join(fixtureRoot, 'repo');
await fs.mkdir(taskRoot, { recursive: true });
await fs.writeFile(path.join(taskRoot, 'gate.txt'), 'base\n', 'utf8');
git(taskRoot, ['init']);
git(taskRoot, ['config', 'user.email', 'smoke@example.invalid']);
git(taskRoot, ['config', 'user.name', 'CodexPro Smoke']);
git(taskRoot, ['add', 'gate.txt']);
git(taskRoot, ['commit', '-m', 'fixture']);
await fs.writeFile(path.join(codexProHome, 'CODEXPRO.md'), '# Recovery smoke rules\n- preserve task state\n', 'utf8');

const port = await getFreePort();
const token = createHash('sha256').update('running restart recovery smoke').digest('hex');
const profileId = 'restart-running-profile';
const taskId = 'cpt_343434343434343434343434';
const env = {
  ...process.env,
  CODEXPRO_ROOT: fixtureRoot,
  CODEXPRO_ALLOWED_ROOTS: fixtureRoot,
  CODEXPRO_HOST: '127.0.0.1',
  CODEXPRO_PORT: String(port),
  CODEXPRO_HTTP_TOKEN: token,
  CODEXPRO_BASH_MODE: 'safe',
  CODEXPRO_WRITE_MODE: 'workspace',
  CODEXPRO_HOME: codexProHome
};
const startServer = () => spawn(process.execPath, ['dist/http.js'], {
  cwd: path.resolve('.'),
  env,
  stdio: ['ignore', 'pipe', 'pipe']
});
const createClient = async (name, boundProfileId = '') => {
  const client = new Client({ name, version: '0.0.0' });
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  if (boundProfileId) url.searchParams.set('codexpro_profile', boundProfileId);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return client;
};

let child = startServer();
let manager;
let worker;
let workerSibling;
let wrongOwner;
try {
  await waitForListening(child);
  manager = await createClient('running-restart-manager');
  await callTool(manager, 'prepare_repo_task', { profile_id: profileId, task_id: taskId, root: taskRoot, scope: 'workspace' });
  worker = await createClient('running-restart-worker', profileId);
  const began = await callTool(worker, 'begin_repo_task', {
    task_id: taskId,
    task_title: 'Resume running task safely',
    task_kind: 'code',
    task_size: 'large',
    root: taskRoot,
    scope: 'workspace'
  });
  const worktreeRoot = String(began.structuredContent.worktree_root || '');
  if (!worktreeRoot) throw new Error('fixture did not receive a task worktree');
  await callTool(worker, 'report_worker_job_progress', {
    task_id: taskId,
    stage: 'partial',
    progress_percent: 45,
    summary: 'implementation is half done',
    completed_parts: ['analysis complete'],
    remaining_parts: ['finish implementation'],
    checklist: [
      { id: 'one', title: 'Analyze failure', status: 'completed', evidence: 'fixture' },
      { id: 'two', title: 'Finish implementation', status: 'in_progress' }
    ]
  });
  await callTool(worker, 'write', { path: 'unfinished.txt', content: 'unfinished-diff\n' });
  const before = await callTool(worker, 'worker_job_status', { task_id: taskId });
  const startedAt = String(before.structuredContent.job?.started_at || '');
  const progressSequence = Number(before.structuredContent.job?.progress_sequence || 0);
  await worker.close();
  worker = undefined;

  worker = await createClient('running-restart-same-process-session', profileId);
  const sameProcessRead = await callTool(worker, 'read', { path: 'unfinished.txt' });
  if (!String(sameProcessRead.structuredContent.text || '').includes('unfinished-diff')) throw new Error('same-process MCP reconnect lost active gate');
  await worker.close();
  worker = undefined;

  child.kill('SIGTERM');
  await waitForExit(child);
  await fs.rm(path.join(codexProHome, 'browser-profile-tasks.json'), { force: true });
  await fs.writeFile(path.join(codexProHome, 'CODEXPRO.md'), '# Recovery smoke rules changed after restart\n- revalidate task state\n', 'utf8');
  child = startServer();
  await waitForListening(child);

  wrongOwner = await createClient('running-restart-wrong-owner', 'restart-running-wrong-owner');
  await expectToolErrorCode(wrongOwner, 'resume_repo_task', { task_id: taskId, profile_id: 'restart-running-wrong-owner' }, 'REPO_TASK_RESUME_OWNER_MISMATCH');
  await wrongOwner.close();
  wrongOwner = undefined;

  worker = await createClient('running-restart-after-server-restart', profileId);
  await expectToolErrorCode(worker, 'read', { path: 'unfinished.txt' }, 'BEGIN_REPO_TASK_REQUIRED');
  const hiddenWorktreeRoot = `${worktreeRoot}-temporarily-missing`;
  await fs.rename(worktreeRoot, hiddenWorktreeRoot);
  try {
    await expectToolErrorCode(worker, 'resume_repo_task', { task_id: taskId, profile_id: profileId }, 'WORKSPACE_TASK_WORKTREE_MISSING');
  } finally {
    await fs.rename(hiddenWorktreeRoot, worktreeRoot);
  }

  await worker.close();
  worker = undefined;
  child.kill('SIGTERM');
  await waitForExit(child);
  const revokedRoot = path.join(fixtureRoot, 'revoked-root');
  await fs.mkdir(revokedRoot, { recursive: true });
  env.CODEXPRO_ROOT = revokedRoot;
  env.CODEXPRO_ALLOWED_ROOTS = revokedRoot;
  child = startServer();
  await waitForListening(child);
  worker = await createClient('running-restart-revoked-root', profileId);
  const revoked = await worker.callTool({ name: 'resume_repo_task', arguments: { task_id: taskId, profile_id: profileId } });
  const revokedMessage = String(revoked?.content?.find?.((part) => part.type === 'text')?.text || '');
  if (!revoked?.isError || !revokedMessage.includes('outside allowed roots')) {
    throw new Error(`resume did not fail closed after workspace permission was revoked: ${JSON.stringify(revoked?.structuredContent)}`);
  }
  await worker.close();
  worker = undefined;
  child.kill('SIGTERM');
  await waitForExit(child);
  env.CODEXPRO_ROOT = fixtureRoot;
  env.CODEXPRO_ALLOWED_ROOTS = fixtureRoot;
  child = startServer();
  await waitForListening(child);

  worker = await createClient('running-restart-final-recovery', profileId);
  workerSibling = await createClient('running-restart-concurrent-recovery', profileId);
  const [resumed, concurrentResumed] = await Promise.all([
    callTool(worker, 'resume_repo_task', { task_id: taskId, profile_id: profileId }),
    callTool(workerSibling, 'resume_repo_task', { task_id: taskId, profile_id: profileId })
  ]);
  for (const result of [resumed, concurrentResumed]) {
    if (result.structuredContent.resumed !== true || result.structuredContent.gate_active !== true) {
      throw new Error(`running task gate was not restored: ${JSON.stringify(result.structuredContent)}`);
    }
    if (path.resolve(String(result.structuredContent.worktree_root || '')) !== path.resolve(worktreeRoot)) {
      throw new Error('resume did not preserve exact worktree root');
    }
  }
  if (![resumed, concurrentResumed].some((result) => result.structuredContent.rules_changed === true)) {
    throw new Error('resume did not report changed global rules after runtime restart');
  }
  if (![resumed, concurrentResumed].some((result) => result.structuredContent.owner_binding_recovered === true)) {
    throw new Error('resume did not recover the missing persisted task/profile mapping');
  }
  const recoveredRead = await callTool(worker, 'read', { path: 'unfinished.txt' });
  if (!String(recoveredRead.structuredContent.text || '').includes('unfinished-diff')) throw new Error('recovered gate did not reopen exact worktree');
  const after = await callTool(worker, 'worker_job_status', { task_id: taskId });
  const job = after.structuredContent.job;
  if (String(job?.started_at || '') !== startedAt) throw new Error('resume reset task started_at');
  if (Number(job?.progress_sequence || 0) !== progressSequence) throw new Error('resume duplicated/reset progress history');
  if (job?.checklist?.[1]?.status !== 'in_progress') throw new Error('resume lost durable checklist state');
  if (await fs.readFile(path.join(worktreeRoot, 'unfinished.txt'), 'utf8') !== 'unfinished-diff\n') throw new Error('worktree diff changed during recovery');
  await fs.access(path.join(taskRoot, 'unfinished.txt')).then(() => { throw new Error('recovery leaked unfinished diff into primary repo'); }, () => {});

  const cancelled = await callTool(worker, 'finalize_worker_job', {
    task_id: taskId,
    outcome: 'cancelled',
    summary: 'fixture ends the recovered task after validating restart recovery'
  });
  if (cancelled.structuredContent.job?.status !== 'cancelled') throw new Error('fixture task did not reach terminal state');
  await expectToolErrorCode(worker, 'resume_repo_task', { task_id: taskId, profile_id: profileId }, 'REPO_TASK_RESUME_NOT_RUNNING');

  console.log('✓ Running task restart recovery smoke test passed');
} finally {
  if (wrongOwner) await wrongOwner.close().catch(() => {});
  if (workerSibling) await workerSibling.close().catch(() => {});
  if (worker) await worker.close().catch(() => {});
  if (manager) await manager.close().catch(() => {});
  if (child && child.exitCode == null && child.signalCode == null) {
    child.kill('SIGTERM');
    await waitForExit(child).catch(() => {});
  }
}
