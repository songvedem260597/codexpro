import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const managerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedStates = ["idle", "working", "hung"];
const expectedPacks = new Map([
  ["y-ta-dam-dang-pixel", "Y tá đảm đang Pixel"],
  ["co-sinh-vien-dam-dang", "Cô sinh viên đảm đang"]
]);
const appSource = fs.readFileSync(path.join(managerRoot, "src", "main.jsx"), "utf8");
const electronSource = fs.readFileSync(path.join(managerRoot, "electron", "main.mjs"), "utf8");

for (const [packId, packName] of expectedPacks) {
  const packRoot = path.join(managerRoot, "src", "assets", "worker-packs", packId);
  const manifest = JSON.parse(fs.readFileSync(path.join(packRoot, "manifest.json"), "utf8"));

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, packId);
  assert.equal(manifest.name, packName);
  assert.deepEqual(Object.keys(manifest.states).sort(), [...expectedStates].sort());

  for (const state of expectedStates) {
    const entry = manifest.states[state];
    assert.match(entry.file, /^[A-Za-z0-9._-]+\.gif$/);
    const assetPath = path.resolve(packRoot, entry.file);
    assert.equal(path.dirname(assetPath), packRoot, `${packId}/${state} escapes the pack directory`);
    const data = fs.readFileSync(assetPath);
    assert.ok(data.subarray(0, 6).equals(Buffer.from("GIF89a")) || data.subarray(0, 6).equals(Buffer.from("GIF87a")), `${packId}/${state} is not a GIF`);
    assert.equal(data.byteLength, entry.bytes, `${packId}/${state} byte length changed`);
    assert.equal(createHash("sha256").update(data).digest("hex"), entry.sha256, `${packId}/${state} checksum changed`);

    let frameCount = 0;
    let transparentFrameCount = 0;
    for (let index = 0; index <= data.length - 4; index += 1) {
      if (data[index] !== 0x21 || data[index + 1] !== 0xf9 || data[index + 2] !== 0x04) continue;
      frameCount += 1;
      if ((data[index + 3] & 0x01) === 0x01) transparentFrameCount += 1;
    }
    assert.equal(frameCount, entry.frames, `${packId}/${state} frame count changed`);
    assert.equal(transparentFrameCount, frameCount, `${packId}/${state} has a non-transparent frame`);
    assert.equal(entry.transparent, true);

    const expectedImport = `./assets/worker-packs/${manifest.id}/${entry.file}`;
    assert.ok(appSource.includes(expectedImport), `${packId}/${state} pack asset is not imported by the app`);
  }
}

assert.ok(!appSource.includes("y-ta-dam-dang-pixel/idle-v2.gif"), "heart idle animation must not be used");
assert.ok(appSource.includes('"co-sinh-vien-dam-dang"'), "student worker pack is not exposed in the UI");
assert.ok(electronSource.includes('"co-sinh-vien-dam-dang"'), "student worker pack is not registered in Electron settings");

console.log("✓ Shared macOS/Windows worker GIF pack smoke test passed");
