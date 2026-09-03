import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAppPluginRegistry } from "../electron/app-plugins/app-plugin-registry.mjs";
import { buildGitDiagramArchitecture } from "../electron/app-plugins/gitdiagram-analyzer.mjs";
import { createManagedAppPluginInstaller } from "../electron/app-plugins/managed-app-plugin-installer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const managerRoot = path.resolve(here, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-gitdiagram-"));

try {
  const source = path.join(scratch, "gitdiagram-source");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "README.md"), "# GitDiagram fixture\n", "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: source, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=CodexPro Test", "-c", "user.email=test@codexpro.local", "add", "."], { cwd: source, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=CodexPro Test", "-c", "user.email=test@codexpro.local", "commit", "-m", "fixture"], { cwd: source, stdio: "ignore" });

  const home = path.join(scratch, "home");
  const registry = createAppPluginRegistry({ home });
  const installer = createManagedAppPluginInstaller({
    home,
    registry,
    templateRoot: path.join(managerRoot, "electron", "app-plugins", "templates", "taste-skill"),
    gitDiagramTemplateRoot: path.join(managerRoot, "electron", "app-plugins", "templates", "gitdiagram"),
    catalog: [{
      id: "gitdiagram",
      name: "GitDiagram",
      description: "Architecture-first local repo fixture",
      repository: source,
      homepage: "https://github.com/ahmedkhaleel2004/gitdiagram",
      branch: "main",
      adapter: "gitdiagram-local",
      license: "MIT"
    }]
  });

  const installed = await installer.install("gitdiagram");
  assert.equal(installed.plugin.id, "gitdiagram");
  assert.equal(installed.plugin.status, "ready");
  assert.equal(installed.skill_count, 0);
  const managedRoot = path.join(home, "app-plugin-repos", "gitdiagram");
  const manifest = JSON.parse(fs.readFileSync(path.join(managedRoot, ".codexpro-plugin", "plugin.json"), "utf8"));
  const meta = JSON.parse(fs.readFileSync(path.join(managedRoot, ".codexpro-plugin", "ui", "meta.json"), "utf8"));
  assert.equal(manifest.adapter, "gitdiagram-local");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.ui.entry, ".codexpro-plugin/ui/index.html");
  assert.equal(meta.source_commit, installed.source_commit);
  assert.ok(fs.existsSync(path.join(managedRoot, ".codexpro-plugin", "ui", "app.js")));
  const entry = registry.resolveResource("gitdiagram", "/");
  const appAsset = registry.resolveResource("gitdiagram", "/app.js");
  assert.equal(entry.path, fs.realpathSync(path.join(managedRoot, ".codexpro-plugin", "ui", "index.html")));
  assert.equal(appAsset.path, fs.realpathSync(path.join(managedRoot, ".codexpro-plugin", "ui", "app.js")));
  assert.equal(appAsset.mime_type, "text/javascript; charset=utf-8");
  assert.equal(installer.listCatalog()[0].installed, true);
  assert.equal(installer.listCatalog()[0].skill_count, 0);

  const managedUiRoot = path.join(managedRoot, ".codexpro-plugin", "ui");
  const bundledUiRoot = path.join(managerRoot, "electron", "app-plugins", "templates", "gitdiagram");
  fs.writeFileSync(path.join(managedUiRoot, "index.html"), '<select id="project"></select>\n', "utf8");
  fs.writeFileSync(path.join(managedUiRoot, "styles.css"), 'button#analyze { background: green; }\n', "utf8");
  const refreshedCatalog = installer.listCatalog();
  assert.equal(refreshedCatalog[0].installed, true);
  const refreshedIndex = fs.readFileSync(path.join(managedUiRoot, "index.html"), "utf8");
  const refreshedStyles = fs.readFileSync(path.join(managedUiRoot, "styles.css"), "utf8");
  assert.equal(refreshedIndex, fs.readFileSync(path.join(bundledUiRoot, "index.html"), "utf8"), "catalog load must refresh a stale managed GitDiagram adapter from the bundled Manager template");
  assert.equal(refreshedStyles, fs.readFileSync(path.join(bundledUiRoot, "styles.css"), "utf8"));
  assert.match(refreshedIndex, /project-dropdown-trigger/);
  assert.doesNotMatch(refreshedIndex, /<select\b/i);
  assert.match(refreshedStyles, /\.action\.primary/);
  assert.doesNotMatch(refreshedStyles, /button#analyze/);

  const architecture = buildGitDiagramArchitecture({
    root: "C:\\repo",
    codexgraph: {
      coverage: { symbolCount: 240, relationshipCount: 520 },
      nodes: [
        { key: 1, path: "manager/src/main.jsx", kind: "module" },
        { key: 2, path: "manager/src/app-plugin-center.jsx", kind: "module" },
        { key: 3, path: "manager/electron/main.mjs", kind: "module" },
        { key: 4, path: "manager/electron/worker-core/runtime.mjs", kind: "module" },
        { key: 5, path: "chrome-extension/service-worker.js", kind: "module" },
        { key: 6, path: "src/analysis/index.ts", kind: "module" },
        { key: 7, path: "src/analysis/projection.ts", kind: "module" },
        { key: 8, path: "manager/scripts/example.test.mjs", kind: "module" }
      ],
      edges: [
        { source: 1, target: 3, kind: "ipc" },
        { source: 2, target: 3, kind: "ipc" },
        { source: 3, target: 4, kind: "calls" },
        { source: 4, target: 5, kind: "calls" },
        { source: 3, target: 6, kind: "calls" },
        { source: 6, target: 7, kind: "contains" },
        { source: 8, target: 1, kind: "tests" }
      ],
      warnings: []
    }
  });
  const labels = architecture.nodes.map((node) => node.label);
  assert.ok(labels.includes("Manager UI"), `missing Manager UI in ${labels.join(", ")}`);
  assert.ok(labels.includes("Manager Runtime"), `missing Manager Runtime in ${labels.join(", ")}`);
  assert.ok(labels.includes("Chrome Extension"), `missing Chrome Extension in ${labels.join(", ")}`);
  assert.ok(labels.includes("Analysis Engine"), `missing Analysis Engine in ${labels.join(", ")}`);
  assert.ok(architecture.nodes.length <= 10);
  assert.ok(architecture.edges.length >= 3);
  assert.ok(architecture.stats.detail_modules >= architecture.nodes.length, "selected components should retain a module-level drill-down");
  const runtimeDetail = architecture.details?.["manager/electron"];
  assert.ok(runtimeDetail, "Manager Runtime must expose a module-level detail projection");
  assert.deepEqual(runtimeDetail.nodes.map((node) => node.label).sort(), ["Main", "Worker Core"]);
  assert.equal(runtimeDetail.edges.length, 1);
  assert.equal(runtimeDetail.edges[0].kind, "calls");
  assert.match(runtimeDetail.mermaid, /Main/);
  assert.match(runtimeDetail.mermaid, /Worker Core/);
  assert.match(architecture.mermaid, /^flowchart TD/m);
  assert.doesNotMatch(architecture.mermaid, /main\.jsx|service-worker\.js|projection\.ts/, "overview Mermaid must use component labels, not file/function-level labels");

  const managerMain = fs.readFileSync(path.join(managerRoot, "electron", "main.mjs"), "utf8");
  const preload = fs.readFileSync(path.join(managerRoot, "electron", "preload.cjs"), "utf8");
  const center = fs.readFileSync(path.join(managerRoot, "src", "app-plugin-center.jsx"), "utf8");
  const template = fs.readFileSync(path.join(managerRoot, "electron", "app-plugins", "templates", "gitdiagram", "app.js"), "utf8");
  const templateHtml = fs.readFileSync(path.join(managerRoot, "electron", "app-plugins", "templates", "gitdiagram", "index.html"), "utf8");
  const templateStyles = fs.readFileSync(path.join(managerRoot, "electron", "app-plugins", "templates", "gitdiagram", "styles.css"), "utf8");
  assert.match(managerMain, /codexpro:analyze-app-plugin-repo/);
  assert.match(managerMain, /buildGitDiagramArchitecture/);
  assert.match(preload, /analyzeAppPluginRepo/);
  assert.match(center, /ARCHITECTURE REPOSITORY/);
  assert.match(center, /codexpro:gitdiagram-analyze/);
  assert.match(center, /projects\.some\(\(project\) => project\.root === root\)/, "sandbox bridge must restrict analysis to a project already exposed by Manager");
  assert.match(center, /postPluginContext\(\);/, "Manager must republish plugin context when saved projects change after iframe readiness");
  assert.match(template, /codexpro:plugin-ready/);
  assert.match(template, /codexpro:gitdiagram-result/);
  assert.match(template, /GitDiagram Mermaid/);
  assert.match(template, /projectRoot/, "GitDiagram must keep custom project selection without relying on a native select element");
  assert.match(template, /project-dropdown-option/);
  assert.match(templateHtml, /class="project-dropdown-trigger"/);
  assert.doesNotMatch(templateHtml, /<select\b/i, "GitDiagram project picker should use the app-style custom dropdown instead of the browser native select");
  assert.match(templateStyles, /\.action\.primary \{ color: #101219; border-color: #e9edf4; background: #e9edf4; \}/, "primary GitDiagram action should follow Manager's light primary button convention");
  assert.match(templateStyles, /\.project-dropdown-trigger \{[^}]*min-height: 58px/s, "GitDiagram project trigger should match the Manager project dropdown control sizing");

  console.log("gitdiagram-plugin-smoke: ok");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
