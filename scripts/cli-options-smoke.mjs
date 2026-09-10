import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boolFromValue,
  configuredProjectRoots,
  effectiveWriteMode,
  expandHome,
  optionalChoice,
  optionalWriteOption,
  optionBool,
  optionValue,
  parseArgs,
  realDir,
  resolveCodexDir,
  resolveConfigPath,
  validateChoice,
  writeOption
} from './cli-options.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliSource = await fs.readFile(path.join(projectRoot, 'scripts', 'codexpro.mjs'), 'utf8');

assert.deepEqual(parseArgs(['--root', 'alpha']), { allowRoots: [], root: 'alpha' });
assert.deepEqual(parseArgs(['--root=alpha']), { allowRoots: [], root: 'alpha' });

const switches = parseArgs([
  '--allow-home',
  '--browser-control',
  '--no-browser-control',
  '--no-bash',
  '--require-bash-session',
  '--subagents',
  '--no-subagents',
  '--yes'
]);
assert.equal(switches.allowHome, true);
assert.equal(switches.browserControl, false);
assert.equal(switches.bash, 'off');
assert.equal(switches.requireBashSession, true);
assert.equal(switches.subagents, false);
assert.equal(switches.yes, true);

assert.deepEqual(parseArgs(['--agent']), { allowRoots: [], mode: 'agent' });
assert.deepEqual(parseArgs(['--agent', 'opencode']), { allowRoots: [], agent: 'opencode' });
assert.deepEqual(parseArgs(['--agent=pi']), { allowRoots: [], agent: 'pi' });

assert.deepEqual(
  parseArgs(['--allow-root', 'one', '--project=two', '--allow-root=three', '--project', 'four']).allowRoots,
  ['one', 'two', 'three', 'four']
);
assert.throws(() => parseArgs(['--root']), /Missing value for --root/);
assert.throws(() => parseArgs(['--root', '--help']), /Missing value for --root/);

const envName = 'CODEXPRO_CLI_OPTIONS_SMOKE_VALUE';
const originalEnv = process.env[envName];
try {
  process.env[envName] = 'env';
  assert.equal(optionValue({ value: 'arg' }, { value: 'profile' }, 'value', [envName], 'fallback'), 'arg');
  assert.equal(optionValue({}, { value: 'profile' }, 'value', [envName], 'fallback'), 'env');
  delete process.env[envName];
  assert.equal(optionValue({}, { value: 'profile' }, 'value', [envName], 'fallback'), 'profile');
  assert.equal(optionValue({}, {}, 'value', [envName], 'fallback'), 'fallback');
} finally {
  if (originalEnv === undefined) delete process.env[envName];
  else process.env[envName] = originalEnv;
}

const boolEnv = 'CODEXPRO_CLI_OPTIONS_SMOKE_BOOL';
const originalBoolEnv = process.env[boolEnv];
try {
  process.env[boolEnv] = 'yes';
  assert.equal(optionBool({ enabled: false }, { enabled: true }, 'enabled', [boolEnv], true), false);
  assert.equal(optionBool({}, { enabled: false }, 'enabled', [boolEnv], false), true);
  delete process.env[boolEnv];
  assert.equal(optionBool({}, { enabled: true }, 'enabled', [boolEnv], false), true);
  assert.equal(optionBool({}, {}, 'enabled', [boolEnv], false), false);
} finally {
  if (originalBoolEnv === undefined) delete process.env[boolEnv];
  else process.env[boolEnv] = originalBoolEnv;
}

assert.equal(boolFromValue('ON'), true);
assert.equal(boolFromValue('0', true), false);
assert.equal(boolFromValue('', true), true);
assert.equal(validateChoice('mode', 'agent', ['agent', 'handoff', 'pro']), 'agent');
assert.equal(optionalChoice('mode', '', ['agent', 'handoff', 'pro']), '');
assert.throws(() => validateChoice('mode', 'bad', ['agent', 'handoff', 'pro']), /--mode must be agent, handoff, or pro/);

assert.equal(effectiveWriteMode('agent', ''), 'workspace');
assert.equal(effectiveWriteMode('handoff', ''), 'handoff');
assert.equal(effectiveWriteMode('agent', 'off'), 'off');
assert.equal(effectiveWriteMode('handoff', 'workspace'), 'handoff');
assert.throws(() => effectiveWriteMode('agent', 'bad'), /--write must be off, handoff, or workspace/);
assert.equal(writeOption({ write: 'workspace' }, { write: 'off' }, 'agent'), 'workspace');
assert.equal(optionalWriteOption({}, {}, 'agent'), '');

assert.equal(expandHome('~'), os.homedir());
assert.equal(expandHome('~/codexpro-smoke'), path.join(os.homedir(), 'codexpro-smoke'));
assert.equal(expandHome('relative/path'), 'relative/path');

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-cli-options-'));
try {
  const projectA = path.join(tempRoot, 'project-a');
  const projectB = path.join(tempRoot, 'project-b');
  await fs.mkdir(projectA);
  await fs.mkdir(projectB);
  const realRoot = realDir(tempRoot);
  const realA = realDir(projectA);
  const realB = realDir(projectB);

  assert.equal(resolveCodexDir(realRoot, 'relative-codex'), path.resolve(realRoot, 'relative-codex'));
  assert.equal(resolveConfigPath(realRoot, 'relative-config.yml'), path.resolve(realRoot, 'relative-config.yml'));
  assert.deepEqual(
    configuredProjectRoots(realRoot, { allowRoots: [projectB, projectA] }, { allowedRoots: [projectA, tempRoot] }),
    [realA, realB]
  );
  assert.deepEqual(configuredProjectRoots(realRoot, { clearProjects: true, allowRoots: [projectB] }, { allowedRoots: [projectA] }), [realB]);

  if (process.platform === 'win32') {
    const windowsAbsolute = path.win32.join(path.parse(realRoot).root, 'codexpro-options-smoke', 'config.yml');
    assert.equal(resolveConfigPath(realRoot, windowsAbsolute), path.resolve(windowsAbsolute));
  }
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

assert.match(cliSource, /from '\.\/cli-options\.mjs';/);
for (const name of [
  'parseArgs',
  'expandHome',
  'realDir',
  'configuredProjectRoots',
  'resolveCodexDir',
  'resolveConfigPath',
  'effectiveWriteMode',
  'writeOption',
  'validateChoice',
  'optionalChoice',
  'optionalWriteOption',
  'optionValue',
  'boolFromValue',
  'optionBool'
]) {
  assert(!cliSource.includes(`function ${name}(`), `${name} still implemented in codexpro.mjs`);
}

console.log('✓ CLI options smoke test passed');
