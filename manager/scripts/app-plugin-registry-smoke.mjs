import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppPluginRegistry } from "../electron/app-plugins/app-plugin-registry.mjs";
import { createManagedAppPluginInstaller } from "../electron/app-plugins/managed-app-plugin-installer.mjs";
import { createPluginSkillBundle } from "../electron/app-plugins/plugin-skill-bundle.mjs";
import { buildPluginTaskPrompt, normalizePluginSkills } from "../src/plugin-task-prompt.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-app-plugin-"));
const home = path.join(scratch, "home");

function createPlugin(folderName, manifestPatch = {}) {
  const root = path.join(scratch, folderName);
  const uiRoot = path.join(root, "dist");
  fs.mkdirSync(path.join(root, ".codexpro-plugin"), { recursive: true });
  fs.mkdirSync(uiRoot, { recursive: true });
  fs.writeFileSync(path.join(uiRoot, "index.html"), "<!doctype html><script src=\"./app.js\"></script>", "utf8");
  fs.writeFileSync(path.join(uiRoot, "app.js"), "document.body.textContent = 'plugin ready';", "utf8");
  fs.writeFileSync(path.join(root, ".codexpro-plugin", "plugin.json"), JSON.stringify({
    schema_version: 1,
    id: folderName,
    name: `Plugin ${folderName}`,
    version: "1.0.0",
    description: "Plugin smoke test",
    ui: { entry: "dist/index.html" },
    ...manifestPatch
  }, null, 2));
  return root;
}

