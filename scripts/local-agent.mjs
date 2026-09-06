#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function usage() {
  console.log(`CodexPro local agent runner

Usage:
  npm run agent -- --task "fix the failing tests"
  npm run agent -- --task-file .ai-bridge/current-plan.md
  npm run agent -- --watch --yes

Options:
  --root <dir>             Workspace root. Default: current directory.
  --task <text>            One task to execute.
  --task-file <path>       Read the task from a workspace file.
                           Default: .ai-bridge/current-plan.md.
  --model <name>           Optional Codex model.
  --codex-command <path>   Codex executable. Default: CODEXPRO_CODEX_COMMAND or codex.
  --watch                  Keep watching the task file and run each new version.
  --yes                    Required with --watch.
  --max-runs <n>           Stop after n runs. Default: unlimited in watch mode.
  --poll-interval-ms <ms>  Watch interval. Default: 1000.
  --timeout-ms <ms>        Per-run timeout. Default: 600000.
  --dry-run                Show what would run without starting Codex.
  --help                    Show this help.
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    let key;
    let value;
    if (eq >= 0) {
      key = raw.slice(2, eq);
      value = raw.slice(eq + 1);
    } else {
      key = raw.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }
    out[key] = value;
  }
  return out;
}

function numberOption(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function realDir(value) {
  const resolved = path.resolve(String(value || process.cwd()));
  const real = fs.realpathSync(resolved);
  if (!fs.statSync(real).isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return real;
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function resolveWorkspacePath(root, value, label) {
  const candidate = path.resolve(root, String(value));
  if (!isInside(root, candidate)) throw new Error(`${label} must stay inside the workspace.`);
  return candidate;
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function writeBounded(file, value, maxBytes = 120_000) {
  const buffer = Buffer.from(String(value ?? ''), 'utf8');
  const bounded = buffer.length <= maxBytes ? buffer : Buffer.concat([
    buffer.subarray(0, maxBytes),
    Buffer.from(`\n...[truncated to ${maxBytes} bytes]\n`, 'utf8')
  ]);
  fs.writeFileSync(file, bounded, { mode: 0o600 });
}

function validateModel(value) {
  if (!value) return '';
  const model = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(model)) {
    throw new Error('Invalid --model value.');
  }
  return model;
}

function resolveCodexCommand(value) {
  const requested = String(value || process.env.CODEXPRO_CODEX_COMMAND || 'codex').trim();
  if (!requested) throw new Error('Codex command is empty.');
  if (path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\')) return requested;
  if (process.platform !== 'win32') return requested;
  const found = spawnSync('where.exe', [requested], { encoding: 'utf8', windowsHide: true });
  if (found.status === 0) {
    const candidates = String(found.stdout || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    return candidates.find((item) => /\.(?:exe|cmd|bat)$/i.test(item)) || candidates[0] || requested;
  }
  return requested;
}

function quoteWindowsCmdArg(value) {
  const text = String(value).replace(/\r?\n/g, ' ').replace(/%/g, '%%');
  if (!text) return '""';
  return `"${text.replace(/"/g, '""')}"`;
}

function spawnSpec(command, args) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    const commandLine = `"${[quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(' ')}"`;
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/q', '/v:off', '/s', '/c', commandLine],
      windowsVerbatimArguments: true
    };
  }
  return { command, args, windowsVerbatimArguments: false };
}

function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const spec = spawnSpec(command, args);
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: false,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current, chunk) => {
      if (Buffer.byteLength(current, 'utf8') >= options.maxOutputBytes) return current;
      return current + String(chunk);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child);
    }, options.timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
  usage();
  process.exit(0);
}

const root = realDir(args.root || process.cwd());
const contextDir = path.join(root, '.ai-bridge');
fs.mkdirSync(contextDir, { recursive: true });
const snapshotPath = path.join(contextDir, 'local-agent-task.md');
const statePath = path.join(contextDir, 'local-agent-state.json');
const outputPath = path.join(contextDir, 'codex-last-message.md');
const stdoutPath = path.join(contextDir, 'local-agent-stdout.log');
const stderrPath = path.join(contextDir, 'local-agent-stderr.log');
const watch = args.watch === true;
const dryRun = args['dry-run'] === true;
if (watch && args.yes !== true && !dryRun) {
  throw new Error('--watch requires --yes because it continuously executes new local tasks.');
}
if (watch && typeof args.task === 'string') {
  throw new Error('--task cannot be combined with --watch. Use --task-file for watch mode.');
}

