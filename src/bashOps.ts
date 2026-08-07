import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export interface BashResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  bashSessionId?: string;
}

type SafeGitWrite =
  | { kind: "add"; args: string[] }
  | { kind: "commit"; message: string }
  | { kind: "push"; branch: string };

interface DirectInvocation {
  executable: string;
  args: string[];
  cleanupDir?: string;
}

const SAFE_NPX_INVOCATIONS = new Map<string, string[]>([
  ["npx vite build", ["vite", "build"]],
  ["npx tsc --noEmit", ["tsc", "--noEmit"]],
  ["npx vitest run", ["vitest", "run"]],
  ["npx jest --runInBand", ["jest", "--runInBand"]],
  ["npx eslint .", ["eslint", "."]],
  ["npx prettier --check .", ["prettier", "--check", "."]],
  ["npx biome check .", ["biome", "check", "."]],
  ["npx next build", ["next", "build"]],
  ["npx astro build", ["astro", "build"]],
  ["npx webpack --mode production", ["webpack", "--mode", "production"]],
  ["npx electron-builder --version", ["electron-builder", "--version"]],
  ["npx electron-builder", ["electron-builder"]],
  ["npx electron-builder --dir", ["electron-builder", "--dir"]],
  ["npx electron-builder --win", ["electron-builder", "--win"]],
  ["npx electron-builder --win nsis", ["electron-builder", "--win", "nsis"]]
]);

const SAFE_ALLOWED_PREFIXES = [
  "pwd",
  "ls",
  "find",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "git blame",
  "git grep",
  "git describe",
  "git remote -v",
  "git tag --list",
  "git worktree list",
  "git submodule status",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "npm run check",
  "pnpm test",
  "pnpm run test",
  "pnpm run typecheck",
  "pnpm run lint",
  "pnpm run build",
  "pnpm run check",
  "yarn test",
  "yarn run test",
  "yarn run typecheck",
  "yarn run lint",
  "yarn run build",
  "yarn run check",
  "bun test",
  "bun run test",
  "bun run typecheck",
  "bun run lint",
  "bun run build",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "uv run pytest",
  "go test",
  "go build",
  "go vet",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "cargo build",
  "cargo fmt --check",
  "python -m compileall",
  "python3 -m compileall",
  "ruff check",
  "mypy",
  "black --check",
  "dotnet build",
  "dotnet test",
  "dotnet format --verify-no-changes",
  "cmake --build",
  "ninja -C build",
  "mvn test",
  "mvn package",
  "mvn verify",
  "./mvnw test",
  "./mvnw package",
  "./mvnw verify",
  "./gradlew test",
  "./gradlew build",
  "tsc",
  "npx tsc",
  "npx vite build",
  "eslint",
  "npx eslint",
  "biome check",
  "npx biome check"
];

