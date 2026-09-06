const { ipcMain, net } = require('electron');

require('./main-performance.js');

const DEFAULT_REPO = 'songvedem260597/codexpro';
const GET_RETRY_DELAYS = [0, 450, 1400];
const REQUEST_TIMEOUT_MS = 15000;
const STALE_MAX_AGE_MS = 5 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 15000;

const responseCache = new Map();
let lastNetworkFailureAt = 0;
let lastNetworkError = '';

function normalizeRepo(value) {
  const repo = String(value || DEFAULT_REPO).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Repository must look like owner/name.');
  return repo;
}

function tokenFromInput(input) {
  return String(input || '').trim() || process.env.CODEXPRO_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
}

function requireToken(input) {
  const token = tokenFromInput(input);
  if (!token) throw new Error('Nhập GitHub token trước.');
  return token;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function networkLabel(error) {
  return String(error?.cause?.code || error?.code || error?.name || 'NETWORK_ERROR');
}

function cacheKey(endpoint, token) {
  return `${token ? 'auth' : 'anon'}:${endpoint}`;
}

function cachedResponse(key) {
  const cached = responseCache.get(key);
  if (!cached || Date.now() - cached.at > STALE_MAX_AGE_MS) return null;
  return {
    ...cached.value,
    stale: true,
    networkWarning: lastNetworkError || 'GitHub API tạm thời mất kết nối; đang dùng dữ liệu gần nhất.'
  };
}

async function electronFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await net.fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function githubJson(endpoint, token) {
  const key = cacheKey(endpoint, token);

  if (Date.now() - lastNetworkFailureAt < FAILURE_COOLDOWN_MS) {
    const stale = cachedResponse(key);
    if (stale) return stale;
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GitHub-Actions-Monitor'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let networkError = null;
  for (let attempt = 0; attempt < GET_RETRY_DELAYS.length; attempt += 1) {
    if (GET_RETRY_DELAYS[attempt]) await sleep(GET_RETRY_DELAYS[attempt]);
    try {
      const response = await electronFetch(`https://api.github.com${endpoint}`, { method: 'GET', headers });
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = response.headers.get('x-ratelimit-reset');

      if (!response.ok) {
        let detail = '';
        try {
          const body = await response.json();
          detail = body?.message ? `: ${body.message}` : '';
        } catch {}

        if ([500, 502, 503, 504].includes(response.status) && attempt < GET_RETRY_DELAYS.length - 1) continue;

        const error = new Error(`GitHub API ${response.status}${detail}`);
        error.status = response.status;
        error.rateLimitRemaining = remaining;
        error.rateLimitReset = reset;
        throw error;
      }

      const value = {
        data: response.status === 204 ? null : await response.json(),
        rateLimit: {
          remaining: remaining === null ? null : Number(remaining),
          reset: reset ? Number(reset) * 1000 : null
        },
        stale: false,
        networkWarning: ''
      };
      responseCache.set(key, { at: Date.now(), value });
      lastNetworkFailureAt = 0;
      lastNetworkError = '';
      return value;
    } catch (error) {
      if (error?.status) throw error;
      networkError = error;
      if (attempt >= GET_RETRY_DELAYS.length - 1) break;
    }
  }

  lastNetworkFailureAt = Date.now();
  const code = networkLabel(networkError);
  lastNetworkError = `Mất kết nối GitHub API (${code}).`;
  const stale = cachedResponse(key);
  if (stale) return stale;

  throw new Error(`Không kết nối được GitHub API sau 3 lần thử (${code}). Kiểm tra mạng, VPN/proxy hoặc firewall rồi Refresh lại.`);
}

async function listAccessibleRepos(token) {
  const repos = [];
  let rateLimit = null;
  let stale = false;
  let networkWarning = '';
  for (let page = 1; page <= 10; page += 1) {
    const result = await githubJson(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, token);
    rateLimit = result.rateLimit;
    stale ||= Boolean(result.stale);
    networkWarning ||= result.networkWarning || '';
    const batch = Array.isArray(result.data) ? result.data : [];
    repos.push(...batch);
    if (batch.length < 100 || result.stale) break;
  }
  return { repos, rateLimit, stale, networkWarning };
}

ipcMain.removeHandler('actions:repos');
ipcMain.handle('actions:repos', async (_event, input = {}) => {
  const token = requireToken(input.token);
  const result = await listAccessibleRepos(token);
  return {
    authenticated: true,
    rateLimit: result.rateLimit,
    stale: result.stale,
    networkWarning: result.networkWarning,
    repos: result.repos.map((repo) => ({
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
});

ipcMain.removeHandler('actions:list');
ipcMain.handle('actions:list', async (_event, input = {}) => {
  const repo = normalizeRepo(input.repo);
  const token = tokenFromInput(input.token);
  const result = await githubJson(`/repos/${repo}/actions/runs?per_page=40`, token);
  return {
    repo,
    authenticated: Boolean(token),
    rateLimit: result.rateLimit,
    stale: result.stale,
    networkWarning: result.networkWarning,
    runs: (result.data?.workflow_runs || []).map((run) => ({
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

ipcMain.removeHandler('actions:jobs');
ipcMain.handle('actions:jobs', async (_event, input = {}) => {
  const repo = normalizeRepo(input.repo);
  const runId = Number(input.runId);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Invalid run id.');
  const token = tokenFromInput(input.token);
  const result = await githubJson(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, token);
  return {
    authenticated: Boolean(token),
    rateLimit: result.rateLimit,
    stale: result.stale,
    networkWarning: result.networkWarning,
    jobs: (result.data?.jobs || []).map((job) => ({
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
