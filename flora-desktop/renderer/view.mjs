import { accountOptionLabel, accountStatus, cleanErrorText, getActiveAccount, progressLabel } from './core.mjs';

export function collectElements() {
  const ids = [
    'authBadge','loginBtn','logoutBtn','credentialPanel','credentialForm','loginEmail','loginPassword','autoLoginBtn','outlookLoginBtn','authHint','selectedAccountTitle',
    'accountSelect','accountCreditBadge','accountHint','accountCount','addAccountBtn','retryAccountBtn','removeAccountBtn','autoSwitchAccounts',
    'generateBtn','chooseImageBtn','selectedImageName','imageUrl','urlLoadState','referencePreview','referencePreviewImage','referencePreviewTitle','referencePreviewMeta','referencePreviewError',
    'prompt','aspectRatio','resolution','model','endpointId','statusText','progressLog','errorText','emptyState','resultWrap','resultImage','openOutput','generationId',
  ];
  return Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
}

export function setError(els, message = '') {
  const text = cleanErrorText(message);
  els.errorText.hidden = !text;
  els.errorText.textContent = text;
}

export function applyCachedAuth(els, state, account) {
  state.hasSession = Boolean(account?.authenticated);
  const status = accountStatus(account);
  els.authBadge.dataset.tone = status.tone;
  els.authBadge.textContent = !account ? 'No account' : account.exhausted ? 'No credits' : state.hasSession ? 'Session ready' : 'Not signed in';
  els.loginBtn.hidden = state.hasSession;
  els.logoutBtn.hidden = !state.hasSession;
  els.credentialPanel.hidden = state.hasSession;
}

export function renderAccounts(els, state) {
  const previousValue = els.accountSelect.value;
  els.accountSelect.replaceChildren();
  for (const account of state.accountState.accounts) {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = accountOptionLabel(account);
    els.accountSelect.appendChild(option);
  }
  const selectedId = state.accountState.activeAccountId
    || (state.accountState.accounts.some((account) => account.id === previousValue) ? previousValue : '')
    || state.accountState.accounts[0]?.id || '';
  state.accountState.activeAccountId = selectedId;
  els.accountSelect.value = selectedId;

  const account = getActiveAccount(state.accountState);
  const status = accountStatus(account);
  els.accountCreditBadge.dataset.tone = status.tone;
  els.accountCreditBadge.textContent = status.label;
  els.selectedAccountTitle.textContent = account?.email || account?.label || 'FLORA account';
  if (account?.email && !els.loginEmail.value.trim()) els.loginEmail.value = account.email;
  els.retryAccountBtn.hidden = !account?.exhausted;
  els.removeAccountBtn.disabled = state.accountState.accounts.length <= 1;
  els.autoSwitchAccounts.checked = state.accountState.autoSwitchOnCredits !== false;
  els.accountCount.textContent = `${state.accountState.accounts.length} account${state.accountState.accounts.length === 1 ? '' : 's'}`;
  els.accountHint.textContent = account?.exhausted
    ? `${account.email || account.label} is out of credits. The next ready account can be used automatically.`
    : 'Each account keeps an isolated FLORA session.';
  applyCachedAuth(els, state, account);
}

export function setAuthBusy(els, busy) {
  els.autoLoginBtn.disabled = busy;
  els.outlookLoginBtn.disabled = busy;
  els.loginBtn.disabled = busy;
  els.loginEmail.disabled = busy;
  els.loginPassword.disabled = busy;
  els.autoLoginBtn.textContent = busy ? 'Signing in...' : 'Sign in';
}

export function clearReferencePreview(els) {
  els.referencePreview.hidden = true;
  els.referencePreviewImage.removeAttribute('src');
  els.referencePreviewTitle.textContent = 'Reference image';
  els.referencePreviewMeta.textContent = '';
}

export function setPreviewError(els, message = '') {
  const text = cleanErrorText(message);
  els.referencePreviewError.hidden = !text;
  els.referencePreviewError.textContent = text;
}

export function showReferencePreview(els, data, title) {
  els.referencePreviewImage.src = data.previewDataUrl;
  els.referencePreviewTitle.textContent = title || 'Reference image';
  els.referencePreviewMeta.textContent = data.width && data.height ? `${data.width} × ${data.height}` : '';
  els.referencePreview.hidden = false;
  setPreviewError(els, '');
}

export function addProgress(els, value) {
  const label = progressLabel(value);
  if (!label) return;
  els.statusText.textContent = String(label).slice(0, 90);
  const item = document.createElement('div');
  item.className = 'progress-item';
  item.textContent = typeof value === 'string' ? value : JSON.stringify(value);
  els.progressLog.appendChild(item);
  els.progressLog.scrollTop = els.progressLog.scrollHeight;
}

export function resetOutput(els) {
  els.progressLog.replaceChildren();
  els.resultWrap.hidden = true;
  els.emptyState.hidden = false;
  els.generationId.textContent = '';
}

export function setGenerateBusy(els, busy) {
  els.generateBtn.disabled = busy;
  els.generateBtn.textContent = busy ? 'Generating...' : 'Generate image';
}
