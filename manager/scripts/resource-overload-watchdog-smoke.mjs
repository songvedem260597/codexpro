import assert from "node:assert/strict";

import {
  createResourceOverloadTracker,
  RESOURCE_OVERLOAD_CPU_PERCENT,
  RESOURCE_OVERLOAD_RAM_MB,
  RESOURCE_OVERLOAD_SUSTAINED_SAMPLES,
  summarizeManagerAppMetrics
} from "../electron/resource-overload-watchdog.mjs";

function metric({ pid, type = "Browser", cpu = 0, workingSetMb = 0, privateMb = workingSetMb }) {
  return {
    pid,
    type,
    cpu: { percentCPUUsage: cpu },
    memory: {
      workingSetSize: workingSetMb * 1024,
      peakWorkingSetSize: workingSetMb * 1024,
      privateBytes: privateMb * 1024
    }
  };
}

const summary = summarizeManagerAppMetrics([
  metric({ pid: 1, type: "Browser", cpu: 80, workingSetMb: 700 }),
  metric({ pid: 2, type: "Tab", cpu: 40, workingSetMb: 500 })
]);
assert.equal(summary.aggregate_ram_mb, 1200);
assert.equal(summary.aggregate_cpu_percent, 120);
assert.equal(summary.process_count, 2);
assert.equal(summary.processes[0].pid, 1);

const tracker = createResourceOverloadTracker({ cooldownMs: 60_000 });
const normal = [metric({ pid: 1, cpu: 60, workingSetMb: 700 }), metric({ pid: 2, cpu: 40, workingSetMb: 500 })];
for (let index = 0; index < 8; index += 1) {
  assert.equal(tracker.observe(normal, index * 2_000), null, "normal Manager usage must not produce resource incidents");
}

const highRam = [metric({ pid: 1, cpu: 70, workingSetMb: 1_000 }), metric({ pid: 2, cpu: 50, workingSetMb: 700 })];
assert.equal(tracker.observe(highRam, 20_000), null);
assert.equal(tracker.observe(highRam, 22_000), null);
const ramIncident = tracker.observe(highRam, 24_000);
assert.ok(ramIncident, "RAM overload should log only after the sustained sample threshold");
assert.equal(ramIncident.trigger, "ram");
assert.equal(ramIncident.thresholds.ram_mb, RESOURCE_OVERLOAD_RAM_MB);
assert.equal(ramIncident.thresholds.sustained_samples, RESOURCE_OVERLOAD_SUSTAINED_SAMPLES);
assert.ok(ramIncident.aggregate_ram_mb >= RESOURCE_OVERLOAD_RAM_MB);
assert.equal(ramIncident.recent_samples.length <= 6, true);
assert.equal(tracker.observe(highRam, 26_000), null, "cooldown must suppress repeated overload spam");

const cpuTracker = createResourceOverloadTracker({ cooldownMs: 60_000 });
const highCpu = [metric({ pid: 3, cpu: 110, workingSetMb: 500 }), metric({ pid: 4, cpu: 90, workingSetMb: 400 })];
assert.equal(cpuTracker.observe(highCpu, 100_000), null);
assert.equal(cpuTracker.observe(highCpu, 102_000), null);
const cpuIncident = cpuTracker.observe(highCpu, 104_000);
assert.ok(cpuIncident, "CPU overload should log only after sustained samples");
assert.equal(cpuIncident.trigger, "cpu");
assert.ok(cpuIncident.aggregate_cpu_percent >= RESOURCE_OVERLOAD_CPU_PERCENT);

const bothTracker = createResourceOverloadTracker({ cooldownMs: 60_000 });
const bothHigh = [metric({ pid: 5, cpu: 120, workingSetMb: 1_000 }), metric({ pid: 6, cpu: 100, workingSetMb: 700 })];
bothTracker.observe(bothHigh, 200_000);
bothTracker.observe(bothHigh, 202_000);
const bothIncident = bothTracker.observe(bothHigh, 204_000);
assert.equal(bothIncident?.trigger, "ram_and_cpu");

console.log("resource overload watchdog smoke passed");
