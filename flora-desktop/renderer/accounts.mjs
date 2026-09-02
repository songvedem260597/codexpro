import { getActiveAccount, normalizeAccountState } from './core.mjs';
import { applyCachedAuth, renderAccounts, setAuthBusy, setError } from './view.mjs';

export function createAccountsController({ els, state, flora }) {
  const activeAccount = () => getActiveAccount(state.accountState);

  async function refreshAccounts(nextState = null) {
    try {
      state.accountState = normalizeAccountState(nextState || await flora.accountsState());
      renderAccounts(els, state);
      return state.accountState;
    } catch (error) {
      setError(els, error?.message || String(error));
      return state.accountState;
    }
  }

  async function refreshAuth() {
    const account = activeAccount();
    if (!account) {
      applyCachedAuth(els, state, null);
      return false;
    }
    try {
      const auth = await flora.authState(account.id);
      state.hasSession = Boolean(auth.hasSession);
      await refreshAccounts();
      const refreshed = activeAccount();
      applyCachedAuth(els, state, refreshed);
      els.authHint.textContent = state.hasSession
        ? `Signed in as ${refreshed?.email || refreshed?.label || 'FLORA account'}. This session is reused automatically.`
        : `Sign in ${refreshed?.email || refreshed?.label || 'this account'} with Outlook, or enter its FLORA email and password.`;
      return state.hasSession;
    } catch {
      state.hasSession = false;
      els.authBadge.textContent = 'Session check failed';
      els.authBadge.dataset.tone = 'off';
      els.credentialPanel.hidden = false;
      return false;
    }
  }

  async function openOutlookLogin(accountId = activeAccount()?.id) {
    if (!accountId) return false;
    setError(els, '');
    els.loginBtn.disabled = true;
    els.outlookLoginBtn.disabled = true;
    els.authHint.textContent = 'Opening Microsoft / Outlook sign in...';
    try {
      const result = await flora.openMicrosoftLogin(accountId);
      if (!result?.ok) throw new Error(result?.message || 'Could not open Microsoft sign in.');
      els.authHint.textContent = 'Finish signing in with Microsoft / Outlook in the FLORA sign-in window.';
      return true;
    } catch (error) {
      els.authHint.textContent = 'Microsoft / Outlook sign in could not be opened.';
      setError(els, error?.message || String(error));
      return false;
    } finally {
      els.loginBtn.disabled = false;
      els.outlookLoginBtn.disabled = false;
    }
  }

  async function signInWithCredentials() {
    const account = activeAccount();
    const email = els.loginEmail.value.trim();
    const password = els.loginPassword.value;
    if (!account) return setError(els, 'Add a FLORA account first.'), false;
    if (!email) return setError(els, 'Enter your FLORA email first.'), els.loginEmail.focus(), false;
    if (!password) return setError(els, 'Enter your FLORA password first.'), els.loginPassword.focus(), false;

    setError(els, '');
    setAuthBusy(els, true);
    els.authHint.textContent = `Signing in ${account.label} to FLORA...`;
    try {
      const result = await flora.autoLogin({ email, password }, account.id);
      if (!result?.ok) {
        els.authHint.textContent = result?.requiresMfa
          ? 'Additional verification is required. Use Microsoft / Outlook sign in to finish it.'
          : 'Sign in failed. Check the account details and try again.';
        setError(els, result?.message || 'FLORA sign in failed.');
        return false;
      }
      els.loginPassword.value = '';
      els.authHint.textContent = 'Signed in. Your password was not saved.';
      await refreshAccounts(result.state || null);
      await refreshAuth();
      return true;
    } catch (error) {
      els.authHint.textContent = 'Sign in failed. Check the account details and try again.';
      setError(els, error?.message || String(error));
      return false;
    } finally {
      setAuthBusy(els, false);
    }
  }

  function bind() {
    els.credentialForm.addEventListener('submit', (event) => { event.preventDefault(); void signInWithCredentials(); });
    els.loginBtn.addEventListener('click', () => void openOutlookLogin());
    els.outlookLoginBtn.addEventListener('click', () => void openOutlookLogin());
    els.logoutBtn.addEventListener('click', async () => {
      const account = activeAccount(); if (!account) return;
      setError(els, ''); els.loginPassword.value = '';
      const result = await flora.logout(account.id);
      els.authHint.textContent = 'Use Microsoft / Outlook sign in, or enter your FLORA email and password below.';
      await refreshAccounts(result?.state || null); await refreshAuth();
    });
    els.accountSelect.addEventListener('change', async () => {
      setError(els, ''); els.loginPassword.value = '';
      const result = await flora.switchAccount(els.accountSelect.value);
      await refreshAccounts(result?.state || null);
      els.loginEmail.value = activeAccount()?.email || '';
      await refreshAuth();
    });
    els.addAccountBtn.addEventListener('click', async () => {
      setError(els, ''); els.addAccountBtn.disabled = true; els.addAccountBtn.textContent = 'Adding...';
      try {
        const result = await flora.addAccount();
        await refreshAccounts(result?.state || null);
        els.loginEmail.value = ''; els.loginPassword.value = '';
        await refreshAuth(); await openOutlookLogin(result?.account?.id);
      } catch (error) { setError(els, error?.message || String(error)); }
      finally { els.addAccountBtn.disabled = false; els.addAccountBtn.textContent = 'Add account'; }
    });
    els.removeAccountBtn.addEventListener('click', async () => {
      const account = activeAccount(); if (!account || state.accountState.accounts.length <= 1) return;
      const label = account.email || account.label;
      if (!window.confirm(`Remove ${label} from this app? Its saved FLORA session will be cleared.`)) return;
      try {
        const result = await flora.removeAccount(account.id);
        els.loginEmail.value = ''; els.loginPassword.value = '';
        await refreshAccounts(result?.state || null); await refreshAuth();
      } catch (error) { setError(els, error?.message || String(error)); }
    });
    els.retryAccountBtn.addEventListener('click', async () => {
      const account = activeAccount(); if (!account) return;
      try { const result = await flora.retryAccount(account.id); await refreshAccounts(result?.state || null); els.statusText.textContent = 'Account credit status reset'; }
      catch (error) { setError(els, error?.message || String(error)); }
    });
    els.autoSwitchAccounts.addEventListener('change', async () => {
      try { state.accountState = normalizeAccountState(await flora.setAutoSwitch(els.autoSwitchAccounts.checked)); renderAccounts(els, state); }
      catch (error) { els.autoSwitchAccounts.checked = !els.autoSwitchAccounts.checked; setError(els, error?.message || String(error)); }
    });
  }

  return { activeAccount, bind, openOutlookLogin, refreshAccounts, refreshAuth, signInWithCredentials };
}
