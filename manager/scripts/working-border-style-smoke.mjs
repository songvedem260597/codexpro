import assert from "node:assert/strict";
import fs from "node:fs";

const renderer = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const managerMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const borderSync = fs.readFileSync(new URL("../src/worker-border-sync.js", import.meta.url), "utf8");

assert.match(managerMain, /workingBorderStyle:\s*"shine"/, "the existing rotating shine must remain the default");
assert.match(managerMain, /MANAGER_WORKING_BORDER_STYLES\s*=\s*new Set\(\["shine",\s*"beam"\]\)/, "Manager settings must accept both border styles");
assert.match(managerMain, /parsed\?\.workingBorderStyle[\s\S]*?defaults\.workingBorderStyle/, "stored border style must be normalized safely");
assert.match(managerMain, /patch,\s*"workingBorderStyle"[\s\S]*?next\.workingBorderStyle/, "the selected border style must persist");

assert.match(renderer, /working-border-\$\{managerSettings\.workingBorderStyle === "beam" \? "beam" : "shine"\}/, "worker list must expose the selected border style");
assert.match(renderer, /value:\s*"shine"[\s\S]*?Ánh sáng xoay[\s\S]*?value:\s*"beam"[\s\S]*?Tia chạy quanh viền/, "settings must keep the old style and add Border Beam");
assert.ok((renderer.match(/className="worker-active-border"/g) || []).length >= 3, "browser, API, and preview cards must render the beam layer");

assert.match(styles, /working-border-shine[\s\S]*?conic-gradient/, "the existing conic shine CSS must remain available");
assert.doesNotMatch(styles, /\.app-shell\s*\{[^}]*animation:\s*profile-border-shine/, "the rotating shine must not invalidate styles across the entire app shell");
assert.match(styles, /\.profile-list\.working-border-shine \.browser-profile\.is-working::before,[\s\S]*?animation:\s*profile-border-shine\s+2\.8s\s+linear\s+infinite/, "shine animation must be scoped to the working-card ring and use the requested pace");
assert.match(styles, /conic-gradient\(from var\(--profile-border-shine-angle\)[\s\S]*?transparent 300deg[\s\S]*?#7cffc4 330deg[\s\S]*?#6aa7ff 350deg[\s\S]*?transparent 360deg\)/, "shine border must use the requested mint-to-blue moving highlight");
assert.match(styles, /working-border-shine[\s\S]*?-webkit-mask-composite:\s*xor[\s\S]*?mask-composite:\s*exclude/, "shine border must mask the gradient down to the border ring");
assert.match(styles, /\.profile-list\.working-border-shine \.browser-profile\.is-working\s*\{[^}]*border-color:\s*#334052;[^}]*#7cffc414[^}]*#6aa7ff12/, "shine mode must neutralize the old orange card ring so the mint-blue highlight stays visible");
assert.match(styles, /@property --profile-border-shine-angle[\s\S]*?inherits:\s*false/, "shine angle must not inherit through the renderer tree");
assert.match(styles, /\.chat-response::before\s*\{[^}]*opacity:\s*0;[^}]*animation:\s*profile-border-shine[^}]*animation-play-state:\s*paused/, "chat shine must stay mounted but hidden and paused while idle or only sending");
assert.match(styles, /\.chat-response\.is-streaming::before\s*\{[^}]*opacity:\s*1;[^}]*animation-play-state:\s*running/, "confirmed processing must reveal and resume the existing chat shine layer");
assert.match(renderer, /const responseBorderActive = selectedBusy \|\| selectedSettling;/, "the latest-message border must stay active continuously from confirmed processing through settling");
assert.match(renderer, /chat-response is-inline \$\{responseBorderActive \? "is-streaming" : sending \? "is-sending" : ""\}/, "confirmed processing must outrank the local sending state for the latest-message border");
assert.match(styles, /\.chat-response\.is-streaming\s*\{[^}]*border-color:/, "only confirmed processing may change the latest-message border color");
assert.doesNotMatch(styles, /\.chat-response\.is-sending(?:\s*,|\s*\{)[^}]*border(?:-color)?:/, "pre-ACK sending must not change the latest-message border at all");
assert.doesNotMatch(styles, /\.chat-response\.is-sending::before/, "pre-ACK sending must not own the animated border paint layer");
assert.match(styles, /working-border-beam[\s\S]*?mask:[\s\S]*?offset-path:\s*rect\(/, "Border Beam must be clipped to the card ring and follow its perimeter");
assert.match(styles, /width:\s*44px[\s\S]*?animation:\s*worker-border-beam-move\s+4\.4s/, "worker Border Beam must use the compact segment and gentle speed");
assert.match(borderSync, /profile-border-shine[\s\S]*worker-border-beam-move/, "both worker border animation styles must participate in synchronization");
assert.match(borderSync, /animation\.startTime\s*!==\s*0[\s\S]*animation\.startTime\s*=\s*0/, "worker border animations must share the document timeline epoch instead of their individual start times");
assert.match(renderer, /synchronizeWorkerBorderAnimations\(document\)/, "the overview must resynchronize working borders whenever worker state changes");
assert.match(styles, /\.profile-list\.working-border-beam \.browser-profile\.is-working\s*\{[^}]*border-color:\s*#3c4655;[^}]*box-shadow:[^}]*#4b5769/, "Border Beam must replace the static orange card border with a neutral slate ring");
assert.match(styles, /\.profile-list\.working-border-beam\.is-card-layout \.browser-profile\.is-working\s*\{[^}]*box-shadow:\s*none/, "card layout Border Beam must not restore the removed top status edge");
assert.match(styles, /prefers-reduced-motion:\s*reduce[\s\S]*?worker-active-border::before[\s\S]*?animation:\s*none/, "Border Beam must honor reduced-motion preferences");

console.log("✓ Working worker Border Beam option smoke test passed");
