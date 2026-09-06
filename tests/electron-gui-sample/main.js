const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REPO = 'songvedem260597/codexpro';

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

async function githubJson(endpoint, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GitHub-Actions-Monitor'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`https://api.github.com${endpoint}`, { headers });
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
    data: await response.json(),
    rateLimit: {
      remaining: remaining === null ? null : Number(remaining),
      reset: reset ? Number(reset) * 1000 : null
    }
  };
}

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
