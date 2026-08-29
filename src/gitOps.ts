import { execFile } from "node:child_process";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

function runGit(workspace: Workspace, args: string[], maxOutputBytes: number): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd: workspace.root,
      encoding: "utf8",
      maxBuffer: maxOutputBytes,
      env: { ...process.env, NO_COLOR: "1" }
    }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve(`git unavailable or failed: ${error.message}`);
          return;
        }
        const failureText = String(stderr || "").trim() || String(stdout || "").trim();
        if (failureText) {
          resolve(redactSensitiveText(failureText));
          return;
        }
        resolve(`git unavailable or failed: ${error.message}`);
        return;
      }
      resolve(redactSensitiveText(String(stdout || "").trim() || "(no output)"));
    });
  });
}

function isGitFailure(output: string): boolean {
  const trimmed = output.trim().toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    trimmed.includes("not a git repository")
  );
}

function outputLines(output: string): string[] {
  return output.trim() === "(no output)" ? [] : output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function gitStatus(config: CodexProConfig, workspace: Workspace, guard?: PathGuard, filePath?: string, staged = false): Promise<string> {
  const args = staged ? ["diff", "--cached", "--name-status"] : ["status", "--short", "--branch"];
  if (filePath?.trim()) {
    if (!guard) return Promise.resolve("path-scoped git status requires a path guard");
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes);
}

export function gitDiff(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): Promise<string> {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (staged) args.push("--staged");
  if (filePath?.trim()) {
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes);
}

export async function gitDiffStatus(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): Promise<string> {
  const args = ["diff", "--name-status"];
  if (staged) args.push("--staged");
  const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
  if (filePath?.trim()) {
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
    untrackedArgs.push("--", resolved.relPath);
  }
  const diffStatus = await runGit(workspace, args, config.maxOutputBytes);
  if (staged || isGitFailure(diffStatus)) return diffStatus;
  const untracked = await runGit(workspace, untrackedArgs, config.maxOutputBytes);
  if (isGitFailure(untracked)) return diffStatus;
  const lines = [...outputLines(diffStatus), ...outputLines(untracked).map((line) => `?? ${line}`)];
  return lines.length ? lines.join("\n") : "(no output)";
}

export function gitLog(config: CodexProConfig, workspace: Workspace, maxCount = 8): Promise<string> {
  const count = Math.max(1, Math.min(Math.floor(maxCount), 30));
  return runGit(workspace, ["log", `--max-count=${count}`, "--oneline", "--decorate"], config.maxOutputBytes);
}

export function assertGitCleanEnoughForWrite(_workspace: Workspace): void {
  // Reserved for future policy hooks. The first version allows writes and returns diffs.
  return;
}
