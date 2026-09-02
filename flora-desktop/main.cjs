const { app, BrowserWindow, ipcMain, session, net, dialog, nativeImage } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const LEGACY_FLORA_PARTITION = 'persist:flora-auth';
const FLORA_MEDIA_ORIGIN = 'https://media.flora.ai';
const FLORA_CONVEX_URL = 'https://energized-vulture-906.convex.cloud';
const FLORA_CONVEX_CLIENT = 'npm-1.42.1';
const ACCOUNTS_FILE = 'flora-accounts.json';
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const selectedImages = new Map();
let mainWindow;
let loginWindow;
let loginAccountId = '';
let accountsStoreCache = null;

function randomId(prefix = '') {
  return prefix + crypto.randomBytes(18).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
}

function accountsFilePath() {
  return path.join(app.getPath('userData'), ACCOUNTS_FILE);
}

function createDefaultAccountsStore() {
  return {
    version: 1,
    activeAccountId: 'primary',
    autoSwitchOnCredits: true,
    accounts: [
      {
        id: 'primary',
        label: 'Primary account',
        email: '',
        partition: LEGACY_FLORA_PARTITION,
        authenticated: false,
        exhaustedAt: null,
        createdAt: Date.now(),
        lastUsedAt: null,
      },
    ],
  };
}

function normalizeAccountsStore(value) {
  const fallback = createDefaultAccountsStore();
  if (!value || typeof value !== 'object' || !Array.isArray(value.accounts)) return fallback;
  const seen = new Set();
  const accounts = value.accounts
    .map((account, index) => {
      const id = String(account?.id || '').trim();
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        label: String(account?.label || account?.email || `Account ${index + 1}`).trim() || `Account ${index + 1}`,
        email: String(account?.email || '').trim(),
        partition: String(account?.partition || `persist:flora-auth-${id}`).trim(),
        authenticated: Boolean(account?.authenticated),
        exhaustedAt: Number(account?.exhaustedAt) || null,
        createdAt: Number(account?.createdAt) || Date.now(),
        lastUsedAt: Number(account?.lastUsedAt) || null,
      };
    })
    .filter(Boolean);

  if (!accounts.length) return fallback;
  const requestedActive = String(value.activeAccountId || '').trim();
  return {
    version: 1,
    activeAccountId: accounts.some((account) => account.id === requestedActive) ? requestedActive : accounts[0].id,
    autoSwitchOnCredits: value.autoSwitchOnCredits !== false,
    accounts,
  };
}

function loadAccountsStore() {
  if (accountsStoreCache) return accountsStoreCache;
  try {
    const raw = fs.readFileSync(accountsFilePath(), 'utf8');
    accountsStoreCache = normalizeAccountsStore(JSON.parse(raw));
  } catch {
    accountsStoreCache = createDefaultAccountsStore();
  }
  return accountsStoreCache;
}

function saveAccountsStore() {
  const store = loadAccountsStore();
  const target = accountsFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

function accountById(accountId = '') {
  const store = loadAccountsStore();
  const requested = String(accountId || '').trim();
  return store.accounts.find((account) => account.id === requested)
    || store.accounts.find((account) => account.id === store.activeAccountId)
    || store.accounts[0];
}

function requireAccountById(accountId) {
  const requested = String(accountId || '').trim();
  const account = loadAccountsStore().accounts.find((candidate) => candidate.id === requested);
  if (!account) throw new Error('FLORA account was not found.');
  return account;
}

function publicAccount(account) {
  const store = loadAccountsStore();
  return {
    id: account.id,
    label: account.label,
    email: account.email,
    authenticated: Boolean(account.authenticated),
    exhausted: Boolean(account.exhaustedAt),
    exhaustedAt: account.exhaustedAt,
    lastUsedAt: account.lastUsedAt,
    active: store.activeAccountId === account.id,
  };
}

function accountsState() {
  const store = loadAccountsStore();
  return {
    activeAccountId: store.activeAccountId,
    autoSwitchOnCredits: store.autoSwitchOnCredits !== false,
    accounts: store.accounts.map(publicAccount),
  };
}

function notifyAccountsChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('flora:accounts-changed', accountsState());
  mainWindow.webContents.send('flora:auth-changed');
}

