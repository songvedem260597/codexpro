const { contextBridge, ipcRenderer } = require('electron');

function authToken(input) {
  return String(input?.token || '').trim();
}

contextBridge.exposeInMainWorld('actionsMonitor', {
  listRepos: (input) => ipcRenderer.invoke('actions:repos', input),
  listRuns: (input) => {
    if (!authToken(input)) {
      return Promise.resolve({
        repo: String(input?.repo || '').trim(),
        authenticated: false,
        requiresToken: true,
        rateLimit: { remaining: null, reset: null },
        runs: []
      });
    }
    return ipcRenderer.invoke('actions:list', input);
  },
  listJobs: (input) => {
    if (!authToken(input)) {
      return Promise.reject(new Error('Nhập GitHub token trước để tải Jobs / Steps.'));
    }
    return ipcRenderer.invoke('actions:jobs', input);
  },
  runnerStatus: (input) => ipcRenderer.invoke('runner:status', input),
  startRunner: (input) => ipcRenderer.invoke('runner:start', input),
  stopRunner: (input) => ipcRenderer.invoke('runner:stop', input),
  openUrl: (url) => ipcRenderer.invoke('actions:open-url', url)
});

function makeSpinner(className = 'github-actions-monitor-spinner') {
  const spinner = document.createElement('span');
  spinner.className = className;
  spinner.setAttribute('aria-hidden', 'true');
  return spinner;
}

function installMonitorEnhancementStyles() {
  if (document.getElementById('github-actions-monitor-live-style')) return;
  const style = document.createElement('style');
  style.id = 'github-actions-monitor-live-style';
  style.textContent = `
    @keyframes github-actions-monitor-spin {
      to { transform: rotate(360deg); }
    }
    .github-actions-monitor-spinner {
      width: 15px;
      height: 15px;
      display: inline-block;
      flex: 0 0 auto;
      box-sizing: border-box;
      border: 2px solid rgba(77, 156, 255, .28);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: github-actions-monitor-spin .8s linear infinite;
    }
    .card.running .github-actions-monitor-spinner {
      width: 18px;
      height: 18px;
      border-width: 2.4px;
    }
    .step-symbol.active .github-actions-monitor-spinner {
      width: 11px;
      height: 11px;
      border-width: 1.7px;
    }
    .live-step-banner {
      margin: 0 12px 10px;
      padding: 9px 11px;
      border: 1px solid rgba(77, 156, 255, .44);
      border-radius: 10px;
      background: linear-gradient(90deg, rgba(77, 156, 255, .14), rgba(77, 156, 255, .05));
      color: #d9eaff;
      display: flex;
      align-items: center;
      gap: 9px;
      font-size: 12px;
      box-shadow: inset 3px 0 0 #4d9cff;
    }
    .live-step-banner.waiting {
      border-color: rgba(245, 196, 81, .36);
      background: linear-gradient(90deg, rgba(245, 196, 81, .10), rgba(245, 196, 81, .03));
      box-shadow: inset 3px 0 0 #f5c451;
      color: #f7dfa1;
    }
    .live-step-label {
      color: #7bb8ff;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: .65px;
      white-space: nowrap;
    }
    .live-step-name {
      min-width: 0;
      flex: 1 1 auto;
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .live-step-time {
      color: #7bb8ff;
      font-weight: 850;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .step.current-live-step {
      background: linear-gradient(90deg, rgba(77, 156, 255, .16), rgba(77, 156, 255, .035));
      box-shadow: inset 3px 0 0 #4d9cff;
      color: #eef6ff;
      font-weight: 720;
    }
    .repo-wrap #repo { display: none !important; }
    .repo-picker {
      min-width: 235px;
      max-width: 300px;
      border: 0;
      outline: 0;
      background: transparent;
      color: #f3f7ff;
      padding: 10px 30px 10px 0;
      cursor: pointer;
      font: inherit;
    }
    .repo-picker option { background: #0d1b2e; color: #f3f7ff; }
    .runner-load-button,
    .runner-toggle-button {
      min-height: 39px;
      white-space: nowrap;
      font-weight: 800;
    }
    .runner-load-button {
      color: #bcd4f2;
      background: #10233b;
    }
    .runner-toggle-button.start {
      border-color: rgba(64, 216, 137, .62);
      background: linear-gradient(180deg, #1b985f, #137749);
      color: #f2fff8;
      box-shadow: 0 8px 20px rgba(27, 152, 95, .20);
    }
    .runner-toggle-button.stop {
      border-color: rgba(255, 101, 116, .62);
      background: linear-gradient(180deg, #b94351, #8e2f3b);
      color: #fff6f7;
      box-shadow: 0 8px 20px rgba(185, 67, 81, .18);
    }
    .runner-toggle-button.connected {
      border-color: rgba(64, 216, 137, .45);
      background: rgba(64, 216, 137, .12);
      color: #68e3a4;
      cursor: default;
      box-shadow: none;
    }
    .runner-toggle-button.busy { opacity: .72; cursor: wait; }
    .runner-status-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 34px;
      padding: 0 9px;
      border-radius: 999px;
      border: 1px solid #294563;
      color: #94a9c5;
      background: rgba(10, 23, 40, .80);
      font-size: 10px;
      font-weight: 850;
      letter-spacing: .4px;
      white-space: nowrap;
    }
    .runner-status-chip::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #647b99;
      box-shadow: 0 0 0 3px rgba(100, 123, 153, .10);
    }
    .runner-status-chip.online { color: #68e3a4; border-color: rgba(64, 216, 137, .40); }
    .runner-status-chip.online::before { background: #40d889; box-shadow: 0 0 8px rgba(64,216,137,.55); }
    .runner-status-chip.busy { color: #7bb8ff; border-color: rgba(77, 156, 255, .40); }
    .runner-status-chip.busy::before { background: #4d9cff; box-shadow: 0 0 8px rgba(77,156,255,.55); }
    .runner-status-chip.error { color: #ff8591; border-color: rgba(255, 101, 116, .40); }
    .runner-status-chip.error::before { background: #ff6574; }
    .runner-repo-count { color: #94a9c5; font-size: 10px; white-space: nowrap; }
  `;
  document.head.appendChild(style);
}

