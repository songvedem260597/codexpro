const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const managerRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(managerRoot, "src", "main.jsx"), "utf8");
const styles = fs.readFileSync(path.join(managerRoot, "src", "styles.css"), "utf8");

for (const className of [
  "summary-working-bolt", "summary-working-spark", "summary-idle-ring", "summary-idle-check",
  "summary-hung-triangle", "summary-hung-mark", "summary-hung-dot",
  "summary-missing-plug", "summary-missing-plus"
]) {
  if (!source.includes(`className=\"${className}\"`)) throw new Error(`ProfileSummaryIcon is missing ${className}`);
}

const cards = `
  <div class="page-overview"><div class="visual-shell">
    <div class="visual-title">Worker status summary</div>
    <div class="visual-row">
      <span class="profile-summary-item is-working"><span class="profile-summary-icon"><svg class="profile-summary-svg" viewBox="0 0 24 24"><path class="summary-working-bolt" d="m13.5 2-8 12h6l-1 8 8-12h-6l1-8Z"></path><circle class="summary-working-spark" cx="18.4" cy="5.2" r="1.25"></circle></svg></span><strong>2 working</strong></span>
      <span class="profile-summary-item is-idle"><span class="profile-summary-icon"><svg class="profile-summary-svg" viewBox="0 0 24 24"><circle class="summary-idle-ring" cx="12" cy="12" r="9"></circle><path class="summary-idle-check" d="m8 12 2.6 2.6L16.5 9"></path></svg></span><strong>4 idle</strong></span>
      <span class="profile-summary-item is-hung"><span class="profile-summary-icon"><svg class="profile-summary-svg" viewBox="0 0 24 24"><path class="summary-hung-triangle" d="M12 3 2.8 20h18.4L12 3Z"></path><path class="summary-hung-mark" d="M12 9v5"></path><circle class="summary-hung-dot" cx="12" cy="17.25" r=".75"></circle></svg></span><strong>1 hung</strong></span>
      <span class="profile-summary-item is-missing"><span class="profile-summary-icon"><svg class="profile-summary-svg" viewBox="0 0 24 24"><path class="summary-missing-plug" d="M8 3v5M12 3v5M6 8h8v2a4 4 0 0 1-4 4v3"></path><path class="summary-missing-plus" d="M16 16h6M19 13v6"></path></svg></span><strong>1 missing</strong></span>
    </div>
  </div></div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${styles}
html, body { margin: 0; min-height: 100%; background: #0b0f16; color: #e8edf6; }
body { display: grid; place-items: center; min-height: 100vh; }
.visual-shell { width: 720px; padding: 32px; border: 1px solid #2c3545; border-radius: 16px; background: #121823; box-sizing: border-box; }
.visual-title { margin-bottom: 18px; font: 600 16px/1.3 system-ui, sans-serif; }
.visual-row { display: flex; flex-wrap: wrap; align-items: center; gap: 18px 26px; }
.profile-summary-item { font-family: system-ui, sans-serif; font-size: 13px; }
</style></head><body>${cards}</body></html>`;

async function inspectAnimations(win) {
  return await win.webContents.executeJavaScript(`(() => {
    const selectors = ['.summary-working-bolt', '.summary-working-spark', '.summary-idle-ring', '.summary-idle-check', '.summary-hung-triangle', '.summary-hung-mark', '.summary-hung-dot', '.summary-missing-plug', '.summary-missing-plus'];
    const animations = Object.fromEntries(selectors.map((selector) => [selector, getComputedStyle(document.querySelector(selector)).animationName]));
    const shell = document.querySelector('.visual-shell');
    const icon = document.querySelector('.profile-summary-icon');
    const iconSvg = icon.querySelector('svg');
    const rect = shell.getBoundingClientRect();
    const iconStyle = getComputedStyle(icon);
    const iconSvgStyle = getComputedStyle(iconSvg);
    return { animations, icon: { width: parseFloat(iconStyle.width), height: parseFloat(iconStyle.height), svgWidth: parseFloat(iconSvgStyle.width), svgHeight: parseFloat(iconSvgStyle.height) }, shell: { left: rect.left, right: rect.right, width: rect.width, scrollWidth: shell.scrollWidth, clientWidth: shell.clientWidth }, viewportWidth: document.documentElement.clientWidth };
  })()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 360, show: false, webPreferences: { offscreen: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const normal = await inspectAnimations(win);
    for (const [selector, animationName] of Object.entries(normal.animations)) {
      if (!animationName || animationName === "none") throw new Error(`${selector} is not animated at runtime`);
    }
    if (normal.icon.width < 18 || normal.icon.height < 18 || normal.icon.svgWidth < 18 || normal.icon.svgHeight < 18) {
      throw new Error(`Overview profile summary icons are too small: ${JSON.stringify(normal.icon)}`);
    }
    if (normal.shell.scrollWidth > normal.shell.clientWidth + 2 || normal.shell.left < -2 || normal.shell.right > normal.viewportWidth + 2) {
      throw new Error(`Profile summary fixture overflowed: ${JSON.stringify(normal.shell)}`);
    }
    const screenshotPath = path.join(os.tmpdir(), "codexpro-profile-summary-status.png");
    const image = await win.webContents.capturePage();
    fs.writeFileSync(screenshotPath, image.toPNG());

    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const reduced = await inspectAnimations(win);
    for (const [selector, animationName] of Object.entries(reduced.animations)) {
      if (animationName !== "none") throw new Error(`${selector} must stop animating with prefers-reduced-motion: reduce`);
    }
    console.log("profile summary visual smoke passed");
    console.log(`visual screenshot: ${screenshotPath}`);
  } finally {
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
    win.destroy();
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
