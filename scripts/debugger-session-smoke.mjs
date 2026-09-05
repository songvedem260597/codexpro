import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../chrome-extension/service-worker.js', import.meta.url), 'utf8');
const start = worker.indexOf('async function acquireDebuggerTab(');
const end = worker.indexOf('function subscribeDebuggerEvents(', start);
assert.ok(start >= 0 && end > start);
const source = worker.slice(start, end);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function harness(options = {}) {
  const sessions = new Map(), transitions = new Map(), timers = new Map();
  const calls = { attach: 0, detach: 0, commands: [], focus: 0 };
  let attached = Boolean(options.attached), timerId = 0;
  const chrome = {
    debugger: {
      async attach() {
        calls.attach++;
        if (attached) throw new Error('Another debugger is already attached to the tab with id: 123.');
        attached = true;
        if (options.attachGate) await options.attachGate.promise;
      },
      async detach() {
        calls.detach++;
        if (options.detachGate) await options.detachGate.promise;
        attached = false;
      },
      async sendCommand(_target, method) {
        calls.commands.push(method);
        if (options.external) throw new Error('Debugger is not attached to the tab with id: 123.');
        if (options.probeError) throw options.probeError;
        return method === 'Runtime.evaluate' ? { result: { value: { ready: true, host: 'chatgpt.com', visibility: 'hidden' } } } : {};
      }
    },
    tabs: { update: async () => { calls.focus++; }, get: async id => ({ id }) },
    windows: { update: async () => { calls.focus++; } }
  };
  const api = Function('chrome', 'debuggerSessionsByTab', 'debuggerSessionTransitionsByTab', 'debuggerEventSubscribersByTab', 'cdpNetworkTrackersByTab', 'stopFlightRecorderForTab', 'promiseWithTimeout', 'setTimeout', 'clearTimeout', 'DEBUGGER_SESSION_IDLE_MS', 'RENDERER_SEND_PREFLIGHT_TIMEOUT_MS', 'RENDERER_SEND_WAKE_SETTLE_MS', `${source}; return {acquireDebuggerTab,releaseDebuggerTab,releaseChatDebuggerForRecovery,probeChatRendererForSend,ensureChatRendererReadyForSend};`)(
    chrome, sessions, transitions, new Map(), new Map(), async () => {}, options.timeout || (p => p),
    callback => { const id = ++timerId; timers.set(id, callback); return id; }, id => timers.delete(id), 30000, 1000, 350
  );
  return { ...api, sessions, transitions, calls, async expire() { const queued = [...timers.values()]; timers.clear(); for (const callback of queued) callback(); await tick(); } };
}

const attachGate = deferred();
const concurrent = harness({ attachGate });
const first = concurrent.acquireDebuggerTab(123);
const second = concurrent.acquireDebuggerTab(123);
const outcomes = Promise.allSettled([first, second]);
await tick(); attachGate.resolve();
assert.deepEqual((await outcomes).map(r => r.status), ['fulfilled', 'fulfilled'], 'recorder and send must share one attachment');
assert.equal(concurrent.calls.attach, 1);
assert.equal(concurrent.sessions.get(123).refs, 2);
assert.equal(concurrent.transitions.size, 0);

const detachGate = deferred();
const releasing = harness({ detachGate });
await releasing.acquireDebuggerTab(123);
releasing.releaseDebuggerTab(123);
await releasing.expire();
assert.equal(releasing.calls.detach, 1);
const reacquire = releasing.acquireDebuggerTab(123);
await tick();
assert.equal(releasing.calls.attach, 1, 'reacquire must wait until detach finishes');
detachGate.resolve(); await reacquire;
assert.equal(releasing.calls.attach, 2);
assert.equal(releasing.sessions.get(123).refs, 1);

const owned = harness({ attached: true });
await owned.acquireDebuggerTab(123);
assert.equal(owned.sessions.get(123).refs, 1, 'recover an owned attachment after in-memory state loss');
assert.equal(owned.calls.detach, 0);
assert.deepEqual(owned.calls.commands, ['Target.getTargetInfo']);

const external = harness({ attached: true, external: true });
await assert.rejects(external.ensureChatRendererReadyForSend({ id: 123, windowId: 99 }), e => e.code === 'DEBUGGER_ATTACH_CONFLICT' && e.stage === 'prepare');
assert.equal(external.calls.focus, 0, 'debugger conflict must not wake/maximize Chrome');
assert.equal(external.calls.detach, 0, 'never detach an unknown debugger owner');
assert.equal(external.sessions.size, 0);
assert.equal(external.transitions.size, 0);

const protocolFailure = harness({ probeError: new Error('Debugger is not attached') });
await assert.rejects(protocolFailure.ensureChatRendererReadyForSend({ id: 123 }), e => e.code === 'DEBUGGER_PROBE_FAILED');
assert.equal(protocolFailure.calls.focus, 0);
const ready = harness();
assert.equal((await ready.ensureChatRendererReadyForSend({ id: 123 })).renderer_preflight.responsive, true);
assert.equal(ready.calls.focus, 0, 'responsive background tab must stay in background');

const delayedGate = deferred();
const delayed = harness({ attachGate: delayedGate, timeout: (p, _ms, message) => message.startsWith('DEBUGGER_ACQUIRE_TIMEOUT:') ? Promise.reject(new Error(message)) : p });
await assert.rejects(delayed.ensureChatRendererReadyForSend({ id: 123 }), e => e.code === 'DEBUGGER_ACQUIRE_FAILED');
assert.equal(delayed.calls.focus, 0, 'slow acquisition is not a frozen renderer');
delayedGate.resolve(); await tick();
assert.equal(delayed.sessions.get(123).refs, 0, 'late acquisition must release its reference');

const generations = harness();
const oldTarget = await generations.acquireDebuggerTab(123);
generations.sessions.delete(123); // Simulate an unexpected detach/map reset while an old operation is running.
const newTarget = await generations.acquireDebuggerTab(123);
assert.notEqual(newTarget, oldTarget);
generations.releaseDebuggerTab(123, oldTarget);
assert.equal(generations.sessions.get(123).refs, 1, 'old operation must not release a new debugger generation');
generations.releaseDebuggerTab(123, newTarget);
assert.equal(generations.sessions.get(123).refs, 0);
console.log('debugger session concurrency, ownership and preflight smoke passed');
