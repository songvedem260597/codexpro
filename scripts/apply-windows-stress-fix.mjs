import fs from 'node:fs/promises';

const bashPath = 'src/bashOps.ts';
const ciPath = '.github/workflows/ci.yml';

const oldShellArgs = `function shellArgs(command: string): string[] {
  if (process.platform === "win32") {
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    return ["/d", "/s", "/c", \`powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand \${encoded}\`];
  }
  return ["-lc", command];
}`;

const newShellArgs = `function shellArgs(command: string): string[] {
  if (process.platform === "win32") {
    // In PowerShell a quoted executable path is a string expression unless it is
    // invoked with the call operator. Preserve the cross-platform command shape
    // used by callers such as \"C:\\\\Program Files\\\\node.exe\" -e ... by adding
    // '&' only when the first token is a quoted Windows executable.
    const powershellCommand = /^\\s*(?:\"[^\"\\r\\n]+\\.(?:exe|cmd|bat|com)\"|'[^'\\r\\n]+\\.(?:exe|cmd|bat|com)')(?:\\s|$)/i.test(command)
      ? \`& \${command}\`
      : command;
    const encoded = Buffer.from(powershellCommand, "utf16le").toString("base64");
    return ["/d", "/s", "/c", \`powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand \${encoded}\`];
  }
  return ["-lc", command];
}`;

let bashSource = await fs.readFile(bashPath, 'utf8');
if (!bashSource.includes(oldShellArgs)) {
  throw new Error('Expected shellArgs block was not found; refusing to patch an unknown source revision.');
}
bashSource = bashSource.replace(oldShellArgs, newShellArgs);
await fs.writeFile(bashPath, bashSource, 'utf8');

let ciSource = await fs.readFile(ciPath, 'utf8');
const windowsSkipComment = `      # scripts/stress.mjs currently builds a shell command that PowerShell parses
      # differently on Windows. Linux/macOS keep full stress coverage while the
      # Windows jobs still verify install/build/smoke/package without producing
      # a false red workflow for that quoting-only test harness issue.
`;
ciSource = ciSource.replace(windowsSkipComment, '');
const before = ciSource;
ciSource = ciSource.replaceAll(`      - name: Stress Test
        if: runner.os != 'Windows'
        run: npm run stress`, `      - name: Stress Test
        run: npm run stress`);
if (ciSource === before || ciSource.includes("if: runner.os != 'Windows'")) {
  throw new Error('Expected Windows Stress Test skip was not removed cleanly.');
}
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
