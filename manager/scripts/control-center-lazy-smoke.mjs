import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const managerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const renderer = fs.readFileSync(path.join(managerRoot, "src", "main.jsx"), "utf8");
const controlCenter = fs.readFileSync(path.join(managerRoot, "src", "control-center.jsx"), "utf8");

assert.doesNotMatch(renderer, /^import .*control-center\.jsx/m, "Control Center must not stay in the startup renderer bundle");
assert.doesNotMatch(renderer, /^import ["']\.\/control-center\.css["'];/m, "Control Center CSS must not stay in the startup renderer bundle");
assert.match(renderer, /const ControlCenter = React\.lazy\(\(\) => import\("\.\/control-center\.jsx"\)/, "Control Center must load through a lazy chunk");
assert.match(renderer, /activePage === "control" \? \([\s\S]{0,240}<React\.Suspense/, "Control Center must only mount after its page is selected");
assert.match(controlCenter, /import "\.\/control-center\.css";/, "Control Center must carry its own CSS into the lazy chunk");

console.log("✓ Control Center lazy chunk smoke test passed");
