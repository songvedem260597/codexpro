import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const STORE_SCHEMA_VERSION = 1;
const MAX_PERSISTED_BYTES = 32 * 1024 * 1024;
function codexProHome() {
    const configured = process.env.CODEXPRO_HOME?.trim();
    return configured ? path.resolve(configured) : path.join(os.homedir(), ".codexpro");
}
function normalizedRoot(root) {
    const resolved = path.resolve(root);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function workspaceKey(workspace) {
    return createHash("sha256").update(`${workspace.id}\u0000${normalizedRoot(workspace.root)}`).digest("hex").slice(0, 24);
}
export function persistentGraphPath(workspace) {
    return path.join(codexProHome(), "graphs", `${workspaceKey(workspace)}.json`);
}
async function readEnvelope(workspace) {
    const filePath = persistentGraphPath(workspace);
    try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PERSISTED_BYTES)
            return undefined;
        const parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
        if (parsed.schemaVersion !== STORE_SCHEMA_VERSION || parsed.workspaceId !== workspace.id || normalizedRoot(String(parsed.root ?? "")) !== normalizedRoot(workspace.root) || !parsed.current)
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
export async function loadPersistentWorkspaceAnalysis(workspace, cacheKey) {
    const envelope = await readEnvelope(workspace);
    if (!envelope || envelope.current.cache.key !== cacheKey)
        return undefined;
    return envelope.current;
}
export async function loadPreviousWorkspaceAnalysis(workspace) {
    return (await readEnvelope(workspace))?.previous;
}
export async function savePersistentWorkspaceAnalysis(workspace, analysis) {
    const filePath = persistentGraphPath(workspace);
    const existing = await readEnvelope(workspace);
    const previous = existing?.current && existing.current.fingerprint !== analysis.fingerprint ? existing.current : existing?.previous;
    const envelope = {
        schemaVersion: STORE_SCHEMA_VERSION,
        workspaceId: workspace.id,
        root: workspace.root,
        savedAt: new Date().toISOString(),
        current: analysis,
        ...(previous ? { previous } : {})
    };
    const serialized = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_BYTES)
        return;
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fsp.writeFile(tempPath, serialized, "utf8");
        await fsp.rename(tempPath, filePath);
    }
    finally {
        await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    }
}
//# sourceMappingURL=persistent.js.map