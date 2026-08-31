import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");

assert.match(source, /<h2>Worker đã kết nối<\/h2>/, "overview must use the unified connected worker heading");
assert.doesNotMatch(source, /<h2>Profile đã kết nối<\/h2>/, "legacy Chrome-only heading must be removed");
assert.match(source, /<ApiWorkerCards[\s\S]*?workers=\{\(status\?\.workers \|\| \[\]\)\.filter[\s\S]*?customImages=\{managerSettings\.workerImageDataUrls\}/, "saved API workers must render in the connected worker list with the configured GIF pack");
assert.match(source, /function ApiWorkerCards[\s\S]*?<WorkerIcon state=\{workerState\} customImages=\{customImages\}/, "API worker cards must use the animated worker icon");
assert.match(source, /const apiWorkers = \(status\?\.workers \|\| \[\]\)\.filter[\s\S]*?working:[\s\S]*?apiWorkers\.filter[\s\S]*?idle:[\s\S]*?apiWorkers\.filter/, "overview summary must count connected API workers");
assert.match(source, /if \(refreshInFlight\.current\) \{[\s\S]*?refreshQueued\.current = true;[\s\S]*?void refresh\(queuedForeground\);/, "a refresh requested while saving must be queued instead of dropped");

console.log("✓ Connected worker overview and queued refresh smoke test passed");