const model = validateModel(args.model);
const codexCommand = resolveCodexCommand(args['codex-command']);
const timeoutMs = numberOption(args['timeout-ms'], 600_000, 1_000, 24 * 60 * 60_000);
const pollMs = numberOption(args['poll-interval-ms'], 1_000, 100, 60_000);
const maxRuns = numberOption(args['max-runs'], watch ? 0 : 1, 0, 10_000);
const sourceTaskPath = resolveWorkspacePath(root, args['task-file'] || '.ai-bridge/current-plan.md', 'Task file');
const fixedPrompt = [
  'Read .ai-bridge/local-agent-task.md and execute it in this workspace.',
  'Work autonomously through the required read/edit/test steps.',
  'Keep changes scoped to the task.',
  'Do not modify .ai-bridge/local-agent-task.md.',
  'When finished, summarize changed files and verification.'
].join(' ');

function codexArgs() {
  return [
    'exec',
    '--ephemeral',
    '--sandbox',
    'workspace-write',
    '-c',
    "approval_policy='never'",
    '--output-last-message',
    outputPath,
    ...(model ? ['--model', model] : []),
    fixedPrompt
  ];
}

async function executeTask(taskText, taskHash, iteration) {
  fs.writeFileSync(snapshotPath, taskText.endsWith('\n') ? taskText : `${taskText}\n`, { mode: 0o600 });
  const startedAt = new Date().toISOString();
  atomicWriteJson(statePath, {
    version: 1,
    state: 'running',
    iteration,
    plan_hash: taskHash,
    started_at: startedAt,
    finished_at: null,
    exit_code: null,
    timed_out: false
  });

  const invocationArgs = codexArgs();
  if (dryRun) {
    console.log(JSON.stringify({ root, command: codexCommand, args: invocationArgs }, null, 2));
    atomicWriteJson(statePath, {
      version: 1,
      state: 'dry_run',
      iteration,
      plan_hash: taskHash,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: 0,
      timed_out: false
    });
    return 0;
  }

  const result = await runProcess(codexCommand, invocationArgs, {
    cwd: root,
    timeoutMs,
    maxOutputBytes: 120_000
  });
  writeBounded(stdoutPath, result.stdout);
  writeBounded(stderrPath, result.stderr);
  const state = result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'completed' : 'failed';
  atomicWriteJson(statePath, {
    version: 1,
    state,
    iteration,
    plan_hash: taskHash,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: result.timedOut,
    last_message: path.relative(root, outputPath).split(path.sep).join('/'),
    stdout_log: path.relative(root, stdoutPath).split(path.sep).join('/'),
    stderr_log: path.relative(root, stderrPath).split(path.sep).join('/')
  });
  console.log(`[codexpro-local-agent] ${state} iteration=${iteration} exit=${result.exitCode ?? 'null'}`);
  return result.exitCode ?? 1;
}

let lastHash = '';
let runs = 0;
let lastExitCode = 0;

while (true) {
  let taskText = '';
  if (typeof args.task === 'string') {
    taskText = args.task.trim();
  } else if (fs.existsSync(sourceTaskPath)) {
    taskText = fs.readFileSync(sourceTaskPath, 'utf8').trim();
  }

  if (taskText) {
    const taskHash = hashText(taskText);
    if (taskHash !== lastHash) {
      lastHash = taskHash;
      runs += 1;
      lastExitCode = await executeTask(taskText, taskHash, runs);
      if (!watch || (maxRuns > 0 && runs >= maxRuns)) break;
    }
  } else if (!watch) {
    throw new Error(`No task found. Pass --task or create ${path.relative(root, sourceTaskPath)}.`);
  } else {
    atomicWriteJson(statePath, {
      version: 1,
      state: 'waiting',
      iteration: runs,
      plan_hash: lastHash || null,
      updated_at: new Date().toISOString()
    });
  }

  if (!watch) break;
  await sleep(pollMs);
}

process.exitCode = lastExitCode;
