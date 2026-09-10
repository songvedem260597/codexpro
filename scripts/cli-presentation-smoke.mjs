import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printBox, usage, wrapLine } from './cli-presentation.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectRoot, 'scripts', 'codexpro.mjs');
const presentation = path.join(projectRoot, 'scripts', 'cli-presentation.mjs');
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

function captureLogs(callback) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  try {
    callback();
  } finally {
    console.log = original;
  }
  return lines;
}

const usageText = captureLogs(usage).join('\n');
for (const section of ['Usage:', 'Options:', 'Execute handoff options:', 'Watch handoff options:', 'Loop handoff options:']) {
  assert(usageText.includes(section), `missing help section: ${section}`);
}
for (const option of ['--root <dir>', '--tool-mode <minimal|standard|full>', '--tunnel <none|cloudflare|cloudflare-named|ngrok|tailscale>', '--help']) {
  assert(usageText.includes(option), `missing help option: ${option}`);
}

assert.deepEqual(wrapLine('alpha beta gamma delta', 11), ['alpha beta', 'gamma delta']);
assert.deepEqual(wrapLine('supercalifragilistic', 5), ['supercalifragilistic']);

const box = captureLogs(() => printBox('Wrap smoke', ['alpha '.repeat(20).trim()])).map(stripAnsi);
assert(box[0].includes(' Wrap smoke '), 'box title divider missing');
assert(/^-+$/.test(box.at(-1)), 'box closing divider missing');
const body = box.slice(1, -1);
assert(body.length > 1, 'box content did not wrap');
assert(body.every((line) => line.startsWith('| ') && line.endsWith(' |')), 'box row framing changed');
assert(body.every((line) => line.length === box[0].length), 'box row width changed');

const cliSource = await fs.readFile(cli, 'utf8');
const presentationSource = await fs.readFile(presentation, 'utf8');
assert.match(cliSource, /import \{ labelValue, paint, printBox, statusLine, usage \} from '\.\/cli-presentation\.mjs';/);
assert(!cliSource.includes('function usage()'));
assert(!cliSource.includes('function wrapLine('));
assert.match(presentationSource, /export function usage\(\)/);
assert.match(presentationSource, /export function printBox\(/);
assert.match(presentationSource, /export function wrapLine\(/);

const help = spawnSync(process.execPath, [cli, '--help'], {
  cwd: projectRoot,
  encoding: 'utf8',
  timeout: 5000,
  env: { ...process.env, NO_COLOR: '1', CI: '1' }
});
assert.equal(help.status, 0, help.stderr || help.stdout || help.error?.message);
for (const section of ['Usage:', 'Options:', 'Execute handoff options:', 'Watch handoff options:', 'Loop handoff options:']) {
  assert(help.stdout.includes(section), `codexpro --help missing section: ${section}`);
}

console.log('✓ CLI presentation smoke test passed');
