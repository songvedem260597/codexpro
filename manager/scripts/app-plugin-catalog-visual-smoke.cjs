const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
]);

app.setPath("userData", path.join(os.tmpdir(), `codexpro-app-plugin-catalog-visual-${process.pid}`));

app.whenReady().then(async () => {
  const managerRoot = path.resolve(__dirname, "..");
  const outputRoot = path.join(os.tmpdir(), `codexpro-app-plugin-catalog-visual-build-${process.pid}`);
  const fixtureHtml = path.join(__dirname, "app-plugin-catalog-visual-fixture.html");
  const screenshotPath = process.env.CODEXPRO_VISUAL_OUTPUT
    ? path.resolve(managerRoot, "..", process.env.CODEXPRO_VISUAL_OUTPUT)
    : path.join(os.tmpdir(), "codexpro-app-plugin-catalog-visual.png");
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

  const builtHtml = path.join(outputRoot, "scripts", "app-plugin-catalog-visual-fixture.html");
  if (!fs.existsSync(builtHtml)) throw new Error(`Vite visual fixture output missing: ${builtHtml}`);

  const window = new BrowserWindow({
    width: 2048,
    height: 900,
    show: false,
    backgroundColor: "#090d12",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true }
  });

  try {
    await withTimeout(window.loadFile(builtHtml), 10000, "app plugin catalog fixture load");
    const deadline = Date.now() + 8000;
    let result = null;
    while (Date.now() < deadline) {
      result = await withTimeout(window.webContents.executeJavaScript("window.__appPluginCatalogVisualResult || null", true), 1500, "app plugin catalog fixture result");
      if (result?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!result?.ok) throw new Error(`App plugin catalog visual fixture did not render: ${JSON.stringify(result)}`);
    if (result.cardHeights.some((height) => height < 90 || height > 150)) {
      throw new Error(`Catalog cards must remain compact: ${JSON.stringify(result)}`);
    }
    if (Math.max(...result.cardHeights) - Math.min(...result.cardHeights) > 8) {
      throw new Error(`Catalog cards should have matching compact heights: ${JSON.stringify(result)}`);
    }
    if (result.layoutTop <= result.cardTop[1] + result.cardHeights[1] || result.layoutHeight < 560) {
      throw new Error(`Plugin layout must follow compact catalog cards: ${JSON.stringify(result)}`);
    }
    if (result.bodyScrollWidth > result.bodyClientWidth + 2) {
      throw new Error(`Plugin catalog overflowed horizontally: ${JSON.stringify(result)}`);
    }
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
    console.log("app-plugin-catalog-visual-smoke: ok");
    console.log(JSON.stringify({ ...result, screenshotPath }, null, 2));
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(1);
  }
});
