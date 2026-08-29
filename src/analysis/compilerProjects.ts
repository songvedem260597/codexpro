import path from "node:path";
import ts from "typescript";
import type { InventoryFile } from "./types.js";

export interface TypeScriptCompilerGroup {
  key: string;
  label: string;
  rootNames: string[];
  options: ts.CompilerOptions;
  projectReferences?: readonly ts.ProjectReference[];
  warnings: string[];
}

type ParsedProjectConfig = {
  path: string;
  dir: string;
  depth: number;
  fileNames: Set<string>;
  options: ts.CompilerOptions;
  projectReferences?: readonly ts.ProjectReference[];
  warnings: string[];
};

function normalizedAbsolute(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function genericCompilerOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true
  };
}

function runtimeAnalysisOptions(parsed: ts.CompilerOptions): ts.CompilerOptions {
  const options: ts.CompilerOptions = {
    ...parsed,
    allowJs: true,
    noEmit: true,
    skipLibCheck: true
  };
  if (options.target === undefined) options.target = ts.ScriptTarget.ES2022;
  if (options.jsx === undefined) options.jsx = ts.JsxEmit.ReactJSX;
  if (options.module === undefined && options.moduleResolution === undefined) {
    options.module = ts.ModuleKind.NodeNext;
    options.moduleResolution = ts.ModuleResolutionKind.NodeNext;
  }
  return options;
}

function parseProjectConfig(root: string, relativePath: string): ParsedProjectConfig | undefined {
  const configPath = path.resolve(root, relativePath);
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) return undefined;
  const dir = path.dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dir, { allowJs: true }, configPath);
  const errors = parsed.errors.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  return {
    path: configPath,
    dir,
    depth: dir.split(/[\\/]+/).length,
    fileNames: new Set(parsed.fileNames.map(normalizedAbsolute)),
    options: runtimeAnalysisOptions(parsed.options),
    projectReferences: parsed.projectReferences,
    warnings: errors.length
      ? [`TypeScript project config ${relativePath} has ${errors.length} error${errors.length === 1 ? "" : "s"}; CodexGraph uses successfully parsed options but unresolved edges may be missing.`]
      : []
  };
}

function isProjectConfig(file: InventoryFile): boolean {
  return !file.generated && /(^|\/)(?:tsconfig|jsconfig)(?:\.[^/]*)?\.json$/i.test(file.path);
}

export function buildTypeScriptCompilerGroups(root: string, inventoryFiles: InventoryFile[], sourceFiles: InventoryFile[]): { groups: TypeScriptCompilerGroup[]; warnings: string[] } {
  const configs = inventoryFiles
    .filter(isProjectConfig)
    .map((file) => parseProjectConfig(root, file.path))
    .filter((config): config is ParsedProjectConfig => Boolean(config))
    .sort((a, b) => b.depth - a.depth || a.path.localeCompare(b.path));

  const groups = new Map<string, TypeScriptCompilerGroup>();
  const fallbackKey = "__codexgraph_fallback__";
  const warnings = new Set<string>();

  for (const source of sourceFiles) {
    const absolute = path.resolve(root, source.path);
    const normalized = normalizedAbsolute(absolute);
    const selected = configs.find((config) => config.fileNames.has(normalized));
    const key = selected?.path ?? fallbackKey;
    let group = groups.get(key);
    if (!group) {
      group = selected
        ? {
            key,
            label: path.relative(root, selected.path).split(path.sep).join("/"),
            rootNames: [],
            options: selected.options,
            projectReferences: selected.projectReferences,
            warnings: selected.warnings
          }
        : {
            key,
            label: "CodexGraph fallback",
            rootNames: [],
            options: genericCompilerOptions(),
            warnings: []
          };
      groups.set(key, group);
      for (const warning of group.warnings) warnings.add(warning);
    }
    group.rootNames.push(absolute);
  }

  return {
    groups: [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)),
    warnings: [...warnings]
  };
}
