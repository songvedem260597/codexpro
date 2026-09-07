(() => {
  const GLOBAL_KEY = '__CODEXPRO_LOCAL_SOURCE_UPLOAD_NETWORK_V1__';
  if (globalThis[GLOBAL_KEY]) return;

  const MAX_EVENTS = 300;
  const events = [];
  const waiters = new Set();
  const nativeFetch = globalThis.fetch?.bind(globalThis);
  const NativeXHR = globalThis.XMLHttpRequest;

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

  function parseJson(text) {
    if (!text || typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function bodyObject(body) {
    if (!body) return null;
    if (typeof body === 'string') return parseJson(body);
    if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
    return null;
  }

  async function fetchBodyObject(input, init) {
    const direct = bodyObject(init?.body);
    if (direct) return direct;
    try {
      if (typeof Request !== 'undefined' && input instanceof Request && !init?.body) return parseJson(await input.clone().text());
    } catch (_) {}
    return null;
  }

  function parseProcessStream(text) {
    const parsed = [];
    let final = null;
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      const value = parseJson(raw);
      if (!value) continue;
      parsed.push(value);
      final = value;
    }
    const success = parsed.some((value) => String(value?.status || '').toLowerCase() === 'success');
    const failure = parsed.find((value) => /^(?:failed|error|cancelled|canceled)$/i.test(String(value?.status || '')) || value?.error);
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

  const normalizeName = (value) => String(value || '').trim().toLocaleLowerCase();
  const createPath = (path) => path === '/backend-api/files' || path === '/backend-anon/files';
  const processPath = (path) => /\/(?:backend-api|backend-anon)\/files\/process_upload_stream$/.test(path);
  const uploadedPath = (path) => path.match(/\/(?:backend-api|backend-anon)\/files\/([^/]+)\/uploaded$/);
  const reusePath = (path) => /\/(?:backend-api|backend-anon)\/files\/library\/reuse$/.test(path);

  async function inspectFetchResponse(url, method, requestBody, response) {
    const path = pathname(url);
    const statusCode = Number(response?.status) || 0;
    const ok = Boolean(response?.ok);
    try {
      if (method === 'POST' && createPath(path)) {
        const payload = await response.clone().json().catch(() => null);
        const fileId = String(payload?.file_id || payload?.id || '');
        const fileName = String(requestBody?.file_name || requestBody?.fileName || payload?.file_name || '');
        const fileSize = Number(requestBody?.file_size ?? requestBody?.fileSize ?? payload?.file_size ?? 0) || 0;
        record({ kind: ok && fileId ? 'created' : 'failed', endpoint: path, fileId, fileName, fileSize, statusCode, explicitStatus: String(payload?.status || ''), error: ok && fileId ? '' : `create upload HTTP ${statusCode}` });
        return;
      }

      if (method === 'POST' && processPath(path)) {
        const text = await response.clone().text().catch(() => '');
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
        const payload = await response.clone().json().catch(() => null);
        const fileId = decodeURIComponent(uploaded[1]);
        const fileName = String(requestBody?.file_name || requestBody?.fileName || payload?.file_name || '');
        const explicitStatus = String(payload?.status || '').toLowerCase();
        if (ok && explicitStatus === 'success') record({ kind: 'confirmed', endpoint: path, fileId, fileName, statusCode, explicitStatus });
        else record({ kind: ok ? 'processed-unconfirmed' : 'failed', endpoint: path, fileId, fileName, statusCode, explicitStatus, error: ok ? '' : `uploaded finalize HTTP ${statusCode}` });
        return;
      }

      if (method === 'POST' && reusePath(path)) {
        const text = await response.clone().text().catch(() => '');
        const payload = parseJson(text);
        const explicitStatus = String(payload?.status || '').toLowerCase();
        const fileId = String(payload?.file_id || payload?.id || requestBody?.file_id || requestBody?.fileId || '');
        const fileName = String(requestBody?.file_name || requestBody?.fileName || payload?.file_name || '');
        if (ok && explicitStatus === 'success') record({ kind: 'confirmed', endpoint: path, fileId, fileName, statusCode, explicitStatus, reused: true });
        else if (!ok) record({ kind: 'failed', endpoint: path, fileId, fileName, statusCode, explicitStatus, error: `library reuse HTTP ${statusCode}` });
      }
    } catch (error) {
      record({ kind: 'monitor-error', endpoint: path, statusCode, error: String(error?.message || error) });
    }
  }

  if (nativeFetch) {
    globalThis.fetch = async function codexproTrackedFetch(input, init) {
      const url = absoluteUrl(input);
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const bodyPromise = fetchBodyObject(input, init);
      let response;
      try { response = await nativeFetch(input, init); }
      catch (error) {
        const path = pathname(url);
        if (createPath(path) || processPath(path) || uploadedPath(path) || reusePath(path)) {
          const requestBody = await bodyPromise.catch(() => null);
          record({ kind: 'failed', endpoint: path, fileId: String(requestBody?.file_id || requestBody?.fileId || ''), fileName: String(requestBody?.file_name || requestBody?.fileName || ''), fileSize: Number(requestBody?.file_size ?? requestBody?.fileSize ?? 0) || 0, statusCode: 0, error: String(error?.message || error) });
        }
        throw error;
      }
      const requestBody = await bodyPromise.catch(() => null);
      void inspectFetchResponse(url, method, requestBody, response);
      return response;
    };
  }

  if (NativeXHR?.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function codexproTrackedOpen(method, url, ...rest) {
      this.__codexproUploadMethod = String(method || 'GET').toUpperCase();
      this.__codexproUploadUrl = absoluteUrl(url);
      return nativeOpen.call(this, method, url, ...rest);
    };
    NativeXHR.prototype.send = function codexproTrackedSend(body) {
      const requestBody = bodyObject(body);
      const url = this.__codexproUploadUrl || '';
      const method = this.__codexproUploadMethod || 'GET';
      const path = pathname(url);
      const relevant = createPath(path) || processPath(path) || uploadedPath(path) || reusePath(path);
      if (relevant) {
        this.addEventListener('loadend', () => {
          const statusCode = Number(this.status) || 0;
          const ok = statusCode >= 200 && statusCode < 300;
          let text = '';
          try { text = typeof this.responseText === 'string' ? this.responseText : ''; } catch (_) {}
          const fakeResponse = { status: statusCode, ok, clone() { return { async json() { return parseJson(text); }, async text() { return text; } }; } };
          void inspectFetchResponse(url, method, requestBody, fakeResponse);
        }, { once: true });
      }
      return nativeSend.call(this, body);
    };
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

    while (now() < deadline) {
      const recent = events.filter((event) => Number(event.at) >= Number(startedAt || 0));
      const created = recent.find((event) => event.kind === 'created' && normalizeName(event.fileName) === expectedName && (!expectedSize || !event.fileSize || Number(event.fileSize) === expectedSize));
      if (created?.fileId) matchedFileId = String(created.fileId);

      const failed = [...recent].reverse().find((event) => {
        if (event.kind !== 'failed') return false;
        if (matchedFileId && event.fileId) return String(event.fileId) === matchedFileId;
        return expectedName && normalizeName(event.fileName) === expectedName;
      });
      if (failed) throw new Error(`ChatGPT upload thất bại tại ${failed.endpoint || 'network'}: ${failed.error || `HTTP ${failed.statusCode}`}`);

      const confirmed = [...recent].reverse().find((event) => {
        if (event.kind !== 'confirmed') return false;
        if (matchedFileId && event.fileId) return String(event.fileId) === matchedFileId;
        return expectedName && normalizeName(event.fileName) === expectedName;
      });
      if (confirmed) return { ok: true, fileId: String(confirmed.fileId || matchedFileId || ''), endpoint: String(confirmed.endpoint || ''), statusCode: Number(confirmed.statusCode) || 0, reused: Boolean(confirmed.reused), confirmedAt: new Date(confirmed.at).toISOString() };

      await waitForChange(Math.min(1000, Math.max(1, deadline - now())));
    }

    throw new Error('ChatGPT chưa trả network success cho file này. Baseline vẫn giữ nguyên; có thể bấm Upload thay đổi lần nữa hoặc Upload lại từ lịch sử.');
  }

  globalThis[GLOBAL_KEY] = { version: 1, waitForSnapshot, events: () => events.slice(), parseProcessStream };
})();
