import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const bridge = fs.readFileSync(new URL("../../src/browserExtensionBridge.ts", import.meta.url), "utf8");

assert.doesNotMatch(source, /connectorAutoMigrationInFlight|connectorAutoMigrationAttempts|CONNECTOR_AUTO_MIGRATION_RETRY_MS/, "connector migration must never be triggered by background status updates");
assert.match(source, /async function setupProfile\(profile\)[\s\S]*?api\.setupProfile\(profile\.profile_id\)/, "connector migration remains available as an explicit user action");
assert.match(source, /connectorActionIsSetup \? setupProfile\(profile\) : checkProfileConnector\(profile\)/, "unknown connector state must check rather than setup");
assert.match(source, /connectorMissingConfirmed[\s\S]*?confirmedMissingProfiles\.includes/, "setup is exposed only after a manual missing result in the current Manager session");
assert.match(source, /connectorDisconnected \? "CHƯA KẾT NỐI CODEXPRO"/, "a listed but disconnected definition must not be labelled as missing");
assert.match(source, /connectorDisconnected[\s\S]*?"Kết nối CodexPro"/, "a disconnected definition must offer Connect rather than Add");
assert.match(bridge, /connectorInstalled = profile\.connectorInstalled && connectorProfileBound && !connectorVerificationRequired/, "only current connected evidence may produce READY after a manual migration");

console.log("✓ Connector manual-migration safety smoke test passed");
