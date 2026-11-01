import path from "node:path";
import ts from "typescript";
function normalizedAbsolute(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function genericCompilerOptions() {
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
function runtimeAnalysisOptions(parsed) {
    const options = {
        ...parsed,
        allowJs: true,
        noEmit: true,
        skipLibCheck: true
    };
    if (options.target === undefined)
        options.target = ts.ScriptTarget.ES2022;
    if (options.jsx === undefined)
        options.jsx = ts.JsxEmit.ReactJSX;
    if (options.module === undefined && options.moduleResolution === undefined) {
        options.module = ts.ModuleKind.NodeNext;
        options.moduleResolution = ts.ModuleResolutionKind.NodeNext;
    }
    return options;
}
function parseProjectConfig(root, relativePath) {
    const configPath = path.resolve(root, relativePath);
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (loaded.error)
        return undefined;
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
function isProjectConfig(file) {
    return !file.generated && /(^|\/)(?:tsconfig|jsconfig)(?:\.[^/]*)?\.json$/i.test(file.path);
}
export function buildTypeScriptCompilerGroups(root, inventoryFiles, sourceFiles) {
    const configs = inventoryFiles
        .filter(isProjectConfig)
        .map((file) => parseProjectConfig(root, file.path))
        .filter((config) => Boolean(config))
        .sort((a, b) => b.depth - a.depth || a.path.localeCompare(b.path));
    const groups = new Map();
    const fallbackKey = "__codexgraph_fallback__";
    const warnings = new Set();
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
            for (const warning of group.warnings)
                warnings.add(warning);
        }
        group.rootNames.push(absolute);
    }
    return {
        groups: [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)),
        warnings: [...warnings]
    };
}
//# sourceMappingURL=compilerProjects.js.map