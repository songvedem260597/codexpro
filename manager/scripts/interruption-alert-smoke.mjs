import assert from "node:assert/strict";
import fs from "node:fs";

import { createInterruptionAlertTracker } from "../electron/interruption-alert.mjs";

const tracker = createInterruptionAlertTracker();

assert.equal(tracker.observeApiWorker({ local_worker_id: "worker-a", activity: "working", task_title: "Phân tích mã nguồn repo", current_workspace_root: "C:/work/codexpro-source" }), null);
assert.equal(tracker.observeApiWorker({ local_worker_id: "worker-a", activity: "working", stream_phase: "tool" }), null);
const workerAlert = tracker.observeApiWorker({ local_worker_id: "worker-a", activity: "failed", task_title: "Phân tích mã nguồn repo", error: "Provider network timeout" });
assert.equal(workerAlert?.title, "CodexPro · Task bị gián đoạn");
assert.match(workerAlert?.body || "", /Phân tích mã nguồn repo/);
assert.match(workerAlert?.body || "", /codexpro-source/);
assert.equal(workerAlert?.task_status, "unfinished");
assert.match(workerAlert?.body || "", /Task chưa hoàn thành/);
assert.match(workerAlert?.body || "", /chưa commit/);
assert.equal(tracker.observeApiWorker({ local_worker_id: "worker-a", activity: "failed", error: "Provider network timeout" }), null, "a repeated failed snapshot must not spam notifications");
assert.equal(tracker.observeApiWorker({ local_worker_id: "worker-b", activity: "idle" }), null);
assert.equal(tracker.observeApiWorker({ local_worker_id: "worker-b", activity: "failed", error: "offline" }), null, "a worker that was not observed running is not an interrupted task");

const tunnelAlert = tracker.observeRuntimeHealth({
  details: { transition: "offline", probe_label: "Public tunnel" },
  message: "Public tunnel health probe thất bại: timeout"
}, [{ task_id: "cpt_active", task_title: "Sửa cảnh báo tunnel", workspace: "C:/work/codexpro-source" }]);
assert.equal(tunnelAlert?.title, "CodexPro · Mất kết nối");
assert.match(tunnelAlert?.body || "", /Public tunnel/);
assert.match(tunnelAlert?.body || "", /Sửa cảnh báo tunnel/);
assert.match(tunnelAlert?.body || "", /codexpro-source/);
assert.match(tunnelAlert?.body || "", /đang làm dở/);
assert.equal(tunnelAlert?.task_status, "unfinished");
assert.equal(tracker.observeRuntimeHealth({ details: { transition: "still-offline", probe_label: "Public tunnel" } }), null, "repeat health logs must not spam Windows notifications");
assert.equal(tracker.observeRuntimeHealth({ details: { transition: "recovered", probe_label: "Public tunnel" } }), null);

const main = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
assert.match(main, /createInterruptionAlertTracker/);
assert.match(main, /observeApiWorker\(update\)[\s\S]{0,300}taskNotifications[\s\S]{0,300}showManagerNotification/);
assert.match(main, /observeRuntimeHealth\(event, activeBrowserTaskSummaries\(\)\)[\s\S]{0,300}taskNotifications[\s\S]{0,300}showManagerNotification/);

const renderer = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
assert.match(renderer, /Task bị gián đoạn[\s\S]{0,250}chưa commit/, "Chrome task failures must name the interrupted work and warn about unfinished code");

console.log("✓ Runtime, tunnel, and API-worker interruption alert smoke test passed");
