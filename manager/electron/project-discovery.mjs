import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runGitProcess } from "./process-runner.mjs";

export const REPO_SCAN_CACHE_MS = 10 * 60 * 1000;
export const GIT_SUMMARY_CACHE_MS = 2 * 60 * 1000;
export const GIT_SUMMARY_CACHE_RETENTION_MS = 30 * 60 * 1000;
export const REPO_SCAN_MAX_DIRECTORIES = 50000;
export const REPO_SCAN_MAX_DEPTH = 12;
export const REPO_SCAN_TIMEOUT_MS = 12000;
export const REPO_SCAN_SKIPPED_DIRECTORIES = new Set([
  "$recycle.bin", "system volume information", "windows", "program files", "program files (x86)", "programdata",
  "appdata", "node_modules", ".git", ".codexpro", ".codex", ".cache", ".gradle", ".idea", ".next", "dist", "build", "coverage", "vendor"
]);

export function createProjectDiscovery(options = {}) {
  const codexProHome = path.resolve(String(options.codexProHome || ""));
  const managerProjectsFile = options.managerProjectsFile || path.join(codexProHome, "manager-projects.json");
  const readTaskConfig = typeof options.readTaskConfig === "function" ? options.readTaskConfig : async () => ({});
  const readManagerSettings = typeof options.readManagerSettings === "function" ? options.readManagerSettings : () => ({});
  const diagnostic = typeof options.diagnostic === "function" ? options.diagnostic : () => {};
  const allAllowedWorkspaces = options.allAllowedWorkspaces;
  const runGitProcessImpl = typeof options.runGitProcess === "function" ? options.runGitProcess : runGitProcess;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const homedir = typeof options.homedir === "function" ? options.homedir : os.homedir;
  const pathInside = typeof options.pathInside === "function"
    ? options.pathInside
    : (child, parent) => {
        const relative = path.relative(path.resolve(parent), path.resolve(child));
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      };

  let repoScanCache = null;
  let repoScanPromise = null;
  const gitSummaryCache = new Map();
  const gitSummaryPromises = new Map();
  const githubRepoCache = new Map();

  function jsonFiles(dir) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => path.join(dir, entry.name));
    } catch {
      return [];
    }
  }

  function readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  function managerProjects() {
    const value = readJson(managerProjectsFile);
    return Array.isArray(value?.roots) ? value.roots.filter((root) => typeof root === "string") : [];
  }

  function saveManagerProjects(roots) {
    fs.mkdirSync(codexProHome, { recursive: true });
    fs.writeFileSync(managerProjectsFile, `${JSON.stringify({ version: 1, roots }, null, 2)}\n`, { mode: 0o600 });
  }

  function githubRepoFromRemote(remoteUrl) {
    const value = String(remoteUrl || "").trim().replace(/\\/g, "/");
    if (!value) return "";
    const match = value.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
    return match ? `${match[1]}/${match[2].replace(/\.git$/i, "")}` : "";
  }

  function repoIdentityFromRemote(remoteUrl) {
    const value = String(remoteUrl || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!value) return { officialName: "", repoFullName: "" };
    const githubRepo = githubRepoFromRemote(value);
    if (githubRepo) return { officialName: githubRepo.split("/").pop() || "", repoFullName: githubRepo };
    const withoutQuery = value.split(/[?#]/, 1)[0];
    const parts = withoutQuery.replace(/\.git$/i, "").split(/[/:]/).filter(Boolean);
    const officialName = parts.pop() || "";
    const owner = parts.pop() || "";
    return { officialName, repoFullName: owner ? `${owner}/${officialName}` : officialName };
  }

  async function githubRepoForRoot(root) {
    const normalizedRoot = path.resolve(String(root || ""));
    const cached = githubRepoCache.get(normalizedRoot.toLowerCase());
    if (cached && now() - cached.at < 15_000) return cached.value;
    let value = "";
    try {
      const remote = await runGitProcessImpl(["-C", normalizedRoot, "remote", "get-url", "origin"], { timeoutMs: 4_000 });
      value = githubRepoFromRemote(remote.stdout.trim());
    } catch {}
    githubRepoCache.set(normalizedRoot.toLowerCase(), { at: now(), value });
    return value;
  }

  async function readGitSummary(root) {
    try {
      const [statusResult, commitResult, remoteResult] = await Promise.allSettled([
        runGitProcessImpl(["-C", root, "status", "--porcelain=v2", "--branch"], { timeoutMs: 4_000, maxBuffer: 2 * 1024 * 1024 }),
        runGitProcessImpl(["-C", root, "log", "-1", "--pretty=format:%h%x09%s%x09%cI"], { timeoutMs: 4_000 }),
        runGitProcessImpl(["-C", root, "remote", "get-url", "origin"], { timeoutMs: 4_000 })
      ]);
      if (statusResult.status !== "fulfilled") throw statusResult.reason;
      if (commitResult.status !== "fulfilled") throw commitResult.reason;
      const statusLines = statusResult.value.stdout.split(/\r?\n/).filter(Boolean);
      const branchHead = statusLines.find((line) => line.startsWith("# branch.head "))?.slice(14).trim() || "";
      const upstream = statusLines.find((line) => line.startsWith("# branch.upstream "))?.slice(18).trim() || "";
      const branch = !branchHead || branchHead === "(detached)" ? "detached" : branchHead;
      const changes = statusLines.filter((line) => !line.startsWith("# ")).length;
      const branchAb = statusLines.find((line) => line.startsWith("# branch.ab "))?.slice(12).trim() || "";
      const branchAbMatch = branchAb.match(/^\+(\d+)\s+-(\d+)$/);
      const ahead = Number(branchAbMatch?.[1] || 0);
      const behind = Number(branchAbMatch?.[2] || 0);
      const worktreeLines = statusLines.filter((line) => !line.startsWith("# "));
      const untracked = worktreeLines.filter((line) => line.startsWith("? ")).length;
      const conflicted = worktreeLines.filter((line) => line.startsWith("u ")).length;
      const modified = worktreeLines.filter((line) => line.startsWith("1 ") || line.startsWith("2 ")).length;
      const commitText = commitResult.value.stdout;
      const remoteUrl = remoteResult.status === "fulfilled" ? remoteResult.value.stdout.trim() : "";
      let pushedAt = "";
      let remoteCommitAt = "";
      let remoteCommitHash = "";
      if (upstream) {
        const [remoteCommit, pushReflog] = await Promise.allSettled([
          runGitProcessImpl(["-C", root, "log", "-1", "--pretty=format:%h%x09%cI", upstream], { timeoutMs: 4_000 }),
          runGitProcessImpl(["-C", root, "reflog", "show", "-1", "--format=%gI", upstream], { timeoutMs: 4_000 })
        ]);
        if (remoteCommit.status === "fulfilled") {
          const [remoteHash = "", remoteDate = ""] = remoteCommit.value.stdout.trim().split("\t");
          remoteCommitHash = remoteHash;
          remoteCommitAt = remoteDate;
        }
        if (pushReflog.status === "fulfilled") pushedAt = pushReflog.value.stdout.trim();
      }
      const [hash = "", subject = "", date = ""] = commitText.trim().split("\t");
      const identity = repoIdentityFromRemote(remoteUrl);
      const latestActivity = [
        { kind: "commit", value: date, timestamp: Date.parse(date) || 0 },
        { kind: "push", value: pushedAt, timestamp: Date.parse(pushedAt) || 0 },
        { kind: "remote", value: remoteCommitAt, timestamp: Date.parse(remoteCommitAt) || 0 }
      ].sort((left, right) => right.timestamp - left.timestamp)[0];
      return {
        isGit: true,
        branch,
        changes,
        modified,
        untracked,
        conflicted,
        ahead,
        behind,
        commit: { hash, subject, date },
        remoteUrl,
        upstream,
        pushedAt,
        remoteCommitAt,
        remoteCommitHash,
        activityAt: latestActivity?.value || date,
        activityTimestamp: latestActivity?.timestamp || 0,
        activityKind: latestActivity?.kind || "commit",
        githubRepo: githubRepoFromRemote(remoteUrl),
        ...identity
      };
    } catch {
      return { isGit: false, branch: "", changes: 0, modified: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0, commit: null, remoteUrl: "", upstream: "", pushedAt: "", remoteCommitAt: "", remoteCommitHash: "", activityAt: "", activityTimestamp: 0, activityKind: "", githubRepo: "", officialName: "", repoFullName: "" };
    }
  }

  async function gitSummary(root) {
    const key = path.resolve(root).toLowerCase();
    const at = now();
    const cached = gitSummaryCache.get(key);
    if (cached && at - cached.at < GIT_SUMMARY_CACHE_MS) return cached.value;
    if (gitSummaryPromises.has(key)) return gitSummaryPromises.get(key);
    const promise = readGitSummary(root).then((value) => {
      gitSummaryCache.set(key, { at: now(), value });
      return value;
    });
    gitSummaryPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      if (gitSummaryPromises.get(key) === promise) gitSummaryPromises.delete(key);
    }
  }

  function pruneGitSummaryCache(liveRoots) {
    const at = now();
    for (const [key, cached] of gitSummaryCache) {
      if (!liveRoots.has(key) && at - cached.at > GIT_SUMMARY_CACHE_RETENTION_MS) gitSummaryCache.delete(key);
    }
  }

  function isInternalWorkspaceWorktree(root) {
    if (!root) return false;
    const resolved = path.resolve(root);
    return pathInside(resolved, path.join(codexProHome, "workspace-worktrees"))
      || pathInside(resolved, path.join(homedir(), ".codex", "worktrees"));
  }

  function repoScanRoots(config) {
    const home = homedir();
    const requested = [config.root, ...(config.allowedRoots || []), ...(config.allowHome ? [home] : [])]
      .filter(Boolean)
      .map((root) => path.resolve(root));
    const roots = new Set();
    for (const root of requested) {
      if (!fs.existsSync(root)) continue;
      const parsed = path.parse(root);
      if (root.toLowerCase() === parsed.root.toLowerCase() && parsed.root.toLowerCase() === path.parse(home).root.toLowerCase()) {
        roots.add(root);
        roots.add(home);
        continue;
      }
      roots.add(root);
    }
    for (const folder of ["Desktop", "Documents", "Downloads", "Pictures", "Videos"]) {
      const candidate = path.join(home, folder);
      if (requested.some((allowed) => pathInside(candidate, allowed)) && fs.existsSync(candidate)) roots.add(candidate);
    }
    return [...roots];
  }

  async function discoverGitRepositories(scanRoots) {
    const cacheKey = [...scanRoots].map((root) => path.resolve(root).toLowerCase()).sort().join("|");
    if (repoScanCache?.key === cacheKey && now() - repoScanCache.at < REPO_SCAN_CACHE_MS) return repoScanCache.roots;
    if (repoScanPromise?.key === cacheKey) return repoScanPromise.promise;
    const promise = (async () => {
      const started = now();
      const queue = scanRoots.map((root) => ({ root: path.resolve(root), depth: 0, insideRepository: false }));
      const visited = new Set();
      const repositories = new Set();
      let scanned = 0;
      while (queue.length && scanned < REPO_SCAN_MAX_DIRECTORIES && now() - started < REPO_SCAN_TIMEOUT_MS) {
        const batch = queue.splice(0, 32).filter((item) => {
          const key = item.root.toLowerCase();
          if (visited.has(key)) return false;
          visited.add(key);
          return true;
        });
        const entriesByRoot = await Promise.all(batch.map(async (item) => {
          try { return { item, entries: await fs.promises.readdir(item.root, { withFileTypes: true }) }; }
          catch { return { item, entries: [] }; }
        }));
        for (const { item, entries } of entriesByRoot) {
          scanned += 1;
          if (entries.some((entry) => entry.name.toLowerCase() === ".git" && (entry.isDirectory() || entry.isFile()))) {
            repositories.add(item.root);
            if (!item.insideRepository && item.depth < REPO_SCAN_MAX_DEPTH) {
              for (const entry of entries) {
                if (!entry.isDirectory() || entry.isSymbolicLink() || REPO_SCAN_SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
                queue.push({ root: path.join(item.root, entry.name), depth: item.depth + 1, insideRepository: true });
              }
            }
            continue;
          }
          if (item.insideRepository) continue;
          if (item.depth >= REPO_SCAN_MAX_DEPTH) continue;
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || REPO_SCAN_SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
            queue.push({ root: path.join(item.root, entry.name), depth: item.depth + 1, insideRepository: false });
          }
        }
      }
      const roots = [...repositories];
      repoScanCache = { key: cacheKey, at: now(), roots };
      return roots;
    })();
    repoScanPromise = { key: cacheKey, promise };
    try { return await promise; }
    finally { if (repoScanPromise?.promise === promise) repoScanPromise = null; }
  }

  async function listProjects() {
    const startedAt = now();
    const taskConfig = await readTaskConfig();
    const activeRoot = taskConfig.root;
    const selectedRoots = new Set(Object.values(readManagerSettings().repoSelections || {})
      .filter((root) => typeof root === "string" && root.trim() && root !== allAllowedWorkspaces)
      .map((root) => path.resolve(root).toLowerCase()));
    const sources = new Map();
    const addSource = (root, source) => {
      if (typeof root !== "string" || !root.trim()) return;
      const resolved = path.resolve(root);
      if (isInternalWorkspaceWorktree(resolved)) return;
      sources.set(resolved, source);
    };
    for (const file of jsonFiles(path.join(codexProHome, "profiles"))) {
      const profile = readJson(file);
      addSource(profile?.root, "CodexPro profile");
    }
    for (const file of jsonFiles(path.join(codexProHome, "runtime"))) {
      const runtime = readJson(file);
      addSource(runtime?.root, "CodexPro runtime");
    }
    for (const root of managerProjects()) {
      const resolved = path.resolve(root);
      addSource(resolved, sources.get(resolved) || "Đã thêm");
    }
    addSource(activeRoot, "Đang chạy");
    const discoveryStartedAt = now();
    const discoveredRoots = await discoverGitRepositories(repoScanRoots(taskConfig));
    const discoveryMs = now() - discoveryStartedAt;
    for (const root of discoveredRoots) {
      const resolved = path.resolve(root);
      if (isInternalWorkspaceWorktree(resolved)) continue;
      if (![...sources.keys()].some((known) => known.toLowerCase() === resolved.toLowerCase())) sources.set(resolved, "Tự quét");
    }

    const entries = [...sources];
    pruneGitSummaryCache(new Set([...sources.keys()].map((root) => path.resolve(root).toLowerCase())));
    const projects = [];
    let nextIndex = 0;
    const summariesStartedAt = now();
    await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
      while (nextIndex < entries.length) {
        const [root, source] = entries[nextIndex++];
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
        const summary = await gitSummary(root);
        const localName = path.basename(root);
        projects.push({
          root,
          localName,
          name: summary.officialName || localName,
          source,
          active: Boolean(activeRoot && path.resolve(activeRoot).toLowerCase() === root.toLowerCase()),
          inUse: selectedRoots.has(path.resolve(root).toLowerCase()),
          ...summary
        });
      }
    }));
    const summariesMs = now() - summariesStartedAt;
    const totalMs = now() - startedAt;
    if (totalMs >= 2_000) {
      diagnostic("warn", "manager", "projects", `list-projects phase breakdown (${totalMs} ms)`, {
        action: "list-projects-breakdown",
        total_ms: totalMs,
        discovery_ms: discoveryMs,
        summaries_ms: summariesMs,
        project_count: projects.length,
        discovered_count: discoveredRoots.length
      });
    }
    return projects.sort((a, b) =>
      Number(Boolean(b.active || b.inUse)) - Number(Boolean(a.active || a.inUse))
      || Number(b.activityTimestamp || 0) - Number(a.activityTimestamp || 0)
      || Number(b.changes > 0) - Number(a.changes > 0)
      || a.name.localeCompare(b.name)
    );
  }

  return {
    jsonFiles,
    readJson,
    managerProjects,
    saveManagerProjects,
    githubRepoFromRemote,
    repoIdentityFromRemote,
    githubRepoForRoot,
    readGitSummary,
    gitSummary,
    pruneGitSummaryCache,
    pathInside,
    isInternalWorkspaceWorktree,
    repoScanRoots,
    discoverGitRepositories,
    listProjects
  };
}
