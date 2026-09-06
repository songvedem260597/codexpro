import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function waitFor(check, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs} ms`);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function waitForChild(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
      reject(new Error(`Child timed out. stdout=${stdout.join('')} stderr=${stderr.join('')}`));
    }, timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.join(''), stderr: stderr.join('') });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-local-agent-smoke-'));
const bridge = path.join(root, '.ai-bridge');
await fs.mkdir(bridge, { recursive: true });
const fakeScript = path.join(root, 'fake-codex.mjs');
const callsFile = path.join(root, 'fake-codex-calls.jsonl');
await fs.writeFile(fakeScript, `import fs from 'node:fs';\nimport path from 'node:path';\nconst args = process.argv.slice(2);\nfs.appendFileSync(path.join(process.cwd(), 'fake-codex-calls.jsonl'), JSON.stringify(args) + '\\n');\nconst outputIndex = args.indexOf('--output-last-message');\nif (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], 'fake codex completed\\n');\n`, 'utf8');

let launcher;
if (process.platform === 'win32') {
  launcher = path.join(root, 'fake-codex.cmd');
  await fs.writeFile(launcher, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`, 'utf8');
} else {
  launcher = path.join(root, 'fake-codex');
  await fs.writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });
}

try {
  const once = spawnSync(process.execPath, [
    'scripts/local-agent.mjs',
    '--root', root,
    '--task', 'Change one thing and verify it.',
    '--codex-command', launcher
  ], { cwd: path.resolve('.'), encoding: 'utf8', windowsHide: true });
  assert(once.status === 0, `one-shot local agent failed: ${once.stdout}\n${once.stderr}`);

  const statePath = path.join(bridge, 'local-agent-state.json');
  const onceState = await readJson(statePath);
  assert(onceState?.state === 'completed' && onceState?.iteration === 1, `unexpected one-shot state: ${JSON.stringify(onceState)}`);
  const snapshot = await fs.readFile(path.join(bridge, 'local-agent-task.md'), 'utf8');
  assert(snapshot.includes('Change one thing'), 'one-shot task was not snapshotted');
  const lastMessage = await fs.readFile(path.join(bridge, 'codex-last-message.md'), 'utf8');
  assert(lastMessage.includes('fake codex completed'), 'one-shot last message was not written');

  const planPath = path.join(bridge, 'current-plan.md');
  await fs.writeFile(planPath, 'First watched plan\n', 'utf8');
  const watcher = spawn(process.execPath, [
    'scripts/local-agent.mjs',
    '--root', root,
    '--watch',
    '--yes',
    '--max-runs', '2',
    '--poll-interval-ms', '100',
    '--codex-command', launcher
  ], { cwd: path.resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  await waitFor(async () => {
    const state = await readJson(statePath);
    return state?.state === 'completed' && state?.iteration === 1;
  });
  await fs.writeFile(planPath, 'Second watched plan\n', 'utf8');
  const watched = await waitForChild(watcher, 12_000);
  assert(watched.code === 0, `watch local agent failed: ${watched.stdout}\n${watched.stderr}`);

  const watchedState = await readJson(statePath);
  assert(watchedState?.state === 'completed' && watchedState?.iteration === 2, `unexpected watched state: ${JSON.stringify(watchedState)}`);
  const calls = (await fs.readFile(callsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert(calls.length === 3, `expected 3 fake Codex runs, got ${calls.length}`);
  for (const call of calls) {
    assert(call[0] === 'exec', `Codex was not invoked with exec: ${JSON.stringify(call)}`);
    assert(call.includes('--ephemeral'), 'Codex run was not ephemeral');
    assert(call.includes('workspace-write'), 'Codex run did not use workspace-write sandbox');
    assert(call.some((arg) => String(arg).includes('approval_policy')), 'Codex run did not disable approval prompts');
    assert(call.some((arg) => String(arg).includes('local-agent-task.md')), 'Codex prompt did not reference the task snapshot');
  }

  console.log('✓ local agent runner smoke test passed');
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
