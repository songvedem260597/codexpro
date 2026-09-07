const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_REPO = 'songvedem260597/codexpro';
const RUNNER_LOOKUP_TTL = 60000;
const PROCESS_TTL = 3500;
const LOG_TTL = 6000;

const runnerCache = new Map();
const processCache = new Map();
const logCache = new Map();

function normalizeRepo(value) {
  const repo = String(value || DEFAULT_REPO).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Repository must look like owner/name.');
  return repo;
}

function localAppDataRoot() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function monitorDataRoot() {
  return path.join(localAppDataRoot(), 'GitHubActionsMonitorData');
}

function configuredRunnerCandidates(repo) {
  const repoName = normalizeRepo(repo).split('/')[1];
  const candidates = [];
  if (process.env.GITHUB_ACTIONS_RUNNER_TEMPLATE) candidates.push(path.resolve(process.env.GITHUB_ACTIONS_RUNNER_TEMPLATE));
  if (process.platform === 'win32') {
    candidates.push(`C:\\actions-runner-${repoName}`, 'C:\\actions-runner-codexpro', 'C:\\actions-runner');
    try {
      for (const entry of fs.readdirSync('C:\\', { withFileTypes: true })) {
        if (entry.isDirectory() && /^actions-runner/i.test(entry.name)) candidates.push(path.join('C:\\', entry.name));
      }
    } catch {}
  }
  const managedRoot = path.join(monitorDataRoot(), 'runners');
  try {
    for (const entry of fs.readdirSync(managedRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(managedRoot, entry.name));
    }
  } catch {}
  return [...new Set(candidates.map((item) => path.resolve(item)))];
}

function readConfiguredRunner(root) {
  try {
    if (!fs.existsSync(path.join(root, 'run.cmd'))) return null;
    const raw = fs.readFileSync(path.join(root, '.runner'), 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    const runnerName = String(data.agentName || data.AgentName || data.name || '').trim() || path.basename(root);
    const githubUrl = String(data.gitHubUrl || data.GitHubUrl || data.githubUrl || '').trim();
    let repo = '';
    const match = githubUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/?$/i);
    if (match) repo = match[1].replace(/\.git$/i, '');
    return { root: path.resolve(root), runnerName, repo, githubUrl };
  } catch {
    return null;
  }
}

function scanLocalRunner(repo) {
  const expected = normalizeRepo(repo).toLowerCase();
  const repoName = expected.split('/')[1];
  let basenameFallback = null;
  let codexFallback = null;

  for (const root of configuredRunnerCandidates(repo)) {
    const configured = readConfiguredRunner(root);
    if (!configured) continue;
    const base = path.basename(root).toLowerCase();
    if (configured.repo && configured.repo.toLowerCase() === expected) return configured;
    if (base === `actions-runner-${repoName}`) basenameFallback ||= configured;
    if (expected === DEFAULT_REPO.toLowerCase() && base === 'actions-runner-codexpro') codexFallback ||= configured;
    if (expected === DEFAULT_REPO.toLowerCase() && configured.runnerName.toLowerCase() === 'codexpro-pc') codexFallback ||= configured;
  }
  return basenameFallback || codexFallback || null;
}

function findLocalRunner(repo, { force = false } = {}) {
  const key = normalizeRepo(repo).toLowerCase();
  const cached = runnerCache.get(key);
  if (!force && cached && Date.now() - cached.at < RUNNER_LOOKUP_TTL) {
    if (!cached.value || fs.existsSync(path.join(cached.value.root, 'run.cmd'))) return cached.value;
  }
  const value = scanLocalRunner(repo);
  runnerCache.set(key, { at: Date.now(), value });
  return value;
}

