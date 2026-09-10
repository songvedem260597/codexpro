import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createProjectDiscovery,
  REPO_SCAN_MAX_DEPTH,
  REPO_SCAN_MAX_DIRECTORIES,
  REPO_SCAN_SKIPPED_DIRECTORIES,
  REPO_SCAN_TIMEOUT_MS
} from "../electron/project-discovery.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-project-discovery-"));
const home = path.join(tempRoot, "home");
const codexProHome = path.join(home, ".codexpro");
const scanRoot = path.join(tempRoot, "scan");
fs.mkdirSync(path.join(codexProHome, "profiles"), { recursive: true });
fs.mkdirSync(path.join(codexProHome, "runtime"), { recursive: true });
fs.mkdirSync(scanRoot, { recursive: true });

function gitMarker(root, asFile = false) {
  fs.mkdirSync(root, { recursive: true });
  const marker = path.join(root, ".git");
  if (asFile) fs.writeFileSync(marker, "gitdir: C:/fixture/gitdir\n", "utf8");
  else fs.mkdirSync(marker, { recursive: true });
}

const normalRepo = path.join(scanRoot, "normal-repo");
const worktreeRepo = path.join(scanRoot, "worktree-repo");
const outerRepo = path.join(scanRoot, "outer-repo");
const nestedRepo = path.join(outerRepo, "nested-repo");
const skippedRepo = path.join(scanRoot, "node_modules", "ignored-repo");
gitMarker(normalRepo);
gitMarker(worktreeRepo, true);
gitMarker(outerRepo);
gitMarker(nestedRepo);
gitMarker(skippedRepo);

const parserClient = createProjectDiscovery({
  codexProHome,
  homedir: () => home,
  allAllowedWorkspaces: "__ALL__"
});

assert.equal(parserClient.githubRepoFromRemote("https://github.com/OpenAI/codex.git"), "OpenAI/codex");
assert.equal(parserClient.githubRepoFromRemote("git@github.com:OpenAI/codex.git"), "OpenAI/codex");
assert.equal(parserClient.githubRepoFromRemote("ssh://git@gitlab.example.com/team/repo.git"), "");
assert.deepEqual(parserClient.repoIdentityFromRemote("https://github.com/OpenAI/codex.git"), {
  officialName: "codex",
  repoFullName: "OpenAI/codex"
});
assert.deepEqual(parserClient.repoIdentityFromRemote("ssh://git@gitlab.example.com/team/repo.git"), {
  officialName: "repo",
  repoFullName: "team/repo"
});

assert.equal(REPO_SCAN_MAX_DIRECTORIES, 50000);
assert.equal(REPO_SCAN_MAX_DEPTH, 12);
assert.equal(REPO_SCAN_TIMEOUT_MS, 12000);
assert.equal(REPO_SCAN_SKIPPED_DIRECTORIES.has("node_modules"), true);
assert.equal(REPO_SCAN_SKIPPED_DIRECTORIES.has(".git"), true);

const internalWorkspaceWorktree = path.join(codexProHome, "workspace-worktrees", "fixture", "task");
const internalCodexWorktree = path.join(home, ".codex", "worktrees", "fixture");
assert.equal(parserClient.isInternalWorkspaceWorktree(internalWorkspaceWorktree), true);
assert.equal(parserClient.isInternalWorkspaceWorktree(internalCodexWorktree), true);
assert.equal(parserClient.isInternalWorkspaceWorktree(normalRepo), false);

const discovered = await parserClient.discoverGitRepositories([scanRoot, scanRoot]);
const discoveredKeys = new Set(discovered.map((root) => path.resolve(root).toLowerCase()));
assert.equal(discoveredKeys.size, discovered.length, "duplicate scan roots must not duplicate repositories");
assert.equal(discoveredKeys.has(path.resolve(normalRepo).toLowerCase()), true, "normal .git directory repo must be found");
assert.equal(discoveredKeys.has(path.resolve(worktreeRepo).toLowerCase()), true, ".git-file worktree repo must be found");
assert.equal(discoveredKeys.has(path.resolve(outerRepo).toLowerCase()), true, "outer repo must be found");
assert.equal(discoveredKeys.has(path.resolve(nestedRepo).toLowerCase()), true, "direct nested repo must be found");
assert.equal(discoveredKeys.has(path.resolve(skippedRepo).toLowerCase()), false, "skipped directories must not be scanned");

const cachedOnlyRepo = path.join(scanRoot, "created-after-scan");
gitMarker(cachedOnlyRepo);
const cachedDiscovery = await parserClient.discoverGitRepositories([scanRoot, scanRoot]);
assert.equal(cachedDiscovery.some((root) => path.resolve(root).toLowerCase() === path.resolve(cachedOnlyRepo).toLowerCase()), false, "repo scan cache must be reused inside its TTL");

