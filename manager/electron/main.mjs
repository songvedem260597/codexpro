import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, shell } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const codexProHome = process.env.CODEXPRO_HOME
  ? path.resolve(process.env.CODEXPRO_HOME)
  : path.join(os.homedir(), ".codexpro");
const tokenFileDefault = path.join(codexProHome, "http-token");
const managerProjectsFile = path.join(codexProHome, "manager-projects.json");
const managerSettingsFile = path.join(codexProHome, "manager-settings.json");
const managerAssetsDir = path.join(codexProHome, "manager-assets");
const MAX_REQUEST_ATTACHMENTS = 4;
const MAX_REQUEST_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_ATTACHMENTS_TOTAL_BYTES = 10 * 1024 * 1024;
const WORKER_EXTENSION_VERSION = "0.5.27";
const RUNTIME_BASE_CACHE_MS = 10000;
const REPO_SCAN_CACHE_MS = 60000;
const REPO_SCAN_MAX_DIRECTORIES = 50000;
const REPO_SCAN_MAX_DEPTH = 12;
const REPO_SCAN_TIMEOUT_MS = 12000;
let runtimeBaseCache = null;
let runtimeBasePromise = null;
let repoScanCache = null;
let repoScanPromise = null;

function versionAtLeast(version, target = WORKER_EXTENSION_VERSION) {
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

function mimeTypeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
    ".js": "text/javascript", ".jsx": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
    ".html": "text/html", ".css": "text/css", ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml",
    ".pdf": "application/pdf", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".zip": "application/zip"
  })[extension] || "application/octet-stream";
}

