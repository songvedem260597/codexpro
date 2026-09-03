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
  assert.equal(entry.path, path.join(managedRoot, ".codexpro-plugin", "ui", "index.html"));
  assert.equal(appAsset.path, path.join(managedRoot, ".codexpro-plugin", "ui", "app.js"));
  assert.equal(appAsset.mime_type, "text/javascript; charset=utf-8");
  assert.equal(installer.listCatalog()[0].installed, true);
  assert.equal(installer.listCatalog()[0].skill_count, 0);

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
  assert.match(architecture.mermaid, /^flowchart TD/m);
  assert.doesNotMatch(architecture.mermaid, /main\.jsx|service-worker\.js|projection\.ts/, "overview Mermaid must use component labels, not file/function-level labels");

  const managerMain = fs.readFileSync(path.join(managerRoot, "electron", "main.mjs"), "utf8");
  const preload = fs.readFileSync(path.join(managerRoot, "electron", "preload.cjs"), "utf8");
  const center = fs.readFileSync(path.join(managerRoot, "src", "app-plugin-center.jsx"), "utf8");
  const template = fs.readFileSync(path.join(managerRoot, "electron", "app-plugins", "templates", "gitdiagram", "app.js"), "utf8");
  assert.match(managerMain, /codexpro:analyze-app-plugin-repo/);
  assert.match(managerMain, /buildGitDiagramArchitecture/);
  assert.match(preload, /analyzeAppPluginRepo/);
  assert.match(center, /ARCHITECTURE REPOSITORY/);
  assert.match(center, /codexpro:gitdiagram-analyze/);
  assert.match(center, /projects\.some\(\(project\) => project\.root === root\)/, "sandbox bridge must restrict analysis to a project already exposed by Manager");
  assert.match(template, /codexpro:plugin-ready/);
  assert.match(template, /codexpro:gitdiagram-result/);
  assert.match(template, /GitDiagram Mermaid/);

  console.log("gitdiagram-plugin-smoke: ok");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
