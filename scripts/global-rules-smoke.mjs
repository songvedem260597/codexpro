import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEXPRO_GLOBAL_RULES_FILE,
  DEFAULT_CODEXPRO_GLOBAL_RULES,
  readGlobalRulesSnapshot,
  readGlobalRulesSnapshotSync,
  withGlobalRules
} from "../src/globalRules.js";
import { STRUCTURED_STRING_MAX_CHARS } from "../src/toolResults.js";

const previousHome = process.env.CODEXPRO_HOME;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-global-rules-smoke-"));
const rulesPath = path.join(tempHome, CODEXPRO_GLOBAL_RULES_FILE);
const sha = (text) => createHash("sha256").update(text).digest("hex");

try {
  process.env.CODEXPRO_HOME = tempHome;

  const missing = readGlobalRulesSnapshotSync();
  assert.equal(missing.path, rulesPath);
  assert.equal(missing.source, "template");
  assert.equal(missing.text, DEFAULT_CODEXPRO_GLOBAL_RULES);
  assert.equal(missing.sha256, sha(DEFAULT_CODEXPRO_GLOBAL_RULES));
  assert.deepEqual(await readGlobalRulesSnapshot(), missing, "async loader must preserve sync snapshot behavior");

  fs.writeFileSync(rulesPath, "alpha\r\nbeta\r\n", "utf8");
  const file = readGlobalRulesSnapshotSync();
  assert.equal(file.source, "file");
  assert.equal(file.text, "alpha\nbeta\n");
  assert.equal(file.sha256, sha("alpha\nbeta\n"));

  const longText = "x".repeat(STRUCTURED_STRING_MAX_CHARS + 1);
  fs.writeFileSync(rulesPath, longText, "utf8");
  const bounded = readGlobalRulesSnapshotSync();
  assert.equal(bounded.source, "file");
  assert.equal(bounded.text.length, STRUCTURED_STRING_MAX_CHARS);
  assert.equal(bounded.text, "x".repeat(STRUCTURED_STRING_MAX_CHARS));
  assert.equal(bounded.sha256, sha(bounded.text));

  fs.rmSync(rulesPath, { force: true });
  fs.mkdirSync(rulesPath);
  assert.throws(
    () => readGlobalRulesSnapshotSync(),
    (error) => Boolean(error && typeof error === "object" && error.code && error.code !== "ENOENT"),
    "non-ENOENT read errors must propagate"
  );
  fs.rmSync(rulesPath, { recursive: true, force: true });

  const wrapperSnapshot = {
    path: "C:/fixture/.codexpro/CODEXPRO.md",
    text: "rule one\nrule two",
    sha256: "abc123",
    source: "file"
  };
  assert.equal(
    withGlobalRules("repo context", wrapperSnapshot),
    [
      "# Mandatory CodexPro Global Rules",
      "",
      "Source: C:/fixture/.codexpro/CODEXPRO.md",
      "SHA-256: abc123",
      "Read and follow these rules before repository-specific AGENTS.md instructions or project decisions.",
      "",
      "rule one\nrule two",
      "",
      "repo context"
    ].join("\n")
  );
  assert.ok(withGlobalRules("repo context", { ...wrapperSnapshot, text: "" }).includes("\n(No global rules configured.)\n"));

  console.log("global-rules smoke passed");
} finally {
  if (previousHome === undefined) delete process.env.CODEXPRO_HOME;
  else process.env.CODEXPRO_HOME = previousHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
}
