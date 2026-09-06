import fs from 'node:fs/promises';

const bashPath = 'src/bashOps.ts';
const ciPath = '.github/workflows/ci.yml';

let bashSource = await fs.readFile(bashPath, 'utf8');
const oldEncodedLine = '    const encoded = Buffer.from(command, "utf16le").toString("base64");';
const newEncodedBlock = `    // PowerShell treats a quoted executable path as a string expression unless
    // it is invoked with the call operator. Keep callers cross-platform by
    // normalizing commands such as \"C:\\\\Program Files\\\\node.exe\" -e ...
    // immediately before PowerShell encodes and executes them.
    const powershellCommand = /^\\s*(?:\"[^\"\\r\\n]+\\.(?:exe|cmd|bat|com)\"|'[^'\\r\\n]+\\.(?:exe|cmd|bat|com)')(?:\\s|$)/i.test(command)
      ? \`& \${command}\`
      : command;
    const encoded = Buffer.from(powershellCommand, "utf16le").toString("base64");`;

const encodedMatches = bashSource.split(oldEncodedLine).length - 1;
if (encodedMatches !== 1) {
  throw new Error(`Expected exactly one Windows PowerShell encoding line, found ${encodedMatches}.`);
}
bashSource = bashSource.replace(oldEncodedLine, newEncodedBlock);
await fs.writeFile(bashPath, bashSource, 'utf8');

let ciSource = await fs.readFile(ciPath, 'utf8');
ciSource = ciSource.replace(
  /\s*# scripts\/stress\.mjs currently builds a shell command that PowerShell parses\r?\n\s*# differently on Windows\. Linux\/macOS keep full stress coverage while the\r?\n\s*# Windows jobs still verify install\/build\/smoke\/package without producing\r?\n\s*# a false red workflow for that quoting-only test harness issue\.\r?\n/g,
  '\n'
);
const skipPattern = /^\s*if: runner\.os != 'Windows'\r?$/gm;
const skipMatches = ciSource.match(skipPattern) || [];
if (skipMatches.length !== 2) {
  throw new Error(`Expected exactly two Windows Stress Test skip lines, found ${skipMatches.length}.`);
}
ciSource = ciSource.replace(skipPattern, '');
await fs.writeFile(ciPath, ciSource, 'utf8');

for (const file of [
  'scripts/windows-powershell-command.mjs',
  'scripts/apply-windows-stress-fix.mjs',
  '.github/workflows/fix-windows-stress.yml',
  '.github/run-stress-source-fix'
]) {
  await fs.rm(file, { force: true });
}

console.log('Applied quoted Windows executable fix and re-enabled Windows Stress Test.');
