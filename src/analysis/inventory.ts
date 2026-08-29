import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import type { CodexProConfig } from "../config.js";
import { listFiles, textScanByteLimit } from "../fsOps.js";
import type { PathGuard, Workspace } from "../guard.js";
import { classifyFileRole, classifyLanguage, isEntrypoint, isGeneratedFile } from "./classify.js";
import type { InventoryFile, InventoryResult } from "./types.js";

const INVENTORY_SCHEMA_VERSION = 2;

function shouldContentHash(file: Pick<InventoryFile, "role" | "generated">): boolean {
  return !file.generated && (file.role === "source" || file.role === "test" || file.role === "config");
}

export async function inventoryWorkspace(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<InventoryResult> {
  const maxFiles = config.analysisLimits.maxInventoryFiles;
  const candidates = await listFiles(guard, workspace, {
    root: ".",
    includeHidden: true,
    maxFiles: maxFiles + 1,
    excludePrefixes: [".ai-bridge"]
  });
  const truncated = candidates.length > maxFiles;
  const files: InventoryFile[] = [];

  for (const candidate of candidates.slice(0, maxFiles)) {
    try {
      const resolved = guard.resolve(workspace, candidate);
      const stat = await fsp.stat(resolved.absPath);
      if (!stat.isFile()) continue;
      await guard.assertTextFile(resolved.absPath, textScanByteLimit(config));
      const language = classifyLanguage(resolved.relPath);
      const role = classifyFileRole(resolved.relPath, language);
      const generated = isGeneratedFile(resolved.relPath);
      const file: InventoryFile = {
        path: resolved.relPath,
        bytes: stat.size,
        modifiedMs: stat.mtimeMs,
        language,
        role,
        generated,
        entrypoint: isEntrypoint(resolved.relPath)
      };
      if (shouldContentHash(file)) {
        const content = await fsp.readFile(resolved.absPath);
        file.contentHash = createHash("sha256").update(content).digest("hex");
      }
      files.push(file);
    } catch {
      // Blocked, escaping, unreadable, binary, and oversized files are absent by design.
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = createHash("sha256")
    .update(`inventory-v${INVENTORY_SCHEMA_VERSION}\n${files.map((file) => `${file.path}:${file.bytes}:${file.modifiedMs}:${file.contentHash ?? "metadata"}`).join("\n")}`)
    .digest("hex");
  const warnings = truncated ? [`Inventory truncated at ${maxFiles} files.`] : [];
  return {
    files,
    fingerprint,
    coverage: {
      inventoryFiles: files.length,
      analyzedFiles: 0,
      scannedBytes: 0,
      symbolCount: 0,
      relationshipCount: 0,
      truncated,
      warnings
    }
  };
}
