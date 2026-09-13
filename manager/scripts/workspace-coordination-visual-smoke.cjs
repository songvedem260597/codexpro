const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
]);

app.setPath("userData", path.join(os.tmpdir(), `codexpro-coordination-visual-${process.pid}`));

app.whenReady().then(async () => {
  const managerRoot = path.resolve(__dirname, "..");
  const outputRoot = path.join(os.tmpdir(), `codexpro-coordination-visual-build-${process.pid}`);
  const fixtureHtml = path.join(__dirname, "workspace-coordination-visual-fixture.html");
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
  const builtHtml = path.join(outputRoot, "scripts", "workspace-coordination-visual-fixture.html");
  if (!fs.existsSync(builtHtml)) throw new Error(`Vite visual fixture output missing: ${builtHtml}`);

  const window = new BrowserWindow({
    width: 1400,
    height: 1100,
    show: false,
    backgroundColor: "#090d12",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true }
  });

  try {
    await withTimeout(window.loadFile(builtHtml), 10000, "coordination fixture load");
    const deadline = Date.now() + 8000;
    let result = null;
    while (Date.now() < deadline) {
      result = await withTimeout(window.webContents.executeJavaScript("window.__coordinationVisualResult || null", true), 1500, "coordination fixture result");
      if (result?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!result?.ok) throw new Error(`Coordination visual fixture did not render: ${JSON.stringify(result)}`);
    for (const expected of ["Worktree & Integration Queue", "STALE BASE", "CONFLICT", "QUEUE #1", "File ownership", "Integration queue", "Mở worktree"]) {
      if (!result.text.includes(expected)) throw new Error(`Coordination visual fixture missing text: ${expected}`);
    }
    if (result.conflictCount < 1 || result.queueBadges < 1) throw new Error(`Coordination visual states were not rendered: ${JSON.stringify(result)}`);
    if (result.panelScrollWidth > result.panelClientWidth + 2 || result.overflowing?.length) throw new Error(`Coordination panel content overflowed horizontally: ${JSON.stringify(result)}`);
    if (result.panelHeight < 500) throw new Error(`Coordination panel rendered unexpectedly short: ${JSON.stringify(result)}`);

    const screenshotPath = path.join(os.tmpdir(), "codexpro-workspace-coordination-p2.png");
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());

    await withTimeout(window.loadFile(builtHtml, { query: { mode: "history" } }), 10000, "coordination history fixture load");
    const historyDeadline = Date.now() + 8000;
    result = null;
    while (Date.now() < historyDeadline) {
      result = await withTimeout(window.webContents.executeJavaScript("window.__coordinationVisualResult || null", true), 1500, "coordination history fixture result");
      if (result?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!result?.ok) throw new Error(`Coordination history fixture did not render: ${JSON.stringify(result)}`);
    for (const expected of ["0 active", "0 claim", "0 queue", "0 conflict", "0 task theo dõi", "Không có task đang chạy, xếp hàng hoặc conflict live trong repo này."]) {
      if (!result.text.includes(expected)) throw new Error(`Coordination history fixture missing text: ${expected}`);
    }
    for (const staleText of ["Historical integration conflict", "Historical failed integration", "TÍCH HỢP LỖI"]) {
      if (result.text.includes(staleText)) throw new Error(`Coordination history fixture leaked terminal task text: ${staleText}`);
    }
    if (result.taskCards !== 0 || result.conflictCount !== 0 || result.repoHasConflict) {
      throw new Error(`Terminal recovery/history records still affected live UI: ${JSON.stringify(result)}`);
    }
    if (result.panelScrollWidth > result.panelClientWidth + 2 || result.overflowing?.length) throw new Error(`Coordination history panel content overflowed horizontally: ${JSON.stringify(result)}`);
    const historyScreenshotPath = path.join(os.tmpdir(), "codexpro-workspace-coordination-history.png");
    fs.writeFileSync(historyScreenshotPath, (await window.webContents.capturePage()).toPNG());
    console.log("workspace coordination visual smoke passed");
    console.log(`visual screenshot: ${screenshotPath}`);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(1);
  }
});