try {
  const registry = createAppPluginRegistry({ home });
  const alphaRoot = createPlugin("alpha");
  const betaRoot = createPlugin("beta");

  const alpha = registry.install(alphaRoot);
  registry.install(betaRoot);
  assert.equal(alpha.id, "alpha");
  assert.equal(alpha.status, "ready");
  assert.equal(alpha.url, "codexpro-plugin://alpha/");
  assert.deepEqual(registry.list().map((plugin) => plugin.id), ["alpha", "beta"]);

  const entry = registry.resolveResource("alpha", "/");
  const asset = registry.resolveResource("alpha", "/app.js");
  assert.equal(entry.path, path.join(alphaRoot, "dist", "index.html"));
  assert.equal(entry.mime_type, "text/html; charset=utf-8");
  assert.equal(asset.path, path.join(alphaRoot, "dist", "app.js"));
  assert.equal(asset.mime_type, "text/javascript; charset=utf-8");
  assert.throws(() => registry.resolveResource("alpha", "/%2e%2e/.codexpro-plugin/plugin.json"), /ngoài thư mục giao diện/i);
  assert.throws(() => registry.resolveResource("missing", "/"), /chưa được cài/i);

  fs.rmSync(path.join(betaRoot, "dist", "index.html"));
  const afterBreak = registry.list();
  assert.equal(afterBreak.find((plugin) => plugin.id === "alpha")?.status, "ready");
  assert.equal(afterBreak.find((plugin) => plugin.id === "beta")?.status, "broken");

  const alphaManifestPath = path.join(alphaRoot, ".codexpro-plugin", "plugin.json");
  const alphaManifest = JSON.parse(fs.readFileSync(alphaManifestPath, "utf8"));
  fs.writeFileSync(alphaManifestPath, JSON.stringify({ ...alphaManifest, version: "1.1.0" }, null, 2));
  assert.equal(registry.reload("alpha").version, "1.1.0", "reload must pick up repo changes without restarting Manager");

  const invalidRoot = createPlugin("invalid", { id: "../invalid" });
  assert.throws(() => registry.install(invalidRoot), /id plugin/i);

  registry.uninstall("alpha");
  assert.equal(registry.list().some((plugin) => plugin.id === "alpha"), false);
  assert.equal(fs.existsSync(alphaRoot), true, "uninstall must never delete the external repository");

  const persisted = createAppPluginRegistry({ home });
  assert.deepEqual(persisted.list().map((plugin) => plugin.id), ["beta"], "registry must persist independently of the running app");

  const tasteSource = path.join(scratch, "taste-source");
  fs.mkdirSync(path.join(tasteSource, "skills", "gpt-tasteskill"), { recursive: true });
  fs.writeFileSync(path.join(tasteSource, "skills", "gpt-tasteskill", "SKILL.md"), [
    "---",
    "name: gpt-taste",
    "description: Design taste for GPT and Codex.",
    "---",
    "",
    "# GPT Taste",
    "",
    "Build a deliberate interface."
  ].join("\n"));
  execFileSync("git", ["init", "-b", "main"], { cwd: tasteSource, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=CodexPro Test", "-c", "user.email=test@codexpro.local", "add", "."], { cwd: tasteSource, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=CodexPro Test", "-c", "user.email=test@codexpro.local", "commit", "-m", "initial"], { cwd: tasteSource, stdio: "ignore" });

  const installer = createManagedAppPluginInstaller({
    home,
    registry: persisted,
    templateRoot: path.resolve(new URL("../electron/app-plugins/templates/taste-skill", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1")),
    catalog: [{
      id: "taste-skill",
      name: "Taste Skill",
      description: "Taste Skill test catalog",
      repository: tasteSource,
      branch: "main",
      adapter: "skill-library"
    }]
  });
  const installedTaste = await installer.install("taste-skill");
  assert.equal(installedTaste.plugin.id, "taste-skill");
  assert.equal(installedTaste.skill_count, 1);
  assert.equal(persisted.list().find((plugin) => plugin.id === "taste-skill")?.status, "ready");
  const managedTasteRoot = path.join(home, "app-plugin-repos", "taste-skill");
  const tasteCatalog = JSON.parse(fs.readFileSync(path.join(managedTasteRoot, "dist", "catalog.json"), "utf8"));
  assert.equal(tasteCatalog.skills[0].install_name, "gpt-taste");
  assert.equal(tasteCatalog.skills[0].group_id, "design-foundation");
  assert.equal(tasteCatalog.skills[0].group_exclusive, true);
  assert.match(tasteCatalog.skills[0].content, /Build a deliberate interface/);
  assert.match(fs.readFileSync(path.join(managedTasteRoot, ".codexpro-plugin", "plugin.json"), "utf8"), /codexpro-plugin:\/\/taste-skill/);

  fs.mkdirSync(path.join(tasteSource, "skills", "minimalist-skill"), { recursive: true });
  fs.writeFileSync(path.join(tasteSource, "skills", "minimalist-skill", "SKILL.md"), "---\nname: minimalist-ui\ndescription: Minimal UI.\n---\n\n# Minimal\n");
  execFileSync("git", ["-c", "user.name=CodexPro Test", "-c", "user.email=test@codexpro.local", "add", "."], { cwd: tasteSource, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=CodexPro Test", "-c", "user.email=test@codexpro.local", "commit", "-m", "add skill"], { cwd: tasteSource, stdio: "ignore" });
  const updatedTaste = await installer.update("taste-skill");
  assert.equal(updatedTaste.skill_count, 2, "updating must refresh the generated skill catalog without restarting Manager");
  assert.equal(installer.listCatalog()[0].installed, true);

  const managerMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const managerHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
  const center = fs.readFileSync(new URL("../src/app-plugin-center.jsx", import.meta.url), "utf8");
  const tasteTemplate = fs.readFileSync(new URL("../electron/app-plugins/templates/taste-skill/app.js", import.meta.url), "utf8");
  assert.match(managerMain, /protocol\.registerSchemesAsPrivileged/, "custom plugin resources must use a private Electron protocol");
  assert.match(managerHtml, /frame-src codexpro-plugin:/, "Manager CSP must allow the isolated plugin frame instead of rendering a blank panel");
  assert.match(managerMain, /codexpro:list-app-plugins/);
  assert.match(managerMain, /codexpro:install-app-plugin/);
  assert.match(managerMain, /codexpro:uninstall-app-plugin/);
  assert.match(preload, /listAppPlugins/);
  assert.match(preload, /installCatalogAppPlugin/);
  assert.match(app, /activePage === "plugins"/);
  assert.match(app, />Plugin<\/button>/, "Manager must expose a dedicated Plugin tab");
  assert.match(center, /sandbox="allow-scripts allow-forms allow-downloads"/, "plugin UI must run without same-origin or parent access");
  assert.match(center, /Không xóa repo/, "uninstall UI must explain that source code remains untouched");
  assert.match(center, /Taste Skill/, "the Plugin tab must expose the Taste Skill integration");
  assert.match(center, /codexpro:copy-text/, "sandboxed skill plugins need the limited copy bridge, not direct preload access");
  assert.match(tasteTemplate, /codexpro:use-skills/, "Taste Skill must send a multi-skill selection to Manager");
  assert.match(tasteTemplate, /state\.selected = \[\]/, "Taste Skill must keep a multi-select collection");
  assert.match(tasteTemplate, /group_exclusive/, "Taste Skill must replace conflicting choices inside exclusive groups");
  assert.match(tasteTemplate, /Chọn 1/, "Taste Skill must label exclusive groups clearly");
  assert.match(center, /Bước 2 · Chọn dự án/, "selected skills must open the project assignment flow");
  assert.match(center, /sendWorkerRequest/, "plugin tasks must support API workers");
  assert.match(center, /sendProfileRequest/, "plugin tasks must support Chrome workers");
  assert.match(center, /prepareAppPluginTask/, "plugin tasks must materialize selected skills as a verified attachment");
  assert.match(preload, /prepareAppPluginTask/);

  const normalizedSkills = normalizePluginSkills([
    { id: "a", install_name: "first-skill", description: "First", content: "Rule A" },
    { id: "a", install_name: "duplicate", content: "Ignored" },
    { id: "b", install_name: "second-skill", content: "Rule B" }
  ]);
  assert.deepEqual(normalizedSkills.map((skill) => skill.name), ["first-skill", "second-skill"], "skill payload must preserve selection order and remove duplicates");
  const pluginPrompt = buildPluginTaskPrompt("Redesign dashboard", normalizedSkills);
  assert.match(pluginPrompt, /# Yêu cầu người dùng[\s\S]*Redesign dashboard/);
  assert.match(pluginPrompt, /`first-skill`, `second-skill`/);
  assert.doesNotMatch(pluginPrompt, /Rule A|Rule B/, "large skill bodies must stay out of the 20,000-character chat request");
  assert.match(pluginPrompt, /file CodexPro Plugin Skill Bundle đính kèm/);
  assert.ok(pluginPrompt.length <= 20_000, "the composed Chrome request must stay inside the transport limit");
  assert.throws(() => buildPluginTaskPrompt("x".repeat(20_000), normalizedSkills), /dài quá/i);
  assert.throws(() => buildPluginTaskPrompt("", normalizedSkills), /nhập yêu cầu/i);
  assert.throws(() => normalizePluginSkills([
    { id: "minimal", install_name: "minimalist-ui", content: "Minimal", group_id: "visual-direction", group_label: "Phong cách", group_exclusive: true },
    { id: "brutal", install_name: "industrial-brutalist-ui", content: "Brutal", group_id: "visual-direction", group_label: "Phong cách", group_exclusive: true }
  ]), /chỉ được chọn một skill/i, "Manager must reject conflicting skills even if a plugin bypasses its own UI");

  const bundle = createPluginSkillBundle({
    registry: persisted,
    home,
    pluginId: "taste-skill",
    skillIds: tasteCatalog.skills.map((skill) => skill.id)
  });
  assert.equal(fs.existsSync(bundle.path), true);
  assert.deepEqual(bundle.skill_names, ["gpt-taste"]);
  assert.match(fs.readFileSync(bundle.path, "utf8"), /Skill 1: gpt-taste[\s\S]*Build a deliberate interface/);
  assert.throws(() => createPluginSkillBundle({ registry: persisted, home, pluginId: "taste-skill", skillIds: ["missing"] }), /không còn tồn tại/i);

  console.log("app-plugin-registry-smoke: ok");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