function setActiveAccount(accountId) {
  const store = loadAccountsStore();
  const account = store.accounts.find((candidate) => candidate.id === String(accountId || '').trim());
  if (!account) throw new Error('FLORA account was not found.');
  store.activeAccountId = account.id;
  account.lastUsedAt = Date.now();
  saveAccountsStore();
  notifyAccountsChanged();
  return account;
}

function addAccountRecord() {
  const store = loadAccountsStore();
  const id = randomId('acct-');
  const account = {
    id,
    label: `Account ${store.accounts.length + 1}`,
    email: '',
    partition: `persist:flora-auth-${id}`,
    authenticated: false,
    exhaustedAt: null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  store.accounts.push(account);
  store.activeAccountId = id;
  saveAccountsStore();
  notifyAccountsChanged();
  return account;
}

function markAccountIdentity(account, identity = {}) {
  const email = String(identity.email || '').trim();
  const displayName = String(identity.name || '').trim();
  account.authenticated = Boolean(identity.hasSession);
  if (email) account.email = email;
  if (email) account.label = email;
  else if (displayName && /^Account \d+$/.test(account.label)) account.label = displayName;
  if (identity.hasSession) account.lastUsedAt = Date.now();
  saveAccountsStore();
}

function markAccountExhausted(account, exhausted = true) {
  account.exhaustedAt = exhausted ? Date.now() : null;
  saveAccountsStore();
  notifyAccountsChanged();
}

function removeAccountRecord(accountId) {
  const store = loadAccountsStore();
  if (store.accounts.length <= 1) throw new Error('Keep at least one FLORA account.');
  const index = store.accounts.findIndex((account) => account.id === String(accountId || '').trim());
  if (index < 0) throw new Error('FLORA account was not found.');
  const [removed] = store.accounts.splice(index, 1);
  if (store.activeAccountId === removed.id) {
    store.activeAccountId = store.accounts[Math.min(index, store.accounts.length - 1)].id;
  }
  saveAccountsStore();
  notifyAccountsChanged();
  return removed;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#0b0d12',
    title: 'FLORA Desktop Generator',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function forceMicrosoftLoginPrompt(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'login.microsoftonline.com') return url;
    if (!/^\/common\/oauth2\/v2\.0\/authorize$/i.test(parsed.pathname)) return url;
    if (parsed.searchParams.get('prompt') !== 'select_account') return url;
    parsed.searchParams.set('prompt', 'login');
    return parsed.toString();
  } catch {
    return url;
  }
}

async function clearMicrosoftLoginCookies(accountId = '') {
  const account = accountId ? requireAccountById(accountId) : accountById();
  const authSession = session.fromPartition(account.partition);
  const cookies = await authSession.cookies.get({});
  const microsoftCookies = cookies.filter((cookie) => {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    return domain === 'login.microsoftonline.com'
      || domain.endsWith('.microsoftonline.com')
      || domain === 'login.live.com'
      || domain.endsWith('.live.com');
  });

  await Promise.all(microsoftCookies.map(async (cookie) => {
    const host = String(cookie.domain || '').replace(/^\./, '');
    if (!host) return;
    const cookieUrl = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
    try {
      await authSession.cookies.remove(cookieUrl, cookie.name);
    } catch {}
  }));
}

