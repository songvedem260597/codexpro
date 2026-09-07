const { app, ipcMain, session, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REPO = 'songvedem260597/codexpro';

function normalizeRepo(value) {
  const repo = String(value || DEFAULT_REPO).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Repository must look like owner/name.');
  return repo;
}

function requireToken(value) {
  const token = String(value || '').trim() || process.env.CODEXPRO_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!token) throw new Error('Nhập GitHub token trước để dùng CI/CD.');
  return token;
}

function positiveInt(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} không hợp lệ.`);
  return number;
}

function safeFileName(value) {
  return String(value || 'artifact')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120) || 'artifact';
}

async function githubJson(endpoint, token, options = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GitHub-Actions-Monitor-CICD'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`https://api.github.com${endpoint}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'follow'
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!response.ok) {
    const detail = data && typeof data === 'object' && data.message ? `: ${data.message}` : '';
    throw new Error(`GitHub API ${response.status}${detail}`);
  }
  return data;
}

function installSessionPreload() {
  app.whenReady().then(() => {
    const cicdPreload = path.join(__dirname, 'preload-cicd.js');
    const current = session.defaultSession.getPreloads();
    if (!current.some((item) => path.resolve(item) === path.resolve(cicdPreload))) {
      session.defaultSession.setPreloads([...current, cicdPreload]);
    }
  });
}

function registerCicdHandlers() {
  ipcMain.handle('cicd:workflows', async (_event, input = {}) => {
    const repo = normalizeRepo(input.repo);
    const token = requireToken(input.token);
    const [workflowData, repoData] = await Promise.all([
      githubJson(`/repos/${repo}/actions/workflows?per_page=100`, token),
      githubJson(`/repos/${repo}`, token)
    ]);
    return {
      repo,
      defaultBranch: repoData?.default_branch || 'main',
      workflows: (workflowData?.workflows || []).map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        path: workflow.path,
        state: workflow.state,
        htmlUrl: workflow.html_url || ''
      }))
    };
  });

  ipcMain.handle('cicd:dispatch', async (_event, input = {}) => {
    const repo = normalizeRepo(input.repo);
    const token = requireToken(input.token);
    const workflowId = String(input.workflowId || '').trim();
    const ref = String(input.ref || '').trim();
    if (!workflowId) throw new Error('Chọn workflow trước.');
    if (!ref) throw new Error('Nhập branch/tag/SHA để chạy workflow.');
    const inputs = input.inputs && typeof input.inputs === 'object' && !Array.isArray(input.inputs) ? input.inputs : {};
    const body = { ref };
    if (Object.keys(inputs).length) body.inputs = inputs;
    await githubJson(`/repos/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, token, { method: 'POST', body });
    return { ok: true, repo, workflowId, ref };
  });

  ipcMain.handle('cicd:cancel', async (_event, input = {}) => {
    const repo = normalizeRepo(input.repo);
    const token = requireToken(input.token);
    const runId = positiveInt(input.runId, 'Run ID');
    await githubJson(`/repos/${repo}/actions/runs/${runId}/cancel`, token, { method: 'POST' });
    return { ok: true, repo, runId };
  });

  ipcMain.handle('cicd:rerun', async (_event, input = {}) => {
    const repo = normalizeRepo(input.repo);
    const token = requireToken(input.token);
    const runId = positiveInt(input.runId, 'Run ID');
    await githubJson(`/repos/${repo}/actions/runs/${runId}/rerun`, token, { method: 'POST' });
    return { ok: true, repo, runId };
  });

  ipcMain.handle('cicd:artifacts', async (_event, input = {}) => {
    const repo = normalizeRepo(input.repo);
    const token = requireToken(input.token);
    const runId = positiveInt(input.runId, 'Run ID');
    const data = await githubJson(`/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`, token);
    return {
      repo,
      runId,
      artifacts: (data?.artifacts || []).map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        sizeInBytes: artifact.size_in_bytes || 0,
        expired: Boolean(artifact.expired),
        createdAt: artifact.created_at,
        expiresAt: artifact.expires_at,
        updatedAt: artifact.updated_at
      }))
    };
  });

  ipcMain.handle('cicd:download-artifact', async (_event, input = {}) => {
    const repo = normalizeRepo(input.repo);
    const token = requireToken(input.token);
    const artifactId = positiveInt(input.artifactId, 'Artifact ID');
    const artifactName = safeFileName(input.name || `artifact-${artifactId}`);

    const response = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}/zip`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GitHub-Actions-Monitor-CICD',
        Authorization: `Bearer ${token}`
      },
      redirect: 'follow'
    });
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        if (body?.message) detail = `: ${body.message}`;
      } catch {}
      throw new Error(`GitHub API ${response.status}${detail}`);
    }

    const save = await dialog.showSaveDialog({
      title: 'Lưu GitHub Actions artifact',
      defaultPath: path.join(app.getPath('downloads'), `${artifactName}.zip`),
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
    });
    if (save.canceled || !save.filePath) return { ok: false, canceled: true };

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(save.filePath, buffer);
    return { ok: true, canceled: false, filePath: save.filePath, bytes: buffer.length };
  });

  ipcMain.handle('cicd:deployments', async (_event, input = {}) => {
    const repo = normalizeRepo(input.repo);
    const token = requireToken(input.token);
    const deployments = await githubJson(`/repos/${repo}/deployments?per_page=15`, token);
    const items = await Promise.all((Array.isArray(deployments) ? deployments : []).map(async (deployment) => {
      let latest = null;
      try {
        const statuses = await githubJson(`/repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`, token);
        latest = Array.isArray(statuses) ? statuses[0] || null : null;
      } catch {}
      return {
        id: deployment.id,
        environment: deployment.environment || 'production',
        ref: deployment.ref || '',
        sha: deployment.sha || '',
        task: deployment.task || 'deploy',
        description: deployment.description || '',
        creator: deployment.creator?.login || '',
        createdAt: deployment.created_at,
        updatedAt: deployment.updated_at,
        state: latest?.state || 'pending',
        environmentUrl: latest?.environment_url || '',
        logUrl: latest?.log_url || ''
      };
    }));
    return { repo, deployments: items };
  });
}

installSessionPreload();
require('./main-ui-fix.js');
registerCicdHandlers();
