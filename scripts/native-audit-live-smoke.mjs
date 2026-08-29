import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCodexProNativeAudit } from './opencode-subagent-runner.mjs';

function resolveCommand(name) {
  if (process.platform !== 'win32') return name;
  const found = spawnSync('where', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const candidates = found.status === 0 ? String(found.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  return candidates.find((candidate) => /\.(cmd|exe)$/i.test(candidate)) || name;
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-live-audit-'));
await fs.writeFile(path.join(root, 'target.txt'), 'GOOD', 'utf8');
await fs.writeFile(path.join(root, 'implementation-diff.patch'), '# fixture diff\n+GOOD\n', 'utf8');
await fs.writeFile(path.join(root, 'agent-status.md'), '# fixture executor status\nExit code: 0\n', 'utf8');
await fs.writeFile(path.join(root, 'loop-tests.txt'), '# fixture tests\nExit code: 0\ntarget.txt verified as GOOD\n', 'utf8');

const command = resolveCommand(process.env.CODEXPRO_OPENCODE_BIN || 'opencode');
const model = process.env.CODEXPRO_OPENCODE_LIVE_MODEL || 'opencode/big-pickle';
const configDir = path.resolve('.opencode');
const audit = await runCodexProNativeAudit({
  command,
  root,
  configDir,
  model,
  originalTask: 'Create target.txt whose exact content is GOOD.',
  iterationPlan: 'Implement the original task and verify the exact file content.',
  diffPath: path.join(root, 'implementation-diff.patch'),
  statusPath: path.join(root, 'agent-status.md'),
  testsPath: path.join(root, 'loop-tests.txt'),
  testsRan: true,
  timeoutMs: Number(process.env.CODEXPRO_OPENCODE_LIVE_TIMEOUT_MS || 120000),
  maxOutputBytes: 160000
});

assert(audit.ok, `live native audit failed: ${audit.reason || audit.raw || 'unknown error'}`);
assert(audit.verdict === 'PASS', `live native audit did not PASS: ${audit.raw}`);
assert(audit.sessionId, 'live native audit did not expose an audit session id');
assert(!audit.tools.some((tool) => ['bash', 'edit', 'write', 'apply_patch', 'task', 'webfetch', 'websearch'].includes(tool)), `live auditor used a forbidden tool: ${audit.tools.join(', ')}`);

console.log(`✓ live CodexPro native audit passed (${audit.model || model})`);
console.log(`  audit_session_id=${audit.sessionId}`);
console.log(`  tools=${audit.tools.join(', ') || '(none)'}`);
