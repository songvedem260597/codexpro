import assert from "node:assert/strict";
import fs from "node:fs";

const main = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const start = main.indexOf('const GENERIC_TOOL_ACTIVITY_TEXT =');
const end = main.indexOf('function sendDebugEvidence', start);
assert.ok(start >= 0 && end > start, "tool activity helpers must be present");
const helperSource = main.slice(start, end);
const helpers = Function(`${helperSource}; return { GENERIC_TOOL_ACTIVITY_TEXT, codexProToolActivityLabel, looksLikeToolArgumentPayload, toolActivityFromText, compactToolActivityMessages };`)();
const generic = "Codex Pro đang sử dụng công cụ";

assert.equal(helpers.GENERIC_TOOL_ACTIVITY_TEXT, generic);
assert.equal(helpers.codexProToolActivityLabel("CodexPro đang sử dụng codexpro"), true);
assert.equal(helpers.codexProToolActivityLabel("Codex Pro đang đọc file"), true);
assert.equal(helpers.toolActivityFromText('{"paths":["CodexPro"],"query":"codexpro"}'), generic, "CodexPro list-resource args must never render as raw JSON");
assert.equal(helpers.toolActivityFromText('{"path":"/CodexPro/codexpro","args":{"action":"search","path":"manager/src/main.jsx"}}'), generic, "legacy CodexPro call payload must collapse to generic activity");
assert.equal(helpers.toolActivityFromText('{"workspace_id":"ws_1","query":"needle","path":"manager/src"}', { collapseArgumentPayload: true }), generic, "tool-shaped args accompanying a live CodexPro activity must collapse even without a CodexPro literal");
assert.equal(helpers.toolActivityFromText('{"status":"ok","message":"normal assistant JSON"}', { collapseArgumentPayload: true }), null, "ordinary JSON responses must remain visible");

const compacted = helpers.compactToolActivityMessages([
  { id: "a", role: "assistant", text: '{"paths":["CodexPro"],"query":"codexpro"}' },
  { id: "b", role: "assistant", text: '{"workspace_id":"ws_1","query":"foo","path":"manager"}' }
], { collapseArgumentPayloads: true });
assert.equal(compacted.length, 1, "consecutive tool argument blobs must merge into one activity row");
assert.equal(compacted[0].text, generic);
assert.equal(compacted[0].toolActivity, true);

const networkCapture = fs.readFileSync(new URL("../../chrome-extension/network-capture.js", import.meta.url), "utf8");
assert.match(networkCapture, /return "Codex Pro đang sử dụng công cụ";/, "network stream tool activity must use the generic label");
assert.doesNotMatch(networkCapture, /CodexPro đang sử dụng \$\{action\}/, "network stream must not expose raw tool action names");
const worker = fs.readFileSync(new URL("../../chrome-extension/service-worker.js", import.meta.url), "utf8");
assert.match(worker, /streamActivity\|\|'Codex Pro đang sử dụng công cụ'/, "worker fallback activity must use the same generic label");

console.log("✓ Tool activity display smoke test passed");
