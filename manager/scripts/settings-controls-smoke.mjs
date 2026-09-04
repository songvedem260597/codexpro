import assert from "node:assert/strict";
import fs from "node:fs";

const main = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const controls = fs.readFileSync(new URL("../src/components/settings-controls.jsx", import.meta.url), "utf8");

assert.match(main, /import \{ SettingsDropdown, SettingsToggle \} from "\.\/components\/settings-controls\.jsx";/, "main.jsx must consume the extracted settings controls module");
for (const component of ["SettingsDropdown", "SettingsToggle"]) {
  assert.doesNotMatch(main, new RegExp(`function ${component}\\(`), `${component} implementation must stay out of main.jsx`);
  assert.match(controls, new RegExp(`export function ${component}\\(`), `${component} must be exported from settings-controls.jsx`);
}
assert.match(controls, /import \{ AppDropdown \} from "\.\.\/app-dropdown\.jsx";/, "SettingsDropdown must reuse the shared AppDropdown component");
assert.match(controls, /className="is-settings"/, "SettingsDropdown must preserve the settings dropdown theme");
assert.match(controls, /options=\{options\.map\(\(option\) => \(\{ \.\.\.option, style: option\.css \? \{ fontFamily: option\.css \} : undefined \}\)\)\}/, "SettingsDropdown must preserve per-option font previews");
assert.match(controls, /searchPlaceholder=\{`Tìm \$\{ariaLabel\.toLocaleLowerCase\("vi-VN"\)\}…`\}/, "SettingsDropdown must preserve localized search text");
assert.match(controls, /className=\{`settings-toggle \$\{checked \? "is-on" : ""\}`\}/, "SettingsToggle must preserve on/off styling");
assert.match(controls, /aria-pressed=\{checked\}/, "SettingsToggle must preserve pressed semantics");
assert.match(controls, /onClick=\{\(\) => onChange\(!checked\)\}/, "SettingsToggle must keep boolean inversion behavior");
assert.match(main, /function ChatDropdown\(/, "ChatDropdown must remain in main.jsx for this seam");
assert.equal((main.match(/<SettingsDropdown\b/g) || []).length, 6, "settings page must keep all six dropdown usages");
assert.equal((main.match(/<SettingsToggle\b/g) || []).length, 1, "settings page must keep the chat selector toggle");

console.log("settings-controls-smoke: ok");
