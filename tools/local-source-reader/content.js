(() => {
  if (window.__CODEXPRO_LOCAL_SOURCE_READER__) return;
  window.__CODEXPRO_LOCAL_SOURCE_READER__ = true;

  const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
  const MAX_FILE_BYTES = 3 * 1024 * 1024;
  const MAX_FILES = 5000;
  const STATUS_ID = 'codexpro-local-source-status';

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
    status: null
  };

  function normalizePath(path) {
    return path.replace(/\\/g, '/').replace(/^\.\//, '');
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

  async function buildSnapshot(rootHandle) {
    const included = [];
    const skipped = [];
    let totalBytes = 0;

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

        if (included.length >= MAX_FILES) {
          skipped.push(`${path} [file-count limit]`);
          continue;
        }
        if (!isSourceFile(entry.name, path)) continue;

        const file = await entry.getFile();
        if (file.size > MAX_FILE_BYTES) {
          skipped.push(`${path} [too large: ${formatBytes(file.size)}]`);
          continue;
        }
        if (totalBytes + file.size > MAX_TOTAL_BYTES) {
          skipped.push(`${path} [snapshot size limit]`);
          continue;
        }
        if (await looksBinary(file)) {
          skipped.push(`${path} [binary]`);
          continue;
        }

        const text = await file.text();
        const bytes = new TextEncoder().encode(text).byteLength;
        if (totalBytes + bytes > MAX_TOTAL_BYTES) {
          skipped.push(`${path} [snapshot size limit]`);
          continue;
        }

        included.push({ path, text, bytes });
        totalBytes += bytes;
        if (included.length % 20 === 0) {
          setStatus(`Đang đọc ${included.length} files · ${formatBytes(totalBytes)}…`);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }

    await walk(rootHandle);

    const header = [
      'LOCAL SOURCE SNAPSHOT',
      `Project: ${rootHandle.name}`,
      `Created: ${new Date().toISOString()}`,
      `Mode: READ-ONLY / ONE-SHOT`,
      `Included files: ${included.length}`,
      `Included text: ${formatBytes(totalBytes)}`,
      '',
      'INSTRUCTIONS FOR CHATGPT:',
      '- Treat this attachment as the current local source-of-truth.',
      '- Read/analyze this single snapshot instead of requesting file-by-file tool messages.',
      '- Do not assume omitted generated/dependency/secret files are part of the editable source.',
      '',
      'FILE TREE:',
      ...included.map((item) => item.path),
      '',
      skipped.length ? 'SKIPPED / FILTERED:' : 'SKIPPED / FILTERED: none',
      ...skipped,
      '',
      '===== SOURCE CONTENT START =====',
      ''
    ];

    const chunks = [header.join('\n')];
    for (const item of included) {
      chunks.push(`===== FILE: ${item.path} =====\n${item.text}\n===== END FILE: ${item.path} =====\n`);
    }
    chunks.push('===== SOURCE CONTENT END =====\n');

    return {
      file: new File(chunks, `${rootHandle.name}-local-source-snapshot.txt`, { type: 'text/plain' }),
      fileCount: included.length,
      totalBytes,
      skippedCount: skipped.length
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

  async function handleClick() {
    if (state.busy) return;
    state.busy = true;
    state.button.disabled = true;
    state.button.textContent = 'Đang đọc source…';
    setStatus('Chọn thư mục project local. Extension chỉ xin quyền READ.');

    try {
      if (typeof window.showDirectoryPicker !== 'function') {
        throw new Error('Chrome/Edge hiện tại không hỗ trợ showDirectoryPicker trong trang này.');
      }

      const rootHandle = await window.showDirectoryPicker({ mode: 'read' });
      setStatus(`Đang quét ${rootHandle.name}…`);
      const snapshot = await buildSnapshot(rootHandle);

      if (snapshot.fileCount === 0) {
        throw new Error('Không tìm thấy source text phù hợp sau khi lọc.');
      }

      setStatus(`Đã gom ${snapshot.fileCount} files. Đang attach 1 file duy nhất…`);
      const attached = await attachToChatGPT(snapshot.file);

      if (attached) {
        state.button.textContent = '✓ Source đã attach';
        setStatus(
          `${snapshot.fileCount} files · ${formatBytes(snapshot.totalBytes)} · 1 attachment · không gửi chat trung gian`,
          'success'
        );
      } else {
        downloadFallback(snapshot.file);
        state.button.textContent = 'Snapshot đã tạo';
        setStatus(
          'ChatGPT đổi UI nên auto-attach chưa tìm thấy input. Snapshot đã tải xuống; kéo đúng 1 file đó vào ô chat.',
          'warning'
        );
      }
    } catch (error) {
      if (error && error.name === 'AbortError') {
        state.button.textContent = '📂 Đọc source local';
        setStatus('Đã hủy chọn thư mục.');
      } else {
        console.error('[Local Source Snapshot]', error);
        state.button.textContent = '📂 Thử lại';
        setStatus(error instanceof Error ? error.message : String(error), 'error');
      }
    } finally {
      state.busy = false;
      state.button.disabled = false;
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
      .panel{font:12px/1.35 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:rgba(20,20,20,.96);color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:8px;box-shadow:0 10px 30px rgba(0,0,0,.28);max-width:310px}
      button{all:unset;box-sizing:border-box;cursor:pointer;background:#fff;color:#111;border-radius:9px;padding:9px 12px;font-weight:700;display:block;text-align:center;min-width:155px}
      button:hover{background:#ececec} button:disabled{opacity:.65;cursor:wait}
      .status{margin-top:7px;color:#b9b9b9;max-width:290px;word-break:break-word}
      .status[data-kind="success"]{color:#a7f3d0}.status[data-kind="warning"]{color:#fde68a}.status[data-kind="error"]{color:#fca5a5}
    `;

    const panel = document.createElement('div');
    panel.className = 'panel';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '📂 Đọc source local';
    button.addEventListener('click', handleClick);
    const status = document.createElement('div');
    status.className = 'status';
    status.id = STATUS_ID;
    status.textContent = 'Read-only · 1 lần · 1 attachment';

    panel.append(button, status);
    shadow.append(style, panel);
    document.documentElement.appendChild(host);

    state.host = host;
    state.button = button;
    state.status = status;
  }

  mount();

  const observer = new MutationObserver(() => {
    if (!state.host || !document.documentElement.contains(state.host)) mount();
  });
  observer.observe(document.documentElement, { childList: true });
})();
