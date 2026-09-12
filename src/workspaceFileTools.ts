import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import type { PathGuard, Workspace, WorkspaceManager } from "./guard.js";
import { repoTree, readTextFile, writeTextFile, editTextFile } from "./fsOps.js";
import { applyWorkspacePatch, patchTouchedPaths } from "./patchOps.js";
import { viewWorkspaceImage } from "./imageOps.js";
import { searchWorkspace } from "./searchOps.js";
import { invalidateWorkspaceAnalysis, reviewWorkspaceChanges } from "./analysis/index.js";
import { redactStructured } from "./redact.js";
import { toolCardMeta } from "./toolCardRegistration.js";
import { textResult } from "./toolResults.js";
import {
  claimWorkspacePaths,
  recordWorkspacePathsTouched,
  releaseWorkspacePaths,
  type WorkspaceTaskContext
} from "./workspaceCoordination.js";
import type { CodexToolHandler } from "./toolRegistration.js";

const defaultDependencies = {
  repoTree,
  searchWorkspace,
  readTextFile,
  viewWorkspaceImage,
  writeTextFile,
  editTextFile,
  applyWorkspacePatch,
  patchTouchedPaths,
  claimWorkspacePaths,
  recordWorkspacePathsTouched,
  releaseWorkspacePaths,
  invalidateWorkspaceAnalysis,
  reviewWorkspaceChanges,
  redactStructured,
  toolCardMeta,
  textResult
};

type RegisterCodexTool = (
  config: CodexProConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: CodexToolHandler
) => void;

type SharedHelpers = {
  workspaceForTool: (server: McpServer, workspaces: WorkspaceManager, workspaceId?: string) => Workspace;
  assertWriteToolAllowed: (config: CodexProConfig, relPath: string) => void;
  assertTaskChecklistReady: (server: McpServer) => void;
  workspaceTaskContextForServer: (server: McpServer, workspace: Workspace) => WorkspaceTaskContext | undefined;
  diffBlock: (diff: string) => string;
  parseBool: (value: unknown, fallback?: boolean) => boolean;
  limitInt: (value: unknown, fallback: number, min: number, max: number) => number;
};

type WorkspaceFileToolsOptions = {
  config: CodexProConfig;
  server: McpServer;
  workspaces: WorkspaceManager;
  guard: PathGuard;
  registerCodexTool: RegisterCodexTool;
  helpers: SharedHelpers;
  annotations: {
    readOnly: Record<string, unknown>;
    localWrite: Record<string, unknown>;
  };
  dependencies?: Partial<typeof defaultDependencies>;
};

function isContextArtifactPath(config: CodexProConfig, relPath: string): boolean {
  const normalized = String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const contextDir = String(config.contextDir || ".ai-bridge").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === contextDir || normalized.startsWith(`${contextDir}/`);
}

async function mutationCodexGraphImpact(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  changedPaths: string[],
  reviewChanges: typeof reviewWorkspaceChanges
) {
  if (!config.analysisEnabled || !changedPaths.length) return undefined;
  try {
    return await reviewChanges(config, guard, workspace, { changedPaths });
  } catch {
    return undefined;
  }
}

function compactMutationCodexGraphImpact(impact: Awaited<ReturnType<typeof reviewWorkspaceChanges>> | undefined) {
  if (!impact) return undefined;
  return {
    dependent_files: impact.dependentFiles.slice(0, 40),
    related_tests: impact.relatedTests.slice(0, 40),
    risk_signals: impact.riskSignals,
    graph_diff: impact.graphDiff,
    warnings: impact.warnings.slice(-8)
  };
}