async function clickMicrosoftSignIn(win) {
  if (!win || win.isDestroyed()) return false;
  const currentUrl = win.webContents.getURL();
  if (/^https:\/\/(?:login\.microsoftonline\.com|login\.live\.com)\//i.test(currentUrl)) return true;
  if (!currentUrl.startsWith('https://app.flora.ai/')) return false;

  try {
    return await win.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const button = [...document.querySelectorAll('button')]
            .find((candidate) => candidate.textContent?.trim() === 'Microsoft');
          if (button && !button.disabled) {
            button.click();
            return true;
          }
          await sleep(100);
        }
        return false;
      })()
    `, true);
  } catch {
    return false;
  }
}

async function readFloraIdentity(win, attempts = 40) {
  if (!win || win.isDestroyed()) return { hasSession: false, email: '', name: '' };
  const serializedAttempts = Math.max(1, Number(attempts) || 1);
  try {
    return await win.webContents.executeJavaScript(`
      (async () => {
        for (let attempt = 0; attempt < ${serializedAttempts}; attempt += 1) {
          const session = window.Clerk?.session;
          if (session?.status === 'active') {
            const user = window.Clerk?.user || session.user || null;
            const email = user?.primaryEmailAddress?.emailAddress
              || user?.emailAddresses?.[0]?.emailAddress
              || '';
            const name = user?.fullName || user?.firstName || user?.username || '';
            return { hasSession: true, email, name };
          }
          await new Promise((resolve) => setTimeout(resolve, 125));
        }
        return { hasSession: false, email: '', name: '' };
      })()
    `, true);
  } catch {
    return { hasSession: false, email: '', name: '' };
  }
}

async function syncLoginWindowAuth(win, account) {
  if (!win || win.isDestroyed()) return;
  if (!win.webContents.getURL().startsWith('https://app.flora.ai/')) return;

  const identity = await readFloraIdentity(win, 40);
  if (identity.hasSession) {
    markAccountIdentity(account, identity);
    notifyAccountsChanged();
    setTimeout(() => {
      if (win === loginWindow && !win.isDestroyed()) win.close();
    }, 250);
  }
}

async function openLoginWindow(provider = '', accountId = '') {
  const account = accountId ? requireAccountById(accountId) : accountById();
  if (provider === 'microsoft') await clearMicrosoftLoginCookies(account.id);

  if (loginWindow && !loginWindow.isDestroyed() && loginAccountId !== account.id) {
    loginWindow.close();
    loginWindow = null;
  }

  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    if (provider === 'microsoft') {
      await loginWindow.loadURL('https://app.flora.ai/');
      const started = await clickMicrosoftSignIn(loginWindow);
      return { ok: started, provider: 'microsoft', account: publicAccount(account), message: started ? '' : 'Microsoft sign in is not available on the current FLORA page.' };
    }
    return { ok: true, account: publicAccount(account) };
  }

  loginAccountId = account.id;
  loginWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    parent: mainWindow,
    modal: false,
    title: provider === 'microsoft' ? `Sign in ${account.label} with Outlook` : `Sign in ${account.label}`,
    backgroundColor: '#111318',
    webPreferences: {
      partition: account.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const redirectMicrosoftPrompt = (event, url) => {
    const normalizedUrl = forceMicrosoftLoginPrompt(url);
    if (normalizedUrl === url) return;
    event.preventDefault();
    void loginWindow.loadURL(normalizedUrl);
  };
  loginWindow.webContents.on('will-navigate', redirectMicrosoftPrompt);
  loginWindow.webContents.on('will-redirect', redirectMicrosoftPrompt);
  loginWindow.webContents.on('did-finish-load', () => {
    void syncLoginWindowAuth(loginWindow, account);
  });

  await loginWindow.loadURL('https://app.flora.ai/');
  loginWindow.on('closed', () => {
    loginWindow = null;
    loginAccountId = '';
    notifyAccountsChanged();
  });

  if (provider === 'microsoft') {
    const started = await clickMicrosoftSignIn(loginWindow);
    return { ok: started, provider: 'microsoft', account: publicAccount(account), message: started ? '' : 'Could not find the Microsoft sign-in option on FLORA.' };
  }
  return { ok: true, account: publicAccount(account) };
}

async function autoLoginWithPassword(credentials, accountId = '') {
  const account = accountId ? requireAccountById(accountId) : accountById();
  const email = String(credentials?.email || '').trim();
  const password = String(credentials?.password || '');

  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid FLORA email address.');
  if (!password) throw new Error('Enter your FLORA password.');

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: account.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    await win.loadURL('https://app.flora.ai/sign-in');
    const serializedEmail = JSON.stringify(email);
    const serializedPassword = JSON.stringify(password);
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const email = ${serializedEmail};
        const password = ${serializedPassword};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const setInputValue = (input, value) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(input, value);
          else input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const visibleText = () => document.body?.innerText || '';
        const knownError = () => {
          const text = visibleText();
          const messages = [
            'Incorrect email or password.',
            'No account found for this email.',
            'Network error. Please try again.',
            'Invalid email format.',
          ];
          return messages.find((message) => text.includes(message)) || '';
        };
        const hasSession = () => Boolean(window.Clerk?.session);
        const signInStatus = () => window.Clerk?.client?.signIn?.status || null;
        const submitForm = async (input) => {
          const form = input?.form;
          if (!form) return false;
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const submit = form.querySelector('button[type="submit"], input[type="submit"]');
            if (!submit || !submit.disabled) {
              form.requestSubmit();
              return true;
            }
            await sleep(100);
          }
          return false;
        };

        for (let attempt = 0; attempt < 120; attempt += 1) {
          if (hasSession()) return { ok: true, status: 'already_signed_in' };
          const emailInput = document.querySelector('[data-id="auth-email-input"], input[type="email"]');
          if (emailInput && !emailInput.disabled) {
            setInputValue(emailInput, email);
            await sleep(120);
            if (!await submitForm(emailInput)) {
              return { ok: false, message: 'FLORA email form did not become ready.' };
            }
            break;
          }
          await sleep(100);
        }

        let passwordInput = null;
        for (let attempt = 0; attempt < 160; attempt += 1) {
          if (hasSession()) return { ok: true, status: 'signed_in' };
          if (signInStatus() === 'needs_second_factor') {
            return { ok: false, requiresMfa: true, message: 'This FLORA account requires MFA. Use the Sign in window to finish verification.' };
          }
          const error = knownError();
          if (error) return { ok: false, message: error };
          passwordInput = document.querySelector('input[type="password"][autocomplete="current-password"], input[type="password"]');
          if (passwordInput && !passwordInput.disabled) break;
          await sleep(100);
        }

        if (!passwordInput) {
          return { ok: false, message: 'FLORA did not offer password sign-in for this account. Use the Sign in window for SSO or additional verification.' };
        }

        setInputValue(passwordInput, password);
        await sleep(120);
        if (!await submitForm(passwordInput)) {
          return { ok: false, message: 'FLORA password form did not become ready.' };
        }

        for (let attempt = 0; attempt < 160; attempt += 1) {
          if (hasSession()) return { ok: true, status: 'signed_in' };
          if (signInStatus() === 'needs_second_factor') {
            return { ok: false, requiresMfa: true, message: 'This FLORA account requires MFA. Use the Sign in window to finish verification.' };
          }
          const error = knownError();
          if (error) return { ok: false, message: error };
          await sleep(100);
        }

        return { ok: false, message: 'FLORA sign in timed out. Check your email and password or use the Sign in window.' };
      })()
    `, true);

    if (result?.ok) {
      const identity = await readFloraIdentity(win, 20);
      markAccountIdentity(account, { ...identity, hasSession: true, email: identity.email || email });
      account.exhaustedAt = null;
      saveAccountsStore();
      notifyAccountsChanged();
    }
    return result ? { ...result, account: publicAccount(account) } : { ok: false, message: 'FLORA sign in returned no result.' };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function getAuthState(accountId = '', attempts = 40) {
  const account = accountId ? requireAccountById(accountId) : accountById();
  const win = await createFloraContext(account);
  try {
    const identity = await readFloraIdentity(win, attempts);
    markAccountIdentity(account, identity);
    return { hasSession: Boolean(identity.hasSession), account: publicAccount(account) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function createFloraContext(accountOrId = '') {
  const account = typeof accountOrId === 'object' && accountOrId
    ? accountOrId
    : accountOrId
      ? requireAccountById(accountOrId)
      : accountById();
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: account.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await win.loadURL('https://app.flora.ai/new');
  return win;
}

async function getFloraConvexToken(win) {
  const token = await win.webContents.executeJavaScript(`
    (async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const session = window.Clerk?.session;
        if (session) {
          try {
            const convexToken = await session.getToken({ template: 'convex' });
            if (convexToken) return convexToken;
          } catch {}
          try {
            const token = await session.getToken();
            if (token) return token;
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 125));
      }
      return null;
    })()
  `, true);

  if (!token) throw new Error('FLORA session is not authenticated. Sign in again.');
  return token;
}

async function invokeFloraConvexMutation(win, functionPath, args) {
  const token = await getFloraConvexToken(win);
  const response = await net.fetch(`${FLORA_CONVEX_URL}/api/mutation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Convex-Client': FLORA_CONVEX_CLIENT,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      path: functionPath,
      format: 'convex_encoded_json',
      args: [args],
    }),
  });

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`FLORA metadata request failed (${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(result?.message || `FLORA metadata request failed (${response.status}).`);
  }
  if (result?.status !== 'success') {
    throw new Error(result?.errorMessage || 'FLORA metadata mutation failed.');
  }
  return result.value;
}

async function createFloraGenerationRecord({ prompt, endpointId, modelName, modelParameters, imageUrl, onProgress, account }) {
  const win = await createFloraContext(account);
  try {
    onProgress?.({ label: 'Creating FLORA generation run' });
    const run = await invokeFloraConvexMutation(
      win,
      'generateRuns/mutations:createGenerateRun',
      {
        mode: 'imageUrl',
        prompt,
        endpointId,
        modelName,
        modelParameters,
        inputMediaUrls: [imageUrl],
        variationCount: 1,
      }
    );

    if (!run?.projectId || !run?.nodeId) {
      throw new Error('FLORA did not return a projectId/nodeId for this generation.');
    }

    onProgress?.({ label: 'Creating FLORA generation record' });
    const generation = await invokeFloraConvexMutation(
      win,
      'generationHistory/mutations:createGenerationWithQueueStatus',
      {
        projectId: run.projectId,
        nodeType: 'generatePage',
        nodeId: run.nodeId,
        prompt,
        model: modelName,
        model_id: endpointId,
        status: 0,
        source: 'generate_page',
        createdAt: Date.now(),
      }
    );

    if (!generation?.generationId) {
      throw new Error('FLORA did not return a generationId.');
    }

    if (generation.queued) onProgress?.({ label: 'FLORA queued this generation' });
    return {
      projectId: run.projectId,
      nodeId: run.nodeId,
      generationId: generation.generationId,
      queued: Boolean(generation.queued),
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function invokeFloraJsonApi(win, route, args) {
  const serializedRoute = JSON.stringify(route);
  const serializedArgs = JSON.stringify(args);
  return win.webContents.executeJavaScript(`
    (async () => {
      const response = await fetch(${serializedRoute}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(${serializedArgs}),
      });
      const text = await response.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); }
        catch { data = { raw: text }; }
      }
      return { ok: response.ok, status: response.status, data };
    })()
  `, true);
}

function mediaUrlForObjectKey(objectKey) {
  return `${FLORA_MEDIA_ORIGIN}/${String(objectKey || '').replace(/^\/+/, '')}`;
}

async function uploadImageToFlora(image, onProgress, account) {
  const win = await createFloraContext(account);
  try {
    onProgress?.({ label: 'Creating FLORA upload reservation' });
    const reservation = await invokeFloraJsonApi(
      win,
      '/api/nodes/create-upload-reservation',
      [image.name, image.mime, null]
    );

    if (!reservation.ok) {
      throw new Error(`FLORA upload reservation failed (${reservation.status}). Sign in again if your session expired.`);
    }
    if (reservation.data?.error) {
      const detail = reservation.data.error.description || reservation.data.error.title || 'Unknown upload error';
      throw new Error(`FLORA upload reservation failed: ${detail}`);
    }

    const gcs = reservation.data?.gcs;
    if (!gcs?.uploadUrl || !gcs?.objectKey) {
      throw new Error('FLORA upload reservation did not return a signed upload URL.');
    }

    onProgress?.({ label: 'Uploading reference image' });
    const bytes = await fs.promises.readFile(image.filePath);
    const uploadResponse = await net.fetch(gcs.uploadUrl, {
      method: 'PUT',
      body: new Uint8Array(bytes),
    });
    if (!uploadResponse.ok) {
      throw new Error(`FLORA media upload failed (${uploadResponse.status}).`);
    }

    if (reservation.data?.metadataProcessing === 'on_upload_complete' && reservation.data?.metadataSessionToken) {
      onProgress?.({ label: 'Finalizing reference image upload' });
      let completion = await invokeFloraJsonApi(
        win,
        '/api/nodes/complete-upload-reservation',
        [reservation.data.metadataSessionToken, null]
      );
      if (!completion.ok || completion.data?.error) {
        completion = await invokeFloraJsonApi(
          win,
          '/api/nodes/complete-upload-reservation',
          [reservation.data.metadataSessionToken, null]
        );
      }
      if (!completion.ok || completion.data?.error) {
        throw new Error(`FLORA upload finalization failed (${completion.status}).`);
      }
    }

    return mediaUrlForObjectKey(gcs.objectKey);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function invokeXaiGeneration({ generationId, nodeId, endpointId, modelParameters }, onProgress, account) {
  const win = await createFloraContext(account);
  try {
    onProgress?.({ label: 'Submitting to FLORA xAI provider', endpointId });
    const result = await invokeFloraJsonApi(
      win,
      '/api/providers/xai/start',
      [generationId, nodeId, endpointId, modelParameters]
    );

    if (!result.ok) {
      throw new Error(`FLORA xAI provider failed (${result.status}).`);
    }
    if (result.data?.error) {
      const detail = result.data.error.description || result.data.error.title || JSON.stringify(result.data.error);
      throw new Error(`FLORA xAI provider failed: ${detail}`);
    }

    onProgress?.({ label: 'FLORA xAI provider accepted generation' });
    return result.data;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function invokeFloraConvexQueryRaw(win, functionPath, args) {
  const token = await getFloraConvexToken(win);
  const response = await net.fetch(`${FLORA_CONVEX_URL}/api/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Convex-Client': FLORA_CONVEX_CLIENT,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      path: functionPath,
      format: 'convex_encoded_json',
      args: [args],
    }),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); }
  catch { data = { raw: text }; }
  return { ok: response.ok, status: response.status, data };
}

async function queryFloraGenerationById(win, generationId) {
  const result = await invokeFloraConvexQueryRaw(
    win,
    'generationHistory/queries:getGenerationById',
    { generationId }
  );
  if (!result.ok || result.data?.status !== 'success') {
    const detail = result.data?.errorMessage || `HTTP ${result.status}`;
    throw new Error(`FLORA generation lookup failed: ${detail}`);
  }
  return result.data.value || null;
}

function describeFloraGenerationFailure(status) {
  const messages = {
    29: 'Generation completed without a usable output.',
    40: 'Generation was cancelled.',
    41: 'FLORA generation queue is full.',
    42: 'FLORA generation timed out in the queue.',
    50: 'FLORA generation failed.',
    51: 'FLORA generation failed during setup.',
    52: 'Not enough FLORA credits.',
    53: 'The prompt was blocked by FLORA moderation.',
    55: 'FLORA encountered a server error.',
    56: 'FLORA rejected the generation parameters.',
    57: 'FLORA generation failed during post-processing.',
    58: 'The xAI provider timed out.',
    59: 'The FLORA credit limit was exceeded.',
    60: 'FLORA could not start the generation.',
    61: 'A downstream FLORA service failed.',
    62: 'FLORA rejected the generation input.',
  };
  return messages[status] || `FLORA generation ended with status ${status}.`;
}

async function waitForFloraGeneration(generationId, onProgress, attempts = 90, account) {
  const win = await createFloraContext(account);
  try {
    let previousStatus = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const generation = await queryFloraGenerationById(win, generationId);
      if (!generation) throw new Error('FLORA generation record disappeared.');

      if (generation.status !== previousStatus) {
        previousStatus = generation.status;
        onProgress?.({ label: 'FLORA generation status', status: generation.status });
      }

      if (generation.mediaUrl) return generation;
      if (generation.status === 29 || generation.status >= 40) {
        const error = new Error(describeFloraGenerationFailure(generation.status));
        error.floraStatus = generation.status;
        error.creditExhausted = generation.status === 52 || generation.status === 59;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('FLORA generation timed out before media became available.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function isCreditExhaustionError(error) {
  if (error?.creditExhausted || error?.floraStatus === 52 || error?.floraStatus === 59) return true;
  const message = String(error?.message || error || '');
  return /not enough.*(?:credit|token)|insufficient.*(?:credit|balance|funds)|credit.*(?:limit|exceed|exhaust)|quota.*(?:exceed|exhaust)|out of credits?/i.test(message);
}

async function findNextUsableAccount(excludedIds = new Set()) {
  const store = loadAccountsStore();
  const currentIndex = Math.max(0, store.accounts.findIndex((account) => account.id === store.activeAccountId));
  const ordered = [
    ...store.accounts.slice(currentIndex + 1),
    ...store.accounts.slice(0, currentIndex + 1),
  ];

  for (const candidate of ordered) {
    if (excludedIds.has(candidate.id) || candidate.exhaustedAt) continue;
    try {
      const state = await getAuthState(candidate.id, 12);
      if (state.hasSession) return requireAccountById(candidate.id);
    } catch {}
  }
  return null;
}

function imagePreviewPayload(image) {
  if (!image || image.isEmpty()) throw new Error('The selected file could not be decoded as an image.');
  const original = image.getSize();
  const scale = Math.min(1, 760 / Math.max(1, original.width), 480 / Math.max(1, original.height));
  const preview = scale < 1
    ? image.resize({
      width: Math.max(1, Math.round(original.width * scale)),
      height: Math.max(1, Math.round(original.height * scale)),
      quality: 'good',
    })
    : image;
  return {
    previewDataUrl: preview.toDataURL(),
    width: original.width,
    height: original.height,
  };
}

async function previewRemoteImage(rawUrl) {
  const value = String(rawUrl || '').trim();
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error('Enter a valid image URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Image URL must use http or https.');

  const response = await net.fetch(parsed.toString());
  if (!response.ok) throw new Error(`Image URL returned HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_PREVIEW_BYTES) throw new Error('Image preview exceeds the 20 MB preview limit.');
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.startsWith('image/')) throw new Error(`URL returned ${contentType}, not an image.`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('Image URL returned an empty file.');
  if (bytes.length > MAX_PREVIEW_BYTES) throw new Error('Image preview exceeds the 20 MB preview limit.');
  const preview = imagePreviewPayload(nativeImage.createFromBuffer(bytes));
  return { ok: true, url: response.url || parsed.toString(), contentType, ...preview };
}

async function registerSelectedImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const stat = await fs.promises.stat(filePath);
  if (stat.size <= 0) throw new Error('Selected image is empty.');
  if (stat.size > 350 * 1024 * 1024) throw new Error('Selected image exceeds FLORA’s 350 MB image limit.');

  const handle = randomId('img-');
  selectedImages.set(handle, {
    filePath,
    name: path.basename(filePath),
    mime,
    size: stat.size,
  });
  const preview = imagePreviewPayload(nativeImage.createFromPath(filePath));

  return {
    canceled: false,
    handle,
    name: path.basename(filePath),
    mime,
    size: stat.size,
    ...preview,
  };
}

async function generateForAccount(event, input, account) {
  const prompt = String(input?.prompt || '').trim();
  const imageHandle = String(input?.imageHandle || '').trim();
  let imageUrl = String(input?.imageUrl || '').trim();
  const endpointId = String(input?.endpointId || 'i2i-xai-imagine').trim();
  const model = String(input?.model || 'grok-imagine-image').trim();
  const resolution = String(input?.resolution || '1k').trim();

  if (!prompt) throw new Error('Prompt is required.');
  event.sender.send('flora:progress', { label: `Using ${account.label}`, accountId: account.id });

  if (imageHandle) {
    const image = selectedImages.get(imageHandle);
    if (!image) throw new Error('Selected local image is no longer available. Choose it again.');
    imageUrl = await uploadImageToFlora(image, (progressEvent) => {
      event.sender.send('flora:progress', progressEvent);
    }, account);
    event.sender.send('flora:progress', { label: 'Reference image uploaded to FLORA' });
  }

  if (!imageUrl) throw new Error('Choose a local image or paste a reference image URL.');

  const modelName = 'Grok Imagine';
  const runModelParameters = {
    prompt,
    model,
    n: 1,
    resolution,
    response_format: 'url',
  };

  const generationRecord = await createFloraGenerationRecord({
    prompt,
    endpointId,
    modelName,
    modelParameters: runModelParameters,
    imageUrl,
    account,
    onProgress: (progressEvent) => event.sender.send('flora:progress', progressEvent),
  });
  const { generationId, nodeId } = generationRecord;
  const modelParameters = { ...runModelParameters, image_url: imageUrl };

  event.sender.send('flora:progress', { label: 'Submitting generation', generationId });
  const providerResult = await invokeXaiGeneration(
    { generationId, nodeId, endpointId, modelParameters },
    (progressEvent) => event.sender.send('flora:progress', progressEvent),
    account
  );
  event.sender.send('flora:progress', { label: 'FLORA provider response', data: providerResult });

  event.sender.send('flora:progress', { label: 'Waiting for FLORA generation result' });
  const completedGeneration = await waitForFloraGeneration(
    generationId,
    (progressEvent) => event.sender.send('flora:progress', progressEvent),
    90,
    account
  );

  account.authenticated = true;
  account.exhaustedAt = null;
  account.lastUsedAt = Date.now();
  saveAccountsStore();
  notifyAccountsChanged();

  return {
    ok: true,
    generationId,
    outputUrl: completedGeneration.mediaUrl,
    available: true,
    providerResult,
    status: completedGeneration.status,
    generationCost: completedGeneration.generationCost ?? null,
    account: publicAccount(account),
  };
}

ipcMain.handle('flora:accounts-state', async () => accountsState());

ipcMain.handle('flora:add-account', async () => {
  const account = addAccountRecord();
  return { ok: true, account: publicAccount(account), state: accountsState() };
});

ipcMain.handle('flora:switch-account', async (_event, accountId) => {
  const account = setActiveAccount(accountId);
  return { ok: true, account: publicAccount(account), state: accountsState() };
});

ipcMain.handle('flora:remove-account', async (_event, accountId) => {
  const account = accountId ? requireAccountById(accountId) : accountById();
  if (loginWindow && !loginWindow.isDestroyed() && loginAccountId === account.id) loginWindow.close();
  const removed = removeAccountRecord(account.id);
  await session.fromPartition(removed.partition).clearStorageData();
  return { ok: true, state: accountsState() };
});

ipcMain.handle('flora:retry-account', async (_event, accountId) => {
  const account = accountId ? requireAccountById(accountId) : accountById();
  markAccountExhausted(account, false);
  return { ok: true, account: publicAccount(account), state: accountsState() };
});

ipcMain.handle('flora:set-auto-switch', async (_event, enabled) => {
  const store = loadAccountsStore();
  store.autoSwitchOnCredits = Boolean(enabled);
  saveAccountsStore();
  notifyAccountsChanged();
  return accountsState();
});

ipcMain.handle('flora:open-login', async (_event, accountId) => openLoginWindow('', accountId));

ipcMain.handle('flora:open-microsoft-login', async (_event, accountId) => openLoginWindow('microsoft', accountId));

ipcMain.handle('flora:auto-login', async (_event, credentials, accountId) => autoLoginWithPassword(credentials, accountId));

ipcMain.handle('flora:auth-state', async (_event, accountId) => getAuthState(accountId));

ipcMain.handle('flora:select-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose reference image',
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return registerSelectedImage(result.filePaths[0]);
});

ipcMain.handle('flora:preview-image-url', async (_event, url) => previewRemoteImage(url));

ipcMain.handle('flora:logout', async (_event, accountId) => {
  const account = accountId ? requireAccountById(accountId) : accountById();
  const ses = session.fromPartition(account.partition);
  await ses.clearStorageData();
  account.authenticated = false;
  account.exhaustedAt = null;
  saveAccountsStore();
  notifyAccountsChanged();
  return { ok: true, account: publicAccount(account), state: accountsState() };
});

ipcMain.handle('flora:generate', async (event, input) => {
  const store = loadAccountsStore();
  let account = input?.accountId
    ? requireAccountById(input.accountId)
    : requireAccountById(store.activeAccountId);
  const attempted = new Set();
  let lastError = null;

  while (account && !attempted.has(account.id)) {
    attempted.add(account.id);
    try {
      return await generateForAccount(event, input, account);
    } catch (error) {
      lastError = error;
      if (!isCreditExhaustionError(error)) throw error;

      markAccountExhausted(account, true);
      event.sender.send('flora:progress', {
        label: `${account.label} has no available FLORA credits`,
        accountId: account.id,
      });

      if (store.autoSwitchOnCredits === false) {
        const disabledError = new Error(`${error.message} Auto account switching is disabled.`);
        disabledError.creditExhausted = true;
        throw disabledError;
      }

      const nextAccount = await findNextUsableAccount(attempted);
      if (!nextAccount) {
        const unavailableError = new Error(`${error.message} No other signed-in FLORA account with available credits was found.`);
        unavailableError.creditExhausted = true;
        throw unavailableError;
      }

      setActiveAccount(nextAccount.id);
      account = nextAccount;
      event.sender.send('flora:progress', {
        label: `Switched to ${account.label}; retrying generation`,
        accountId: account.id,
      });
    }
  }

  throw lastError || new Error('No FLORA account is available for generation.');
});

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
