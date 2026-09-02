import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const managerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(managerRoot, "..");
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

const preload = read("manager/electron/preload.cjs");
const electronMain = read("manager/electron/main.mjs");

const control = read("manager/src/control-center.jsx");
const panel = read("manager/src/workspace-coordination-panel.jsx");
const styles = read("manager/src/workspace-coordination-panel.css");
const server = read("src/server.ts");
const coordination = read("src/workspaceCoordination.ts");

assert.match(preload, /getWorkspaceCoordination:\s*\(root\)\s*=>\s*invoke\("codexpro:get-workspace-coordination"/);
assert.match(electronMain, /workspace_coordination_status/);
assert.match(electronMain, /codexpro:get-workspace-coordination/);
assert.match(control, /api\s*=\s*window\.codexpro/);
assert.match(control, /WorkspaceCoordinationPanel/);
assert.match(control, /coordinationRoots/);
assert.match(panel, /getWorkspaceCoordination/);
assert.match(panel, /WORKTREE/);
assert.match(panel, /QUEUE #/);
assert.match(panel, /STALE BASE/);
assert.match(panel, /CONFLICT/);
assert.match(panel, /File ownership/);
assert.match(panel, /Integration queue/);
assert.match(panel, /Mở worktree/);
assert.match(styles, /coordination-repo\.has-conflict/);
assert.match(styles, /coordination-badges span\.is-danger/);
assert.match(server, /"workspace_coordination_status"/);
assert.match(coordination, /export function readWorkspaceCoordinationStatus/);
assert.match(coordination, /stale_paths/);
assert.match(coordination, /queue_position/);

console.log("workspace coordination UI smoke passed");
