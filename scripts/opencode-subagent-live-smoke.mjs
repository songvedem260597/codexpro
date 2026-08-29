import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runVerifiedOpenCodeInvestigation } from './opencode-subagent-runner.mjs';

function resolveCommand(name) {
  if (process.platform !== 'win32') return name;
  const found = spawnSync('where', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const candidates = found.status === 0 ? String(found.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  return candidates.find((candidate) => /\.(cmd|exe)$/i.test(candidate)) || name;
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

const marker = 'CODEXPRO_SUBAGENT_MARKER=orange-otter-7319';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-live-subagent-'));
await fs.writeFile(path.join(root, 'marker.txt'), `${marker}\n`, 'utf8');
await fs.writeFile(path.join(root, 'noise.txt'), 'this file does not contain the requested marker\n', 'utf8');

const command = resolveCommand(process.env.CODEXPRO_OPENCODE_BIN || 'opencode');
const model = process.env.CODEXPRO_OPENCODE_LIVE_MODEL || 'opencode/big-pickle';
const configDir = path.resolve('.opencode');
const result = await runVerifiedOpenCodeInvestigation({
  command,
  root,
  configDir,
  model,
  planText: `Find the exact marker stored in marker.txt and report it verbatim. The parent orchestrator must not read the file itself. Expected marker prefix: CODEXPRO_SUBAGENT_MARKER=.`,
  timeoutMs: Number(process.env.CODEXPRO_OPENCODE_LIVE_TIMEOUT_MS || 120000),
  maxOutputBytes: 160000
});

assert(result.verified, `live subagent was not verified: ${result.fallbackReason}`);
assert(result.childSessionId, 'live subagent did not expose a child session id');
assert(result.childResult.includes(marker), `child result did not contain marker: ${result.childResult}`);
assert((result.primaryResult || '').includes(marker), `primary synthesis did not contain marker: ${result.primaryResult}`);
assert(result.filesInspected.some((file) => String(file).replaceAll('\\', '/').endsWith('marker.txt')), `child export did not prove marker.txt was inspected: ${JSON.stringify(result.filesInspected)}`);
assert(!result.childToolNames.some((tool) => ['bash', 'edit', 'write', 'apply_patch', 'task'].includes(tool)), `child used a forbidden tool: ${result.childToolNames.join(', ')}`);

const eventNames = new Set(result.events.map((event) => event.event));
for (const required of ['subagent_requested', 'subagent_started', 'child_session_id', 'subagent_completed', 'files_inspected', 'result_received']) {
  assert(eventNames.has(required), `missing telemetry event: ${required}`);
}

console.log(`✓ live OpenCode subagent E2E passed (${model})`);
console.log(`  child_session_id=${result.childSessionId}`);
console.log(`  files_inspected=${result.filesInspected.join(', ')}`);
