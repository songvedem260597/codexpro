const $ = (id) => document.getElementById(id);

const authBadge = $('authBadge');
const loginBtn = $('loginBtn');
const logoutBtn = $('logoutBtn');
const credentialPanel = $('credentialPanel');
const credentialForm = $('credentialForm');
const loginEmail = $('loginEmail');
const loginPassword = $('loginPassword');
const autoLoginBtn = $('autoLoginBtn');
const outlookLoginBtn = $('outlookLoginBtn');
const authHint = $('authHint');
const generateBtn = $('generateBtn');
const chooseImageBtn = $('chooseImageBtn');
const selectedImageName = $('selectedImageName');
const imageUrl = $('imageUrl');
let localImageHandle = '';
const prompt = $('prompt');
const aspectRatio = $('aspectRatio');
const resolution = $('resolution');
const model = $('model');
const endpointId = $('endpointId');
const statusText = $('statusText');
const progressLog = $('progressLog');
const errorText = $('errorText');
const emptyState = $('emptyState');
const resultWrap = $('resultWrap');
const resultImage = $('resultImage');
const openOutput = $('openOutput');
const generationId = $('generationId');

function setError(message = '') {
  errorText.hidden = !message;
  errorText.textContent = message;
}

function addProgress(value) {
  const label = value?.label || value?.step || value?.message || value?.status || value?.event || value?.raw || JSON.stringify(value);
  if (!label) return;
  statusText.textContent = String(label).slice(0, 90);
  const item = document.createElement('div');
  item.className = 'progress-item';
  item.textContent = typeof value === 'string' ? value : JSON.stringify(value);
  progressLog.appendChild(item);
  progressLog.scrollTop = progressLog.scrollHeight;
}

let hasSession = false;

function setAuthBusy(busy) {
  autoLoginBtn.disabled = busy;
  outlookLoginBtn.disabled = busy;
  loginEmail.disabled = busy;
  loginPassword.disabled = busy;
  autoLoginBtn.textContent = busy ? 'Signing in…' : 'Auto sign in';
}

async function openOutlookLogin() {
  setError('');
  loginBtn.disabled = true;
  outlookLoginBtn.disabled = true;
  authHint.textContent = 'Opening Microsoft / Outlook sign in…';
  try {
    const result = await window.flora.openMicrosoftLogin();
    if (!result?.ok) throw new Error(result?.message || 'Could not open Microsoft sign in.');
    authHint.textContent = 'Finish signing in with Microsoft / Outlook in the FLORA sign-in window.';
    return true;
  } catch (error) {
    authHint.textContent = 'Microsoft / Outlook sign in could not be opened.';
    setError(error?.message || String(error));
    return false;
  } finally {
    loginBtn.disabled = false;
    outlookLoginBtn.disabled = false;
  }
}

async function refreshAuth() {
  try {
    const state = await window.flora.authState();
    hasSession = Boolean(state.hasSession);
    authBadge.classList.toggle('ok', hasSession);
    authBadge.classList.toggle('off', !hasSession);
    authBadge.textContent = hasSession ? 'FLORA session detected' : 'Not signed in';
    loginBtn.hidden = hasSession;
    logoutBtn.hidden = !hasSession;
    credentialPanel.hidden = hasSession;
    if (hasSession) authHint.textContent = 'Signed in. The saved FLORA session will be reused automatically.';
    return hasSession;
  } catch (error) {
    hasSession = false;
    authBadge.textContent = 'Session check failed';
    authBadge.classList.add('off');
    credentialPanel.hidden = false;
    return false;
  }
}

async function signInWithCredentials() {
  const email = loginEmail.value.trim();
  const password = loginPassword.value;

  if (!email) {
    setError('Enter your FLORA email first.');
    loginEmail.focus();
    return false;
  }
  if (!password) {
    setError('Enter your FLORA password first.');
    loginPassword.focus();
    return false;
  }

  setError('');
  setAuthBusy(true);
  authHint.textContent = 'Signing in to FLORA…';
  try {
    const result = await window.flora.autoLogin({ email, password });
    if (!result?.ok) {
      const message = result?.message || 'FLORA sign in failed.';
      authHint.textContent = result?.requiresMfa
        ? 'Additional verification is required. Use Microsoft / Outlook sign in to finish it.'
        : 'Sign in failed. Check the account details and try again.';
      setError(message);
      return false;
    }

    loginPassword.value = '';
    authHint.textContent = 'Signed in. Your password was not saved.';
    await refreshAuth();
    return true;
  } catch (error) {
    authHint.textContent = 'Sign in failed. Check the account details and try again.';
    setError(error?.message || String(error));
    return false;
  } finally {
    setAuthBusy(false);
  }
}

credentialForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await signInWithCredentials();
});

loginBtn.addEventListener('click', async () => {
  await openOutlookLogin();
});

outlookLoginBtn.addEventListener('click', async () => {
  await openOutlookLogin();
});

logoutBtn.addEventListener('click', async () => {
  setError('');
  loginPassword.value = '';
  await window.flora.logout();
  authHint.textContent = 'Use Microsoft / Outlook sign in, or enter your FLORA email and password below.';
  await refreshAuth();
});

chooseImageBtn.addEventListener('click', async () => {
  setError('');
  const result = await window.flora.selectImage();
  if (!result || result.canceled) return;
  localImageHandle = result.handle || '';
  selectedImageName.textContent = result.name || 'Selected image';
  imageUrl.value = '';
});

imageUrl.addEventListener('input', () => {
  if (imageUrl.value.trim()) {
    localImageHandle = '';
    selectedImageName.textContent = 'No file selected';
  }
});

generateBtn.addEventListener('click', async () => {
  setError('');
  progressLog.innerHTML = '';
  resultWrap.hidden = true;
  emptyState.hidden = false;
  generationId.textContent = '';

  const payload = {
    imageHandle: localImageHandle,
    imageUrl: imageUrl.value,
    prompt: prompt.value,
    aspectRatio: aspectRatio.value,
    resolution: resolution.value,
    model: model.value,
    endpointId: endpointId.value,
  };

  if (!payload.imageHandle && !payload.imageUrl.trim()) {
    setError('Choose a local image or paste a reference image URL first.');
    chooseImageBtn.focus();
    return;
  }
  if (!payload.prompt.trim()) {
    setError('Enter a prompt first.');
    prompt.focus();
    return;
  }

  if (!hasSession) {
    const signedIn = await signInWithCredentials();
    if (!signedIn) return;
  }

  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating…';
  statusText.textContent = 'Starting';

  try {
    const result = await window.flora.generate(payload);
    generationId.textContent = result.generationId;
    resultImage.src = `${result.outputUrl}?t=${Date.now()}`;
    openOutput.href = result.outputUrl;
    emptyState.hidden = true;
    resultWrap.hidden = false;
    statusText.textContent = result.available ? 'Complete' : 'Generation completed; media still propagating';
  } catch (error) {
    statusText.textContent = 'Failed';
    setError(error?.message || String(error));
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate image';
  }
});

window.flora.onProgress(addProgress);
window.flora.onAuthChanged(refreshAuth);
refreshAuth();
