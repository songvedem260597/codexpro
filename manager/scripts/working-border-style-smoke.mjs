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
assert.match(styles, /\.profile-list\.working-border-shine \.browser-profile\.is-working::before,[\s\S]*?animation:\s*profile-border-shine\s+2\.8s\s+linear\s+infinite/, "shine animation must be scoped to the working-card ring and use the requested pace");
assert.match(styles, /conic-gradient\(from var\(--profile-border-shine-angle\)[\s\S]*?transparent 300deg[\s\S]*?#7cffc4 330deg[\s\S]*?#6aa7ff 350deg[\s\S]*?transparent 360deg\)/, "shine border must use the requested mint-to-blue moving highlight");
assert.match(styles, /working-border-shine[\s\S]*?-webkit-mask-composite:\s*xor[\s\S]*?mask-composite:\s*exclude/, "shine border must mask the gradient down to the border ring");
assert.match(styles, /\.profile-list\.working-border-shine \.browser-profile\.is-working\s*\{[^}]*border-color:\s*#334052;[^}]*#7cffc414[^}]*#6aa7ff12/, "shine mode must neutralize the old orange card ring so the mint-blue highlight stays visible");
assert.match(styles, /@property --profile-border-shine-angle[\s\S]*?inherits:\s*false/, "shine angle must not inherit through the renderer tree");
assert.match(styles, /\.chat-response\.is-streaming::before,[\s\S]*?data-layout-settling="1"\]::before,[\s\S]*?data-layout-stream="1"\]::before[^}]*animation:\s*profile-border-shine/, "streaming chat shine must remain painted through transient busy-to-settling transitions");
assert.match(renderer, /chat-response is-inline \$\{sending \? "is-sending" : selectedBusy \? "is-streaming" : ""\}/, "submission must use a stable sending border instead of restarting the streaming shine before ACK");
assert.match(styles, /\.chat-response\.is-sending,[\s\S]*?\.chat-response\.is-streaming,[\s\S]*?data-layout-settling="1"\],[\s\S]*?data-layout-stream="1"\]\s*\{[^}]*border-color:/, "sending, streaming, and settling states must keep the same static border geometry");
assert.match(styles, /\.chat-response\.is-inline\s*\{[^}]*height:\s*260px;[^}]*min-height:\s*260px;[^}]*max-height:\s*260px;[^}]*flex:\s*0 0 260px;[^}]*contain:\s*layout paint;/, "latest-message geometry must stay fixed even while its content and paint layers change");
assert.match(styles, /\.chat-modal \.chat-response\.is-inline\s*\{[^}]*height:\s*var\(--chat-response-height, 330px\);[^}]*flex-basis:\s*var\(--chat-response-height, 330px\);/, "chat modal must pin its flex basis to the configured latest-message height");
assert.doesNotMatch(styles, /\.chat-response\.is-sending::before/, "the pre-ACK sending state must not create an animated border paint layer");
assert.match(styles, /working-border-beam[\s\S]*?mask:[\s\S]*?offset-path:\s*rect\(/, "Border Beam must be clipped to the card ring and follow its perimeter");
assert.match(styles, /width:\s*44px[\s\S]*?animation:\s*worker-border-beam-move\s+4\.4s/, "worker Border Beam must use the compact segment and gentle speed");
assert.match(styles, /\.profile-list\.working-border-beam \.browser-profile\.is-working\s*\{[^}]*border-color:\s*#3c4655;[^}]*box-shadow:[^}]*#4b5769/, "Border Beam must replace the static orange card border with a neutral slate ring");
assert.match(styles, /\.profile-list\.working-border-beam\.is-card-layout \.browser-profile\.is-working\s*\{[^}]*box-shadow:\s*none/, "card layout Border Beam must not restore the removed top status edge");
assert.match(styles, /prefers-reduced-motion:\s*reduce[\s\S]*?worker-active-border::before[\s\S]*?animation:\s*none/, "Border Beam must honor reduced-motion preferences");

console.log("✓ Working worker Border Beam option smoke test passed");