function installRunningStatusSpinner() {
  installMonitorEnhancementStyles();

  const apply = () => {
    document.querySelectorAll('.card.running .card-icon, .status-icon.in_progress, .step-symbol.active').forEach((node) => {
      node.classList.remove('pulse');
      if (node.querySelector('.github-actions-monitor-spinner')) return;
      node.replaceChildren(makeSpinner());
    });
  };

  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.body, { childList: true, subtree: true });
}

function elapsed(start, end = null) {
  if (!start) return '0s';
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '0s';
  const seconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
  if (minutes) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

function statusPresentation(item) {
  const key = item?.status === 'completed' ? (item?.conclusion || 'completed') : (item?.status || 'queued');
  if (key === 'success') return { key, label: 'THÀNH CÔNG', symbol: '✓', cls: 'ok' };
  if (['failure', 'timed_out', 'startup_failure'].includes(key)) return { key, label: 'THẤT BẠI', symbol: '×', cls: 'bad' };
  if (key === 'cancelled') return { key, label: 'ĐÃ HỦY', symbol: '–', cls: 'bad' };
  if (key === 'in_progress') return { key, label: 'ĐANG CHẠY', symbol: '', cls: 'active' };
  return { key, label: 'ĐANG CHỜ', symbol: '…', cls: 'queued' };
}

function installLiveStepTracking() {
  installMonitorEnhancementStyles();

  let pollTimer = null;
  let clockTimer = null;
  let busy = false;
  let lastAuthenticated = false;

  function selectedRun() {
    const row = document.querySelector('.run.selected[data-id]');
    if (!row) return null;
    const runId = Number(row.dataset.id);
    if (!Number.isSafeInteger(runId) || runId <= 0) return null;
    return {
      runId,
      active: Boolean(row.querySelector('.status-pill.in_progress'))
    };
  }

  function updateLiveClocks() {
    document.querySelectorAll('.live-step-time[data-started-at]').forEach((node) => {
      node.textContent = `⏱ ${elapsed(node.dataset.startedAt)}`;
    });
  }

  function setRefreshMode(authenticated, active) {
    const target = document.getElementById('refreshMode');
    if (!target || !active) return;
    target.textContent = authenticated
      ? 'Steps LIVE ~3s · timer 1s'
      : 'Chờ GitHub token';
  }

  function syncStepRows(card, job) {
    const rows = [...card.querySelectorAll('.step')];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const step = job.steps?.[index];
      if (!step) continue;
      const presentation = statusPresentation(step);
      row.classList.toggle('current-live-step', presentation.key === 'in_progress');

      const symbol = row.querySelector('.step-symbol');
      if (symbol) {
        symbol.className = `step-symbol ${presentation.cls}`;
        if (presentation.key === 'in_progress') symbol.replaceChildren(makeSpinner());
        else symbol.textContent = presentation.symbol;
      }

      const duration = row.querySelector('.duration');
      if (duration) {
        if (step.startedAt) duration.dataset.durationStart = step.startedAt;
        else delete duration.dataset.durationStart;
        if (step.completedAt) duration.dataset.durationEnd = step.completedAt;
        else delete duration.dataset.durationEnd;
        duration.classList.toggle('live', presentation.key === 'in_progress');
      }
    }
  }

  function syncJobCard(card, job) {
    const presentation = statusPresentation(job);
    const pill = card.querySelector('.job-state .status-pill');
    if (pill) {
      pill.className = `status-pill ${presentation.key}`;
      pill.textContent = presentation.label;
    }

    syncStepRows(card, job);

    let banner = card.querySelector('.live-step-banner');
    const activeStep = job.steps?.find((step) => step.status === 'in_progress');
    const jobRunning = job.status === 'in_progress';

    if (!jobRunning) {
      banner?.remove();
      return;
    }

    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'live-step-banner';
      const steps = card.querySelector('.steps');
      if (steps) card.insertBefore(banner, steps);
      else card.appendChild(banner);
    }

    if (activeStep) {
      banner.className = 'live-step-banner';
      const label = document.createElement('span');
      label.className = 'live-step-label';
      label.textContent = 'ĐANG CHẠY';
      const name = document.createElement('span');
      name.className = 'live-step-name';
      name.textContent = activeStep.name;
      const time = document.createElement('span');
      time.className = 'live-step-time';
      time.dataset.startedAt = activeStep.startedAt || new Date().toISOString();
      time.textContent = `⏱ ${elapsed(time.dataset.startedAt)}`;
      banner.replaceChildren(makeSpinner(), label, name, time);
    } else {
      banner.className = 'live-step-banner waiting';
      const label = document.createElement('span');
      label.className = 'live-step-label';
      label.textContent = 'ĐANG CHẠY';
      const name = document.createElement('span');
      name.className = 'live-step-name';
      name.textContent = 'Đang chuyển sang bước tiếp theo…';
      banner.replaceChildren(makeSpinner(), label, name);
    }
  }

  function applyJobs(jobs) {
    const cards = [...document.querySelectorAll('#details .job')];
    for (let index = 0; index < cards.length; index += 1) {
      const job = jobs?.[index];
      if (job) syncJobCard(cards[index], job);
    }
    updateLiveClocks();
  }

  function schedule(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }

  async function poll() {
    const selection = selectedRun();
    if (!selection) {
      schedule(1000);
      return;
    }

    if (!selection.active) {
      setRefreshMode(lastAuthenticated, false);
      schedule(2500);
      return;
    }

    const repo = String(document.getElementById('repo')?.value || '').trim();
    const token = String(document.getElementById('token')?.value || '').trim();
    if (!token) {
      lastAuthenticated = false;
      setRefreshMode(false, true);
      schedule(5000);
      return;
    }
    if (!repo || busy) {
      schedule(1000);
      return;
    }

    busy = true;
    try {
      const result = await ipcRenderer.invoke('actions:jobs', {
        repo,
        runId: selection.runId,
        token
      });
      lastAuthenticated = true;
      applyJobs(result?.jobs || []);
      setRefreshMode(true, true);
    } catch (error) {
      console.warn('[actions-monitor-live-steps]', error?.message || error);
    } finally {
      busy = false;
      schedule(lastAuthenticated ? 3000 : 5000);
    }
  }

  document.addEventListener('click', (event) => {
    if (event.target?.closest?.('.run')) schedule(120);
  }, true);
  document.getElementById('repo')?.addEventListener('change', () => schedule(120));
  document.getElementById('token')?.addEventListener('change', () => schedule(120));
  document.getElementById('refresh')?.addEventListener('click', () => schedule(500));

  const detailsObserver = new MutationObserver(() => {
    const selection = selectedRun();
    if (selection?.active) schedule(350);
  });
  const details = document.getElementById('details');
  if (details) detailsObserver.observe(details, { childList: true });

  clockTimer = setInterval(updateLiveClocks, 1000);
  schedule(600);

  window.addEventListener('beforeunload', () => {
    clearTimeout(pollTimer);
    clearInterval(clockTimer);
    detailsObserver.disconnect();
  }, { once: true });
}

