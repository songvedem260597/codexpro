import { redactSensitiveText } from "../redact.js";
const providers = new Map();
export function registerAnalysisProvider(provider) {
    if (!provider.id.trim())
        throw new Error("Analysis provider id is required.");
    providers.set(provider.id, provider);
}
export function listAnalysisProviders() {
    return [...providers.values()];
}
export function normalizeProviderPaths(guard, workspace, paths) {
    const valid = [];
    const warnings = [];
    for (const candidate of paths) {
        try {
            valid.push(guard.resolve(workspace, candidate).relPath);
        }
        catch (error) {
            warnings.push(redactSensitiveText(`Provider path rejected: ${error instanceof Error ? error.message : String(error)}`));
        }
    }
    return { paths: [...new Set(valid)], warnings };
}
//# sourceMappingURL=providers.js.map