export const EMPTY_ACCOUNT_STATE = Object.freeze({
  activeAccountId: '',
  autoSwitchOnCredits: true,
  accounts: [],
});

export function cleanErrorText(value = '') {
  return String(value || '')
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
}

export function normalizeAccountState(value) {
  const accounts = Array.isArray(value?.accounts) ? value.accounts : [];
  const requestedActive = String(value?.activeAccountId || '').trim();
  const activeAccountId = accounts.some((account) => account.id === requestedActive)
    ? requestedActive
    : accounts[0]?.id || '';
  return {
    activeAccountId,
    autoSwitchOnCredits: value?.autoSwitchOnCredits !== false,
    accounts,
  };
}

export function getActiveAccount(state) {
  return state?.accounts?.find((account) => account.id === state.activeAccountId)
    || state?.accounts?.[0]
    || null;
}

export function accountOptionLabel(account) {
  const base = account?.email || account?.label || 'FLORA account';
  if (account?.exhausted) return `${base} - no credits`;
  if (!account?.authenticated) return `${base} - sign in`;
  return `${base} - ready`;
}

export function accountStatus(account) {
  if (!account) return { tone: 'off', label: 'No account' };
  if (account.exhausted) return { tone: 'warning', label: 'Credits exhausted' };
  if (!account.authenticated) return { tone: 'off', label: 'Needs sign in' };
  return { tone: 'ready', label: 'Ready' };
}

export function progressLabel(value) {
  return value?.label || value?.step || value?.message || value?.status || value?.event || value?.raw || (value ? JSON.stringify(value) : '');
}

export function buildGenerationPayload(values) {
  return {
    accountId: String(values?.accountId || ''),
    imageHandle: String(values?.imageHandle || ''),
    imageUrl: String(values?.imageUrl || ''),
    prompt: String(values?.prompt || ''),
    aspectRatio: String(values?.aspectRatio || ''),
    resolution: String(values?.resolution || ''),
    model: String(values?.model || ''),
    endpointId: String(values?.endpointId || ''),
  };
}

export function validateGenerationInput(payload, account) {
  if (!payload.imageHandle && !payload.imageUrl.trim()) {
    return { ok: false, field: 'image', message: 'Choose a local image or paste a reference image URL first.' };
  }
  if (!payload.prompt.trim()) {
    return { ok: false, field: 'prompt', message: 'Enter a prompt first.' };
  }
  if (!account) {
    return { ok: false, field: 'account', message: 'Add a FLORA account first.' };
  }
  return { ok: true, field: '', message: '' };
}

export function appendCacheBust(url, timestamp = Date.now()) {
  const value = String(url || '');
  if (!value) return '';
  return `${value}${value.includes('?') ? '&' : '?'}t=${timestamp}`;
}
