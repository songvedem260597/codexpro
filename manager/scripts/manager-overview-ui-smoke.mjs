import assert from "node:assert/strict";
import fs from "node:fs";

const main = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const overviewUi = fs.readFileSync(new URL("../src/components/manager-overview-ui.jsx", import.meta.url), "utf8");

assert.match(main, /import \{ Icon, ProfileSummaryItem, StatusCard, TitleGalaxyAccent \} from "\.\/components\/manager-overview-ui\.jsx";/, "main.jsx must consume the extracted overview UI module");
assert.match(overviewUi, /import \{ Dot \} from "\.\/worker-ui\.jsx";/, "overview status cards must keep using the shared worker status indicator module");
for (const component of ["StatusCard", "Icon", "ProfileSummaryItem", "TitleGalaxyAccent"]) {
  assert.doesNotMatch(main, new RegExp(`function ${component}\\(`), `${component} implementation must stay out of main.jsx`);
  assert.match(overviewUi, new RegExp(`export function ${component}\\(`), `${component} must be exported from the overview UI module`);
}
assert.doesNotMatch(main, /function ProfileSummaryIcon\(/, "ProfileSummaryIcon implementation must stay out of main.jsx");
assert.match(overviewUi, /function ProfileSummaryIcon\(/, "profile summary SVG variants must stay colocated with ProfileSummaryItem");
for (const marker of ["summary-missing-plug", "summary-working-bolt", "summary-idle-check", "summary-hung-triangle"]) {
  assert.match(overviewUi, new RegExp(marker), `profile summary state marker ${marker} must remain represented`);
}
assert.match(overviewUi, /<Dot ok=\{ok\} \/>/, "status cards must keep using the shared Dot status indicator");
assert.match(main, /<>CodexPro <TitleGalaxyAccent \/> Agent<\/>/, "overview title must keep the extracted Multi accent");
assert.match(main, /<ProfileSummaryItem state="working"[\s\S]*<ProfileSummaryItem state="idle"[\s\S]*<ProfileSummaryItem state="hung"/, "overview header must keep rendering the extracted profile summary items");
assert.match(main, /<StatusCard label="Scheduled Task"[\s\S]*<StatusCard label="Local MCP"[\s\S]*<StatusCard label="Public tunnel"[\s\S]*<StatusCard label="Processes"/, "overview must keep the four runtime status cards");

console.log("manager-overview-ui-smoke: ok");
