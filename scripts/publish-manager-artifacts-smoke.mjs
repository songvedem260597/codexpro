import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishManagerArtifacts, resolveManagerArtifactRoots } from "./publish-manager-artifacts.mjs";

const scriptPath = fileURLToPath(new URL("./publish-manager-artifacts.mjs", import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), "codexpro-artifact-publish-"));
const mainRoot = path.join(temp, "repo");
const worktreeRoot = path.join(temp, "task-worktree");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

try {
  await mkdir(mainRoot, { recursive: true });
  git(mainRoot, ["init", "-b", "win"]);
  git(mainRoot, ["config", "user.name", "CodexPro Smoke"]);
  git(mainRoot, ["config", "user.email", "smoke@codexpro.local"]);
  await writeFile(path.join(mainRoot, "README.md"), "artifact publish smoke\n", "utf8");
  git(mainRoot, ["add", "README.md"]);
  git(mainRoot, ["commit", "-m", "init"]);
  git(mainRoot, ["worktree", "add", "-b", "codexpro/task/artifact-smoke", worktreeRoot]);

  const worktreeRelease = path.join(worktreeRoot, "manager", "release");
  await mkdir(path.join(worktreeRelease, "win-unpacked"), { recursive: true });
  const installer = "CodexPro-Manager-Setup-0.2.999.exe";
  const blockmap = `${installer}.blockmap`;
  await writeFile(path.join(worktreeRelease, installer), "installer-from-task\n", "utf8");
  await writeFile(path.join(worktreeRelease, blockmap), "blockmap-from-task\n", "utf8");
  await writeFile(path.join(worktreeRelease, "latest.yml"), "version: 0.2.999\n", "utf8");
  await writeFile(path.join(worktreeRelease, "debug.txt"), "must-not-publish\n", "utf8");
  await writeFile(path.join(worktreeRelease, "win-unpacked", "CodexPro Manager.exe"), "must-not-publish-directory\n", "utf8");

  const roots = resolveManagerArtifactRoots(worktreeRoot);
  assert.equal(path.resolve(roots.sourceRoot), path.resolve(worktreeRoot));
  assert.equal(path.resolve(roots.primaryRoot), path.resolve(mainRoot));

  const head = git(worktreeRoot, ["rev-parse", "HEAD"]);
  const result = await publishManagerArtifacts({ sourceRoot: roots.sourceRoot, primaryRoot: roots.primaryRoot, sourceHead: head, sourceDirty: true });
  assert.equal(result.copied, true);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.name), [installer, blockmap, "latest.yml"]);

  const mainRelease = path.join(mainRoot, "manager", "release");
  assert.equal(await readFile(path.join(mainRelease, installer), "utf8"), "installer-from-task\n");
  assert.equal(await readFile(path.join(mainRelease, blockmap), "utf8"), "blockmap-from-task\n");
  assert.equal(await readFile(path.join(mainRelease, "latest.yml"), "utf8"), "version: 0.2.999\n");
  await assert.rejects(readFile(path.join(mainRelease, "debug.txt"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(path.join(mainRelease, "win-unpacked", "CodexPro Manager.exe"), "utf8"), /ENOENT/);

  const manifest = JSON.parse(await readFile(path.join(mainRelease, ".codexpro-build-manifest.json"), "utf8"));
  assert.equal(manifest.source_head, head);
  assert.equal(manifest.source_dirty, true);
  assert.equal(path.resolve(manifest.source_root), path.resolve(worktreeRoot));
  assert.equal(path.resolve(manifest.primary_root), path.resolve(mainRoot));
  assert.equal(manifest.artifacts.length, 3);

  await writeFile(path.join(worktreeRelease, installer), "installer-from-cli\n", "utf8");
  const cli = spawnSync(process.execPath, [scriptPath], { cwd: path.join(worktreeRoot, "manager"), encoding: "utf8", windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.match(cli.stdout, /published 3 file\(s\)/i);
  assert.equal(await readFile(path.join(mainRelease, installer), "utf8"), "installer-from-cli\n");

  console.log("manager artifact publish smoke passed");
} finally {
  await rm(temp, { recursive: true, force: true });
}