function requestFileSummary(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Không phải file hợp lệ: ${path.basename(resolved)}`);
  const mimeType = mimeTypeForFile(resolved);
  let previewDataUrl = "";
  if (mimeType.startsWith("image/")) {
    try {
      const image = nativeImage.createFromPath(resolved);
      if (!image.isEmpty()) {
        const { width, height } = image.getSize();
        const longest = Math.max(width, height, 1);
        const scale = Math.min(1, 96 / longest);
        const thumbnail = scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(width * scale)),
              height: Math.max(1, Math.round(height * scale)),
              quality: "good"
            })
          : image;
        previewDataUrl = thumbnail.toDataURL();
      }
    } catch {
      previewDataUrl = "";
    }
  }
  return { path: resolved, name: path.basename(resolved), size: stat.size, mimeType, previewDataUrl };
}

async function chooseRequestFiles() {
  const result = await dialog.showOpenDialog({
    title: "Chọn file gửi cùng yêu cầu",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Tài liệu, mã nguồn và hình ảnh", extensions: ["txt", "md", "csv", "json", "js", "jsx", "ts", "tsx", "html", "css", "xml", "yaml", "yml", "pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg", "gif", "webp", "zip"] },
      { name: "Tất cả file", extensions: ["*"] }
    ]
  });
  if (result.canceled) return [];
  if (result.filePaths.length > MAX_REQUEST_ATTACHMENTS) throw new Error("Mỗi yêu cầu được đính kèm tối đa 4 file.");
  const files = result.filePaths.map(requestFileSummary);
  if (files.some((file) => file.size > MAX_REQUEST_ATTACHMENT_BYTES)) throw new Error("Mỗi file được tối đa 8 MB.");
  if (files.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_ATTACHMENTS_TOTAL_BYTES) throw new Error("Tổng file đính kèm được tối đa 10 MB.");
  return files;
}

const MANAGER_FONT_CHOICES = new Set(["system", "arial", "tahoma", "verdana", "trebuchet", "georgia", "cascadia"]);
const WORKER_IMAGE_STATES = new Set(["idle", "working", "hung"]);
const WORKER_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_WORKER_IMAGE_BYTES = 10 * 1024 * 1024;

function defaultManagerSettings() {
  return { chatWidth: 940, chatHeight: 330, fontFamily: "system", repoSelections: {}, workerImages: { idle: "", working: "", hung: "" } };
}

function readManagerSettings() {
  const defaults = defaultManagerSettings();
  try {
    const parsed = JSON.parse(fs.readFileSync(managerSettingsFile, "utf8"));
    return {
      chatWidth: Math.max(720, Math.min(1600, Number(parsed?.chatWidth) || defaults.chatWidth)),
      chatHeight: Math.max(180, Math.min(700, Number(parsed?.chatHeight) || defaults.chatHeight)),
      fontFamily: MANAGER_FONT_CHOICES.has(String(parsed?.fontFamily || "")) ? String(parsed.fontFamily) : defaults.fontFamily,
      repoSelections: Object.fromEntries(Object.entries(parsed?.repoSelections && typeof parsed.repoSelections === "object" ? parsed.repoSelections : {})
        .filter(([profileId, root]) => /^[A-Za-z0-9._-]{1,160}$/.test(profileId) && typeof root === "string" && root.trim())
        .slice(0, 40)
        .map(([profileId, root]) => [profileId, path.resolve(root)])),
      workerImages: {
        idle: String(parsed?.workerImages?.idle || ""),
        working: String(parsed?.workerImages?.working || ""),
        hung: String(parsed?.workerImages?.hung || "")
      }
    };
  } catch {
    return defaults;
  }
}

function writeManagerSettings(settings) {
  fs.mkdirSync(codexProHome, { recursive: true });
  fs.writeFileSync(managerSettingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function imageDataUrl(filePath) {
  if (!filePath) return "";
  try {
    const resolved = path.resolve(filePath);
    const extension = path.extname(resolved).toLowerCase();
    if (!WORKER_IMAGE_EXTENSIONS.has(extension)) return "";
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_WORKER_IMAGE_BYTES) return "";
    const mimeType = mimeTypeForFile(resolved);
    return `data:${mimeType};base64,${fs.readFileSync(resolved).toString("base64")}`;
  } catch {
    return "";
  }
}

function managerSettingsPayload() {
  const settings = readManagerSettings();
  return {
    ...settings,
    workerImageDataUrls: {
      idle: imageDataUrl(settings.workerImages.idle),
      working: imageDataUrl(settings.workerImages.working),
      hung: imageDataUrl(settings.workerImages.hung)
    }
  };
}

function saveManagerSettingsPatch(patch = {}) {
  const current = readManagerSettings();
  const next = { ...current, workerImages: { ...current.workerImages } };
  if (Object.prototype.hasOwnProperty.call(patch, "chatWidth")) {
    next.chatWidth = Math.max(720, Math.min(1600, Number(patch.chatWidth) || current.chatWidth));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "chatHeight")) {
    next.chatHeight = Math.max(180, Math.min(700, Number(patch.chatHeight) || current.chatHeight));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "fontFamily") && MANAGER_FONT_CHOICES.has(String(patch.fontFamily))) {
    next.fontFamily = String(patch.fontFamily);
  }
  if (patch?.repoSelections && typeof patch.repoSelections === "object") {
    next.repoSelections = { ...(current.repoSelections || {}) };
    for (const [profileId, root] of Object.entries(patch.repoSelections)) {
      if (!/^[A-Za-z0-9._-]{1,160}$/.test(profileId)) continue;
      if (typeof root === "string" && root.trim()) next.repoSelections[profileId] = path.resolve(root);
      else delete next.repoSelections[profileId];
    }
  }
  writeManagerSettings(next);
  return managerSettingsPayload();
}

async function chooseWorkerImage(state) {
  const normalizedState = String(state || "");
  if (!WORKER_IMAGE_STATES.has(normalizedState)) throw new Error("Trạng thái worker không hợp lệ.");
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
  const destination = path.join(managerAssetsDir, `worker-${normalizedState}${extension}`);
  if (path.resolve(source) !== path.resolve(destination)) {
    for (const candidate of fs.readdirSync(managerAssetsDir, { withFileTypes: true })) {
      if (candidate.isFile() && candidate.name.startsWith(`worker-${normalizedState}.`)) {
        fs.rmSync(path.join(managerAssetsDir, candidate.name), { force: true });
      }
    }
    fs.copyFileSync(source, destination);
  }
  const settings = readManagerSettings();
  settings.workerImages[normalizedState] = destination;
  writeManagerSettings(settings);
  return managerSettingsPayload();
}

function resetWorkerImage(state) {
  const normalizedState = String(state || "");
  if (!WORKER_IMAGE_STATES.has(normalizedState)) throw new Error("Trạng thái worker không hợp lệ.");
  const settings = readManagerSettings();
  const currentPath = settings.workerImages[normalizedState];
  settings.workerImages[normalizedState] = "";
  writeManagerSettings(settings);
  if (currentPath && path.dirname(path.resolve(currentPath)) === path.resolve(managerAssetsDir)) {
    fs.rmSync(path.resolve(currentPath), { force: true });
  }
  return managerSettingsPayload();
}

function resetManagerSettings() {
  const current = readManagerSettings();
  for (const workerPath of Object.values(current.workerImages || {})) {
    if (workerPath && path.dirname(path.resolve(workerPath)) === path.resolve(managerAssetsDir)) fs.rmSync(path.resolve(workerPath), { force: true });
  }
  const defaults = { ...defaultManagerSettings(), repoSelections: { ...(current.repoSelections || {}) } };
  writeManagerSettings(defaults);
  return managerSettingsPayload();
}

async function clipboardImagePng() {
  if (typeof clipboard.readImage === "function") {
    const image = await Promise.resolve(clipboard.readImage());
    if (!image?.isEmpty?.()) return image.toPNG();
  }
  if (typeof clipboard.read === "function") {
    const items = await clipboard.read();
    for (const item of items || []) {
      const imageType = (item.types || []).find((type) => /^image\/(png|jpeg|jpg|webp)$/i.test(type));
      if (imageType) {
        const blob = await item.getType(imageType);
        if (blob instanceof Blob) {
          const buffer = Buffer.from(await blob.arrayBuffer());
          if (/^image\/png$/i.test(imageType)) return buffer;
          const image = nativeImage.createFromBuffer(buffer);
          if (!image.isEmpty()) return image.toPNG();
        }
      }
      if ((item.types || []).includes("text/uri-list")) {
        const blob = await item.getType("text/uri-list");
        if (!(blob instanceof Blob)) continue;
        const urls = (await blob.text()).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        for (const url of urls) {
          if (!url.startsWith("file://")) continue;
          const filePath = fileURLToPath(url);
          if (!/\.(png|jpe?g|gif|webp)$/i.test(filePath) || !fs.existsSync(filePath)) continue;
          const image = nativeImage.createFromBuffer(await fs.promises.readFile(filePath));
          if (!image.isEmpty()) return image.toPNG();
        }
      }
    }
  }
  return null;
}

async function captureClipboardImage() {
  const png = await clipboardImagePng();
  if (!png?.length) return null;
  if (png.length > MAX_REQUEST_ATTACHMENT_BYTES) throw new Error("Ảnh trong clipboard lớn quá 8 MB.");
  const directory = path.join(app.getPath("temp"), "codexpro-manager", "clipboard-images");
  await fs.promises.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `clipboard-${Date.now()}-${randomBytes(4).toString("hex")}.png`);
  await fs.promises.writeFile(filePath, png, { flag: "wx" });
  return requestFileSummary(filePath);
}

function createWindow() {
  const smokeMode = process.env.CODEXPRO_MANAGER_SMOKE === "1";
  const win = new BrowserWindow({
    width: smokeMode ? 1900 : 1240,
    height: smokeMode ? 1000 : 820,
    minWidth: 940,
    minHeight: 650,
    backgroundColor: "#090b10",
    title: "CodexPro Manager",
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.CODEXPRO_MANAGER_DEV_URL;
    if (allowed ? !url.startsWith(allowed) : !url.startsWith("file:")) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.once("ready-to-show", () => {
    if (!smokeMode) win.show();
  });
  const devUrl = process.env.CODEXPRO_MANAGER_DEV_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(here, "..", "dist", "index.html"), process.env.CODEXPRO_MANAGER_SMOKE_PAGE === "requests" ? { query: { page: "requests" } } : undefined);

  if (smokeMode) {
    win.webContents.once("did-finish-load", async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 2800));
        const bridge = await win.webContents.executeJavaScript("typeof window.codexpro", true);
        if (bridge !== "object") throw new Error(`Preload bridge unavailable: ${bridge}`);
        const status = await win.webContents.executeJavaScript("window.codexpro.getStatus().then((value) => JSON.parse(JSON.stringify(value)))", true);
        const projects = await win.webContents.executeJavaScript("window.codexpro.listProjects().then((value) => JSON.parse(JSON.stringify(value)))", true);
        let inspection = null;
        if (status.local?.ok && projects[0]?.root) {
          inspection = await win.webContents.executeJavaScript(`window.codexpro.inspectProject(${JSON.stringify(projects[0].root)})`, true);
        }
        let settingsProbe = null;
        const settingsSmokeRequested = process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS === "1" || process.env.CODEXPRO_MANAGER_SMOKE_PAGE === "settings";
        if (settingsSmokeRequested) {
          const beforeSettings = await win.webContents.executeJavaScript("window.codexpro.getManagerSettings().then((value) => JSON.parse(JSON.stringify(value)))", true);
          await win.webContents.executeJavaScript(`(() => {
            const button = [...document.querySelectorAll('nav button')].find((item) => /cài đặt/i.test(item.textContent || ''));
            button?.click();
            return Boolean(button);
          })()`, true);
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS === "1") {
            await win.webContents.executeJavaScript(`(async () => {
              const range = document.querySelector('.settings-range:not(.chat-height-range)');
              const heightRange = document.querySelector('.chat-height-range');
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              if (range) {
                setter?.call(range, '1180');
                range.dispatchEvent(new Event('input', { bubbles: true }));
                range.dispatchEvent(new Event('change', { bubbles: true }));
                range.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
              }
              if (heightRange) {
                setter?.call(heightRange, '520');
                heightRange.dispatchEvent(new Event('input', { bubbles: true }));
                heightRange.dispatchEvent(new Event('change', { bubbles: true }));
                heightRange.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
              const trigger = document.querySelector('.settings-dropdown-trigger');
              trigger?.click();
              await new Promise((resolve) => setTimeout(resolve, 80));
              const tahoma = [...document.querySelectorAll('.settings-dropdown-option')].find((item) => /Tahoma/i.test(item.textContent || ''));
              tahoma?.click();
            })()`, true);
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
          const afterSettings = await win.webContents.executeJavaScript("window.codexpro.getManagerSettings().then((value) => JSON.parse(JSON.stringify(value)))", true);
          let chatModalWidth = 0;
          let chatResponseHeight = 0;
          if (process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS === "1") {
            const chatButtonFound = await win.webContents.executeJavaScript(`(() => {
              const button = document.querySelector('.profile-chat:not(:disabled)');
              button?.click();
              return Boolean(button);
            })()`, true);
            if (chatButtonFound) {
              await new Promise((resolve) => setTimeout(resolve, 350));
              chatModalWidth = await win.webContents.executeJavaScript("Math.round(document.querySelector('.chat-modal')?.getBoundingClientRect().width || 0)", true);
              chatResponseHeight = await win.webContents.executeJavaScript("Math.round(document.querySelector('.chat-modal .chat-response.is-inline')?.getBoundingClientRect().height || 0)", true);
              await win.webContents.executeJavaScript("document.querySelector('.chat-modal-head > button')?.click()", true);
              await new Promise((resolve) => setTimeout(resolve, 120));
            }
          }
          const uiSettings = await win.webContents.executeJavaScript(`(() => {
            const settingsView = document.querySelector('.settings-view');
            const main = document.querySelector('main');
            return {
              settingsVisible: !settingsView?.hidden,
              rangeValue: document.querySelector('.settings-range:not(.chat-height-range)')?.value || '',
              heightRangeValue: document.querySelector('.chat-height-range')?.value || '',
              numberValue: document.querySelectorAll('.settings-number-field input')?.[0]?.value || '',
              heightNumberValue: document.querySelectorAll('.settings-number-field input')?.[1]?.value || '',
              fontValue: document.querySelector('.settings-dropdown-value strong')?.textContent?.trim() || '',
              workerCards: document.querySelectorAll('.worker-setting-card').length,
              settingsWidth: Math.round(settingsView?.getBoundingClientRect().width || 0),
              mainContentWidth: Math.round((main?.clientWidth || 0) - 100),
              chatWidthVar: document.querySelector('.app-shell')?.style.getPropertyValue('--chat-modal-width') || '',
              chatHeightVar: document.querySelector('.app-shell')?.style.getPropertyValue('--chat-response-height') || '',
              fontVar: document.querySelector('.app-shell')?.style.getPropertyValue('--app-font-family') || ''
            };
          })()`, true);
          settingsProbe = {
            ok: Boolean(uiSettings.settingsVisible) && Number(uiSettings.rangeValue) >= 720 && Number(uiSettings.heightRangeValue) >= 180 && uiSettings.workerCards === 3 && uiSettings.settingsWidth >= uiSettings.mainContentWidth - 4 && (process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS !== "1" || (afterSettings.chatWidth === 1180 && afterSettings.chatHeight === 520 && afterSettings.fontFamily === "tahoma" && /Tahoma/i.test(uiSettings.fontValue) && uiSettings.numberValue === "1180" && uiSettings.heightNumberValue === "520" && (!chatModalWidth || Math.abs(chatModalWidth - 1180) <= 3) && (!chatResponseHeight || Math.abs(chatResponseHeight - 520) <= 3))),
            before: { chatWidth: beforeSettings.chatWidth, chatHeight: beforeSettings.chatHeight, fontFamily: beforeSettings.fontFamily },
            saved: { chatWidth: afterSettings.chatWidth, chatHeight: afterSettings.chatHeight, fontFamily: afterSettings.fontFamily },
            chatModalWidth,
            chatResponseHeight,
            ui: uiSettings
          };
          if (process.env.CODEXPRO_MANAGER_SMOKE_SETTINGS === "1") {
            await win.webContents.executeJavaScript(`window.codexpro.saveManagerSettings(${JSON.stringify({ chatWidth: beforeSettings.chatWidth, chatHeight: beforeSettings.chatHeight, fontFamily: beforeSettings.fontFamily })})`, true);
          }
        }
        const chatSmokeRequested = [
          process.env.CODEXPRO_MANAGER_SMOKE_CHAT_MODAL,
          process.env.CODEXPRO_MANAGER_SMOKE_RENAME,
          process.env.CODEXPRO_MANAGER_SMOKE_DROPDOWN,
          process.env.CODEXPRO_MANAGER_SMOKE_RESPONSE,
          process.env.CODEXPRO_MANAGER_SMOKE_SEND,
          process.env.CODEXPRO_MANAGER_SMOKE_PASTE_IMAGE,
          process.env.CODEXPRO_MANAGER_SMOKE_REALTIME_RESPONSE
        ].some((value) => value === "1");
        let chatModalProbe = null;
        if (chatSmokeRequested) {
          const preferredProfile = String(process.env.CODEXPRO_MANAGER_SMOKE_SCROLL_PROFILE || "").trim();
          const clickProbe = await win.webContents.executeJavaScript(`(() => {
            const cards = [...document.querySelectorAll('.browser-profile')];
            const card = cards.find((item) => ${JSON.stringify(preferredProfile)} && item.querySelector('code')?.textContent?.includes(${JSON.stringify(preferredProfile)}))
              || cards.find((item) => !item.querySelector('.profile-chat')?.disabled);
            const button = card?.querySelector('.profile-chat:not(:disabled)');
            button?.click();
            return { cardFound: Boolean(card), buttonFound: Boolean(button), profile: card?.querySelector('code')?.textContent || '' };
          })()`, true);
          await new Promise((resolve) => setTimeout(resolve, 1400));
          chatModalProbe = await win.webContents.executeJavaScript(`(() => {
            const modal = document.querySelector('.chat-modal');
            return { open: Boolean(modal), profile: modal?.querySelector('.chat-modal-profile code')?.textContent || '', hasProjectDropdown: Boolean(modal?.querySelector('.project-dropdown')), selectedProject: modal?.querySelector('.project-dropdown-value strong')?.textContent?.trim() || '', hasChatSelector: Boolean(modal?.querySelector('.chat-dropdown, .chat-manage-actions')), hasResponse: Boolean(modal?.querySelector('.chat-response')), hasTextarea: Boolean(modal?.querySelector('textarea')) };
          })()`, true);
          chatModalProbe.click = clickProbe;
          await win.webContents.executeJavaScript("document.querySelector('.project-dropdown-trigger:not(:disabled)')?.click()", true);
          await new Promise((resolve) => setTimeout(resolve, 150));
          chatModalProbe.hasProjectSearch = await win.webContents.executeJavaScript("Boolean(document.querySelector('.project-dropdown-search input[type=search]'))", true);
          chatModalProbe.projectSearchStyle = await win.webContents.executeJavaScript(`(() => {
            const input = document.querySelector('.project-dropdown-search input[type=search]');
            if (!input) return null;
            input.focus();
            const style = getComputedStyle(input);
            return { borderWidth: style.borderWidth, boxShadow: style.boxShadow, outlineWidth: style.outlineWidth, backgroundColor: style.backgroundColor };
          })()`, true);
        }
        let renameProbe = null;
        if (process.env.CODEXPRO_MANAGER_SMOKE_RENAME === "1") {
          const renameTitle = String(process.env.CODEXPRO_MANAGER_SMOKE_RENAME_TITLE || "CodexPro rename UI probe").trim();
          renameProbe = await win.webContents.executeJavaScript(`(async () => {
            const modal = document.querySelector('.chat-modal');
            const button = [...(modal?.querySelectorAll('.chat-manage-actions button') || [])].find((item) => /đổi tên/i.test(item.textContent || ''));
            const beforeTitle = modal?.querySelector('.chat-dropdown-value strong')?.textContent?.trim() || '';
            if (!button || button.disabled) return { ok: false, error: 'Nút Đổi tên không bấm được.', beforeTitle };
            button.click();
            await new Promise((resolve) => setTimeout(resolve, 180));
            const input = modal.querySelector('.chat-rename-input');
            const save = modal.querySelector('.chat-rename-save');
            if (!input || !save) return { ok: false, error: 'Không mở được editor đổi tên.', beforeTitle };
            input.focus();
            const oldValue = input.value;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, ${JSON.stringify(renameTitle)});
            if (input._valueTracker) input._valueTracker.setValue(oldValue);
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(renameTitle)} }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 300));
            const currentSave = modal.querySelector('.chat-rename-save');
            const saveDisabledBeforeClick = Boolean(currentSave?.disabled);
            if (currentSave && !saveDisabledBeforeClick) currentSave.click();
            await new Promise((resolve) => setTimeout(resolve, 5200));
            const afterTitle = modal.querySelector('.chat-dropdown-value strong')?.textContent?.trim() || '';
            const toast = document.querySelector('.toast')?.textContent?.trim() || '';
            const error = modal.querySelector('.request-send-error')?.textContent?.trim() || document.querySelector('.alert')?.textContent?.trim() || '';
            return { ok: afterTitle === ${JSON.stringify(renameTitle)} && !error, beforeTitle, afterTitle, toast, error, saveDisabledBeforeClick, editorClosed: !modal.querySelector('.chat-rename-editor') };
          })()`, true);
        }
        if (process.env.CODEXPRO_MANAGER_SMOKE_DROPDOWN === "1") {
          await win.webContents.executeJavaScript("document.querySelector('.chat-dropdown-trigger:not(:disabled)')?.click()", true);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (process.env.CODEXPRO_MANAGER_SMOKE_RESPONSE === "1") {
          await win.webContents.executeJavaScript("if (!document.querySelector('.chat-response')) document.querySelector('.response-toggle:not(:disabled)')?.click()", true);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        let sendProbe = null;
        if (process.env.CODEXPRO_MANAGER_SMOKE_SEND === "1") {
          const sendConversationId = String(process.env.CODEXPRO_MANAGER_SMOKE_SEND_CONVERSATION_ID || "").trim();
          const sendText = String(process.env.CODEXPRO_MANAGER_SMOKE_SEND_TEXT || "CodexPro Manager UI send probe — trả lời OK.").trim();
          if (sendConversationId) {
            await win.webContents.executeJavaScript(`(async () => {
              const trigger = document.querySelector('.chat-dropdown-trigger:not(:disabled)');
              if (!trigger) return false;
              trigger.click();
              await new Promise((resolve) => setTimeout(resolve, 180));
              const option = document.querySelector('[data-conversation-id=${JSON.stringify(sendConversationId)}]');
              if (!option) return false;
              option.click();
              return true;
            })()`, true);
            await new Promise((resolve) => setTimeout(resolve, 1400));
          }
          sendProbe = await win.webContents.executeJavaScript(`(async () => {
            const cards = [...document.querySelectorAll('.request-card')];
            const card = cards.find((item) => {
              const textarea = item.querySelector('textarea');
              const button = item.querySelector('.request-card-actions .button.primary');
              return textarea && !textarea.disabled && button && !/đang trả lời/i.test(button.textContent || '');
            });
            if (!card) return { ok: false, error: 'Không có card rảnh để test gửi.' };
            const textarea = card.querySelector('textarea');
            const oldValue = textarea.value;
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            setter?.call(textarea, ${JSON.stringify(sendText)});
            if (textarea._valueTracker) textarea._valueTracker.setValue(oldValue);
            textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(sendText)} }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 350));
            const currentButton = card.querySelector('.request-card-actions .button.primary');
            if (!currentButton || currentButton.disabled) return { ok: false, error: 'Nút Gửi tin nhắn chưa sẵn sàng sau khi nhập.', textarea: card.querySelector('textarea')?.value || '' };
            currentButton.click();
            await new Promise((resolve) => setTimeout(resolve, 16000));
            const currentTextarea = card.querySelector('textarea');
            const toast = document.querySelector('.toast')?.textContent?.trim() || '';
            const error = card.querySelector('.request-send-error')?.textContent?.trim() || document.querySelector('.error-banner')?.textContent?.trim() || document.querySelector('.error')?.textContent?.trim() || '';
            const userMessages = [...card.querySelectorAll('.chat-transcript-message.is-user .user-message-text')].map((node) => node.textContent?.trim() || '').filter(Boolean);
            const userMessageVisible = userMessages.includes(${JSON.stringify(sendText)});
            return {
              ok: (currentTextarea?.value || '') === '' && !error && userMessageVisible,
              textarea: currentTextarea?.value || '',
              buttonText: card.querySelector('.request-card-actions .button.primary')?.textContent?.trim() || '',
              toast,
              error,
              userMessageVisible,
              userMessages: userMessages.slice(-5),
              conversationTitle: card.querySelector('.chat-dropdown-value strong')?.textContent?.trim() || ''
            };
          })()`, true);
        }
        let pasteProbe = null;
        if (process.env.CODEXPRO_MANAGER_SMOKE_PASTE_IMAGE === "1") {
          const previousImage = typeof clipboard.readImage === "function" ? await Promise.resolve(clipboard.readImage()) : null;
          const previousText = typeof clipboard.readText === "function" ? String(await Promise.resolve(clipboard.readText()) || "") : "";
          const sampleBitmap = Buffer.alloc(24 * 24 * 4);
          for (let index = 0; index < sampleBitmap.length; index += 4) {
            sampleBitmap[index] = 0x3f;
            sampleBitmap[index + 1] = 0x85;
            sampleBitmap[index + 2] = 0xff;
            sampleBitmap[index + 3] = 0xff;
          }
          const sample = nativeImage.createFromBitmap(sampleBitmap, { width: 24, height: 24, scaleFactor: 1 });
          try {
            if (typeof clipboard.writeImage === "function") await Promise.resolve(clipboard.writeImage(sample));
            else await clipboard.write([new ClipboardItem({ "image/png": new Blob([sample.toPNG()], { type: "image/png" }) })]);
            const pasteTargetReady = await win.webContents.executeJavaScript(`(() => {
              const card = [...document.querySelectorAll('.request-card')].find((item) => {
                const textarea = item.querySelector('textarea');
                return textarea && !textarea.disabled;
              });
              const textarea = card?.querySelector('textarea');
              textarea?.focus();
              return Boolean(textarea);
            })()`, true);
            if (!pasteTargetReady) pasteProbe = { ok: false, error: 'Không có textarea rảnh để test paste ảnh.' };
            else {
              win.webContents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] });
              win.webContents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: ["control"] });
              await new Promise((resolve) => setTimeout(resolve, 1400));
              pasteProbe = await win.webContents.executeJavaScript(`(() => {
                const card = [...document.querySelectorAll('.request-card')].find((item) => item.querySelector('textarea:focus'))
                  || [...document.querySelectorAll('.request-card')].find((item) => item.querySelector('textarea'));
                const textarea = card?.querySelector('textarea');
                const attachment = card?.querySelector('.request-file');
                attachment?.scrollIntoView({ block: 'center' });
                const thumbnail = attachment?.querySelector('img.request-file-image');
                return {
                  ok: Boolean(thumbnail),
                  attachment: attachment?.querySelector('.request-file-copy strong')?.textContent?.trim() || '',
                  hasThumbnail: Boolean(thumbnail),
                  thumbnailSource: Boolean(thumbnail?.getAttribute('src')?.startsWith('data:image/')),
                  toast: document.querySelector('.toast')?.textContent?.trim() || '',
                  error: card?.querySelector('.request-send-error')?.textContent?.trim() || '',
                  placeholder: textarea?.getAttribute('placeholder') || ''
                };
              })()`, true);
            }
          } finally {
            if (previousImage && !previousImage.isEmpty() && typeof clipboard.writeImage === "function") clipboard.writeImage(previousImage);
            else if (typeof clipboard.writeText === "function") clipboard.writeText(previousText || "");
          }
        }
        let openProfileProbe = null;
        const openProfilePrefix = String(process.env.CODEXPRO_MANAGER_SMOKE_OPEN_PROFILE || "").trim();
        if (openProfilePrefix) {
          const beforeProfile = status.browserProfiles?.find((item) => item.profile_id.startsWith(openProfilePrefix));
          const beforeActiveTab = beforeProfile?.conversation_tabs?.find((item) => item.active) || beforeProfile?.conversation_tabs?.[0];
          const expectedConversationId = String(beforeActiveTab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
          const expectedTitle = String(beforeActiveTab?.title || beforeProfile?.active_chat_title || "");
          const ui = await win.webContents.executeJavaScript(`(async () => {
            const card = [...document.querySelectorAll('.browser-profile')].find((item) => item.querySelector('code')?.textContent?.includes(${JSON.stringify(openProfilePrefix)}));
            const chatButton = card?.querySelector('.profile-chat');
            if (!chatButton) return { ok: false, error: 'Không tìm thấy nút Chat.' };
            chatButton.click();
            await new Promise((resolve) => setTimeout(resolve, 500));
            const modal = document.querySelector('.chat-modal');
            const button = modal?.querySelector('.request-card-actions .button.secondary');
            if (!button) return { ok: false, error: 'Không tìm thấy nút Mở Chrome trong popup.' };
            const disabledBefore = button.disabled;
            const textBefore = button.textContent?.trim() || '';
            button.click();
            await new Promise((resolve) => setTimeout(resolve, 7000));
            const currentButton = document.querySelector('.chat-modal .request-card-actions .button.secondary');
            return { ok: true, disabledBefore, textBefore, disabledAfter: currentButton?.disabled ?? null, textAfter: currentButton?.textContent?.trim() || '', error: document.querySelector('.alert')?.textContent?.trim() || '' };
          })()`, true);
          const afterStatus = await win.webContents.executeJavaScript("window.codexpro.getStatus().then((value) => JSON.parse(JSON.stringify(value)))", true);
          const afterProfile = afterStatus.browserProfiles?.find((item) => item.profile_id.startsWith(openProfilePrefix));
          const afterActiveTab = afterProfile?.conversation_tabs?.find((item) => item.active) || afterProfile?.conversation_tabs?.[0];
          const afterConversationId = String(afterActiveTab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
          let foreground = null;
          try {
            foreground = JSON.parse(await runPowerShell(`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CodexProSmokeForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$h=[CodexProSmokeForeground]::GetForegroundWindow()
