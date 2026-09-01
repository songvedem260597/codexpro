import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const electronSource = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
assert.match(source, /Hãy kết nối API worker và Chrome profile của bạn/, "connected workers section must use the concise connection guidance");

assert.match(source, /<h2>Worker đã kết nối<\/h2>/, "overview must use the unified connected worker heading");
assert.doesNotMatch(source, /<h2>Profile đã kết nối<\/h2>/, "legacy Chrome-only heading must be removed");
assert.match(source, /header-server-actions[\s\S]*?profile-count[\s\S]*?profileSummary\.working[\s\S]*?profileSummary\.idle[\s\S]*?profileSummary\.hung[\s\S]*?profileSummary\.missing/, "overview must retain the worker state summary");
assert.doesNotMatch(source, /header-action-row/, "overview header must not reserve vertical space for extension and runtime action buttons");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
assert.match(styles, /\.page-overview #overview \.status-card \{ min-height: 92px;/, "overview runtime status cards must stay compact");
assert.match(styles, /\.page-overview #profiles \.profile-list\.is-card-layout \.profile-worker \{ width: 120px; height: 132px;/, "overview worker images must leave enough vertical room for the complete cards");
assert.match(styles, /\.page-overview \.header-server-actions \{ width: auto;[\s\S]*?\.profile-count \{ min-height: 34px;/, "overview worker totals must stay compact instead of stretching to the heading height");
assert.match(styles, /@media \(max-height: 820px\)[\s\S]*?\.profile-list\.is-card-layout \.profile-worker \{ width: 88px; height: 96px;/, "short overview windows must compact worker cards so all three remain fully visible");
assert.match(source, /<ApiWorkerCards[\s\S]*?workers=\{\(status\?\.workers \|\| \[\]\)\.filter[\s\S]*?customImages=\{activeWorkerImages\}/, "saved API workers must render in the connected worker list with the active built-in or custom GIF pack");
assert.match(source, /function ApiWorkerCards[\s\S]*?<WorkerIcon state=\{workerState\} customImages=\{customImages\}/, "API worker cards must use the animated worker icon");
assert.match(source, /const apiWorkers = \(status\?\.workers \|\| \[\]\)\.filter[\s\S]*?working:[\s\S]*?apiWorkers\.filter[\s\S]*?idle:[\s\S]*?apiWorkers\.filter/, "overview summary must count connected API workers");
assert.match(source, /function profileVisibleInWorkerList\(profile\)[\s\S]*?tab_count[\s\S]*?> 0 \|\| Boolean\(profile\?\.connector_installed\)/, "only a zero-tab profile without the CodexPro connector must be hidden from connected workers");
assert.match(source, /status\?\.browserProfiles \|\| \[\][\s\S]*?\.filter\(profileVisibleInWorkerList\)[\s\S]*?\.map\(\(profile\)/, "the connected worker cards must exclude background profiles with no tabs");
assert.match(source, /headlessWorker = profile\.headless[\s\S]*?headlessState\?\.workers[\s\S]*?sourceProfileDirectory/, "headless connected worker cards must resolve their clone source from the headless worker registry");
assert.match(source, /headlessSourceProfile = profile\.headless && profile\.source_profile_id[\s\S]*?headlessSourceLabel[\s\S]*?Clone từ <b>/, "headless connected worker cards must show which Chrome profile they were cloned from");
assert.match(styles, /\.profile-meta > \.headless-clone-source[\s\S]*?\.profile-list\.is-card-layout \.headless-clone-source/, "headless clone-source metadata must stay readable in row and card layouts");
assert.match(source, /function profileSafeForWorkerUpdate\(profile\)[\s\S]*?\["idle", "no_chatgpt"\]\.includes\(profile\?\.activity\)/, "a hidden background profile must remain safe to update while it has no work");
assert.match(electronSource, /const safeToReload = \(profile\)[\s\S]*?\["idle", "no_chatgpt"\]\.includes\(profile\.activity\)/, "the backend must reload an outdated background profile that has no work");
assert.match(source, /if \(refreshInFlight\.current\) \{[\s\S]*?refreshQueued\.current = true;[\s\S]*?void refresh\(queuedForeground\);/, "a refresh requested while saving must be queued instead of dropped");
assert.match(source, /mergeRuntimeStatus\(current, nextStatus\)/, "full status refreshes must preserve the last good worker snapshot across transient MCP failures");
assert.match(source, /status\?\.workerSnapshotStale[\s\S]*?MCP tạm thời không phản hồi, worker sẽ tự cập nhật khi kết nối phục hồi/, "the overview must disclose when preserved worker data is stale");
assert.match(source, /autoUpdateWorkers \|\| busy \|\| !status\?\.local\?\.ok \|\| status\?\.workerSnapshotStale/, "automatic worker updates must wait for a current online runtime snapshot");
assert.match(electronSource, /status\.workerSnapshotAvailable === false[\s\S]*?mode: "runtime_unavailable"/, "worker reload must defer instead of reporting no profiles when the MCP snapshot is temporarily unavailable");
assert.match(source, /connectorAutoMigrationInFlight\.current[\s\S]*?connector_update_required !== true[\s\S]*?profileSafeForWorkerUpdate\(profile\)[\s\S]*?api\.setupProfile\(profileId\)/, "outdated profile-bound connectors must auto-migrate sequentially only after the worker becomes idle");
assert.match(source, /CONNECTOR_AUTO_MIGRATION_RETRY_MS[\s\S]*?connectorAutoMigrationAttempts\.current\.get\(profile\.profile_id\)/, "failed automatic connector migration must use retry backoff");
assert.match(source, /autoMigratingProfileId === profile\.profile_id[\s\S]*?Đang cập nhật \+ test/, "the card must surface automatic connector migration as an in-progress update");

console.log("✓ Connected worker overview, queued refresh, and connector auto-migration smoke test passed");
