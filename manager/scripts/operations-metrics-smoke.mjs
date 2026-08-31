import assert from "node:assert/strict";
import { collectOperationsPerformance } from "../electron/operations-metrics.mjs";

const first = await collectOperationsPerformance([process.pid]);
await new Promise((resolve) => setTimeout(resolve, 40));
const second = await collectOperationsPerformance([process.pid]);

assert.equal(second.managerPid, process.pid);
assert.ok(second.logicalCpuCount >= 1);
assert.ok(second.totalMemoryBytes > 0);
assert.ok(second.freeMemoryBytes >= 0);
const current = second.processes.find((entry) => entry.pid === process.pid);
assert.ok(current, "current Manager test process must be present");
assert.ok(current.memoryBytes > 0, "current process RSS must be reported");
assert.ok(current.cpuSeconds >= 0);
assert.ok(current.cpuPercent >= 0);
console.log("operations metrics smoke passed");
