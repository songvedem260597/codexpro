import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const worker = readFileSync(new URL('../chrome-extension/service-worker.js', import.meta.url), 'utf8');
const waitSource = worker.slice(worker.indexOf('async function waitForTab('), worker.indexOf('async function replaceUnresponsiveChatTab('));

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

const cleanupGuardSource = worker.slice(worker.indexOf('function debuggerSessionBlocksChatTabCleanup('), worker.indexOf('function planChatTabCleanup('));
const policySource = worker.slice(worker.indexOf('function planChatTabCleanup('), worker.indexOf('async function probeChatGptTabHealth('));
const cleanupSource = worker.slice(worker.indexOf('async function cleanupChatGptTabs('), worker.indexOf('function enforceSingleChatTabSoon('));
function cleanupHarness({ createFails = false, busy = false, pinned = false, limit = 1 } = {}) {
  const tabs = [{ id: 1, windowId: 42, url: 'https://chatgpt.com/c/existing-1234', active: true, status: 'complete', pinned }];
  const events = [];
  let minimumTabCount = tabs.length;
  const chrome = { tabs: {
    async query() { return tabs.map(tab => ({ ...tab })); },
    async get(id) { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('missing'); return { ...tab }; },
    async create(args) {
      events.push('create');
      if (createFails) throw new Error('creation failed');
      const tab = { ...args, id: 2, status: 'loading' };
      tabs.push(tab);
      return { ...tab };
    }
  }, storage: { local: { async set() {} } } };
  const context = {
    chrome, MAX_CHATGPT_TABS: 3, MAC_MAX_CHATGPT_TABS: 1,
    CHAT_TAB_HEALTH_FAILURES_TO_CLOSE: 2, CHAT_TAB_CLEANUP_INTERVAL_MS: 30000,
    lastChatTabCleanupAt: 0, recentConversationCache: {},
    chatTabHealthByTab: new Map([[1, { failures: 1 }]]),
    debuggerSessionsByTab: new Map(), flightRecorderTrackersByTab: new Map(), pendingConversationByTab: new Map(),
    PENDING_CONVERSATION_TTL_MS: 60000,
    chatAttachmentOwnershipByTab: new Map(), browserMutationTailsByTab: new Map(), chatDomActivityByTab: new Map(),
    chatGptTabLimit: async () => limit, ensureChatAttachmentOwnershipLoaded: async () => {},
    probeChatGptTabHealth: async () => false, chatRequestState: async () => ({ busy }),
    canonicalActivityState: () => ({ busy: false }), scheduleRealtimeProfilePush: () => {},
    isChatGptTabUrl: value => String(value).startsWith('https://chatgpt.com/'),
    conversationIdFromUrl: value => String(value).split('/c/')[1] || '',
    recordProfileLifecycleEvent: async event => events.push(event.type),
    async removeTabWithReason(id) {
      events.push(`remove:${id}`);
      tabs.splice(tabs.findIndex(tab => tab.id === id), 1);
      minimumTabCount = Math.min(minimumTabCount, tabs.length);
    }
  };
  const { cleanupChatGptTabs } = vm.runInNewContext(`${cleanupGuardSource}\n${policySource}\n${cleanupSource}; ({cleanupChatGptTabs});`, context);
  return { cleanupChatGptTabs, tabs, events, minimum: () => minimumTabCount };
}

{
  const h = cleanupHarness();
  const result = await h.cleanupChatGptTabs([], [], { force: true });
  assert.equal(h.minimum(), 1, 'health cleanup must not temporarily close the last macOS tab/window');
  assert.ok(h.events.indexOf('create') < h.events.indexOf('remove:1'), 'create must finish before removal');
  assert.equal(h.tabs.length, 1);
  assert.equal(h.tabs[0].url, 'https://chatgpt.com/c/existing-1234');
  assert.equal(h.tabs[0].windowId, 42);
  assert.equal(result.replacement_tab_id, 2);
}
for (const options of [{ createFails: true }, { busy: true }, { pinned: true }, { limit: 3 }]) {
  const h = cleanupHarness(options);
  await h.cleanupChatGptTabs([], [], { force: true });
  assert.equal(h.minimum(), 1, 'failed replacement/protected tab must retain its original window');
  assert.equal(h.tabs[0].id, 1);
  assert.ok(!h.events.includes('remove:1'));
}
console.log('✓ Tab completion race and safe macOS health replacement smoke tests passed');
