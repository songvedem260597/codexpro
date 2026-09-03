const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
]);

app.setPath("userData", path.join(os.tmpdir(), `codexpro-task-hang-visual-${process.pid}`));

app.whenReady().then(async () => {
  const managerRoot = path.resolve(__dirname, "..");
  const outputRoot = path.join(os.tmpdir(), `codexpro-task-hang-visual-build-${process.pid}`);
  const fixtureHtml = path.join(__dirname, "control-center-task-hang-visual-fixture.html");
  const screenshotPath = process.env.CODEXPRO_VISUAL_OUTPUT
    ? path.resolve(managerRoot, "..", process.env.CODEXPRO_VISUAL_OUTPUT)
    : path.join(os.tmpdir(), "codexpro-task-hang-visual.png");
  const { build } = await import("vite");

  await build({
    root: managerRoot,
    base: "./",
    logLevel: "error",
    build: {
      outDir: outputRoot,
      emptyOutDir: true,
      rollupOptions: { input: fixtureHtml }
    }
  });

  const builtHtml = path.join(outputRoot, "scripts", "control-center-task-hang-visual-fixture.html");
  if (!fs.existsSync(builtHtml)) throw new Error(`Vite visual fixture output missing: ${builtHtml}`);

  const window = new BrowserWindow({
    width: 1560,
    height: 1180,
    show: false,
    backgroundColor: "#090d12",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true }
  });

  try {
    await withTimeout(window.loadFile(builtHtml), 10000, "task hang visual fixture load");
    const deadline = Date.now() + 8000;
    let result = null;
    while (Date.now() < deadline) {
      result = await withTimeout(window.webContents.executeJavaScript("window.__taskHangVisualResult || null", true), 1500, "task hang fixture result");
      if (result?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!result?.ok) throw new Error(`Task hang visual fixture did not render: ${JSON.stringify(result)}`);
    if (!/1 đang treo · 4 lần/.test(result.text) || !/Đóng tab \+ tiếp tục task/.test(result.text)) {
      throw new Error(`Task hang visual fixture is missing incident statistics/actions: ${JSON.stringify(result)}`);
    }
    if (result.buttonDisabled) throw new Error(`Recoverable active incident continuation button must be enabled: ${JSON.stringify(result)}`);
    if (result.overflowCount > 0) throw new Error(`Task hang section contains clipped horizontal content: ${JSON.stringify(result)}`);
    if (result.sectionHeight < 340 || result.rowWidth < 900) throw new Error(`Task hang panel layout is unexpectedly cramped: ${JSON.stringify(result)}`);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await window.webContents.executeJavaScript(`(() => { const el=document.querySelector('.control-hang-section'); const r=el.getBoundingClientRect(); window.scrollTo({top:Math.max(0, window.scrollY + r.top - 20), behavior:'instant'}); })()`, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
    console.log("control-center-task-hang-visual-smoke: ok");
    console.log(JSON.stringify({ ...result, screenshotPath }, null, 2));
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(1);
  }
});
