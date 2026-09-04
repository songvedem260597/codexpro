const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
]);

app.setPath("userData", path.join(os.tmpdir(), `codexpro-chat-dropdown-visual-${process.pid}`));

app.whenReady().then(async () => {
  const managerRoot = path.resolve(__dirname, "..");
  const outputRoot = path.join(os.tmpdir(), `codexpro-chat-dropdown-visual-build-${process.pid}`);
  const fixtureHtml = path.join(__dirname, "chat-dropdown-visual-fixture.html");
  const screenshotPath = path.join(managerRoot, "..", ".ai-bridge", "chat-dropdown-visual.png");
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

  const builtHtml = path.join(outputRoot, "scripts", "chat-dropdown-visual-fixture.html");
  if (!fs.existsSync(builtHtml)) throw new Error(`Vite visual fixture output missing: ${builtHtml}`);

  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    backgroundColor: "#090d12",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true }
  });

  try {
    await withTimeout(window.loadFile(builtHtml), 10000, "chat dropdown fixture load");
    const deadline = Date.now() + 8000;
    let initial = null;
    while (Date.now() < deadline) {
      initial = await withTimeout(window.webContents.executeJavaScript("window.__chatDropdownVisualResult || null", true), 1500, "chat dropdown fixture result");
      if (initial?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!initial?.ok) throw new Error(`Chat dropdown visual fixture did not render: ${JSON.stringify(initial)}`);
    if (!initial.selectedText.includes("Chat mới") || !initial.selectedText.includes("Chưa tạo trên ChatGPT")) {
      throw new Error(`New chat draft option was not selected correctly: ${JSON.stringify(initial)}`);
    }
    if (!initial.disabled || initial.selectedExpanded !== "false") throw new Error(`Chat dropdown disabled/expanded semantics changed: ${JSON.stringify(initial)}`);
    if (initial.triggerHeights.some((height) => height < 50)) throw new Error(`Chat dropdown trigger became too short: ${JSON.stringify(initial.triggerHeights)}`);
    if (initial.bodyScrollWidth > initial.bodyClientWidth + 2) throw new Error(`Chat dropdown fixture overflowed horizontally: ${JSON.stringify(initial)}`);

    await window.webContents.executeJavaScript("document.querySelector('.app-dropdown-trigger:not(:disabled)').click()", true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const openState = await window.webContents.executeJavaScript(`(() => ({
      expanded: document.querySelector('.app-dropdown-trigger:not(:disabled)').getAttribute('aria-expanded'),
      optionCount: document.querySelectorAll('.app-dropdown-option').length,
      firstOptionText: document.querySelector('.app-dropdown-option')?.innerText || '',
      activeBadges: [...document.querySelectorAll('.app-dropdown-meta.is-active')].map((item) => item.innerText),
      searchVisible: Boolean(document.querySelector('.app-dropdown-search input')),
      menuRect: (() => { const menu = document.querySelector('.app-dropdown-menu')?.getBoundingClientRect(); return menu ? { width: Math.round(menu.width), height: Math.round(menu.height), right: Math.round(menu.right) } : null; })(),
      viewportWidth: window.innerWidth
    }))()`, true);
    if (openState.expanded !== "true" || openState.optionCount !== 8 || !openState.searchVisible) throw new Error(`Chat dropdown did not open/search correctly: ${JSON.stringify(openState)}`);
    if (!openState.firstOptionText.includes("Chat mới") || !openState.firstOptionText.includes("Chưa tạo trên ChatGPT")) throw new Error(`Draft option ordering changed: ${JSON.stringify(openState)}`);
    if (openState.activeBadges.length !== 1 || openState.activeBadges[0] !== "ACTIVE") throw new Error(`Active conversation badge changed: ${JSON.stringify(openState)}`);
    if (!openState.menuRect || openState.menuRect.right > openState.viewportWidth + 2) throw new Error(`Chat dropdown menu overflowed viewport: ${JSON.stringify(openState)}`);

    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());

    await window.webContents.executeJavaScript("document.querySelectorAll('.app-dropdown-option')[1].click()", true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const selected = await window.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('.app-dropdown-trigger:not(:disabled)');
      return { expanded: trigger.getAttribute('aria-expanded'), text: trigger.innerText, menuVisible: Boolean(document.querySelector('.app-dropdown-menu')) };
    })()`, true);
    if (selected.expanded !== "false" || selected.menuVisible || !selected.text.includes("Audit refactor CodexPro") || !selected.text.includes("Đang mở trong Chrome")) {
      throw new Error(`Chat dropdown selection regressed: ${JSON.stringify(selected)}`);
    }

    console.log("chat-dropdown-visual-smoke: ok");
    console.log(JSON.stringify({ initial, openState, selected, screenshotPath }, null, 2));
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(1);
  }
});
