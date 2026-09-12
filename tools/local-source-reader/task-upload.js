(() => {
  const GLOBAL_KEY = '__CODEXPRO_LOCAL_TASK_UPLOAD_V1__';
  if (globalThis[GLOBAL_KEY]) return;

  const HOST_ID = 'codexpro-local-source-reader';
  const NETWORK_GLOBAL_KEY = '__CODEXPRO_LOCAL_SOURCE_UPLOAD_NETWORK_V1__';
  const UPLOAD_TIMEOUT_MS = 120000;
  const MAX_TASK_FILES = 100;
  const MAX_TASK_FILE_BYTES = 1024 * 1024;
  const MAX_TASK_TOTAL_BYTES = 10 * 1024 * 1024;
  const ALLOWED_EXTENSIONS = new Set(['json', 'md', 'txt']);
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'logs', 'log', 'cache', 'tmp', 'temp']);
  const SECRET_NAMES = new Set([
    '.env', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
    'credentials.json', 'cookies.json', 'token.json', 'tokens.json', 'auth.json'
  ]);

  let taskBusy = false;

  function normalizePath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  }

  function extensionOf(name) {
    const value = String(name || '').toLowerCase();
    const dot = value.lastIndexOf('.');
    return dot >= 0 ? value.slice(dot + 1) : '';
  }

  function secretLike(path) {
    const normalized = normalizePath(path).toLowerCase();
    const base = normalized.split('/').at(-1) || '';
    if (SECRET_NAMES.has(base)) return true;
    if (base.startsWith('.env.')) return true;
    if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(base)) return true;
    if (/^(id_rsa|id_ed25519|id_ecdsa)(\.|$)/i.test(base)) return true;
    return false;
  }

  async function sortedEntries(dirHandle) {
    const entries = [];
    for await (const entry of dirHandle.values()) entries.push(entry);
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  async function looksBinary(file) {
    const sample = new Uint8Array(await file.slice(0, Math.min(file.size, 8192)).arrayBuffer());
    if (!sample.length) return false;
    let suspicious = 0;
    for (const byte of sample) {
      if (byte === 0) return true;
      if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
    }
    return suspicious / sample.length > 0.12;
  }

  function isCompletedTaskJson(text) {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && String(parsed.state || '').toUpperCase() === 'COMPLETED'
        && parsed.finalized === true;
    } catch (_) {
      return false;
    }
  }

  function getUi() {
    const host = document.getElementById(HOST_ID);
    const shadow = host?.shadowRoot;
    return {
      host,
      shadow,
      actions: shadow?.querySelector('.actions') || null,
      status: shadow?.querySelector('.status') || null
    };
  }

  function setStatus(message, kind = 'normal') {
    const { status } = getUi();
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function setActionButtonsDisabled(disabled) {
    const { actions } = getUi();
    if (!actions) return [];
    const buttons = [...actions.querySelectorAll('button')];
    if (disabled) {
      return buttons.map((button) => {
        const previous = button.disabled;
        button.disabled = true;
        return [button, previous];
      });
    }
    return buttons;
  }

  function restoreButtons(snapshot) {
    for (const [button, disabled] of snapshot || []) {
      if (button?.isConnected) button.disabled = Boolean(disabled);
    }
  }

  async function collectTaskFiles(rootHandle) {
    if (String(rootHandle?.name || '').toLowerCase() !== 'task-tracking') {
      throw new Error('Hãy chọn đúng thư mục task-tracking.');
    }

    const selected = [];
    const warnings = [];
    let totalBytes = 0;
    let completedExcluded = 0;
    let candidateCount = 0;

    async function walk(dirHandle, prefix = '') {
      const entries = await sortedEntries(dirHandle);
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const normalized = normalizePath(relativePath);

        if (entry.kind === 'directory') {
          if (SKIP_DIRS.has(entry.name.toLowerCase()) || secretLike(normalized)) {
            warnings.push(`${normalized}/ [ignored directory]`);
            continue;
          }
          await walk(entry, normalized);
          continue;
        }

        if (entry.kind !== 'file') continue;
        if (!ALLOWED_EXTENSIONS.has(extensionOf(entry.name))) continue;
        if (secretLike(normalized)) {
          warnings.push(`${normalized} [secret-like name]`);
          continue;
        }

        candidateCount += 1;
        if (candidateCount > MAX_TASK_FILES) {
          warnings.push(`${normalized} [file-count limit]`);
          continue;
        }

        const file = await entry.getFile();
        if (file.size > MAX_TASK_FILE_BYTES) {
          warnings.push(`${normalized} [too large]`);
          continue;
        }
        if (totalBytes + file.size > MAX_TASK_TOTAL_BYTES) {
          warnings.push(`${normalized} [total-size limit]`);
          continue;
        }
        if (await looksBinary(file)) {
          warnings.push(`${normalized} [binary]`);
          continue;
        }

        const text = await file.text();
        if (extensionOf(entry.name) === 'json' && isCompletedTaskJson(text)) {
          completedExcluded += 1;
          continue;
        }

        selected.push({ path: normalized, text, bytes: file.size });
        totalBytes += file.size;
      }
    }

    await walk(rootHandle);
    return { selected, warnings, totalBytes, completedExcluded, candidateCount };
  }

  function safeTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  function buildTaskBundle(rootHandle, result) {
    const lines = [
      'CODEXPRO UNFINISHED TASK TRACKING',
      `Created: ${new Date().toISOString()}`,
      `Tracking root: ${rootHandle.name}`,
      `Included files: ${result.selected.length}`,
      `Completed finalized excluded: ${result.completedExcluded}`,
      `Warnings: ${result.warnings.length}`,
      '',
      'INSTRUCTIONS FOR CHATGPT:',
      '- This attachment contains task-tracking information only; it is not a source-code baseline.',
      '- Treat authoritative repo-task/coordination state as source of truth if it conflicts with this snapshot.',
      '- Focus on unfinished task state, checkpoint, blocker, dependency and safe_next_action fields.',
      ''
    ];

    if (result.warnings.length) {
      lines.push('WARNINGS:', ...result.warnings, '');
    }

    for (const item of result.selected) {
      lines.push(
        `===== TASK FILE: ${item.path} =====`,
        item.text,
        `===== END TASK FILE: ${item.path} =====`,
        ''
      );
    }

    return new File(
      [lines.join('\n')],
      `codexpro-unfinished-tasks-${safeTimestamp()}.txt`,
      { type: 'text/plain' }
    );
  }

  async function waitForUploadInput(timeoutMs = 1800) {
    const selectors = [
      'input[type="file"]',
      'form input[type="file"]',
      '[data-testid="composer"] input[type="file"]'
    ];
    const find = () => selectors.map((selector) => document.querySelector(selector)).find(Boolean);
    let input = find();
    if (input) return input;

    const attachButton = [
      'button[data-testid="composer-plus-btn"]',
      'button[aria-label*="Attach" i]',
      'button[aria-label*="Upload" i]',
      'button[aria-label*="Add files" i]'
    ].map((selector) => document.querySelector(selector)).find(Boolean);
    if (attachButton) {
      try { attachButton.click(); } catch (_) {}
    }

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      input = find();
      if (input) return input;
    }
    return null;
  }

  async function attachToChatGPT(file) {
    const input = await waitForUploadInput();
    if (!input) return false;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function attachAndConfirm(file) {
    const monitor = globalThis[NETWORK_GLOBAL_KEY];
    if (!monitor || typeof monitor.waitForSnapshot !== 'function') {
      throw new Error('Network monitor chưa được nạp. Reload extension và ChatGPT rồi thử lại.');
    }
    const startedAt = Date.now() - 100;
    const attached = await attachToChatGPT(file);
    if (!attached) throw new Error('ChatGPT chưa nhận được file task vào composer.');
    setStatus(`Đã attach ${file.name}. Đang chờ ChatGPT network xác nhận upload…`);
    return monitor.waitForSnapshot(file, startedAt, UPLOAD_TIMEOUT_MS);
  }

  async function handleTaskUpload() {
    if (taskBusy) return;
    const { actions } = getUi();
    const otherBusy = actions && [...actions.querySelectorAll('button')].some((button) => button.disabled && button.id !== 'codexpro-upload-task');
    if (otherBusy) {
      setStatus('Đang có upload khác chạy. Hãy chờ upload hiện tại xong.', 'warning');
      return;
    }

    if (typeof window.showDirectoryPicker !== 'function') {
      setStatus('Chrome/Edge hiện tại không hỗ trợ chọn thư mục task-tracking.', 'error');
      return;
    }

    taskBusy = true;
    const disabledSnapshot = setActionButtonsDisabled(true);
    const originalStatus = getUi().status?.textContent || '';
    const taskButton = getUi().shadow?.getElementById('codexpro-upload-task');
    if (taskButton) taskButton.textContent = 'Task: đang quét…';

    try {
      setStatus('Chọn thư mục task-tracking. Chỉ .json/.md/.txt chưa hoàn thành sẽ được upload.');
      const rootHandle = await window.showDirectoryPicker({ mode: 'read' });
      const result = await collectTaskFiles(rootHandle);
      if (!result.selected.length) {
        setStatus(`Không có task dở để upload · ${result.completedExcluded} task completed đã bỏ qua.`, 'success');
        return;
      }

      setStatus(`Task: ${result.selected.length} file dở · ${result.completedExcluded} completed bỏ qua · đang tạo attachment…`);
      const bundle = buildTaskBundle(rootHandle, result);
      await attachAndConfirm(bundle);

      const success = `Đã upload ${result.selected.length} file task · ${bundle.name} · baseline source không đổi.`;
      setStatus(success, 'success');
      setTimeout(() => {
        const { status } = getUi();
        if (status?.textContent === success) {
          status.textContent = originalStatus;
          status.dataset.kind = 'normal';
        }
      }, 5000);
    } catch (error) {
      if (error?.name === 'AbortError') setStatus('Đã hủy chọn thư mục task-tracking.');
      else {
        console.error('[Local Task Upload]', error);
        setStatus(error instanceof Error ? error.message : String(error), 'error');
      }
    } finally {
      taskBusy = false;
      restoreButtons(disabledSnapshot);
      const button = getUi().shadow?.getElementById('codexpro-upload-task');
      if (button) button.textContent = 'Upload Task';
    }
  }

  function mountTaskButton() {
    const { shadow, actions } = getUi();
    if (!shadow || !actions || shadow.getElementById('codexpro-upload-task')) return false;

    const button = document.createElement('button');
    button.id = 'codexpro-upload-task';
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'Upload Task';
    button.title = 'Upload snapshot chỉ chứa task chưa hoàn thành từ thư mục task-tracking; không thay đổi source baseline.';
    button.addEventListener('click', handleTaskUpload);

    const historyButton = [...actions.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Lịch sử');
    actions.insertBefore(button, historyButton || null);
    return true;
  }

  mountTaskButton();
  const observer = new MutationObserver(() => { mountTaskButton(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  globalThis[GLOBAL_KEY] = {
    version: 1,
    collectTaskFiles,
    isCompletedTaskJson,
    buildTaskBundle
  };
})();