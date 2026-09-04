const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
]);

app.setPath("userData", path.join(os.tmpdir(), `codexpro-settings-controls-visual-${process.pid}`));

app.whenReady().then(async () => {
  const managerRoot = path.resolve(__dirname, "..");
  const outputRoot = path.join(os.tmpdir(), `codexpro-settings-controls-visual-build-${process.pid}`);
  const fixtureHtml = path.join(__dirname, "settings-controls-visual-fixture.html");
  const screenshotPath = path.join(managerRoot, "..", ".ai-bridge", "settings-controls-visual.png");
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

  const builtHtml = path.join(outputRoot, "scripts", "settings-controls-visual-fixture.html");
  if (!fs.existsSync(builtHtml)) throw new Error(`Vite visual fixture output missing: ${builtHtml}`);

  const window = new BrowserWindow({
    width: 1000,
    height: 720,
    show: false,
    backgroundColor: "#090d12",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true }
  });

  try {
    await withTimeout(window.loadFile(builtHtml), 10000, "settings controls fixture load");
    const deadline = Date.now() + 8000;
    let initial = null;
    while (Date.now() < deadline) {
      initial = await withTimeout(window.webContents.executeJavaScript("window.__settingsControlsVisualResult || null", true), 1500, "settings controls fixture result");
      if (initial?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!initial?.ok) throw new Error(`Settings controls visual fixture did not render: ${JSON.stringify(initial)}`);
    if (initial.bodyScrollWidth > initial.bodyClientWidth + 2) throw new Error(`Settings controls overflowed horizontally: ${JSON.stringify(initial)}`);
    if (initial.triggerHeights.some((height) => height < 50)) throw new Error(`Settings dropdown trigger became too short: ${JSON.stringify(initial.triggerHeights)}`);
    if (initial.toggleHeights.some((height) => height < 46)) throw new Error(`Settings toggle became too short: ${JSON.stringify(initial.toggleHeights)}`);
    if (initial.activeTogglePressed !== "true" || !initial.disabledDropdown || !initial.disabledToggle) {
      throw new Error(`Settings control semantics changed: ${JSON.stringify(initial)}`);
    }

    await window.webContents.executeJavaScript("document.querySelector('.settings-toggle:not(:disabled)').click()", true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const toggleState = await window.webContents.executeJavaScript(`(() => {
      const toggle = document.querySelector('.settings-toggle:not(:disabled)');
      return { pressed: toggle.getAttribute('aria-pressed'), isOn: toggle.classList.contains('is-on') };
    })()`, true);
    if (toggleState.pressed !== "false" || toggleState.isOn) throw new Error(`Settings toggle interaction regressed: ${JSON.stringify(toggleState)}`);

    await window.webContents.executeJavaScript("document.querySelector('.app-dropdown-trigger:not(:disabled)').click()", true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const openState = await window.webContents.executeJavaScript(`(() => ({
      expanded: document.querySelector('.app-dropdown-trigger:not(:disabled)').getAttribute('aria-expanded'),
      options: document.querySelectorAll('.app-dropdown-option').length,
      menuVisible: Boolean(document.querySelector('.app-dropdown-menu'))
    }))()`, true);
    if (openState.expanded !== "true" || openState.options !== 3 || !openState.menuVisible) throw new Error(`Settings dropdown did not open correctly: ${JSON.stringify(openState)}`);

    await window.webContents.executeJavaScript("document.querySelectorAll('.app-dropdown-option')[1].click()", true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const selectedState = await window.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('.app-dropdown-trigger:not(:disabled)');
      return { expanded: trigger.getAttribute('aria-expanded'), text: trigger.innerText, menuVisible: Boolean(document.querySelector('.app-dropdown-menu')) };
    })()`, true);
    if (selectedState.expanded !== "false" || selectedState.menuVisible || !selectedState.text.includes("Manrope")) {
      throw new Error(`Settings dropdown selection regressed: ${JSON.stringify(selectedState)}`);
    }

    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
    console.log("settings-controls-visual-smoke: ok");
    console.log(JSON.stringify({ initial, toggleState, openState, selectedState, screenshotPath }, null, 2));
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(1);
  }
});
