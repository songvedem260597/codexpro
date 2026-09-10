import assert from "node:assert/strict";

import { createWorkerUpdateBroadcaster } from "../electron/worker-update-broadcaster.mjs";

const sent = [];
const timers = [];
const observedUpdates = [];
const notifications = [];
let notificationsEnabled = true;
let notificationSupported = true;

class FakeNotification {
  static isSupported() {
    return notificationSupported;
  }

  constructor(options) {
    this.options = options;
    notifications.push({ options, shown: false });
  }

  show() {
    notifications.at(-1).shown = true;
  }
}

function createWindow(name, { destroyed = false, webContentsDestroyed = false } = {}) {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => webContentsDestroyed,
      send: (channel, payload) => sent.push({ name, channel, payload })
    }
  };
}

const windows = [
  createWindow("live"),
  createWindow("destroyed-window", { destroyed: true }),
  createWindow("destroyed-web-contents", { webContentsDestroyed: true })
];

const interruptionAlertTracker = {
  observeApiWorker(update) {
    observedUpdates.push(update);
    if (update?.emit_alert) {
      return {
        title: update.alert_title,
        body: update.alert_body,
        silent: update.alert_silent
      };
    }
    return null;
  }
};

const { queueWorkerUpdate, showManagerNotification } = createWorkerUpdateBroadcaster({
  BrowserWindow: { getAllWindows: () => windows },
  Notification: FakeNotification,
  interruptionAlertTracker,
  readManagerSettings: () => ({ taskNotifications: notificationsEnabled }),
  setTimeoutImpl: (callback, delay) => {
    timers.push({ callback, delay });
    return { timer: timers.length };
  }
});

queueWorkerUpdate({ local_worker_id: "   " });
assert.equal(observedUpdates.length, 0, "blank local worker IDs must be ignored before interruption tracking");
assert.equal(timers.length, 0);

const first = {
  local_worker_id: "worker-a",
  activity: "working",
  job_id: "job-old",
  task_title: "Old title"
};
queueWorkerUpdate(first);
assert.equal(timers.length, 1);
assert.equal(timers[0].delay, 40, "worker updates must keep the 40ms batching window");

const latest = {
  local_worker_id: "worker-a",
  activity: "working",
  job_id: "job-123",
  task_title: "Worker task",
  current_workspace_root: "C:\\repo",
  last_request: "request text",
  result: { text: "result text", usage: { input_tokens: 12, output_tokens: 4 } },
  error: "last error",
  stream_text: "stream body",
  stream_revision: "7",
  stream_phase: "generating",
  stream_updated_at: "2026-09-11T00:00:00Z",
  stream_tool_status: "running",
  workflow_id: "workflow-1",
  workflow_version: "v2",
  workflow_evidence: "evidence",
  started_at: "start",
  finished_at: "finish",
  emit_alert: true,
  alert_title: `  ${"T".repeat(140)}  `,
  alert_body: `  ${"B".repeat(540)}  `,
  alert_silent: true
};
queueWorkerUpdate(latest);
queueWorkerUpdate({
  local_worker_id: "worker-b",
  activity: "idle",
  job_id: "job-456",
  task_title: "Idle task",
  current_workspace_root: "C:\\other"
});
assert.equal(timers.length, 1, "multiple updates in one batch must share one timer");
assert.equal(observedUpdates.length, 3, "interruption tracker must observe every accepted API-worker update before dedupe");
assert.equal(notifications.length, 1);
assert.equal(notifications[0].shown, true);
assert.equal(notifications[0].options.title, "T".repeat(120));
assert.equal(notifications[0].options.body, "B".repeat(500));
assert.equal(notifications[0].options.silent, true);

timers[0].callback();
assert.equal(sent.length, 2, "only the live window should receive the two deduped worker updates");
assert.ok(sent.every((event) => event.name === "live"));
assert.ok(sent.every((event) => event.channel === "codexpro:worker-update"));

const workerA = sent.find((event) => event.payload.worker_id === "api:worker-a")?.payload;
assert.deepEqual(workerA, {
  worker_id: "api:worker-a",
  activity: "working",
  current_task_id: "job-123",
  current_task_title: "Worker task",
  current_workspace_root: "C:\\repo",
  last_task_id: "job-123",
  last_task_title: "Worker task",
  last_request: "request text",
  last_result: "result text",
  last_error: "last error",
  stream_text: "stream body",
  stream_revision: 7,
  stream_phase: "generating",
  stream_updated_at: "2026-09-11T00:00:00Z",
  stream_tool_status: "running",
  workflow_id: "workflow-1",
  workflow_version: "v2",
  workflow_evidence: "evidence",
  started_at: "start",
  finished_at: "finish",
  usage: { input_tokens: 12, output_tokens: 4 }
});

const workerB = sent.find((event) => event.payload.worker_id === "api:worker-b")?.payload;
assert.equal(workerB.activity, "idle");
assert.equal(workerB.current_task_id, "");
assert.equal(workerB.current_task_title, "");
assert.equal(workerB.current_workspace_root, "");
assert.equal(workerB.last_task_id, "job-456");
assert.equal(workerB.last_task_title, "Idle task");

notificationsEnabled = false;
queueWorkerUpdate({
  local_worker_id: "worker-c",
  emit_alert: true,
  alert_title: "suppressed",
  alert_body: "suppressed"
});
assert.equal(notifications.length, 1, "taskNotifications=false must suppress interruption notifications");
assert.equal(timers.length, 2, "flush completion must allow scheduling the next 40ms batch");
assert.equal(timers[1].delay, 40);
timers[1].callback();
assert.equal(sent.length, 3);

notificationSupported = false;
assert.equal(showManagerNotification({ title: "unsupported", body: "unsupported" }), false);
assert.equal(notifications.length, 1);
notificationSupported = true;
assert.equal(showManagerNotification({ title: "   ", body: " body ", silent: false }), true);
assert.deepEqual(notifications.at(-1), {
  options: { title: "CodexPro", body: "body", silent: false },
  shown: true
});

console.log("worker-update-broadcaster-smoke: ok");