export function registerWorkspaceFileTools(options: WorkspaceFileToolsOptions): void {
  const { config, server, workspaces, guard, registerCodexTool, helpers, annotations } = options;
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const {
    workspaceForTool,
    assertWriteToolAllowed,
    assertTaskChecklistReady,
    workspaceTaskContextForServer,
    diffBlock,
    parseBool,
    limitInt
  } = helpers;

  registerCodexTool(
    config,
    server,
    "tree",
    {
      title: "File Tree",
      description: "List files and directories inside the workspace, excluding blocked paths.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Directory relative to workspace root. Default: ."),
        max_depth: z.number().int().min(1).max(12).optional().describe("Maximum depth. Default: 4."),
        include_hidden: z.boolean().optional().describe("Include dotfiles/dotfolders that are not blocked. Default: false."),
        max_entries: z.number().int().min(1).max(3000).optional().describe("Maximum entries. Default: 800.")
      },
      annotations: annotations.readOnly,
      _meta: {
        ...dependencies.toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing workspace files...",
        "openai/toolInvocation/invoked": "Workspace files listed"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const result = await dependencies.repoTree(config, guard, workspace, {
        path: args.path ?? ".",
        maxDepth: limitInt(args.max_depth, 4, 1, 12),
        includeHidden: parseBool(args.include_hidden, false),
        maxEntries: limitInt(args.max_entries, 800, 1, 3000)
      });
      return dependencies.textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "search",
    {
      title: "Search Files",
      description: "Use this for targeted verification or code lookup. Prefer one specific final search instead of repeated broad verification searches.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        query: z.string().describe("Text or regex to search for."),
        regex: z.boolean().optional().describe("Treat query as a regular expression. Requires ripgrep. Default: false."),
        path: z.string().optional().describe("Directory or file relative to workspace root. Default: ."),
        glob: z.string().optional().describe("Optional glob, for example src/**/*.ts."),
        include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        max_results: z.number().int().min(1).max(2000).optional().describe("Maximum results. Default from config."),
        intent: z.enum(["auto", "text", "symbol", "references", "impact"]).optional().describe("Optional structured search intent. Omit for legacy lexical behavior."),
        symbol: z.string().optional().describe("Optional symbol query. Uses repository analysis and overrides query text."),
        include_tests: z.boolean().optional().describe("Include related tests in structured results. Default: false.")
      },
      annotations: annotations.readOnly,
      _meta: {
        ...dependencies.toolCardMeta(),
        "openai/toolInvocation/invoking": "Searching workspace...",
        "openai/toolInvocation/invoked": "Workspace search complete"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const result = await dependencies.searchWorkspace(config, guard, workspace, {
        query: args.query,
        regex: parseBool(args.regex, false),
        root: args.path ?? ".",
        glob: args.glob,
        includeHidden: parseBool(args.include_hidden, false),
        maxResults: limitInt(args.max_results, config.maxSearchResults, 1, config.maxSearchResults),
        intent: args.intent,
        symbol: args.symbol,
        includeTests: args.include_tests === undefined ? undefined : parseBool(args.include_tests, false)
      });
      const structured: Record<string, unknown> = {
        workspace_id: workspace.id,
        root: workspace.root,
        matches: result.matches,
        truncated: result.truncated,
        used: result.used
      };
      if (result.analysis) structured.analysis = result.analysis;
      return dependencies.textResult(result.text, structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "read",
    {
      title: "Read File",
      description: "Read a specific text file with line numbers. Avoid rereading files after write/edit/apply_patch unless exact final content is needed.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("File path relative to workspace root."),
        start_line: z.number().int().min(1).optional().describe("First line to read. Default: 1."),
        end_line: z.number().int().min(1).optional().describe("Last line to read. Default: end of file."),
        max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Maximum file bytes. Capped by server config.")
      },
      annotations: annotations.readOnly,
      _meta: {
        ...dependencies.toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading file...",
        "openai/toolInvocation/invoked": "File read"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const result = await dependencies.readTextFile(config, guard, workspace, args.path, {
        startLine: args.start_line,
        endLine: args.end_line,
        maxBytes: args.max_bytes
      });
      const text = `# Read File\n\nPath: ${result.path}\nLines: ${result.startLine}-${result.endLine} of ${result.totalLines}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\n\n\`\`\`text\n${result.text}\n\`\`\``;
      return dependencies.textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "view_image",
    {
      title: "View Image",
      description: "Inspect a PNG, JPEG, GIF, or WebP image from the active workspace. Returns native MCP image content plus dimensions and SHA-256.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("Image path relative to workspace root."),
        max_bytes: z.number().int().min(4096).max(2000000).optional().describe("Maximum image bytes. Default: at least 1 MB, capped at 2 MB.")
      },
      annotations: annotations.readOnly
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const result = await dependencies.viewWorkspaceImage(config, guard, workspace, args.path, args.max_bytes);
      const dimensions = result.width && result.height ? `${result.width}x${result.height}` : "unknown";
      return {
        content: [
          {
            type: "text",
            text: `Image: ${result.path}\nType: ${result.mimeType}\nDimensions: ${dimensions}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}`
          },
          { type: "image", data: result.data, mimeType: result.mimeType }
        ],
        structuredContent: dependencies.redactStructured({
          workspace_id: workspace.id,
          root: workspace.root,
          path: result.path,
          mime_type: result.mimeType,
          width: result.width ?? null,
          height: result.height ?? null,
          bytes: result.bytes,
          sha256: result.sha256
        })
      };
    }
  );

  registerCodexTool(
    config,
    server,
    "write",
    {
      title: "Write File",
      description: "Create or overwrite a meaningful text file inside the workspace. New files use an atomic rename; existing files retain their inode and metadata. Returns a unified diff; pass the SHA from read when overwriting shared files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("File path relative to workspace root."),
        content: z.string().describe("Complete file contents to write."),
        create_dirs: z.boolean().optional().describe("Create parent directories if missing. Default: true."),
        overwrite: z.boolean().optional().describe("Allow overwriting existing files. Default: true."),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe("Optional SHA-256 from read. Fails instead of overwriting if another session changed the file.")
      },
      annotations: annotations.localWrite,
      _meta: {
        ...dependencies.toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing file...",
        "openai/toolInvocation/invoked": "File written"
      }
    },
    async (args) => {
      assertTaskChecklistReady(server);
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const taskContext = workspaceTaskContextForServer(server, workspace);
      const trackTaskSource = Boolean(taskContext && !isContextArtifactPath(config, resolved.relPath));
      if (taskContext && trackTaskSource) await dependencies.claimWorkspacePaths(taskContext, [resolved.relPath]);
      const codexGraphBefore = await mutationCodexGraphImpact(config, guard, workspace, [resolved.relPath], dependencies.reviewWorkspaceChanges);
      let result;
      try {
        result = await dependencies.writeTextFile(config, guard, workspace, args.path, String(args.content ?? ""), {
          createDirs: args.create_dirs !== false,
          overwrite: args.overwrite !== false,
          expectedSha256: args.expected_sha256
        });
      } catch (error) {
        if (taskContext && trackTaskSource) await dependencies.releaseWorkspacePaths(taskContext, [resolved.relPath], { onlyUntouched: true });
        throw error;
      }
      if (taskContext && trackTaskSource) {
        if (result.diff.changed) await dependencies.recordWorkspacePathsTouched(taskContext, [resolved.relPath]);
        else await dependencies.releaseWorkspacePaths(taskContext, [resolved.relPath], { onlyUntouched: true });
      }
      if (result.diff.changed) dependencies.invalidateWorkspaceAnalysis(workspace.id);
      const codexGraphAfter = result.diff.changed
        ? await mutationCodexGraphImpact(config, guard, workspace, [resolved.relPath], dependencies.reviewWorkspaceChanges)
        : codexGraphBefore;
      const text = `# Write File\n\nPath: ${result.path}\nExisted before: ${result.existed}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return dependencies.textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        existed: result.existed,
        codexgraph: { before: compactMutationCodexGraphImpact(codexGraphBefore), after: compactMutationCodexGraphImpact(codexGraphAfter) },
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "edit",
    {
      title: "Edit File",
      description: "Apply a targeted exact text replacement while retaining the existing file inode and metadata. Returns a unified diff; pass the SHA from read to reject stale multi-session edits.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("File path relative to workspace root."),
        old_text: z.string().describe("Exact text to replace. Must match once unless replace_all=true."),
        new_text: z.string().describe("Replacement text."),
        replace_all: z.boolean().optional().describe("Replace all occurrences. Default: false."),
        expected_replacements: z.number().int().min(1).optional().describe("Fail if actual replacement count differs."),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe("Optional SHA-256 from read. Fails if another session changed the file.")
      },
      annotations: annotations.localWrite,
      _meta: {
        ...dependencies.toolCardMeta(),
        "openai/toolInvocation/invoking": "Editing file...",
        "openai/toolInvocation/invoked": "File edited"
      }
    },
    async (args) => {
      assertTaskChecklistReady(server);
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const taskContext = workspaceTaskContextForServer(server, workspace);
      const trackTaskSource = Boolean(taskContext && !isContextArtifactPath(config, resolved.relPath));
      if (taskContext && trackTaskSource) await dependencies.claimWorkspacePaths(taskContext, [resolved.relPath]);
      const codexGraphBefore = await mutationCodexGraphImpact(config, guard, workspace, [resolved.relPath], dependencies.reviewWorkspaceChanges);
      let result;
      try {
        result = await dependencies.editTextFile(config, guard, workspace, args.path, String(args.old_text ?? ""), String(args.new_text ?? ""), {
          replaceAll: parseBool(args.replace_all, false),
          expectedReplacements: args.expected_replacements,
          expectedSha256: args.expected_sha256
        });
      } catch (error) {
        if (taskContext && trackTaskSource) await dependencies.releaseWorkspacePaths(taskContext, [resolved.relPath], { onlyUntouched: true });
        throw error;
      }
      if (taskContext && trackTaskSource) {
        if (result.diff.changed) await dependencies.recordWorkspacePathsTouched(taskContext, [resolved.relPath]);
        else await dependencies.releaseWorkspacePaths(taskContext, [resolved.relPath], { onlyUntouched: true });
      }
      if (result.diff.changed) dependencies.invalidateWorkspaceAnalysis(workspace.id);
      const codexGraphAfter = result.diff.changed
        ? await mutationCodexGraphImpact(config, guard, workspace, [resolved.relPath], dependencies.reviewWorkspaceChanges)
        : codexGraphBefore;
      const text = `# Edit File\n\nPath: ${result.path}\nReplacements: ${result.replacements}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return dependencies.textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        replacements: result.replacements,
        codexgraph: { before: compactMutationCodexGraphImpact(codexGraphBefore), after: compactMutationCodexGraphImpact(codexGraphAfter) },
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "apply_patch",
    {
      title: "Apply Patch",
      description:
        "Apply one unified diff patch inside the workspace. Paths are validated before applying. Prefer edit for tiny replacements and apply_patch for multi-file diffs.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        patch: z.string().describe("Unified diff patch to apply. File paths must stay inside the workspace and avoid blocked paths.")
      },
      annotations: annotations.localWrite,
      _meta: {
        ...dependencies.toolCardMeta(),
        "openai/toolInvocation/invoking": "Applying patch...",
        "openai/toolInvocation/invoked": "Patch applied"
      }
    },
    async (args) => {
      assertTaskChecklistReady(server);
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const patchText = String(args.patch ?? "");
      const codexGraphPaths = dependencies.patchTouchedPaths(patchText);
      const taskContext = workspaceTaskContextForServer(server, workspace);
      const taskSourcePaths = taskContext ? codexGraphPaths.filter((relPath) => !isContextArtifactPath(config, relPath)) : [];
      if (taskContext && taskSourcePaths.length) await dependencies.claimWorkspacePaths(taskContext, taskSourcePaths);
      const codexGraphBefore = await mutationCodexGraphImpact(config, guard, workspace, codexGraphPaths, dependencies.reviewWorkspaceChanges);
      let result;
      try {
        result = await dependencies.applyWorkspacePatch(config, guard, workspace, patchText, (touchedPath) => assertWriteToolAllowed(config, touchedPath));
      } catch (error) {
        if (taskContext && taskSourcePaths.length) await dependencies.releaseWorkspacePaths(taskContext, taskSourcePaths, { onlyUntouched: true });
        throw error;
      }
      if (taskContext && taskSourcePaths.length) {
        if (result.changed) await dependencies.recordWorkspacePathsTouched(taskContext, taskSourcePaths);
        else await dependencies.releaseWorkspacePaths(taskContext, taskSourcePaths, { onlyUntouched: true });
      }
      if (result.changed) dependencies.invalidateWorkspaceAnalysis(workspace.id);
      const codexGraphAfter = result.changed
        ? await mutationCodexGraphImpact(config, guard, workspace, result.paths, dependencies.reviewWorkspaceChanges)
        : codexGraphBefore;
      const text = [
        "# Apply Patch",
        "",
        `Paths: ${result.paths.join(", ")}`,
        `Diff stats: +${result.additions} -${result.deletions}`,
        result.stderr ? `stderr: ${result.stderr}` : "",
        result.diff ? diffBlock(result.diff) : "No diff output."
      ].filter(Boolean).join("\n");
      return dependencies.textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        paths: result.paths,
        stdout: result.stdout,
        stderr: result.stderr,
        additions: result.additions,
        deletions: result.deletions,
        changed: result.changed,
        codexgraph: { before: compactMutationCodexGraphImpact(codexGraphBefore), after: compactMutationCodexGraphImpact(codexGraphAfter) },
        diff: result.diff
      });
    }
  );
}
