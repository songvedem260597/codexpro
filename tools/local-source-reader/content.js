(() => {
  if (window.__CODEXPRO_LOCAL_SOURCE_READER__) return;
  window.__CODEXPRO_LOCAL_SOURCE_READER__ = true;

  const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
  const MAX_FILE_BYTES = 3 * 1024 * 1024;
  const MAX_FILES = 5000;
  const STATUS_ID = 'codexpro-local-source-status';
  const BASELINE_STORAGE_KEY = 'codexproLocalSourceReaderBaselinesV2';
  const BASELINE_VERSION = 2;
  const HISTORY_DB_NAME = 'codexproLocalSourceReaderV2';
  const HISTORY_DB_VERSION = 1;
  const HISTORY_STORE = 'snapshots';
  const HISTORY_LIMIT_PER_PROJECT = 12;
  const UPLOAD_TIMEOUT_MS = 120000;
  const NETWORK_GLOBAL_KEY = '__CODEXPRO_LOCAL_SOURCE_UPLOAD_NETWORK_V1__';

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
    changesButton: null,
    fullButton: null,
    historyButton: null,
    history: null,
    status: null,
    lastProjectName: ''
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
      console.warn('[Local Source Snapshot] could not persist confirmed baseline', error);
      return false;
    }
  }

  function openHistoryDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB không khả dụng; không thể lưu lịch sử snapshot.'));
        return;
      }
      const request = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        let store;
        if (!db.objectStoreNames.contains(HISTORY_STORE)) {
          store = db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
        } else {
          store = request.transaction.objectStore(HISTORY_STORE);
        }
        if (!store.indexNames.contains('projectKey')) store.createIndex('projectKey', 'projectKey', { unique: false });
        if (!store.indexNames.contains('createdAtMs')) store.createIndex('createdAtMs', 'createdAtMs', { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Không mở được IndexedDB.'));
    });
  }

  async function withHistoryStore(mode, run) {
    const db = await openHistoryDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE, mode);
        const store = tx.objectStore(HISTORY_STORE);
        let result;
        try { result = run(store, tx); }
        catch (error) { reject(error); return; }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction thất bại.'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction bị hủy.'));
      });
    } finally {
      db.close();
    }
  }

  async function putHistory(record) {
    await withHistoryStore('readwrite', (store) => { store.put(record); });
    await pruneHistory(record.projectKey);
    return record;
  }

  async function getHistory(id) {
    const db = await openHistoryDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE, 'readonly');
        const request = tx.objectStore(HISTORY_STORE).get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('Không đọc được history item.'));
      });
    } finally {
      db.close();
    }
  }

  async function listHistory(projectName = '', limit = 20) {
    const projectKey = projectStorageKey(projectName);
    const db = await openHistoryDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE, 'readonly');
        const store = tx.objectStore(HISTORY_STORE);
        const request = projectKey ? store.index('projectKey').getAll(projectKey) : store.getAll();
        request.onsuccess = () => {
          const rows = Array.isArray(request.result) ? request.result : [];
          rows.sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
          resolve(rows.slice(0, Math.max(1, limit)));
        };
        request.onerror = () => reject(request.error || new Error('Không đọc được lịch sử upload.'));
      });
    } finally {
      db.close();
    }
  }

  async function pruneHistory(projectKey) {
    if (!projectKey) return;
    const db = await openHistoryDb();
    try {
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE, 'readonly');
        const request = tx.objectStore(HISTORY_STORE).index('projectKey').getAll(projectKey);
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
        request.onerror = () => reject(request.error || new Error('Không đọc được lịch sử để dọn.'));
      });
      rows.sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
      const stale = rows.slice(HISTORY_LIMIT_PER_PROJECT);
      if (!stale.length) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE, 'readwrite');
        const store = tx.objectStore(HISTORY_STORE);
        for (const item of stale) store.delete(item.id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Không dọn được lịch sử cũ.'));
      });
    } finally {
      db.close();
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
    for (const button of [state.changesButton, state.fullButton, state.historyButton]) {
      if (button) button.disabled = busy;
    }
    if (busy && state.changesButton) state.changesButton.textContent = label;
  }

  function resetButtonLabels() {
    if (state.changesButton) state.changesButton.textContent = 'Upload thay đổi';
    if (state.fullButton) state.fullButton.textContent = 'Upload Full';
    if (state.historyButton) state.historyButton.textContent = 'Lịch sử';
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
    const mode = options.mode === 'FULL' ? 'FULL' : 'DELTA';
    const confirmedBaseline = options.baseline || null;
    if (mode === 'DELTA' && !confirmedBaseline) throw new Error('Chưa có baseline đã được ChatGPT xác nhận. Hãy bấm Upload Full trước.');

    const previousFiles = confirmedBaseline?.files && typeof confirmedBaseline.files === 'object' ? confirmedBaseline.files : {};
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
      if (mode === 'FULL' || !file || metadataChanged(previous, file)) blockedChanges.push(`${path} [${reason}]`);
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

    const deleted = mode === 'DELTA'
      ? Object.keys(previousFiles).filter((path) => !seenSourcePaths.has(path)).sort((a, b) => a.localeCompare(b))
      : [];

    const previousRevision = Number(confirmedBaseline?.revision) || 0;
    const nextRevision = previousRevision + 1;
    const nextFiles = mode === 'FULL' ? { ...currentFiles } : { ...previousFiles, ...currentFiles };
    for (const path of deleted) delete nextFiles[path];

    const nextBaseline = {
      version: BASELINE_VERSION,
      projectName: rootHandle.name,
      revision: nextRevision,
      updatedAt: new Date().toISOString(),
      confirmedAt: '',
      confirmedSnapshotId: '',
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
        previousRevision,
        nextRevision,
        baseline: confirmedBaseline
      };
    }

    const header = mode === 'FULL'
      ? [
          'LOCAL SOURCE SNAPSHOT',
          `Project: ${rootHandle.name}`,
          `Created: ${new Date().toISOString()}`,
          'Mode: FULL BASELINE / READ-ONLY',
          `Previous confirmed baseline revision: ${previousRevision}`,
          `Candidate baseline revision: ${nextRevision}`,
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
          `Previous confirmed baseline revision: ${previousRevision}`,
          `Candidate baseline revision: ${nextRevision}`,
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
    for (const item of changed) chunks.push(`===== FILE: ${item.path} =====\n${item.text}\n===== END FILE: ${item.path} =====\n`);
    chunks.push('===== SOURCE CONTENT END =====\n');

    const suffix = mode === 'FULL' ? `local-source-full-r${nextRevision}` : `local-source-delta-r${nextRevision}`;
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

  function networkMonitor() {
    const monitor = globalThis[NETWORK_GLOBAL_KEY];
    if (!monitor || typeof monitor.waitForSnapshot !== 'function') {
      throw new Error('Network monitor chưa được nạp. Reload extension và reload ChatGPT trước khi upload.');
    }
    return monitor;
  }

  async function attachAndConfirm(file) {
    const monitor = networkMonitor();
    const startedAt = Date.now() - 100;
    const attached = await attachToChatGPT(file);
    if (!attached) throw new Error('ChatGPT chưa nhận được file vào composer. Baseline chưa thay đổi.');
    setStatus(`Đã attach ${file.name}. Đang chờ ChatGPT network xác nhận upload…`);
    return await monitor.waitForSnapshot(file, startedAt, UPLOAD_TIMEOUT_MS);
  }

  function historyId() {
    return `${Date.now().toString(36)}-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
  }

  function snapshotSummary(snapshot) {
    return snapshot.mode === 'FULL'
      ? `${snapshot.changedCount} files full · ${formatBytes(snapshot.changedTextBytes)}`
      : `${snapshot.changedCount} file đổi/mới · ${snapshot.deletedCount} file xóa · ${formatBytes(snapshot.changedTextBytes)}`;
  }

  function createHistoryRecord(projectName, snapshot) {
    const id = historyId();
    return {
      id,
      projectName,
      projectKey: projectStorageKey(projectName),
      mode: snapshot.mode,
      status: 'pending',
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
      updatedAt: new Date().toISOString(),
      fileName: snapshot.file.name,
      mimeType: snapshot.file.type || 'text/plain',
      fileSize: snapshot.file.size,
      fileBlob: snapshot.file.slice(0, snapshot.file.size, snapshot.file.type || 'text/plain'),
      summary: snapshotSummary(snapshot),
      fileCount: snapshot.fileCount,
      changedCount: snapshot.changedCount,
      deletedCount: snapshot.deletedCount,
      blockedChangeCount: snapshot.blockedChangeCount || 0,
      previousRevision: snapshot.previousRevision,
      nextRevision: snapshot.nextRevision,
      candidateBaseline: snapshot.nextBaseline,
      network: null,
      error: '',
      retryCount: 0,
      lastRetryAt: '',
      lastRetryNetwork: null
    };
  }

  function confirmedBaselineFromRecord(record, network) {
    return {
      ...(record.candidateBaseline || {}),
      version: BASELINE_VERSION,
      projectName: record.projectName,
      revision: Number(record.nextRevision) || Number(record.candidateBaseline?.revision) || 1,
      confirmedAt: new Date().toISOString(),
      confirmedSnapshotId: record.id,
      confirmedEndpoint: String(network?.endpoint || ''),
      confirmedFileId: String(network?.fileId || '')
    };
  }

  function canAdvanceBaselineFromRecord(record) {
    const current = loadBaseline(record.projectName);
    const currentRevision = Number(current?.revision) || 0;
    return currentRevision === Number(record.previousRevision || 0);
  }

  async function markRecordFailed(record, error) {
    record.status = 'failed';
    record.updatedAt = new Date().toISOString();
    record.error = String(error?.message || error || 'Upload failed');
    await putHistory(record).catch(() => {});
  }

  async function markRecordConfirmed(record, network, options = {}) {
    record.status = 'confirmed';
    record.updatedAt = new Date().toISOString();
    record.confirmedAt = new Date().toISOString();
    record.network = network;
    record.error = '';

    let baselineSaved = true;
    let baselineAdvanced = false;
    if (options.advanceBaseline !== false) {
      if (!canAdvanceBaselineFromRecord(record)) {
        baselineSaved = false;
      } else {
        baselineSaved = saveBaseline(record.projectName, confirmedBaselineFromRecord(record, network));
        baselineAdvanced = baselineSaved;
      }
    }

    record.baselineAdvanced = baselineAdvanced;
    record.baselineAdvanceSkipped = options.advanceBaseline !== false && !baselineAdvanced;
    await putHistory(record);
    return { baselineSaved, baselineAdvanced };
  }

  async function handleUpload(mode) {
    if (state.busy) return;
    const full = mode === 'FULL';
    setBusy(true, full ? 'Đang tạo Full…' : 'Đang tìm thay đổi…');
    setStatus(full ? 'Chọn project để upload toàn bộ source.' : 'Chọn project để upload chỉ những file khác với baseline đã xác nhận.');

    let record = null;
    try {
      if (typeof window.showDirectoryPicker !== 'function') throw new Error('Chrome/Edge hiện tại không hỗ trợ showDirectoryPicker trong trang này.');

      const rootHandle = await window.showDirectoryPicker({ mode: 'read' });
      state.lastProjectName = rootHandle.name;
      const confirmedBaseline = loadBaseline(rootHandle.name);
      if (!full && !confirmedBaseline) throw new Error(`Chưa có baseline đã xác nhận cho ${rootHandle.name}. Bấm Upload Full trước.`);

      setStatus(full
        ? `Đang quét FULL ${rootHandle.name}${confirmedBaseline ? ` từ baseline r${confirmedBaseline.revision}` : ''}…`
        : `Baseline đã xác nhận r${confirmedBaseline.revision}. Đang tìm file thay đổi trong ${rootHandle.name}…`);

      const snapshot = await buildSnapshot(rootHandle, { mode, baseline: confirmedBaseline });
      if (snapshot.fileCount === 0) throw new Error('Không tìm thấy source text phù hợp sau khi lọc.');

      if (snapshot.unchanged) {
        if (state.changesButton) state.changesButton.textContent = '✓ 0 file thay đổi';
        setStatus(`${snapshot.fileCount} source files · 0 file thay đổi so với baseline đã xác nhận r${snapshot.previousRevision}.`, 'success');
        return;
      }

      record = createHistoryRecord(rootHandle.name, snapshot);
      await putHistory(record);
      await renderHistory();

      setStatus(`${record.summary} · snapshot đã lưu lịch sử · đang attach…`);
      const network = await attachAndConfirm(snapshot.file);
      const result = await markRecordConfirmed(record, network, { advanceBaseline: true });

      if (!result.baselineAdvanced) {
        throw new Error('Upload đã được ChatGPT xác nhận nhưng baseline đã thay đổi bởi một snapshot khác. Không ghi đè baseline cũ; xem Lịch sử để kiểm tra.');
      }

      if (full && state.fullButton) state.fullButton.textContent = '✓ Full đã xác nhận';
      if (!full && state.changesButton) state.changesButton.textContent = '✓ Changes đã xác nhận';
      setStatus(`${record.summary} · ChatGPT network SUCCESS · baseline r${record.nextRevision} đã xác nhận · có thể upload thay đổi tiếp theo.`, 'success');
      await renderHistory();
    } catch (error) {
      if (record && record.status !== 'confirmed') await markRecordFailed(record, error);
      if (error?.name === 'AbortError') {
        setStatus('Đã hủy chọn thư mục.');
      } else {
        console.error('[Local Source Snapshot]', error);
        setStatus(`${error instanceof Error ? error.message : String(error)} Baseline đã xác nhận vẫn giữ nguyên.`, 'error');
      }
      await renderHistory().catch(() => {});
    } finally {
      setBusy(false);
      setTimeout(resetButtonLabels, 1800);
    }
  }

  async function reuploadHistory(id) {
    if (state.busy) return;
    setBusy(true, 'Đang upload lại…');
    try {
      const record = await getHistory(id);
      if (!record || !record.fileBlob || !record.fileName) throw new Error('Snapshot lịch sử không còn dữ liệu để upload lại.');

      record.retryCount = Number(record.retryCount || 0) + 1;
      record.lastRetryAt = new Date().toISOString();
      record.updatedAt = new Date().toISOString();
      await putHistory(record);

      const file = new File([record.fileBlob], record.fileName, { type: record.mimeType || 'text/plain' });
      setStatus(`Upload lại ${record.fileName} từ lịch sử. Đang chờ ChatGPT network xác nhận…`);
      const network = await attachAndConfirm(file);
      record.lastRetryNetwork = network;
      record.lastRetryConfirmedAt = new Date().toISOString();

      const wasConfirmed = record.status === 'confirmed';
      if (wasConfirmed) {
        record.updatedAt = new Date().toISOString();
        record.error = '';
        await putHistory(record);
        setStatus(`Upload lại thành công · ChatGPT network SUCCESS · baseline không đổi r${loadBaseline(record.projectName)?.revision || record.nextRevision}.`, 'success');
      } else if (canAdvanceBaselineFromRecord(record)) {
        const result = await markRecordConfirmed(record, network, { advanceBaseline: true });
        if (!result.baselineAdvanced) throw new Error('Snapshot upload lại đã thành công nhưng không thể cập nhật baseline.');
        setStatus(`Retry thành công · snapshot #${record.nextRevision} đã được xác nhận · baseline hiện là r${record.nextRevision}.`, 'success');
      } else {
        record.status = 'confirmed';
        record.baselineAdvanced = false;
        record.baselineAdvanceSkipped = true;
        record.network = network;
        record.error = '';
        record.updatedAt = new Date().toISOString();
        await putHistory(record);
        setStatus('Snapshot lịch sử đã upload lại thành công nhưng baseline mới hơn đang tồn tại, nên không rollback baseline.', 'warning');
      }
      await renderHistory();
    } catch (error) {
      setStatus(`${error instanceof Error ? error.message : String(error)} Baseline không thay đổi.`, 'error');
    } finally {
      setBusy(false);
      resetButtonLabels();
    }
  }

  function statusGlyph(status) {
    if (status === 'confirmed') return '✓';
    if (status === 'failed') return '!';
    return '…';
  }

  async function renderHistory() {
    if (!state.history) return;
    let rows = [];
    try { rows = await listHistory('', 20); }
    catch (error) {
      state.history.innerHTML = `<div class="history-empty">Không đọc được lịch sử: ${escapeHtml(error?.message || error)}</div>`;
      return;
    }

    if (!rows.length) {
      state.history.innerHTML = '<div class="history-empty">Chưa có snapshot upload nào.</div>';
      return;
    }

    state.history.innerHTML = rows.map((row) => {
      const revision = `r${Number(row.previousRevision || 0)}→r${Number(row.nextRevision || 0)}`;
      const when = row.createdAt ? new Date(row.createdAt).toLocaleString() : '';
      const retry = Number(row.retryCount || 0) ? ` · retry ${row.retryCount}` : '';
      const network = row.network?.endpoint ? ` · ${escapeHtml(row.network.endpoint)}` : '';
      const err = row.error ? `<div class="history-error">${escapeHtml(row.error)}</div>` : '';
      return `<div class="history-row" data-status="${escapeHtml(row.status || 'pending')}">
        <div class="history-head"><strong>${statusGlyph(row.status)} ${escapeHtml(row.mode || '')} ${revision}</strong><span>${escapeHtml(when)}</span></div>
        <div>${escapeHtml(row.projectName || '')} · ${escapeHtml(row.summary || formatBytes(row.fileSize || 0))}${retry}${network}</div>
        ${err}
        <button class="history-retry" type="button" data-history-id="${escapeHtml(row.id)}">Upload lại</button>
      </div>`;
    }).join('');

    state.history.querySelectorAll('[data-history-id]').forEach((button) => {
      button.addEventListener('click', () => reuploadHistory(button.getAttribute('data-history-id')));
    });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function toggleHistory() {
    if (!state.history) return;
    const open = state.history.hidden;
    state.history.hidden = !open;
    if (open) void renderHistory();
  }

  function describePersistedState() {
    const entries = Object.values(readBaselineStore()).filter((entry) => entry?.version === BASELINE_VERSION);
    if (!entries.length) return 'Chưa có baseline network-confirmed · hãy Upload Full trước';
    entries.sort((a, b) => Date.parse(String(b.confirmedAt || b.updatedAt || '')) - Date.parse(String(a.confirmedAt || a.updatedAt || '')));
    const latest = entries[0];
    return `Baseline đã xác nhận: ${latest.projectName || 'project'} r${latest.revision || 1} · Upload thay đổi luôn so với baseline này`;
  }

  function mount() {
    if (state.host && document.documentElement.contains(state.host)) return;

    const host = document.createElement('div');
    host.id = 'codexpro-local-source-reader';
    host.style.cssText = 'position:fixed;right:18px;bottom:86px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .panel{font:12px/1.35 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:rgba(20,20,20,.97);color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:8px;box-shadow:0 10px 30px rgba(0,0,0,.28);max-width:430px}
      .actions{display:flex;gap:6px;align-items:stretch;flex-wrap:wrap}
      button{all:unset;box-sizing:border-box;cursor:pointer;background:#fff;color:#111;border-radius:9px;padding:9px 12px;font-weight:700;display:block;text-align:center}
      button.primary{min-width:150px}
      button.secondary{background:#2d2d2d;color:#ddd;border:1px solid rgba(255,255,255,.14);font-weight:600}
      button:hover{background:#ececec} button.secondary:hover{background:#3a3a3a} button:disabled{opacity:.65;cursor:wait}
      .status{margin-top:7px;color:#b9b9b9;max-width:410px;word-break:break-word}
      .status[data-kind="success"]{color:#a7f3d0}.status[data-kind="warning"]{color:#fde68a}.status[data-kind="error"]{color:#fca5a5}
      .history{margin-top:8px;border-top:1px solid rgba(255,255,255,.12);padding-top:6px;max-height:300px;overflow:auto}
      .history-row{padding:7px;border-radius:8px;background:rgba(255,255,255,.05);margin-top:6px;color:#d8d8d8}
      .history-row[data-status="confirmed"]{border-left:3px solid #6ee7b7}.history-row[data-status="failed"]{border-left:3px solid #fca5a5}.history-row[data-status="pending"]{border-left:3px solid #fde68a}
      .history-head{display:flex;justify-content:space-between;gap:10px}.history-head span{color:#888;font-size:10px}.history-error{color:#fca5a5;margin-top:4px;word-break:break-word}.history-empty{color:#999;padding:6px}
      .history-retry{margin-top:6px;padding:5px 8px;background:#303030;color:#eee;border:1px solid rgba(255,255,255,.12);font-size:11px}
    `;

    const panel = document.createElement('div');
    panel.className = 'panel';
    const actions = document.createElement('div');
    actions.className = 'actions';

    const changesButton = document.createElement('button');
    changesButton.type = 'button';
    changesButton.className = 'primary';
    changesButton.textContent = 'Upload thay đổi';
    changesButton.title = 'Chỉ upload file khác với baseline đã được ChatGPT network xác nhận.';
    changesButton.addEventListener('click', () => handleUpload('DELTA'));

    const fullButton = document.createElement('button');
    fullButton.type = 'button';
    fullButton.className = 'secondary';
    fullButton.textContent = 'Upload Full';
    fullButton.title = 'Upload toàn bộ source. Baseline chỉ đổi sau khi ChatGPT xác nhận network success.';
    fullButton.addEventListener('click', () => handleUpload('FULL'));

    const historyButton = document.createElement('button');
    historyButton.type = 'button';
    historyButton.className = 'secondary';
    historyButton.textContent = 'Lịch sử';
    historyButton.title = 'Xem snapshot cũ và upload lại đúng snapshot đó.';
    historyButton.addEventListener('click', toggleHistory);

    const status = document.createElement('div');
    status.className = 'status';
    status.id = STATUS_ID;
    status.textContent = describePersistedState();

    const history = document.createElement('div');
    history.className = 'history';
    history.hidden = true;

    actions.append(changesButton, fullButton, historyButton);
    panel.append(actions, status, history);
    shadow.append(style, panel);
    document.documentElement.appendChild(host);

    state.host = host;
    state.changesButton = changesButton;
    state.fullButton = fullButton;
    state.historyButton = historyButton;
    state.status = status;
    state.history = history;
  }

  mount();

  const observer = new MutationObserver(() => {
    if (!state.host || !document.documentElement.contains(state.host)) mount();
  });
  observer.observe(document.documentElement, { childList: true });
})();
