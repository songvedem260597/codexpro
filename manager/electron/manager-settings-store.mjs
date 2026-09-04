import { dialog } from "electron";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ALL_ALLOWED_WORKSPACES = "__codexpro_all_allowed__";

const MANAGER_FONT_CHOICES = new Set(["system", "be-vietnam-pro", "manrope", "jetbrains-mono", "arial", "tahoma", "verdana", "trebuchet", "georgia", "cascadia"]);
const MANAGER_WORKING_BORDER_STYLES = new Set(["shine", "beam", "mint"]);
const WORKER_IMAGE_STATES = new Set(["idle", "working", "hung"]);
const WORKER_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_WORKER_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_APP_BACKGROUND_BYTES = 25 * 1024 * 1024;
const MAX_WORKER_IMAGE_PACKS = 20;
const DEFAULT_WORKER_PACK_ID = "default";
const MAX_GLOBAL_RULES_CHARS = 30000;
const DEFAULT_GLOBAL_RULES = `# CodexPro Global Rules

<!-- Rule trong file này áp dụng cho mọi repo/dự án được thao tác qua MCP CodexPro. -->
<!-- Thêm hoặc sửa rule bên dưới. Không lưu password, token hoặc API key trong file này. -->

- Đọc và tuân thủ file này trước khi đọc rule riêng của từng repo/dự án.
- Rule riêng của repo có thể bổ sung chi tiết nhưng không được âm thầm bỏ qua rule toàn cục này.
`;

function emptyWorkerImages() {
  return { idle: "", working: "", hung: "" };
}

function normalizeWorkerImages(value) {
  return {
    idle: String(value?.idle || ""),
    working: String(value?.working || ""),
    hung: String(value?.hung || "")
  };
}

function normalizeWorkerPacks(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((pack) => {
    const id = String(pack?.id || "").trim();
    const name = String(pack?.name || "").trim().slice(0, 60);
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(id) || id === DEFAULT_WORKER_PACK_ID || !name || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name, images: normalizeWorkerImages(pack?.images) }];
  }).slice(0, MAX_WORKER_IMAGE_PACKS);
}

