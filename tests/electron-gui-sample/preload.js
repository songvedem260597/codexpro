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

function makeSpinner() {
  const spinner = document.createElement('span');
  spinner.className = 'github-actions-monitor-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  return spinner;
}

function installStyles() {
  if (document.getElementById('github-actions-monitor-preload-style')) return;
  const style = document.createElement('style');
  style.id = 'github-actions-monitor-preload-style';
  style.textContent = `
    @keyframes github-actions-monitor-spin { to { transform: rotate(360deg); } }
    .github-actions-monitor-spinner {
      width: 15px; height: 15px; display: inline-block; flex: 0 0 auto;
      box-sizing: border-box; border: 2px solid rgba(77,156,255,.28);
      border-top-color: currentColor; border-radius: 50%;
      animation: github-actions-monitor-spin .8s linear infinite;
    }
    .card.running .github-actions-monitor-spinner { width: 18px; height: 18px; border-width: 2.4px; }
    .step-symbol.active .github-actions-monitor-spinner { width: 11px; height: 11px; border-width: 1.7px; }
    .step.current-live-step {
      background: linear-gradient(90deg, rgba(77,156,255,.16), rgba(77,156,255,.035));
      box-shadow: inset 3px 0 0 #4d9cff; color: #eef6ff; font-weight: 720;
    }
    .live-step-banner {
      margin: 0 12px 10px; padding: 9px 11px; border: 1px solid rgba(77,156,255,.44);
      border-radius: 10px; background: linear-gradient(90deg,rgba(77,156,255,.14),rgba(77,156,255,.05));
      color: #d9eaff; display: flex; align-items: center; gap: 9px; font-size: 12px;
      box-shadow: inset 3px 0 0 #4d9cff;
    }
    .live-step-label { color: #7bb8ff; font-size: 10px; font-weight: 900; letter-spacing: .65px; white-space: nowrap; }
    .live-step-name { min-width: 0; flex: 1; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .live-step-time { color: #7bb8ff; font-weight: 850; font-variant-numeric: tabular-nums; white-space: nowrap; }

    .repo-wrap #repo, #repoPicker { display: none !important; }
    .controls { align-items: center; gap: 8px !important; }
    .controls #refresh, .controls .runner-load-button, .controls .runner-toggle-button {
      width: 118px !important; min-width: 118px !important; height: 42px !important; min-height: 42px !important;
      padding: 0 12px !important; box-sizing: border-box; border-radius: 10px !important;
      display: inline-flex !important; align-items: center; justify-content: center;
      line-height: 1; font-size: 12px; font-weight: 850; white-space: nowrap;
    }
    .controls #token { height: 42px; min-height: 42px; box-sizing: border-box; border-radius: 10px; }
    .runner-load-button { color: #bcd4f2; background: #10233b; }
    .runner-toggle-button.start {
      border-color: rgba(64,216,137,.62); background: linear-gradient(180deg,#1b985f,#137749);
      color: #f2fff8; box-shadow: 0 8px 20px rgba(27,152,95,.20);
    }
    .runner-toggle-button.stop {
      border-color: rgba(255,101,116,.62); background: linear-gradient(180deg,#b94351,#8e2f3b);
      color: #fff6f7; box-shadow: 0 8px 20px rgba(185,67,81,.18);
    }
    .runner-toggle-button.connected {
      border-color: rgba(64,216,137,.45); background: rgba(64,216,137,.12); color: #68e3a4;
      cursor: default; box-shadow: none;
    }
    .runner-toggle-button.busy { opacity: .72; cursor: wait; }
    .runner-toggle-button:disabled { opacity: .54; cursor: not-allowed; filter: saturate(.55); box-shadow: none; }
    .runner-status-chip {
      height: 42px; min-height: 42px; display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box;
      padding: 0 12px; border-radius: 999px; border: 1px solid #294563; color: #94a9c5;
      background: rgba(10,23,40,.80); font-size: 10px; font-weight: 850; letter-spacing: .4px; white-space: nowrap;
    }
    .runner-status-chip::before {
      content: ''; width: 7px; height: 7px; border-radius: 50%; background: #647b99;
      box-shadow: 0 0 0 3px rgba(100,123,153,.10);
    }
    .runner-status-chip.online { color: #68e3a4; border-color: rgba(64,216,137,.40); }
    .runner-status-chip.online::before { background: #40d889; box-shadow: 0 0 8px rgba(64,216,137,.55); }
    .runner-status-chip.busy { color: #7bb8ff; border-color: rgba(77,156,255,.40); }
    .runner-status-chip.busy::before { background: #4d9cff; box-shadow: 0 0 8px rgba(77,156,255,.55); }
    .runner-status-chip.error { color: #ff8591; border-color: rgba(255,101,116,.40); }
    .runner-status-chip.error::before { background: #ff6574; }
    .runner-repo-count { display: none !important; }

    .repo-wrap { position: relative; overflow: visible !important; }
    .repo-custom-dropdown { position: relative; width: 278px; min-width: 278px; height: 42px; z-index: 40; }
    .repo-dropdown-trigger {
      width: 100%; height: 42px; padding: 0 12px; border: 1px solid #2e5c8c; border-radius: 11px;
      background: linear-gradient(180deg,#0f2742 0%,#0b1e34 100%); color: #eef6ff;
      display: flex; align-items: center; gap: 9px; box-sizing: border-box; cursor: pointer; font: inherit;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.035),0 5px 16px rgba(0,0,0,.14);
    }
    .repo-dropdown-trigger:hover, .repo-custom-dropdown.open .repo-dropdown-trigger {
      border-color: #4d9cff; background: linear-gradient(180deg,#123052,#0d2541);
      box-shadow: 0 0 0 3px rgba(77,156,255,.10);
    }
    .repo-dropdown-icon {
      width: 20px; height: 20px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center;
      flex: 0 0 auto; color: #7bb8ff; background: rgba(77,156,255,.12); border: 1px solid rgba(77,156,255,.24);
      font-size: 11px; font-weight: 900;
    }
    .repo-dropdown-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; font-size: 12px; font-weight: 760; }
    .repo-dropdown-chevron { color: #88a6c8; font-size: 10px; transition: transform .16s ease; }
    .repo-custom-dropdown.open .repo-dropdown-chevron { transform: rotate(180deg); }
    .repo-dropdown-menu {
      position: absolute; top: calc(100% + 7px); left: 0; width: 100%; max-height: 340px; display: none; overflow: hidden;
      border: 1px solid #294c72; border-radius: 12px; background: #0a1829;
      box-shadow: 0 18px 42px rgba(0,0,0,.46),inset 0 1px 0 rgba(255,255,255,.035); z-index: 9999;
    }
    .repo-custom-dropdown.open .repo-dropdown-menu { display: block; }
    .repo-dropdown-search-wrap { padding: 8px; border-bottom: 1px solid #1e3651; background: #0b1b2e; }
    .repo-dropdown-search {
      width: 100%; height: 34px; padding: 0 10px; border: 1px solid #294c72; border-radius: 8px; outline: none;
      box-sizing: border-box; background: #071421; color: #eef6ff; font: inherit; font-size: 12px;
    }
    .repo-dropdown-search:focus { border-color: #4d9cff; box-shadow: 0 0 0 3px rgba(77,156,255,.10); }
    .repo-dropdown-list { max-height: 286px; overflow: auto; padding: 6px; scrollbar-width: thin; scrollbar-color: #31577f transparent; }
    .repo-dropdown-item {
      width: 100%; min-height: 38px; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent;
      color: #cbd9ea; display: flex; align-items: center; gap: 8px; cursor: pointer; text-align: left; font: inherit; font-size: 12px;
    }
    .repo-dropdown-item:hover { background: rgba(77,156,255,.10); color: #fff; }
    .repo-dropdown-item.selected { background: rgba(77,156,255,.16); color: #fff; box-shadow: inset 2px 0 0 #4d9cff; }
    .repo-dropdown-item:disabled { opacity: .45; cursor: not-allowed; }
    .repo-dropdown-item-mark { width: 16px; flex: 0 0 16px; color: #70b1ff; font-weight: 900; }
    .repo-dropdown-item-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    @media (max-width:1180px) {
      .repo-custom-dropdown { width:245px; min-width:245px; }
      .controls #refresh, .controls .runner-load-button, .controls .runner-toggle-button { width:108px !important; min-width:108px !important; }
    }
  `;
  document.head.appendChild(style);
}

