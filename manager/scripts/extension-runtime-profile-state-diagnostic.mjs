import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const profileId = process.argv[2];
const extensionId = process.argv[3];
if (!profileId || !extensionId) throw new Error("profileId and extensionId required");
const profileRoot = path.join(os.homedir(), ".codexpro", "extension-runtime-browser-profiles", profileId, "user-data", "Default");

function readSetting(fileName) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(profileRoot, fileName), "utf8"));
    const setting = value?.extensions?.settings?.[extensionId] || {};
    return {
      path: String(setting.path || ""),
      state: Number.isInteger(setting.state) ? setting.state : null,
      disable_reasons: Array.isArray(setting.disable_reasons) ? setting.disable_reasons : [],
      location: Number.isInteger(setting.location) ? setting.location : null,
      was_installed_by_default: setting.was_installed_by_default === true,
      from_webstore: setting.from_webstore === true
    };
  } catch (error) {
    return { error: error?.code || error?.message || String(error) };
  }
}

console.log(JSON.stringify({
  secure_preferences: readSetting("Secure Preferences"),
  preferences: readSetting("Preferences")
}, null, 2));
