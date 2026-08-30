import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const supportedExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
let mainWindow;
let pendingOpenPath = "";

function aiPythonExecutable() {
  const homeDirectory = app.getPath("home");
  const candidates = [
    process.env.CODEXPRO_REMBG_PYTHON,
    path.join(homeDirectory, ".local", "share", "uv", "tools", "rembg", "bin", "python")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Chưa có engine AI. Hãy cài rembg bằng uv tool install --python python3.12 'rembg[cpu]'.");
}

function aiHelperPath() {
  if (!app.isPackaged) return path.join(currentDir, "remove_background_ai.py");
  return path.join(process.resourcesPath, "app.asar.unpacked", "electron", "remove_background_ai.py");
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".gif") return "image/gif";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function validateImagePath(value) {
  const resolved = path.resolve(String(value || ""));
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || !supportedExtensions.has(path.extname(resolved).toLowerCase())) {
    throw new Error("Chỉ hỗ trợ PNG, JPG, GIF và WEBP.");
  }
  if (stat.size > 80 * 1024 * 1024) throw new Error("Ảnh được tối đa 80 MB.");
  return resolved;
}

function imageSummary(filePath) {
  const resolved = validateImagePath(filePath);
  const stat = fs.statSync(resolved);
  const dimensions = nativeImage.createFromPath(resolved).getSize();
  return {
    path: resolved,
    name: path.basename(resolved),
    bytes: stat.size,
    width: dimensions.width,
    height: dimensions.height,
    dataUrl: `data:${mimeType(resolved)};base64,${fs.readFileSync(resolved).toString("base64")}`
  };
}

function runAiSegmentation(inputPath, outputPath, onFrameProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(aiPythonExecutable(), [aiHelperPath(), inputPath, outputPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stdoutBuffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const match = line.match(/^PROGRESS (\d+) (\d+)$/);
        if (match) onFrameProgress?.(Number(match[1]), Number(match[2]));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Engine AI thoát với mã ${code}`));
    });
  });
}

function nextOutputPath(inputPath) {
  const parsed = path.parse(inputPath);
  const outputExtension = parsed.ext.toLowerCase() === ".gif" ? ".gif" : ".png";
  let suffix = "";
  let index = 2;
  let candidate = path.join(parsed.dir, `${parsed.name}-no-bg${suffix}${outputExtension}`);
  while (fs.existsSync(candidate)) {
    suffix = `-${index}`;
    index += 1;
    candidate = path.join(parsed.dir, `${parsed.name}-no-bg${suffix}${outputExtension}`);
  }
  return candidate;
}

function sendProgress(percent, status) {
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send("background-remover:progress", { percent, status });
}

async function removeBackground({ inputPath }) {
  const resolved = validateImagePath(inputPath);
  const outputPath = nextOutputPath(resolved);
  const isGif = path.extname(resolved).toLowerCase() === ".gif";
  sendProgress(8, isGif ? "Đang nạp AI cho GIF động…" : "Đang nạp AI nhận diện chủ thể…");
  if (isGif) {
    await runAiSegmentation(resolved, outputPath, (current, total) => {
      const percent = 10 + Math.round((current / total) * 84);
      sendProgress(percent, `Đã xử lý frame ${current}/${total} · đang giữ chuyển động…`);
    });
  } else {
    let percent = 8;
    const timer = setInterval(() => {
      percent = Math.min(94, percent + Math.max(1, Math.round((96 - percent) / 18)));
      sendProgress(percent, percent < 55 ? "AI đang nhận diện toàn bộ trang phục…" : "Đang làm sạch mũ, tóc và quần áo…");
    }, 220);
    try {
      await runAiSegmentation(resolved, outputPath);
    } finally {
      clearInterval(timer);
    }
  }
  sendProgress(96, isGif ? "Đang kiểm tra frame và thời lượng GIF…" : "Đang kiểm tra lớp nền trong suốt…");
  const result = imageSummary(outputPath);
  sendProgress(100, "Xóa nền AI hoàn tất");
  return { ...result, engine: "birefnet-general-lite" };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    title: "CodexPro Xóa Nền",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: "#070914",
    webPreferences: {
      preload: path.join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.once("did-finish-load", () => {
    if (!pendingOpenPath) return;
    try {
      mainWindow.webContents.send("background-remover:opened-file", imageSummary(pendingOpenPath));
      pendingOpenPath = "";
    } catch {
      // The renderer will remain on the normal picker when macOS passes an invalid file.
    }
  });
  const devUrl = process.env.BG_REMOVER_DEV_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(currentDir, "..", "dist", "index.html"));
}

ipcMain.handle("background-remover:choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Chọn ảnh cần xóa nền",
    properties: ["openFile"],
    filters: [{ name: "Ảnh", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]
  });
  return result.canceled || !result.filePaths[0] ? null : imageSummary(result.filePaths[0]);
});
ipcMain.handle("background-remover:load", (_event, filePath) => imageSummary(filePath));
ipcMain.handle("background-remover:remove", (_event, options) => removeBackground(options));
ipcMain.handle("background-remover:reveal", async (_event, filePath) => {
  const resolved = validateImagePath(filePath);
  shell.showItemInFolder(resolved);
  return true;
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  pendingOpenPath = filePath;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    try {
      mainWindow.webContents.send("background-remover:opened-file", imageSummary(filePath));
      pendingOpenPath = "";
      mainWindow.show();
    } catch {
      // Ignore unsupported files forwarded by LaunchServices.
    }
  }
});

app.whenReady().then(() => {
  app.setName("CodexPro Xóa Nền");
  const commandLineImage = process.argv.find((argument) => {
    try {
      return supportedExtensions.has(path.extname(argument).toLowerCase()) && fs.statSync(argument).isFile();
    } catch {
      return false;
    }
  });
  if (commandLineImage) pendingOpenPath = path.resolve(commandLineImage);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
