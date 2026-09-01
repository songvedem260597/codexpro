import assert from "node:assert/strict";
import { pruneTimestampMap, trimMapEntries, trimSetEntries } from "../src/performance-retention.js";

const map = new Map(Array.from({ length: 6 }, (_, index) => [`k${index}`, index]));
assert.equal(trimMapEntries(map, 3), 3);
assert.deepEqual([...map.keys()], ["k3", "k4", "k5"], "map pruning must retain the newest insertion-order entries");

const set = new Set(["a", "b", "c", "d"]);
assert.equal(trimSetEntries(set, 2), 2);
assert.deepEqual([...set], ["c", "d"], "set pruning must retain the newest entries");

const now = 1_000_000;
const timestamps = new Map([
  ["expired", now - 120_000],
  ["fresh-a", now - 20_000],
  ["fresh-b", now - 10_000],
  ["opaque", "not-a-timestamp"]
]);
assert.equal(pruneTimestampMap(timestamps, { now, maxAgeMs: 60_000, maxEntries: 3 }), 1);
assert.equal(timestamps.has("expired"), false, "timestamp pruning must remove stale entries");
assert.equal(timestamps.size, 3, "timestamp pruning must also enforce a hard entry cap");

console.log("✓ Renderer retention cache pruning smoke test passed");
