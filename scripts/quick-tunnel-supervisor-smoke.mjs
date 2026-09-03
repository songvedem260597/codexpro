import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  QUICK_TUNNEL_MAX_RESTARTS,
  quickTunnelRestartDelay,
  superviseQuickTunnel
} from './quick-tunnel-supervisor.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.codexproExpectedExit = false;
  }

  exit(code = 1, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

assert.equal(QUICK_TUNNEL_MAX_RESTARTS, 5);
assert.deepEqual([1, 2, 3, 4, 5, 6].map((attempt) => quickTunnelRestartDelay(attempt)), [1000, 2000, 4000, 8000, 15000, 15000]);

const initial = { child: new FakeChild(), publicBase: 'https://first.trycloudflare.com' };
const restarted = { child: new FakeChild(), publicBase: 'https://second.trycloudflare.com' };
const scheduled = [];
const ready = [];
let starts = 0;
let stop = false;
const run = superviseQuickTunnel({
  initialInstance: initial,
  shouldStop: () => stop,
  sleep: async (ms) => scheduled.push(ms),
  startInstance: async () => {
    starts += 1;
    return restarted;
  },
  onRestartReady: ({ restartCount, instance }) => ready.push({ restartCount, publicBase: instance.publicBase })
});
initial.child.exit(1);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(starts, 1);
assert.deepEqual(scheduled, [1000]);
assert.deepEqual(ready, [{ restartCount: 1, publicBase: 'https://second.trycloudflare.com' }]);
stop = true;
restarted.child.codexproExpectedExit = true;
restarted.child.exit(0);
const result = await run;
assert.equal(result.stopped, true);
assert.equal(result.restartCount, 1);

let attempts = 0;
const exhaustedChild = new FakeChild();
const exhausted = superviseQuickTunnel({
  initialInstance: { child: exhaustedChild },
  maxRestarts: 2,
  sleep: async () => {},
  startInstance: async () => {
    attempts += 1;
    throw new Error(`restart-${attempts}-failed`);
  }
});
exhaustedChild.exit(2);
await assert.rejects(exhausted, /restart budget exhausted after 2 restart attempt\(s\).*restart-2-failed/);
assert.equal(attempts, 2);

console.log('✓ quick tunnel supervisor restart/backoff smoke test passed');
