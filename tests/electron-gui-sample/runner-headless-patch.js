const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PATCH_KEY = Symbol.for('github-actions-monitor.headless-runner-patch');

if (!childProcess[PATCH_KEY]) {
  const originalSpawn = childProcess.spawn.bind(childProcess);

  function vbsString(value) {
    return `"${String(value || '').replace(/"/g, '""')}"`;
  }

  function powershellSingleQuote(value) {
    return `'${String(value || '').replace(/'/g, "''")}'`;
  }

  function isRunnerRunCmd(command, args, options) {
    if (process.platform !== 'win32') return false;
    const executable = path.win32.basename(String(command || '')).toLowerCase();
    if (executable !== 'cmd.exe' && executable !== 'cmd') return false;
    if (!Array.isArray(args)) return false;

    const normalized = args.map((value) => String(value || '').toLowerCase());
    const commandIndex = normalized.findIndex((value) => value === '/c');
    if (commandIndex < 0 || normalized[commandIndex + 1] !== 'run.cmd') return false;

    const root = String(options?.cwd || '').trim();
    if (!root) return false;
    return fs.existsSync(path.join(root, 'run.cmd')) && fs.existsSync(path.join(root, 'bin', 'Runner.Listener.exe'));
  }

  function readServiceName(root) {
    try {
      const value = fs.readFileSync(path.join(root, '.service'), 'utf8').replace(/^\uFEFF/, '').trim();
      return value || '';
    } catch {
      return '';
    }
  }

  function spawnConfiguredService(root, options) {
    const serviceName = readServiceName(root);
    if (!serviceName) return null;
    const script = [
      `$service = ${powershellSingleQuote(serviceName)}`,
      'Start-Service -Name $service -ErrorAction Stop'
    ].join('; ');
    return originalSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      cwd: root,
      env: options?.env || process.env,
      detached: Boolean(options?.detached),
      stdio: 'ignore',
      windowsHide: true
    });
  }

  function spawnRunCmdWithoutWindow(root, options) {
    const runCmd = path.join(root, 'run.cmd');
    const scriptPath = path.join(
      os.tmpdir(),
      `github-actions-monitor-runner-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.vbs`
    );
    const script = [
      'On Error Resume Next',
      'Set shell = CreateObject("WScript.Shell")',
      `shell.CurrentDirectory = ${vbsString(root)}`,
      `shell.Run Chr(34) & ${vbsString(runCmd)} & Chr(34), 0, False`,
      'If Err.Number <> 0 Then WScript.Quit 1',
      'WScript.Quit 0'
    ].join('\r\n');

    fs.writeFileSync(scriptPath, script, 'utf8');
    const child = originalSpawn('wscript.exe', ['//B', '//Nologo', scriptPath], {
      cwd: root,
      env: options?.env || process.env,
      detached: Boolean(options?.detached),
      stdio: 'ignore',
      windowsHide: true
    });

    const cleanup = () => {
      try { fs.rmSync(scriptPath, { force: true }); } catch {}
    };
    child.once('exit', cleanup);
    child.once('error', cleanup);
    setTimeout(cleanup, 10000).unref?.();
    return child;
  }

  childProcess.spawn = function headlessRunnerSpawn(command, args, options) {
    if (!isRunnerRunCmd(command, args, options)) return originalSpawn(command, args, options);

    const root = path.resolve(String(options.cwd));
    const serviceChild = spawnConfiguredService(root, options);
    if (serviceChild) return serviceChild;
    return spawnRunCmdWithoutWindow(root, options);
  };

  childProcess[PATCH_KEY] = {
    installed: true,
    originalSpawn,
    isRunnerRunCmd
  };
}

module.exports = childProcess[PATCH_KEY];
