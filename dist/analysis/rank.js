const GROUPS = ["definitions", "references", "tests", "configuration", "documentation", "other"];
export function emptySearchGroups() {
    return { definitions: [], references: [], tests: [], configuration: [], documentation: [], other: [] };
}
export function classifySearchIntent(query, requested = "auto", regex = false) {
    if (requested !== "auto")
        return requested;
    if (regex || /\s/.test(query) || /^['"].*['"]$/.test(query))
        return "text";
    return /^[A-Za-z_$][\w$]*$/.test(query) ? "symbol" : "text";
}
export function sortStructuredMatches(matches) {
    return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
}
export function groupForFile(analysis, filePath, isDefinition) {
    if (isDefinition)
        return "definitions";
    const role = analysis.files.find((file) => file.path === filePath)?.role;
    if (role === "test")
        return "tests";
    if (role === "config")
        return "configuration";
    if (role === "docs")
        return "documentation";
    return "references";
}
//# sourceMappingURL=rank.js.map