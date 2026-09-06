const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('actionsMonitor', {
  listRuns: (input) => ipcRenderer.invoke('actions:list', input),
  listJobs: (input) => ipcRenderer.invoke('actions:jobs', input),
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
      : 'Steps 60s · thêm token để LIVE ~3s';
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
      lastAuthenticated = Boolean(token || result?.authenticated);
      applyJobs(result?.jobs || []);
      setRefreshMode(lastAuthenticated, true);
    } catch (error) {
      console.warn('[actions-monitor-live-steps]', error?.message || error);
    } finally {
      busy = false;
      schedule(lastAuthenticated ? 3000 : 60000);
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

window.addEventListener('DOMContentLoaded', () => {
  installRunningStatusSpinner();
  installLiveStepTracking();
}, { once: true });
