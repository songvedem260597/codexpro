import assert from "node:assert/strict";
import fs from "node:fs";

const renderer = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const managerMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");

assert.match(managerMain, /workingBorderStyle:\s*"shine"/, "the existing rotating shine must remain the default");
assert.match(managerMain, /MANAGER_WORKING_BORDER_STYLES\s*=\s*new Set\(\["shine",\s*"beam"\]\)/, "Manager settings must accept both border styles");
assert.match(managerMain, /parsed\?\.workingBorderStyle[\s\S]*?defaults\.workingBorderStyle/, "stored border style must be normalized safely");
assert.match(managerMain, /patch,\s*"workingBorderStyle"[\s\S]*?next\.workingBorderStyle/, "the selected border style must persist");

assert.match(renderer, /working-border-\$\{managerSettings\.workingBorderStyle === "beam" \? "beam" : "shine"\}/, "worker list must expose the selected border style");
assert.match(renderer, /value:\s*"shine"[\s\S]*?Ánh sáng xoay[\s\S]*?value:\s*"beam"[\s\S]*?Tia chạy quanh viền/, "settings must keep the old style and add Border Beam");
assert.ok((renderer.match(/className="worker-active-border"/g) || []).length >= 3, "browser, API, and preview cards must render the beam layer");

assert.match(styles, /working-border-shine[\s\S]*?conic-gradient/, "the existing conic shine CSS must remain available");
assert.doesNotMatch(styles, /\.app-shell\s*\{[^}]*animation:\s*profile-border-shine/, "the rotating shine must not invalidate styles across the entire app shell");
assert.match(styles, /\.profile-list\.working-border-shine \.browser-profile\.is-working::before,[\s\S]*?animation:\s*profile-border-shine/, "shine animation must be scoped to the pseudo-elements that actually render it");
assert.match(styles, /@property --profile-border-shine-angle[\s\S]*?inherits:\s*false/, "shine angle must not inherit through the renderer tree");
assert.match(styles, /\.chat-response\.is-streaming::before[^}]*animation:\s*profile-border-shine/, "streaming chat shine must remain animated on its own paint layer");
assert.match(styles, /working-border-beam[\s\S]*?mask:[\s\S]*?offset-path:\s*rect\(/, "Border Beam must be clipped to the card ring and follow its perimeter");
assert.match(styles, /width:\s*44px[\s\S]*?animation:\s*worker-border-beam-move\s+4\.4s/, "worker Border Beam must use the compact segment and gentle speed");
assert.match(styles, /prefers-reduced-motion:\s*reduce[\s\S]*?worker-active-border::before[\s\S]*?animation:\s*none/, "Border Beam must honor reduced-motion preferences");

console.log("✓ Working worker Border Beam option smoke test passed");
