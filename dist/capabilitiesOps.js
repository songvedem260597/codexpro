import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSubpath } from "./guard.js";
const MAX_MCP_SERVER_INVENTORY = 120;
function unique(items, key) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const id = key(item);
        if (seen.has(id))
            continue;
        seen.add(id);
        out.push(item);
    }
    return out;
}
async function safeReadText(file, maxBytes = 16_000) {
    const stat = await fsp.stat(file);
    const handle = await fsp.open(file, "r");
    try {
        const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
    }
    finally {
        await handle.close();
    }
}
async function readTextWithStats(file, maxBytes) {
    const stat = await fsp.stat(file);
    const handle = await fsp.open(file, "r");
    try {
        const limit = Math.max(1, Math.min(maxBytes, stat.size));
        const buffer = Buffer.alloc(limit);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
            text: buffer.subarray(0, bytesRead).toString("utf8"),
            bytes: bytesRead,
            totalBytes: stat.size,
            truncated: stat.size > bytesRead
        };
    }
    finally {
        await handle.close();
    }
}
async function safeReaddir(dir) {
    try {
        return await fsp.readdir(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
}
function realpathOrUndefined(filePath) {
    try {
        return fs.realpathSync(filePath);
    }
    catch {
        return undefined;
    }
}
function displayPath(absPath, workspaceRoot, home = os.homedir()) {
    if (absPath === workspaceRoot)
        return "$WORKSPACE";
    if (absPath.startsWith(`${workspaceRoot}${path.sep}`)) {
        return `$WORKSPACE/${path.relative(workspaceRoot, absPath).split(path.sep).join("/")}`;
    }
    if (absPath === home)
        return "~";
    if (absPath.startsWith(`${home}${path.sep}`)) {
        return `~/${path.relative(home, absPath).split(path.sep).join("/")}`;
    }
    return absPath;
}
function skillSource(skillPath, workspaceRoot, home = os.homedir()) {
    if (skillPath.startsWith(`${workspaceRoot}${path.sep}`))
        return "workspace";
    if (skillPath.includes(`${path.sep}.codex${path.sep}plugins${path.sep}`))
        return "plugin";
    if (skillPath.startsWith(`${home}${path.sep}`))
        return "user";
    return "other";
}
function skillSourceRank(source) {
    if (source === "workspace")
        return 0;
    if (source === "user")
        return 1;
    if (source === "plugin")
        return 2;
    return 3;
}
function compareSkills(a, b) {
    return (skillSourceRank(a.source) - skillSourceRank(b.source) ||
        a.name.localeCompare(b.name) ||
        a.path.localeCompare(b.path));
}
function compareSkillPrecedence(a, b) {
    return (a.precedence - b.precedence ||
        skillSourceRank(a.source) - skillSourceRank(b.source) ||
        a.name.localeCompare(b.name) ||
        a.path.localeCompare(b.path));
}
function activeSkillRecords(records) {
    return unique([...records].sort(compareSkillPrecedence), (item) => item.name).sort(compareSkills);
}
function publicSkill(record) {
    return {
        name: record.name,
        description: record.description,
        source: record.source,
        path: record.path
    };
}
function frontmatterValue(text, key) {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}
async function findSkillFiles(root, maxDepth, out, maxItems, precedence) {
    if (out.length >= maxItems || maxDepth < 0)
        return;
    const entries = (await safeReaddir(root)).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        if (out.length >= maxItems)
            return;
        if (entry.name === "node_modules" || entry.name === ".git")
            continue;
        const abs = path.join(root, entry.name);
        if (entry.isFile() && entry.name === "SKILL.md") {
            out.push({ file: abs, precedence });
            continue;
        }
        if (entry.isDirectory()) {
            await findSkillFiles(abs, maxDepth - 1, out, maxItems, precedence);
        }
    }
}
async function discoverSkillRecords(workspace, options = {}) {
    const maxSkills = Math.max(1, Math.min(options.maxSkills ?? 120, 500));
    const workspaceRoot = realpathOrUndefined(workspace.root) ?? path.resolve(workspace.root);
    const requestedHomeDir = options.homeDir ?? os.homedir();
    const homeDir = realpathOrUndefined(requestedHomeDir) ?? path.resolve(requestedHomeDir);
    const workspaceRoots = [
        path.join(workspaceRoot, ".codex", "skills"),
        path.join(workspaceRoot, ".agents", "skills"),
        path.join(workspaceRoot, "skills")
    ].flatMap((dir) => {
        const real = realpathOrUndefined(dir);
        return real && isSubpath(real, workspaceRoot) ? [real] : [];
    });
    const roots = [
        ...workspaceRoots,
        ...(options.includeGlobal
            ? [
                path.join(homeDir, ".codex", "skills"),
                path.join(homeDir, ".agents", "skills"),
                path.join(homeDir, ".codex", "plugins", "cache")
            ]
            : [])
    ].filter((dir) => fs.existsSync(dir));
    const skillFiles = [];
    for (const [precedence, root] of roots.entries()) {
        await findSkillFiles(root, root.includes(`${path.sep}plugins${path.sep}cache`) ? 9 : 3, skillFiles, maxSkills, precedence);
        if (skillFiles.length >= maxSkills)
            break;
    }
    const items = [];
    for (const discovered of skillFiles.slice(0, maxSkills)) {
        const file = discovered.file;
        const realFile = realpathOrUndefined(file) ?? file;
        if (isSubpath(file, workspaceRoot) && !isSubpath(realFile, workspaceRoot))
            continue;
        let text = "";
        try {
            text = await safeReadText(realFile);
        }
        catch {
            // Keep the skill visible even if the file cannot be read.
        }
        const name = frontmatterValue(text, "name") ?? path.basename(path.dirname(realFile));
        const description = frontmatterValue(text, "description");
        items.push({
            name,
            description,
            source: skillSource(realFile, workspaceRoot, homeDir),
            path: displayPath(realFile, workspaceRoot, homeDir),
            absPath: realFile,
            precedence: discovered.precedence
        });
    }
    return unique(items, (item) => `${item.source}:${item.name}:${item.path}`).sort(compareSkillPrecedence);
}
export async function discoverSkillInventory(workspace, options = {}) {
    return activeSkillRecords(await discoverSkillRecords(workspace, options)).map(publicSkill);
}
export async function loadSkill(workspace, options) {
    const name = options.name.trim();
    if (!name)
        throw new Error("Skill name is required.");
    const requestedPath = options.path?.trim();
    const records = await discoverSkillRecords(workspace, {
        includeGlobal: options.includeGlobal !== false,
        maxSkills: options.maxSkills,
        homeDir: options.homeDir
    });
    const activeRecords = activeSkillRecords(records);
    const candidateRecords = requestedPath
        ? records
        : activeSkillRecords(options.source ? records.filter((skill) => skill.source === options.source) : records);
    const matches = candidateRecords.filter((skill) => skill.name === name &&
        (!options.source || skill.source === options.source) &&
        (!requestedPath || skill.path === requestedPath));
    if (!matches.length) {
        const near = activeRecords
            .filter((skill) => skill.name.toLowerCase().includes(name.toLowerCase()))
            .slice(0, 8)
            .map((skill) => `${skill.name} [${skill.source}]`)
            .join(", ");
        const suffix = requestedPath ? ` at ${requestedPath}` : "";
        throw new Error(`Skill not found: ${name}${suffix}${near ? `. Similar skills: ${near}` : ""}`);
    }
    if (matches.length > 1) {
        const choices = matches.map((skill) => `${skill.name} [${skill.source}] at ${skill.path}`).join("; ");
        throw new Error(`Multiple exact skill matches remained for ${name}: ${choices}`);
    }
    const [skill] = matches;
    if (path.basename(skill.absPath) !== "SKILL.md") {
        throw new Error(`Refusing to load non-skill file: ${skill.path}`);
    }
    if (skill.source === "workspace") {
        const realSkillPath = realpathOrUndefined(skill.absPath);
        const realWorkspaceRoot = realpathOrUndefined(workspace.root) ?? path.resolve(workspace.root);
        if (!realSkillPath || !isSubpath(realSkillPath, realWorkspaceRoot)) {
            throw new Error(`Refusing to load workspace skill outside workspace: ${skill.path}`);
        }
    }
    const maxBytes = Math.max(1_000, Math.min(options.maxBytes ?? 40_000, 100_000));
    const loaded = await readTextWithStats(skill.absPath, maxBytes);
    return {
        skill: publicSkill(skill),
        text: loaded.text,
        bytes: loaded.bytes,
        totalBytes: loaded.totalBytes,
        truncated: loaded.truncated
    };
}
function parseTomlMcpServers(text, source) {
    const out = [];
    const re = /^\s*\[(?:mcp_servers|mcpServers)\.("?)([^"\].]+)\1\]\s*$/gm;
    let match;
    while ((match = re.exec(text))) {
        out.push({ name: match[2], source });
    }
    return out;
}
function parseJsonMcpServers(text, source) {
    try {
        const parsed = JSON.parse(text);
        const servers = parsed?.mcpServers;
        if (!servers || typeof servers !== "object" || Array.isArray(servers))
            return [];
        return Object.keys(servers).map((name) => ({ name, source }));
    }
    catch {
        return [];
    }
}
export async function discoverMcpServers(workspace) {
    const candidates = [
        { file: path.join(os.homedir(), ".codex", "config.toml"), kind: "toml", source: "user codex config" },
        { file: path.join(workspace.root, ".mcp.json"), kind: "json", source: "workspace config" },
        { file: path.join(workspace.root, ".cursor", "mcp.json"), kind: "json", source: "workspace cursor config" },
        { file: path.join(os.homedir(), ".cursor", "mcp.json"), kind: "json", source: "user cursor config" }
    ];
    const servers = [];
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate.file))
            continue;
        let text = "";
        try {
            text = await safeReadText(candidate.file, 200_000);
        }
        catch {
            continue;
        }
        servers.push(...(candidate.kind === "toml" ? parseTomlMcpServers(text, candidate.source) : parseJsonMcpServers(text, candidate.source)));
    }
    return unique(servers, (server) => `${server.source}:${server.name}`)
        .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source))
        .slice(0, MAX_MCP_SERVER_INVENTORY);
}
export async function codexproInventory(config, workspace, options = {}) {
    const skills = await discoverSkillInventory(workspace, {
        includeGlobal: options.includeGlobalSkills !== false,
        maxSkills: options.maxSkills
    });
    const mcpServers = options.includeMcpServers === false ? [] : await discoverMcpServers(workspace);
    const bySource = skills.reduce((acc, skill) => {
        acc[skill.source] = (acc[skill.source] ?? 0) + 1;
        return acc;
    }, {});
    const skillLines = skills.length
        ? skills.map((skill) => `- ${skill.name} [${skill.source}]${skill.description ? ` - ${skill.description}` : ""}`).join("\n")
        : "- none discovered";
    const mcpLines = mcpServers.length
        ? mcpServers.map((server) => `- ${server.name} (${server.source})`).join("\n")
        : "- none discovered";
    const text = `# CodexPro Inventory

Workspace: ${workspace.root}
Bash mode: ${config.bashMode}
Write mode: ${config.writeMode}
Tool mode: ${config.toolMode}

## Skill summary

Total: ${skills.length}
Workspace: ${bySource.workspace ?? 0}
User: ${bySource.user ?? 0}
Plugin: ${bySource.plugin ?? 0}
Other: ${bySource.other ?? 0}

${skillLines}

## MCP servers

${mcpLines}
`;
    return { text, skills, mcpServers };
}
//# sourceMappingURL=capabilitiesOps.js.map