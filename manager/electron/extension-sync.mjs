import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEXPRO_EXTENSION_ID = "gndipignbnipohooclcbhjliikamjlpl";

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function versionAtLeast(version, target) {
  const current = String(version || "").split(".").map(Number);
  const required = String(target || "").split(".").map(Number);
  const length = Math.max(current.length, required.length);
  for (let index = 0; index < length; index += 1) {
    const left = Number.isFinite(current[index]) ? current[index] : 0;
    const right = Number.isFinite(required[index]) ? required[index] : 0;
    if (left !== right) return left > right;
  }
  return true;
}

export function defaultChromeUserDataRoot() {
  if (process.env.CODEXPRO_CHROME_USER_DATA_DIR) return path.resolve(process.env.CODEXPRO_CHROME_USER_DATA_DIR);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");
  }
  return path.join(os.homedir(), ".config", "google-chrome");
}

function resolveInstalledPath(rawPath, profileRoot, userDataRoot) {
  const value = String(rawPath || "").trim();
  if (!value) return "";
  if (path.isAbsolute(value)) return path.resolve(value);
  const profileRelative = path.resolve(profileRoot, value);
  if (fs.existsSync(profileRelative)) return profileRelative;
  return path.resolve(userDataRoot, value);
}

export function discoverUnpackedCodexProExtensions({
  userDataRoot = defaultChromeUserDataRoot(),
  extensionId = CODEXPRO_EXTENSION_ID
} = {}) {
  const root = path.resolve(userDataRoot);
  if (!fs.existsSync(root)) return [];
  const installations = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profileRoot = path.join(root, entry.name);
    for (const preferencesName of ["Secure Preferences", "Preferences"]) {
      const preferences = readJson(path.join(profileRoot, preferencesName), null);
      const setting = preferences?.extensions?.settings?.[extensionId];
      if (!setting || typeof setting !== "object") continue;
      const installedPath = resolveInstalledPath(setting.path, profileRoot, root);
      if (!installedPath) continue;
      if (setting.location != null && Number(setting.location) !== 4) continue;
      const key = installedPath.toLowerCase();
      const existing = installations.get(key) || {
        path: installedPath,
        profileDirectories: [],
        preferencesFiles: []
      };
      if (!existing.profileDirectories.includes(entry.name)) existing.profileDirectories.push(entry.name);
      const preferencesFile = path.join(profileRoot, preferencesName);
      if (!existing.preferencesFiles.includes(preferencesFile)) existing.preferencesFiles.push(preferencesFile);
      installations.set(key, existing);
    }
  }

  return [...installations.values()];
}

function extensionManifest(extensionRoot) {
  return readJson(path.join(extensionRoot, "manifest.json"), null);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function validCodexProTarget(sourceManifest, targetManifest) {
  if (!sourceManifest || !targetManifest) return false;
  if (sourceManifest.key && targetManifest.key && sourceManifest.key !== targetManifest.key) return false;
  return String(targetManifest.name || "").trim() === String(sourceManifest.name || "").trim();
}

async function pruneBackups(backupsRoot, keep = 4) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(backupsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const directories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(backupsRoot, entry.name);
    try {
      const stat = await fs.promises.stat(fullPath);
      directories.push({ path: fullPath, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  directories.sort((left, right) => right.mtimeMs - left.mtimeMs);
  await Promise.all(directories.slice(keep).map((entry) => fs.promises.rm(entry.path, { recursive: true, force: true }).catch(() => {})));
}

export async function syncUnpackedCodexProExtensions({
  sourceRoot,
  targetVersion,
  codexProHome,
  userDataRoot = defaultChromeUserDataRoot(),
  extensionId = CODEXPRO_EXTENSION_ID
} = {}) {
  const source = path.resolve(String(sourceRoot || ""));
  const sourceManifest = extensionManifest(source);
  if (!sourceManifest) throw new Error(`Không đọc được manifest worker nguồn tại ${source}.`);
  const expectedVersion = String(targetVersion || sourceManifest.version || "").trim();
  if (!expectedVersion) throw new Error("Worker nguồn không có version hợp lệ.");
  if (!versionAtLeast(sourceManifest.version, expectedVersion)) {
    throw new Error(`Worker nguồn đang ở ${sourceManifest.version || "unknown"}, thấp hơn bản cần dùng ${expectedVersion}.`);
  }

  const installations = discoverUnpackedCodexProExtensions({ userDataRoot, extensionId });
  const outdated = [];
  const skipped = [];
  for (const installation of installations) {
    const targetManifest = extensionManifest(installation.path);
    if (!validCodexProTarget(sourceManifest, targetManifest)) {
      skipped.push({ ...installation, reason: "invalid_target", version: targetManifest?.version || "" });
      continue;
    }
    if (samePath(source, installation.path) || versionAtLeast(targetManifest?.version, expectedVersion)) {
      skipped.push({ ...installation, reason: samePath(source, installation.path) ? "source_path" : "up_to_date", version: targetManifest?.version || "" });
      continue;
    }
    outdated.push({ ...installation, version: targetManifest?.version || "" });
  }

  if (!outdated.length) {
    return {
      ok: true,
      sourceRoot: source,
      sourceVersion: sourceManifest.version,
      targetVersion: expectedVersion,
      discovered: installations.length,
      synced: [],
      skipped
    };
  }

  const backupsRoot = path.join(path.resolve(codexProHome || path.join(os.homedir(), ".codexpro")), "worker-extension-backups");
  const backupDir = path.join(backupsRoot, `${Date.now()}-${String(expectedVersion).replace(/[^0-9A-Za-z._-]/g, "_")}`);
  await fs.promises.mkdir(backupDir, { recursive: true });

  const synced = [];
  for (let index = 0; index < outdated.length; index += 1) {
    const installation = outdated[index];
    const backupTarget = path.join(backupDir, `target-${index + 1}`);
    await fs.promises.cp(installation.path, backupTarget, { recursive: true, force: true, dereference: false });
    await fs.promises.writeFile(
      path.join(backupTarget, ".codexpro-backup.json"),
      `${JSON.stringify({ originalPath: installation.path, version: installation.version, backedUpAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );
    await fs.promises.cp(source, installation.path, { recursive: true, force: true, dereference: false });
    const refreshedManifest = extensionManifest(installation.path);
    if (!validCodexProTarget(sourceManifest, refreshedManifest) || !versionAtLeast(refreshedManifest?.version, expectedVersion)) {
      throw new Error(`Đã chép worker mới vào ${installation.path} nhưng manifest vẫn chưa đạt ${expectedVersion}.`);
    }
    synced.push({
      path: installation.path,
      fromVersion: installation.version,
      toVersion: refreshedManifest.version,
      profileDirectories: installation.profileDirectories,
      backupPath: backupTarget
    });
  }

  await pruneBackups(backupsRoot);
  return {
    ok: true,
    sourceRoot: source,
    sourceVersion: sourceManifest.version,
    targetVersion: expectedVersion,
    discovered: installations.length,
    synced,
    skipped,
    backupDir
  };
}
