import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANAGER_RELEASE_DIR = path.join("manager", "release");
const MANIFEST_NAME = ".codexpro-build-manifest.json";
const SETUP_RE = /^CodexPro-Manager-Setup-[A-Za-z0-9._-]+\.exe$/;
const BLOCKMAP_RE = /^CodexPro-Manager-Setup-[A-Za-z0-9._-]+\.exe\.blockmap$/;

function gitText(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function sameFsPath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isPublishableArtifact(name) {
  return SETUP_RE.test(name) || BLOCKMAP_RE.test(name) || name === "latest.yml";
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export function resolveManagerArtifactRoots(cwd = process.cwd()) {
  const sourceRoot = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  const commonDir = gitText(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (path.basename(commonDir).toLowerCase() !== ".git") {
    throw new Error(`Expected a normal Git worktree with a shared .git directory, got: ${commonDir}`);
  }
  const primaryRoot = path.dirname(commonDir);
  return { sourceRoot, primaryRoot };
}

async function rejectSymlinkIfPresent(file) {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to publish through a symlink: ${file}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function publishManagerArtifacts({ sourceRoot, primaryRoot, sourceHead = "", sourceDirty = false }) {
  const sourceRelease = path.resolve(sourceRoot, MANAGER_RELEASE_DIR);
  const primaryRelease = path.resolve(primaryRoot, MANAGER_RELEASE_DIR);
  const sourceRootReal = await realpath(sourceRoot);
  const primaryRootReal = await realpath(primaryRoot);
  const sourceReleaseReal = await realpath(sourceRelease).catch(() => "");
  if (!sourceReleaseReal) throw new Error(`Manager release directory does not exist: ${sourceRelease}`);
  if (!isInside(sourceRootReal, sourceReleaseReal)) {
    throw new Error(`Refusing to publish from release directory outside the task repository: ${sourceReleaseReal}`);
  }

  const entries = await readdir(sourceRelease, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && isPublishableArtifact(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!names.some((name) => SETUP_RE.test(name))) {
    throw new Error(`No CodexPro Manager installer found in ${sourceRelease}`);
  }

  await mkdir(primaryRelease, { recursive: true });
  const primaryReleaseStat = await lstat(primaryRelease);
  const primaryReleaseReal = await realpath(primaryRelease);
  if (!primaryReleaseStat.isDirectory() || primaryReleaseStat.isSymbolicLink() || !isInside(primaryRootReal, primaryReleaseReal)) {
    throw new Error(`Refusing to publish outside the primary repository release directory: ${primaryRelease}`);
  }

  const artifacts = [];
  for (const name of names) {
    const source = path.join(sourceRelease, name);
    const destination = path.join(primaryRelease, name);
    const sourceStat = await lstat(source);
    const sourceReal = await realpath(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || !isInside(sourceReleaseReal, sourceReal)) {
      throw new Error(`Refusing to publish non-regular artifact: ${source}`);
    }
    await rejectSymlinkIfPresent(destination);
    if (!sameFsPath(source, destination)) await copyFile(source, destination);
    const sourceHash = await sha256(source);
    const destinationHash = await sha256(destination);
    if (sourceHash !== destinationHash) throw new Error(`Published artifact verification failed: ${name}`);
    artifacts.push({ name, bytes: sourceStat.size, sha256: sourceHash });
  }

  const manifestPath = path.join(primaryRelease, MANIFEST_NAME);
  await rejectSymlinkIfPresent(manifestPath);
  const manifest = {
    schema: 1,
    published_at: new Date().toISOString(),
    source_root: path.resolve(sourceRoot),
    primary_root: path.resolve(primaryRoot),
    source_head: sourceHead || null,
    source_dirty: Boolean(sourceDirty),
    artifacts
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { sourceRelease, primaryRelease, copied: !sameFsPath(sourceRelease, primaryRelease), artifacts, manifest };
}

async function main() {
  const { sourceRoot, primaryRoot } = resolveManagerArtifactRoots();
  const sourceHead = gitText(sourceRoot, ["rev-parse", "HEAD"]);
  const sourceDirty = Boolean(gitText(sourceRoot, ["status", "--porcelain"]));
  const result = await publishManagerArtifacts({ sourceRoot, primaryRoot, sourceHead, sourceDirty });
  console.log(`[manager artifacts] ${result.copied ? "published" : "verified"} ${result.artifacts.length} file(s) -> ${result.primaryRelease}`);
  for (const artifact of result.artifacts) {
    console.log(`  ${artifact.name}  ${artifact.bytes} bytes  sha256=${artifact.sha256}`);
  }
}

if (process.argv[1] && sameFsPath(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`[manager artifacts] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
