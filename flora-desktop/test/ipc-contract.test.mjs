import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const preload = fs.readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../main.cjs', import.meta.url), 'utf8');

const invokeChannels = [
  'flora:accounts-state','flora:add-account','flora:switch-account','flora:remove-account','flora:retry-account','flora:set-auto-switch',
  'flora:open-login','flora:open-microsoft-login','flora:auto-login','flora:auth-state','flora:select-image','flora:preview-image-url','flora:logout','flora:generate',
];

const eventChannels = ['flora:progress', 'flora:auth-changed', 'flora:accounts-changed'];

test('preload and main retain all renderer IPC invoke contracts', () => {
  for (const channel of invokeChannels) {
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
});

test('preload retains account, auth and progress event subscriptions', () => {
  for (const channel of eventChannels) assert.ok(preload.includes(`ipcRenderer.on('${channel}'`));
});

test('credit exhaustion still marks and switches account before retry', () => {
  assert.ok(main.includes('markAccountExhausted(account, true)'));
  assert.ok(main.includes('findNextUsableAccount(attempted)'));
  assert.ok(main.includes('setActiveAccount(nextAccount.id)'));
  assert.ok(main.includes('retrying generation'));
});

test('account persistence remains under Electron userData', () => {
  assert.ok(main.includes("app.getPath('userData')"));
  assert.ok(main.includes("const ACCOUNTS_FILE = 'flora-accounts.json'"));
});
