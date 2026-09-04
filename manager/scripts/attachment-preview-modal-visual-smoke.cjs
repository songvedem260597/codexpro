const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
]);

app.setPath("userData", path.join(os.tmpdir(), `codexpro-attachment-preview-visual-${process.pid}`));

app.whenReady().then(async () => {
  const managerRoot = path.resolve(__dirname, "..");
  const outputRoot = path.join(os.tmpdir(), `codexpro-attachment-preview-build-${process.pid}`);
  const fixtureHtml = path.join(__dirname, "attachment-preview-modal-visual-fixture.html");
  const screenshotPath = path.join(managerRoot, "..", ".ai-bridge", "attachment-preview-modal-visual.png");
  const { build } = await import("vite");

  await build({
    root: managerRoot,
    base: "./",
    logLevel: "error",
    build: { outDir: outputRoot, emptyOutDir: true, rollupOptions: { input: fixtureHtml } }
  });

  const builtHtml = path.join(outputRoot, "scripts", "attachment-preview-modal-visual-fixture.html");
  if (!fs.existsSync(builtHtml)) throw new Error(`Vite visual fixture output missing: ${builtHtml}`);

  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: false,
    backgroundColor: "#05070b",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true }
  });

  try {
    await withTimeout(window.loadFile(builtHtml), 10000, "attachment preview fixture load");
    const deadline = Date.now() + 8000;
    let initial = null;
    while (Date.now() < deadline) {
      initial = await withTimeout(window.webContents.executeJavaScript(`(() => {
        const backdrop = document.querySelector('.attachment-lightbox-backdrop');
        const dialog = document.querySelector('.attachment-lightbox');
        const body = document.querySelector('.attachment-lightbox-body');
        if (!backdrop || !dialog || !body) return null;
        const rect = dialog.getBoundingClientRect();
        return {
          title: document.querySelector('.attachment-lightbox-head strong')?.innerText || '',
          meta: document.querySelector('.attachment-lightbox-head span')?.innerText || '',
          aria: dialog.getAttribute('aria-label'),
          role: dialog.getAttribute('role'),
          bodyClass: body.className,
          text: body.innerText,
          closeLabel: document.querySelector('.attachment-lightbox-head button')?.getAttribute('aria-label'),
          rect: { width: Math.round(rect.width), height: Math.round(rect.height), left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          bodyScrollWidth: document.body.scrollWidth,
          bodyClientWidth: document.body.clientWidth
        };
      })()`, true), 1500, "attachment preview initial state");
      if (initial) break;
      await delay(100);
    }

    if (!initial) throw new Error("Attachment preview fixture did not render");
    if (initial.title !== "notes.md" || !initial.meta.includes("text/markdown") || !initial.meta.includes("2 KB") || !initial.meta.includes("chỉ hiển thị phần đầu")) throw new Error(`Attachment metadata regressed: ${JSON.stringify(initial)}`);
    if (initial.aria !== "Xem trước notes.md" || initial.role !== "dialog" || initial.closeLabel !== "Đóng xem trước") throw new Error(`Attachment accessibility semantics regressed: ${JSON.stringify(initial)}`);
    if (!initial.bodyClass.includes("is-text") || !initial.text.includes("Dòng tiếng Việt")) throw new Error(`Text preview state regressed: ${JSON.stringify(initial)}`);
    if (initial.rect.left < 0 || initial.rect.top < 0 || initial.rect.right > initial.viewport.width || initial.rect.bottom > initial.viewport.height) throw new Error(`Attachment preview escaped viewport: ${JSON.stringify(initial.rect)}`);
    if (initial.bodyScrollWidth > initial.bodyClientWidth + 2) throw new Error(`Attachment preview caused horizontal page overflow: ${JSON.stringify(initial)}`);

    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());

    await window.webContents.executeJavaScript("document.querySelector('.attachment-lightbox-head button').click()", true);
    await delay(120);
    const closedByButton = await window.webContents.executeJavaScript("!document.querySelector('.attachment-lightbox')", true);
    if (!closedByButton) throw new Error("Close button did not close attachment preview");

    await window.webContents.executeJavaScript("window.__openAttachmentPreview('image')", true);
    await delay(150);
    const imageState = await window.webContents.executeJavaScript(`(() => ({
      open: Boolean(document.querySelector('.attachment-lightbox')),
      image: Boolean(document.querySelector('.attachment-lightbox-body.is-image img')),
      title: document.querySelector('.attachment-lightbox-head strong')?.innerText || ''
    }))()`, true);
    if (!imageState.open || !imageState.image || imageState.title !== "preview.svg") throw new Error(`Image preview state regressed: ${JSON.stringify(imageState)}`);

    await window.webContents.executeJavaScript("document.querySelector('.attachment-lightbox-backdrop').focus()", true);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ESCAPE" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ESCAPE" });
    await delay(150);
    const closedByEscape = await window.webContents.executeJavaScript("!document.querySelector('.attachment-lightbox')", true);
    if (!closedByEscape) throw new Error("Escape did not close attachment preview");

    await window.webContents.executeJavaScript("window.__openAttachmentPreview('unsupported')", true);
    await delay(120);
    const unsupportedState = await window.webContents.executeJavaScript(`(() => ({
      open: Boolean(document.querySelector('.attachment-lightbox')),
      bodyClass: document.querySelector('.attachment-lightbox-body')?.className || '',
      text: document.querySelector('.attachment-lightbox-body')?.innerText || ''
    }))()`, true);
    if (!unsupportedState.open || !unsupportedState.bodyClass.includes("is-unsupported") || !unsupportedState.text.includes("Định dạng này chưa hỗ trợ xem trước.")) throw new Error(`Unsupported preview state regressed: ${JSON.stringify(unsupportedState)}`);

    await window.webContents.executeJavaScript("document.querySelector('.attachment-lightbox-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))", true);
    await delay(120);
    const closedByBackdrop = await window.webContents.executeJavaScript("!document.querySelector('.attachment-lightbox')", true);
    if (!closedByBackdrop) throw new Error("Backdrop mouse down did not close attachment preview");

    console.log("attachment-preview-modal-visual-smoke: ok");
    console.log(JSON.stringify({ initial, imageState, unsupportedState, screenshotPath }, null, 2));
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(1);
  }
});
