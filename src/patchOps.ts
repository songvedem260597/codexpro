import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { CodexProError, PathGuard, type Workspace } from "./guard.js";
import { withFileWriteLocks } from "./fsOps.js";
import { runGitProcess } from "./processOps.js";
import { redactSensitiveText } from "./redact.js";

function diffStats(diff: string): { additions: number; deletions: number; changed: boolean } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions, changed: Boolean(diff.trim()) };
}

export function decodeGitQuotedPath(pathText: string): string {
  const input = pathText.startsWith('"') && pathText.endsWith('"') ? pathText.slice(1, -1) : pathText;
  let decoded = "";
  let escapedBytes: number[] = [];
  const flushEscapedBytes = () => {
    if (!escapedBytes.length) return;
    decoded += Buffer.from(escapedBytes).toString("utf8");
    escapedBytes = [];
  };
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char !== "\\") {
      flushEscapedBytes();
      decoded += char;
      continue;
    }
    i += 1;
    const escaped = input[i];
    if (escaped === undefined) throw new CodexProError(`Invalid quoted Git path: ${pathText}`);
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      for (let j = 0; j < 2 && i + 1 < input.length && /[0-7]/.test(input[i + 1]); j += 1) {
        i += 1;
        octal += input[i];
      }
      escapedBytes.push(Number.parseInt(octal, 8));
    } else {
      flushEscapedBytes();
      decoded += ({ a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" } as Record<string, string>)[escaped] ?? escaped;
    }
  }
  flushEscapedBytes();
  return decoded;
}

function stripPatchPathComponents(filePath: string, stripComponents: number): string {
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) return filePath;
  let stripped = filePath;
  for (let i = 0; i < stripComponents; i += 1) {
    const slash = stripped.indexOf("/");
    if (slash < 0) return stripped;
    stripped = stripped.slice(slash + 1);
  }
  return stripped;
}

function normalizePatchPath(rawPath: string, stripComponents = 1): string | undefined {
  const raw = rawPath.trim().split("\t")[0]?.trim();
  if (!raw || raw === "/dev/null") return undefined;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? decodeGitQuotedPath(raw.slice(1, -1)) : raw;
  return stripPatchPathComponents(unquoted, stripComponents);
}

function patchHasSymlinkMode(patch: string): boolean {
  return patch.split(/\r?\n/).some((line) => /^(?:new|old|deleted) file mode 120000\s*$/.test(line) || /^new mode 120000\s*$/.test(line) || /^old mode 120000\s*$/.test(line));
}

export function patchTouchedPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const normalized = normalizePatchPath(line.slice(4));
      if (normalized) paths.add(normalized);
    } else if (line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("copy from ") || line.startsWith("copy to ")) {
      const normalized = normalizePatchPath(line.replace(/^(?:rename|copy) (?:from|to) /, ""), 0);
      if (normalized) paths.add(normalized);
    }
  }
  return [...paths];
}

export async function applyWorkspacePatch(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  patch: string,
  assertWriteAllowed: (relativePath: string) => void
): Promise<{ paths: string[]; stdout: string; stderr: string; diff: string; additions: number; deletions: number; changed: boolean }> {
  if (!patch.trim()) throw new CodexProError("patch is required.");
  if (Buffer.byteLength(patch, "utf8") > config.maxWriteBytes) {
    throw new CodexProError(`Patch is too large. Limit: ${config.maxWriteBytes} bytes.`);
  }
  if (patchHasSymlinkMode(patch)) {
    throw new CodexProError("Symlink patches are blocked from apply_patch.");
  }

  const paths = patchTouchedPaths(patch);
  if (!paths.length) throw new CodexProError("Patch must include at least one file path.");
  const absPaths: string[] = [];
  for (const touchedPath of paths) {
    absPaths.push(guard.resolve(workspace, touchedPath, { forWrite: true }).absPath);
    assertWriteAllowed(touchedPath);
  }

  return withFileWriteLocks(absPaths, async () => {
    for (const touchedPath of paths) {
      guard.resolve(workspace, touchedPath, { forWrite: true });
      assertWriteAllowed(touchedPath);
    }

    const check = await runGitProcess(workspace.root, ["apply", "--check", "--whitespace=nowarn"], {
      cwd: workspace.root,
      input: patch,
      encoding: "utf8",
      maxBuffer: config.maxOutputBytes,
      env: { ...process.env, NO_COLOR: "1" }
    });
    if (check.status !== 0) {
      throw new CodexProError(redactSensitiveText(check.stderr.trim() || check.stdout.trim() || "git apply --check failed"));
    }

    const applied = await runGitProcess(workspace.root, ["apply", "--whitespace=nowarn"], {
      cwd: workspace.root,
      input: patch,
      encoding: "utf8",
      maxBuffer: config.maxOutputBytes,
      env: { ...process.env, NO_COLOR: "1" }
    });
    if (applied.status !== 0) {
      throw new CodexProError(redactSensitiveText(applied.stderr.trim() || applied.stdout.trim() || "git apply failed"));
    }

    const diff = redactSensitiveText(patch.trimEnd());
    const stats = diffStats(diff);
    return {
      paths,
      stdout: redactSensitiveText(applied.stdout?.trim() || ""),
      stderr: redactSensitiveText(applied.stderr?.trim() || ""),
      diff,
      additions: stats.additions,
      deletions: stats.deletions,
      changed: true
    };
  });
}