function runProcessInspection(root) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ running: false, busy: false, listenerPid: null, workerPids: [] });
  }
  const escaped = String(path.resolve(root)).replace(/'/g, "''");
  const script = [
    `$root = '${escaped}'`,
    "$prefix = $root.TrimEnd('\\') + '\\'",
    "$items = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^Runner\\.(Listener|Worker)(\\.exe)?$' })",
    "$matching = @($items | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($prefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) })",
    "$listener = @($matching | Where-Object { $_.Name -match '^Runner\\.Listener(\\.exe)?$' })",
    "$worker = @($matching | Where-Object { $_.Name -match '^Runner\\.Worker(\\.exe)?$' })",
    '$listenerPid = if ($listener.Count -gt 0) { $listener[0].ProcessId } else { 0 }',
    '$workerPids = @($worker | ForEach-Object { $_.ProcessId }) -join ","',
    '[Console]::Out.Write((($listener.Count -gt 0).ToString().ToLower()) + "|" + (($worker.Count -gt 0).ToString().ToLower()) + "|" + $listenerPid + "|" + $workerPids)'
  ].join('; ');

  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 6000,
      maxBuffer: 64 * 1024
    }, (error, stdout) => {
      if (error) {
        resolve({ running: false, busy: false, listenerPid: null, workerPids: [] });
        return;
      }
      const [runningText, busyText, pidText, workersText = ''] = String(stdout || '').trim().split('|');
      resolve({
        running: runningText === 'true',
        busy: busyText === 'true',
        listenerPid: Number(pidText) || null,
        workerPids: workersText.split(',').map(Number).filter(Boolean)
      });
    });
  });
}

async function inspectRunnerProcess(root, { force = false } = {}) {
  const key = path.resolve(root).toLowerCase();
  const cached = processCache.get(key);
  if (!force && cached?.value && Date.now() - cached.at < PROCESS_TTL) return cached.value;
  if (cached?.promise) return cached.promise;

  const promise = runProcessInspection(root).then((value) => {
    processCache.set(key, { at: Date.now(), value, promise: null });
    return value;
  }).catch(() => {
    const fallback = cached?.value || { running: false, busy: false, listenerPid: null, workerPids: [] };
    processCache.set(key, { at: Date.now(), value: fallback, promise: null });
    return fallback;
  });

  processCache.set(key, { at: cached?.at || 0, value: cached?.value || null, promise });
  return promise;
}

function invalidateProcessState(root) {
  if (!root) return;
  processCache.delete(path.resolve(root).toLowerCase());
}

function cleanDiagLine(line) {
  let value = String(line || '').trim();
  if (!value) return '';
  value = value
    .replace(/github_pat_[A-Za-z0-9_]+/g, '***')
    .replace(/gh[pousr]_[A-Za-z0-9]+/g, '***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
  const match = value.match(/^\[([^\]]+)]\s*(.*)$/);
  if (match) value = `${match[1]} ${match[2]}`;
  return value;
}

function readRunnerEvents(root, { force = false } = {}) {
  const key = path.resolve(root).toLowerCase();
  const cached = logCache.get(key);
  if (!force && cached && Date.now() - cached.at < LOG_TTL) return cached.lines;

  const diag = path.join(root, '_diag');
  const events = [];
  try {
    const files = fs.readdirSync(diag, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.log$/i.test(entry.name))
      .map((entry) => {
        const file = path.join(diag, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(file).mtimeMs; } catch {}
        return { file, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 4);

    for (const item of files) {
      try {
        const stat = fs.statSync(item.file);
        const max = 96 * 1024;
        const start = Math.max(0, stat.size - max);
        const length = stat.size - start;
        const fd = fs.openSync(item.file, 'r');
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        fs.closeSync(fd);
        const text = buffer.toString('utf8');
        for (const rawLine of text.split(/\r?\n/)) {
          if (!/(Running job:|completed with result:|Listening for Jobs|Runner connect|Runner reconnected|Job .*completed|Job .*started|Running job)/i.test(rawLine)) continue;
          const line = cleanDiagLine(rawLine);
          if (line) events.push(line);
        }
      } catch {}
    }
  } catch {}

  const lines = [...new Set(events)].slice(-70);
  logCache.set(key, { at: Date.now(), lines });
  return lines;
}

module.exports = {
  DEFAULT_REPO,
  normalizeRepo,
  findLocalRunner,
  inspectRunnerProcess,
  invalidateProcessState,
  readRunnerEvents
};
