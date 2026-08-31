import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const bridge = fs.readFileSync(new URL("../../src/browserExtensionBridge.ts", import.meta.url), "utf8");

assert.match(source, /const CONNECTOR_AUTO_MIGRATION_RETRY_MS = 5 \* 60 \* 1000;/, "automatic connector migration must back off for five minutes after an attempt");
assert.match(source, /if \(busy \|\| connectorAutoMigrationInFlight\.current\) return;/, "only one connector migration may run at a time and normal busy work must take priority");
assert.match(source, /profile\.connector_update_required !== true/, "automatic migration must only target profiles explicitly marked for connector update");
assert.match(source, /!profileSafeForWorkerUpdate\(profile\)/, "automatic migration must wait until a browser worker is truly idle");
assert.match(source, /profileChecksInFlight\.current\.has\(profile\.profile_id\)/, "automatic migration must not race the connector verification probe for the same profile");
assert.match(source, /connectorAutoMigrationAttempts\.current\.set\(profileId, now\)/, "automatic migration must remember each attempt for retry throttling");
assert.match(source, /\.finally\(\(\) => \{[\s\S]*?connectorAutoMigrationAttempts\.current\.set\(profileId, Date\.now\(\)\)/, "retry backoff must restart when a migration finishes, including slow or failed migrations");
assert.match(source, /void api\.setupProfile\(profileId\)/, "automatic migration must reuse the verified setup-profile migration path");
assert.match(source, /connectorAutoMigrationInFlight\.current === profileId[\s\S]*?setAutoMigratingProfileId/, "automatic migration must release its single-flight guard after completion");
assert.match(source, /const profileBusy = busy === `profile:\$\{profile\.profile_id\}` \|\| autoMigratingProfileId === profile\.profile_id;/, "worker card must expose automatic migration as profile busy state");
assert.match(source, /disabled=\{Boolean\(busy\) \|\| Boolean\(autoMigratingProfileId\) \|\| profileChecking/, "manual connector setup must not collide with automatic migration");
assert.match(bridge, /!profile\.connectorInstalled && profile\.connectorServerFingerprint/, "a failed migration with the new fingerprint must remain queued for retry instead of becoming a false READY state");

console.log("✓ Connector auto-migration safety smoke test passed");
