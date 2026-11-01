import path from "node:path";
const LANGUAGE_BY_EXTENSION = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".swift": "swift",
    ".java": "java",
    ".cs": "csharp",
    ".c": "c",
    ".h": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".hh": "cpp",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".md": "markdown",
    ".mdx": "markdown",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell"
};
const TEST_PATTERNS = [/(^|\/)(__tests__|test|tests|spec)\//i, /\.(test|spec)\.[^.]+$/i, /_test\.go$/i, /Tests?\.swift$/i];
const GENERATED_PATTERNS = [/(^|\/)(generated|vendor|vendors|third_party)\//i, /\.generated\./i, /\.g\.(cs|dart)$/i];
const INFRA_PATTERNS = [/(^|\/)(\.github|infra|infrastructure|terraform|deploy|k8s|helm)\//i, /(^|\/)Dockerfile$/i];
const CONFIG_NAMES = new Set(["package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "Package.swift"]);
const ENTRYPOINT_NAMES = new Set(["index.ts", "index.js", "main.ts", "main.js", "main.py", "main.go", "main.rs", "lib.rs", "App.swift", "Program.cs"]);
export function classifyLanguage(filePath) {
    return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "unknown";
}
export function isGeneratedFile(filePath) {
    return GENERATED_PATTERNS.some((pattern) => pattern.test(filePath));
}
export function isEntrypoint(filePath) {
    return ENTRYPOINT_NAMES.has(path.basename(filePath));
}
export function classifyFileRole(filePath, language = classifyLanguage(filePath)) {
    const basename = path.basename(filePath);
    if (isGeneratedFile(filePath))
        return "generated";
    if (TEST_PATTERNS.some((pattern) => pattern.test(filePath)))
        return "test";
    if (CONFIG_NAMES.has(basename) || /(^|\/)(config|configs)\//i.test(filePath))
        return "config";
    if (language === "markdown" || /(^|\/)docs?\//i.test(filePath))
        return "docs";
    if (INFRA_PATTERNS.some((pattern) => pattern.test(filePath)))
        return "infrastructure";
    if (["typescript", "javascript", "python", "go", "rust", "swift", "java", "csharp", "c", "cpp"].includes(language))
        return "source";
    return "other";
}
export function detectProjectTypes(files) {
    const names = new Set(files.map((file) => path.basename(file.path)));
    const detected = [];
    if (names.has("package.json"))
        detected.push("node");
    if (names.has("pyproject.toml") || names.has("requirements.txt"))
        detected.push("python");
    if (names.has("go.mod"))
        detected.push("go");
    if (names.has("Cargo.toml"))
        detected.push("rust");
    if (names.has("Package.swift"))
        detected.push("swift");
    if (names.has("pom.xml") || names.has("build.gradle") || names.has("build.gradle.kts"))
        detected.push("jvm");
    if (files.some((file) => file.path.endsWith(".sln") || file.path.endsWith(".csproj")))
        detected.push("dotnet");
    if (names.has("CMakeLists.txt") || names.has("Makefile"))
        detected.push("native");
    return detected;
}
export function detectRiskSignals(filePath) {
    const value = filePath.toLowerCase();
    const risks = [];
    if (/(auth|session|token|oauth|login)/.test(value))
        risks.push("authentication");
    if (/(migration|schema|prisma|drizzle)/.test(value))
        risks.push("migration");
    if (/(database|storage|repository|model)/.test(value))
        risks.push("storage");
    if (/(package\.json|lock|build|webpack|vite|tsconfig)/.test(value))
        risks.push("build");
    if (/(config|settings|\.ya?ml|\.toml)/.test(value))
        risks.push("configuration");
    if (/(api|public|export|route)/.test(value))
        risks.push("public-api");
    return [...new Set(risks)];
}
//# sourceMappingURL=classify.js.map