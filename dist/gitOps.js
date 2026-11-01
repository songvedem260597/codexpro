import { execFile } from "node:child_process";
import { redactSensitiveText } from "./redact.js";
function runGit(workspace, args, maxOutputBytes) {
    return new Promise((resolve) => {
        execFile("git", args, {
            cwd: workspace.root,
            encoding: "utf8",
            maxBuffer: maxOutputBytes,
            env: { ...process.env, NO_COLOR: "1" }
        }, (error, stdout, stderr) => {
            if (error) {
                if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
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
function isGitFailure(output) {
    const trimmed = output.trim().toLowerCase();
    return (trimmed.startsWith("fatal:") ||
        trimmed.startsWith("error:") ||
        trimmed.startsWith("git unavailable or failed:") ||
        trimmed.startsWith("git exited with status") ||
        trimmed.startsWith("usage: git ") ||
        trimmed.includes("not a git repository"));
}
function outputLines(output) {
    return output.trim() === "(no output)" ? [] : output.split("\n").map((line) => line.trim()).filter(Boolean);
}
export function gitStatus(config, workspace, guard, filePath, staged = false) {
    const args = staged ? ["diff", "--cached", "--name-status"] : ["status", "--short", "--branch"];
    if (filePath?.trim()) {
        if (!guard)
            return Promise.resolve("path-scoped git status requires a path guard");
        const resolved = guard.resolve(workspace, filePath);
        args.push("--", resolved.relPath);
    }
    return runGit(workspace, args, config.maxOutputBytes);
}
export function gitDiff(config, guard, workspace, filePath, staged = false) {
    const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
    if (staged)
        args.push("--staged");
    if (filePath?.trim()) {
        const resolved = guard.resolve(workspace, filePath);
        args.push("--", resolved.relPath);
    }
    return runGit(workspace, args, config.maxOutputBytes);
}
export async function gitDiffStatus(config, guard, workspace, filePath, staged = false) {
    const args = ["diff", "--name-status"];
    if (staged)
        args.push("--staged");
    const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
    if (filePath?.trim()) {
        const resolved = guard.resolve(workspace, filePath);
        args.push("--", resolved.relPath);
        untrackedArgs.push("--", resolved.relPath);
    }
    const diffStatus = await runGit(workspace, args, config.maxOutputBytes);
    if (staged || isGitFailure(diffStatus))
        return diffStatus;
    const untracked = await runGit(workspace, untrackedArgs, config.maxOutputBytes);
    if (isGitFailure(untracked))
        return diffStatus;
    const lines = [...outputLines(diffStatus), ...outputLines(untracked).map((line) => `?? ${line}`)];
    return lines.length ? lines.join("\n") : "(no output)";
}
export function gitLog(config, workspace, maxCount = 8) {
    const count = Math.max(1, Math.min(Math.floor(maxCount), 30));
    return runGit(workspace, ["log", `--max-count=${count}`, "--oneline", "--decorate"], config.maxOutputBytes);
}
export function assertGitCleanEnoughForWrite(_workspace) {
    // Reserved for future policy hooks. The first version allows writes and returns diffs.
    return;
}
//# sourceMappingURL=gitOps.js.map