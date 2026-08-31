import assert from "node:assert/strict";
import fs from "node:fs";
import { formatWorkerRunningDuration } from "../src/worker-running-duration.js";

const now = Date.parse("2026-08-31T15:30:00.000Z");
assert.equal(formatWorkerRunningDuration("", now), "");
assert.equal(formatWorkerRunningDuration("2026-08-31T15:29:40.000Z", now), "0:20");
assert.equal(formatWorkerRunningDuration("2026-08-31T15:10:00.000Z", now), "20:00");
assert.equal(formatWorkerRunningDuration("2026-08-31T15:17:45.000Z", now), "12:15");
assert.equal(formatWorkerRunningDuration("2026-08-31T13:17:45.000Z", now), "2:12:15");

const source = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
assert.match(source, /<WorkerRunningDuration startedAt=\{profile\.busy_since \|\| liveTab\?\.network_last_started_at\}/, "Chrome worker duration must use the actual generation start time");
assert.match(source, /<WorkerRunningDuration startedAt=\{worker\.started_at\}/, "API worker duration must use its job start time");
assert.doesNotMatch(source, /<code>\{profile\.email \? profile\.label : profile\.profile_id\}<\/code>/, "Chrome profile UUID must not remain visible on the card");

const component = fs.readFileSync(new URL("../src/worker-running-duration.jsx", import.meta.url), "utf8");
assert.match(component, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1_000\)/, "duration display must update every second without rerendering the whole worker list");
assert.match(component, /Hoạt động trong \{label\}/, "duration display must explain that the clock is elapsed activity time");

console.log("✓ Worker running duration and hidden Chrome UUID smoke test passed");