[uint32]$processId=0
[CodexProSmokeForeground]::GetWindowThreadProcessId($h,[ref]$processId)|Out-Null
if($processId -gt 0){$p=Get-Process -Id $processId;[pscustomobject]@{process=$p.ProcessName;title=$p.MainWindowTitle;processId=$p.Id}|ConvertTo-Json -Compress}else{[pscustomobject]@{process='';title='';processId=0}|ConvertTo-Json -Compress}
`));
          } catch {}
          openProfileProbe = {
            ok: Boolean(ui?.ok) && !ui?.error && !ui?.disabledBefore && String(foreground?.process || '').toLowerCase() === 'chrome' && beforeProfile?.tab_count === afterProfile?.tab_count && (!expectedConversationId || expectedConversationId === afterConversationId),
            beforeTabCount: beforeProfile?.tab_count ?? null,
            afterTabCount: afterProfile?.tab_count ?? null,
            expectedConversationId,
            afterConversationId,
            expectedTitle,
            foreground,
            ui
          };
        }
        let realtimeProbe = null;
        if (process.env.CODEXPRO_MANAGER_SMOKE_REALTIME_RESPONSE === "1") {
          const preferredProfile = String(process.env.CODEXPRO_MANAGER_SMOKE_SCROLL_PROFILE || "").trim();
          const profile = status.browserProfiles?.find((item) => preferredProfile && item.profile_id.startsWith(preferredProfile) && item.connected)
            || status.browserProfiles?.find((item) => item.connected && item.activity === "working" && item.conversation_tabs?.some((tab) => tab.busy));
          const tab = profile?.conversation_tabs?.find((item) => item.busy) || profile?.conversation_tabs?.find((item) => item.active);
          const conversationId = String(tab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
          if (profile?.profile_id && conversationId) {
            const started = Date.now();
            const response = await win.webContents.executeJavaScript(`window.codexpro.getProfileResponse(${JSON.stringify({ profileId: profile.profile_id, conversationId })}).then((value) => JSON.parse(JSON.stringify(value)))`, true);
            await new Promise((resolve) => setTimeout(resolve, 1800));
            const ui = await win.webContents.executeJavaScript(`(() => {
              const modal = document.querySelector('.chat-modal');
              const card = modal?.querySelector('.request-card');
              const modalProfile = modal?.querySelector('.chat-modal-profile code')?.textContent || '';
              if (!card || !modalProfile.includes(${JSON.stringify(profile.profile_id)})) return { text: '', status: '', found: false };
              return { found: true, text: card.querySelector('.chat-message-text')?.textContent || '', status: card.querySelector('.chat-response-head strong')?.textContent || '', bulletCount: card.querySelectorAll('.response-bullets li').length, numberedCount: card.querySelectorAll('.response-numbered li').length };
            })()`, true);
            realtimeProbe = { ok: Boolean(response?.text) && Boolean(ui?.text), busy: Boolean(response?.busy), textLength: Number(response?.text_length || response?.text?.length || 0), uiTextLength: String(ui?.text || '').length, bulletCount: Number(ui?.bulletCount || 0), numberedCount: Number(ui?.numberedCount || 0), latencyMs: Date.now() - started, tail: String(response?.text || "").slice(-220), uiTail: String(ui?.text || '').slice(-220), uiStatus: ui?.status || '' };
          } else realtimeProbe = { ok: false, error: "Không có profile WORKING để test realtime." };
        }
        const workerUpdateProbe = await win.webContents.executeJavaScript(`(() => {
          const button = document.querySelector('.reload-all');
          return button ? { text: button.textContent?.trim() || '', disabled: Boolean(button.disabled), primary: button.classList.contains('primary'), title: button.getAttribute('title') || '' } : null;
        })()`, true);
        const activeChatTitleProbe = await win.webContents.executeJavaScript(`(() => [...document.querySelectorAll('.browser-profile')].map((card) => ({
          profile: card.querySelector('code')?.textContent?.trim() || '',
          repo: card.querySelector('.active-repo-chip')?.textContent?.trim() || '',
          hasLegacyChatTitle: Boolean(card.querySelector('.active-chat-chip')),
          metaStillHasChat: /(?:^|\\s)Chat:/i.test(card.querySelector('.profile-meta')?.textContent || '')
        })))()`, true);
        const scrollProfile = String(process.env.CODEXPRO_MANAGER_SMOKE_SCROLL_PROFILE || "").trim();
        if (scrollProfile) {
          await win.webContents.executeJavaScript(`(() => {
            const card = [...document.querySelectorAll('.request-card')].find((item) => item.querySelector('code')?.textContent?.includes(${JSON.stringify(scrollProfile)}));
            card?.scrollIntoView({ block: 'center' });
          })()`, true);
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        const screenshot = process.env.CODEXPRO_MANAGER_SMOKE_SCREENSHOT;
        if (screenshot) {
          win.show();
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        const image = await win.webContents.capturePage();
        if (screenshot) fs.writeFileSync(screenshot, image.toPNG());
        console.log(JSON.stringify({ ok: true, status, projectCount: projects.length, projectIdentityProbe: projects.slice(0, 20).map((project) => ({ name: project.name, localName: project.localName, repoFullName: project.repoFullName, activityAt: project.activityAt, activityTimestamp: project.activityTimestamp, activityKind: project.activityKind })), inspection: inspection ? { workspace_id: inspection.workspace_id, root: inspection.root } : null, settingsProbe, chatModalProbe, renameProbe, sendProbe, pasteProbe, openProfileProbe, realtimeProbe, workerUpdateProbe, activeChatTitleProbe }));
      } catch (error) {
        console.error(error instanceof Error ? error.stack || error.message : String(error));
        process.exitCode = 1;
      } finally {
        app.quit();
      }
    });
  }
}

async function runPowerShell(script) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
  );
  return stdout.trim();
}

function parseTaskArguments(args = "") {
  const value = String(args);
  const read = (name) => {
    const match = value.match(new RegExp(`--${name}\\s+(?:\"([^\"]+)\"|'([^']+)'|([^\\s]+))`, "i"));
    return match?.[1] || match?.[2] || match?.[3] || "";
  };
  const readAll = (name) => [...value.matchAll(new RegExp(`--${name}\\s+(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, "gi"))]
    .map((match) => match[1] || match[2] || match[3] || "")
    .filter(Boolean);
  return {
    root: read("root"),
    port: Number(read("port")) || 8793,
    hostname: read("hostname"),
    tokenFile: read("token-file") || tokenFileDefault,
    tunnel: read("tunnel") || "none",
    allowedRoots: readAll("allow-root"),
    allowHome: /(?:^|\s)--allow-home(?:\s|$)/i.test(value)
  };
}

async function scheduledTask() {
  const script = [
    "$t=Get-ScheduledTask -TaskName 'CodexPro' -ErrorAction Stop",
    "$i=Get-ScheduledTaskInfo -TaskName 'CodexPro'",
    "$a=$t.Actions | Select-Object -First 1",
    "$auto=(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'CodexPro Manager' -ErrorAction SilentlyContinue).'CodexPro Manager'",
    "$tr=@($t.Triggers | ForEach-Object { [pscustomobject]@{ type=$_.CimClass.CimClassName; id=$_.Id; interval=$_.Repetition.Interval; delay=$_.Delay } })",
    "[pscustomobject]@{ state=[string]$t.State; lastRunTime=if($i.LastRunTime){$i.LastRunTime.ToString('o')}else{$null}; lastTaskResult=$i.LastTaskResult; execute=$a.Execute; arguments=$a.Arguments; workingDirectory=$a.WorkingDirectory; triggers=$tr; autoStartCommand=$auto } | ConvertTo-Json -Depth 5 -Compress"
  ].join("; ");
  try {
    return JSON.parse(await runPowerShell(script));
  } catch (error) {
    return { state: "NotFound", error: error instanceof Error ? error.message : String(error), arguments: "" };
  }
}

function readToken(tokenFile) {
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

async function health(base, token) {
  if (!base) return { ok: false, status: 0, latency: 0, error: "Chưa có endpoint" };
  const started = Date.now();
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/healthz`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5500)
    });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok && body.ok === true,
      status: response.status,
      latency: Date.now() - started,
      data: body
    };
  } catch (error) {
    return { ok: false, status: 0, latency: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

function connectorLink(config, token) {
  if (!config.hostname || !token) return "";
  const base = config.hostname.includes("://") ? config.hostname : `https://${config.hostname}`;
  const url = new URL(base);
  url.pathname = "/mcp";
  url.search = "";
  url.searchParams.set("codexpro_token", token);
  return url.toString();
}

async function runtimeBaseStatus() {
  if (runtimeBaseCache && Date.now() - runtimeBaseCache.cachedAt < RUNTIME_BASE_CACHE_MS) return runtimeBaseCache.value;
  if (runtimeBasePromise) return runtimeBasePromise;
  runtimeBasePromise = (async () => {
    const task = await scheduledTask();
    const config = parseTaskArguments(task.arguments);
    const token = readToken(config.tokenFile);
    const localBase = `http://127.0.0.1:${config.port}`;
    const publicBase = config.hostname
      ? (config.hostname.includes("://") ? config.hostname : `https://${config.hostname}`).replace(/\/mcp\/?$/, "")
      : "";
    const [local, tunnel, processText] = await Promise.all([
      health(localBase, token),
      publicBase ? health(publicBase, token) : Promise.resolve({ ok: false, status: 0, latency: 0, error: "Không dùng public tunnel" }),
      runPowerShell("@((Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','cloudflared.exe') -and $_.CommandLine -match 'codexpro\\.mjs.*start|dist\\\\http\\.js|cloudflared.*codexpro' } | Select-Object ProcessId,Name,CommandLine)) | ConvertTo-Json -Depth 3 -Compress").catch(() => "[]")
    ]);
    let processes = [];
    try {
      const parsed = JSON.parse(processText || "[]");
      processes = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    } catch {
      processes = [];
    }
    const value = {
      task,
      config,
      token,
      local,
      tunnel,
      processes: processes.map((item) => ({ pid: item.ProcessId, name: item.Name })),
      mcpLink: connectorLink(config, token),
      tokenConfigured: Boolean(token),
      autoStart: Boolean(task.autoStartCommand)
    };
    runtimeBaseCache = { cachedAt: Date.now(), value };
    return value;
  })();
  try {
    return await runtimeBasePromise;
  } finally {
    runtimeBasePromise = null;
  }
}

async function runtimeStatus() {
  const base = await runtimeBaseStatus();
  const browserProfilesRaw = base.local.ok
    ? await listBrowserProfilesThroughMcp(base.config, base.token).catch(() => [])
    : [];
  const browserProfiles = await Promise.all(browserProfilesRaw.map(async (profile) => {
    const workspaceRoot = String(profile.current_workspace_root || "").trim();
    if (!workspaceRoot) return { ...profile, current_workspace_repo: "" };
    return { ...profile, current_workspace_repo: await githubRepoForRoot(workspaceRoot) };
  }));
  return {
    checkedAt: new Date().toISOString(),
    task: base.task,
    config: base.config,
    local: base.local,
    tunnel: base.tunnel,
    processes: base.processes,
    browserProfiles,
    mcpLink: base.mcpLink,
    tokenConfigured: base.tokenConfigured,
    autoStart: base.autoStart
  };
}

function jsonFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function managerProjects() {
  const value = readJson(managerProjectsFile);
  return Array.isArray(value?.roots) ? value.roots.filter((root) => typeof root === "string") : [];
}

function saveManagerProjects(roots) {
  fs.mkdirSync(codexProHome, { recursive: true });
  fs.writeFileSync(managerProjectsFile, `${JSON.stringify({ version: 1, roots }, null, 2)}\n`, { mode: 0o600 });
}

function githubRepoFromRemote(remoteUrl) {
  const value = String(remoteUrl || "").trim().replace(/\\/g, "/");
  if (!value) return "";
  const match = value.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2].replace(/\.git$/i, "")}` : "";
}

function repoIdentityFromRemote(remoteUrl) {
  const value = String(remoteUrl || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!value) return { officialName: "", repoFullName: "" };
  const githubRepo = githubRepoFromRemote(value);
  if (githubRepo) return { officialName: githubRepo.split("/").pop() || "", repoFullName: githubRepo };
  const withoutQuery = value.split(/[?#]/, 1)[0];
  const parts = withoutQuery.replace(/\.git$/i, "").split(/[/:]/).filter(Boolean);
  const officialName = parts.pop() || "";
  const owner = parts.pop() || "";
  return { officialName, repoFullName: owner ? `${owner}/${officialName}` : officialName };
}

const githubRepoCache = new Map();
async function githubRepoForRoot(root) {
  const normalizedRoot = path.resolve(String(root || ""));
  const cached = githubRepoCache.get(normalizedRoot.toLowerCase());
  if (cached && Date.now() - cached.at < 15_000) return cached.value;
  let value = "";
  try {
    const remote = await execFileAsync("git.exe", ["-C", normalizedRoot, "remote", "get-url", "origin"], { windowsHide: true });
    value = githubRepoFromRemote(remote.stdout.trim());
  } catch {}
  githubRepoCache.set(normalizedRoot.toLowerCase(), { at: Date.now(), value });
  return value;
}

async function gitSummary(root) {
  try {
    const { stdout: branchText } = await execFileAsync("git.exe", ["-C", root, "branch", "--show-current"], { windowsHide: true });
    const { stdout: statusText } = await execFileAsync("git.exe", ["-C", root, "status", "--porcelain"], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const { stdout: commitText } = await execFileAsync("git.exe", ["-C", root, "log", "-1", "--pretty=format:%h%x09%s%x09%cI"], { windowsHide: true });
    let remoteUrl = "";
    let upstream = "";
    let pushedAt = "";
    let remoteCommitAt = "";
    try {
      const remote = await execFileAsync("git.exe", ["-C", root, "remote", "get-url", "origin"], { windowsHide: true });
      remoteUrl = remote.stdout.trim();
    } catch {}
    try {
      const upstreamResult = await execFileAsync("git.exe", ["-C", root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { windowsHide: true });
      upstream = upstreamResult.stdout.trim();
      const [remoteCommit, pushReflog] = await Promise.allSettled([
        execFileAsync("git.exe", ["-C", root, "log", "-1", "--pretty=format:%cI", upstream], { windowsHide: true }),
        execFileAsync("git.exe", ["-C", root, "reflog", "show", "-1", "--format=%gI", upstream], { windowsHide: true })
      ]);
      if (remoteCommit.status === "fulfilled") remoteCommitAt = remoteCommit.value.stdout.trim();
      if (pushReflog.status === "fulfilled") pushedAt = pushReflog.value.stdout.trim();
    } catch {}
    const [hash = "", subject = "", date = ""] = commitText.trim().split("\t");
    const identity = repoIdentityFromRemote(remoteUrl);
    const latestActivity = [
      { kind: "commit", value: date, timestamp: Date.parse(date) || 0 },
      { kind: "push", value: pushedAt, timestamp: Date.parse(pushedAt) || 0 },
      { kind: "remote", value: remoteCommitAt, timestamp: Date.parse(remoteCommitAt) || 0 }
    ].sort((left, right) => right.timestamp - left.timestamp)[0];
    return {
      isGit: true,
      branch: branchText.trim() || "detached",
      changes: statusText.split(/\r?\n/).filter(Boolean).length,
      commit: { hash, subject, date },
      remoteUrl,
      upstream,
      pushedAt,
      remoteCommitAt,
      activityAt: latestActivity?.value || date,
      activityTimestamp: latestActivity?.timestamp || 0,
      activityKind: latestActivity?.kind || "commit",
      githubRepo: githubRepoFromRemote(remoteUrl),
      ...identity
    };
  } catch {
    return { isGit: false, branch: "", changes: 0, commit: null, remoteUrl: "", upstream: "", pushedAt: "", remoteCommitAt: "", activityAt: "", activityTimestamp: 0, activityKind: "", githubRepo: "", officialName: "", repoFullName: "" };
  }
}

const REPO_SCAN_SKIPPED_DIRECTORIES = new Set([
  "$recycle.bin", "system volume information", "windows", "program files", "program files (x86)", "programdata",
  "appdata", "node_modules", ".git", ".cache", ".gradle", ".idea", ".next", "dist", "build", "coverage", "vendor"
]);

function pathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function repoScanRoots(config) {
  const home = os.homedir();
  const requested = [config.root, ...(config.allowedRoots || []), ...(config.allowHome ? [home] : [])]
    .filter(Boolean)
    .map((root) => path.resolve(root));
  const roots = new Set();
  for (const root of requested) {
    if (!fs.existsSync(root)) continue;
    const parsed = path.parse(root);
    if (root.toLowerCase() === parsed.root.toLowerCase() && parsed.root.toLowerCase() === path.parse(home).root.toLowerCase()) {
      roots.add(root);
      roots.add(home);
      continue;
    }
    roots.add(root);
  }
  for (const folder of ["Desktop", "Documents", "Downloads", "Pictures", "Videos"]) {
    const candidate = path.join(home, folder);
    if (requested.some((allowed) => pathInside(candidate, allowed)) && fs.existsSync(candidate)) roots.add(candidate);
  }
  return [...roots];
}

async function discoverGitRepositories(scanRoots) {
  const cacheKey = [...scanRoots].map((root) => path.resolve(root).toLowerCase()).sort().join("|");
  if (repoScanCache?.key === cacheKey && Date.now() - repoScanCache.at < REPO_SCAN_CACHE_MS) return repoScanCache.roots;
  if (repoScanPromise?.key === cacheKey) return repoScanPromise.promise;
  const promise = (async () => {
    const started = Date.now();
    const queue = scanRoots.map((root) => ({ root: path.resolve(root), depth: 0 }));
    const visited = new Set();
    const repositories = new Set();
    let scanned = 0;
    while (queue.length && scanned < REPO_SCAN_MAX_DIRECTORIES && Date.now() - started < REPO_SCAN_TIMEOUT_MS) {
      const batch = queue.splice(0, 32).filter((item) => {
        const key = item.root.toLowerCase();
        if (visited.has(key)) return false;
        visited.add(key);
        return true;
      });
      const entriesByRoot = await Promise.all(batch.map(async (item) => {
        try { return { item, entries: await fs.promises.readdir(item.root, { withFileTypes: true }) }; }
        catch { return { item, entries: [] }; }
      }));
      for (const { item, entries } of entriesByRoot) {
        scanned += 1;
        if (entries.some((entry) => entry.name.toLowerCase() === ".git" && (entry.isDirectory() || entry.isFile()))) {
          repositories.add(item.root);
          continue;
        }
        if (item.depth >= REPO_SCAN_MAX_DEPTH) continue;
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || REPO_SCAN_SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
          queue.push({ root: path.join(item.root, entry.name), depth: item.depth + 1 });
        }
      }
    }
    const roots = [...repositories];
    repoScanCache = { key: cacheKey, at: Date.now(), roots };
    return roots;
  })();
  repoScanPromise = { key: cacheKey, promise };
  try { return await promise; }
  finally { if (repoScanPromise?.promise === promise) repoScanPromise = null; }
}

async function listProjects() {
  const task = await scheduledTask();
  const taskConfig = parseTaskArguments(task.arguments);
  const activeRoot = taskConfig.root;
  const sources = new Map();
  for (const file of jsonFiles(path.join(codexProHome, "profiles"))) {
    const profile = readJson(file);
    if (typeof profile?.root === "string") sources.set(path.resolve(profile.root), "CodexPro profile");
  }
  for (const file of jsonFiles(path.join(codexProHome, "runtime"))) {
    const runtime = readJson(file);
    if (typeof runtime?.root === "string") sources.set(path.resolve(runtime.root), "CodexPro runtime");
  }
  for (const root of managerProjects()) sources.set(path.resolve(root), sources.get(path.resolve(root)) || "Đã thêm");
  if (activeRoot) sources.set(path.resolve(activeRoot), "Đang chạy");
  const discoveredRoots = await discoverGitRepositories(repoScanRoots(taskConfig));
  for (const root of discoveredRoots) {
    const resolved = path.resolve(root);
    if (![...sources.keys()].some((known) => known.toLowerCase() === resolved.toLowerCase())) sources.set(resolved, "Tự quét");
  }

  const entries = [...sources];
  const projects = [];
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (nextIndex < entries.length) {
      const [root, source] = entries[nextIndex++];
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
      const summary = await gitSummary(root);
      const localName = path.basename(root);
      projects.push({
        root,
        localName,
        name: summary.officialName || localName,
        source,
        active: Boolean(activeRoot && path.resolve(activeRoot).toLowerCase() === root.toLowerCase()),
        ...summary
      });
    }
  }));
  return projects.sort((a, b) =>
    Number(b.activityTimestamp || 0) - Number(a.activityTimestamp || 0)
    || Number(b.changes > 0) - Number(a.changes > 0)
    || Number(b.active) - Number(a.active)
    || a.name.localeCompare(b.name)
  );
}

async function mcpRequest(url, token, body, sessionId, timeoutMs = 15000) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const nextSessionId = response.headers.get("mcp-session-id") || sessionId;
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/event-stream") && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";
        for (const event of events) {
          const data = event.split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!data) continue;
          const payload = JSON.parse(data);
          if (payload.error) throw new Error(payload.error.message || "MCP trả về lỗi");
          await reader.cancel().catch(() => {});
          return { payload, sessionId: nextSessionId };
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!buffer.trim()) return { payload: {}, sessionId: nextSessionId };
    const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data) return { payload: {}, sessionId: nextSessionId };
    const payload = JSON.parse(data);
    if (payload.error) throw new Error(payload.error.message || "MCP trả về lỗi");
    return { payload, sessionId: nextSessionId };
  }
  const text = await response.text();
  if (!text.trim()) return { payload: {}, sessionId: nextSessionId };
  const payload = JSON.parse(text);
  if (payload.error) throw new Error(payload.error.message || "MCP trả về lỗi");
  return { payload, sessionId: nextSessionId };
}

async function localMcpTool(config, token, toolName, args, timeoutMs = 15000) {
  const url = `http://127.0.0.1:${config.port}/mcp`;
  const debug = process.env.CODEXPRO_MANAGER_MCP_DEBUG === "1";
  if (debug) console.error(`[manager-mcp] ${toolName}: initialize`);
  const initialized = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "CodexPro Manager", version: "0.2.54" } }
  });
  const sessionId = initialized.sessionId;
  if (debug) console.error(`[manager-mcp] ${toolName}: initialized notification`);
  await mcpRequest(url, token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  if (debug) console.error(`[manager-mcp] ${toolName}: tools/call`);
  const called = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: toolName, arguments: args }
  }, sessionId, timeoutMs);
  if (debug) console.error(`[manager-mcp] ${toolName}: tools/call complete`);
  const result = called.payload.result;
  if (result?.isError) {
    const message = result.content?.find((item) => item.type === "text")?.text || "CodexPro MCP trả về lỗi.";
    throw new Error(message);
  }
  return result?.structuredContent || {};
}

