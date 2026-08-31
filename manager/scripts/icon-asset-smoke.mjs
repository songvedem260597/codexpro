import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const iconPath = path.resolve(here, "../../docs/favicon.svg");
const icon = fs.readFileSync(iconPath, "utf8");

assert.match(icon, /aria-label="CodexPro C mark"/, "app icon must identify the single C mark");
assert.match(icon, /<rect[^>]+fill="#0b1220"/, "app icon must preserve the dark background");
assert.match(icon, /<linearGradient id="c"[\s\S]*?#67e8f9[\s\S]*?#34d399/, "C mark must preserve the cyan-to-green palette");
assert.equal((icon.match(/<path\b/g) || []).length, 1, "app icon must contain exactly one glyph path");
assert.doesNotMatch(icon, /<path[^>]+stroke=/, "C mark must not use an outline");

console.log("icon asset smoke passed");
