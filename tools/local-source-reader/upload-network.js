(() => {
  const GLOBAL_KEY = '__CODEXPRO_LOCAL_SOURCE_UPLOAD_NETWORK_V1__';
  if (globalThis[GLOBAL_KEY]?.version >= 2) return;

  const MAX_EVENTS = 300;
  const MAX_DIAGNOSTICS = 400;
  const DIAGNOSTIC_STORAGE_KEY = 'codexproLocalSourceUploadDiagnosticsV1';
  const events = [];
  const waiters = new Set();
  const nativeFetch = globalThis.fetch?.bind(globalThis);
  const NativeXHR = globalThis.XMLHttpRequest;
  const nativeOpen = NativeXHR?.prototype?.open;
  const nativeSend = NativeXHR?.prototype?.send;
  let patchedFetch = null;
  let patchedOpen = null;
  let patchedSend = null;

  const now = () => Date.now();

  function absoluteUrl(input) {
    try {
      if (typeof input === 'string' || input instanceof URL) return new URL(String(input), location.href).href;
      if (input && typeof input.url === 'string') return new URL(input.url, location.href).href;
    } catch (_) {}
    return '';
  }

  function pathname(input) {
    try { return new URL(absoluteUrl(input) || String(input), location.href).pathname; }
    catch (_) { return ''; }
  }

  function hostOf(input) {
    try { return new URL(absoluteUrl(input) || String(input), location.href).host; }
    catch (_) { return ''; }
  }

  function parseJson(text) {
    if (!text || typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function bodyObject(body) {
    if (!body) return null;
    if (typeof body === 'string') return parseJson(body);
    if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const result = {};
      for (const [key, value] of body.entries()) {
        if (typeof value === 'string') result[key] = value;
        else if (value && typeof value === 'object') {
          result[key] = {
            name: String(value.name || ''),
            size: Number(value.size) || 0,
            type: String(value.type || '')
          };
        }
      }
      return result;
    }
    return null;
  }

  async function fetchBodyObject(input, init) {
    const direct = bodyObject(init?.body);
    if (direct) return direct;
    try {
      if (typeof Request !== 'undefined' && input instanceof Request && !init?.body) {
        const contentType = String(input.headers?.get?.('content-type') || '').toLowerCase();
        if (contentType.includes('application/json') || contentType.includes('application/x-www-form-urlencoded')) {
          const text = await input.clone().text();
          return contentType.includes('application/x-www-form-urlencoded')
            ? Object.fromEntries(new URLSearchParams(text).entries())
            : parseJson(text);
        }
      }
    } catch (_) {}
    return null;
  }

  function parseProcessStream(text) {
    const parsed = [];
    let final = null;
    for (const line of String(text || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const raw = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
      if (!raw || raw === '[DONE]') continue;
      const value = parseJson(raw);
      if (!value) continue;
      parsed.push(value);
      final = value;
    }
    const success = parsed.some((value) => {
      const status = String(value?.status || '').toLowerCase();
      const event = String(value?.event || '').toLowerCase();
      return status === 'success' || event === 'file.processing.completed';
    });
    const failure = parsed.find((value) => {
      const status = String(value?.status || '').toLowerCase();
      const event = String(value?.event || '').toLowerCase();
      return /^(?:failed|error|cancelled|canceled)$/.test(status)
        || /(?:^|\.)(?:failed|error|cancelled|canceled)$/.test(event)
        || Boolean(value?.error);
    });
    return { events: parsed, final, success, failure };
  }

  function notify() { for (const waiter of [...waiters]) waiter(); }

  function record(event) {
    const item = { at: now(), ...event };
    events.push(item);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    notify();
    return item;
  }

  function redactValue(value, key = '', depth = 0) {
    if (depth > 5) return '[depth-limit]';
    if (/token|secret|authorization|cookie|credential|signature|signed|upload_url|download_url|presign|api[_-]?key/i.test(String(key))) return '[redacted]';
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      let text = value.slice(0, 1600);
      text = text.replace(/(https?:\/\/[^\s?"']+)\?[^\s"']+/gi, '$1?[redacted-query]');
      text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
      return text;
    }
    if (Array.isArray(value)) return value.slice(0, 30).map((item) => redactValue(item, key, depth + 1));
    if (typeof value === 'object') {
      const result = {};
      for (const [childKey, childValue] of Object.entries(value).slice(0, 40)) {
        result[childKey] = redactValue(childValue, childKey, depth + 1);
      }
      return result;
    }
    return String(value);
  }

  function bodyMeta(body) {
    if (!body || typeof body !== 'object') return null;
    const keys = [
      'file_id', 'fileId', 'file_name', 'fileName', 'file_size', 'fileSize',
      'status', 'mime_type', 'mimeType', 'purpose', 'use_case', 'useCase', 'batch_id', 'batchId'
    ];
    const result = {};
    for (const key of keys) {
      if (body[key] !== undefined) result[key] = redactValue(body[key], key);
    }
    for (const [key, value] of Object.entries(body)) {
      if (value && typeof value === 'object' && typeof value.name === 'string' && Number.isFinite(Number(value.size))) {
        result[`${key}_file`] = { name: value.name, size: Number(value.size) || 0, type: String(value.type || '') };
      }
    }
    return Object.keys(result).length ? result : null;
  }

  function readPersistedDiagnostics() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DIAGNOSTIC_STORAGE_KEY) || '{}');
      return Array.isArray(parsed?.entries) ? parsed.entries.slice(-MAX_DIAGNOSTICS) : [];
    } catch (_) {
      return [];
    }
  }

  const diagnostics = readPersistedDiagnostics();
  let diagnosticSeq = diagnostics.reduce((max, entry) => Math.max(max, Number(entry?.seq) || 0), 0);

  function persistDiagnostics() {
    try {
      localStorage.setItem(DIAGNOSTIC_STORAGE_KEY, JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: diagnostics.slice(-MAX_DIAGNOSTICS)
      }));
    } catch (_) {}
  }

  function recordDiagnostic(entry) {
    const item = redactValue({
      seq: ++diagnosticSeq,
      at: new Date().toISOString(),
      atMs: now(),
      ...entry
    });
    diagnostics.push(item);
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
    persistDiagnostics();
    try { console.debug('[Local Source Upload Trace]', item); } catch (_) {}
    return item;
  }

  function clearDiagnostics() {
    diagnostics.splice(0, diagnostics.length);
    diagnosticSeq = 0;
    try { localStorage.removeItem(DIAGNOSTIC_STORAGE_KEY); } catch (_) {}
    recordDiagnostic({ type: 'diagnostics-cleared' });
  }

  function safeResponsePreview(text) {
    const raw = String(text || '');
    if (!raw) return '';
    const json = parseJson(raw);
    if (json) return redactValue(json);
    const sse = parseProcessStream(raw);
    if (sse.events.length) return redactValue({ events: sse.events.slice(-20), final: sse.final });
    return redactValue(raw);
  }

  const normalizeName = (value) => String(value || '').trim().toLocaleLowerCase();
  const createPath = (path) => path === '/backend-api/files' || path === '/backend-anon/files';
  const processPath = (path) => /\/(?:backend-api|backend-anon)\/files\/process_upload_stream$/.test(path);
  const uploadedPath = (path) => path.match(/\/(?:backend-api|backend-anon)\/files\/([^/]+)\/uploaded$/);
  const reusePath = (path) => /\/(?:backend-api|backend-anon)\/files\/library\/reuse$/.test(path);

  function isInterestingMutation(url, method) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)) return false;
    const path = pathname(url).toLowerCase();
    if (/\/(?:backend-api|backend-anon)\/(?:files|uploads)(?:\/|$)/.test(path)) return true;
    if (/(?:file|upload)/.test(path)) return true;
    try {
      const parsed = new URL(absoluteUrl(url), location.href);
      if (normalizedMethod === 'PUT' && parsed.origin !== location.origin) return true;
    } catch (_) {}
    return false;
  }

  async function inspectFetchResponse(url, method, requestBody, response, transport = 'fetch') {
    const path = pathname(url);
    const statusCode = Number(response?.status) || 0;
    const ok = Boolean(response?.ok);
    const interesting = isInterestingMutation(url, method);
    let responseText = '';
    if (interesting) {
      try { responseText = await response.clone().text().catch(() => ''); } catch (_) {}
      recordDiagnostic({
        type: 'network-response',
        transport,
        method,
        host: hostOf(url),
        endpoint: path,
        statusCode,
        ok,
        request: bodyMeta(requestBody),
        response: safeResponsePreview(responseText)
      });
    }

    try {
      if (method === 'POST' && createPath(path)) {
        const payload = responseText ? parseJson(responseText) : await response.clone().json().catch(() => null);
        const fileId = String(payload?.file_id || payload?.id || '');
        const fileName = String(requestBody?.file_name || requestBody?.fileName || payload?.file_name || '');
        const fileSize = Number(requestBody?.file_size ?? requestBody?.fileSize ?? payload?.file_size ?? 0) || 0;
        record({ kind: ok && fileId ? 'created' : 'failed', endpoint: path, fileId, fileName, fileSize, statusCode, explicitStatus: String(payload?.status || ''), error: ok && fileId ? '' : `create upload HTTP ${statusCode}` });
        return;
      }

      if (method === 'POST' && processPath(path)) {
        const text = responseText || await response.clone().text().catch(() => '');
        const stream = parseProcessStream(text);
        const fileId = String(requestBody?.file_id || requestBody?.fileId || stream.final?.file_id || stream.final?.fileId || '');
        const fileName = String(requestBody?.file_name || requestBody?.fileName || stream.final?.file_name || '');
        if (ok && stream.success) record({ kind: 'confirmed', endpoint: path, fileId, fileName, statusCode, explicitStatus: 'success' });
        else if (!ok || stream.failure) record({ kind: 'failed', endpoint: path, fileId, fileName, statusCode, explicitStatus: String(stream.failure?.status || stream.final?.status || ''), error: String(stream.failure?.error?.message || stream.failure?.error || `process upload HTTP ${statusCode}`) });
        else record({ kind: 'processed-unconfirmed', endpoint: path, fileId, fileName, statusCode, explicitStatus: String(stream.final?.status || '') });
        return;
      }

      const uploaded = method === 'POST' ? uploadedPath(path) : null;
      if (uploaded) {
        const payload = responseText ? parseJson(responseText) : await response.clone().json().catch(() => null);
        const fileId = decodeURIComponent(uploaded[1]);
        const fileName = String(requestBody?.file_name || requestBody?.fileName || payload?.file_name || '');
        const explicitStatus = String(payload?.status || '').toLowerCase();
        if (ok && explicitStatus === 'success') record({ kind: 'confirmed', endpoint: path, fileId, fileName, statusCode, explicitStatus });
        else record({ kind: ok ? 'processed-unconfirmed' : 'failed', endpoint: path, fileId, fileName, statusCode, explicitStatus, error: ok ? '' : `uploaded finalize HTTP ${statusCode}` });
        return;
      }

      if (method === 'POST' && reusePath(path)) {
        const text = responseText || await response.clone().text().catch(() => '');
        const payload = parseJson(text);
        const explicitStatus = String(payload?.status || '').toLowerCase();
        const fileId = String(payload?.file_id || payload?.id || requestBody?.file_id || requestBody?.fileId || '');
        const fileName = String(requestBody?.file_name || requestBody?.fileName || payload?.file_name || '');
        if (ok && explicitStatus === 'success') record({ kind: 'confirmed', endpoint: path, fileId, fileName, statusCode, explicitStatus, reused: true });
        else if (!ok) record({ kind: 'failed', endpoint: path, fileId, fileName, statusCode, explicitStatus, error: `library reuse HTTP ${statusCode}` });
      }
    } catch (error) {
      record({ kind: 'monitor-error', endpoint: path, statusCode, error: String(error?.message || error) });
      recordDiagnostic({ type: 'monitor-error', transport, method, host: hostOf(url), endpoint: path, statusCode, error: String(error?.message || error) });
    }
  }

  if (nativeFetch) {
    patchedFetch = async function codexproTrackedFetch(input, init) {
      const url = absoluteUrl(input);
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const bodyPromise = fetchBodyObject(input, init);
      const interesting = isInterestingMutation(url, method);
      if (interesting) {
        void bodyPromise.then((requestBody) => recordDiagnostic({
          type: 'network-request',
          transport: 'fetch',
          method,
          host: hostOf(url),
          endpoint: pathname(url),
          request: bodyMeta(requestBody)
        })).catch(() => {});
      }
      let response;
      try { response = await nativeFetch(input, init); }
      catch (error) {
        const path = pathname(url);
        const requestBody = await bodyPromise.catch(() => null);
        if (createPath(path) || processPath(path) || uploadedPath(path) || reusePath(path)) {
          record({ kind: 'failed', endpoint: path, fileId: String(requestBody?.file_id || requestBody?.fileId || ''), fileName: String(requestBody?.file_name || requestBody?.fileName || ''), fileSize: Number(requestBody?.file_size ?? requestBody?.fileSize ?? 0) || 0, statusCode: 0, error: String(error?.message || error) });
        }
        if (interesting) recordDiagnostic({ type: 'network-error', transport: 'fetch', method, host: hostOf(url), endpoint: path, request: bodyMeta(requestBody), error: String(error?.message || error) });
        throw error;
      }
      const requestBody = await bodyPromise.catch(() => null);
      void inspectFetchResponse(url, method, requestBody, response, 'fetch');
      return response;
    };
    globalThis.fetch = patchedFetch;
  }

  if (NativeXHR?.prototype && nativeOpen && nativeSend) {
    patchedOpen = function codexproTrackedOpen(method, url, ...rest) {
      this.__codexproUploadMethod = String(method || 'GET').toUpperCase();
      this.__codexproUploadUrl = absoluteUrl(url);
      return nativeOpen.call(this, method, url, ...rest);
    };
    patchedSend = function codexproTrackedSend(body) {
      const requestBody = bodyObject(body);
      const url = this.__codexproUploadUrl || '';
      const method = this.__codexproUploadMethod || 'GET';
      const path = pathname(url);
      const relevant = createPath(path) || processPath(path) || uploadedPath(path) || reusePath(path);
      const interesting = isInterestingMutation(url, method);
      if (interesting) {
        recordDiagnostic({ type: 'network-request', transport: 'xhr', method, host: hostOf(url), endpoint: path, request: bodyMeta(requestBody) });
      }
      if (relevant || interesting) {
        this.addEventListener('loadend', () => {
          const statusCode = Number(this.status) || 0;
          const ok = statusCode >= 200 && statusCode < 300;
          let text = '';
          try { text = typeof this.responseText === 'string' ? this.responseText : ''; } catch (_) {}
          const fakeResponse = { status: statusCode, ok, clone() { return { async json() { return parseJson(text); }, async text() { return text; } }; } };
          void inspectFetchResponse(url, method, requestBody, fakeResponse, 'xhr');
        }, { once: true });
      }
      return nativeSend.call(this, body);
    };
    NativeXHR.prototype.open = patchedOpen;
    NativeXHR.prototype.send = patchedSend;
  }

  function waitForChange(timeoutMs) {
    return new Promise((resolve) => {
      let timer;
      const done = () => { waiters.delete(done); if (timer) clearTimeout(timer); resolve(); };
      waiters.add(done);
      timer = setTimeout(done, Math.max(1, timeoutMs));
    });
  }

  async function waitForSnapshot(file, startedAt = now(), timeoutMs = 120000) {
    const deadline = now() + Math.max(1000, timeoutMs);
    const expectedName = normalizeName(file?.name);
    const expectedSize = Number(file?.size) || 0;
    let matchedFileId = '';

    recordDiagnostic({
      type: 'snapshot-wait-start',
      fileName: String(file?.name || ''),
      fileSize: expectedSize,
      startedAtMs: Number(startedAt) || 0,
      timeoutMs: Math.max(1000, timeoutMs),
      health: health()
    });

    while (now() < deadline) {
      const recent = events.filter((event) => Number(event.at) >= Number(startedAt || 0));
      const created = recent.find((event) => event.kind === 'created' && normalizeName(event.fileName) === expectedName && (!expectedSize || !event.fileSize || Number(event.fileSize) === expectedSize));
      if (created?.fileId && String(created.fileId) !== matchedFileId) {
        matchedFileId = String(created.fileId);
        recordDiagnostic({ type: 'snapshot-match-created', fileName: String(file?.name || ''), fileSize: expectedSize, fileId: matchedFileId, endpoint: created.endpoint, statusCode: created.statusCode });
      }

      const failed = [...recent].reverse().find((event) => {
        if (event.kind !== 'failed') return false;
        if (matchedFileId && event.fileId) return String(event.fileId) === matchedFileId;
        return expectedName && normalizeName(event.fileName) === expectedName;
      });
      if (failed) {
        recordDiagnostic({ type: 'snapshot-failed', fileName: String(file?.name || ''), fileSize: expectedSize, matchedFileId, event: failed });
        throw new Error(`ChatGPT upload thất bại tại ${failed.endpoint || 'network'}: ${failed.error || `HTTP ${failed.statusCode}`}`);
      }

      const confirmed = [...recent].reverse().find((event) => {
        if (event.kind !== 'confirmed') return false;
        if (matchedFileId && event.fileId) return String(event.fileId) === matchedFileId;
        return expectedName && normalizeName(event.fileName) === expectedName;
      });
      if (confirmed) {
        recordDiagnostic({ type: 'snapshot-confirmed', fileName: String(file?.name || ''), fileSize: expectedSize, matchedFileId, event: confirmed });
        return { ok: true, fileId: String(confirmed.fileId || matchedFileId || ''), endpoint: String(confirmed.endpoint || ''), statusCode: Number(confirmed.statusCode) || 0, reused: Boolean(confirmed.reused), confirmedAt: new Date(confirmed.at).toISOString() };
      }

      await waitForChange(Math.min(1000, Math.max(1, deadline - now())));
    }

    const recent = events.filter((event) => Number(event.at) >= Number(startedAt || 0));
    recordDiagnostic({
      type: 'snapshot-timeout',
      fileName: String(file?.name || ''),
      fileSize: expectedSize,
      matchedFileId,
      recentUploadEvents: recent.slice(-30),
      health: health()
    });
    throw new Error('ChatGPT chưa trả network success cho file này. Baseline vẫn giữ nguyên; mở Log để xuất trace điều tra rồi có thể bấm Upload lại.');
  }

  function health() {
    return {
      version: 2,
      page: location.origin,
      fetchAvailable: Boolean(nativeFetch),
      fetchHookActive: Boolean(patchedFetch && globalThis.fetch === patchedFetch),
      xhrAvailable: Boolean(NativeXHR?.prototype),
      xhrOpenHookActive: Boolean(patchedOpen && NativeXHR?.prototype?.open === patchedOpen),
      xhrSendHookActive: Boolean(patchedSend && NativeXHR?.prototype?.send === patchedSend),
      diagnosticCount: diagnostics.length,
      eventCount: events.length
    };
  }

  function exportDiagnostics() {
    return {
      format: 'codexpro-local-source-upload-diagnostics',
      version: 1,
      exportedAt: new Date().toISOString(),
      page: location.origin,
      health: health(),
      events: events.slice(),
      diagnostics: diagnostics.slice()
    };
  }

  const api = {
    version: 2,
    waitForSnapshot,
    events: () => events.slice(),
    diagnostics: () => diagnostics.slice(),
    clearDiagnostics,
    exportDiagnostics,
    health,
    parseProcessStream
  };
  globalThis[GLOBAL_KEY] = api;

  recordDiagnostic({ type: 'monitor-installed', health: health(), documentReadyState: document.readyState });
})();
