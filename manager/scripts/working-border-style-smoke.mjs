import assert from "node:assert/strict";
import fs from "node:fs";

const renderer = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const apiWorkerCards = fs.readFileSync(new URL("../src/features/api-workers/api-worker-cards.jsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const managerMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const borderSync = fs.readFileSync(new URL("../src/worker-border-sync.js", import.meta.url), "utf8");

assert.match(managerMain, /workingBorderStyle:\s*"shine"/, "the existing rotating shine must remain the default");
assert.match(managerMain, /MANAGER_WORKING_BORDER_STYLES\s*=\s*new Set\(\["shine",\s*"beam",\s*"mint"\]\)/, "Manager settings must accept shine, beam, and the added mint border");
assert.match(managerMain, /parsed\?\.workingBorderStyle[\s\S]*?defaults\.workingBorderStyle/, "stored border style must be normalized safely");
assert.match(managerMain, /patch,\s*"workingBorderStyle"[\s\S]*?next\.workingBorderStyle/, "the selected border style must persist");

assert.ok((renderer.match(/working-border-\$\{managerSettings\.workingBorderStyle\}/g) || []).length >= 2, "worker list and preview must expose all normalized border styles without collapsing them into the old modes");
assert.match(renderer, /value:\s*"shine"[\s\S]*?Ánh sáng xoay[\s\S]*?value:\s*"mint"[\s\S]*?Glow mint xanh[\s\S]*?value:\s*"beam"[\s\S]*?Tia chạy quanh viền/, "settings must keep both existing styles and add the mint border as a third option");
assert.ok((`${renderer}\n${apiWorkerCards}`.match(/className="worker-active-border"/g) || []).length >= 3, "browser, API, and preview cards must render the beam layer");

assert.match(styles, /\.profile-list\.working-border-shine \.browser-profile\.is-working::before,[\s\S]*?transparent 0deg 225deg[\s\S]*?#f4a340 244deg[\s\S]*?#ff9f1c 346deg[\s\S]*?animation:\s*profile-border-shine\s+2\.75s\s+linear\s+infinite/, "the original orange rotating shine must remain unchanged as its own style");
assert.doesNotMatch(styles, /\.profile-list\.working-border-shine \.browser-profile\.is-working\s*\{[^}]*border-color:\s*#334052/, "the original shine must not inherit the mint style's neutral static ring");
assert.doesNotMatch(styles, /\.app-shell\s*\{[^}]*animation:\s*profile-border-shine/, "the rotating shine must not invalidate styles across the entire app shell");

assert.match(styles, /\.profile-list\.working-border-mint \.browser-profile\.is-working::before,[\s\S]*?animation:\s*profile-border-shine\s+2\.8s\s+linear\s+infinite/, "the added mint border must animate independently at the requested pace");
assert.match(styles, /working-border-mint[\s\S]*?conic-gradient\(from var\(--profile-border-shine-angle\)[\s\S]*?transparent 300deg[\s\S]*?#7cffc4 330deg[\s\S]*?#6aa7ff 350deg[\s\S]*?transparent 360deg\)/, "the added border must use the requested mint-to-blue moving highlight");
assert.match(styles, /working-border-mint[\s\S]*?-webkit-mask-composite:\s*xor[\s\S]*?mask-composite:\s*exclude/, "the added mint border must be masked down to the border ring");
assert.match(styles, /\.profile-list\.working-border-mint \.browser-profile\.is-working\s*\{[^}]*border-color:\s*#334052;[^}]*#7cffc414[^}]*#6aa7ff12/, "the mint mode must use its own neutral static ring so the moving highlight stays visible");
assert.match(styles, /@property --profile-border-shine-angle[\s\S]*?inherits:\s*false/, "the shared shine angle must remain a registered non-inherited angle");
assert.match(styles, /prefers-reduced-motion:\s*reduce[\s\S]*?working-border-mint[\s\S]*?animation:\s*none/, "the added mint border must honor reduced-motion preferences");

assert.match(styles, /\.chat-response::before\s*\{[^}]*opacity:\s*0;[^}]*animation:\s*profile-border-shine[^}]*animation-play-state:\s*paused/, "chat shine must stay mounted but hidden and paused while idle or only sending");
assert.match(styles, /\.chat-response\.is-streaming::before\s*\{[^}]*opacity:\s*1;[^}]*animation-play-state:\s*running/, "confirmed processing must reveal and resume the existing chat shine layer");
assert.match(renderer, /const responseBorderActive = selectedBusy \|\| selectedSettling;/, "the latest-message border must stay active continuously from confirmed processing through settling");
assert.match(renderer, /chat-response is-inline \$\{responseBorderActive \? "is-streaming" : sending \? "is-sending" : ""\}/, "confirmed processing must outrank the local sending state for the latest-message border");
assert.match(styles, /\.chat-response\.is-streaming\s*\{[^}]*border-color:/, "only confirmed processing may change the latest-message border color");
assert.doesNotMatch(styles, /\.chat-response\.is-sending(?:\s*,|\s*\{)[^}]*border(?:-color)?:/, "pre-ACK sending must not change the latest-message border at all");
assert.doesNotMatch(styles, /\.chat-response\.is-sending::before/, "pre-ACK sending must not own the animated border paint layer");

assert.match(styles, /working-border-beam[\s\S]*?mask:[\s\S]*?offset-path:\s*rect\(/, "Border Beam must be clipped to the card ring and follow its perimeter");
assert.match(styles, /width:\s*44px[\s\S]*?animation:\s*worker-border-beam-move\s+4\.4s/, "worker Border Beam must use the compact segment and gentle speed");
assert.match(borderSync, /profile-border-shine[\s\S]*worker-border-beam-move/, "shine, mint, and beam animations must continue using the synchronized document timeline");
assert.match(borderSync, /animation\.startTime\s*!==\s*0[\s\S]*animation\.startTime\s*=\s*0/, "worker border animations must share the document timeline epoch instead of their individual start times");
assert.match(renderer, /synchronizeWorkerBorderAnimations\(document\)/, "the overview must resynchronize working borders whenever worker state changes");
assert.match(styles, /\.profile-list\.working-border-beam \.browser-profile\.is-working\s*\{[^}]*border-color:\s*#3c4655;[^}]*box-shadow:[^}]*#4b5769/, "Border Beam must retain its own neutral slate ring");
assert.match(styles, /\.profile-list\.working-border-beam\.is-card-layout \.browser-profile\.is-working\s*\{[^}]*box-shadow:\s*none/, "card layout Border Beam must not restore the removed top status edge");
assert.match(styles, /prefers-reduced-motion:\s*reduce[\s\S]*?worker-active-border::before[\s\S]*?animation:\s*none/, "Border Beam must honor reduced-motion preferences");

console.log("✓ Working worker border styles smoke test passed");