function installRunningSpinners() {
  const apply = () => {
    document.querySelectorAll('.card.running .card-icon, .status-icon.in_progress, .step-symbol.active').forEach((node) => {
      node.classList.remove('pulse');
      if (!node.querySelector('.github-actions-monitor-spinner')) node.replaceChildren(makeSpinner());
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
  if (hours) return `${hours}h ${String(minutes).padStart(2,'0')}m ${String(secs).padStart(2,'0')}s`;
  if (minutes) return `${minutes}m ${String(secs).padStart(2,'0')}s`;
  return `${secs}s`;
}

function installLiveSteps() {
  let pollTimer = null;
  let clockTimer = null;
  let busy = false;

  function selectedRun() {
    const row = document.querySelector('.run.selected[data-id]');
    if (!row) return null;
    const runId = Number(row.dataset.id);
    return Number.isSafeInteger(runId) && runId > 0
      ? { runId, active: Boolean(row.querySelector('.status-pill.in_progress')) }
      : null;
  }

  function updateClocks() {
    document.querySelectorAll('.live-step-time[data-started-at]').forEach((node) => {
      node.textContent = `⏱ ${elapsed(node.dataset.startedAt)}`;
    });
  }

  function applyJobs(jobs) {
    const cards = [...document.querySelectorAll('#details .job')];
    cards.forEach((card, index) => {
      const job = jobs?.[index];
      if (!job) return;
      const rows = [...card.querySelectorAll('.step')];
      rows.forEach((row, stepIndex) => {
        const step = job.steps?.[stepIndex];
        if (!step) return;
        const active = step.status === 'in_progress';
        row.classList.toggle('current-live-step', active);
        const symbol = row.querySelector('.step-symbol');
        if (symbol) {
          if (active) {
            symbol.className = 'step-symbol active';
            symbol.replaceChildren(makeSpinner());
          } else if (step.conclusion === 'success') {
            symbol.className = 'step-symbol ok';
            symbol.textContent = '✓';
          } else if (step.conclusion) {
            symbol.className = 'step-symbol bad';
            symbol.textContent = '×';
          }
        }
        const duration = row.querySelector('.duration');
        if (duration) {
          if (step.startedAt) duration.dataset.durationStart = step.startedAt;
          if (step.completedAt) duration.dataset.durationEnd = step.completedAt;
          else delete duration.dataset.durationEnd;
          duration.classList.toggle('live', active);
        }
      });

      let banner = card.querySelector('.live-step-banner');
      const activeStep = job.steps?.find((step) => step.status === 'in_progress');
      if (job.status !== 'in_progress') {
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
      const label = document.createElement('span');
      label.className = 'live-step-label';
      label.textContent = 'ĐANG CHẠY';
      const name = document.createElement('span');
      name.className = 'live-step-name';
      name.textContent = activeStep?.name || 'Đang chuyển sang bước tiếp theo…';
      const children = [makeSpinner(), label, name];
      if (activeStep?.startedAt) {
        const time = document.createElement('span');
        time.className = 'live-step-time';
        time.dataset.startedAt = activeStep.startedAt;
        time.textContent = `⏱ ${elapsed(activeStep.startedAt)}`;
        children.push(time);
      }
      banner.replaceChildren(...children);
    });
    updateClocks();
  }

  async function poll() {
    const selected = selectedRun();
    const repo = String(document.getElementById('repo')?.value || '').trim();
    const token = String(document.getElementById('token')?.value || '').trim();
    if (selected?.active && repo && token && !busy) {
      busy = true;
      try {
        const result = await ipcRenderer.invoke('actions:jobs', { repo, runId: selected.runId, token });
        applyJobs(result?.jobs || []);
        const mode = document.getElementById('refreshMode');
        if (mode) mode.textContent = 'Steps LIVE ~3s · timer 1s';
      } catch (error) {
        console.warn('[actions-monitor-live-steps]', error?.message || error);
      } finally {
        busy = false;
      }
    }
    pollTimer = setTimeout(poll, selected?.active && token ? 3000 : 2500);
  }

  clockTimer = setInterval(updateClocks, 1000);
  pollTimer = setTimeout(poll, 700);
  window.addEventListener('beforeunload', () => {
    clearTimeout(pollTimer);
    clearInterval(clockTimer);
  }, { once: true });
}

function installRunnerControls() {
  const controls = document.querySelector('.controls');
  const repoInput = document.getElementById('repo');
  const tokenInput = document.getElementById('token');
  const refreshButton = document.getElementById('refresh');
  const repoWrap = repoInput?.closest('.repo-wrap');
  if (!controls || !repoInput || !tokenInput || !refreshButton || !repoWrap) return;

  tokenInput.placeholder = 'GitHub token (cho API/runner mới)';

  const picker = document.createElement('select');
  picker.id = 'repoPicker';
  picker.setAttribute('aria-label', 'Repository');

  const count = document.createElement('span');
  count.className = 'runner-repo-count';

  const loadButton = document.createElement('button');
  loadButton.type = 'button';
  loadButton.className = 'runner-load-button';
  loadButton.textContent = '↻ Repos';
  loadButton.title = 'Cần GitHub token để tải danh sách repository';

  const status = document.createElement('span');
  status.className = 'runner-status-chip';
  status.textContent = 'CHECKING';

  const runnerButton = document.createElement('button');
  runnerButton.type = 'button';
  runnerButton.className = 'runner-toggle-button start';
  runnerButton.textContent = '▶ Start Runner';
  runnerButton.disabled = true;

  repoWrap.append(picker, count);
  controls.insertBefore(loadButton, refreshButton);
  controls.insertBefore(status, refreshButton);
  controls.insertBefore(runnerButton, refreshButton);

  let runnerState = {
    configured: false,
    managed: false,
    external: false,
    local: false,
    running: false,
    online: false,
    busy: false,
    requiresToken: false
  };
  let operationBusy = false;
  let timer = null;

  const token = () => String(tokenInput.value || '').trim();
  const selectedRepo = () => String(picker.value || repoInput.value || '').trim();

  function setPickerValue(repo) {
    if (!repo) return;
    repoInput.value = repo;
    let option = [...picker.options].find((item) => item.value === repo);
    if (!option) {
      option = document.createElement('option');
      option.value = repo;
      option.textContent = repo;
      picker.append(option);
    }
    picker.value = repo;
    repoInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function populateRepos(repos) {
    const current = selectedRepo();
    picker.replaceChildren();
    for (const repo of repos) {
      const option = document.createElement('option');
      option.value = repo.fullName;
      option.textContent = `${repo.private ? '🔒 ' : ''}${repo.fullName}${repo.admin ? '' : ' · no admin'}`;
      option.disabled = Boolean(repo.archived || repo.disabled);
      picker.append(option);
    }
    const preferred = repos.find((repo) => repo.fullName === current)?.fullName || repos[0]?.fullName || current;
    if (preferred) setPickerValue(preferred);
  }

  function renderRunnerState(next = {}) {
    runnerState = { ...runnerState, ...next };
    status.className = 'runner-status-chip';

    const running = Boolean(runnerState.online || runnerState.running);
    if (runnerState.busy && running) {
      status.classList.add('busy');
      status.textContent = 'RUNNER BUSY';
    } else if (running) {
      status.classList.add('online');
      status.textContent = 'RUNNER IDLE';
    } else if (runnerState.error) {
      status.classList.add('error');
      status.textContent = 'RUNNER ERROR';
    } else if (runnerState.configured) {
      status.textContent = 'RUNNER OFFLINE';
    } else if (!token() && runnerState.requiresToken) {
      status.textContent = 'NHẬP TOKEN';
    } else if (!token()) {
      status.textContent = 'NO LOCAL RUNNER';
    } else {
      status.textContent = 'NO RUNNER';
    }

    const externalRunning = Boolean(runnerState.external && running);
    if (externalRunning) {
      runnerButton.className = 'runner-toggle-button connected';
      runnerButton.textContent = '✓ Connected';
      runnerButton.disabled = true;
    } else if (running) {
      runnerButton.className = `runner-toggle-button stop${operationBusy ? ' busy' : ''}`;
      runnerButton.textContent = operationBusy ? 'Stopping…' : '■ Stop Runner';
      runnerButton.disabled = operationBusy;
    } else {
      const canStartLocal = Boolean(runnerState.local && runnerState.configured);
      const canCreate = Boolean(token());
      runnerButton.className = `runner-toggle-button start${operationBusy ? ' busy' : ''}`;
      runnerButton.textContent = operationBusy ? 'Starting…' : '▶ Start Runner';
      runnerButton.disabled = operationBusy || !selectedRepo() || (!canStartLocal && !canCreate);
      runnerButton.title = !canStartLocal && !canCreate
        ? 'Nhập GitHub token để tạo runner mới.'
        : (canStartLocal ? 'Runner đã cấu hình trên máy; có thể start không cần token.' : 'Tạo và start runner cho repository này.');
    }

    const parts = [];
    if (runnerState.runnerName) parts.push(`Runner: ${runnerState.runnerName}`);
    if (runnerState.root) parts.push(`Local: ${runnerState.root}`);
    if (runnerState.local) parts.push('Đã phát hiện runner local');
    status.title = parts.join(' · ');
  }

  async function refreshRunnerStatus() {
    const repo = selectedRepo();
    if (!repo) return;
    try {
      const result = await ipcRenderer.invoke('runner:status', { repo, token: token() });
      renderRunnerState({ ...result, error: result.remoteError || '' });
    } catch (error) {
      renderRunnerState({
        configured: false,
        managed: false,
        external: false,
        local: false,
        running: false,
        online: false,
        busy: false,
        error: error?.message || String(error)
      });
    }
  }

  async function loadRepos() {
    if (!token()) {
      if (!(runnerState.online || runnerState.running)) {
        status.className = 'runner-status-chip error';
        status.textContent = 'NHẬP TOKEN';
      }
      tokenInput.focus();
      return;
    }
    loadButton.disabled = true;
    const oldText = loadButton.textContent;
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
      loadButton.textContent = oldText;
    }
  }

  async function toggleRunner() {
    const repo = selectedRepo();
    if (!repo || operationBusy) return;
    const running = Boolean(runnerState.online || runnerState.running);
    if (runnerState.external && running) return;

    const canStartLocal = Boolean(runnerState.local && runnerState.configured);
    if (!running && !token() && !canStartLocal) {
      tokenInput.focus();
      return;
    }

    operationBusy = true;
    renderRunnerState();
    try {
      if (running) {
        await ipcRenderer.invoke('runner:stop', { repo, token: token() });
        renderRunnerState({
          configured: true,
          managed: true,
          external: false,
          local: true,
          running: false,
          online: false,
          busy: false,
          error: ''
        });
      } else {
        status.className = 'runner-status-chip busy';
        status.textContent = 'STARTING';
        const result = await ipcRenderer.invoke('runner:start', { repo, token: token() });
        renderRunnerState({
          configured: true,
          managed: result.managed !== false,
          external: Boolean(result.external),
          local: Boolean(result.local),
          running: true,
          online: result.online !== false,
          busy: Boolean(result.busy),
          runnerName: result.runnerName,
          root: result.root || runnerState.root,
          error: ''
        });
      }
    } catch (error) {
      renderRunnerState({ error: error?.message || String(error) });
    } finally {
      operationBusy = false;
      renderRunnerState();
      setTimeout(refreshRunnerStatus, 1200);
    }
  }

  picker.addEventListener('change', () => {
    setPickerValue(picker.value);
    renderRunnerState({
      configured: false,
      managed: false,
      external: false,
      local: false,
      running: false,
      online: false,
      busy: false,
      requiresToken: false,
      error: ''
    });
    refreshRunnerStatus();
    if (token()) refreshButton.click();
  });
  loadButton.addEventListener('click', loadRepos);
  runnerButton.addEventListener('click', toggleRunner);
  tokenInput.addEventListener('input', () => {
    if (!token()) refreshRunnerStatus();
  });
  tokenInput.addEventListener('change', () => {
    if (token()) loadRepos();
    else refreshRunnerStatus();
  });
  tokenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (token()) loadRepos();
      else refreshRunnerStatus();
    }
  });

  setPickerValue(repoInput.value);
  renderRunnerState();
  setTimeout(refreshRunnerStatus, 120);
  timer = setInterval(refreshRunnerStatus, 5000);
  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
}

function installCustomDropdown() {
  const picker = document.getElementById('repoPicker');
  const repoWrap = picker?.parentElement;
  if (!picker || !repoWrap || document.getElementById('repoCustomDropdown')) return;

  const custom = document.createElement('div');
  custom.id = 'repoCustomDropdown';
  custom.className = 'repo-custom-dropdown';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'repo-dropdown-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const icon = document.createElement('span');
  icon.className = 'repo-dropdown-icon';
  icon.textContent = '◎';
  const label = document.createElement('span');
  label.className = 'repo-dropdown-label';
  label.textContent = 'Chọn repository';
  const chevron = document.createElement('span');
  chevron.className = 'repo-dropdown-chevron';
  chevron.textContent = '▼';
  trigger.append(icon, label, chevron);

  const menu = document.createElement('div');
  menu.className = 'repo-dropdown-menu';
  const searchWrap = document.createElement('div');
  searchWrap.className = 'repo-dropdown-search-wrap';
  const search = document.createElement('input');
  search.className = 'repo-dropdown-search';
  search.type = 'text';
  search.placeholder = 'Tìm repository…';
  search.autocomplete = 'off';
  searchWrap.append(search);
  const list = document.createElement('div');
  list.className = 'repo-dropdown-list';
  list.setAttribute('role', 'listbox');
  menu.append(searchWrap, list);
  custom.append(trigger, menu);
  repoWrap.append(custom);

  function syncLabel() {
    const option = picker.selectedOptions?.[0];
    label.textContent = option?.textContent?.trim() || picker.value || 'Chọn repository';
  }

  function rebuild() {
    const query = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const option of [...picker.options]) {
      const value = option.textContent?.trim() || option.value;
      if (query && !value.toLowerCase().includes(query)) continue;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `repo-dropdown-item${option.value === picker.value ? ' selected' : ''}`;
      item.disabled = option.disabled;
      const mark = document.createElement('span');
      mark.className = 'repo-dropdown-item-mark';
      mark.textContent = option.value === picker.value ? '✓' : '○';
      const name = document.createElement('span');
      name.className = 'repo-dropdown-item-name';
      name.textContent = value;
      item.append(mark, name);
      item.addEventListener('click', () => {
        picker.value = option.value;
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        custom.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        search.value = '';
        rebuild();
      });
      list.append(item);
    }
    if (!list.childElementCount) {
      const empty = document.createElement('div');
      empty.style.padding = '14px 12px';
      empty.style.color = '#8098b5';
      empty.style.fontSize = '12px';
      empty.textContent = 'Không tìm thấy repository';
      list.append(empty);
    }
    syncLabel();
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = !custom.classList.contains('open');
    custom.classList.toggle('open', open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) requestAnimationFrame(() => search.focus());
  });
  menu.addEventListener('click', (event) => event.stopPropagation());
  search.addEventListener('input', rebuild);
  picker.addEventListener('change', rebuild);
  new MutationObserver(rebuild).observe(picker, { childList: true, subtree: true, attributes: true });
  document.addEventListener('click', () => {
    custom.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      custom.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    }
  });
  rebuild();
}

window.addEventListener('DOMContentLoaded', () => {
  installStyles();
  installRunningSpinners();
  installLiveSteps();
  installRunnerControls();
  installCustomDropdown();
}, { once: true });
