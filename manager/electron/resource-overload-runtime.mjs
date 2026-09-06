import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { app } from "electron";

import {
  createResourceOverloadTracker,
  RESOURCE_OVERLOAD_SAMPLE_INTERVAL_MS
} from "./resource-overload-watchdog.mjs";

const RESOURCE_LOG_MAX_BYTES = 2 * 1024 * 1024;
const home = process.env.CODEXPRO_HOME
  ? path.resolve(process.env.CODEXPRO_HOME)
  : path.join(os.homedir(), ".codexpro");
const currentLog = path.join(home, "manager-resource-overload.jsonl");
const previousLog = path.join(home, "manager-resource-overload.previous.jsonl");
const watchdogRunId = `resource_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
const tracker = createResourceOverloadTracker();
let timer = null;
let writeChain = Promise.resolve();

async function rotateIfNeeded() {
  try {
    const stat = await fs.promises.stat(currentLog);
    if (stat.size < RESOURCE_LOG_MAX_BYTES) return;
    await fs.promises.rm(previousLog, { force: true });
    await fs.promises.rename(currentLog, previousLog);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function persistIncident(incident) {
  const record = {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    action: "manager-resource-overload",
    manager_version: app.getVersion(),
    process_id: process.pid,
    watchdog_run_id: watchdogRunId,
    ...incident
  };
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      await fs.promises.mkdir(home, { recursive: true });
      await rotateIfNeeded();
      await fs.promises.appendFile(currentLog, `${JSON.stringify(record)}\n`, "utf8");
    })
    .catch(() => undefined);
}

function sample() {
  try {
    const incident = tracker.observe(app.getAppMetrics());
    if (incident) persistIncident(incident);
  } catch {
    // Stay silent in normal operation and never let monitoring destabilize Manager.
  }
}

function start() {
  if (timer) return;
  timer = setInterval(sample, RESOURCE_OVERLOAD_SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

app.whenReady().then(start).catch(() => undefined);
app.on("before-quit", stop);
