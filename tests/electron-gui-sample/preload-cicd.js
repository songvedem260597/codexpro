const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cicdMonitor', {
  listWorkflows: (input) => ipcRenderer.invoke('cicd:workflows', input),
  dispatchWorkflow: (input) => ipcRenderer.invoke('cicd:dispatch', input),
  cancelRun: (input) => ipcRenderer.invoke('cicd:cancel', input),
  rerunRun: (input) => ipcRenderer.invoke('cicd:rerun', input),
  listArtifacts: (input) => ipcRenderer.invoke('cicd:artifacts', input),
  downloadArtifact: (input) => ipcRenderer.invoke('cicd:download-artifact', input),
  listDeployments: (input) => ipcRenderer.invoke('cicd:deployments', input)
});

function installCicdUi() {
  if (window.__githubActionsMonitorCicdUi) return;
  window.__githubActionsMonitorCicdUi = true;

  const appRoot = document.querySelector('.app');
  const summary = document.querySelector('.summary');
  if (!appRoot || !summary || !window.cicdMonitor) return;

  const style = document.createElement('style');
  style.id = 'github-actions-monitor-cicd-style';
  style.textContent = `
    .app:has(.cicd-bar):has(.runner-console-panel:not(.collapsed)) {
      grid-template-rows: auto auto auto minmax(0,1fr) 210px !important;
    }
    .app:has(.cicd-bar):has(.runner-console-panel.collapsed) {
      grid-template-rows: auto auto auto minmax(0,1fr) 42px !important;
    }
    .app:has(.cicd-bar):not(:has(.runner-console-panel)) {
      grid-template-rows: auto auto auto minmax(0,1fr) !important;
    }
    .cicd-bar {
      min-height: 54px;
      padding: 7px 15px;
      border-bottom: 1px solid rgba(46,70,98,.72);
      background: linear-gradient(180deg, rgba(9,22,38,.98), rgba(7,17,31,.98));
      display: flex;
      align-items: center;
      gap: 8px;
      box-sizing: border-box;
      overflow-x: auto;
      scrollbar-width: thin;
    }
    .cicd-title {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      margin-right: 4px;
      color: #d9e8fa;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: .65px;
      white-space: nowrap;
    }
    .cicd-title::before {
      content: 'CI/CD';
      border: 1px solid rgba(127,106,255,.42);
      color: #b8aaff;
      background: rgba(127,106,255,.10);
      border-radius: 999px;
      padding: 4px 8px;
    }
    .cicd-button {
      height: 36px;
      min-width: 108px;
      padding: 0 12px;
      border: 1px solid #2b4b6d;
      border-radius: 9px;
      background: #10233b;
      color: #cfe0f5;
      font: inherit;
      font-size: 11px;
      font-weight: 820;
      cursor: pointer;
      white-space: nowrap;
      transition: .14s ease;
    }
    .cicd-button:hover:not(:disabled) {
      border-color: #4d9cff;
      background: #153052;
      color: #fff;
      transform: translateY(-1px);
    }
    .cicd-button.primary {
      border-color: rgba(64,216,137,.52);
      background: linear-gradient(180deg,#198a58,#126d45);
      color: #effff7;
    }
    .cicd-button.danger {
      border-color: rgba(255,101,116,.45);
      color: #ff9da7;
      background: rgba(132,42,54,.28);
    }
    .cicd-button:disabled { opacity: .42; cursor: not-allowed; transform: none; }
    .cicd-status {
      margin-left: auto;
      color: #7891af;
      font-size: 10px;
      white-space: nowrap;
      max-width: 280px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cicd-status.ok { color: #68e3a4; }
    .cicd-status.error { color: #ff8591; }
    .cicd-overlay {
      position: fixed;
      inset: 0;
      z-index: 20000;
      background: rgba(1,7,14,.70);
      backdrop-filter: blur(7px);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .cicd-modal {
      width: min(650px, 94vw);
      max-height: min(76vh, 720px);
      overflow: hidden;
      border: 1px solid #31577f;
      border-radius: 14px;
      background: linear-gradient(155deg,#0d2036,#091727);
      box-shadow: 0 24px 70px rgba(0,0,0,.58);
      color: #e7f0fc;
      display: flex;
      flex-direction: column;
    }
    .cicd-modal-head {
      min-height: 50px;
      padding: 0 15px;
      border-bottom: 1px solid #213c5a;
      display: flex;
      align-items: center;
      gap: 10px;
      background: #0b1c30;
    }
    .cicd-modal-head strong { font-size: 14px; }
    .cicd-modal-close {
      margin-left: auto;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      border: 1px solid #2b4b6d;
      background: #10233b;
      color: #9fb4cd;
      cursor: pointer;
      font-size: 16px;
    }
    .cicd-modal-body { padding: 15px; overflow: auto; min-height: 120px; }
    .cicd-field { display: grid; gap: 6px; margin-bottom: 12px; }
    .cicd-field label { color: #91a9c7; font-size: 11px; font-weight: 750; }
    .cicd-field input, .cicd-field select, .cicd-field textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #2b4d73;
      border-radius: 9px;
      background: #071522;
      color: #eef6ff;
      padding: 0 10px;
      outline: none;
      font: inherit;
      font-size: 12px;
    }
    .cicd-field input, .cicd-field select { height: 38px; }
    .cicd-field textarea { min-height: 90px; padding: 9px 10px; resize: vertical; font-family: Consolas, monospace; }
    .cicd-field input:focus, .cicd-field select:focus, .cicd-field textarea:focus {
      border-color: #4d9cff;
      box-shadow: 0 0 0 3px rgba(77,156,255,.10);
    }
    .cicd-modal-actions {
      padding: 12px 15px;
      border-top: 1px solid #213c5a;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      background: #0a192a;
    }
    .cicd-list { display: grid; gap: 8px; }
    .cicd-row {
      border: 1px solid #294867;
      border-radius: 10px;
      padding: 10px 11px;
      background: rgba(14,31,52,.85);
      display: grid;
      grid-template-columns: minmax(0,1fr) auto;
      gap: 12px;
      align-items: center;
    }
    .cicd-row-name { font-size: 12px; font-weight: 780; color: #e7f1ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cicd-row-meta { margin-top: 5px; color: #829bb8; font-size: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
    .cicd-badge { border: 1px solid #315171; border-radius: 999px; padding: 2px 7px; color: #aec4dd; }
    .cicd-badge.success { color: #68e3a4; border-color: rgba(64,216,137,.38); }
    .cicd-badge.failure, .cicd-badge.error { color: #ff8591; border-color: rgba(255,101,116,.38); }
    .cicd-badge.in_progress, .cicd-badge.queued, .cicd-badge.pending { color: #7bb8ff; border-color: rgba(77,156,255,.38); }
    .cicd-mini-button {
      height: 31px;
      padding: 0 10px;
      border: 1px solid #31577f;
      border-radius: 8px;
      background: #112a47;
      color: #d7e8fb;
      font-size: 10px;
      font-weight: 800;
      cursor: pointer;
    }
    .cicd-empty { padding: 35px 12px; color: #819ab8; text-align: center; font-size: 12px; }
    .cicd-toast {
      position: fixed;
      left: 50%;
      bottom: 26px;
      transform: translateX(-50%);
      z-index: 22000;
      max-width: min(680px, 90vw);
      padding: 10px 14px;
      border: 1px solid #31577f;
      border-radius: 10px;
      background: #0c2036;
      color: #dceafa;
      box-shadow: 0 12px 34px rgba(0,0,0,.44);
      font-size: 11px;
      font-weight: 720;
    }
    .cicd-toast.error { color: #ff9aa5; border-color: rgba(255,101,116,.45); }
    @media (max-width: 1050px) {
      .cicd-status { display: none; }
      .cicd-button { min-width: 96px; }
    }
  `;
  document.head.appendChild(style);

  const bar = document.createElement('section');
  bar.className = 'cicd-bar';
  const title = document.createElement('div');
  title.className = 'cicd-title';
  title.textContent = 'Control Center';

  const runButton = makeButton('▶ Run workflow', 'primary');
  const cancelButton = makeButton('■ Cancel', 'danger');
  const rerunButton = makeButton('↻ Re-run');
  const artifactsButton = makeButton('📦 Artifacts');
  const deploymentsButton = makeButton('🚀 Deployments');
  const status = document.createElement('div');
  status.className = 'cicd-status';
  status.textContent = 'Nhập token để dùng CI/CD';
  bar.append(title, runButton, cancelButton, rerunButton, artifactsButton, deploymentsButton, status);
  summary.insertAdjacentElement('afterend', bar);

  function makeButton(text, extra = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `cicd-button${extra ? ` ${extra}` : ''}`;
    button.textContent = text;
    return button;
  }

  function context() {
    return {
      repo: String(document.getElementById('repo')?.value || '').trim(),
      token: String(document.getElementById('token')?.value || '').trim()
    };
  }

  function selectedRun() {
    const row = document.querySelector('.run.selected[data-id]');
    if (!row) return null;
    const runId = Number(row.dataset.id);
    if (!Number.isSafeInteger(runId) || runId <= 0) return null;
    const pill = row.querySelector('.status-pill');
    const classes = pill ? [...pill.classList] : [];
    const known = ['in_progress','queued','waiting','pending','requested','success','failure','timed_out','startup_failure','cancelled','completed'];
    const state = classes.find((item) => known.includes(item)) || '';
    return {
      runId,
      state,
      title: row.querySelector('.title')?.textContent?.trim() || `Run #${runId}`
    };
  }

  function setStatus(text, kind = '') {
    status.className = `cicd-status${kind ? ` ${kind}` : ''}`;
    status.textContent = text;
  }

  function toast(message, error = false) {
    document.querySelector('.cicd-toast')?.remove();
    const node = document.createElement('div');
    node.className = `cicd-toast${error ? ' error' : ''}`;
    node.textContent = message;
    document.body.append(node);
    setTimeout(() => node.remove(), 3800);
  }

  function requireContext({ run = false } = {}) {
    const value = context();
    if (!value.repo) {
      toast('Chọn repository trước.', true);
      return null;
    }
    if (!value.token) {
      toast('Nhập GitHub token trước để dùng CI/CD.', true);
      document.getElementById('token')?.focus();
      return null;
    }
    if (run) {
      const selected = selectedRun();
      if (!selected) {
        toast('Chọn một workflow run trước.', true);
        return null;
      }
      return { ...value, selected };
    }
    return value;
  }

  function openModal(titleText) {
    const overlay = document.createElement('div');
    overlay.className = 'cicd-overlay';
    const modal = document.createElement('section');
    modal.className = 'cicd-modal';
    const head = document.createElement('div');
    head.className = 'cicd-modal-head';
    const titleNode = document.createElement('strong');
    titleNode.textContent = titleText;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'cicd-modal-close';
    close.textContent = '×';
    const body = document.createElement('div');
    body.className = 'cicd-modal-body';
    const actions = document.createElement('div');
    actions.className = 'cicd-modal-actions';
    head.append(titleNode, close);
    modal.append(head, body, actions);
    overlay.append(modal);
    document.body.append(overlay);

    const dismiss = () => overlay.remove();
    close.addEventListener('click', dismiss);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss(); });
    document.addEventListener('keydown', function esc(event) {
      if (event.key !== 'Escape') return;
      document.removeEventListener('keydown', esc);
      dismiss();
    });
    return { overlay, body, actions, dismiss };
  }

  function field(labelText, control) {
    const wrap = document.createElement('div');
    wrap.className = 'cicd-field';
    const label = document.createElement('label');
    label.textContent = labelText;
    wrap.append(label, control);
    return wrap;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function shortSha(value) {
    return String(value || '').slice(0, 8);
  }

  function localDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('vi-VN') : String(value);
  }

  async function openRunWorkflow() {
    const value = requireContext();
    if (!value) return;
    const modal = openModal(`Run workflow · ${value.repo}`);
    modal.body.innerHTML = '<div class="cicd-empty">Đang tải workflows…</div>';
    try {
      const data = await window.cicdMonitor.listWorkflows(value);
      modal.body.replaceChildren();
      const workflow = document.createElement('select');
      for (const item of data.workflows || []) {
        const option = document.createElement('option');
        option.value = String(item.id);
        option.textContent = `${item.name}${item.state !== 'active' ? ` · ${item.state}` : ''}`;
        option.disabled = item.state !== 'active';
        workflow.append(option);
      }
      const ref = document.createElement('input');
      ref.value = data.defaultBranch || 'main';
      ref.placeholder = 'main / branch / tag / SHA';
      const inputs = document.createElement('textarea');
      inputs.value = '{}';
      inputs.spellcheck = false;
      inputs.placeholder = '{"environment":"staging"}';
      modal.body.append(field('Workflow', workflow), field('Branch / tag / SHA', ref), field('Inputs JSON (tuỳ chọn)', inputs));

      const close = makeButton('Đóng');
      const run = makeButton('▶ Run workflow', 'primary');
      modal.actions.append(close, run);
      close.addEventListener('click', modal.dismiss);
      run.addEventListener('click', async () => {
        run.disabled = true;
        run.textContent = 'Đang chạy…';
        try {
          let parsed = {};
          const raw = inputs.value.trim();
          if (raw) {
            parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Inputs JSON phải là object.');
          }
          await window.cicdMonitor.dispatchWorkflow({
            ...value,
            workflowId: workflow.value,
            ref: ref.value.trim(),
            inputs: parsed
          });
          toast(`Đã trigger workflow trên ${ref.value.trim()}.`);
          setStatus('Workflow vừa được trigger', 'ok');
          modal.dismiss();
          setTimeout(() => document.getElementById('refresh')?.click(), 900);
        } catch (error) {
          toast(error?.message || String(error), true);
          run.disabled = false;
          run.textContent = '▶ Run workflow';
        }
      });
    } catch (error) {
      modal.body.innerHTML = `<div class="cicd-empty">${escapeHtml(error?.message || String(error))}</div>`;
    }
  }

  async function cancelSelectedRun() {
    const value = requireContext({ run: true });
    if (!value) return;
    if (!window.confirm(`Hủy ${value.selected.title}?`)) return;
    cancelButton.disabled = true;
    try {
      await window.cicdMonitor.cancelRun({ ...value, runId: value.selected.runId });
      toast('Đã gửi lệnh Cancel tới GitHub Actions.');
      setStatus('Đã gửi Cancel', 'ok');
      setTimeout(() => document.getElementById('refresh')?.click(), 800);
    } catch (error) {
      toast(error?.message || String(error), true);
      setStatus('Cancel thất bại', 'error');
    } finally {
      updateControls();
    }
  }

  async function rerunSelectedRun() {
    const value = requireContext({ run: true });
    if (!value) return;
    rerunButton.disabled = true;
    try {
      await window.cicdMonitor.rerunRun({ ...value, runId: value.selected.runId });
      toast('Đã yêu cầu Re-run workflow.');
      setStatus('Workflow đang re-run', 'ok');
      setTimeout(() => document.getElementById('refresh')?.click(), 900);
    } catch (error) {
      toast(error?.message || String(error), true);
      setStatus('Re-run thất bại', 'error');
    } finally {
      updateControls();
    }
  }

  async function openArtifacts() {
    const value = requireContext({ run: true });
    if (!value) return;
    const modal = openModal(`Artifacts · ${value.selected.title}`);
    modal.body.innerHTML = '<div class="cicd-empty">Đang tải artifacts…</div>';
    try {
      const data = await window.cicdMonitor.listArtifacts({ ...value, runId: value.selected.runId });
      modal.body.replaceChildren();
      const list = document.createElement('div');
      list.className = 'cicd-list';
      for (const artifact of data.artifacts || []) {
        const row = document.createElement('div');
        row.className = 'cicd-row';
        const info = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'cicd-row-name';
        name.textContent = artifact.name;
        const meta = document.createElement('div');
        meta.className = 'cicd-row-meta';
        meta.innerHTML = `<span class="cicd-badge">${formatBytes(artifact.sizeInBytes)}</span><span>${localDate(artifact.createdAt)}</span>${artifact.expired ? '<span class="cicd-badge failure">EXPIRED</span>' : ''}`;
        info.append(name, meta);
        const download = document.createElement('button');
        download.type = 'button';
        download.className = 'cicd-mini-button';
        download.textContent = artifact.expired ? 'Expired' : 'Download ZIP';
        download.disabled = artifact.expired;
        download.addEventListener('click', async () => {
          download.disabled = true;
          download.textContent = 'Downloading…';
          try {
            const result = await window.cicdMonitor.downloadArtifact({
              repo: value.repo,
              token: value.token,
              artifactId: artifact.id,
              name: artifact.name
            });
            if (result?.ok) toast(`Đã lưu: ${result.filePath}`);
          } catch (error) {
            toast(error?.message || String(error), true);
          } finally {
            download.disabled = artifact.expired;
            download.textContent = artifact.expired ? 'Expired' : 'Download ZIP';
          }
        });
        row.append(info, download);
        list.append(row);
      }
      if (!list.childElementCount) list.innerHTML = '<div class="cicd-empty">Run này không có artifact.</div>';
      modal.body.append(list);
      const close = makeButton('Đóng');
      close.addEventListener('click', modal.dismiss);
      modal.actions.append(close);
    } catch (error) {
      modal.body.innerHTML = `<div class="cicd-empty">${escapeHtml(error?.message || String(error))}</div>`;
    }
  }

  async function openDeployments() {
    const value = requireContext();
    if (!value) return;
    const modal = openModal(`Deployments · ${value.repo}`);
    modal.body.innerHTML = '<div class="cicd-empty">Đang tải deployments…</div>';
    try {
      const data = await window.cicdMonitor.listDeployments(value);
      modal.body.replaceChildren();
      const list = document.createElement('div');
      list.className = 'cicd-list';
      for (const deployment of data.deployments || []) {
        const row = document.createElement('div');
        row.className = 'cicd-row';
        const info = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'cicd-row-name';
        name.textContent = `${deployment.environment} · ${deployment.ref || shortSha(deployment.sha)}`;
        const meta = document.createElement('div');
        meta.className = 'cicd-row-meta';
        const stateClass = String(deployment.state || '').toLowerCase().replaceAll(' ', '_');
        const bits = [
          `<span class="cicd-badge ${escapeHtml(stateClass)}">${escapeHtml(String(deployment.state || 'pending').toUpperCase())}</span>`,
          `<span>${escapeHtml(shortSha(deployment.sha))}</span>`,
          `<span>${escapeHtml(localDate(deployment.createdAt))}</span>`
        ];
        if (deployment.creator) bits.push(`<span>@${escapeHtml(deployment.creator)}</span>`);
        meta.innerHTML = bits.join('');
        info.append(name, meta);
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'cicd-mini-button';
        open.textContent = deployment.environmentUrl ? 'Copy URL' : '—';
        open.disabled = !deployment.environmentUrl;
        open.addEventListener('click', () => {
          if (!deployment.environmentUrl) return;
          navigator.clipboard?.writeText(deployment.environmentUrl)
            .then(() => toast('Đã copy environment URL.'))
            .catch(() => toast(deployment.environmentUrl));
        });
        row.append(info, open);
        list.append(row);
      }
      if (!list.childElementCount) list.innerHTML = '<div class="cicd-empty">Repository này chưa có deployment.</div>';
      modal.body.append(list);
      const close = makeButton('Đóng');
      close.addEventListener('click', modal.dismiss);
      modal.actions.append(close);
    } catch (error) {
      modal.body.innerHTML = `<div class="cicd-empty">${escapeHtml(error?.message || String(error))}</div>`;
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function updateControls() {
    const value = context();
    const selected = selectedRun();
    const hasToken = Boolean(value.token && value.repo);
    const activeStates = new Set(['in_progress','queued','waiting','pending','requested']);
    runButton.disabled = !hasToken;
    cancelButton.disabled = !hasToken || !selected || !activeStates.has(selected.state);
    rerunButton.disabled = !hasToken || !selected || activeStates.has(selected.state);
    artifactsButton.disabled = !hasToken || !selected;
    deploymentsButton.disabled = !hasToken;
    if (!hasToken) setStatus('Nhập token để dùng CI/CD');
  }

  runButton.addEventListener('click', openRunWorkflow);
  cancelButton.addEventListener('click', cancelSelectedRun);
  rerunButton.addEventListener('click', rerunSelectedRun);
  artifactsButton.addEventListener('click', openArtifacts);
  deploymentsButton.addEventListener('click', openDeployments);

  const observer = new MutationObserver(updateControls);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  document.getElementById('token')?.addEventListener('input', updateControls);
  document.getElementById('repo')?.addEventListener('input', updateControls);
  document.getElementById('repoPicker')?.addEventListener('change', updateControls);
  updateControls();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', installCicdUi, { once: true });
} else {
  queueMicrotask(installCicdUi);
}
