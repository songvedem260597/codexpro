import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dropdownSearchEnabled, filterDropdownOptions } from "../src/dropdown-options.js";

const many = Array.from({ length: 10 }, (_, index) => ({ value: `model-${index}`, label: `Model ${index}` }));
assert.equal(dropdownSearchEnabled(many), true);
assert.equal(dropdownSearchEnabled(many.slice(0, 3)), false);
assert.equal(dropdownSearchEnabled(many, false), false);
assert.deepEqual(filterDropdownOptions([
  { value: "du-an", label: "Dự án chính", hint: "Workspace" },
  { value: "worker", label: "API Worker" }
], "du an").map((item) => item.value), ["du-an"]);

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
  "project-dropdown-trigger",
  "diagnostic-filter-trigger",
  "codexgraph-filter-trigger"
];
const legacyDropdowns = jsxFiles.flatMap((name) => {
  const text = fs.readFileSync(path.join(sourceRoot, name), "utf8");
  return legacyDropdownTriggers.filter((token) => text.includes(token)).map((token) => `${name}:${token}`);
});
assert.deepEqual(legacyDropdowns, [], `legacy dropdowns remain: ${legacyDropdowns.join(", ")}`);

console.log("✓ Unified searchable app dropdown smoke test passed");
