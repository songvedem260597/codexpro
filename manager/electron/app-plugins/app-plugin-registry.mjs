import fs from "node:fs";
import path from "node:path";

const STORE_VERSION = 1;
const MANIFEST_RELATIVE_PATH = path.join(".codexpro-plugin", "plugin.json");
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".ttf", "font/ttf"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

function requiredText(value, label, maxLength = 160) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} không được để trống.`);
  if (normalized.length > maxLength) throw new Error(`${label} vượt quá ${maxLength} ký tự.`);
  return normalized;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Không đọc được ${filePath}: ${error?.message || error}`);
  }
}

function validatePlugin(repoRoot) {
  const resolvedRoot = path.resolve(requiredText(repoRoot, "Đường dẫn repo", 4096));
  if (!path.isAbsolute(resolvedRoot) || !fs.statSync(resolvedRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Repo plugin không tồn tại: ${resolvedRoot}`);
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const manifestPath = path.join(realRoot, MANIFEST_RELATIVE_PATH);
  const manifest = readJson(manifestPath);
  if (Number(manifest?.schema_version) !== 1) throw new Error("schema_version plugin phải là 1.");
  const id = requiredText(manifest?.id, "ID plugin", 64).toLowerCase();
  if (!PLUGIN_ID_PATTERN.test(id)) throw new Error("ID plugin chỉ được dùng chữ thường, số và dấu gạch ngang.");
  const name = requiredText(manifest?.name, "Tên plugin", 120);
  const version = requiredText(manifest?.version, "Phiên bản plugin", 64);
  const description = String(manifest?.description || "").trim().slice(0, 500);
  const entry = requiredText(manifest?.ui?.entry, "ui.entry", 1024);
  if (path.isAbsolute(entry)) throw new Error("ui.entry phải là đường dẫn tương đối trong repo.");
  const entryPath = path.resolve(realRoot, entry);
  if (!isPathInside(realRoot, entryPath)) throw new Error("ui.entry nằm ngoài repo plugin.");
  if (!fs.statSync(entryPath, { throwIfNoEntry: false })?.isFile()) throw new Error(`Không tìm thấy giao diện plugin: ${entry}`);
  if (path.extname(entryPath).toLowerCase() !== ".html") throw new Error("ui.entry phải trỏ tới một file HTML.");
  const realEntryPath = fs.realpathSync(entryPath);
  if (!isPathInside(realRoot, realEntryPath)) throw new Error("ui.entry không được đi qua symlink ra ngoài repo.");
  const uiRoot = path.dirname(realEntryPath);
  return {
    id,
    name,
    version,
    description,
    repo_root: realRoot,
    manifest_path: manifestPath,
    entry_path: realEntryPath,
    entry_file: path.basename(realEntryPath),
    ui_root: uiRoot,
    url: `codexpro-plugin://${id}/`,
    status: "ready",
    error: ""
  };
}

function normalizeStore(value) {
  if (!value || Number(value.version) !== STORE_VERSION || !Array.isArray(value.plugins)) {
    return { version: STORE_VERSION, plugins: [] };
  }
  const seen = new Set();
  const plugins = [];
  for (const item of value.plugins) {
    const id = String(item?.id || "").trim().toLowerCase();
    const repoRoot = String(item?.repo_root || "").trim();
    if (!PLUGIN_ID_PATTERN.test(id) || !repoRoot || seen.has(id)) continue;
    seen.add(id);
    plugins.push({ id, repo_root: repoRoot, installed_at: String(item?.installed_at || "") });
  }
  return { version: STORE_VERSION, plugins };
}

export function createAppPluginRegistry({ home }) {
  const registryHome = path.resolve(requiredText(home, "CodexPro home", 4096));
  const storePath = path.join(registryHome, "app-plugins.json");

  function readStore() {
    if (!fs.existsSync(storePath)) return { version: STORE_VERSION, plugins: [] };
    try {
      return normalizeStore(JSON.parse(fs.readFileSync(storePath, "utf8")));
    } catch {
      return { version: STORE_VERSION, plugins: [] };
    }
  }

  function writeStore(store) {
    fs.mkdirSync(registryHome, { recursive: true });
    const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalizeStore(store), null, 2)}\n`, "utf8");
    try {
      fs.renameSync(temporaryPath, storePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  function installedRecord(id) {
    const normalizedId = String(id || "").trim().toLowerCase();
    const record = readStore().plugins.find((item) => item.id === normalizedId);
    if (!record) throw new Error(`Plugin ${normalizedId || "này"} chưa được cài.`);
    return record;
  }

  function inspect(record) {
    try {
      const plugin = validatePlugin(record.repo_root);
      if (plugin.id !== record.id) throw new Error(`Manifest đã đổi ID từ ${record.id} thành ${plugin.id}.`);
      return { ...plugin, installed_at: record.installed_at };
    } catch (error) {
      return {
        id: record.id,
        name: record.id,
        version: "",
        description: "",
        repo_root: record.repo_root,
        url: "",
        status: "broken",
        error: String(error?.message || error),
        installed_at: record.installed_at
      };
    }
  }

  return {
    manifestRelativePath: MANIFEST_RELATIVE_PATH,
    storePath,
    list() {
      return readStore().plugins.map(inspect).sort((left, right) => left.name.localeCompare(right.name, "vi"));
    },
    install(repoRoot) {
      const plugin = validatePlugin(repoRoot);
      const store = readStore();
      const existing = store.plugins.find((item) => item.id === plugin.id);
      if (existing && path.resolve(existing.repo_root) !== path.resolve(plugin.repo_root)) {
        throw new Error(`Plugin ${plugin.id} đã được đăng ký từ repo khác. Hãy gỡ trước khi thay repo.`);
      }
      const installedAt = existing?.installed_at || new Date().toISOString();
      store.plugins = [
        ...store.plugins.filter((item) => item.id !== plugin.id),
        { id: plugin.id, repo_root: plugin.repo_root, installed_at: installedAt }
      ];
      writeStore(store);
      return { ...plugin, installed_at: installedAt };
    },
    uninstall(id) {
      const record = installedRecord(id);
      const store = readStore();
      store.plugins = store.plugins.filter((item) => item.id !== record.id);
      writeStore(store);
      return { id: record.id, repo_root: record.repo_root, removed: true, repo_preserved: true };
    },
    reload(id) {
      const record = installedRecord(id);
      const plugin = validatePlugin(record.repo_root);
      if (plugin.id !== record.id) throw new Error(`Manifest đã đổi ID từ ${record.id} thành ${plugin.id}.`);
      return { ...plugin, installed_at: record.installed_at, cache_bust: Date.now() };
    },
    resolveResource(id, requestPath) {
      const record = installedRecord(id);
      const plugin = validatePlugin(record.repo_root);
      if (plugin.id !== record.id) throw new Error(`Manifest đã đổi ID từ ${record.id} thành ${plugin.id}.`);
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(String(requestPath || "/").split("?")[0]);
      } catch {
        throw new Error("Đường dẫn tài nguyên plugin không hợp lệ.");
      }
      const relativePath = decodedPath === "/" || decodedPath === "" ? plugin.entry_file : decodedPath.replace(/^[/\\]+/, "");
      const candidate = path.resolve(plugin.ui_root, relativePath);
      if (!isPathInside(plugin.ui_root, candidate)) throw new Error("Tài nguyên nằm ngoài thư mục giao diện plugin.");
      if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) throw new Error(`Không tìm thấy tài nguyên plugin: ${relativePath}`);
      const realCandidate = fs.realpathSync(candidate);
      if (!isPathInside(plugin.ui_root, realCandidate)) throw new Error("Tài nguyên nằm ngoài thư mục giao diện plugin.");
      return {
        path: realCandidate,
        mime_type: MIME_TYPES.get(path.extname(realCandidate).toLowerCase()) || "application/octet-stream"
      };
    }
  };
}
