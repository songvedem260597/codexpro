import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_SKILLS = 32;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_CHARS = 500_000;
const MAX_BUNDLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function clean(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function selectedSkillIds(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("Hãy chọn ít nhất một skill.");
  if (value.length > MAX_SKILLS) throw new Error(`Chỉ được chọn tối đa ${MAX_SKILLS} skill cho một task.`);
  const ids = value.map((item) => clean(item, 120));
  if (ids.some((id) => !id)) throw new Error("Danh sách skill không hợp lệ.");
  if (new Set(ids).size !== ids.length) throw new Error("Danh sách skill bị trùng.");
  return ids;
}

function readCatalog(plugin) {
  const uiRoot = fs.realpathSync(plugin.ui_root);
  const catalogPath = path.resolve(uiRoot, "catalog.json");
  if (!pathInside(uiRoot, catalogPath)) throw new Error("Catalog plugin nằm ngoài thư mục giao diện.");
  const stat = fs.statSync(catalogPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`Plugin ${plugin.id} không cung cấp catalog skill.`);
  if (stat.size > MAX_CATALOG_BYTES) throw new Error("Catalog skill quá lớn để xử lý an toàn.");
  const realCatalogPath = fs.realpathSync(catalogPath);
  if (!pathInside(uiRoot, realCatalogPath)) throw new Error("Catalog plugin không được đi qua symlink ra ngoài.");
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(realCatalogPath, "utf8"));
  } catch (error) {
    throw new Error(`Không đọc được catalog skill: ${error?.message || error}`);
  }
  if (!Array.isArray(catalog?.skills)) throw new Error("Catalog plugin không có danh sách skill hợp lệ.");
  return catalog;
}

function normalizeCatalogSkill(item) {
  return {
    id: clean(item?.id, 120),
    name: clean(item?.install_name || item?.name || item?.id, 120),
    description: clean(item?.description, 2_000),
    content: String(item?.content || "").trim(),
    groupId: clean(item?.group_id || item?.groupId, 120),
    groupLabel: clean(item?.group_label || item?.groupLabel || item?.group_id || item?.groupId, 120),
    groupExclusive: item?.group_exclusive === true || item?.groupExclusive === true
  };
}

function resolveSkills(catalog, ids) {
  const byId = new Map(catalog.skills.map(normalizeCatalogSkill).filter((skill) => skill.id).map((skill) => [skill.id, skill]));
  const skills = ids.map((id) => {
    const skill = byId.get(id);
    if (!skill?.name || !skill.content) throw new Error(`Skill ${id} không còn tồn tại hoặc không có nội dung.`);
    return skill;
  });
  const exclusiveGroups = new Map();
  let contentLength = 0;
  for (const skill of skills) {
    contentLength += skill.content.length;
    if (contentLength > MAX_BUNDLE_CHARS) throw new Error("Tổng nội dung skill quá lớn để giao an toàn trong một task.");
    if (!skill.groupExclusive || !skill.groupId) continue;
    if (exclusiveGroups.has(skill.groupId)) throw new Error(`Nhóm “${skill.groupLabel || skill.groupId}” chỉ được chọn một skill.`);
    exclusiveGroups.set(skill.groupId, skill.id);
  }
  return skills;
}

function bundleMarkdown(plugin, catalog, skills) {
  const sections = skills.map((skill, index) => [
    `## Skill ${index + 1}: ${skill.name}`,
    skill.description ? `Mô tả: ${skill.description}` : "",
    "",
    skill.content
  ].filter(Boolean).join("\n"));
  return [
    "# CodexPro Plugin Skill Bundle",
    "",
    `Plugin: ${plugin.name} (${plugin.id})`,
    `Nguồn: ${clean(catalog.repository, 2_000) || "local plugin"}`,
    `Commit nguồn: ${clean(catalog.source_commit, 80) || "unknown"}`,
    `Số skill: ${skills.length}`,
    "",
    "Hãy đọc và áp dụng các skill theo thứ tự bên dưới. Nếu có xung đột, ưu tiên yêu cầu trực tiếp của người dùng rồi đến skill được liệt kê trước.",
    "",
    sections.join("\n\n---\n\n")
  ].join("\n");
}

function pruneOldBundles(root) {
  const now = Date.now();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(root, entry.name);
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (stat?.isFile() && now - stat.mtimeMs > MAX_BUNDLE_AGE_MS) fs.rmSync(filePath, { force: true });
  }
}

export function createPluginSkillBundle({ registry, home, pluginId, skillIds }) {
  const id = clean(pluginId, 64).toLowerCase();
  if (!PLUGIN_ID_PATTERN.test(id)) throw new Error("ID plugin không hợp lệ.");
  const ids = selectedSkillIds(skillIds);
  const plugin = registry.list().find((item) => item.id === id);
  if (!plugin || plugin.status !== "ready") throw new Error(`Plugin ${id} chưa sẵn sàng.`);
  const catalog = readCatalog(plugin);
  const skills = resolveSkills(catalog, ids);
  const markdown = bundleMarkdown(plugin, catalog, skills);
  const bundleRoot = path.resolve(String(home || ""), "app-plugin-task-bundles", id);
  fs.mkdirSync(bundleRoot, { recursive: true });
  pruneOldBundles(bundleRoot);
  const digest = createHash("sha256").update(`${id}\0${clean(catalog.source_commit, 80)}\0${ids.join("\0")}\0${markdown}`).digest("hex").slice(0, 20);
  const bundlePath = path.join(bundleRoot, `${id}-${digest}.md`);
  if (!fs.existsSync(bundlePath)) {
    const temporaryPath = `${bundlePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporaryPath, `${markdown}\n`, "utf8");
    try {
      fs.renameSync(temporaryPath, bundlePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      if (!fs.existsSync(bundlePath)) throw error;
    }
  }
  return {
    path: bundlePath,
    plugin_id: id,
    skill_ids: ids,
    skill_names: skills.map((skill) => skill.name),
    size: fs.statSync(bundlePath).size
  };
}
