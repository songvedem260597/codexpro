import assert from "node:assert/strict";
import fs from "node:fs";

const renderer = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

assert.match(renderer, /function ChatGalaxyButtonContent\(\)[\s\S]*?chat-galaxy-spark[\s\S]*?chat-galaxy-static[\s\S]*?chat-galaxy-orbit[\s\S]*?chat-galaxy-label/, "Chat button must render the galaxy layers and readable label");
assert.equal((renderer.match(/<ChatGalaxyButtonContent \/>/g) || []).length, 2, "browser and API worker Chat buttons must share the same galaxy effect");
assert.match(renderer, /className="button primary profile-chat chat-galaxy-button"[\s\S]*?onClick=\{\(\) => openChat\(profile\)\}/, "browser worker Chat button must use the galaxy effect");
assert.match(renderer, /className="button primary profile-chat chat-galaxy-button"[^>]*onClick=\{\(\) => onRun\(worker\)\}/, "API worker Chat button must use the galaxy effect");

const baseButton = styles.match(/\.chat-galaxy-button \{([^}]*)\}/)?.[1] || "";
const activeButton = styles.match(/\.chat-galaxy-button:hover:not\(:disabled\),\s*\.chat-galaxy-button:focus-visible:not\(:disabled\) \{([^}]*)\}/)?.[1] || "";
assert.match(baseButton, /overflow:\s*hidden/, "galaxy paint must stay clipped inside the button");
assert.match(baseButton, /box-shadow:\s*none/, "Chat button must not have an outer glow at rest");
assert.match(activeButton, /box-shadow:\s*none/, "Chat button must not gain an outer glow on hover or focus");
assert.match(styles, /\.chat-galaxy-spark[^}]*mask-composite:\s*exclude/, "rotating spark must be clipped to the border ring");
assert.match(styles, /\.chat-galaxy-spark::before[^}]*conic-gradient[^}]*animation:\s*chat-galaxy-spark-rotate\s+1\.8s/, "Chat button must keep the rotating conic spark from the reference effect");
assert.match(styles, /\.chat-galaxy-star[^}]*animation:\s*chat-galaxy-orbit/, "orbiting stars must animate inside the Chat button");
assert.match(styles, /prefers-reduced-motion:\s*reduce[\s\S]*?\.chat-galaxy-spark::before,[\s\S]*?\.chat-galaxy-star \{ animation:\s*none;/, "galaxy motion must honor reduced-motion preferences");
assert.doesNotMatch(styles, /chat-galaxy[^\n}]*filter:\s*drop-shadow/i, "Chat galaxy effect must not add glow outside the button");

console.log("✓ Chat galaxy button source smoke passed");
