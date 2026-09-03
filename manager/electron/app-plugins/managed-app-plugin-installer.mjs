import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TASTE_SKILL_GROUPS = Object.freeze({
  "design-taste-frontend": { id: "design-foundation", label: "Nền thiết kế", order: 10, exclusive: true },
  "design-taste-frontend-v1": { id: "design-foundation", label: "Nền thiết kế", order: 10, exclusive: true },
  "gpt-taste": { id: "design-foundation", label: "Nền thiết kế", order: 10, exclusive: true },
  "high-end-visual-design": { id: "visual-direction", label: "Phong cách", order: 20, exclusive: true },
  "minimalist-ui": { id: "visual-direction", label: "Phong cách", order: 20, exclusive: true },
  "industrial-brutalist-ui": { id: "visual-direction", label: "Phong cách", order: 20, exclusive: true },
  "redesign-existing-projects": { id: "implementation-workflow", label: "Quy trình triển khai", order: 30, exclusive: false },
  "image-to-code": { id: "implementation-workflow", label: "Quy trình triển khai", order: 30, exclusive: false },
  "full-output-enforcement": { id: "support", label: "Bổ trợ", order: 40, exclusive: false },
  "stitch-design-taste": { id: "support", label: "Bổ trợ", order: 40, exclusive: false },
  "imagegen-frontend-web": { id: "image-generation", label: "Tạo hình ảnh", order: 50, exclusive: false },
  "imagegen-frontend-mobile": { id: "image-generation", label: "Tạo hình ảnh", order: 50, exclusive: false },
  "brandkit": { id: "image-generation", label: "Tạo hình ảnh", order: 50, exclusive: false }
});

const TASTE_SKILL_SUMMARIES_VI = Object.freeze({
  "design-taste-frontend": "Thiết kế và viết giao diện web cao cấp, tránh kiểu AI rập khuôn; phù hợp landing page, portfolio và redesign.",
  "design-taste-frontend-v1": "Bản quy tắc thiết kế cũ để giữ tương thích với dự án đang dùng hành vi của phiên bản v1.",
  "gpt-taste": "Tạo giao diện giàu chuyển động GSAP, bố cục AIDA sáng tạo và kiểm soát chặt chữ, khoảng cách, lưới bento.",
  "high-end-visual-design": "Nâng thẩm mỹ lên kiểu agency cao cấp với font, khoảng cách, bóng, thẻ và chuyển động được chuẩn hóa.",
  "minimalist-ui": "Phong cách tối giản, sạch, thiên biên tập với màu ấm, bố cục phẳng và ít hiệu ứng nặng.",
  "industrial-brutalist-ui": "Phong cách công nghiệp, thô và tương phản mạnh; hợp dashboard dữ liệu, portfolio hoặc giao diện cá tính.",
  "redesign-existing-projects": "Rà soát và nâng cấp giao diện dự án có sẵn mà vẫn giữ nguyên chức năng và framework hiện tại.",
  "image-to-code": "Tạo ảnh thiết kế tham chiếu trước, phân tích kỹ rồi viết giao diện bám sát hình ảnh đó.",
  "full-output-enforcement": "Yêu cầu worker xuất đầy đủ code và nội dung, tránh placeholder hoặc tự rút gọn giữa chừng.",
  "stitch-design-taste": "Tạo file DESIGN.md cho Google Stitch để thống nhất chữ, màu sắc, bố cục và chuyển động.",
  "imagegen-frontend-web": "Tạo ảnh thiết kế riêng cho từng phần của website, dùng chung bảng màu để lập trình lại chính xác.",
  "imagegen-frontend-mobile": "Tạo concept nhiều màn hình app mobile đồng nhất trong mockup điện thoại cao cấp; chỉ tạo ảnh, không viết code.",
  "brandkit": "Tạo bộ nhận diện thương hiệu gồm logo, guideline, mockup và bảng định hướng hình ảnh cao cấp."
});

