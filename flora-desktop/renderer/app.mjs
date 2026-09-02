import { EMPTY_ACCOUNT_STATE, normalizeAccountState } from './core.mjs';
import { createAccountsController } from './accounts.mjs';
import { createReferenceController } from './reference.mjs';
import { createGenerationController } from './generation.mjs';
import { addProgress, collectElements, renderAccounts } from './view.mjs';

const flora = window.flora;
const els = collectElements();
const state = {
  localImageHandle: '',
  hasSession: false,
  accountState: { ...EMPTY_ACCOUNT_STATE, accounts: [] },
  urlPreviewTimer: 0,
  urlPreviewSequence: 0,
};

const accounts = createAccountsController({ els, state, flora });
const reference = createReferenceController({ els, state, flora });
const generation = createGenerationController({ els, state, flora, accounts });

accounts.bind();
reference.bind();
generation.bind();

flora.onProgress((value) => addProgress(els, value));
flora.onAuthChanged(() => { void accounts.refreshAuth(); });
flora.onAccountsChanged((nextState) => {
  state.accountState = normalizeAccountState(nextState);
  renderAccounts(els, state);
});

await accounts.refreshAccounts();
await accounts.refreshAuth();
