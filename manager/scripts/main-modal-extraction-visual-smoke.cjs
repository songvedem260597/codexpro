const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
]);

app.setPath("userData", path.join(os.tmpdir(), `codexpro-main-modal-visual-${process.pid}`));

app.whenReady().then(async () => {
  const managerRoot = path.resolve(__dirname, "..");
  const outputRoot = path.join(os.tmpdir(), `codexpro-main-modal-build-${process.pid}`);
  const fixtureHtml = path.join(__dirname, "main-modal-extraction-visual-fixture.html");
  const screenshotRoot = path.join(managerRoot, "..", ".ai-bridge");
  const { build } = await import("vite");

  await build({ root: managerRoot, base: "./", logLevel: "error", build: { outDir: outputRoot, emptyOutDir: true, rollupOptions: { input: fixtureHtml } } });
  const builtHtml = path.join(outputRoot, "scripts", "main-modal-extraction-visual-fixture.html");
  if (!fs.existsSync(builtHtml)) throw new Error(`Fixture output missing: ${builtHtml}`);

  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    show: false,
    backgroundColor: "#090c12",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true }
  });

  try {
    await timeout(win.loadFile(builtHtml), 10000, "fixture load");
    await delay(300);

    const worker = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.worker-update-dialog');
      const backdrop = document.querySelector('.worker-update-backdrop');
      if (!dialog || !backdrop) return null;
      const rect = dialog.getBoundingClientRect();
      return {
        title: document.querySelector('#worker-update-title')?.innerText || '',
        text: dialog.innerText,
        role: dialog.getAttribute('role'),
        modal: dialog.getAttribute('aria-modal'),
        buttons: [...dialog.querySelectorAll('button')].map((button) => button.innerText),
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        viewport: { width: innerWidth, height: innerHeight }
      };
    })()`, true);
    if (!worker) throw new Error("Worker update modal did not render");
    if (worker.title !== "Cập nhật CodexPro Worker" || !worker.text.includes("3 worker đang rảnh") || !worker.text.includes("2 worker đang làm việc") || !worker.text.includes("0.5.121")) throw new Error(`Worker update content regressed: ${JSON.stringify(worker)}`);
    if (worker.role !== "dialog" || worker.modal !== "true") throw new Error(`Worker update accessibility regressed: ${JSON.stringify(worker)}`);
    if (worker.rect.left < 0 || worker.rect.top < 0 || worker.rect.right > worker.viewport.width || worker.rect.bottom > worker.viewport.height) throw new Error(`Worker update escaped viewport: ${JSON.stringify(worker.rect)}`);
    fs.mkdirSync(screenshotRoot, { recursive: true });
    const workerScreenshot = path.join(screenshotRoot, "worker-update-modal-visual.png");
    fs.writeFileSync(workerScreenshot, (await win.webContents.capturePage()).toPNG());

    await win.webContents.executeJavaScript("document.querySelector('.worker-update-actions .primary').click()", true);
    await delay(100);
    const confirmed = await win.webContents.executeJavaScript("window.__modalFixtureState()", true);
    if (!confirmed.confirmed || confirmed.workerOpen) throw new Error(`Worker update confirm interaction regressed: ${JSON.stringify(confirmed)}`);

    await win.webContents.executeJavaScript("window.__showInspection()", true);
    await delay(700);
    const inspection = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.codexgraph-modal');
      if (!dialog) return null;
      const rect = dialog.getBoundingClientRect();
      return {
        title: dialog.querySelector('h2')?.innerText || '',
        workspace: dialog.querySelector('.inspection-grid code')?.innerText || '',
        closeLabel: dialog.querySelector('.modal-head button')?.getAttribute('aria-label') || '',
        hasGraph: Boolean(dialog.querySelector('.react-sigma') || dialog.querySelector('canvas') || dialog.querySelector('.sigma-container')),
        hasRaw: Boolean(dialog.querySelector('.codexgraph-raw-details')),
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        viewport: { width: innerWidth, height: innerHeight }
      };
    })()`, true);
    if (!inspection) throw new Error("Inspection modal did not render");
    if (inspection.title !== "codexpro-source" || inspection.workspace !== "ws_visual_test" || inspection.closeLabel !== "Đóng kiểm tra workspace" || !inspection.hasRaw) throw new Error(`Inspection modal content regressed: ${JSON.stringify(inspection)}`);
    if (inspection.rect.left < 0 || inspection.rect.top < 0 || inspection.rect.right > inspection.viewport.width || inspection.rect.bottom > inspection.viewport.height) throw new Error(`Inspection modal escaped viewport: ${JSON.stringify(inspection.rect)}`);
    const inspectionScreenshot = path.join(screenshotRoot, "inspection-modal-visual.png");
    fs.writeFileSync(inspectionScreenshot, (await win.webContents.capturePage()).toPNG());

    await win.webContents.executeJavaScript("document.querySelector('.codexgraph-modal .modal-head button').click()", true);
    await delay(100);
    const closed = await win.webContents.executeJavaScript("!document.querySelector('.codexgraph-modal')", true);
    if (!closed) throw new Error("Inspection close button did not close modal");

    console.log("main-modal-extraction-visual-smoke: ok");
    console.log(JSON.stringify({ workerScreenshot, inspectionScreenshot, worker, inspection }, null, 2));
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(1);
  }
});