const summaryRoot = path.join(tempRoot, "summary-repo");
const nonGitRoot = path.join(tempRoot, "plain-folder");
const githubLookupRoot = path.join(tempRoot, "github-lookup");
for (const root of [summaryRoot, nonGitRoot, githubLookupRoot]) fs.mkdirSync(root, { recursive: true });
const gitCalls = [];
const fakeGit = async (args, options = {}) => {
  gitCalls.push({ args: [...args], options: { ...options } });
  const root = args[1];
  const command = args.slice(2).join(" ");
  if (root === nonGitRoot) throw new Error("not a git repository");
  if (root === githubLookupRoot && command === "remote get-url origin") return { stdout: "https://github.com/acme/cache-demo.git\n" };
  if (root !== summaryRoot) throw new Error(`unexpected root: ${root}`);
  if (command === "status --porcelain=v2 --branch") {
    return {
      stdout: [
        "# branch.oid abcdef123456",
        "# branch.head feature/project-discovery",
        "# branch.upstream origin/feature/project-discovery",
        "# branch.ab +2 -3",
        "1 .M N... 100644 100644 100644 a a file-a.txt",
        "2 R. N... 100644 100644 100644 a a R100 file-b.txt\tfile-old.txt",
        "? untracked.txt",
        "u UU N... 100644 100644 100644 100644 a b c conflicted.txt"
      ].join("\n")
    };
  }
  if (command === "log -1 --pretty=format:%h%x09%s%x09%cI") return { stdout: "abc123\tLocal commit\t2026-09-10T10:00:00.000Z" };
  if (command === "remote get-url origin") return { stdout: "git@github.com:acme/summary-repo.git\n" };
  if (command === "log -1 --pretty=format:%h%x09%cI origin/feature/project-discovery") return { stdout: "def456\t2026-09-10T12:00:00.000Z" };
  if (command === "reflog show -1 --format=%gI origin/feature/project-discovery") return { stdout: "2026-09-10T11:00:00.000Z\n" };
  throw new Error(`unexpected git command: ${command}`);
};

const summaryClient = createProjectDiscovery({
  codexProHome,
  homedir: () => home,
  runGitProcess: fakeGit,
  allAllowedWorkspaces: "__ALL__"
});

const [summaryA, summaryB] = await Promise.all([
  summaryClient.gitSummary(summaryRoot),
  summaryClient.gitSummary(summaryRoot)
]);
assert.deepEqual(summaryA, summaryB);
assert.equal(summaryA.isGit, true);
assert.equal(summaryA.branch, "feature/project-discovery");
assert.equal(summaryA.ahead, 2);
assert.equal(summaryA.behind, 3);
assert.equal(summaryA.changes, 4);
assert.equal(summaryA.modified, 2);
assert.equal(summaryA.untracked, 1);
assert.equal(summaryA.conflicted, 1);
assert.deepEqual(summaryA.commit, { hash: "abc123", subject: "Local commit", date: "2026-09-10T10:00:00.000Z" });
assert.equal(summaryA.remoteUrl, "git@github.com:acme/summary-repo.git");
assert.equal(summaryA.upstream, "origin/feature/project-discovery");
assert.equal(summaryA.pushedAt, "2026-09-10T11:00:00.000Z");
assert.equal(summaryA.remoteCommitAt, "2026-09-10T12:00:00.000Z");
assert.equal(summaryA.remoteCommitHash, "def456");
assert.equal(summaryA.activityKind, "remote");
assert.equal(summaryA.activityAt, "2026-09-10T12:00:00.000Z");
assert.equal(summaryA.githubRepo, "acme/summary-repo");
assert.equal(summaryA.officialName, "summary-repo");
assert.equal(summaryA.repoFullName, "acme/summary-repo");
assert.equal(gitCalls.filter((call) => call.args[1] === summaryRoot && call.args[2] === "status").length, 1, "concurrent git summaries must single-flight");
await summaryClient.gitSummary(summaryRoot);
assert.equal(gitCalls.filter((call) => call.args[1] === summaryRoot && call.args[2] === "status").length, 1, "git summary cache must avoid repeat Git calls inside TTL");
const statusCall = gitCalls.find((call) => call.args[1] === summaryRoot && call.args[2] === "status");
assert.equal(statusCall.options.timeoutMs, 4000);
assert.equal(statusCall.options.maxBuffer, 2 * 1024 * 1024);
assert.ok(gitCalls.filter((call) => call.args[1] === summaryRoot).every((call) => call.options.timeoutMs === 4000), "all Git summary subprocesses must preserve the 4s timeout");

const nonGitSummary = await summaryClient.gitSummary(nonGitRoot);
assert.deepEqual(nonGitSummary, {
  isGit: false,
  branch: "",
  changes: 0,
  modified: 0,
  untracked: 0,
  conflicted: 0,
  ahead: 0,
  behind: 0,
  commit: null,
  remoteUrl: "",
  upstream: "",
  pushedAt: "",
  remoteCommitAt: "",
  remoteCommitHash: "",
  activityAt: "",
  activityTimestamp: 0,
  activityKind: "",
  githubRepo: "",
  officialName: "",
  repoFullName: ""
});

