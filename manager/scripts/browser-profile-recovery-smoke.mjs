import assert from "node:assert/strict";
import fs from "node:fs";
import { createBrowserProfileRecoveryPlanner } from "../electron/browser-profile-recovery.mjs";

const managerMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const extensionSource = fs.readFileSync(new URL("../../chrome-extension/service-worker.js", import.meta.url), "utf8");
const bridgeSource = fs.readFileSync(new URL("../../src/browserExtensionBridge.ts", import.meta.url), "utf8");
assert.match(managerMain, /startMacBrowserProfileRecoveryWatchdog\(\)/, "the macOS manager must start the browser profile recovery watchdog");
assert.match(managerMain, /--profile-directory=\$\{action\.profileDirectory\}/, "recovery must reopen the exact configured Chrome profile directory");
assert.match(managerMain, /process\.platform !== "darwin"/, "automatic source-profile recovery must remain macOS-specific");
assert.match(managerMain, /macSourceChromeExecutable\(\)[\s\S]*?\/Applications\/Google Chrome\.app/, "source-profile recovery must use regular Google Chrome rather than Chrome for Testing");
assert.match(extensionSource, /if\(tabLimit===MAC_MAX_CHATGPT_TABS&&current\.length\)[\s\S]*?mac_single_tab_limit[\s\S]*?return \{\.\.\.updated,codexpro_reused:true/, "macOS must reuse its one allowed ChatGPT tab instead of deleting the last profile window");
assert.match(extensionSource, /preserveOnlyMacTab[\s\S]*?chrome\.tabs\.create\(createArgs\)[\s\S]*?renderer_replacement_completed/, "renderer recovery must create the replacement before removing the only macOS ChatGPT tab");
assert.match(extensionSource, /chrome\.windows\.onRemoved[\s\S]*?external_or_chrome[\s\S]*?lifecycle_event/, "the extension must persist window-removal evidence for future incident diagnosis");
assert.match(bridgeSource, /lifecycleEvent[\s\S]*?source\.lifecycle_event[\s\S]*?lifecycle_event: profile\.lifecycleEvent/, "the runtime bridge must forward extension lifecycle evidence to Manager diagnostics");
assert.match(managerMain, /browser-profile-lifecycle-event[\s\S]*?lifecycle_event/, "Manager must record the exact tab/window lifecycle cause in its diagnostic log");
assert.match(extensionSource, /PROFILE_LIFECYCLE_HISTORY_STORAGE_KEY[\s\S]*?PROFILE_LIFECYCLE_HISTORY_LIMIT = 20/, "the extension must retain a bounded lifecycle history instead of overwriting the shutdown cause");
assert.match(extensionSource, /tab_close_requested[\s\S]*?await chrome\.tabs\.remove/, "CodexPro-initiated tab closes must persist their reason before the destructive remove");
assert.match(extensionSource, /window_close_requested[\s\S]*?browser_control_close_profile[\s\S]*?await chrome\.windows\.remove/, "explicit profile closes must persist their reason before closing Chrome windows");
assert.match(extensionSource, /lifecycle_events:profileLifecycleHistory/, "the extension profile summary must expose lifecycle history to the runtime bridge");
assert.match(bridgeSource, /lifecycleEvents[\s\S]*?source\.lifecycle_events[\s\S]*?lifecycle_events: profile\.lifecycleEvents\.slice\(-20\)/, "the runtime bridge must preserve bounded lifecycle history for Manager diagnostics");
assert.match(managerMain, /browserProfileLifecycleSeen[\s\S]*?event_id[\s\S]*?event_reason/, "Manager must de-duplicate and log lifecycle events with stable ids and reasons");
assert.match(managerMain, /profile-removed-from-stream[\s\S]*?last_lifecycle_event[\s\S]*?last_lifecycle_event_age_ms/, "profile disappearance logs must carry the most recent lifecycle cause and its age");
assert.match(managerMain, /browser-profile-auto-recovery-launched[\s\S]*?recovery_evidence[\s\S]*?last_lifecycle_event/, "automatic relaunch logs must include the lifecycle evidence that justified recovery");
assert.match(bridgeSource, /PROFILE_TTL_MS = 3 \* 60_000[\s\S]*?PROFILE_RETENTION_MS = 24 \* 60 \* 60_000/, "source Chrome profiles must tolerate suspended MV3 heartbeats and remain visible offline for a day");
assert.match(bridgeSource, /browserProfileRetentionState\(profile, now\)\.visible/, "normal Chrome profiles must remain in Manager after heartbeat expiry instead of disappearing immediately");
assert.match(bridgeSource, /const \{ connected \} = browserProfileRetentionState\(profile, now\)[\s\S]*?connected,/, "retained source profiles must switch to offline instead of being reported online forever");
assert.match(bridgeSource, /browser-profiles\.json[\s\S]*?loadBrowserProfileRegistry\(state\)/, "the runtime bridge must restore retained source profiles after a process restart");
assert.match(bridgeSource, /restored: true[\s\S]*?tabs: \[\][\s\S]*?recentConversations: \[\]/, "restored profiles must start offline without stale tab or task activity");
assert.match(bridgeSource, /profile\?\.headless !== true[\s\S]*?browserProfileRetentionState\(profile, now\)\.visible/, "headless and expired profiles must not be persisted as duplicate cards");
assert.match(fs.readFileSync(new URL("../electron/browser-profile-recovery.mjs", import.meta.url), "utf8"), /window_removed[\s\S]*?browser_control_close_profile[\s\S]*?evidenceMaxAgeMs/, "automatic recovery must require recent window-removal evidence and ignore explicit CodexPro closes");

const workers = [{
  label: "CHATGPT 4",
  sourceProfileName: "CHATGPT 4",
  sourceProfileId: "profile-22-id",
  sourceProfileDirectory: "Profile 22",
  pid: 0,
  running: false
}];

let nowMs = Date.parse("2026-09-02T14:00:00.000Z");
const planner = createBrowserProfileRecoveryPlanner({
  now: () => nowMs,
  missingGraceMs: 100,
  launchCooldownMs: 500,
  startingGraceMs: 200,
  evidenceMaxAgeMs: 1_000
});
const offlineWithoutEvidence = [{ profile_id: "profile-22-id", connected: false, lifecycle_events: [] }];
assert.deepEqual(planner.observe({ profiles: offlineWithoutEvidence, workers }), [], "a transient missing heartbeat must not launch Chrome immediately");
nowMs += 101;
assert.deepEqual(planner.observe({ profiles: offlineWithoutEvidence, workers }), [], "heartbeat loss alone must never auto-open another Chrome window");

let evidenceNowMs = Date.parse("2026-09-02T14:10:00.000Z");
const evidencePlanner = createBrowserProfileRecoveryPlanner({
  now: () => evidenceNowMs,
  missingGraceMs: 100,
  launchCooldownMs: 500,
  startingGraceMs: 200,
  evidenceMaxAgeMs: 1_000
});
const lifecycleEvent = {
  type: "window_removed",
  reason: "external_or_chrome",
  at: new Date(evidenceNowMs).toISOString(),
  window_id: 123
};
const offlineWithEvidence = [{
  profile_id: "profile-22-id",
  connected: false,
  lifecycle_event: lifecycleEvent,
  lifecycle_events: [lifecycleEvent]
}];
assert.deepEqual(evidencePlanner.observe({ profiles: offlineWithEvidence, workers }), [], "even a real window removal must honor the recovery grace period");
evidenceNowMs += 101;
assert.deepEqual(evidencePlanner.observe({ profiles: offlineWithEvidence, workers }), [{
  profileId: "profile-22-id",
  profileDirectory: "Profile 22",
  label: "CHATGPT 4",
  missingForMs: 101,
  recoveryReason: "external_or_chrome",
  lifecycleEvent
}], "a recent real Chrome window removal may trigger bounded recovery");

evidenceNowMs += 200;
assert.deepEqual(evidencePlanner.observe({ profiles: offlineWithEvidence, workers }), [], "the launch cooldown must prevent duplicate Chrome windows");
evidenceNowMs += 301;
assert.equal(evidencePlanner.observe({ profiles: offlineWithEvidence, workers }).length, 1, "qualified recovery evidence may retry after cooldown while still fresh");
assert.deepEqual(evidencePlanner.observe({ profiles: [{ profile_id: "profile-22-id", connected: true }], workers }), [], "a recovered heartbeat must clear missing state");
assert.deepEqual(evidencePlanner.snapshot(), [], "recovered profiles must not retain stale recovery state");

let blockedNowMs = Date.parse("2026-09-02T14:20:00.000Z");
const blockedPlanner = createBrowserProfileRecoveryPlanner({ now: () => blockedNowMs, missingGraceMs: 0, evidenceMaxAgeMs: 1_000 });
const explicitClose = {
  type: "window_removed",
  reason: "browser_control_close_profile",
  at: new Date(blockedNowMs).toISOString()
};
assert.deepEqual(blockedPlanner.observe({ profiles: [{ profile_id: "profile-22-id", connected: false, lifecycle_events: [explicitClose] }], workers }), [], "an explicit CodexPro close must not be undone by auto-recovery");
blockedNowMs += 2_000;
const staleRemoval = { type: "window_removed", reason: "external_or_chrome", at: new Date(blockedNowMs - 2_000).toISOString() };
assert.deepEqual(blockedPlanner.observe({ profiles: [{ profile_id: "profile-22-id", connected: false, lifecycle_events: [staleRemoval] }], workers }), [], "stale lifecycle evidence must not justify opening a new Chrome window");

blockedNowMs += 1;
assert.deepEqual(blockedPlanner.observe({ profiles: [], workers: [{ ...workers[0], running: true, pid: 42 }] }), [], "a running headless clone must not race source-profile recovery");
blockedNowMs += 1;
assert.deepEqual(blockedPlanner.observe({ profiles: [], workers: [{ ...workers[0], startingAt: new Date(blockedNowMs).toISOString() }] }), [], "a starting headless clone must not race source-profile recovery");

console.log("browser-profile-recovery-smoke: ok");
