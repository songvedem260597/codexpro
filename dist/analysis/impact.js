import fsp from "node:fs/promises";
import path from "node:path";
import { detectRiskSignals } from "./classify.js";
import { inspectWorkspace } from "./index.js";
import { relationshipIdentity, reverseSymbolNeighborhood } from "./graph.js";
import { loadPreviousWorkspaceAnalysis } from "./persistent.js";
const RISK_LABELS = {
    "public-api": "Public API",
    authentication: "Authentication or sessions",
    storage: "Storage or persistence",
    migration: "Schema or migration",
    build: "Build or dependency configuration",
    configuration: "Runtime configuration",
    "graph-integrity": "Dependency graph integrity"
};
const SCRIPT_PRIORITY = ["test", "test:unit", "typecheck", "lint", "build", "check"];
const SAFE_SCRIPT = /^[A-Za-z0-9._:-]+$/;
async function packageRunner(guard, workspace, packageJson) {
    const declared = typeof packageJson.packageManager === "string"
        ? packageJson.packageManager.match(/^(npm|pnpm|yarn|bun)(?:@|$)/)?.[1]
        : undefined;
    if (declared)
        return declared;
    const lockfiles = [
        ["pnpm-lock.yaml", "pnpm"],
        ["yarn.lock", "yarn"],
        ["bun.lock", "bun"],
        ["bun.lockb", "bun"],
        ["package-lock.json", "npm"],
        ["npm-shrinkwrap.json", "npm"]
    ];
    for (const [lockfile, runner] of lockfiles) {
        try {
            if ((await fsp.stat(guard.resolve(workspace, lockfile).absPath)).isFile())
                return runner;
        }
        catch {
            // Continue to the next package-manager marker.
        }
    }
    return "npm";
}
function packageCommand(runner, script) {
    if (runner === "npm")
        return script === "test" ? "npm test" : `npm run ${script}`;
    if (runner === "pnpm")
        return script === "test" ? "pnpm test" : `pnpm run ${script}`;
    return `${runner} run ${script}`;
}
async function packageRecommendations(guard, workspace) {
    try {
        const resolved = guard.resolve(workspace, "package.json");
        const parsed = JSON.parse(await fsp.readFile(resolved.absPath, "utf8"));
        const scripts = parsed?.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
        const runner = await packageRunner(guard, workspace, parsed);
        return SCRIPT_PRIORITY
            .filter((name) => typeof scripts[name] === "string" && SAFE_SCRIPT.test(name))
            .map((name) => ({
            command: packageCommand(runner, name),
            source: "package.json",
            reasons: ["existing project script", `${runner} project`, name.includes("test") ? "related test coverage" : "project verification"]
        }));
    }
    catch {
        return [];
    }
}
async function nativeRecommendations(guard, workspace) {
    const candidates = [
        { manifest: "go.mod", command: "go test ./..." },
        { manifest: "Cargo.toml", command: "cargo test" },
        { manifest: "Package.swift", command: "swift test" },
        { manifest: "pyproject.toml", command: "python3 -m pytest" },
        { manifest: "pom.xml", command: "mvn test" }
    ];
    const recommendations = [];
    for (const candidate of candidates) {
        try {
            const resolved = guard.resolve(workspace, candidate.manifest);
            const stat = await fsp.stat(resolved.absPath);
            if (!stat.isFile())
                continue;
            recommendations.push({
                command: candidate.command,
                source: candidate.manifest,
                reasons: ["detected project manifest", "native project verification"]
            });
        }
        catch {
            // Missing or blocked manifests do not create recommendations.
        }
    }
    return recommendations;
}
export async function reviewWorkspaceChanges(config, guard, workspace, options) {
    const changedPaths = [];
    const pathWarnings = [];
    for (const candidate of options.changedPaths) {
        try {
            const relPath = guard.resolve(workspace, candidate).relPath;
            if (!changedPaths.includes(relPath))
                changedPaths.push(relPath);
        }
        catch {
            pathWarnings.push(`Skipped unsafe or unreadable changed path: ${candidate}`);
        }
    }
    const analysis = await inspectWorkspace(config, guard, workspace);
    const affectedAreas = [...new Set(changedPaths.map((filePath) => filePath.includes("/") ? filePath.split("/")[0] : "."))].sort();
    const changed = new Set(changedPaths);
    const dependents = new Map();
    const tests = new Map();
    const roleByPath = new Map(analysis.files.map((file) => [file.path, file.role]));
    for (const relationship of analysis.relationships) {
        if (!changed.has(relationship.to) || !roleByPath.has(relationship.from))
            continue;
        const target = relationship.kind === "tests" ? tests : dependents;
        const reasons = target.get(relationship.from) ?? new Set();
        reasons.add(`${relationship.kind} ${relationship.to}`);
        target.set(relationship.from, reasons);
    }
    const changedSymbolIds = analysis.symbols
        .filter((symbol) => changed.has(symbol.path) && symbol.id)
        .map((symbol) => symbol.id);
    const graphNeighborhood = reverseSymbolNeighborhood(analysis.symbols, analysis.relationships, changedSymbolIds, { maxDepth: 4 });
    const symbolsById = new Map(analysis.symbols.filter((symbol) => symbol.id).map((symbol) => [symbol.id, symbol]));
    for (const [symbolId, distance] of graphNeighborhood.distance) {
        if (distance === 0)
            continue;
        const symbol = symbolsById.get(symbolId);
        if (!symbol || symbol.virtual || changed.has(symbol.path))
            continue;
        const target = roleByPath.get(symbol.path) === "test" ? tests : dependents;
        const reasons = target.get(symbol.path) ?? new Set();
        reasons.add(distance === 1 ? `direct CodexGraph dependency on changed symbol` : `transitive CodexGraph dependency (${distance} hops)`);
        target.set(symbol.path, reasons);
    }
    const directTestCandidates = analysis.files.filter((file) => file.role === "test" && changedPaths.some((changedPath) => {
        const base = path.basename(changedPath).replace(/\.[^.]+$/, "").toLowerCase();
        return base.length > 2 && file.path.toLowerCase().includes(base);
    }));
    for (const test of directTestCandidates) {
        const reasons = tests.get(test.path) ?? new Set();
        reasons.add("test filename matches changed source");
        tests.set(test.path, reasons);
    }
    const previousAnalysis = await loadPreviousWorkspaceAnalysis(workspace);
    let graphDiff;
    if (previousAnalysis && previousAnalysis.fingerprint !== analysis.fingerprint) {
        const relevant = (relationship) => changed.has(relationship.from) || changed.has(relationship.to);
        const previousRelationships = new Map(previousAnalysis.relationships.filter(relevant).map((relationship) => [relationshipIdentity(relationship), relationship]));
        const currentRelationships = new Map(analysis.relationships.filter(relevant).map((relationship) => [relationshipIdentity(relationship), relationship]));
        const addedRelationships = [...currentRelationships.entries()].filter(([key]) => !previousRelationships.has(key)).map(([, relationship]) => relationship);
        const removedRelationships = [...previousRelationships.entries()].filter(([key]) => !currentRelationships.has(key)).map(([, relationship]) => relationship);
        const currentSymbolIds = new Set(analysis.symbols.map((symbol) => symbol.id).filter((id) => Boolean(id)));
        const removedSymbols = previousAnalysis.symbols.filter((symbol) => changed.has(symbol.path) && symbol.id && !currentSymbolIds.has(symbol.id));
        graphDiff = {
            previousFingerprint: previousAnalysis.fingerprint,
            currentFingerprint: analysis.fingerprint,
            addedRelationships: addedRelationships.length,
            removedRelationships: removedRelationships.length,
            removedSymbols: removedSymbols.length,
            addedSamples: addedRelationships.slice(0, 20),
            removedSamples: removedRelationships.slice(0, 20),
            removedSymbolSamples: removedSymbols.slice(0, 20)
        };
    }
    const risks = new Map();
    for (const changedPath of changedPaths) {
        for (const risk of detectRiskSignals(changedPath)) {
            const paths = risks.get(risk) ?? new Set();
            paths.add(changedPath);
            risks.set(risk, paths);
        }
    }
    if (graphDiff && (graphDiff.removedRelationships > 0 || graphDiff.removedSymbols > 0)) {
        risks.set("graph-integrity", new Set(changedPaths));
    }
    const riskSignals = [...risks.entries()].map(([id, paths]) => ({
        id,
        label: RISK_LABELS[id],
        confidence: "inferred",
        paths: [...paths].sort(),
        reasons: id === "graph-integrity" && graphDiff
            ? [`CodexGraph observed ${graphDiff.removedRelationships} removed dependency edge(s) and ${graphDiff.removedSymbols} removed symbol(s) around changed files; verify removals are intentional.`]
            : [`path pattern matched ${id}`]
    }));
    const resultLimit = Math.max(1, config.maxSearchResults);
    const dependentFiles = [...dependents.entries()]
        .map(([filePath, reasons]) => ({ path: filePath, confidence: "strong", reasons: [...reasons] }))
        .sort((a, b) => a.path.localeCompare(b.path));
    const relatedTests = [...tests.entries()]
        .map(([filePath, reasons]) => ({ path: filePath, confidence: "strong", reasons: [...reasons] }))
        .sort((a, b) => a.path.localeCompare(b.path));
    const impactLimited = dependentFiles.length > resultLimit || relatedTests.length > resultLimit;
    return {
        schemaVersion: 1,
        changedPaths,
        affectedAreas,
        dependentFiles: dependentFiles.slice(0, resultLimit),
        relatedTests: relatedTests.slice(0, resultLimit),
        riskSignals,
        graphDiff,
        recommendedCommands: [...await packageRecommendations(guard, workspace), ...await nativeRecommendations(guard, workspace)],
        coverage: analysis.coverage,
        warnings: [
            ...analysis.warnings,
            ...pathWarnings,
            ...(graphDiff && (graphDiff.removedRelationships > 0 || graphDiff.removedSymbols > 0) ? [`CodexGraph diff detected ${graphDiff.removedRelationships} removed dependency edge(s) and ${graphDiff.removedSymbols} removed symbol(s) around changed files.`] : []),
            ...(impactLimited ? [`Change-impact output was limited to ${resultLimit} dependent files and ${resultLimit} related tests.`] : [])
        ],
        cache: analysis.cache
    };
}
//# sourceMappingURL=impact.js.map