import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_APP_PLUGIN_CATALOG = Object.freeze([{
  id: "taste-skill",
  name: "Taste Skill",
  description: "Bộ skill thiết kế frontend, redesign và image-to-code cho GPT/Codex.",
  repository: "https://github.com/leonxlnx/taste-skill.git",
  homepage: "https://github.com/leonxlnx/taste-skill",
  branch: "main",
  adapter: "skill-library",
  license: "MIT"
}]);

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function scalar(frontmatter, key) {
  const match = String(frontmatter || "").match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));
  return String(match?.[1] || "").trim().replace(/^(['"])(.*)\1$/, "$2");
}

function readSkill(skillPath) {
  const content = fs.readFileSync(skillPath, "utf8");
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || "";
  const folder = path.basename(path.dirname(skillPath));
  return {
    id: folder,
    install_name: scalar(frontmatter, "name") || folder,
    description: scalar(frontmatter, "description"),
    content
  };
}

function readGeneratedManifest(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".codexpro-plugin", "plugin.json"), "utf8"));
  } catch {
    return null;
  }
}

export function createManagedAppPluginInstaller({ home, registry, templateRoot, catalog = DEFAULT_APP_PLUGIN_CATALOG }) {
  if (!registry || typeof registry.install !== "function") throw new Error("Managed plugin installer cần app plugin registry.");
  const resolvedHome = path.resolve(String(home || ""));
  const managedRoot = path.join(resolvedHome, "app-plugin-repos");
  const resolvedTemplateRoot = path.resolve(String(templateRoot || ""));
  const catalogById = new Map(catalog.map((item) => [String(item.id), { ...item }]));

  function definition(id) {
    const item = catalogById.get(String(id || ""));
    if (!item) throw new Error(`Plugin catalog ${id || "này"} không tồn tại.`);
    if (item.adapter !== "skill-library") throw new Error(`Adapter ${item.adapter || "unknown"} chưa được hỗ trợ.`);
    return item;
  }

  function pluginRoot(id) {
    const root = path.resolve(managedRoot, String(id || ""));
    if (!isPathInside(managedRoot, root) || root === managedRoot) throw new Error("Đường dẫn managed plugin không hợp lệ.");
    return root;
  }

  async function git(args, cwd) {
    try {
      return await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
      throw new Error(`Git plugin thất bại: ${detail}`);
    }
  }

  function generateTasteSkillAdapter(item, root, commit) {
    const skillsRoot = path.join(root, "skills");
    if (!fs.statSync(skillsRoot, { throwIfNoEntry: false })?.isDirectory()) throw new Error("Repo Taste Skill không có thư mục skills.");
    const skills = fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(skillsRoot, entry.name, "SKILL.md"))
      .filter((skillPath) => fs.statSync(skillPath, { throwIfNoEntry: false })?.isFile())
      .map(readSkill)
      .sort((left, right) => left.install_name.localeCompare(right.install_name, "en"));
    if (!skills.length) throw new Error("Repo Taste Skill không có SKILL.md hợp lệ.");

    const manifestRoot = path.join(root, ".codexpro-plugin");
    const distRoot = path.join(root, "dist");
    fs.mkdirSync(manifestRoot, { recursive: true });
    fs.mkdirSync(distRoot, { recursive: true });
    for (const fileName of ["index.html", "app.js", "styles.css"]) {
      fs.copyFileSync(path.join(resolvedTemplateRoot, fileName), path.join(distRoot, fileName));
    }
    const logoSource = path.join(root, "assets", "taste-skill-logo.webp");
    if (fs.statSync(logoSource, { throwIfNoEntry: false })?.isFile()) fs.copyFileSync(logoSource, path.join(distRoot, "logo.webp"));
    fs.writeFileSync(path.join(distRoot, "catalog.json"), `${JSON.stringify({
      schema_version: 1,
      id: item.id,
      name: item.name,
      description: item.description,
      repository: item.homepage || item.repository,
      source_commit: commit,
      generated_at: new Date().toISOString(),
      skills
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(manifestRoot, "plugin.json"), `${JSON.stringify({
      schema_version: 1,
      id: item.id,
      name: item.name,
      version: `1.0.0+${commit.slice(0, 12)}`,
      description: item.description,
      homepage: item.homepage || item.repository,
      source_repository: item.repository,
      source_commit: commit,
      license: item.license || "",
      ui_url: `codexpro-plugin://${item.id}/`,
      ui: { entry: "dist/index.html" }
    }, null, 2)}\n`, "utf8");
    return skills;
  }

  async function generateAndRegister(item, root) {
    const { stdout } = await git(["rev-parse", "HEAD"], root);
    const commit = String(stdout || "").trim();
    if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error("Không xác định được commit của plugin.");
    const skills = generateTasteSkillAdapter(item, root, commit);
    const plugin = registry.install(root);
    return { plugin, skill_count: skills.length, source_commit: commit };
  }

  return {
    listCatalog() {
      const installedById = new Map(registry.list().map((plugin) => [plugin.id, plugin]));
      return [...catalogById.values()].map((item) => {
        const root = pluginRoot(item.id);
        const installed = installedById.get(item.id);
        const manifest = readGeneratedManifest(root);
        return {
          ...item,
          installed: Boolean(installed),
          downloaded: fs.statSync(path.join(root, ".git"), { throwIfNoEntry: false })?.isDirectory() === true,
          status: installed?.status || "available",
          installed_version: installed?.version || "",
          source_commit: String(manifest?.source_commit || ""),
          skill_count: (() => {
            try { return JSON.parse(fs.readFileSync(path.join(root, "dist", "catalog.json"), "utf8")).skills?.length || 0; }
            catch { return 0; }
          })()
        };
      });
    },
    async install(id) {
      const item = definition(id);
      const root = pluginRoot(item.id);
      fs.mkdirSync(managedRoot, { recursive: true });
      if (!fs.statSync(path.join(root, ".git"), { throwIfNoEntry: false })?.isDirectory()) {
        if (fs.existsSync(root)) throw new Error(`Thư mục plugin đã tồn tại nhưng không phải Git repo: ${root}`);
        try {
          await git(["clone", "--depth", "1", "--single-branch", "--branch", item.branch || "main", item.repository, root], managedRoot);
        } catch (error) {
          if (isPathInside(managedRoot, root)) fs.rmSync(root, { recursive: true, force: true });
          throw error;
        }
      }
      return await generateAndRegister(item, root);
    },
    async update(id) {
      const item = definition(id);
      const root = pluginRoot(item.id);
      if (!fs.statSync(path.join(root, ".git"), { throwIfNoEntry: false })?.isDirectory()) throw new Error("Plugin chưa được tải; hãy cài trước.");
      await git(["pull", "--ff-only", "origin", item.branch || "main"], root);
      return await generateAndRegister(item, root);
    }
  };
}
