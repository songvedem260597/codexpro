import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { runBash } = await import(pathToFileURL(path.join(projectRoot, "dist", "bashOps.js")).href);
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-git-write-smoke-"));
const repoRoot = path.join(scratchRoot, "repo");
const remoteRoot = path.join(repoRoot, "remote.git");

function git(args, options = {}) {
  return execFileSync(process.platform === "win32" ? "git.exe" : "git", args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    cwd: options.cwd
  }).trim();
}

try {
  fs.mkdirSync(repoRoot);
  git(["init"], { cwd: repoRoot });
  git(["init", "--bare", remoteRoot]);
  git(["config", "user.name", "CodexPro Smoke"], { cwd: repoRoot });
  git(["config", "user.email", "codexpro-smoke@example.invalid"], { cwd: repoRoot });
  git(["remote", "add", "origin", remoteRoot], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "safe git write smoke\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, ".env"), "DO_NOT_STAGE=1\n", "utf8");

  const hookMarker = path.join(repoRoot, "hook-ran.txt");
  const hookPath = path.join(repoRoot, ".git", "hooks", "post-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\nprintf hook-ran > "${hookMarker.replace(/\\/g, "/")}"\n`, "utf8");
  fs.chmodSync(hookPath, 0o755);
  const pushHookMarker = path.join(repoRoot, "push-hook-ran.txt");
  const pushHookPath = path.join(repoRoot, ".git", "hooks", "pre-push");
  fs.writeFileSync(pushHookPath, `#!/bin/sh\nprintf push-hook-ran > "${pushHookMarker.replace(/\\/g, "/")}"\n`, "utf8");
  fs.chmodSync(pushHookPath, 0o755);

  const config = {
    bashMode: "safe",
    requireBashSession: false,
    inheritEnv: true,
    maxOutputBytes: 100_000,
    maxBashTimeoutMs: 600_000
  };
  const workspace = { id: "git-write-policy-smoke", root: repoRoot };
  const guard = {
    resolve(_workspace, requestedPath) {
      assert.equal(requestedPath, ".");
      return { absPath: repoRoot, relPath: "." };
    }
  };
  const run = (command) => runBash(config, guard, workspace, command, { timeoutMs: 20_000 });
  const expectBlocked = async (command) => {
    await assert.rejects(run(command), /blocked|not in the .*allowlist/i);
  };

  assert.equal((await run("git add tracked.txt")).exitCode, 0);
  assert.equal((await run('git commit -m "safe policy smoke"')).exitCode, 0);
  assert.equal(fs.existsSync(hookMarker), false, "repository hooks must not run during a safe commit");
  git(["branch", "-M", "main"], { cwd: repoRoot });
  assert.equal((await run("git push origin main")).exitCode, 0);
  assert.equal(fs.existsSync(pushHookMarker), false, "repository hooks must not run during a safe push");
  assert.equal(git(["rev-parse", "HEAD"], { cwd: repoRoot }), git(["--git-dir", remoteRoot, "rev-parse", "refs/heads/main"]));

  await expectBlocked("git add .env");
  await expectBlocked("git add .");
  await expectBlocked("git add -A");
  await expectBlocked("git add ../outside.txt");
  await expectBlocked('git commit --amend -m "unsafe"');
  await expectBlocked("git push --force origin main");
  await expectBlocked("git push upstream main");
  await expectBlocked("git push origin :main");
  await expectBlocked("git push origin --tags");

  console.log("git write policy smoke passed");
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
