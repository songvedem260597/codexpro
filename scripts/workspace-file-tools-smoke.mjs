import assert from "node:assert/strict";
import { registerWorkspaceFileTools } from "../dist/workspaceFileTools.js";

const config = { maxSearchResults: 50, analysisEnabled: true };
const server = {};
const workspaces = {};
const workspace = { id: "ws-files", root: "C:/repo", openedAt: "2026-01-01T00:00:00.000Z" };
const taskContext = { taskId: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa", workerId: "worker", title: "Task", root: workspace.root };
const registrations = [];
const handlers = new Map();
let events = [];
let treeOptions;
let searchOptions;
let readArgs;
let imageArgs;
let writeArgs;
let editArgs;
let patchArgs;
let writeMode = "changed";
let editMode = "changed";
let patchMode = "changed";
let graphMode = "ok";
let graphCalls = 0;

const guard = {
  resolve(_workspace, inputPath, options = {}) {
    events.push(`resolve:${inputPath}:${options.forWrite === true ? "write" : "read"}`);
    return { absPath: `C:/repo/${inputPath}`, relPath: String(inputPath).replace(/\\/g, "/") };
  }
};

function parseBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}
function limitInt(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}
function diffBlock(diff) {
  return `\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

const helpers = {
  workspaceForTool(_server, _workspaces, workspaceId) {
    events.push(`workspace:${workspaceId ?? "default"}`);
    return workspace;
  },
  assertWriteToolAllowed(_config, relPath) {
    events.push(`policy:${relPath}`);
  },
  assertTaskChecklistReady() {
    events.push("checklist");
  },
  workspaceTaskContextForServer() {
    events.push("task-context");
    return taskContext;
  },
  diffBlock,
  parseBool,
  limitInt
};

const graphImpact = {
  dependentFiles: Array.from({ length: 45 }, (_, index) => ({ path: `dep-${index}` })),
  relatedTests: Array.from({ length: 45 }, (_, index) => ({ path: `test-${index}` })),
  riskSignals: ["risk"],
  graphDiff: { nodes: 1 },
  warnings: Array.from({ length: 10 }, (_, index) => `warning-${index}`)
};

const dependencies = {
  toolCardMeta: () => ({ card: true }),
  textResult: (text, structuredContent = {}) => ({ content: [{ type: "text", text }], structuredContent }),
  redactStructured: (value) => ({ ...value, redacted_fixture: true }),
  repoTree: async (_config, _guard, _workspace, options) => {
    treeOptions = options;
    return { text: "tree text", entries: ["src"], truncated: false };
  },
  searchWorkspace: async (_config, _guard, _workspace, options) => {
    searchOptions = options;
    return {
      text: "search text",
      matches: [{ path: "src/a.ts", line: 2, text: "needle" }],
      truncated: false,
      used: "ripgrep",
      analysis: { schema_version: 1, source: "fixture" }
    };
  },
  readTextFile: async (_config, _guard, _workspace, filePath, options) => {
    readArgs = { filePath, options };
    return {
      path: filePath,
      text: "2 | beta\n3 | gamma",
      startLine: 2,
      endLine: 3,
      totalLines: 5,
      bytes: 42,
      sha256: "a".repeat(64),
      truncated: false
    };
  },
  viewWorkspaceImage: async (_config, _guard, _workspace, filePath, maxBytes) => {
    imageArgs = { filePath, maxBytes };
    return { path: filePath, mimeType: "image/png", width: 64, height: 32, bytes: 128, sha256: "b".repeat(64), data: "aW1hZ2U=" };
  },
  claimWorkspacePaths: async (_context, paths) => events.push(`claim:${paths.join(",")}`),
  recordWorkspacePathsTouched: async (_context, paths) => events.push(`touched:${paths.join(",")}`),
  releaseWorkspacePaths: async (_context, paths, options) => events.push(`release:${paths.join(",")}:${options?.onlyUntouched === true}`),
  invalidateWorkspaceAnalysis: (workspaceId) => events.push(`invalidate:${workspaceId}`),
  reviewWorkspaceChanges: async (_config, _guard, _workspace, { changedPaths }) => {
    graphCalls += 1;
    events.push(`graph:${changedPaths.join(",")}`);
    if (graphMode === "throw") throw new Error("graph unavailable");
    return graphImpact;
  },
  writeTextFile: async (_config, _guard, _workspace, filePath, content, options) => {
    events.push(`write:${filePath}`);
    writeArgs = { filePath, content, options };
    if (writeMode === "throw") throw new Error("write failed");
    const changed = writeMode === "changed";
    return {
      path: filePath,
      existed: true,
      bytes: 11,
      sha256: "c".repeat(64),
      diff: { changed, additions: changed ? 1 : 0, deletions: 0, diff: changed ? "+new" : "" }
    };
  },
  editTextFile: async (_config, _guard, _workspace, filePath, oldText, newText, options) => {
    events.push(`edit:${filePath}`);
    editArgs = { filePath, oldText, newText, options };
    if (editMode === "throw") throw new Error("edit failed");
    const changed = editMode === "changed";
    return {
      path: filePath,
      replacements: changed ? 2 : 0,
      bytes: 12,
      sha256: "d".repeat(64),
      diff: { changed, additions: changed ? 2 : 0, deletions: changed ? 2 : 0, diff: changed ? "-old\n+new" : "" }
    };
  },
  patchTouchedPaths: (patchText) => {
    events.push("patch-paths");
    return patchText.includes("b.ts") ? ["src/a.ts", "src/b.ts"] : ["src/a.ts"];
  },
  applyWorkspacePatch: async (_config, _guard, _workspace, patchText, writePolicy) => {
    events.push("patch");
    patchArgs = { patchText };
    writePolicy("src/a.ts");
    if (patchText.includes("b.ts")) writePolicy("src/b.ts");
    if (patchMode === "throw") throw new Error("patch failed");
    const changed = patchMode === "changed";
    return {
      paths: patchText.includes("b.ts") ? ["src/a.ts", "src/b.ts"] : ["src/a.ts"],
      stdout: "patched",
      stderr: "",
      additions: changed ? 2 : 0,
      deletions: changed ? 1 : 0,
      changed,
      diff: changed ? "+patch" : ""
    };
  }
};

function registerCodexTool(_config, _server, name, options, handler) {
  registrations.push(name);
  handlers.set(name, { options, handler });
}

registerWorkspaceFileTools({
  config,
  server,
  workspaces,
  guard,
  registerCodexTool,
  helpers,
  annotations: { readOnly: { readOnlyHint: true }, localWrite: { destructiveHint: true } },
  dependencies
});

assert.deepEqual(registrations, ["tree", "search", "read", "view_image", "write", "edit", "apply_patch"]);
const call = (name, args) => handlers.get(name).handler(args);

await call("tree", {});
assert.deepEqual(treeOptions, { path: ".", maxDepth: 4, includeHidden: false, maxEntries: 800 });
await call("tree", { path: "src", max_depth: 9, include_hidden: true, max_entries: 1200 });
assert.deepEqual(treeOptions, { path: "src", maxDepth: 9, includeHidden: true, maxEntries: 1200 });

let result = await call("search", { query: "needle", regex: true, path: "src", glob: "**/*.ts", include_hidden: true, max_results: 999, intent: "impact", symbol: "Thing", include_tests: true });
assert.deepEqual(searchOptions, { query: "needle", regex: true, root: "src", glob: "**/*.ts", includeHidden: true, maxResults: 50, intent: "impact", symbol: "Thing", includeTests: true });
assert.deepEqual(result.structuredContent.analysis, { schema_version: 1, source: "fixture" });
assert.equal(result.structuredContent.used, "ripgrep");

result = await call("read", { path: "src/a.ts", start_line: 2, end_line: 3, max_bytes: 5000 });
assert.deepEqual(readArgs, { filePath: "src/a.ts", options: { startLine: 2, endLine: 3, maxBytes: 5000 } });
assert.match(result.content[0].text, /Lines: 2-3 of 5/);
assert.equal(result.structuredContent.sha256, "a".repeat(64));

result = await call("view_image", { path: "img.png", max_bytes: 123456 });
assert.deepEqual(imageArgs, { filePath: "img.png", maxBytes: 123456 });
assert.equal(result.content[0].type, "text");
assert.match(result.content[0].text, /Dimensions: 64x32/);
assert.deepEqual(result.content[1], { type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
assert.equal(result.structuredContent.redacted_fixture, true);
assert.equal(result.structuredContent.width, 64);

// write success: checklist -> resolve/policy -> claim -> graph -> write -> touched -> invalidate -> graph
writeMode = "changed";
graphMode = "ok";
graphCalls = 0;
events = [];
result = await call("write", { path: "src/a.ts", content: "new", create_dirs: false, overwrite: false, expected_sha256: "e".repeat(64) });
assert.deepEqual(writeArgs, { filePath: "src/a.ts", content: "new", options: { createDirs: false, overwrite: false, expectedSha256: "e".repeat(64) } });
assert.deepEqual(events, ["checklist", "workspace:default", "resolve:src/a.ts:write", "policy:src/a.ts", "task-context", "claim:src/a.ts", "graph:src/a.ts", "write:src/a.ts", "touched:src/a.ts", "invalidate:ws-files", "graph:src/a.ts"]);
assert.equal(graphCalls, 2);
assert.equal(result.structuredContent.codexgraph.before.dependent_files.length, 40);
assert.equal(result.structuredContent.codexgraph.before.warnings.length, 8);

// write no-change releases only untouched and does not invalidate/re-review.
writeMode = "unchanged";
graphCalls = 0;
events = [];
await call("write", { path: "src/nochange.ts", content: "same" });
assert.deepEqual(events, ["checklist", "workspace:default", "resolve:src/nochange.ts:write", "policy:src/nochange.ts", "task-context", "claim:src/nochange.ts", "graph:src/nochange.ts", "write:src/nochange.ts", "release:src/nochange.ts:true"]);
assert.equal(graphCalls, 1);

// write failure releases only untouched.
writeMode = "throw";
events = [];
await assert.rejects(call("write", { path: "src/fail.ts", content: "x" }), /write failed/);
assert.equal(events.at(-1), "release:src/fail.ts:true");
assert.ok(events.indexOf("checklist") < events.indexOf("write:src/fail.ts"));
writeMode = "changed";

// graph review failure is non-fatal and mutation still succeeds.
graphMode = "throw";
events = [];
result = await call("write", { path: "src/graph.ts", content: "x" });
assert.equal(result.structuredContent.codexgraph.before, undefined);
assert.equal(result.structuredContent.codexgraph.after, undefined);
assert.ok(events.includes("write:src/graph.ts"));
graphMode = "ok";

// edit forwarding including replacement semantics and expected SHA.
events = [];
editMode = "changed";
result = await call("edit", { path: "src/edit.ts", old_text: "old", new_text: "new", replace_all: true, expected_replacements: 2, expected_sha256: "f".repeat(64) });
assert.deepEqual(editArgs, { filePath: "src/edit.ts", oldText: "old", newText: "new", options: { replaceAll: true, expectedReplacements: 2, expectedSha256: "f".repeat(64) } });
assert.ok(events.indexOf("checklist") < events.indexOf("edit:src/edit.ts"));
assert.ok(events.includes("touched:src/edit.ts"));
assert.equal(result.structuredContent.replacements, 2);

// patch changed path claim/record + policy callback.
patchMode = "changed";
events = [];
result = await call("apply_patch", { patch: "patch touching a.ts and b.ts" });
assert.equal(patchArgs.patchText, "patch touching a.ts and b.ts");
assert.ok(events.includes("claim:src/a.ts,src/b.ts"));
assert.ok(events.includes("policy:src/a.ts"));
assert.ok(events.includes("policy:src/b.ts"));
assert.ok(events.includes("touched:src/a.ts,src/b.ts"));
assert.ok(events.includes("invalidate:ws-files"));
assert.deepEqual(result.structuredContent.paths, ["src/a.ts", "src/b.ts"]);

// patch failure cleanup.
patchMode = "throw";
events = [];
await assert.rejects(call("apply_patch", { patch: "patch touching a.ts" }), /patch failed/);
assert.equal(events.at(-1), "release:src/a.ts:true");
assert.ok(events.indexOf("checklist") < events.indexOf("patch"));

console.log("workspace-file-tools smoke passed");
