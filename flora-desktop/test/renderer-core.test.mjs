import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountOptionLabel,
  appendCacheBust,
  buildGenerationPayload,
  cleanErrorText,
  getActiveAccount,
  normalizeAccountState,
  validateGenerationInput,
} from '../renderer/core.mjs';

test('cleans Electron IPC error prefixes', () => {
  assert.equal(cleanErrorText("Error invoking remote method 'flora:generate': Error: Not enough credits"), 'Not enough credits');
});

test('normalizes account state without dropping account data', () => {
  const accounts = [{ id: 'a', email: 'a@example.com', authenticated: true }, { id: 'b', exhausted: true }];
  const state = normalizeAccountState({ activeAccountId: 'b', autoSwitchOnCredits: false, accounts });
  assert.equal(state.activeAccountId, 'b');
  assert.equal(state.autoSwitchOnCredits, false);
  assert.equal(state.accounts, accounts);
  assert.equal(getActiveAccount(state), accounts[1]);
});

test('account labels preserve ready, sign-in and exhausted states', () => {
  assert.equal(accountOptionLabel({ email: 'ready@example.com', authenticated: true }), 'ready@example.com - ready');
  assert.equal(accountOptionLabel({ label: 'Account 2', authenticated: false }), 'Account 2 - sign in');
  assert.equal(accountOptionLabel({ email: 'full@example.com', authenticated: true, exhausted: true }), 'full@example.com - no credits');
});

test('generation payload preserves the existing IPC shape', () => {
  const payload = buildGenerationPayload({ accountId: 'a', imageHandle: 'img-1', imageUrl: '', prompt: 'hello', aspectRatio: 'source', resolution: '1k', model: 'grok-imagine-image', endpointId: 'i2i-xai-imagine' });
  assert.deepEqual(Object.keys(payload), ['accountId', 'imageHandle', 'imageUrl', 'prompt', 'aspectRatio', 'resolution', 'model', 'endpointId']);
  assert.equal(validateGenerationInput(payload, { id: 'a' }).ok, true);
});

test('generation validation retains input and prompt guards', () => {
  const base = buildGenerationPayload({ accountId: 'a', prompt: 'x' });
  assert.equal(validateGenerationInput(base, { id: 'a' }).field, 'image');
  assert.equal(validateGenerationInput({ ...base, imageUrl: 'https://example.com/a.jpg', prompt: '' }, { id: 'a' }).field, 'prompt');
  assert.equal(validateGenerationInput({ ...base, imageUrl: 'https://example.com/a.jpg' }, null).field, 'account');
});

test('cache busting preserves existing query strings', () => {
  assert.equal(appendCacheBust('https://media.flora.ai/a.png', 42), 'https://media.flora.ai/a.png?t=42');
  assert.equal(appendCacheBust('https://media.flora.ai/a.png?x=1', 42), 'https://media.flora.ai/a.png?x=1&t=42');
});