const SAFE_BLOCKED_PATTERNS = [
  /(^|\s)rm\s+/,
  /(^|\s)mv\s+/,
  /(^|\s)cp\s+/,
  /(^|\s)dd\s+/,
  /(^|\s)sudo\s+/,
  /(^|\s)chmod\s+/,
  /(^|\s)chown\s+/,
  /(^|\s)kill\s+/,
  /(^|\s)pkill\s+/,
  /(^|\s)curl\s+/,
  /(^|\s)wget\s+/,
  /(^|\s)ssh\s+/,
  /(^|\s)scp\s+/,
  /(^|\s)rsync\s+/,
  /(^|\s)docker\s+/,
  /(^|\s)podman\s+/,
  /(^|\s)git\s+push\b/,
  /(^|\s)git\s+reset\b/,
  /(^|\s)git\s+clean\b/,
  /(^|\s)git\s+checkout\b/,
  /(^|\s)git\s+switch\b/,
  /(^|\s)git\s+restore\b/,
  /(^|\s)(npm|pnpm|yarn)\s+publish\b/,
  /(^|\s)--no-index\b/,
  /(^|\s)--fix\b/,
  /(^|\s)(\/|~(?:\/|\s|$))/,
  /(^|\s)\.\.(?:\/|\s|$)/,
  /\$/,
  /(^|[\s:])(?:\.env(?:[./\s:]|$)|\.git(?:[\/\s:]|$)|node_modules(?:[\/\s:]|$)|\.ssh(?:[\/\s:]|$)|id_rsa(?:[.\s:]|$)|id_ed25519(?:[.\s:]|$)|[^\s:]*\.(?:pem|key)(?:[\s:]|$))/,
  /(^|\s)['"]?-exec(?:['"]|\s|$)/,
  /(^|\s)['"]?-execdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-delete(?:['"]|\s|$)/,
  /(^|\s)['"]?-ok(?:['"]|\s|$)/,
  /(^|\s)['"]?-okdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprint0?(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprintf(?:['"]|\s|$)/,
  /(^|\s)['"]?-fls(?:['"]|\s|$)/,
  /(^|\s)['"]?--output(?:=|['"]|\s|$)/,
  /(^|\s)(sed|perl)\s+.*(^|\s)-i(\s|$)/,
  /(^|\s)(cat|grep|rg|head|tail|wc)\s+/,
  /[;&|<>`]/,
  /[\r\n]/
];

const WINDOWS_SAFE_ALLOWED_PATTERNS = [
  /^(?:Get-Location|pwd)$/i,
  /^(?:Get-ChildItem|Get-Content|Get-Item|Test-Path|Resolve-Path|Get-FileHash|Select-String|Measure-Object|Sort-Object)(?:\s+.+)?$/i,
  /^git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|blame|grep|describe)(?:\s+.+)?$/i,
  /^git\s+(?:remote\s+-v|tag\s+--list|worktree\s+list|submodule\s+status)$/i,
  /^(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:test|run\s+(?:test|typecheck|lint|build|check|format|coverage)(?::[A-Za-z0-9._-]+)*)(?:\s+--\s+[A-Za-z0-9._:= -]+)?$/i,
  /^(?:npm(?:\.cmd)?\s+(?:ci|install)\s+--ignore-scripts(?:\s+--no-audit)?(?:\s+--no-fund)?|pnpm(?:\.cmd)?\s+install\s+--ignore-scripts\s+--frozen-lockfile|yarn(?:\.cmd)?\s+install\s+--ignore-scripts\s+--frozen-lockfile|bun(?:\.exe)?\s+install\s+--ignore-scripts\s+--frozen-lockfile)$/i,
  /^(?:npx\s+(?:vite\s+build|tsc\s+--noEmit|vitest\s+run|jest\s+--runInBand|eslint\s+\.|prettier\s+--check\s+\.|biome\s+check\s+\.|next\s+build|astro\s+build|webpack\s+--mode\s+production|electron-builder(?:\s+(?:--version|--dir|--win(?:\s+nsis)?))?))$/i,
  /^(?:pytest|python\s+-m\s+pytest|py\s+-m\s+pytest)(?:\s+[A-Za-z0-9._=\\\/-]+)*$/i,
  /^(?:python|py)\s+-m\s+(?:venv\s+\.venv|compileall\s+\.)$/i,
  /^(?:ruff\s+check\s+\.|mypy\s+\.|black\s+--check\s+\.)$/i,
  /^go\s+(?:test|build|vet)\s+\.\/\.\.\.$/i,
  /^cargo\s+(?:test|check|clippy|build)(?:\s+--(?:release|all-targets|all-features))*$/i,
  /^cargo\s+fmt\s+--check$/i,
  /^dotnet\s+(?:build|test)(?:\s+--no-restore)?$/i,
  /^dotnet\s+format\s+--verify-no-changes$/i,
  /^cmake\s+--build\s+(?:build|\.)$/i,
  /^ninja\s+-C\s+build$/i,
  /^(?:mvn|\.\\mvnw\.cmd)\s+(?:test|package|verify)$/i,
  /^\.\\gradlew\.bat\s+(?:test|build)$/i,
  /^(?:python|py|node|npm|pnpm|yarn|bun|pip|go|rustc|cargo|java|dotnet|cmake|ninja)\s+(?:--version|-v|version|--info)$/i,
  /^nvidia-smi(?:\s+.+)?$/i
];

function compact(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function simpleCommandTokens(command: string): string[] | undefined {
  const tokens: string[] = [];
  const tokenPattern = /\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"';&|<>`\r\n]+))/y;
  let offset = 0;
  while (offset < command.length) {
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(command);
    if (!match) return undefined;
    tokens.push(match[1] ?? match[2] ?? match[3]);
    offset = tokenPattern.lastIndex;
  }
  return tokens;
}

function isSensitiveGitPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized === "." || /[*?\[\]]/.test(normalized) || normalized.startsWith(":") || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || normalized.startsWith("//")) return true;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".git" || segment === "node_modules" || segment === ".ssh" || segment === ".env" || segment.startsWith(".env."))) return true;
  return /\.(?:pem|key)$/i.test(segments.at(-1) ?? "");
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function parseSafeGitWrite(command: string): SafeGitWrite | undefined {
  const tokens = simpleCommandTokens(command.trim());
  if (!tokens || tokens[0]?.toLowerCase() !== "git") return undefined;
  const operation = tokens[1]?.toLowerCase();

  if (operation === "add") {
    const args = tokens.slice(2);
    if (!args.length) return undefined;
    for (const arg of args) {
      if (arg.startsWith("-") || isSensitiveGitPath(arg)) return undefined;
    }
    return { kind: "add", args };
  }

  if (operation === "commit" && tokens.length === 4 && tokens[2] === "-m") {
    const message = tokens[3];
    if (message.length >= 1 && message.length <= 200 && !/[\r\n]/.test(message)) return { kind: "commit", message };
    return undefined;
  }

  if (operation === "push" && tokens.length === 4 && tokens[2].toLowerCase() === "origin") {
    const branch = tokens[3];
    const validShape = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/.test(branch);
    if (validShape && !branch.includes("..") && !branch.includes("@{") && !branch.endsWith(".") && !branch.endsWith("/") && !branch.includes("//") && !branch.includes("\\")) {
      return { kind: "push", branch };
    }
  }

  return undefined;
}

function emptyGitHooksDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-empty-git-hooks-"));
}