assert.equal(await summaryClient.githubRepoForRoot(githubLookupRoot), "acme/cache-demo");
assert.equal(await summaryClient.githubRepoForRoot(githubLookupRoot), "acme/cache-demo");
assert.equal(gitCalls.filter((call) => call.args[1] === githubLookupRoot && call.args[2] === "remote").length, 1, "GitHub repo lookup must use its cache inside TTL");

const manualA = path.join(tempRoot, "manual-a");
const manualB = path.join(tempRoot, "manual-b");
fs.mkdirSync(manualA, { recursive: true });
fs.mkdirSync(manualB, { recursive: true });
summaryClient.saveManagerProjects([manualA, manualB]);
assert.deepEqual(summaryClient.managerProjects(), [manualA, manualB], "manually added project persistence must round-trip");

const catalogRoot = path.join(tempRoot, "catalog");
const activeRoot = path.join(catalogRoot, "active-project");
const inUseRoot = path.join(catalogRoot, "in-use-project");
const changedRoot = path.join(catalogRoot, "changed-project");
const quietRoot = path.join(catalogRoot, "quiet-project");
for (const root of [activeRoot, inUseRoot, changedRoot, quietRoot]) gitMarker(root);
const catalogInternalRoot = path.join(codexProHome, "workspace-worktrees", "fixture", "internal-project");
gitMarker(catalogInternalRoot);
fs.writeFileSync(path.join(codexProHome, "profiles", "changed.json"), JSON.stringify({ root: changedRoot }), "utf8");
fs.writeFileSync(path.join(codexProHome, "profiles", "internal.json"), JSON.stringify({ root: catalogInternalRoot }), "utf8");
fs.writeFileSync(path.join(codexProHome, "runtime", "in-use.json"), JSON.stringify({ root: inUseRoot }), "utf8");

const catalogDates = new Map([
  [activeRoot, "2026-09-10T13:00:00.000Z"],
  [inUseRoot, "2026-09-10T12:00:00.000Z"],
  [changedRoot, "2026-09-10T11:00:00.000Z"],
  [quietRoot, "2026-09-10T11:00:00.000Z"]
]);
const catalogGit = async (args) => {
  const root = args[1];
  const command = args.slice(2).join(" ");
  if (!catalogDates.has(root)) throw new Error("not git");
  const date = catalogDates.get(root);
  if (command === "status --porcelain=v2 --branch") {
    const dirtyLine = root === changedRoot ? "1 .M N... 100644 100644 100644 a a changed.txt" : "";
    return { stdout: ["# branch.head win", "# branch.ab +0 -0", dirtyLine].filter(Boolean).join("\n") };
  }
  if (command === "log -1 --pretty=format:%h%x09%s%x09%cI") return { stdout: `abc123\t${path.basename(root)}\t${date}` };
  if (command === "remote get-url origin") return { stdout: `https://github.com/acme/${path.basename(root)}.git\n` };
  throw new Error(`unexpected catalog git command: ${command}`);
};
const diagnostics = [];
const catalogClient = createProjectDiscovery({
  codexProHome,
  homedir: () => home,
  runGitProcess: catalogGit,
  readTaskConfig: async () => ({ root: activeRoot, allowedRoots: [catalogRoot], allowHome: false }),
  readManagerSettings: () => ({ repoSelections: { selected: inUseRoot, all: "__ALL__" } }),
  diagnostic: (...args) => diagnostics.push(args),
  allAllowedWorkspaces: "__ALL__"
});
catalogClient.saveManagerProjects([quietRoot, quietRoot]);
const projects = await catalogClient.listProjects();
const roots = projects.map((project) => path.resolve(project.root));
assert.equal(roots.filter((root) => root.toLowerCase() === quietRoot.toLowerCase()).length, 1, "duplicate roots must collapse in the catalog");
assert.equal(roots.some((root) => root.toLowerCase() === catalogInternalRoot.toLowerCase()), false, "internal task worktrees must be excluded from the catalog");
assert.deepEqual(roots.slice(0, 4), [activeRoot, inUseRoot, changedRoot, quietRoot], "project ordering must preserve active/in-use, activity, changes, then name priority");
const activeProject = projects.find((project) => path.resolve(project.root) === activeRoot);
const inUseProject = projects.find((project) => path.resolve(project.root) === inUseRoot);
assert.equal(activeProject.active, true);
assert.equal(activeProject.source, "Đang chạy");
assert.equal(inUseProject.inUse, true);
assert.equal(projects.find((project) => path.resolve(project.root) === changedRoot)?.source, "CodexPro profile");
assert.equal(projects.find((project) => path.resolve(project.root) === quietRoot)?.source, "Đã thêm");
assert.equal(diagnostics.length, 0, "fast project listing should not emit slow-phase diagnostics");

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("project-discovery-smoke: ok");
