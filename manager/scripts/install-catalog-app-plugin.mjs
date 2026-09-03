import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAppPluginRegistry } from "../electron/app-plugins/app-plugin-registry.mjs";
import { createManagedAppPluginInstaller } from "../electron/app-plugins/managed-app-plugin-installer.mjs";

const id = String(process.argv[2] || "").trim();
if (!id) throw new Error("Thiếu plugin id. Ví dụ: npm run app-plugin:install -- taste-skill");
const home = process.env.CODEXPRO_HOME ? path.resolve(process.env.CODEXPRO_HOME) : path.join(os.homedir(), ".codexpro");
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const registry = createAppPluginRegistry({ home });
const installer = createManagedAppPluginInstaller({
  home,
  registry,
  templateRoot: path.join(scriptRoot, "..", "electron", "app-plugins", "templates", "taste-skill"),
  gitDiagramTemplateRoot: path.join(scriptRoot, "..", "electron", "app-plugins", "templates", "gitdiagram")
});
const catalogItem = installer.listCatalog().find((item) => item.id === id);
if (!catalogItem) throw new Error(`Không tìm thấy plugin ${id} trong catalog.`);
const result = catalogItem.downloaded ? await installer.update(id) : await installer.install(id);
console.log(JSON.stringify({
  ok: true,
  action: catalogItem.downloaded ? "updated" : "installed",
  plugin: result.plugin,
  skill_count: result.skill_count,
  source_commit: result.source_commit
}, null, 2));
