import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve('.');

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function runCodexPro(args, env) {
  return spawnSync(process.execPath, ['scripts/codexpro.mjs', ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 4_000_000
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-native-audit-'));
const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-native-audit-bin-'));
await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
const originalTask = '# Task\n\nCreate `target.txt` whose exact content is `GOOD`.\n';
await fs.writeFile(path.join(root, '.ai-bridge', 'current-plan.md'), originalTask, 'utf8');

const executorPath = path.join(root, 'executor.mjs');
await fs.writeFile(executorPath, `
import fs from 'node:fs';
import path from 'node:path';
const plan = fs.readFileSync(process.argv[2], 'utf8');
const value = /Replace BAD with GOOD/i.test(plan) ? 'GOOD' : 'BAD';
fs.writeFileSync(path.join(process.cwd(), 'target.txt'), value, 'utf8');
console.log('executor wrote ' + value);
`, 'utf8');

const testPath = path.join(root, 'verify.mjs');
await fs.writeFile(testPath, `
import fs from 'node:fs';
import path from 'node:path';
const value = fs.existsSync(path.join(process.cwd(), 'target.txt')) ? fs.readFileSync(path.join(process.cwd(), 'target.txt'), 'utf8') : '';
if (value !== 'GOOD') {
  console.error('expected GOOD, got ' + JSON.stringify(value));
  process.exit(1);
}
console.log('target verified');
`, 'utf8');

const fakeOpenCodePath = path.join(fakeBin, 'fake-opencode.mjs');
await fs.writeFile(fakeOpenCodePath, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'agent' && args[1] === 'list') {
  console.log('codexpro-auditor (primary)');
  console.log(JSON.stringify([
    { permission: 'read', action: 'allow', pattern: '*' },
    { permission: 'grep', action: 'allow', pattern: '*' },
    { permission: 'glob', action: 'allow', pattern: '*' },
    { permission: 'list', action: 'allow', pattern: '*' },
    { permission: 'edit', action: 'deny', pattern: '*' },
    { permission: 'bash', action: 'deny', pattern: '*' },
    { permission: 'task', action: 'deny', pattern: '*' },
    { permission: 'webfetch', action: 'deny', pattern: '*' },
    { permission: 'websearch', action: 'deny', pattern: '*' }
  ], null, 2));
  process.exit(0);
}
if (args[0] === 'run') {
  const targetPath = path.join(process.cwd(), 'target.txt');
  const value = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
  const pass = value === 'GOOD';
  const sessionID = pass ? 'ses_native_audit_pass' : 'ses_native_audit_fail';
  const text = pass
    ? 'CODEXPRO_AUDIT=PASS\\nSUMMARY=target.txt exactly matches the original acceptance target.\\nREQUIRED_FIXES=NONE'
    : 'CODEXPRO_AUDIT=FAIL\\nSUMMARY=target.txt contains BAD instead of GOOD.\\nREQUIRED_FIXES:\\n- Replace BAD with GOOD in target.txt.';
  console.log(JSON.stringify({ type: 'text', sessionID, part: { type: 'text', text } }));
  process.exit(0);
}
if (args[0] === 'export') {
  const sessionID = args[1] || 'ses_unknown';
  console.log(JSON.stringify({
    info: { id: sessionID },
    messages: [{
      info: { role: 'assistant' },
      parts: [{ type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'target.txt' } } }]
    }]
  }));
  process.exit(0);
}
console.error('unsupported fake opencode args: ' + JSON.stringify(args));
process.exit(2);
`, 'utf8');

if (process.platform === 'win32') {
  await fs.writeFile(path.join(fakeBin, 'opencode.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-opencode.mjs" %*\r\n`, 'utf8');
} else {
  const launcher = path.join(fakeBin, 'opencode');
  await fs.writeFile(launcher, `#!/bin/sh\nexec ${quoteArg(process.execPath)} ${quoteArg(fakeOpenCodePath)} "$@"\n`, { mode: 0o755 });
  await fs.chmod(launcher, 0o755);
}

const gitInit = spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
assert(gitInit.status === 0, `git init failed: ${gitInit.stderr}`);

const env = {
  ...process.env,
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  NO_COLOR: '1'
};
const executorCommand = `${quoteArg(process.execPath)} ${quoteArg(executorPath)} {{plan_file}}`;
const testCommand = `${quoteArg(process.execPath)} ${quoteArg(testPath)}`;
const result = runCodexPro([
  'loop-handoff',
  '--root', root,
  '--agent', 'custom',
  '--command', executorCommand,
  '--run-tests', testCommand,
  '--max-iters', '3',
  '--yes'
], env);

assert(result.status === 0, `native audit loop failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
assert((await fs.readFile(path.join(root, 'target.txt'), 'utf8')) === 'GOOD', 'native audit loop did not remediate target.txt to GOOD');
assert((await fs.readFile(path.join(root, '.ai-bridge', 'loop-target-plan.md'), 'utf8')) === originalTask, 'immutable original target plan was not preserved');
const state = JSON.parse(await fs.readFile(path.join(root, '.ai-bridge', 'loop-handoff-state.json'), 'utf8'));
assert(state.verdict === 'PASS', `expected PASS state, got ${JSON.stringify(state)}`);
assert(state.iteration === 2, `expected two execute/audit iterations, got ${state.iteration}`);
assert(state.auditMode === 'codexpro_native', `expected native audit mode, got ${state.auditMode}`);
assert(state.auditAgent === 'codexpro-auditor', `unexpected audit agent: ${state.auditAgent}`);
assert(state.auditSessionId === 'ses_native_audit_pass', `unexpected final audit session: ${state.auditSessionId}`);
const review = await fs.readFile(path.join(root, '.ai-bridge', 'loop-review.md'), 'utf8');
assert(review.includes('# CodexPro Native Audit') && review.includes('Verdict: PASS'), `final native audit artifact is wrong:\n${review}`);
const currentPlan = await fs.readFile(path.join(root, '.ai-bridge', 'current-plan.md'), 'utf8');
assert(currentPlan.includes('Replace BAD with GOOD in target.txt.'), 'CodexPro did not write the FAIL remediation plan before iteration 2');
const log = await fs.readFile(path.join(root, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
assert(log.includes('"audit_mode":"codexpro_native"') && log.includes('"audit_session_id":"ses_native_audit_pass"'), 'native audit telemetry was not recorded');

console.log('✓ CodexPro native execute/audit loop smoke test passed');
