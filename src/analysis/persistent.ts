import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "../guard.js";
import type { WorkspaceAnalysis } from "./types.js";

const STORE_SCHEMA_VERSION = 1;
const MAX_PERSISTED_BYTES = 32 * 1024 * 1024;

type GraphStoreEnvelope = {
  schemaVersion: 1;
  workspaceId: string;
  root: string;
  savedAt: string;
  current: WorkspaceAnalysis;
  previous?: WorkspaceAnalysis;
};

function codexProHome(): string {
  const configured = process.env.CODEXPRO_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codexpro");
}

function workspaceKey(workspace: Workspace): string {
  return createHash("sha256").update(`${workspace.id}\u0000${path.resolve(workspace.root)}`).digest("hex").slice(0, 24);
}

export function persistentGraphPath(workspace: Workspace): string {
  return path.join(codexProHome(), "graphs", `${workspaceKey(workspace)}.json`);
}

async function readEnvelope(workspace: Workspace): Promise<GraphStoreEnvelope | undefined> {
  const filePath = persistentGraphPath(workspace);
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PERSISTED_BYTES) return undefined;
    const parsed = JSON.parse(await fsp.readFile(filePath, "utf8")) as Partial<GraphStoreEnvelope>;
    if (parsed.schemaVersion !== STORE_SCHEMA_VERSION || parsed.workspaceId !== workspace.id || path.resolve(String(parsed.root ?? "")) !== path.resolve(workspace.root) || !parsed.current) return undefined;
    return parsed as GraphStoreEnvelope;
  } catch {
    return undefined;
  }
}

export async function loadPersistentWorkspaceAnalysis(workspace: Workspace, cacheKey: string): Promise<WorkspaceAnalysis | undefined> {
  const envelope = await readEnvelope(workspace);
  if (!envelope || envelope.current.cache.key !== cacheKey) return undefined;
  return envelope.current;
}

export async function loadPreviousWorkspaceAnalysis(workspace: Workspace): Promise<WorkspaceAnalysis | undefined> {
  return (await readEnvelope(workspace))?.previous;
}

export async function savePersistentWorkspaceAnalysis(workspace: Workspace, analysis: WorkspaceAnalysis): Promise<void> {
  const filePath = persistentGraphPath(workspace);
  const existing = await readEnvelope(workspace);
  const previous = existing?.current && existing.current.fingerprint !== analysis.fingerprint ? existing.current : existing?.previous;
  const envelope: GraphStoreEnvelope = {
    schemaVersion: STORE_SCHEMA_VERSION,
    workspaceId: workspace.id,
    root: workspace.root,
    savedAt: new Date().toISOString(),
    current: analysis,
    ...(previous ? { previous } : {})
  };
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_BYTES) return;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tempPath, serialized, "utf8");
    await fsp.rename(tempPath, filePath);
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