async function listBrowserProfilesThroughMcp(config, token) {
  const result = await localMcpTool(config, token, "browser_control", { action: "list_profiles" });
  return Array.isArray(result.profiles) ? result.profiles : [];
}

async function setupChatGptProfile(profileId) {
  const id = String(profileId || "").trim();
  if (!id || id.length > 160 || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("Chrome profile id không hợp lệ.");
  const status = await runtimeStatus();
  if (!status.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  const profile = status.browserProfiles.find((item) => item.profile_id === id);
  if (!profile?.connected) throw new Error("Chrome profile này đang offline. Hãy mở Chrome và bật extension CodexPro.");
  if (!versionAtLeast(profile.extension_version)) {
    throw new Error(`Worker extension của profile này chưa phải bản ${WORKER_EXTENSION_VERSION}. Hãy bấm Update worker extension rồi thử lại.`);
  }
  const token = readToken(status.config.tokenFile);
  return await localMcpTool(status.config, token, "browser_control", {
    action: "setup_chatgpt",
    profile_id: id
  }, 305000);
}

async function checkChatGptProfile(profileId) {
  const id = String(profileId || "").trim();
  if (!id || id.length > 160 || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("Chrome profile id không hợp lệ.");
  const status = await runtimeStatus();
  if (!status.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  const profile = status.browserProfiles.find((item) => item.profile_id === id);
  if (!profile?.connected) throw new Error("Chrome profile này đang offline.");
  const token = readToken(status.config.tokenFile);
  return await localMcpTool(status.config, token, "browser_control", {
    action: "check_chatgpt",
    profile_id: id
  }, 65000);
}

async function focusChromeWindow(chatTitle) {
  const title = String(chatTitle || "").trim();
  if (!title) return { ok: false, reason: "missing_title" };
  const encodedTitle = Buffer.from(title, "utf8").toString("base64");
  const script = `
$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTitle}'))
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CodexProWindowFocus {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
$found=[IntPtr]::Zero
$foundTitle=''
for($attempt=0;$attempt -lt 45 -and $found -eq [IntPtr]::Zero;$attempt++){
  [CodexProWindowFocus]::EnumWindows({param($h,$l)
    if(-not [CodexProWindowFocus]::IsWindowVisible($h)){return $true}
    $sb=New-Object Text.StringBuilder 512
    [CodexProWindowFocus]::GetWindowText($h,$sb,$sb.Capacity)|Out-Null
    $windowTitle=$sb.ToString()
    if(-not $windowTitle){return $true}
    [uint32]$processId=0
    [CodexProWindowFocus]::GetWindowThreadProcessId($h,[ref]$processId)|Out-Null
    try{$process=Get-Process -Id $processId -ErrorAction Stop}catch{return $true}
    if($process.ProcessName -eq 'chrome' -and ($windowTitle -eq ($target+' - Google Chrome') -or $windowTitle.StartsWith($target+' - '))){
      $script:found=$h
      $script:foundTitle=$windowTitle
      return $false
    }
    return $true
  },[IntPtr]::Zero)|Out-Null
  if($found -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 100}
}
if($found -eq [IntPtr]::Zero){[pscustomobject]@{ok=$false;title=$target;reason='window_not_found'}|ConvertTo-Json -Compress;exit 0}

[uint32]$targetPid=0
$targetThread=[CodexProWindowFocus]::GetWindowThreadProcessId($found,[ref]$targetPid)
$currentThread=[CodexProWindowFocus]::GetCurrentThreadId()
$attachedTarget=$false
$attachedForeground=$false
for($attempt=0;$attempt -lt 4;$attempt++){
  [CodexProWindowFocus]::ShowWindowAsync($found,3)|Out-Null
  $foregroundBefore=[CodexProWindowFocus]::GetForegroundWindow()
  [uint32]$foregroundPid=0
  $foregroundThread=if($foregroundBefore -ne [IntPtr]::Zero){[CodexProWindowFocus]::GetWindowThreadProcessId($foregroundBefore,[ref]$foregroundPid)}else{0}
  if($foregroundThread -gt 0 -and $foregroundThread -ne $currentThread){$attachedForeground=[CodexProWindowFocus]::AttachThreadInput($currentThread,$foregroundThread,$true)}
  if($targetThread -gt 0 -and $targetThread -ne $currentThread){$attachedTarget=[CodexProWindowFocus]::AttachThreadInput($currentThread,$targetThread,$true)}
  [CodexProWindowFocus]::BringWindowToTop($found)|Out-Null
  [CodexProWindowFocus]::SetWindowPos($found,[IntPtr](-1),0,0,0,0,0x0053)|Out-Null
  [CodexProWindowFocus]::SetWindowPos($found,[IntPtr](-2),0,0,0,0,0x0053)|Out-Null
  [CodexProWindowFocus]::SetActiveWindow($found)|Out-Null
  [CodexProWindowFocus]::SetForegroundWindow($found)|Out-Null
  Start-Sleep -Milliseconds 160
  $foreground=[CodexProWindowFocus]::GetForegroundWindow()
  if($attachedTarget){[CodexProWindowFocus]::AttachThreadInput($currentThread,$targetThread,$false)|Out-Null;$attachedTarget=$false}
  if($attachedForeground){[CodexProWindowFocus]::AttachThreadInput($currentThread,$foregroundThread,$false)|Out-Null;$attachedForeground=$false}
  if($foreground -eq $found -and [CodexProWindowFocus]::IsZoomed($found)){break}
  Start-Sleep -Milliseconds 100
}
$foreground=[CodexProWindowFocus]::GetForegroundWindow()
$maximized=[CodexProWindowFocus]::IsZoomed($found)
$foregroundMatch=($foreground -eq $found)
[pscustomobject]@{ok=([bool]$foregroundMatch -and [bool]$maximized);activated=[bool]$foregroundMatch;maximized=[bool]$maximized;foreground_match=[bool]$foregroundMatch;title=$foundTitle;hwnd=$found.ToInt64();foreground=$foreground.ToInt64();target_pid=$targetPid}|ConvertTo-Json -Compress
`;
  try {
    return JSON.parse(await runPowerShell(script));
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function openProfileChat(payload) {
  const profileId = String(payload?.profileId || "").trim();
  const conversationId = String(payload?.conversationId || "").trim();
  const targetId = String(payload?.targetId ?? "").trim();
  const targetConversationId = String(payload?.targetConversationId || "").trim();
  const title = String(payload?.title || "").trim();
  if (!profileId || profileId.length > 160 || !/^[A-Za-z0-9._-]+$/.test(profileId)) throw new Error("Chrome profile id không hợp lệ.");
  if (conversationId && !/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) throw new Error("Đoạn chat đích không hợp lệ.");
  if (!targetId || !/^\d+$/.test(targetId)) throw new Error("Không tìm thấy tab Chrome của profile này.");

  const base = await runtimeBaseStatus();
  if (!base.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  const token = base.token;

  if (conversationId && targetConversationId !== conversationId) {
    await localMcpTool(base.config, token, "browser_control", {
      action: "navigate",
      profile_id: profileId,
      target_id: targetId,
      url: `https://chatgpt.com/c/${conversationId}`
    }, 30000);
  }

  const activation = await localMcpTool(base.config, token, "browser_control", {
    action: "activate_tab",
    profile_id: profileId,
    target_id: targetId
  }, 20000);

  let windowFocus = await focusChromeWindow(title);
  if (!windowFocus?.ok && activation?.window_state === "maximized" && activation?.window_focused) {
    windowFocus = {
      ok: true,
      activated: true,
      maximized: true,
      foreground_match: true,
      source: "chrome.windows",
      window_id: activation.window_id
    };
  }
  if (!windowFocus?.ok) throw new Error("Đã chọn đúng tab nhưng Windows chưa đưa Chrome lên trước. Hãy thử lại một lần.");

  return {
    ok: true,
    profile_id: profileId,
    conversation_id: conversationId || targetConversationId,
    target_id: Number(targetId),
    activation,
    window_focus: windowFocus
  };
}

async function reloadChromeProfiles() {
  const status = await runtimeStatus();
  const connectedProfiles = status.browserProfiles.filter((profile) => profile.connected);
  if (!connectedProfiles.length) throw new Error("Không có Chrome profile nào đang kết nối.");
  const outdated = connectedProfiles.filter((profile) => !versionAtLeast(profile.extension_version));
  if (!outdated.length) return { ok: true, mode: "up_to_date", count: 0, failed: 0, version: WORKER_EXTENSION_VERSION };
  if (!status.local.ok) throw new Error("Local MCP chưa sẵn sàng.");

  const token = readToken(status.config.tokenFile);
  const legacy = outdated.filter((profile) => {
    const [major = 0, minor = 0] = String(profile.extension_version || "").split(".").map(Number);
    return !(major > 0 || (major === 0 && minor >= 4));
  });
  const modern = outdated.filter((profile) => !legacy.includes(profile));

  const legacyResults = await Promise.allSettled(legacy.map((profile) => localMcpTool(status.config, token, "browser_control", {
    action: "open_tab",
    profile_id: profile.profile_id,
    url: "chrome-extension://gndipignbnipohooclcbhjliikamjlpl/popup.html?codexpro_reload=1"
  }, 20000)));
  const modernResults = await Promise.allSettled(modern.map((profile) => localMcpTool(status.config, token, "browser_control", {
    action: "reload_extension",
    profile_id: profile.profile_id
  }, 20000)));

  const results = [...legacyResults, ...modernResults];
  const updated = results.filter((result) => result.status === "fulfilled").length;
  if (!updated) throw new Error("Không profile worker cũ nào nhận được lệnh update.");
  return {
    ok: true,
    mode: legacy.length ? (modern.length ? "mixed_update" : "bootstrap_reload") : "extension_reload",
    count: updated,
    failed: outdated.length - updated,
    version: WORKER_EXTENSION_VERSION
  };
}

async function sendProfileRequest(payload) {
  const sendDebug = process.env.CODEXPRO_MANAGER_MCP_DEBUG === "1";
  if (sendDebug) console.error('[manager-send] start');
  const profileId = String(payload?.profileId || "").trim();
  const conversationId = String(payload?.conversationId || "").trim();
  const newChat = Boolean(payload?.newChat);
  const text = String(payload?.text || "").trim();
  const requestedProjectRoot = String(payload?.projectRoot || "").trim();
  const requestedFiles = Array.isArray(payload?.attachments) ? payload.attachments.slice(0, MAX_REQUEST_ATTACHMENTS) : [];
  if (!profileId || profileId.length > 160 || !/^[A-Za-z0-9._-]+$/.test(profileId)) throw new Error("Chrome profile id không hợp lệ.");
  if (!newChat && !/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) throw new Error("Đoạn chat đích không hợp lệ.");
  if (!text && !requestedFiles.length) throw new Error("Hãy nhập yêu cầu hoặc chọn ít nhất một file.");
  if (!requestedProjectRoot) throw new Error("Hãy chọn repo cần code trước khi gửi yêu cầu.");
  if (text.length > 12000) throw new Error("Yêu cầu dài quá 12.000 ký tự.");
  const files = requestedFiles.map((file) => requestFileSummary(file?.path));
  if (files.some((file) => file.size > MAX_REQUEST_ATTACHMENT_BYTES)) throw new Error("Mỗi file được tối đa 8 MB.");
  if (files.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_ATTACHMENTS_TOTAL_BYTES) throw new Error("Tổng file đính kèm được tối đa 10 MB.");
  const attachments = await Promise.all(files.map(async (file) => ({
    name: file.name,
    mime_type: file.mimeType,
    data_base64: (await fs.promises.readFile(file.path)).toString("base64")
  })));
  if (sendDebug) console.error('[manager-send] before runtimeStatus');
  let status = await runtimeStatus();
  if (sendDebug) console.error('[manager-send] after runtimeStatus');
  if (!status.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  const knownProjects = await listProjects();
  const selectedProject = knownProjects.find((project) => project.isGit && path.resolve(project.root).toLowerCase() === path.resolve(requestedProjectRoot).toLowerCase());
  if (!selectedProject) throw new Error("Repo đã chọn không còn nằm trong danh sách Git workspace của CodexPro.");
  let profile = status.browserProfiles.find((item) => item.profile_id === profileId);
  if (!profile?.connected) throw new Error("Extension của profile này đang mất heartbeat với CodexPro.");
  const token = readToken(status.config.tokenFile);
  if (!versionAtLeast(profile.extension_version)) {
    if (sendDebug) console.error(`[manager-send] updating worker ${profile.extension_version || "unknown"} -> ${WORKER_EXTENSION_VERSION}`);
    await localMcpTool(status.config, token, "browser_control", {
      action: "reload_extension",
      profile_id: profileId
    }, 20000);
    const updateDeadline = Date.now() + 15000;
    while (Date.now() < updateDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = await runtimeStatus();
      profile = status.browserProfiles.find((item) => item.profile_id === profileId);
      if (profile?.connected && versionAtLeast(profile.extension_version)) break;
    }
    if (!profile?.connected || !versionAtLeast(profile.extension_version)) {
      throw new Error(`Không thể tự update worker extension lên ${WORKER_EXTENSION_VERSION}. Hãy mở chrome://extensions và reload CodexPro.`);
    }
  }
  const selectedConversationTab = newChat ? null : (profile.conversation_tabs || []).find((tab) => String(tab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] === conversationId);
  if (selectedConversationTab?.busy) throw new Error("Đoạn chat này đang xử lý yêu cầu khác. Hãy chờ phản hồi hiện tại hoàn tất.");
  if (!newChat) {
    const allowedConversationIds = new Set([
      ...(profile.recent_conversations || []).map((conversation) => String(conversation.id || "")),
      ...(profile.conversation_tabs || []).map((tab) => String(tab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "")
    ]);
    if (!allowedConversationIds.has(conversationId)) throw new Error("Đoạn chat không còn thuộc 3 chat gần nhất của profile này.");
  }
  if (sendDebug) console.error('[manager-send] before send_chat_request tool');
  await localMcpTool(status.config, token, "browser_control", {
    action: "select_workspace",
    profile_id: profileId,
    root: selectedProject.root
  }, 20000);
  const taskText = [
    "@CodexPro",
    `Repo đã được CodexPro Manager khóa cho yêu cầu này: ${selectedProject.root}`,
    "Hãy dùng CodexPro để đọc và thao tác đúng repo đã khóa ở trên. Không chuyển sang workspace/repo khác. Tiếp tục từ trạng thái git và công việc hiện có của repo này.",
    "",
    text ? `Yêu cầu của người dùng:\n${text}` : "Yêu cầu của người dùng nằm trong file đính kèm."
  ].join("\n");
  const result = await localMcpTool(status.config, token, "browser_control", {
    action: "send_chat_request",
    profile_id: profileId,
    conversation_id: newChat ? undefined : conversationId,
    new_chat: newChat,
    text: taskText,
    attachments
  }, 120000);
  if (sendDebug) console.error('[manager-send] after send_chat_request tool');
  return result;
}

async function renameProfileChat(payload) {
  const profileId = String(payload?.profileId || "").trim();
  const conversationId = String(payload?.conversationId || "").trim();
  const title = String(payload?.title || "").trim();
  if (!profileId || profileId.length > 160 || !/^[A-Za-z0-9._-]+$/.test(profileId)) throw new Error("Chrome profile id không hợp lệ.");
  if (!/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) throw new Error("Đoạn chat đích không hợp lệ.");
  if (!title || title.length > 120) throw new Error("Tên đoạn chat phải từ 1 đến 120 ký tự.");
  const status = await runtimeStatus();
  if (!status.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  const profile = status.browserProfiles.find((item) => item.profile_id === profileId);
  if (!profile?.connected) throw new Error("Extension của profile này đang mất heartbeat với CodexPro.");
  const allowedConversationIds = new Set([
    ...(profile.recent_conversations || []).map((conversation) => String(conversation.id || "")),
    ...(profile.conversation_tabs || []).map((tab) => String(tab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "")
  ]);
  if (!allowedConversationIds.has(conversationId)) throw new Error("Đoạn chat không còn thuộc 3 chat gần nhất của profile này.");
  const token = readToken(status.config.tokenFile);
  return await localMcpTool(status.config, token, "browser_control", {
    action: "rename_chat",
    profile_id: profileId,
    conversation_id: conversationId,
    title
  }, 30000);
}

async function getProfileResponse(payload) {
  const profileId = String(payload?.profileId || "").trim();
  const conversationId = String(payload?.conversationId || "").trim();
  if (!profileId || profileId.length > 160 || !/^[A-Za-z0-9._-]+$/.test(profileId)) throw new Error("Chrome profile id không hợp lệ.");
  if (!/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) throw new Error("Đoạn chat đích không hợp lệ.");
  const base = await runtimeBaseStatus();
  if (!base.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  return await localMcpTool(base.config, base.token, "browser_control", {
    action: "get_chat_response",
    profile_id: profileId,
    conversation_id: conversationId,
    read_dom: payload?.readDom !== false
  }, 80000);
}

async function inspectThroughMcp(root) {
  const status = await runtimeStatus();
  if (!status.local.ok) throw new Error("Local MCP chưa sẵn sàng.");
  const token = readToken(status.config.tokenFile);
  const url = `http://127.0.0.1:${status.config.port}/mcp`;
  const initialized = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "CodexPro Manager", version: "0.2.54" } }
  });
  const sessionId = initialized.sessionId;
  await mcpRequest(url, token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  const opened = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "open_workspace", arguments: { root } }
  }, sessionId);
  const workspaceId = opened.payload.result?.structuredContent?.workspace_id;
  const snapshot = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "workspace_snapshot", arguments: { workspace_id: workspaceId, max_depth: 2, max_files: 300 } }
  }, sessionId);
  return snapshot.payload.result?.structuredContent || opened.payload.result?.structuredContent || {};
}

async function controlServer(action) {
  if (!["start", "restart"].includes(action)) throw new Error("Thao tác server không hợp lệ.");
  const current = await runtimeStatus();
  if (action === "start" && current.local.ok) return current;
  if (action === "restart") {
    const task = await scheduledTask();
    const config = parseTaskArguments(task.arguments);
    const rootLiteral = String(config.root || "").replace(/'/g, "''");
    const stopTree = [
      "Stop-ScheduledTask -TaskName 'CodexPro' -ErrorAction SilentlyContinue",
      "Start-Sleep -Milliseconds 500",
      `$root='${rootLiteral}'`,
      "$targets=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match 'codexpro\\.mjs' -and (!$root -or $_.CommandLine -like ('*'+$root+'*')) }",
      "$targets | ForEach-Object { & taskkill.exe /pid $_.ProcessId /t /f 2>$null | Out-Null }",
      "Start-Sleep -Seconds 1",
      "Start-ScheduledTask -TaskName 'CodexPro' -ErrorAction Stop"
    ].join("; ");
    await runPowerShell(stopTree);
  } else {
    await runPowerShell("Start-ScheduledTask -TaskName 'CodexPro' -ErrorAction Stop");
  }
  await new Promise((resolve) => setTimeout(resolve, 2400));
  return runtimeStatus();
}

ipcMain.handle("codexpro:status", () => runtimeStatus());
ipcMain.handle("codexpro:control", (_event, action) => controlServer(action));
ipcMain.handle("codexpro:copy", (_event, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});
ipcMain.handle("codexpro:rotate-link", async () => {
  const choice = await dialog.showMessageBox({
    type: "warning",
    title: "Tạo link MCP mới",
    message: "Token cũ sẽ hết hiệu lực",
    detail: "CodexPro sẽ đổi token và restart. Các kết nối ChatGPT cũ phải được cập nhật bằng link mới.",
    buttons: ["Hủy", "Tạo link mới"],
    defaultId: 0,
    cancelId: 0
  });
  if (choice.response !== 1) return { cancelled: true };
  const task = await scheduledTask();
  const config = parseTaskArguments(task.arguments);
  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(config.tokenFile), { recursive: true });
  fs.writeFileSync(config.tokenFile, `${token}\n`, { mode: 0o600 });
  await controlServer("restart");
  return { cancelled: false, ...(await runtimeStatus()) };
});
ipcMain.handle("codexpro:projects", () => listProjects());
ipcMain.handle("codexpro:check-profile", (_event, profileId) => checkChatGptProfile(profileId));
ipcMain.handle("codexpro:setup-profile", (_event, profileId) => setupChatGptProfile(profileId));
ipcMain.handle("codexpro:open-profile-chat", async (event, payload) => {
  const result = await openProfileChat(payload);
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (result?.window_focus?.ok && owner && !owner.isDestroyed()) owner.minimize();
  return result;
});
ipcMain.handle("codexpro:reload-profiles", () => reloadChromeProfiles());
ipcMain.handle("codexpro:get-manager-settings", () => managerSettingsPayload());
ipcMain.handle("codexpro:save-manager-settings", (_event, patch) => saveManagerSettingsPatch(patch));
ipcMain.handle("codexpro:choose-worker-image", (_event, state) => chooseWorkerImage(state));
ipcMain.handle("codexpro:reset-worker-image", (_event, state) => resetWorkerImage(state));
ipcMain.handle("codexpro:reset-manager-settings", () => resetManagerSettings());
ipcMain.handle("codexpro:choose-request-files", () => chooseRequestFiles());
ipcMain.handle("codexpro:capture-clipboard-image", () => captureClipboardImage());
ipcMain.handle("codexpro:send-profile-request", (_event, payload) => sendProfileRequest(payload));
ipcMain.handle("codexpro:rename-profile-chat", (_event, payload) => renameProfileChat(payload));
ipcMain.handle("codexpro:get-profile-response", (_event, payload) => getProfileResponse(payload));
ipcMain.handle("codexpro:choose-project", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Chọn repo hoặc dự án" });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("codexpro:add-project", async (_event, root) => {
  const resolved = path.resolve(String(root || ""));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error("Thư mục dự án không tồn tại.");
  const roots = [...new Set([...managerProjects(), resolved])];
  saveManagerProjects(roots);
  return listProjects();
});
ipcMain.handle("codexpro:remove-project", async (_event, root) => {
  const target = path.resolve(String(root || "")).toLowerCase();
  saveManagerProjects(managerProjects().filter((item) => path.resolve(item).toLowerCase() !== target));
  return listProjects();
});
ipcMain.handle("codexpro:inspect-project", (_event, root) => inspectThroughMcp(path.resolve(String(root || ""))));
ipcMain.handle("codexpro:open-folder", async (_event, root) => {
  const error = await shell.openPath(path.resolve(String(root || "")));
  if (error) throw new Error(error);
  return true;
});
ipcMain.handle("codexpro:open-external", async (_event, url) => {
  const parsed = new URL(String(url));
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Chỉ cho phép liên kết HTTP(S).");
  await shell.openExternal(parsed.toString());
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