export function createManagerSettingsStore({ home, mimeTypeForFile }) {
  const codexProHome = path.resolve(home);
  const managerSettingsFile = path.join(codexProHome, "manager-settings.json");
  const globalRulesFile = path.join(codexProHome, "CODEXPRO.md");
  const managerAssetsDir = path.join(codexProHome, "manager-assets");

  function normalizeGlobalRules(value) {
    return String(value ?? "").replace(/\r\n/g, "\n").slice(0, MAX_GLOBAL_RULES_CHARS);
  }

  function readGlobalRulesFile() {
    try {
      return normalizeGlobalRules(fs.readFileSync(globalRulesFile, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") return DEFAULT_GLOBAL_RULES;
      fs.mkdirSync(codexProHome, { recursive: true });
      fs.writeFileSync(globalRulesFile, DEFAULT_GLOBAL_RULES, "utf8");
      return DEFAULT_GLOBAL_RULES;
    }
  }

  function writeGlobalRulesFile(value) {
    const rules = normalizeGlobalRules(value);
    fs.mkdirSync(codexProHome, { recursive: true });
    fs.writeFileSync(globalRulesFile, rules.endsWith("\n") || !rules ? rules : `${rules}\n`, "utf8");
    return rules;
  }

  function defaultManagerSettings() {
    return {
      chatWidth: 940,
      chatHeight: 330,
      showChatConversationSelector: true,
      fontFamily: "system",
      headingFontFamily: "inherit",
      monoFontFamily: "inherit",
      fontSize: 14,
      fontWeight: 400,
      profileLayout: "rows",
      profileCardHeight: 390,
      workingBorderStyle: "shine",
      maxSubagents: 1,
      autoRecovery: false,
      autoUpdateWorkers: false,
      taskNotifications: true,
      appBackground: "",
      appBackgroundBlur: 6,
      appBackgroundDim: 54,
      globalRules: readGlobalRulesFile(),
      repoSelections: {},
      selectedWorkerPackId: DEFAULT_WORKER_PACK_ID,
      workerImagePacks: [],
      workerImages: emptyWorkerImages()
    };
  }

  function readManagerSettings() {
    const defaults = defaultManagerSettings();
    try {
      const parsed = JSON.parse(fs.readFileSync(managerSettingsFile, "utf8"));
      const legacyImages = normalizeWorkerImages(parsed?.workerImages);
      const hasLegacyImages = Object.values(legacyImages).some(Boolean);
      const workerImagePacks = normalizeWorkerPacks(parsed?.workerImagePacks);
      if (!workerImagePacks.length && hasLegacyImages) {
        workerImagePacks.push({ id: "legacy-custom", name: "Bộ tùy chỉnh hiện tại", images: legacyImages });
      }
      const requestedPackId = String(parsed?.selectedWorkerPackId || "");
      const selectedWorkerPackId = requestedPackId === DEFAULT_WORKER_PACK_ID || workerImagePacks.some((pack) => pack.id === requestedPackId)
        ? requestedPackId
        : (workerImagePacks[0]?.id || DEFAULT_WORKER_PACK_ID);
      const selectedPack = workerImagePacks.find((pack) => pack.id === selectedWorkerPackId);
      return {
        chatWidth: Math.max(720, Math.min(1600, Number(parsed?.chatWidth) || defaults.chatWidth)),
        chatHeight: Math.max(180, Math.min(700, Number(parsed?.chatHeight) || defaults.chatHeight)),
        showChatConversationSelector: parsed?.showChatConversationSelector !== false,
        fontFamily: MANAGER_FONT_CHOICES.has(String(parsed?.fontFamily || "")) ? String(parsed.fontFamily) : defaults.fontFamily,
        headingFontFamily: parsed?.headingFontFamily === "inherit" || MANAGER_FONT_CHOICES.has(String(parsed?.headingFontFamily || "")) ? String(parsed.headingFontFamily) : defaults.headingFontFamily,
        monoFontFamily: parsed?.monoFontFamily === "inherit" || MANAGER_FONT_CHOICES.has(String(parsed?.monoFontFamily || "")) ? String(parsed.monoFontFamily) : defaults.monoFontFamily,
        fontSize: Math.max(12, Math.min(18, Number(parsed?.fontSize) || defaults.fontSize)),
        fontWeight: Math.max(400, Math.min(700, Math.round((Number(parsed?.fontWeight) || defaults.fontWeight) / 100) * 100)),
        profileLayout: parsed?.profileLayout === "cards" ? "cards" : defaults.profileLayout,
        profileCardHeight: Math.max(390, Math.min(760, Math.round((Number(parsed?.profileCardHeight) || defaults.profileCardHeight) / 10) * 10)),
        workingBorderStyle: MANAGER_WORKING_BORDER_STYLES.has(String(parsed?.workingBorderStyle || "")) ? String(parsed.workingBorderStyle) : defaults.workingBorderStyle,
        maxSubagents: Math.max(1, Math.min(1, Number(parsed?.maxSubagents) || defaults.maxSubagents)),
        autoRecovery: parsed?.autoRecovery === true,
        autoUpdateWorkers: parsed?.autoUpdateWorkers === true,
        taskNotifications: parsed?.taskNotifications !== false,
        appBackground: typeof parsed?.appBackground === "string" ? parsed.appBackground : defaults.appBackground,
        appBackgroundBlur: Number.isFinite(Number(parsed?.appBackgroundBlur)) ? Math.max(0, Math.min(24, Number(parsed.appBackgroundBlur))) : defaults.appBackgroundBlur,
        appBackgroundDim: Number.isFinite(Number(parsed?.appBackgroundDim)) ? Math.max(0, Math.min(85, Number(parsed.appBackgroundDim))) : defaults.appBackgroundDim,
        globalRules: readGlobalRulesFile(),
        repoSelections: Object.fromEntries(Object.entries(parsed?.repoSelections && typeof parsed.repoSelections === "object" ? parsed.repoSelections : {})
          .filter(([profileId, root]) => /^[A-Za-z0-9._-]{1,160}$/.test(profileId) && typeof root === "string" && root.trim())
          .slice(0, 40)
          .map(([profileId, root]) => [profileId, root === ALL_ALLOWED_WORKSPACES ? ALL_ALLOWED_WORKSPACES : path.resolve(root)])),
        selectedWorkerPackId,
        workerImagePacks,
        workerImages: selectedPack ? { ...selectedPack.images } : emptyWorkerImages()
      };
    } catch {
      return defaults;
    }
  }

  function writeManagerSettings(settings) {
    fs.mkdirSync(codexProHome, { recursive: true });
    const { globalRules, ...storedSettings } = settings;
    writeGlobalRulesFile(globalRules);
    fs.writeFileSync(managerSettingsFile, `${JSON.stringify(storedSettings, null, 2)}\n`, "utf8");
  }

  function imageDataUrl(filePath, maxBytes = MAX_WORKER_IMAGE_BYTES) {
    if (!filePath) return "";
    try {
      const resolved = path.resolve(filePath);
      const extension = path.extname(resolved).toLowerCase();
      if (!WORKER_IMAGE_EXTENSIONS.has(extension)) return "";
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size > maxBytes) return "";
      const mimeType = mimeTypeForFile(resolved);
      return `data:${mimeType};base64,${fs.readFileSync(resolved).toString("base64")}`;
    } catch {
      return "";
    }
  }

  function managerSettingsPayload() {
    const settings = readManagerSettings();
    const workerImagePacks = settings.workerImagePacks.map((pack) => ({
      ...pack,
      images: { ...pack.images },
      imageDataUrls: {
        idle: imageDataUrl(pack.images.idle),
        working: imageDataUrl(pack.images.working),
        hung: imageDataUrl(pack.images.hung)
      }
    }));
    return {
      ...settings,
      appBackgroundDataUrl: imageDataUrl(settings.appBackground, MAX_APP_BACKGROUND_BYTES),
      workerImagePacks,
      workerImageDataUrls: {
        idle: imageDataUrl(settings.workerImages.idle),
        working: imageDataUrl(settings.workerImages.working),
        hung: imageDataUrl(settings.workerImages.hung)
      }
    };
  }

  function saveManagerSettingsPatch(patch = {}) {
    const current = readManagerSettings();
    const next = {
      ...current,
      workerImages: { ...current.workerImages },
      workerImagePacks: current.workerImagePacks.map((pack) => ({ ...pack, images: { ...pack.images } }))
    };
    if (Object.prototype.hasOwnProperty.call(patch, "chatWidth")) {
      next.chatWidth = Math.max(720, Math.min(1600, Number(patch.chatWidth) || current.chatWidth));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "chatHeight")) {
      next.chatHeight = Math.max(180, Math.min(700, Number(patch.chatHeight) || current.chatHeight));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "showChatConversationSelector")) {
      next.showChatConversationSelector = patch.showChatConversationSelector !== false;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "fontFamily") && MANAGER_FONT_CHOICES.has(String(patch.fontFamily))) {
      next.fontFamily = String(patch.fontFamily);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "headingFontFamily") && (patch.headingFontFamily === "inherit" || MANAGER_FONT_CHOICES.has(String(patch.headingFontFamily)))) {
      next.headingFontFamily = String(patch.headingFontFamily);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "monoFontFamily") && (patch.monoFontFamily === "inherit" || MANAGER_FONT_CHOICES.has(String(patch.monoFontFamily)))) {
      next.monoFontFamily = String(patch.monoFontFamily);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "fontSize")) {
      next.fontSize = Math.max(12, Math.min(18, Number(patch.fontSize) || current.fontSize));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "fontWeight")) {
      next.fontWeight = Math.max(400, Math.min(700, Math.round((Number(patch.fontWeight) || current.fontWeight) / 100) * 100));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "profileLayout")) {
      next.profileLayout = patch.profileLayout === "cards" ? "cards" : "rows";
    }
    if (Object.prototype.hasOwnProperty.call(patch, "profileCardHeight")) {
      next.profileCardHeight = Math.max(390, Math.min(760, Math.round((Number(patch.profileCardHeight) || current.profileCardHeight) / 10) * 10));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "workingBorderStyle") && MANAGER_WORKING_BORDER_STYLES.has(String(patch.workingBorderStyle))) {
      next.workingBorderStyle = String(patch.workingBorderStyle);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "maxSubagents")) {
      next.maxSubagents = Math.max(1, Math.min(1, Number(patch.maxSubagents) || current.maxSubagents));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "autoRecovery")) next.autoRecovery = patch.autoRecovery === true;
    if (Object.prototype.hasOwnProperty.call(patch, "autoUpdateWorkers")) next.autoUpdateWorkers = patch.autoUpdateWorkers === true;
    if (Object.prototype.hasOwnProperty.call(patch, "taskNotifications")) next.taskNotifications = patch.taskNotifications !== false;
    if (Object.prototype.hasOwnProperty.call(patch, "appBackgroundBlur")) next.appBackgroundBlur = Math.max(0, Math.min(24, Number(patch.appBackgroundBlur) || 0));
    if (Object.prototype.hasOwnProperty.call(patch, "appBackgroundDim")) next.appBackgroundDim = Math.max(0, Math.min(85, Number(patch.appBackgroundDim) || 0));
    if (Object.prototype.hasOwnProperty.call(patch, "globalRules")) {
      next.globalRules = normalizeGlobalRules(patch.globalRules);
    }
    if (patch?.repoSelections && typeof patch.repoSelections === "object") {
      next.repoSelections = { ...(current.repoSelections || {}) };
      for (const [profileId, root] of Object.entries(patch.repoSelections)) {
        if (!/^[A-Za-z0-9._-]{1,160}$/.test(profileId)) continue;
        if (typeof root === "string" && root.trim()) next.repoSelections[profileId] = root === ALL_ALLOWED_WORKSPACES ? ALL_ALLOWED_WORKSPACES : path.resolve(root);
        else delete next.repoSelections[profileId];
      }
    }
    writeManagerSettings(next);
    return managerSettingsPayload();
  }

  function findWorkerPack(settings, packId) {
    const normalizedPackId = String(packId || "");
    if (normalizedPackId === DEFAULT_WORKER_PACK_ID) throw new Error("Hãy tạo một bộ ảnh riêng trước khi tải ảnh lên.");
    const pack = settings.workerImagePacks.find((item) => item.id === normalizedPackId);
    if (!pack) throw new Error("Không tìm thấy bộ ảnh worker.");
    return pack;
  }

  function createWorkerImagePack(name) {
    const normalizedName = String(name || "").trim().slice(0, 60);
    if (!normalizedName) throw new Error("Tên bộ ảnh không được để trống.");
    const settings = readManagerSettings();
    if (settings.workerImagePacks.length >= MAX_WORKER_IMAGE_PACKS) throw new Error(`Chỉ được tạo tối đa ${MAX_WORKER_IMAGE_PACKS} bộ ảnh worker.`);
    const id = `pack-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    settings.workerImagePacks.push({ id, name: normalizedName, images: emptyWorkerImages() });
    settings.selectedWorkerPackId = id;
    settings.workerImages = emptyWorkerImages();
    writeManagerSettings(settings);
    return managerSettingsPayload();
  }

  function selectWorkerImagePack(packId) {
    const settings = readManagerSettings();
    const normalizedPackId = String(packId || "");
    const pack = normalizedPackId === DEFAULT_WORKER_PACK_ID
      ? null
      : settings.workerImagePacks.find((item) => item.id === normalizedPackId);
    if (normalizedPackId !== DEFAULT_WORKER_PACK_ID && !pack) throw new Error("Không tìm thấy bộ ảnh worker.");
    settings.selectedWorkerPackId = normalizedPackId;
    settings.workerImages = pack ? { ...pack.images } : emptyWorkerImages();
    writeManagerSettings(settings);
    return managerSettingsPayload();
  }

  function removeManagedWorkerImage(filePath) {
    if (!filePath) return;
    const resolved = path.resolve(filePath);
    if (path.dirname(resolved) === path.resolve(managerAssetsDir)) fs.rmSync(resolved, { force: true });
  }

  function deleteWorkerImagePack(packId) {
    const settings = readManagerSettings();
    const normalizedPackId = String(packId || "");
    const index = settings.workerImagePacks.findIndex((pack) => pack.id === normalizedPackId);
    if (index < 0) throw new Error("Không tìm thấy bộ ảnh worker.");
    const [removed] = settings.workerImagePacks.splice(index, 1);
    Object.values(removed.images).forEach(removeManagedWorkerImage);
    if (settings.selectedWorkerPackId === normalizedPackId) {
      settings.selectedWorkerPackId = DEFAULT_WORKER_PACK_ID;
      settings.workerImages = emptyWorkerImages();
    }
    writeManagerSettings(settings);
    return managerSettingsPayload();
  }

  async function chooseWorkerImage(packId, state) {
    const normalizedState = String(state || "");
    if (!WORKER_IMAGE_STATES.has(normalizedState)) throw new Error("Trạng thái worker không hợp lệ.");
    const settings = readManagerSettings();
    const pack = findWorkerPack(settings, packId);
    const result = await dialog.showOpenDialog({
      title: `Chọn ảnh worker ${normalizedState}`,
      properties: ["openFile"],
      filters: [{ name: "Ảnh worker", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]
    });
    if (result.canceled || !result.filePaths[0]) return managerSettingsPayload();
    const source = path.resolve(result.filePaths[0]);
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new Error("Ảnh worker không hợp lệ.");
    if (stat.size > MAX_WORKER_IMAGE_BYTES) throw new Error("Ảnh worker được tối đa 10 MB.");
    const extension = path.extname(source).toLowerCase();
    if (!WORKER_IMAGE_EXTENSIONS.has(extension)) throw new Error("Chỉ hỗ trợ PNG, JPG, GIF hoặc WEBP.");
    fs.mkdirSync(managerAssetsDir, { recursive: true });
    const previousPath = pack.images[normalizedState];
    const destination = path.join(managerAssetsDir, `worker-${pack.id}-${normalizedState}${extension}`);
    if (path.resolve(source) !== path.resolve(destination)) {
      for (const candidate of fs.readdirSync(managerAssetsDir, { withFileTypes: true })) {
        if (candidate.isFile() && candidate.name.startsWith(`worker-${pack.id}-${normalizedState}.`)) {
          fs.rmSync(path.join(managerAssetsDir, candidate.name), { force: true });
        }
      }
      fs.copyFileSync(source, destination);
    }
    if (previousPath && path.resolve(previousPath) !== path.resolve(destination)) removeManagedWorkerImage(previousPath);
    pack.images[normalizedState] = destination;
    settings.selectedWorkerPackId = pack.id;
    settings.workerImages = { ...pack.images };
    writeManagerSettings(settings);
    return managerSettingsPayload();
  }

  function resetWorkerImage(packId, state) {
    const normalizedState = String(state || "");
    if (!WORKER_IMAGE_STATES.has(normalizedState)) throw new Error("Trạng thái worker không hợp lệ.");
    const settings = readManagerSettings();
    const pack = findWorkerPack(settings, packId);
    const currentPath = pack.images[normalizedState];
    pack.images[normalizedState] = "";
    settings.selectedWorkerPackId = pack.id;
    settings.workerImages = { ...pack.images };
    writeManagerSettings(settings);
    removeManagedWorkerImage(currentPath);
    return managerSettingsPayload();
  }

  async function chooseAppBackground() {
    const result = await dialog.showOpenDialog({
      title: "Chọn hình nền CodexPro",
      properties: ["openFile"],
      filters: [{ name: "Hình nền", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]
    });
    if (result.canceled || !result.filePaths[0]) return managerSettingsPayload();
    const source = path.resolve(result.filePaths[0]);
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new Error("Hình nền không hợp lệ.");
    if (stat.size > MAX_APP_BACKGROUND_BYTES) throw new Error("Hình nền được tối đa 25 MB.");
    const extension = path.extname(source).toLowerCase();
    if (!WORKER_IMAGE_EXTENSIONS.has(extension)) throw new Error("Chỉ hỗ trợ PNG, JPG, GIF hoặc WEBP.");
    fs.mkdirSync(managerAssetsDir, { recursive: true });
    const settings = readManagerSettings();
    const previousPath = settings.appBackground;
    const destination = path.join(managerAssetsDir, `app-background${extension}`);
    if (path.resolve(source) !== path.resolve(destination)) {
      for (const candidate of fs.readdirSync(managerAssetsDir, { withFileTypes: true })) {
        if (candidate.isFile() && candidate.name.startsWith("app-background.")) fs.rmSync(path.join(managerAssetsDir, candidate.name), { force: true });
      }
      fs.copyFileSync(source, destination);
    }
    if (previousPath && path.resolve(previousPath) !== path.resolve(destination)) removeManagedWorkerImage(previousPath);
    settings.appBackground = destination;
    writeManagerSettings(settings);
    return managerSettingsPayload();
  }

  function resetAppBackground() {
    const settings = readManagerSettings();
    const currentPath = settings.appBackground;
    settings.appBackground = "";
    writeManagerSettings(settings);
    removeManagedWorkerImage(currentPath);
    return managerSettingsPayload();
  }

  function resetManagerSettings() {
    const current = readManagerSettings();
    for (const pack of current.workerImagePacks || []) Object.values(pack.images || {}).forEach(removeManagedWorkerImage);
    removeManagedWorkerImage(current.appBackground);
    const defaults = { ...defaultManagerSettings(), repoSelections: { ...(current.repoSelections || {}) } };
    writeManagerSettings(defaults);
    return managerSettingsPayload();
  }

  return {
    readManagerSettings,
    managerSettingsPayload,
    saveManagerSettingsPatch,
    createWorkerImagePack,
    selectWorkerImagePack,
    deleteWorkerImagePack,
    chooseWorkerImage,
    resetWorkerImage,
    chooseAppBackground,
    resetAppBackground,
    resetManagerSettings
  };
}