export const DEFAULT_APP_PLUGIN_CATALOG = Object.freeze([{
  id: "taste-skill",
  name: "Taste Skill",
  description: "Bộ skill thiết kế frontend, redesign và image-to-code cho GPT/Codex.",
  repository: "https://github.com/leonxlnx/taste-skill.git",
  homepage: "https://github.com/leonxlnx/taste-skill",
  branch: "main",
  adapter: "skill-library",
  license: "MIT"
}, {
  id: "gitdiagram",
  name: "GitDiagram",
  description: "Rút repo local thành sơ đồ kiến trúc tổng quát, dễ đọc, dựa trên CodexGraph và ý tưởng architecture-first của GitDiagram.",
  repository: "https://github.com/ahmedkhaleel2004/gitdiagram.git",
  homepage: "https://github.com/ahmedkhaleel2004/gitdiagram",
  branch: "main",
  adapter: "gitdiagram-local",
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
  const installName = scalar(frontmatter, "name") || folder;
  const group = TASTE_SKILL_GROUPS[installName] || { id: "other", label: "Khác", order: 90, exclusive: false };
  return {
    id: folder,
    install_name: installName,
    description: scalar(frontmatter, "description"),
    summary_vi: TASTE_SKILL_SUMMARIES_VI[installName] || "Skill bổ trợ từ thư viện Taste Skill; hãy đọc mô tả gốc để biết phạm vi áp dụng.",
    content,
    group_id: group.id,
    group_label: group.label,
    group_order: group.order,
    group_exclusive: group.exclusive
  };
}

function readGeneratedManifest(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".codexpro-plugin", "plugin.json"), "utf8"));
  } catch {
    return null;
  }
}

export function createManagedAppPluginInstaller({ home, registry, templateRoot, gitDiagramTemplateRoot, catalog = DEFAULT_APP_PLUGIN_CATALOG }) {
  if (!registry || typeof registry.install !== "function") throw new Error("Managed plugin installer cần app plugin registry.");
  const resolvedHome = path.resolve(String(home || ""));
  const managedRoot = path.join(resolvedHome, "app-plugin-repos");
  const resolvedTemplateRoot = path.resolve(String(templateRoot || ""));
  const resolvedGitDiagramTemplateRoot = path.resolve(String(gitDiagramTemplateRoot || templateRoot || ""));
  const catalogById = new Map(catalog.map((item) => [String(item.id), { ...item }]));

  function definition(id) {
    const item = catalogById.get(String(id || ""));
    if (!item) throw new Error(`Plugin catalog ${id || "này"} không tồn tại.`);
    if (!["skill-library", "gitdiagram-local"].includes(item.adapter)) throw new Error(`Adapter ${item.adapter || "unknown"} chưa được hỗ trợ.`);
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
      .sort((left, right) => left.group_order - right.group_order || left.install_name.localeCompare(right.install_name, "en"));
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

  function generateGitDiagramAdapter(item, root, commit) {
    if (!fs.statSync(resolvedGitDiagramTemplateRoot, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Không tìm thấy template GitDiagram: ${resolvedGitDiagramTemplateRoot}`);
    }
    const manifestRoot = path.join(root, ".codexpro-plugin");
    const uiRoot = path.join(manifestRoot, "ui");
    fs.mkdirSync(uiRoot, { recursive: true });
    for (const fileName of ["index.html", "app.js", "styles.css"]) {
      fs.copyFileSync(path.join(resolvedGitDiagramTemplateRoot, fileName), path.join(uiRoot, fileName));
    }
    fs.writeFileSync(path.join(uiRoot, "meta.json"), `${JSON.stringify({
      schema_version: 1,
      id: item.id,
      name: item.name,
      description: item.description,
      repository: item.homepage || item.repository,
      source_commit: commit,
      license: item.license || "",
      adapter: item.adapter,
      generated_at: new Date().toISOString()
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
      adapter: item.adapter,
      ui_url: `codexpro-plugin://${item.id}/`,
      ui: { entry: ".codexpro-plugin/ui/index.html" }
    }, null, 2)}\n`, "utf8");
    return [];
  }

  async function generateAndRegister(item, root) {
    const { stdout } = await git(["rev-parse", "HEAD"], root);
    const commit = String(stdout || "").trim();
    if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error("Không xác định được commit của plugin.");
    const skills = item.adapter === "skill-library"
      ? generateTasteSkillAdapter(item, root, commit)
      : generateGitDiagramAdapter(item, root, commit);
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
          skill_count: item.adapter === "skill-library" ? (() => {
            try { return JSON.parse(fs.readFileSync(path.join(root, "dist", "catalog.json"), "utf8")).skills?.length || 0; }
            catch { return 0; }
          })() : 0
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
