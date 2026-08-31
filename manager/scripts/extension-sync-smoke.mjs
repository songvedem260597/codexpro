import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverUnpackedCodexProExtensions, syncUnpackedCodexProExtensions, CODEXPRO_EXTENSION_ID } from "../electron/extension-sync.mjs";

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexpro-extension-sync-"));
const userDataRoot = path.join(root, "chrome");
const sourceRoot = path.join(root, "source-extension");
const targetRoot = path.join(root, "loaded-extension");
const codexProHome = path.join(root, "codexpro-home");
const key = "test-key";

async function writeJson(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

try {
  await writeJson(path.join(sourceRoot, "manifest.json"), {
    manifest_version: 3,
    name: "CodexPro Profile Bridge",
    version: "0.5.88",
    key
  });
  await fs.promises.writeFile(path.join(sourceRoot, "service-worker.js"), "new-worker\n", "utf8");

  await writeJson(path.join(targetRoot, "manifest.json"), {
    manifest_version: 3,
    name: "CodexPro Profile Bridge",
    version: "0.5.73",
    key
  });
  await fs.promises.writeFile(path.join(targetRoot, "service-worker.js"), "old-worker\n", "utf8");

  for (const profile of ["Profile 12", "Profile 14"]) {
    await writeJson(path.join(userDataRoot, profile, "Secure Preferences"), {
      extensions: {
        settings: {
          [CODEXPRO_EXTENSION_ID]: {
            location: 4,
            path: targetRoot
          }
        }
      }
    });
  }

  const discovered = discoverUnpackedCodexProExtensions({ userDataRoot });
  assert.equal(discovered.length, 1, "duplicate profile paths should collapse to one extension installation");
  assert.deepEqual(discovered[0].profileDirectories.sort(), ["Profile 12", "Profile 14"]);

  const result = await syncUnpackedCodexProExtensions({
    sourceRoot,
    targetVersion: "0.5.88",
    codexProHome,
    userDataRoot
  });

  assert.equal(result.synced.length, 1);
  assert.equal(JSON.parse(await fs.promises.readFile(path.join(targetRoot, "manifest.json"), "utf8")).version, "0.5.88");
  assert.equal(await fs.promises.readFile(path.join(targetRoot, "service-worker.js"), "utf8"), "new-worker\n");

  const backupPath = result.synced[0].backupPath;
  assert.ok(backupPath && fs.existsSync(backupPath), "stale loaded extension should be backed up before overwrite");
  assert.equal(await fs.promises.readFile(path.join(backupPath, "service-worker.js"), "utf8"), "old-worker\n");
  const backupMeta = JSON.parse(await fs.promises.readFile(path.join(backupPath, ".codexpro-backup.json"), "utf8"));
  assert.equal(path.resolve(backupMeta.originalPath), path.resolve(targetRoot));
  assert.equal(backupMeta.version, "0.5.73");

  const second = await syncUnpackedCodexProExtensions({
    sourceRoot,
    targetVersion: "0.5.88",
    codexProHome,
    userDataRoot
  });
  assert.equal(second.synced.length, 0, "already updated extension should not be copied again");
  assert.ok(second.skipped.some((item) => item.reason === "up_to_date"));

  console.log("✓ unpacked CodexPro extension sync smoke test passed");
} finally {
  await fs.promises.rm(root, { recursive: true, force: true });
}
