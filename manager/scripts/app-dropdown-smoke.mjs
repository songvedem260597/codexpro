import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dropdownSearchEnabled, filterDropdownOptions, resolveDropdownEnterOption } from "../src/dropdown-options.js";

const many = Array.from({ length: 10 }, (_, index) => ({ value: `model-${index}`, label: `Model ${index}` }));
assert.equal(dropdownSearchEnabled(many), true);
assert.equal(dropdownSearchEnabled(many.slice(0, 3)), false);
assert.equal(dropdownSearchEnabled(many, false), false);
assert.deepEqual(filterDropdownOptions([
  { value: "du-an", label: "Dự án chính", hint: "Workspace" },
  { value: "worker", label: "API Worker" }
], "du an").map((item) => item.value), ["du-an"]);

const discoveredModels = [{ value: "cc/claude-opus-4-6", label: "Claude Opus 4.6" }];
const customModel = { value: "ag/gemini-3-flash", customModel: "ag/gemini-3-flash" };
assert.equal(resolveDropdownEnterOption(discoveredModels, "cc/claude-opus-4-6", customModel)?.value, "cc/claude-opus-4-6");
assert.equal(resolveDropdownEnterOption([], "ag/gemini-3-flash", customModel)?.customModel, "ag/gemini-3-flash");

const sourceRoot = path.resolve(import.meta.dirname, "../src");
const jsxFiles = fs.readdirSync(sourceRoot).filter((name) => name.endsWith(".jsx"));
const nativeSelects = jsxFiles.flatMap((name) => {
  const text = fs.readFileSync(path.join(sourceRoot, name), "utf8");
  return text.includes("<select") ? [name] : [];
});
assert.deepEqual(nativeSelects, [], `native selects remain: ${nativeSelects.join(", ")}`);

const legacyDropdownTriggers = [
  "settings-dropdown-trigger",
  "chat-dropdown-trigger",
  "diagnostic-filter-trigger",
  "codexgraph-filter-trigger"
];
const legacyDropdowns = jsxFiles.flatMap((name) => {
  const text = fs.readFileSync(path.join(sourceRoot, name), "utf8");
  return legacyDropdownTriggers.filter((token) => text.includes(token)).map((token) => `${name}:${token}`);
});
assert.deepEqual(legacyDropdowns, [], `legacy dropdowns remain: ${legacyDropdowns.join(", ")}`);

const mainSource = fs.readFileSync(path.join(sourceRoot, "main.jsx"), "utf8");
const projectDropdownSource = fs.readFileSync(path.join(sourceRoot, "project-dropdown.jsx"), "utf8");
const workflowSource = fs.readFileSync(path.join(sourceRoot, "task-workflow-center.jsx"), "utf8");
const pluginSource = fs.readFileSync(path.join(sourceRoot, "app-plugin-center.jsx"), "utf8");
assert.match(projectDropdownSource, /export function ProjectDropdown[\s\S]*?className="project-dropdown-trigger"[\s\S]*?className="project-dropdown-search"/, "the repo picker must retain its dedicated searchable green UI");
assert.doesNotMatch(projectDropdownSource, /<AppDropdown/, "the repo picker must not inherit the generic shared dropdown theme");
assert.match(mainSource, /import \{ ALL_ALLOWED_WORKSPACES, formatRepoActivity, ProjectDropdown \} from "\.\/project-dropdown\.jsx";/, "main request surfaces must use the shared repo picker");
assert.ok((mainSource.match(/<ProjectDropdown/g) || []).length >= 2, "API worker and Chrome request surfaces must both use the shared repo picker");
assert.match(workflowSource, /<ProjectDropdown[\s\S]{0,500}?ariaLabel="Chọn workspace"/, "workflow workspace selection must use the shared repo picker");
assert.doesNotMatch(workflowSource, /<AppDropdown[\s\S]{0,400}?projects\.map\(\(project\)/, "workflow workspace selection must not fall back to generic AppDropdown");
assert.match(pluginSource, /<ProjectDropdown[^>]*includeAllAllowed=\{false\}[^>]*ariaLabel="Chọn dự án áp dụng skill"/, "plugin task project selection must use the shared repo picker without widening its workspace scope");
assert.doesNotMatch(pluginSource, /<AppDropdown[^>]*projects\.map\(\(project\)/, "plugin project selection must not use generic AppDropdown");

console.log("✓ Unified searchable app dropdown smoke test passed");
