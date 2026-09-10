import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bashSessionOptions,
  bashTranscriptOption,
  codexSessionsOption,
  hasToolCardsInput,
  toolCardsCliArgs,
  toolCardsProfileEntry,
  validateBashSession
} from './cli-runtime-options.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliSource = await fs.readFile(path.join(projectRoot, 'scripts', 'codexpro.mjs'), 'utf8');
const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));

const envNames = [
  'CODEXPRO_TOOL_CARDS',
  'CODEXPRO_BASH_SESSION_ID',
  'CODEXPRO_REQUIRE_BASH_SESSION',
  'CODEXPRO_BASH_TRANSCRIPT',
  'CODEXPRO_CODEX_SESSIONS'
];
const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));

function clearRuntimeOptionEnv() {
  for (const name of envNames) delete process.env[name];
}

try {
  clearRuntimeOptionEnv();

  assert.equal(hasToolCardsInput({}, {}), false);
  assert.deepEqual(toolCardsProfileEntry({}, {}), {});
  assert.deepEqual(toolCardsCliArgs({}, {}), []);

  assert.equal(hasToolCardsInput({ toolCards: false }), true);
  assert.deepEqual(toolCardsProfileEntry({ toolCards: false }), { toolCards: false });
  assert.deepEqual(toolCardsCliArgs({ toolCards: false }), ['--tool-cards', 'off']);

  assert.equal(hasToolCardsInput({ toolCards: true }), true);
  assert.deepEqual(toolCardsProfileEntry({ toolCards: true }), { toolCards: true });
  assert.deepEqual(toolCardsCliArgs({ toolCards: true }), ['--tool-cards', 'on']);

  assert.deepEqual(toolCardsCliArgs({}, { toolCards: true }), ['--tool-cards', 'on']);
  process.env.CODEXPRO_TOOL_CARDS = 'off';
  assert.deepEqual(toolCardsCliArgs({}, { toolCards: true }), ['--tool-cards', 'off']);
  assert.deepEqual(toolCardsCliArgs({ toolCards: true }, { toolCards: false }), ['--tool-cards', 'on']);
  process.env.CODEXPRO_TOOL_CARDS = '';
  assert.equal(hasToolCardsInput({}, {}), false);
  delete process.env.CODEXPRO_TOOL_CARDS;

  assert.equal(validateBashSession('session-1.alpha_beta'), 'session-1.alpha_beta');
  assert.equal(validateBashSession('  Session_2  '), 'Session_2');
  assert.equal(validateBashSession(''), '');
  const bashSessionError = '--bash-session must be 1-64 characters using letters, numbers, dot, underscore, or dash, and must start with a letter or number.';
  assert.throws(() => validateBashSession('-invalid'), { message: bashSessionError });
  assert.throws(() => validateBashSession('has spaces'), { message: bashSessionError });
  assert.throws(() => validateBashSession(`a${'b'.repeat(64)}`), { message: bashSessionError });

  assert.deepEqual(bashSessionOptions({}, {}), { bashSession: '', requireBashSession: false });
  process.env.CODEXPRO_BASH_SESSION_ID = 'env-session';
  assert.deepEqual(bashSessionOptions({}, { bashSession: 'profile-session' }), { bashSession: 'env-session', requireBashSession: false });
  assert.deepEqual(bashSessionOptions({ bashSession: 'arg-session' }, { bashSession: 'profile-session' }), { bashSession: 'arg-session', requireBashSession: false });
  delete process.env.CODEXPRO_BASH_SESSION_ID;
  assert.deepEqual(bashSessionOptions({}, { bashSession: 'profile-session' }), { bashSession: 'profile-session', requireBashSession: false });

  assert.throws(
    () => bashSessionOptions({ requireBashSession: true }, {}),
    { message: '--require-bash-session requires --bash-session <id>.' }
  );
  process.env.CODEXPRO_BASH_SESSION_ID = 'required-env-session';
  process.env.CODEXPRO_REQUIRE_BASH_SESSION = 'true';
  assert.deepEqual(bashSessionOptions({}, { requireBashSession: false }), { bashSession: 'required-env-session', requireBashSession: true });
  assert.deepEqual(bashSessionOptions({ requireBashSession: false }, {}), { bashSession: 'required-env-session', requireBashSession: false });
  delete process.env.CODEXPRO_BASH_SESSION_ID;
  delete process.env.CODEXPRO_REQUIRE_BASH_SESSION;

  assert.equal(bashTranscriptOption({}, {}), 'compact');
  assert.equal(bashTranscriptOption({}, { bashTranscript: 'full' }), 'full');
  process.env.CODEXPRO_BASH_TRANSCRIPT = 'full';
  assert.equal(bashTranscriptOption({}, { bashTranscript: 'compact' }), 'full');
  assert.equal(bashTranscriptOption({ bashTranscript: 'compact' }, { bashTranscript: 'full' }), 'compact');
  assert.throws(() => bashTranscriptOption({ bashTranscript: 'verbose' }, {}), { message: '--bash-transcript must be compact or full.' });
  delete process.env.CODEXPRO_BASH_TRANSCRIPT;

  assert.equal(codexSessionsOption({}, {}), 'off');
  assert.equal(codexSessionsOption({}, { codexSessions: 'metadata' }), 'metadata');
  process.env.CODEXPRO_CODEX_SESSIONS = 'read';
  assert.equal(codexSessionsOption({}, { codexSessions: 'metadata' }), 'read');
  assert.equal(codexSessionsOption({ codexSessions: 'off' }, { codexSessions: 'read' }), 'off');
  assert.equal(codexSessionsOption({ codexSessions: 'metadata' }, {}), 'metadata');
  assert.equal(codexSessionsOption({ codexSessions: 'read' }, {}), 'read');
  assert.throws(() => codexSessionsOption({ codexSessions: 'write' }, {}), { message: '--codex-sessions must be off, metadata, or read.' });
} finally {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

assert.match(cliSource, /from '\.\/cli-runtime-options\.mjs';/);
for (const name of [
  'hasToolCardsInput',
  'toolCardsProfileEntry',
  'toolCardsCliArgs',
  'validateBashSession',
  'bashSessionOptions',
  'bashTranscriptOption',
  'codexSessionsOption'
]) {
  assert(!cliSource.includes(`function ${name}(`), `${name} still implemented in codexpro.mjs`);
}
assert(cliSource.includes('function managerMaxSubagentsSetting('), 'managerMaxSubagentsSetting moved unexpectedly');
assert(cliSource.includes('function stableToken('), 'stableToken moved unexpectedly');
assert.match(packageJson.scripts.smoke, /node scripts\/cli-options-smoke\.mjs/);
assert.match(packageJson.scripts.smoke, /node scripts\/cli-executables-smoke\.mjs/);
assert.match(packageJson.scripts.smoke, /node scripts\/cli-runtime-options-smoke\.mjs/);
assert.equal(packageJson.scripts['send-trace:smoke'], 'tsx scripts/send-trace-regression.mts');

console.log('✓ CLI runtime options smoke test passed');
