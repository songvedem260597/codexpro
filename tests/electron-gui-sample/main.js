const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_REPO = 'songvedem260597/codexpro';
const runnerProcesses = new Map();

function normalizeRepo(value) {
  const repo = String(value || DEFAULT_REPO).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('Repository must look like owner/name.');
  }
  return repo;
}

function tokenFromInput(input) {
  const supplied = String(input || '').trim();
  return supplied || process.env.CODEXPRO_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
}

function requireToken(input) {
  const token = tokenFromInput(input);
  if (!token) throw new Error('Nhập GitHub token trước.');
  return token;
}

async function githubJson(endpoint, token, options = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GitHub-Actions-Monitor'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`https://api.github.com${endpoint}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.message ? `: ${body.message}` : '';
    } catch {}
    const error = new Error(`GitHub API ${response.status}${detail}`);
    error.status = response.status;
    error.rateLimitRemaining = remaining;
    error.rateLimitReset = reset;
    throw error;
  }
  return {
    data: response.status === 204 ? null : await response.json(),
    rateLimit: {
      remaining: remaining === null ? null : Number(remaining),
      reset: reset ? Number(reset) * 1000 : null
    }
  };
}

async function listAccessibleRepos(token) {
  const repos = [];
  let rateLimit = null;
  for (let page = 1; page <= 10; page += 1) {
    const result = await githubJson(
      `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
      token
    );
    rateLimit = result.rateLimit;
    const batch = Array.isArray(result.data) ? result.data : [];
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return {
    rateLimit,
    repos: repos.map((repo) => ({
      id: repo.id,
      fullName: repo.full_name,
      private: Boolean(repo.private),
      archived: Boolean(repo.archived),
      disabled: Boolean(repo.disabled),
      admin: Boolean(repo.permissions?.admin),
      maintain: Boolean(repo.permissions?.maintain),
      push: Boolean(repo.permissions?.push),
      defaultBranch: repo.default_branch || ''
    }))
  };
}

function monitorDataRoot() {
  const localAppData = process.env.LOCALAPPDATA || app.getPath('userData');
  return path.join(localAppData, 'GitHubActionsMonitorData');
}

function runnerRoot(repo) {
  const slug = normalizeRepo(repo).replace(/[^A-Za-z0-9_.-]+/g, '__');
  return path.join(monitorDataRoot(), 'runners', slug);
}

function runnerMetaPath(repo) {
  return path.join(runnerRoot(repo), 'monitor-runner.json');
}

function runnerName(repo) {
  const machine = os.hostname().replace(/[^A-Za-z0-9_.-]+/g, '-');
  const slug = normalizeRepo(repo).replace(/[^A-Za-z0-9_.-]+/g, '-');
  return `${machine}-${slug}-monitor`.slice(0, 64);
}

function readRunnerMeta(repo) {
  try {
    return JSON.parse(fs.readFileSync(runnerMetaPath(repo), 'utf8'));
  } catch {
    return null;
  }
}

function writeRunnerMeta(repo, value) {
  fs.mkdirSync(runnerRoot(repo), { recursive: true });
  fs.writeFileSync(runnerMetaPath(repo), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runnerTemplateCandidates() {
  const candidates = [];
  if (process.env.GITHUB_ACTIONS_RUNNER_TEMPLATE) {
    candidates.push(path.resolve(process.env.GITHUB_ACTIONS_RUNNER_TEMPLATE));
  }
  if (process.platform === 'win32') {
    candidates.push('C:\\actions-runner-codexpro', 'C:\\actions-runner');
    try {
      for (const entry of fs.readdirSync('C:\\', { withFileTypes: true })) {
        if (entry.isDirectory() && /^actions-runner/i.test(entry.name)) {
          candidates.push(path.join('C:\\', entry.name));
        }
      }
    } catch {}
  }
  return [...new Set(candidates)];
}

function findRunnerTemplate() {
  for (const candidate of runnerTemplateCandidates()) {
    if (
      fs.existsSync(path.join(candidate, 'config.cmd')) &&
      fs.existsSync(path.join(candidate, 'run.cmd'))
    ) return candidate;
  }
  throw new Error('Không tìm thấy GitHub Actions runner template trên máy.');
}

function copyRunnerTemplate(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  const blockedDirectories = new Set(['_work', '_diag']);
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: (sourcePath) => {
      const relative = path.relative(source, sourcePath);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      if (blockedDirectories.has(parts[0])) return false;
      const name = path.basename(sourcePath).toLowerCase();
      if (name === '.runner' || name === '.service' || name === '.env' || name === '.path') return false;
      if (name.startsWith('.credentials')) return false;
      return true;
    }
  });
}

function commandQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function configureRunner(repo, token) {
  if (process.platform !== 'win32') throw new Error('Start Runner hiện chỉ hỗ trợ Windows.');
  const root = runnerRoot(repo);
  const source = findRunnerTemplate();
  copyRunnerTemplate(source, root);
  return { root, source };
}

async function obtainRegistrationToken(repo, token) {
  const result = await githubJson(`/repos/${repo}/actions/runners/registration-token`, token, { method: 'POST' });
  const registrationToken = String(result.data?.token || '');
  if (!registrationToken) throw new Error('GitHub không trả runner registration token.');
  return registrationToken;
}

function runRunnerConfiguration(root, repo, registrationToken, name) {
  const command = [
    'config.cmd',
    '--url', commandQuote(`https://github.com/${repo}`),
    '--token', commandQuote(registrationToken),
    '--name', commandQuote(name),
    '--work', commandQuote('_work'),
    '--unattended',
    '--replace'
  ].join(' ');
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
    cwd: root,
    env: { ...process.env, RUNNER_TRACKING_ID: '' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.replaceAll(registrationToken, '***').trim();
    throw new Error(`Config runner thất bại${output ? `: ${output.slice(-1000)}` : ''}`);
  }
}

function launchRunnerProcess(repo, root, name) {
  const child = spawn('cmd.exe', ['/d', '/s', '/c', 'run.cmd'], {
    cwd: root,
    env: { ...process.env, RUNNER_TRACKING_ID: '' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  runnerProcesses.set(repo, {
    pid: child.pid,
    runnerName: name,
    root,
    startedAt: new Date().toISOString()
  });
  child.once('exit', () => {
    const tracked = runnerProcesses.get(repo);
    if (tracked?.pid === child.pid) runnerProcesses.delete(repo);
  });
  child.unref();
  return child.pid;
}

function trackedRunner(repo) {
  const tracked = runnerProcesses.get(repo);
  if (!tracked?.pid) return null;
  try {
    process.kill(tracked.pid, 0);
    return tracked;
  } catch {
    runnerProcesses.delete(repo);
    return null;
  }
}

function stopRunnerProcesses(root) {
  if (process.platform !== 'win32') return;
  const escaped = String(root).replace(/'/g, "''");
  const script = [
    `$needle = '${escaped}'`,
    "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ].join('; ');
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000
  });
}

async function findRemoteRunner(repo, token, name) {
  const result = await githubJson(`/repos/${repo}/actions/runners?per_page=100`, token);
  const runners = Array.isArray(result.data?.runners) ? result.data.runners : [];
  return runners.find((runner) => runner.name === name) || null;
}

ipcMain.handle('actions:repos', async (_event, input = {}) => {
  const token = requireToken(input.token);
  const result = await listAccessibleRepos(token);
  return {
    authenticated: true,
    rateLimit: result.rateLimit,
    repos: result.repos
  };
});

ipcMain.handle('actions:list', async (_event, input = {}) => {
  const repo = normalizeRepo(input.repo);
  const token = tokenFromInput(input.token);
  const result = await githubJson(`/repos/${repo}/actions/runs?per_page=40`, token);
  return {
    repo,
    authenticated: Boolean(token),
    rateLimit: result.rateLimit,
    runs: (result.data.workflow_runs || []).map((run) => ({
      id: run.id,
      name: run.name,
      displayTitle: run.display_title,
      runNumber: run.run_number,
      event: run.event,
      branch: run.head_branch,
      sha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      startedAt: run.run_started_at,
      htmlUrl: run.html_url,
      actor: run.actor?.login || '',
      attempt: run.run_attempt || 1
    }))
  };
});

ipcMain.handle('actions:jobs', async (_event, input = {}) => {
  const repo = normalizeRepo(input.repo);
  const runId = Number(input.runId);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Invalid run id.');
  const token = tokenFromInput(input.token);
  const result = await githubJson(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, token);
  return {
    authenticated: Boolean(token),
    rateLimit: result.rateLimit,
    jobs: (result.data.jobs || []).map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      htmlUrl: job.html_url,
      runnerName: job.runner_name || '',
      runnerGroup: job.runner_group_name || '',
      labels: job.labels || [],
      steps: (job.steps || []).map((step) => ({
        number: step.number,
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        startedAt: step.started_at,
        completedAt: step.completed_at
      }))
    }))
  };
});

ipcMain.handle('runner:status', async (_event, input = {}) => {
  const repo = normalizeRepo(input.repo);
  const token = tokenFromInput(input.token);
  const meta = readRunnerMeta(repo);
  if (!meta) {
    return { configured: false, running: false, online: false, busy: false, repo };
  }

  let remote = null;
  let remoteError = '';
  if (token) {
    try {
      remote = await findRemoteRunner(repo, token, meta.runnerName);
    } catch (error) {
      remoteError = error.message || String(error);
    }
  }
  const tracked = trackedRunner(repo);
  const online = remote?.status === 'online';
  return {
    configured: true,
    running: online || Boolean(tracked),
    online,
    busy: Boolean(remote?.busy),
    repo,
    runnerName: meta.runnerName,
    root: meta.root,
    pid: tracked?.pid || null,
    remoteError
  };
});

ipcMain.handle('runner:start', async (_event, input = {}) => {
  const repo = normalizeRepo(input.repo);
  const token = requireToken(input.token);
  const name = runnerName(repo);
  const currentMeta = readRunnerMeta(repo);

  if (currentMeta?.runnerName) {
    try {
      const currentRemote = await findRemoteRunner(repo, token, currentMeta.runnerName);
      if (currentRemote?.status === 'online') {
        return {
          ok: true,
          alreadyRunning: true,
          repo,
          runnerName: currentMeta.runnerName,
          online: true,
          busy: Boolean(currentRemote.busy)
        };
      }
    } catch {}
  }

  const existingRoot = runnerRoot(repo);
  stopRunnerProcesses(existingRoot);

  const registrationToken = await obtainRegistrationToken(repo, token);
  const prepared = configureRunner(repo, token);
  runRunnerConfiguration(prepared.root, repo, registrationToken, name);
  writeRunnerMeta(repo, {
    repo,
    runnerName: name,
    root: prepared.root,
    template: prepared.source,
    configuredAt: new Date().toISOString()
  });
  const pid = launchRunnerProcess(repo, prepared.root, name);

  return {
    ok: true,
    alreadyRunning: false,
    repo,
    runnerName: name,
    pid,
    root: prepared.root
  };
});

ipcMain.handle('runner:stop', async (_event, input = {}) => {
  const repo = normalizeRepo(input.repo);
  const root = runnerRoot(repo);
  stopRunnerProcesses(root);
  runnerProcesses.delete(repo);
  return { ok: true, repo, runnerName: readRunnerMeta(repo)?.runnerName || runnerName(repo) };
});

ipcMain.handle('actions:open-url', async (_event, value) => {
  const url = String(value || '');
  if (!/^https:\/\/github\.com\//i.test(url)) throw new Error('Only github.com links are allowed.');
  await shell.openExternal(url);
  return true;
});

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#07111f',
    title: 'GitHub Actions Monitor',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.setMenuBarVisibility(false);
  win.removeMenu();
  win.loadFile('index.html');
  win.once('ready-to-show', () => {
    win.show();
    const marker = process.env.CODEXPRO_ELECTRON_TEST_MARKER;
    if (marker) fs.writeFileSync(marker, `ready ${new Date().toISOString()}\n`, 'utf8');
  });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('GitHub.Actions.Monitor');
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
