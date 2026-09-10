import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  commandAvailable,
  commandAvailableFromRoot,
  commandExists,
  commandPaths,
  executableFileExists,
  isPathLike,
  isWindowsBatchFile,
  isWindowsCommandCandidate,
  resolveAgentCommand,
  resolveCodexCommand,
  resolveExecutablePath
} from './cli-executables.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliSource = await fs.readFile(path.join(projectRoot, 'scripts', 'codexpro.mjs'), 'utf8');
const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));

assert.equal(isPathLike('node'), false);
assert.equal(isPathLike('./node'), true);
assert.equal(isPathLike('../node'), true);
assert.equal(isPathLike('bin/node'), true);
assert.equal(isPathLike('bin\\node'), true);

assert.equal(resolveExecutablePath('~/codexpro-cli-executables-smoke'), path.resolve(path.join(os.homedir(), 'codexpro-cli-executables-smoke')));
assert.equal(resolveExecutablePath('./relative-tool'), path.resolve('./relative-tool'));

const windows = process.platform === 'win32';
assert.equal(isWindowsBatchFile('tool.cmd'), windows);
assert.equal(isWindowsBatchFile('tool.BAT'), windows);
assert.equal(isWindowsBatchFile('tool.exe'), false);
assert.equal(isWindowsCommandCandidate('tool.cmd'), windows);
assert.equal(isWindowsCommandCandidate('tool.BAT'), windows);
assert.equal(isWindowsCommandCandidate('tool.EXE'), windows);
assert.equal(isWindowsCommandCandidate('tool.com'), false);
assert.equal(isWindowsCommandCandidate('tool'), false);

assert.equal(commandExists('node'), true);
const nodePaths = commandPaths('node');
assert(nodePaths.length > 0, 'node should be discoverable from PATH');
const missingCommand = `codexpro-cli-executables-missing-${process.pid}`;
assert.equal(commandExists(missingCommand), false);
assert.deepEqual(commandPaths(missingCommand), []);
assert.equal(commandAvailable('node'), true);
assert.equal(commandAvailable(missingCommand), false);

const expectedAgentNode = windows ? nodePaths.find(isWindowsCommandCandidate) || 'node' : 'node';
assert.equal(resolveAgentCommand('node'), expectedAgentNode);
assert.equal(resolveAgentCommand('./relative-agent'), './relative-agent');

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-cli-executables-'));
const originalCodexBin = process.env.CODEXPRO_CODEX_BIN;
try {
  const binDir = path.join(tempRoot, 'bin');
  const toolPath = path.join(binDir, 'tool.exe');
  await fs.mkdir(binDir);
  await fs.writeFile(toolPath, 'smoke');

  assert.equal(executableFileExists(toolPath), true);
  assert.equal(executableFileExists(binDir), false);
  assert.equal(executableFileExists(path.join(binDir, 'missing.exe')), false);
  assert.equal(commandAvailable(toolPath), true);
  assert.equal(commandAvailable(path.join(binDir, 'missing.exe')), false);
  assert.equal(commandAvailableFromRoot('./bin/tool.exe', tempRoot), true);
  assert.equal(commandAvailableFromRoot('./bin/missing.exe', tempRoot), false);
  assert.equal(commandAvailableFromRoot('node', tempRoot), true);

  process.env.CODEXPRO_CODEX_BIN = toolPath;
  assert.equal(resolveCodexCommand(), path.resolve(toolPath));

  process.env.CODEXPRO_CODEX_BIN = missingCommand;
  assert.equal(resolveCodexCommand(), missingCommand);
} finally {
  if (originalCodexBin === undefined) delete process.env.CODEXPRO_CODEX_BIN;
  else process.env.CODEXPRO_CODEX_BIN = originalCodexBin;
  await fs.rm(tempRoot, { recursive: true, force: true });
}

assert.match(cliSource, /from '\.\/cli-executables\.mjs';/);
assert.match(cliSource, /from '\.\/cli-presentation\.mjs';/);
for (const name of [
  'commandExists',
  'commandPaths',
  'isPathLike',
  'resolveExecutablePath',
  'isWindowsBatchFile',
  'isWindowsCommandCandidate',
  'resolveCodexCommand',
  'resolveAgentCommand',
  'executableFileExists',
  'commandAvailable',
  'commandAvailableFromRoot'
]) {
  assert(!cliSource.includes(`function ${name}(`), `${name} still implemented in codexpro.mjs`);
}
assert.match(packageJson.scripts.smoke, /node scripts\/cli-options-smoke\.mjs/);
assert.match(packageJson.scripts.smoke, /node scripts\/cli-executables-smoke\.mjs/);
assert.equal(packageJson.scripts['send-trace:smoke'], 'tsx scripts/send-trace-regression.mts');

console.log('✓ CLI executables smoke test passed');
