import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const worker = readFileSync(new URL('../chrome-extension/service-worker.js', import.meta.url), 'utf8');
const waitSource = worker.slice(worker.indexOf('async function waitForTab('), worker.indexOf('async function replaceUnresponsiveChatTab('));
assert.ok(waitSource.includes('chrome.tabs.onUpdated.addListener(listener)'), 'waitForTab source must be available');

function waitHarness(mode) {
  const listeners = new Set();
  const removedListeners = new Set();
  let status = mode === 'complete' ? 'complete' : 'loading';
  const chrome = { tabs: {
    onUpdated: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    onRemoved: { addListener: fn => removedListeners.add(fn), removeListener: fn => removedListeners.delete(fn) },
    async get(id) {
      if (mode === 'missing') throw new Error('No tab with id');
      const snapshot = { id, status };
      if (mode === 'race') queueMicrotask(() => {
        status = 'complete';
        for (const listener of listeners) listener(id, { status }, { id, status });
      });
      return snapshot;
    }
  } };
  const { waitForTab } = vm.runInNewContext(`${waitSource}; ({waitForTab});`, { chrome, setTimeout, clearTimeout });
  return { waitForTab, listeners, removedListeners };
}

for (const mode of ['race', 'complete', 'missing', 'timeout', 'removed']) {
  const harness = waitHarness(mode);
  const waiting = harness.waitForTab(7, 30);
  if (mode === 'removed') queueMicrotask(() => {
    for (const listener of harness.removedListeners) listener(7);
  });
  if (mode === 'race' || mode === 'complete') {
    assert.equal((await waiting).status, 'complete', `${mode}: loading completion must never be missed`);
  } else {
    await assert.rejects(waiting, mode === 'missing' ? /No tab/ : mode === 'removed' ? /TAB_CLOSED/ : /tải quá lâu/);
  }
  assert.equal(harness.listeners.size, 0, `${mode}: completion listener must be removed`);
  assert.equal(harness.removedListeners.size, 0, `${mode}: close listener must be removed`);
}

console.log('✓ Windows tab completion race and listener cleanup smoke tests passed');
