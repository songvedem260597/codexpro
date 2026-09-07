(() => {
  if (window.__CODEXPRO_LOCAL_SOURCE_READER__) return;
  window.__CODEXPRO_LOCAL_SOURCE_READER__ = true;

  const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
  const MAX_FILE_BYTES = 3 * 1024 * 1024;
  const MAX_FILES = 5000;
  const STATUS_ID = 'codexpro-local-source-status';
  const BASELINE_STORAGE_KEY = 'codexproLocalSourceReaderBaselinesV1';
  const BASELINE_VERSION = 1;

  const SKIP_DIRS = new Set([
    '.git', '.hg', '.svn', 'node_modules', 'bower_components',
    'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit',
    '.cache', '.parcel-cache', '.turbo', '.vite', '.vercel', '.output',
    '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
    'target', 'bin', 'obj', 'vendor'
  ]);

  const SKIP_FILE_NAMES = new Set([
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
    'bun.lockb', 'bun.lock', 'cargo.lock', 'poetry.lock', 'composer.lock',
    'gemfile.lock', 'pipfile.lock'
  ]);

  const SOURCE_EXTENSIONS = new Set([
    'js', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'mjs', 'cjs',
    'json', 'jsonc', 'md', 'mdx', 'txt', 'html', 'htm', 'css', 'scss', 'sass', 'less',
    'vue', 'svelte', 'astro', 'py', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
    'c', 'h', 'cc', 'hh', 'cpp', 'hpp', 'cxx', 'hxx', 'cs', 'fs', 'fsx', 'vb',
    'php', 'rb', 'swift', 'dart', 'lua', 'r', 'ex', 'exs', 'erl', 'hrl',
    'clj', 'cljs', 'cljc', 'edn', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'sql', 'graphql', 'gql', 'proto', 'prisma', 'sol', 'tf', 'tfvars',
    'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'gradle', 'xml',
    'csv', 'tsv', 'env', 'example', 'sample', 'template'
  ]);

  const SOURCE_FILE_NAMES = new Set([
    'dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile', 'vagrantfile',
    'cmakelists.txt', '.gitignore', '.gitattributes', '.dockerignore', '.npmignore',
    '.editorconfig', '.prettierrc', '.eslintrc', '.babelrc', 'license'
  ]);

  const state = {
    busy: false,
    host: null,
    button: null,
    fullButton: null,
    status: null
  };

  function normalizePath(path) {
    return path.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  function projectStorageKey(projectName) {
    return String(projectName || '').trim().toLocaleLowerCase();
  }

  function readBaselineStore() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(BASELINE_STORAGE_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function loadBaseline(projectName) {
    const entry = readBaselineStore()[projectStorageKey(projectName)];
    if (!entry || entry.version !== BASELINE_VERSION || !entry.files || typeof entry.files !== 'object') return null;
    return entry;
  }

  function saveBaseline(projectName, baseline) {
    try {
      const store = readBaselineStore();
      store[projectStorageKey(projectName)] = baseline;
      window.localStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(store));
      return true;
    } catch (error) {
      console.warn('[Local Source Snapshot] could not persist baseline', error);
      return false;
    }
  }

  function isSecretLike(path) {
    const normalized = normalizePath(path).toLowerCase();
    const parts = normalized.split('/');
    const base = parts.at(-1) || '';

    if (parts.some((part) => ['.ssh', '.aws', '.azure', '.gnupg'].includes(part))) return true;
    if (['.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials.json'].includes(base)) return true;
    if (/^(id_rsa|id_ed25519|id_ecdsa)(\.|$)/.test(base)) return true;
    if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(base)) return true;
    if (/service[-_]?account.*\.json$/.test(base) || /firebase-adminsdk.*\.json$/.test(base)) return true;

    if (base === '.env' || base.startsWith('.env.')) {
      return !/(example|sample|template|dist|defaults?)/.test(base);
    }

    return false;
  }

  function isSourceFile(name, path) {
    const lower = name.toLowerCase();
    if (SKIP_FILE_NAMES.has(lower)) return false;
    if (lower.endsWith('.map') || lower.includes('.min.')) return false;
    if (isSecretLike(path)) return false;
    if (SOURCE_FILE_NAMES.has(lower)) return true;

    const dot = lower.lastIndexOf('.');
    if (dot < 0) return false;
    return SOURCE_EXTENSIONS.has(lower.slice(dot + 1));
  }

  async function looksBinary(file) {
    const sample = new Uint8Array(await file.slice(0, Math.min(file.size, 8192)).arrayBuffer());
    if (sample.length === 0) return false;

    let suspicious = 0;
    for (const byte of sample) {
      if (byte === 0) return true;
      if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
    }
    return suspicious / sample.length > 0.12;
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

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function setStatus(text, kind = 'normal') {
    if (!state.status) return;
    state.status.textContent = text;
    state.status.dataset.kind = kind;
  }

  function setBusy(busy, label = 'Đang đọc source…') {
    state.busy = busy;
    if (state.button) {
      state.button.disabled = busy;
      if (busy) state.button.textContent = label;
    }
    if (state.fullButton) state.fullButton.disabled = busy;
  }

  function fallbackHash(bytes) {
    let hash = 2166136261;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${bytes.byteLength}`;
  }

  async function contentHash(bytes) {
    try {
      if (window.crypto?.subtle) {
        const digest = await window.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
      }
    } catch (_) {}
    return fallbackHash(bytes);
  }

  function metadataChanged(previous, file) {
    if (!previous) return true;
    return Number(previous.bytes) !== Number(file.size) || Number(previous.lastModified) !== Number(file.lastModified);
  }

  async function buildSnapshot(rootHandle, options = {}) {
    const storedBaseline = options.forceFull ? null : loadBaseline(rootHandle.name);
    const mode = storedBaseline ? 'DELTA' : 'FULL';
    const previousFiles = storedBaseline?.files && typeof storedBaseline.files === 'object' ? storedBaseline.files : {};
    const changed = [];
    const skipped = [];
    const blockedChanges = [];
    const currentFiles = {};
    const seenSourcePaths = new Set();
    let currentTextBytes = 0;
    let changedTextBytes = 0;
    let sourceFileCount = 0;

    async function noteBlocked(path, reason, file = null) {
      skipped.push(`${path} [${reason}]`);
      const previous = previousFiles[path];
      if (!storedBaseline || !file || metadataChanged(previous, file)) {
        blockedChanges.push(`${path} [${reason}]`);
      }
    }

    async function walk(dirHandle, prefix = '') {
      const entries = await sortedEntries(dirHandle);
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.kind === 'directory') {
          if (SKIP_DIRS.has(entry.name.toLowerCase()) || isSecretLike(path)) {
            skipped.push(`${path}/ [ignored directory]`);
            continue;
          }
          await walk(entry, path);
          continue;
        }

        if (!isSourceFile(entry.name, path)) continue;
        sourceFileCount += 1;
        seenSourcePaths.add(path);

        if (sourceFileCount > MAX_FILES) {
          await noteBlocked(path, 'file-count limit');
          continue;
        }

        const file = await entry.getFile();
        if (file.size > MAX_FILE_BYTES) {
          await noteBlocked(path, `too large: ${formatBytes(file.size)}`, file);
          continue;
        }
        if (currentTextBytes + file.size > MAX_TOTAL_BYTES) {
          await noteBlocked(path, 'snapshot size limit', file);
          continue;
        }
        if (await looksBinary(file)) {
          await noteBlocked(path, 'binary', file);
          continue;
        }

        const text = await file.text();
        const encoded = new TextEncoder().encode(text);
        const bytes = encoded.byteLength;
        if (currentTextBytes + bytes > MAX_TOTAL_BYTES) {
          await noteBlocked(path, 'snapshot size limit', file);
          continue;
        }

        const hash = await contentHash(encoded);
        const record = { hash, bytes, lastModified: Number(file.lastModified) || 0 };
        currentFiles[path] = record;
        currentTextBytes += bytes;

        const previousHash = String(previousFiles[path]?.hash || '');
        if (mode === 'FULL' || previousHash !== hash) {
          changed.push({ path, text, bytes, record });
          changedTextBytes += bytes;
        }

        if (sourceFileCount % 20 === 0) {
          const label = mode === 'FULL'
            ? `Đang đọc ${sourceFileCount} files · ${formatBytes(currentTextBytes)}…`
            : `Đang so sánh ${sourceFileCount} files · ${changed.length} file đổi…`;
          setStatus(label);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }

    await walk(rootHandle);

    const deleted = storedBaseline
      ? Object.keys(previousFiles).filter((path) => !seenSourcePaths.has(path)).sort((a, b) => a.localeCompare(b))
      : [];

    const previousRevision = Number(storedBaseline?.revision) || 0;
    const nextRevision = previousRevision + 1;
    const nextFiles = mode === 'FULL' ? { ...currentFiles } : { ...previousFiles, ...currentFiles };
    for (const path of deleted) delete nextFiles[path];

    const nextBaseline = {
      version: BASELINE_VERSION,
      projectName: rootHandle.name,
      revision: nextRevision,
      updatedAt: new Date().toISOString(),
      files: nextFiles
    };

    const hasChanges = mode === 'FULL' || changed.length > 0 || deleted.length > 0 || blockedChanges.length > 0;
    if (!hasChanges) {
      return {
        unchanged: true,
        mode,
        fileCount: sourceFileCount,
        changedCount: 0,
        deletedCount: 0,
        skippedCount: skipped.length,
        currentTextBytes,
        changedTextBytes: 0,
        baseline: storedBaseline
      };
    }

    const header = mode === 'FULL'
      ? [
          'LOCAL SOURCE SNAPSHOT',
          `Project: ${rootHandle.name}`,
          `Created: ${new Date().toISOString()}`,
          'Mode: FULL BASELINE / READ-ONLY',
          `Baseline revision: ${nextRevision}`,
          `Included files: ${changed.length}`,
          `Included text: ${formatBytes(changedTextBytes)}`,
          '',
          'INSTRUCTIONS FOR CHATGPT:',
          '- Treat this attachment as the full local source baseline for this project in the current conversation.',
          '- Later DELTA attachments only contain changed/new source files and deleted-file markers.',
          '- Do not assume omitted generated/dependency/secret files are part of the editable source.',
          '',
          'FILE TREE:',
          ...changed.map((item) => item.path),
          '',
          skipped.length ? 'SKIPPED / FILTERED:' : 'SKIPPED / FILTERED: none',
          ...skipped,
          '',
          '===== SOURCE CONTENT START =====',
          ''
        ]
      : [
          'LOCAL SOURCE DELTA',
          `Project: ${rootHandle.name}`,
          `Created: ${new Date().toISOString()}`,
          'Mode: CHANGES ONLY / READ-ONLY',
          `Previous baseline revision: ${previousRevision}`,
          `New baseline revision: ${nextRevision}`,
          `Changed/new files: ${changed.length}`,
          `Deleted files: ${deleted.length}`,
          `Changed text: ${formatBytes(changedTextBytes)}`,
          '',
          'INSTRUCTIONS FOR CHATGPT:',
          '- Apply this delta on top of the previous FULL/DELTA source baseline already attached in this conversation.',
          '- Files not listed in CHANGED / NEW FILES are unchanged and must be remembered from the previous baseline.',
          '- Files listed in DELETED FILES no longer exist locally and must be treated as removed.',
          '- If the previous baseline is not available in this conversation, ask for a new FULL upload instead of guessing.',
          '',
          changed.length ? 'CHANGED / NEW FILES:' : 'CHANGED / NEW FILES: none',
          ...changed.map((item) => item.path),
          '',
          deleted.length ? 'DELETED FILES:' : 'DELETED FILES: none',
          ...deleted,
          '',
          blockedChanges.length ? 'CHANGED BUT NOT ATTACHED DUE TO LIMITS:' : 'CHANGED BUT NOT ATTACHED DUE TO LIMITS: none',
          ...blockedChanges,
          '',
          skipped.length ? 'SKIPPED / FILTERED:' : 'SKIPPED / FILTERED: none',
          ...skipped,
          '',
          '===== SOURCE CONTENT START =====',
          ''
        ];

    const chunks = [header.join('\n')];
    for (const item of changed) {
      chunks.push(`===== FILE: ${item.path} =====\n${item.text}\n===== END FILE: ${item.path} =====\n`);
    }
    chunks.push('===== SOURCE CONTENT END =====\n');

    const suffix = mode === 'FULL' ? 'local-source-snapshot' : `local-source-delta-r${nextRevision}`;
    return {
      file: new File(chunks, `${rootHandle.name}-${suffix}.txt`, { type: 'text/plain' }),
      mode,
      fileCount: sourceFileCount,
      changedCount: changed.length,
      deletedCount: deleted.length,
      blockedChangeCount: blockedChanges.length,
      skippedCount: skipped.length,
      currentTextBytes,
      changedTextBytes,
      previousRevision,
      nextRevision,
      nextBaseline
    };
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

    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (error) {
      console.warn('[Local Source Snapshot] attach failed', error);
      return false;
    }
  }

  function downloadFallback(file) {
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.style.display = 'none';
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function handleClick(options = {}) {
    if (state.busy) return;
    const forceFull = options.forceFull === true;
    setBusy(true, forceFull ? 'Đang tạo full snapshot…' : 'Đang đọc source…');
    setStatus(
      forceFull
        ? 'Chọn project để upload FULL và đặt lại baseline.'
        : 'Chọn project. Lần đầu upload full; các lần sau chỉ attach file code thay đổi.'
    );

    try {
      if (typeof window.showDirectoryPicker !== 'function') {
        throw new Error('Chrome/Edge hiện tại không hỗ trợ showDirectoryPicker trong trang này.');
      }

      const rootHandle = await window.showDirectoryPicker({ mode: 'read' });
      const baseline = forceFull ? null : loadBaseline(rootHandle.name);
      setStatus(
        forceFull
          ? `Đang quét full ${rootHandle.name}…`
          : baseline
            ? `Đã nhớ baseline r${baseline.revision || 1}. Đang tìm file thay đổi trong ${rootHandle.name}…`
            : `Chưa có baseline cho ${rootHandle.name}. Đang quét full lần đầu…`
      );

      const snapshot = await buildSnapshot(rootHandle, { forceFull });

      if (snapshot.fileCount === 0) {
        throw new Error('Không tìm thấy source text phù hợp sau khi lọc.');
      }

      if (snapshot.unchanged) {
        state.button.textContent = '✓ Không có thay đổi';
        setStatus(
          `${snapshot.fileCount} source files · không có file code thay đổi từ baseline · không tạo attachment`,
          'success'
        );
        return;
      }

      const summary = snapshot.mode === 'FULL'
        ? `${snapshot.changedCount} files full · ${formatBytes(snapshot.changedTextBytes)}`
        : `${snapshot.changedCount} file đổi/mới · ${snapshot.deletedCount} file xóa · ${formatBytes(snapshot.changedTextBytes)}`;
      setStatus(`${summary}. Đang attach 1 file duy nhất…`);
      const attached = await attachToChatGPT(snapshot.file);

      if (attached) {
        const baselineSaved = saveBaseline(rootHandle.name, snapshot.nextBaseline);
        state.button.textContent = snapshot.mode === 'FULL' ? '✓ Full source đã attach' : '✓ Changes đã attach';
        setStatus(
          `${summary} · baseline r${snapshot.nextRevision} ${baselineSaved ? 'đã ghi nhớ' : 'KHÔNG lưu được'} · 1 attachment · không gửi chat trung gian`,
          baselineSaved ? 'success' : 'warning'
        );
      } else {
        downloadFallback(snapshot.file);
        state.button.textContent = 'Snapshot đã tạo';
        setStatus(
          'ChatGPT đổi UI nên auto-attach chưa tìm thấy input. Snapshot đã tải xuống; baseline CHƯA cập nhật để tránh bỏ sót thay đổi. Kéo file vào chat hoặc thử lại.',
          'warning'
        );
      }
    } catch (error) {
      if (error && error.name === 'AbortError') {
        state.button.textContent = '📂 Upload source';
        setStatus('Đã hủy chọn thư mục.');
      } else {
        console.error('[Local Source Snapshot]', error);
        state.button.textContent = '📂 Thử lại';
        setStatus(error instanceof Error ? error.message : String(error), 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  function mount() {
    if (state.host && document.documentElement.contains(state.host)) return;

    const host = document.createElement('div');
    host.id = 'codexpro-local-source-reader';
    host.style.cssText = 'position:fixed;right:18px;bottom:86px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .panel{font:12px/1.35 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:rgba(20,20,20,.96);color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:8px;box-shadow:0 10px 30px rgba(0,0,0,.28);max-width:330px}
      .actions{display:flex;gap:6px;align-items:stretch}
      button{all:unset;box-sizing:border-box;cursor:pointer;background:#fff;color:#111;border-radius:9px;padding:9px 12px;font-weight:700;display:block;text-align:center;min-width:155px}
      button.secondary{min-width:auto;background:#2d2d2d;color:#ddd;border:1px solid rgba(255,255,255,.14);font-weight:600}
      button:hover{background:#ececec} button.secondary:hover{background:#3a3a3a} button:disabled{opacity:.65;cursor:wait}
      .status{margin-top:7px;color:#b9b9b9;max-width:310px;word-break:break-word}
      .status[data-kind="success"]{color:#a7f3d0}.status[data-kind="warning"]{color:#fde68a}.status[data-kind="error"]{color:#fca5a5}
    `;

    const panel = document.createElement('div');
    panel.className = 'panel';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '📂 Upload source';
    button.title = 'Lần đầu: full source. Lần sau: chỉ file thay đổi.';
    button.addEventListener('click', () => handleClick({ forceFull: false }));
    const fullButton = document.createElement('button');
    fullButton.type = 'button';
    fullButton.className = 'secondary';
    fullButton.textContent = 'Full lại';
    fullButton.title = 'Upload lại toàn bộ source và đặt lại baseline, ví dụ khi chuyển sang chat mới.';
    fullButton.addEventListener('click', () => handleClick({ forceFull: true }));
    const status = document.createElement('div');
    status.className = 'status';
    status.id = STATUS_ID;
    status.textContent = 'Read-only · lần đầu full · lần sau chỉ file đổi';

    actions.append(button, fullButton);
    panel.append(actions, status);
    shadow.append(style, panel);
    document.documentElement.appendChild(host);

    state.host = host;
    state.button = button;
    state.fullButton = fullButton;
    state.status = status;
  }

  mount();

  const observer = new MutationObserver(() => {
    if (!state.host || !document.documentElement.contains(state.host)) mount();
  });
  observer.observe(document.documentElement, { childList: true });
})();
