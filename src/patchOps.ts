import path from "node:path";
import { CodexProError } from "./guard.js";

type ReadFile = (filePath: string, encoding: "utf8") => Promise<string>;

export const CODEX_PATCH_ENVELOPE_CONTRACT_VERSION = 1;

interface AddOperation {
  kind: "add";
  path: string;
  lines: string[];
}

interface DeleteOperation {
  kind: "delete";
  path: string;
}

interface UpdateOperation {
  kind: "update";
  path: string;
  moveTo?: string;
  hunks: Array<{ lines: string[]; endOfFile: boolean }>;
}

type PatchOperation = AddOperation | DeleteOperation | UpdateOperation;

function cleanOperationPath(rawPath: string): string {
  const value = rawPath.trim();
  if (!value || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new CodexProError("Codex patch contains an invalid file path.");
  }
  return value;
}

function parseCodexPatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch") {
    throw new CodexProError("Codex patch must start with *** Begin Patch.");
  }

  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line === "*** End Patch") {
      if (lines.slice(index + 1).some((tail) => tail.trim())) {
        throw new CodexProError("Codex patch contains content after *** End Patch.");
      }
      if (!operations.length) throw new CodexProError("Codex patch must include at least one file operation.");
      return operations;
    }

    const add = line.match(/^\*\*\* Add File: (.+)$/);
    if (add) {
      const operation: AddOperation = { kind: "add", path: cleanOperationPath(add[1]), lines: [] };
      index += 1;
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("+")) {
          throw new CodexProError(`Added file ${operation.path} must contain only lines prefixed with +.`);
        }
        operation.lines.push(lines[index].slice(1));
        index += 1;
      }
      operations.push(operation);
      continue;
    }

    const deletion = line.match(/^\*\*\* Delete File: (.+)$/);
    if (deletion) {
      operations.push({ kind: "delete", path: cleanOperationPath(deletion[1]) });
      index += 1;
      continue;
    }

    const update = line.match(/^\*\*\* Update File: (.+)$/);
    if (update) {
      const operation: UpdateOperation = { kind: "update", path: cleanOperationPath(update[1]), hunks: [] };
      index += 1;
      const move = lines[index]?.match(/^\*\*\* Move to: (.+)$/);
      if (move) {
        operation.moveTo = cleanOperationPath(move[1]);
        index += 1;
      }
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("@@")) {
          throw new CodexProError(`Update for ${operation.path} must start each change with @@.`);
        }
        index += 1;
        const hunk: string[] = [];
        while (index < lines.length && !lines[index].startsWith("@@") && !lines[index].startsWith("*** ")) {
          if (!/^[ +\-]/.test(lines[index])) {
            throw new CodexProError(`Update for ${operation.path} contains an invalid hunk line.`);
          }
          hunk.push(lines[index]);
          index += 1;
        }
        if (!hunk.length) throw new CodexProError(`Update for ${operation.path} contains an empty hunk.`);
        const endOfFile = lines[index] === "*** End of File";
        if (endOfFile) index += 1;
        operation.hunks.push({ lines: hunk, endOfFile });
      }
      if (!operation.hunks.length && !operation.moveTo) {
        throw new CodexProError(`Update for ${operation.path} must include at least one hunk.`);
      }
      operations.push(operation);
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }
    throw new CodexProError(`Unsupported Codex patch directive: ${line}`);
  }
  throw new CodexProError("Codex patch is missing *** End Patch.");
}

function findSequence(lines: string[], sequence: string[], start: number): number {
  if (!sequence.length) return Math.min(start, lines.length);
  for (let index = Math.max(0, start); index <= lines.length - sequence.length; index += 1) {
    if (sequence.every((line, offset) => lines[index + offset] === line)) return index;
  }
  return -1;
}

function applyHunks(path: string, source: string, hunks: Array<{ lines: string[]; endOfFile: boolean }>): string {
  const trailingNewline = source.endsWith("\n");
  const lines = source.replace(/\n$/, "").split("\n");
  if (source === "") lines.length = 0;
  let cursor = 0;
  for (const hunk of hunks) {
    const before = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1));
    const after = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1));
    const match = hunk.endOfFile && !before.length ? lines.length : findSequence(lines, before, cursor);
    if (match < 0 || (hunk.endOfFile && match + before.length !== lines.length)) {
      throw new CodexProError(`Codex patch context did not match ${path}. Read the current file and retry.`);
    }
    lines.splice(match, before.length, ...after);
    cursor = match + after.length;
  }
  if (!lines.length) return "";
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function quotedPatchPath(prefix: "a" | "b", filePath: string): string {
  return JSON.stringify(`${prefix}/${filePath}`);
}

function replacementDiff(oldPath: string | undefined, newPath: string | undefined, before: string, after: string): string {
  const beforeLines = before ? before.replace(/\n$/, "").split("\n") : [];
  const afterLines = after ? after.replace(/\n$/, "").split("\n") : [];
  const displayPath = newPath ?? oldPath!;
  const output = [
    `diff --git ${quotedPatchPath("a", oldPath ?? displayPath)} ${quotedPatchPath("b", newPath ?? displayPath)}`,
    !oldPath ? "new file mode 100644" : !newPath ? "deleted file mode 100644" : undefined,
    oldPath ? `--- ${quotedPatchPath("a", oldPath)}` : "--- /dev/null",
    newPath ? `+++ ${quotedPatchPath("b", newPath)}` : "+++ /dev/null",
    `@@ -${beforeLines.length ? "1" : "0"},${beforeLines.length} +${afterLines.length ? "1" : "0"},${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].filter((line): line is string => Boolean(line));
  const oldStart = oldPath && newPath ? 4 : 5;
  if (before && !before.endsWith("\n")) output.splice(oldStart + beforeLines.length, 0, "\\ No newline at end of file");
  if (after && !after.endsWith("\n")) output.push("\\ No newline at end of file");
  return `${output.join("\n")}\n`;
}

export function isCodexPatchEnvelope(patch: string): boolean {
  return patch.trimStart().startsWith("*** Begin Patch");
}

export function codexPatchTouchedPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const operation of parseCodexPatch(patch.trimStart())) {
    const operationPaths = [operation.path, operation.kind === "update" ? operation.moveTo : undefined]
      .filter((value): value is string => Boolean(value));
    for (const operationPath of operationPaths) {
      if (paths.has(operationPath)) {
        throw new CodexProError(`Codex patch contains more than one operation for ${operationPath}.`);
      }
      paths.add(operationPath);
    }
  }
  return [...paths];
}

export async function codexPatchToUnifiedDiff(
  patch: string,
  root: string,
  readFile: ReadFile,
): Promise<string> {
  const operations = parseCodexPatch(patch.trimStart());
  const diffs: string[] = [];
  for (const operation of operations) {
    if (operation.kind === "add") {
      const content = `${operation.lines.join("\n")}${operation.lines.length ? "\n" : ""}`;
      diffs.push(replacementDiff(undefined, operation.path, "", content));
      continue;
    }
    const before = await readFile(path.join(root, operation.path), "utf8");
    if (operation.kind === "delete") {
      diffs.push(replacementDiff(operation.path, undefined, before, ""));
      continue;
    }
    const after = applyHunks(operation.path, before, operation.hunks);
    if (operation.moveTo) {
      diffs.push(replacementDiff(operation.path, undefined, before, ""));
      diffs.push(replacementDiff(undefined, operation.moveTo, "", after));
    } else {
      diffs.push(replacementDiff(operation.path, operation.path, before, after));
    }
  }
  return diffs.join("");
}
