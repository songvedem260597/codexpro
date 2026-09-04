import assert from "node:assert/strict";
import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ALL_ALLOWED_WORKSPACES, createManagerSettingsStore } from "../electron/manager-settings-store.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-manager-settings-store-"));

try {
  const store = createManagerSettingsStore({ home, mimeTypeForFile: () => "image/png" });
  const defaults = store.managerSettingsPayload();
  assert.equal(defaults.chatWidth, 940);
  assert.equal(defaults.chatHeight, 330);
  assert.equal(defaults.workingBorderStyle, "shine");
  assert.equal(defaults.selectedWorkerPackId, "default");
  assert.deepEqual(defaults.workerImagePacks, []);
  assert.match(defaults.globalRules, /CodexPro Global Rules/);

  const repoRoot = path.join(home, "repo");
  const saved = store.saveManagerSettingsPatch({
    chatWidth: 1180,
    chatHeight: 520,
    showChatConversationSelector: false,
    fontFamily: "be-vietnam-pro",
    headingFontFamily: "manrope",
    monoFontFamily: "jetbrains-mono",
    fontWeight: 500,
    profileLayout: "cards",
    profileCardHeight: 470,
    workingBorderStyle: "beam",
    autoRecovery: true,
    autoUpdateWorkers: true,
    taskNotifications: false,
    appBackgroundBlur: 9,
    appBackgroundDim: 63,
    globalRules: "# CodexPro Global Rules\n\n- smoke-global-rule\n",
    repoSelections: {
      profileA: ALL_ALLOWED_WORKSPACES,
      profileB: repoRoot
    }
  });
  assert.equal(saved.chatWidth, 1180);
  assert.equal(saved.chatHeight, 520);
  assert.equal(saved.showChatConversationSelector, false);
  assert.equal(saved.headingFontFamily, "manrope");
  assert.equal(saved.monoFontFamily, "jetbrains-mono");
  assert.equal(saved.fontWeight, 500);
  assert.equal(saved.profileLayout, "cards");
  assert.equal(saved.profileCardHeight, 470);
  assert.equal(saved.workingBorderStyle, "beam");
  assert.equal(saved.autoRecovery, true);
  assert.equal(saved.autoUpdateWorkers, true);
  assert.equal(saved.taskNotifications, false);
  assert.equal(saved.appBackgroundBlur, 9);
  assert.equal(saved.appBackgroundDim, 63);
  assert.equal(saved.repoSelections.profileA, ALL_ALLOWED_WORKSPACES);
  assert.equal(saved.repoSelections.profileB, path.resolve(repoRoot));
  assert.match(fs.readFileSync(path.join(home, "CODEXPRO.md"), "utf8"), /smoke-global-rule/);
  assert.doesNotMatch(fs.readFileSync(path.join(home, "manager-settings.json"), "utf8"), /globalRules/);

  const created = store.createWorkerImagePack("Smoke pack");
  const pack = created.workerImagePacks.find((item) => item.name === "Smoke pack");
  assert.ok(pack?.id);
  assert.equal(created.selectedWorkerPackId, pack.id);

  const selectedDefault = store.selectWorkerImagePack("default");
  assert.equal(selectedDefault.selectedWorkerPackId, "default");
  const removed = store.deleteWorkerImagePack(pack.id);
  assert.equal(removed.selectedWorkerPackId, "default");
  assert.equal(removed.workerImagePacks.some((item) => item.id === pack.id), false);

  const reset = store.resetManagerSettings();
  assert.equal(reset.chatWidth, 940);
  assert.equal(reset.chatHeight, 330);
  assert.equal(reset.workingBorderStyle, "shine");
  assert.equal(reset.repoSelections.profileA, ALL_ALLOWED_WORKSPACES);
  assert.equal(reset.repoSelections.profileB, path.resolve(repoRoot));
  assert.match(reset.globalRules, /smoke-global-rule/, "reset must preserve the separately managed Global Rules file");

  console.log("manager-settings-store-smoke: ok");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
  app.quit();
}
