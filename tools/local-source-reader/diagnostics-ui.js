(() => {
  const HOST_ID = 'codexpro-local-source-reader';
  const NETWORK_GLOBAL_KEY = '__CODEXPRO_LOCAL_SOURCE_UPLOAD_NETWORK_V1__';
  const LOG_PANEL_CLASS = 'upload-log-panel';
  const LOG_BUTTON_ID = 'codexpro-upload-log-button';

  let refreshTimer = null;

  function monitor() {
    return globalThis[NETWORK_GLOBAL_KEY] || null;
  }

  function downloadText(fileName, text, type = 'application/json') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function compactEntry(entry) {
    const time = entry?.at ? new Date(entry.at).toLocaleTimeString() : '';
    const method = entry?.method ? `${entry.method} ` : '';
    const endpoint = entry?.endpoint || '';
    const status = entry?.statusCode ? ` -> ${entry.statusCode}` : '';
    const fileName = entry?.fileName ? ` · ${entry.fileName}` : '';
    const fileId = entry?.fileId ? ` · id=${entry.fileId}` : '';
    const error = entry?.error ? ` · ERROR=${entry.error}` : '';
    return `${time} #${entry?.seq || '-'} ${entry?.type || 'event'} · ${method}${endpoint}${status}${fileName}${fileId}${error}`.trim();
  }

  function exportPayload() {
    const net = monitor();
    if (!net) {
      return {
        format: 'codexpro-local-source-upload-diagnostics',
        version: 1,
        exportedAt: new Date().toISOString(),
        error: 'network monitor unavailable'
      };
    }
    if (typeof net.exportDiagnostics === 'function') return net.exportDiagnostics();
    return {
      format: 'codexpro-local-source-upload-diagnostics',
      version: 1,
      exportedAt: new Date().toISOString(),
      page: location.origin,
      health: typeof net.health === 'function' ? net.health() : null,
      events: typeof net.events === 'function' ? net.events() : [],
      diagnostics: typeof net.diagnostics === 'function' ? net.diagnostics() : []
    };
  }

  function render(panel) {
    if (!panel || panel.hidden) return;
    const payload = exportPayload();
    const rows = Array.isArray(payload.diagnostics) ? payload.diagnostics.slice(-100) : [];
    const health = payload.health || {};
    const healthText = [
      `monitor v${health.version || '?'}`,
      `fetchHook=${health.fetchHookActive ? 'ON' : 'OFF'}`,
      `xhrOpen=${health.xhrOpenHookActive ? 'ON' : 'OFF'}`,
      `xhrSend=${health.xhrSendHookActive ? 'ON' : 'OFF'}`,
      `logs=${health.diagnosticCount ?? rows.length}`,
      `events=${health.eventCount ?? (payload.events?.length || 0)}`
    ].join(' · ');

    const healthNode = panel.querySelector('[data-log-health]');
    if (healthNode) {
      healthNode.textContent = healthText;
      healthNode.dataset.bad = (!health.fetchHookActive && !health.xhrSendHookActive) ? 'true' : 'false';
    }

    const rowsNode = panel.querySelector('[data-log-rows]');
    if (rowsNode) {
      rowsNode.innerHTML = rows.length
        ? rows.map((entry) => `<div class="upload-log-row">${escapeHtml(compactEntry(entry))}</div>`).join('')
        : '<div class="upload-log-empty">Chưa có log network. Hãy thử Upload Full rồi mở lại Log.</div>';
      rowsNode.scrollTop = rowsNode.scrollHeight;
    }
  }

  function startRefresh(panel) {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!document.documentElement.contains(panel)) {
        clearInterval(refreshTimer);
        refreshTimer = null;
        return;
      }
      render(panel);
    }, 1000);
  }

  function stopRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function mountIntoReader() {
    const host = document.getElementById(HOST_ID);
    const shadow = host?.shadowRoot;
    if (!shadow) return false;
    const actions = shadow.querySelector('.actions');
    const mainPanel = shadow.querySelector('.panel');
    if (!actions || !mainPanel) return false;
    if (shadow.getElementById(LOG_BUTTON_ID)) return true;

    const style = document.createElement('style');
    style.textContent = `
      .upload-log-panel{margin-top:8px;border-top:1px solid rgba(255,255,255,.12);padding-top:8px;max-width:410px}
      .upload-log-toolbar{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px}
      .upload-log-toolbar button{padding:5px 8px;background:#303030;color:#eee;border:1px solid rgba(255,255,255,.12);font-size:11px}
      .upload-log-health{color:#a7f3d0;margin-bottom:5px;word-break:break-word}.upload-log-health[data-bad="true"]{color:#fca5a5}
      .upload-log-help{color:#aaa;margin-bottom:6px}.upload-log-rows{max-height:240px;overflow:auto;background:#111;border-radius:7px;padding:5px;font:10px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;color:#ccc}
      .upload-log-row{padding:3px 2px;border-bottom:1px solid rgba(255,255,255,.06);word-break:break-all}.upload-log-row:last-child{border-bottom:0}.upload-log-empty{color:#777;padding:4px}
    `;
    shadow.appendChild(style);

    const logButton = document.createElement('button');
    logButton.id = LOG_BUTTON_ID;
    logButton.type = 'button';
    logButton.className = 'secondary';
    logButton.textContent = 'Log';
    logButton.title = 'Xem và xuất network log của upload để điều tra khi ChatGPT không xác nhận.';

    const panel = document.createElement('div');
    panel.className = LOG_PANEL_CLASS;
    panel.hidden = true;
    panel.innerHTML = `
      <div class="upload-log-toolbar">
        <button type="button" data-log-refresh>Làm mới</button>
        <button type="button" data-log-copy>Sao chép JSON</button>
        <button type="button" data-log-download>Tải JSON</button>
        <button type="button" data-log-clear>Xóa log</button>
      </div>
      <div class="upload-log-health" data-log-health></div>
      <div class="upload-log-help">Log được lưu qua reload, chỉ ghi metadata network đã lọc/redact; không lưu source file, cookie, Authorization hay signed upload URL.</div>
      <div class="upload-log-rows" data-log-rows></div>
    `;

    logButton.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        render(panel);
        startRefresh(panel);
      } else {
        stopRefresh();
      }
    });

    panel.querySelector('[data-log-refresh]')?.addEventListener('click', () => render(panel));
    panel.querySelector('[data-log-copy]')?.addEventListener('click', async () => {
      const text = JSON.stringify(exportPayload(), null, 2);
      try {
        await navigator.clipboard.writeText(text);
        const button = panel.querySelector('[data-log-copy]');
        if (button) {
          const old = button.textContent;
          button.textContent = 'Đã copy';
          setTimeout(() => { button.textContent = old; }, 1200);
        }
      } catch (error) {
        console.warn('[Local Source Upload Trace] clipboard copy failed', error);
      }
    });
    panel.querySelector('[data-log-download]')?.addEventListener('click', () => {
      const payload = exportPayload();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadText(`codexpro-upload-log-${stamp}.json`, JSON.stringify(payload, null, 2));
    });
    panel.querySelector('[data-log-clear]')?.addEventListener('click', () => {
      const net = monitor();
      if (typeof net?.clearDiagnostics === 'function') net.clearDiagnostics();
      render(panel);
    });

    actions.appendChild(logButton);
    mainPanel.appendChild(panel);
    return true;
  }

  function ensureMounted() {
    if (mountIntoReader()) return;
    setTimeout(ensureMounted, 300);
  }

  ensureMounted();
  const observer = new MutationObserver(() => { void mountIntoReader(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
