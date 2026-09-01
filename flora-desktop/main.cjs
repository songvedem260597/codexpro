const { app, BrowserWindow, ipcMain, session, net, dialog } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const FLORA_PARTITION = 'persist:flora-auth';
const FLORA_MEDIA_ORIGIN = 'https://media.flora.ai';
const FLORA_CONVEX_URL = 'https://energized-vulture-906.convex.cloud';
const FLORA_CONVEX_CLIENT = 'npm-1.42.1';
const selectedImages = new Map();
let mainWindow;
let loginWindow;

function randomId(prefix = '') {
  return prefix + crypto.randomBytes(18).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
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

async function clearMicrosoftLoginCookies() {
  const authSession = session.fromPartition(FLORA_PARTITION);
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

async function syncLoginWindowAuth(win) {
  if (!win || win.isDestroyed()) return;
  if (!win.webContents.getURL().startsWith('https://app.flora.ai/')) return;

  try {
    const hasSession = await win.webContents.executeJavaScript(`
      (async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (window.Clerk?.session?.status === 'active') return true;
          await new Promise((resolve) => setTimeout(resolve, 125));
        }
        return false;
      })()
    `, true);
    if (hasSession) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('flora:auth-changed');
      setTimeout(() => {
        if (win === loginWindow && !win.isDestroyed()) win.close();
      }, 250);
    }
  } catch {}
}

async function openLoginWindow(provider = '') {
  if (provider === 'microsoft') await clearMicrosoftLoginCookies();

  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    if (provider === 'microsoft') {
      await loginWindow.loadURL('https://app.flora.ai/');
      const started = await clickMicrosoftSignIn(loginWindow);
      return { ok: started, provider: 'microsoft', message: started ? '' : 'Microsoft sign in is not available on the current FLORA page.' };
    }
    return { ok: true };
  }

  loginWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    parent: mainWindow,
    modal: false,
    title: provider === 'microsoft' ? 'Sign in to FLORA with Outlook' : 'Sign in to FLORA',
    backgroundColor: '#111318',
    webPreferences: {
      partition: FLORA_PARTITION,
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
    void syncLoginWindowAuth(loginWindow);
  });

  await loginWindow.loadURL('https://app.flora.ai/');
  loginWindow.on('closed', () => {
    loginWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('flora:auth-changed');
  });

  if (provider === 'microsoft') {
    const started = await clickMicrosoftSignIn(loginWindow);
    return { ok: started, provider: 'microsoft', message: started ? '' : 'Could not find the Microsoft sign-in option on FLORA.' };
  }
  return { ok: true };
}

async function autoLoginWithPassword(credentials) {
  const email = String(credentials?.email || '').trim();
  const password = String(credentials?.password || '');

  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid FLORA email address.');
  if (!password) throw new Error('Enter your FLORA password.');

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: FLORA_PARTITION,
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

    if (result?.ok && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('flora:auth-changed');
    }
    return result || { ok: false, message: 'FLORA sign in returned no result.' };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function getAuthState() {
  const win = await createFloraContext();
  try {
    const hasSession = await win.webContents.executeJavaScript(`
      (async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (window.Clerk?.session?.status === 'active') return true;
          await new Promise((resolve) => setTimeout(resolve, 125));
        }
        return false;
      })()
    `, true);
    return { hasSession: Boolean(hasSession) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function createFloraContext() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: FLORA_PARTITION,
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

async function createFloraGenerationRecord({ prompt, endpointId, modelName, modelParameters, imageUrl, onProgress }) {
  const win = await createFloraContext();
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

async function uploadImageToFlora(image, onProgress) {
  const win = await createFloraContext();
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

async function invokeXaiGeneration({ generationId, nodeId, endpointId, modelParameters }, onProgress) {
  const win = await createFloraContext();
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

async function waitForFloraGeneration(generationId, onProgress, attempts = 90) {
  const win = await createFloraContext();
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
        throw new Error(describeFloraGenerationFailure(generation.status));
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('FLORA generation timed out before media became available.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

ipcMain.handle('flora:open-login', async () => openLoginWindow());

ipcMain.handle('flora:open-microsoft-login', async () => openLoginWindow('microsoft'));

ipcMain.handle('flora:auto-login', async (_event, credentials) => autoLoginWithPassword(credentials));

ipcMain.handle('flora:auth-state', getAuthState);

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

  return {
    canceled: false,
    handle,
    name: path.basename(filePath),
    mime,
    size: stat.size,
  };
}

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

ipcMain.handle('flora:logout', async () => {
  const ses = session.fromPartition(FLORA_PARTITION);
  await ses.clearStorageData();
  return { ok: true };
});

ipcMain.handle('flora:generate', async (event, input) => {
  const prompt = String(input?.prompt || '').trim();
  const imageHandle = String(input?.imageHandle || '').trim();
  let imageUrl = String(input?.imageUrl || '').trim();
  const endpointId = String(input?.endpointId || 'i2i-xai-imagine').trim();
  const model = String(input?.model || 'grok-imagine-image').trim();
  const resolution = String(input?.resolution || '1k').trim();

  if (!prompt) throw new Error('Prompt is required.');

  if (imageHandle) {
    const image = selectedImages.get(imageHandle);
    if (!image) throw new Error('Selected local image is no longer available. Choose it again.');
    imageUrl = await uploadImageToFlora(image, (progressEvent) => {
      event.sender.send('flora:progress', progressEvent);
    });
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
    onProgress: (progressEvent) => {
      event.sender.send('flora:progress', progressEvent);
    },
  });
  const { generationId, nodeId } = generationRecord;

  const modelParameters = {
    ...runModelParameters,
    image_url: imageUrl,
  };

  event.sender.send('flora:progress', { label: 'Submitting generation', generationId });
  const providerResult = await invokeXaiGeneration(
    { generationId, nodeId, endpointId, modelParameters },
    (progressEvent) => event.sender.send('flora:progress', progressEvent)
  );
  event.sender.send('flora:progress', { label: 'FLORA provider response', data: providerResult });

  event.sender.send('flora:progress', { label: 'Waiting for FLORA generation result' });
  const completedGeneration = await waitForFloraGeneration(
    generationId,
    (progressEvent) => event.sender.send('flora:progress', progressEvent)
  );
  const outputUrl = completedGeneration.mediaUrl;

  return {
    ok: true,
    generationId,
    outputUrl,
    available: true,
    providerResult,
    status: completedGeneration.status,
    generationCost: completedGeneration.generationCost ?? null,
  };
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
