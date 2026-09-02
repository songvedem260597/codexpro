import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const electronSource = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
assert.match(source, /Hãy kết nối API worker và Chrome profile của bạn/, "connected workers section must use the concise connection guidance");
assert.match(styles, /\.profile-worker \{[^}]*aspect-ratio:\s*1\s*\/\s*1;/, "worker GIF frames must enforce a square aspect ratio");
assert.match(styles, /\.profile-worker img \{[^}]*max-width:\s*100%;[^}]*max-height:\s*100%;[^}]*object-fit:\s*contain;/, "worker GIFs must stay contained inside their frame");
assert.match(styles, /\.profile-list\.is-card-layout \.profile-worker \{[^}]*width:\s*178px;[^}]*height:\s*178px;/, "card layout worker frames must remain square at the enlarged size");
assert.match(styles, /\.profile-layout-preview\.is-card \.profile-worker \{[^}]*width:\s*58px;[^}]*height:\s*58px;/, "card layout preview worker frames must remain square");

assert.match(source, /<h2>Worker đã kết nối<\/h2>/, "overview must use the unified connected worker heading");
assert.doesNotMatch(source, /<h2>Profile đã kết nối<\/h2>/, "legacy Chrome-only heading must be removed");
assert.match(source, /<ApiWorkerCards[\s\S]*?workers=\{\(status\?\.workers \|\| \[\]\)\.filter[\s\S]*?customImages=\{managerSettings\.workerImageDataUrls\}/, "saved API workers must render in the connected worker list with the configured GIF pack");
assert.match(source, /function ApiWorkerCards[\s\S]*?<WorkerIcon state=\{workerState\} customImages=\{customImages\}/, "API worker cards must use the animated worker icon");
assert.match(source, /const apiWorkers = \(status\?\.workers \|\| \[\]\)\.filter[\s\S]*?working:[\s\S]*?apiWorkers\.filter[\s\S]*?idle:[\s\S]*?apiWorkers\.filter/, "overview summary must count connected API workers");
assert.match(source, /function profileVisibleInWorkerList\(profile\)[\s\S]*?tab_count[\s\S]*?> 0 \|\| Boolean\(profile\?\.connector_installed\)/, "only a zero-tab profile without the CodexPro connector must be hidden from connected workers");
assert.match(source, /status\?\.browserProfiles \|\| \[\][\s\S]*?\.filter\(profileVisibleInWorkerList\)[\s\S]*?\.map\(\(profile\)/, "the connected worker cards must exclude background profiles with no tabs");
assert.match(source, /function profileSafeForWorkerUpdate\(profile\)[\s\S]*?\["idle", "no_chatgpt"\]\.includes\(profile\?\.activity\)/, "a hidden background profile must remain safe to update while it has no work");
assert.match(electronSource, /const safeToReload = \(profile\)[\s\S]*?\["idle", "no_chatgpt"\]\.includes\(profile\.activity\)/, "the backend must reload an outdated background profile that has no work");
assert.match(source, /if \(refreshInFlight\.current\) \{[\s\S]*?refreshQueued\.current = true;[\s\S]*?void refresh\(queuedForeground\);/, "a refresh requested while saving must be queued instead of dropped");
assert.match(source, /mergeRuntimeStatus\(current, nextStatus\)/, "full status refreshes must preserve the last good worker snapshot across transient MCP failures");
assert.match(source, /status\?\.workerSnapshotStale[\s\S]*?MCP tạm thời không phản hồi, worker sẽ tự cập nhật khi kết nối phục hồi/, "the overview must disclose when preserved worker data is stale");
assert.match(source, /workerSnapshotStaleReason === "empty-grace"[\s\S]*?Đang xác minh kết nối worker; tạm giữ trạng thái gần nhất/, "the overview must explain the temporary all-empty snapshot grace period");
assert.match(source, /const clearedEmptyGrace = !stabilized\.preserved[\s\S]*?browserProfiles === current\.browserProfiles && !clearedEmptyGrace/, "a heartbeat recovery must clear the empty-snapshot warning even when profile UI identity is unchanged");
assert.match(source, /autoUpdateWorkers \|\| busy \|\| !status\?\.local\?\.ok \|\| status\?\.workerSnapshotStale/, "automatic worker updates must wait for a current online runtime snapshot");
assert.match(electronSource, /status\.workerSnapshotAvailable === false[\s\S]*?mode: "runtime_unavailable"/, "worker reload must defer instead of reporting no profiles when the MCP snapshot is temporarily unavailable");
assert.match(source, /connectorAutoMigrationInFlight\.current[\s\S]*?connector_update_required !== true[\s\S]*?profileSafeForWorkerUpdate\(profile\)[\s\S]*?api\.setupProfile\(profileId\)/, "outdated profile-bound connectors must auto-migrate sequentially only after the worker becomes idle");
assert.match(source, /CONNECTOR_AUTO_MIGRATION_RETRY_MS[\s\S]*?connectorAutoMigrationAttempts\.current\.get\(profile\.profile_id\)/, "failed automatic connector migration must use retry backoff");
assert.match(source, /autoMigratingProfileId === profile\.profile_id[\s\S]*?Đang cập nhật \+ test/, "the card must surface automatic connector migration as an in-progress update");

console.log("✓ Connected worker overview, queued refresh, and connector auto-migration smoke test passed");
