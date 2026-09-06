const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('actionsMonitor', {
  listRuns: (input) => ipcRenderer.invoke('actions:list', input),
  listJobs: (input) => ipcRenderer.invoke('actions:jobs', input),
  openUrl: (url) => ipcRenderer.invoke('actions:open-url', url)
});

function installRunningStatusSpinner() {
  if (!document.getElementById('github-actions-monitor-running-spinner-style')) {
    const style = document.createElement('style');
    style.id = 'github-actions-monitor-running-spinner-style';
    style.textContent = `
      @keyframes github-actions-monitor-spin {
        to { transform: rotate(360deg); }
      }
      .github-actions-monitor-spinner {
        width: 15px;
        height: 15px;
        display: inline-block;
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
    `;
    document.head.appendChild(style);
  }

  const apply = () => {
    document.querySelectorAll('.card.running .card-icon, .status-icon.in_progress, .step-symbol.active').forEach((node) => {
      node.classList.remove('pulse');
      if (node.querySelector('.github-actions-monitor-spinner')) return;
      node.replaceChildren(Object.assign(document.createElement('span'), {
        className: 'github-actions-monitor-spinner'
      }));
    });
  };

  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.body, { childList: true, subtree: true });
}

window.addEventListener('DOMContentLoaded', installRunningStatusSpinner, { once: true });
