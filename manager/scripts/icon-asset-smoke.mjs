import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const iconPath = path.resolve(here, "../../docs/favicon.svg");
const icon = fs.readFileSync(iconPath, "utf8");
const macIconPath = path.resolve(here, "../build/icon.icns");
const macIcon = fs.readFileSync(macIconPath);

assert.match(icon, /aria-label="CodexPro C mark"/, "app icon must identify the single C mark");
assert.match(icon, /<rect[^>]+fill="#0b1220"/, "app icon must preserve the dark background");
assert.match(icon, /<linearGradient id="c"[\s\S]*?#67e8f9[\s\S]*?#34d399/, "C mark must preserve the cyan-to-green palette");
assert.equal((icon.match(/<path\b/g) || []).length, 1, "app icon must contain exactly one glyph path");
assert.doesNotMatch(icon, /<path[^>]+stroke=/, "C mark must not use an outline");
assert.equal(
  crypto.createHash("sha256").update(macIcon).digest("hex"),
  "5ebdfe206b9415e3a7dadbfa4b8f64ebc9368b5989a37addabea736ba82b9f50",
  "macOS icon.icns must be regenerated whenever the shared app icon changes"
);

console.log("icon asset smoke passed");