function assertExplicitGitFiles(args: string[], cwd: string, workspaceRoot: string): void {
  const realWorkspace = fs.realpathSync(workspaceRoot);
  for (const arg of args) {
    const candidate = path.resolve(cwd, arg);
    let stat: fs.Stats;
    let realCandidate: string;
    try {
      stat = fs.lstatSync(candidate);
      realCandidate = fs.realpathSync(candidate);
    } catch {
      throw new CodexProError(`Safe git add requires an existing explicit file: ${arg}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || !isPathInside(realWorkspace, realCandidate)) {
      throw new CodexProError(`Safe git add is restricted to explicit non-symlink files inside the workspace: ${arg}`);
    }
  }
}

function safeLocalRemoteUrl(remoteUrl: string, workspaceRoot: string): boolean {
  let candidate: string;
  try {
    candidate = remoteUrl.startsWith("file://") ? fileURLToPath(remoteUrl) : path.resolve(workspaceRoot, remoteUrl);
  } catch {
    return false;
  }
  try {
    return isPathInside(fs.realpathSync(workspaceRoot), fs.realpathSync(candidate));
  } catch {
    return false;
  }
}

function assertSafePushTarget(executable: string, branch: string, cwd: string, workspaceRoot: string): void {
  const branchCheck = spawnSync(executable, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd, windowsHide: true });
  if (branchCheck.status !== 0) throw new CodexProError(`Safe git push requires an existing local branch: ${branch}`);

  const remoteCheck = spawnSync(executable, ["remote", "get-url", "--all", "--push", "origin"], { cwd, encoding: "utf8", windowsHide: true });
  const remoteUrls = String(remoteCheck.stdout ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (remoteCheck.status !== 0 || !remoteUrls.length || remoteUrls.some((remoteUrl) => !/^https:\/\//i.test(remoteUrl) && !safeLocalRemoteUrl(remoteUrl, workspaceRoot))) {
    throw new CodexProError("Safe git push requires origin to use HTTPS or a local remote contained inside the workspace.");
  }
}

function directGitInvocation(command: SafeGitWrite, cwd: string, workspaceRoot: string): DirectInvocation {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  if (command.kind === "add") {
    assertExplicitGitFiles(command.args, cwd, workspaceRoot);
    return { executable, args: ["add", ...command.args] };
  }
  if (command.kind === "push") {
    assertSafePushTarget(executable, command.branch, cwd, workspaceRoot);
    const hooksDir = emptyGitHooksDir();
    return { executable, args: ["-c", `core.hooksPath=${hooksDir}`, "push", "origin", command.branch], cleanupDir: hooksDir };
  }

  const hooksDir = emptyGitHooksDir();
  return {
    executable,
    args: ["-c", `core.hooksPath=${hooksDir}`, "commit", "--no-gpg-sign", "--no-verify", "-m", command.message],
    cleanupDir: hooksDir
  };
}

function directPackageInvocation(command: string): DirectInvocation | undefined {
  const tokens = simpleCommandTokens(command.trim());
  const normalized = compact(command);
  const safeNpxArgs = SAFE_NPX_INVOCATIONS.get(normalized);
  if (safeNpxArgs) {
    if (process.platform === "win32") {
      return {
        executable: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", ["npx.cmd", "--no-install", ...safeNpxArgs].join(" ")]
      };
    }
    return { executable: "npx", args: ["--no-install", ...safeNpxArgs] };
  }
  if (!tokens || !/^(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?$/.test(tokens[0])) return undefined;
  const manager = tokens[0].replace(/\.(?:cmd|exe)$/i, "");
  const args = tokens.slice(1);
  const isTest = args.length === 1 && args[0] === "test";
  const isAllowedRun =
    args[0] === "run" &&
    /^(?:test|typecheck|lint|build|check|format|coverage)(?::[A-Za-z0-9._-]+)*$/.test(args[1] ?? "") &&
    (args.length === 2 || (args[2] === "--" && args.slice(3).every((arg) => /^[A-Za-z0-9._:=/-]+$/.test(arg))));
  const isSafeInstall = isAllowedPackageInstall(normalized);
  if (!isTest && !isAllowedRun && !isSafeInstall) return undefined;

  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", [`${manager}.cmd`, ...args].join(" ")]
    };
  }
  return { executable: manager, args };
}

function startsWithAllowedPrefix(command: string): boolean {
  const normalized = compact(command);
  return SAFE_NPX_INVOCATIONS.has(normalized) || isAllowedPackageInstall(normalized) || isAllowedPackageScript(normalized) || SAFE_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

function isAllowedPackageScript(command: string): boolean {
  const packageScriptPattern =
    /^(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+run\s+(?:test|typecheck|lint|build|check|format|coverage)(?::[A-Za-z0-9._-]+)*(?:\s+--\s+[A-Za-z0-9._:= -]+)?$/;
  return packageScriptPattern.test(command);
}

function isAllowedPackageInstall(command: string): boolean {
  return /^(?:npm(?:\.cmd)?\s+(?:ci|install)\s+--ignore-scripts(?:\s+--no-audit)?(?:\s+--no-fund)?|pnpm(?:\.cmd)?\s+install\s+--ignore-scripts\s+--frozen-lockfile|yarn(?:\.cmd)?\s+install\s+--ignore-scripts\s+--frozen-lockfile|bun(?:\.exe)?\s+install\s+--ignore-scripts\s+--frozen-lockfile)$/.test(command);
}

function assertSafePowerShellCommand(command: string): void {
  const raw = command.trim();
  const normalized = compact(command);
  const blockedSyntax = /[\r\n;&|<>`$]/;
  const outsideWorkspacePath = /(?:^|\s|['"])(?:[A-Za-z]:[\\/]|\\\\|\.\.(?:[\\/]|\s|$)|~(?:[\\/]|\s|$))/;
  const windowsProvider = /(?:Registry::|Cert:|Env:|Variable:|Function:|Alias:|HKLM:|HKCU:|HKCR:|HKU:|HKCC:)/i;
  const sensitivePath = /(?:^|[\s:])(?:\.env(?:[.\\/\s:]|$)|\.git(?:[\\/\s:]|$)|node_modules(?:[\\/\s:]|$)|\.ssh(?:[\\/\s:]|$)|id_rsa(?:[.\s:]|$)|id_ed25519(?:[.\s:]|$)|[^\s:]*\.(?:pem|key)(?:[\s:]|$))/i;
  const outputOption = /(?:^|\s)["']?--output(?:=|["']|\s|$)/i;
  if (blockedSyntax.test(raw) || outsideWorkspacePath.test(raw) || windowsProvider.test(raw) || sensitivePath.test(normalized) || outputOption.test(normalized)) {
    throw new CodexProError(
      `Command is blocked by the Windows-safe PowerShell policy: ${normalized}\n` +
        "Use one simple command at a time, use a workspace-relative path, and do not use pipelines, redirects, variables, providers, or command chaining."
    );
  }
  if (!WINDOWS_SAFE_ALLOWED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new CodexProError(
      `Command is blocked because it is not in the Windows-safe PowerShell allowlist: ${normalized}\n` +
        "Allowed categories: workspace inspection, safe Git reads/writes, tests/build/lint, and version or GPU checks."
    );
  }
}

function assertSafeCommand(config: CodexProConfig, command: string): void {
  if (config.bashMode === "off") {
    throw new CodexProError("bash tool is disabled. Start with CODEXPRO_BASH_MODE=safe or CODEXPRO_BASH_MODE=full to enable it.");
  }
  if (config.bashMode === "full") return;

  const raw = command.trim();
  const normalized = compact(command);
  if (parseSafeGitWrite(normalized)) return;
  if (process.platform === "win32") {
    assertSafePowerShellCommand(command);
    return;
  }
  for (const pattern of SAFE_BLOCKED_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) {
      throw new CodexProError(
        `Command is blocked in CODEXPRO_BASH_MODE=safe: ${normalized}\n` +
          "Use separate read/search/git tools, or restart with CODEXPRO_BASH_MODE=full only for trusted repos."
      );
    }
  }
  if (!startsWithAllowedPrefix(normalized)) {
    throw new CodexProError(
      `Command is not in the safe bash allowlist: ${normalized}\n` +
        "Allowed examples: ls, find, git status, git diff, git add, git commit -m, git push origin <branch>, npm test, npm run typecheck, npm run build:clients, pytest, go test, cargo test. Use read/search tools for file contents. " +
        "Use CODEXPRO_BASH_MODE=full for trusted local automation."
    );
  }
}

function assertBashSession(config: CodexProConfig, sessionId?: string): string | undefined {
  const requested = sessionId?.trim();
  if (!config.bashSessionId) {
    if (config.requireBashSession) {
      throw new CodexProError("bash session guard is enabled but no server bash session id is configured.");
    }
    return undefined;
  }
  if (!requested) {
    if (config.requireBashSession) {
      throw new CodexProError(`bash session id is required. Retry with session_id="${config.bashSessionId}".`);
    }
    return config.bashSessionId;
  }
  if (requested !== config.bashSessionId) {
    throw new CodexProError(`bash session id mismatch. This CodexPro server accepts session_id="${config.bashSessionId}".`);
  }
  return config.bashSessionId;
}

function makeEnv(config: CodexProConfig): NodeJS.ProcessEnv {
  if (config.inheritEnv) {
    return { ...process.env, NO_COLOR: "1", CI: process.env.CI ?? "1" };
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    SHELL: process.env.SHELL ?? "/bin/bash",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1"
  };
  if (process.platform === "win32") {
    const requiredWindowsKeys = [
      "SystemRoot",
      "WINDIR",
      "ComSpec",
      "PATHEXT",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "LOCALAPPDATA",
      "APPDATA",
      "ProgramData",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "ProgramW6432",
      "PSModulePath"
    ];
    for (const key of requiredWindowsKeys) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

function shellExecutable(): string {
  if (process.platform === "win32") return process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
  return fs.existsSync("/bin/bash") ? "/bin/bash" : "bash";
}

function shellArgs(command: string): string[] {
  if (process.platform === "win32") {
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    return ["/d", "/s", "/c", `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encoded}`];
  }
  return ["-lc", command];
}

function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const sliced = buffer.subarray(0, maxBytes).toString("utf8");
  return { value: `${sliced}\n...[output truncated to ${maxBytes} bytes]`, truncated: true };
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // Windows does not provide Unix-style cooperative signals to process trees.
    // Force the full tree while the parent PID still identifies its descendants;
    // otherwise the shell can exit first and orphan an output-heavy grandchild.
    const args = ["/pid", String(child.pid), "/t", "/f"];
    const result = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    if (result.status !== 0) child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

export async function runBash(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  command: string,
  options: { cwd?: string; timeoutMs?: number; sessionId?: string } = {}
): Promise<BashResult> {
  if (!command?.trim()) throw new CodexProError("command is required.");
  const bashSessionId = assertBashSession(config, options.sessionId);
  assertSafeCommand(config, command);
  const cwdResolved = guard.resolve(workspace, options.cwd ?? ".");
  const cwd = cwdResolved.absPath;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 180_000));
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const safeGitWrite = parseSafeGitWrite(command);
    const directInvocation = safeGitWrite ? directGitInvocation(safeGitWrite, cwd, workspace.root) : directPackageInvocation(command);
    const child = spawn(directInvocation?.executable ?? shellExecutable(), directInvocation?.args ?? shellArgs(command), {
      cwd,
      env: makeEnv(config),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    let closed = false;
    let terminationStarted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let observedOutputBytes = 0;
    const retainedOutputBytes = config.maxOutputBytes + 1;
    let cleanupComplete = false;

    const cleanup = () => {
      if (cleanupComplete) return;
      cleanupComplete = true;
      if (directInvocation?.cleanupDir) fs.rmSync(directInvocation.cleanupDir, { recursive: true, force: true });
    };

    const terminate = (signal: NodeJS.Signals) => {
      if (closed) return;
      terminationStarted = true;
      terminateProcessTree(child, signal);
    };
    const terminateWithEscalation = () => {
      if (terminationStarted || closed) return;
      terminate("SIGTERM");
      killTimer = setTimeout(() => terminate("SIGKILL"), 1_500);
      killTimer.unref();
    };
    const appendBounded = (current: string, chunk: unknown) => {
      const bytes = Buffer.from(String(chunk), "utf8");
      observedOutputBytes += bytes.byteLength;
      const remaining = retainedOutputBytes - Buffer.byteLength(stdout, "utf8") - Buffer.byteLength(stderr, "utf8");
      if (remaining <= 0) return current;
      return current + bytes.subarray(0, remaining).toString("utf8");
    };

    const timer = setTimeout(() => {
      killedByTimeout = true;
      terminateWithEscalation();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
      if (observedOutputBytes > config.maxOutputBytes) terminateWithEscalation();
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
      if (observedOutputBytes > config.maxOutputBytes) terminateWithEscalation();
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      closed = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      cleanup();
      if (killedByTimeout) {
        stderr += `\n[codexpro] Command timed out after ${timeoutMs} ms.`;
      }
      const out = trimOutput(redactSensitiveText(stdout), config.maxOutputBytes);
      const err = trimOutput(redactSensitiveText(stderr), config.maxOutputBytes);
      resolve({
        command,
        cwd: path.relative(workspace.root, cwd) || ".",
        exitCode,
        signal,
        durationMs: Date.now() - start,
        stdout: out.value,
        stderr: err.value,
        truncated: out.truncated || err.truncated,
        ...(bashSessionId ? { bashSessionId } : {})
      });
    });
  });
}