function installRunnerControls() {
  installMonitorEnhancementStyles();
  const controls = document.querySelector('.controls');
  const repoInput = document.getElementById('repo');
  const tokenInput = document.getElementById('token');
  const refreshButton = document.getElementById('refresh');
  const repoWrap = repoInput?.closest('.repo-wrap');
  if (!controls || !repoInput || !tokenInput || !repoWrap || !refreshButton) return;

  tokenInput.placeholder = 'GitHub token (bắt buộc)';

  const picker = document.createElement('select');
  picker.id = 'repoPicker';
  picker.className = 'repo-picker';
  picker.setAttribute('aria-label', 'Repository');

  const count = document.createElement('span');
  count.className = 'runner-repo-count';

  const loadButton = document.createElement('button');
  loadButton.type = 'button';
  loadButton.className = 'runner-load-button';
  loadButton.textContent = '↻ Repos';
  loadButton.title = 'Load tất cả repository mà token truy cập được';

  const status = document.createElement('span');
  status.className = 'runner-status-chip';
  status.textContent = 'NHẬP TOKEN';

  const runnerButton = document.createElement('button');
  runnerButton.type = 'button';
  runnerButton.className = 'runner-toggle-button start';
  runnerButton.textContent = '▶ Start Runner';
  runnerButton.disabled = true;

  repoWrap.append(picker, count);
  repoInput.hidden = true;
  controls.insertBefore(loadButton, refreshButton);
  controls.insertBefore(status, refreshButton);
  controls.insertBefore(runnerButton, refreshButton);

  let runnerState = {
    configured: false,
    managed: false,
    external: false,
    running: false,
    online: false,
    busy: false
  };
  let statusTimer = null;
  let operationBusy = false;

  function selectedRepo() {
    return String(picker.value || repoInput.value || '').trim();
  }

  function token() {
    return String(tokenInput.value || '').trim();
  }

  function showTokenRequiredState() {
    const message = document.getElementById('message');
    const runs = document.getElementById('runsList');
    const details = document.getElementById('details');
    const mode = document.getElementById('refreshMode');
    if (message) {
      message.className = 'small';
      message.textContent = 'Nhập GitHub token để tải dữ liệu';
    }
    if (runs) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nhập GitHub token, sau đó bấm Repos để bắt đầu.';
      runs.replaceChildren(empty);
    }
    if (details) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Chờ GitHub token.';
      details.replaceChildren(empty);
    }
    if (mode) mode.textContent = 'Chờ token';
    const apiCount = document.getElementById('apiCount');
    if (apiCount) apiCount.textContent = '—';
  }

  function setPickerValue(repo) {
    if (!repo) return;
    repoInput.value = repo;
    const existing = [...picker.options].find((option) => option.value === repo);
    if (!existing) {
      const option = document.createElement('option');
      option.value = repo;
      option.textContent = repo;
      picker.append(option);
    }
    picker.value = repo;
    repoInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function populateRepos(repos) {
    const current = selectedRepo() || repoInput.value;
    picker.replaceChildren();
    for (const repo of repos) {
      const option = document.createElement('option');
      option.value = repo.fullName;
      const access = repo.admin ? '' : ' · no admin';
      option.textContent = `${repo.private ? '🔒 ' : ''}${repo.fullName}${access}`;
      option.disabled = Boolean(repo.archived || repo.disabled);
      option.dataset.admin = repo.admin ? '1' : '0';
      picker.append(option);
    }
    count.textContent = repos.length ? `${repos.length} repos` : '';
    const preferred = repos.find((repo) => repo.fullName === current)?.fullName || repos[0]?.fullName || current;
    if (preferred) setPickerValue(preferred);
  }

  function renderRunnerState(next) {
    runnerState = { ...runnerState, ...next };
    status.className = 'runner-status-chip';

    if (!token()) {
      status.textContent = 'NHẬP TOKEN';
      status.title = 'Cần token để kiểm tra runner đã đăng ký trên GitHub.';
      runnerButton.className = 'runner-toggle-button start';
      runnerButton.textContent = '▶ Start Runner';
      runnerButton.disabled = true;
      runnerButton.title = 'Nhập token trước để kiểm tra trạng thái runner.';
      return;
    }

    if (runnerState.busy) {
      status.classList.add('busy');
      status.textContent = 'RUNNER BUSY';
    } else if (runnerState.online || runnerState.running) {
      status.classList.add('online');
      status.textContent = runnerState.external ? 'RUNNER CONNECTED' : 'RUNNER ONLINE';
    } else if (runnerState.error) {
      status.classList.add('error');
      status.textContent = 'RUNNER ERROR';
    } else {
      status.textContent = runnerState.configured ? 'RUNNER OFFLINE' : 'NO RUNNER';
    }

    const running = Boolean(runnerState.online || runnerState.running);
    const externalRunning = Boolean(runnerState.external && running);

    if (externalRunning) {
      runnerButton.className = 'runner-toggle-button connected';
      runnerButton.textContent = '✓ Đã kết nối';
      runnerButton.disabled = true;
    } else {
      runnerButton.className = `runner-toggle-button ${running ? 'stop' : 'start'}${operationBusy ? ' busy' : ''}`;
      runnerButton.textContent = operationBusy
        ? (running ? 'Stopping…' : 'Starting…')
        : (running ? '■ Stop Runner' : '▶ Start Runner');
      runnerButton.disabled = operationBusy || !selectedRepo();
    }

    const source = runnerState.external ? 'runner có sẵn trên repo' : 'runner do app quản lý';
    runnerButton.title = runnerState.runnerName ? `Runner: ${runnerState.runnerName} · ${source}` : '';
    status.title = runnerState.runnerName ? `Runner: ${runnerState.runnerName}` : '';
  }

  async function refreshRunnerStatus() {
    const repo = selectedRepo();
    if (!repo) return;
    if (!token()) {
      renderRunnerState({
        configured: false,
        managed: false,
        external: false,
        requiresToken: true,
        running: false,
        online: false,
        busy: false,
        error: ''
      });
      return;
    }
    try {
      const result = await ipcRenderer.invoke('runner:status', { repo, token: token() });
      renderRunnerState({ ...result, error: result.remoteError || '' });
    } catch (error) {
      renderRunnerState({
        configured: false,
        managed: false,
        external: false,
        running: false,
        online: false,
        busy: false,
        error: error?.message || String(error)
      });
    }
  }

  async function loadRepos() {
    if (!token()) {
      status.className = 'runner-status-chip error';
      status.textContent = 'NHẬP TOKEN';
      showTokenRequiredState();
      tokenInput.focus();
      return;
    }
    loadButton.disabled = true;
    const previous = loadButton.textContent;
    loadButton.textContent = 'Loading…';
    try {
      const result = await ipcRenderer.invoke('actions:repos', { token: token() });
      populateRepos(result.repos || []);
      await refreshRunnerStatus();
      refreshButton.click();
    } catch (error) {
      status.className = 'runner-status-chip error';
      status.textContent = 'REPO ERROR';
      status.title = error?.message || String(error);
    } finally {
      loadButton.disabled = false;
      loadButton.textContent = previous;
    }
  }

  async function toggleRunner() {
    const repo = selectedRepo();
    const authToken = token();
    if (!repo || !authToken || operationBusy) return;
    if (runnerState.external && (runnerState.online || runnerState.running)) return;

    operationBusy = true;
    renderRunnerState({});
    try {
      if (runnerState.online || runnerState.running) {
        await ipcRenderer.invoke('runner:stop', { repo, token: authToken });
        renderRunnerState({
          configured: true,
          managed: true,
          external: false,
          running: false,
          online: false,
          busy: false,
          error: ''
        });
      } else {
        status.className = 'runner-status-chip busy';
        status.textContent = 'STARTING';
        const result = await ipcRenderer.invoke('runner:start', { repo, token: authToken });
        renderRunnerState({
          configured: true,
          managed: result.managed !== false,
          external: Boolean(result.external),
          running: true,
          online: Boolean(result.online),
          busy: Boolean(result.busy),
          runnerName: result.runnerName,
          error: ''
        });
      }
    } catch (error) {
      renderRunnerState({
        configured: false,
        managed: false,
        external: false,
        running: false,
        online: false,
        busy: false,
        error: error?.message || String(error)
      });
      status.title = error?.message || String(error);
    } finally {
      operationBusy = false;
      renderRunnerState({});
      setTimeout(refreshRunnerStatus, 1500);
    }
  }

  picker.addEventListener('change', () => {
    setPickerValue(picker.value);
    renderRunnerState({
      configured: false,
      managed: false,
      external: false,
      running: false,
      online: false,
      busy: false,
      error: ''
    });
    refreshRunnerStatus();
    if (token()) refreshButton.click();
  });
  loadButton.addEventListener('click', loadRepos);
  runnerButton.addEventListener('click', toggleRunner);
  refreshButton.addEventListener('click', (event) => {
    if (token()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    status.className = 'runner-status-chip error';
    status.textContent = 'NHẬP TOKEN';
    showTokenRequiredState();
    tokenInput.focus();
  }, true);
  tokenInput.addEventListener('input', () => {
    renderRunnerState({});
    if (!token()) showTokenRequiredState();
  });
  tokenInput.addEventListener('change', () => {
    if (token()) loadRepos();
    else showTokenRequiredState();
  });
  tokenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      loadRepos();
    }
  });

  setPickerValue(repoInput.value);
  renderRunnerState({
    configured: false,
    managed: false,
    external: false,
    running: false,
    online: false,
    busy: false,
    error: ''
  });
  if (!token()) showTokenRequiredState();
  statusTimer = setInterval(refreshRunnerStatus, 10000);
  window.addEventListener('beforeunload', () => clearInterval(statusTimer), { once: true });
}

window.addEventListener('DOMContentLoaded', () => {
  installRunningStatusSpinner();
  installLiveStepTracking();
  installRunnerControls();
}, { once: true });