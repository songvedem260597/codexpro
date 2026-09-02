const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const managerRoot = path.resolve(__dirname, "..");
const styles = fs.readFileSync(path.join(managerRoot, "src", "styles.css"), "utf8");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${styles}
html, body { margin: 0; min-height: 100%; background: #0b0f16; color: #e8edf6; }
body { display: grid; place-items: center; min-height: 100vh; }
.visual-shell { width: 820px; padding: 44px; border: 1px solid #263244; border-radius: 18px; background: radial-gradient(circle at 50% 0%, #172033, #0d1118 58%); box-sizing: border-box; }
.visual-title { margin-bottom: 20px; color: #aab7ca; font: 600 13px/1.3 system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; }
.profile-list { display: block; }
.browser-profile { min-height: 150px; }
.profile-main { min-width: 0; flex: 1; font-family: system-ui, sans-serif; }
.profile-title { display: flex; align-items: center; gap: 10px; font-size: 16px; }
.profile-meta { margin-top: 12px; color: #8c98ab; font: 13px/1.5 system-ui, sans-serif; }
.profile-live-activity { margin-top: 16px; color: #bdc9dc; font: 13px/1.5 system-ui, sans-serif; }
</style></head><body>
  <div class="visual-shell">
    <div class="visual-title">Working worker - rotating mint-blue border</div>
    <div class="profile-list working-border-shine is-row-layout">
      <article class="browser-profile is-online is-working">
        <div class="profile-worker is-working"><span class="profile-worker-dot"></span></div>
        <div class="profile-main">
          <div class="profile-title"><strong>Working worker</strong><span class="badge">WORKING</span></div>
          <div class="profile-meta">CodexPro - ChatGPT worker - active task</div>
          <div class="profile-live-activity">Running tools and updating results...</div>
        </div>
      </article>
    </div>
  </div>
</body></html>`;

async function inspect(win) {
  return win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.browser-profile.is-working');
    const pseudo = getComputedStyle(card, '::before');
    const rect = card.getBoundingClientRect();
    return {
      animationName: pseudo.animationName,
      animationDuration: pseudo.animationDuration,
      angle: pseudo.getPropertyValue('--profile-border-shine-angle').trim(),
      backgroundImage: pseudo.backgroundImage,
      webkitMaskComposite: pseudo.webkitMaskComposite,
      maskComposite: pseudo.maskComposite,
      card: { left: rect.left, right: rect.right, width: rect.width, scrollWidth: card.scrollWidth, clientWidth: card.clientWidth },
      viewportWidth: document.documentElement.clientWidth
    };
  })()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 980, height: 470, show: false, backgroundColor: "#0b0f16", webPreferences: { offscreen: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 260));
    const first = await inspect(win);
    await new Promise((resolve) => setTimeout(resolve, 420));
    const second = await inspect(win);

    if (first.animationName !== "profile-border-shine" || first.animationDuration !== "2.8s") {
      throw new Error(`Working border animation is not active: ${JSON.stringify(first)}`);
    }
    if (!/#7cffc4|rgb\(124, 255, 196\)/i.test(first.backgroundImage) || !/#6aa7ff|rgb\(106, 167, 255\)/i.test(first.backgroundImage)) {
      throw new Error(`Working border does not use the requested mint-blue gradient: ${first.backgroundImage}`);
    }
    if (!first.webkitMaskComposite || first.webkitMaskComposite === "source-over") {
      throw new Error(`Working border WebKit mask ring is not active: ${first.webkitMaskComposite}`);
    }
    if (!first.maskComposite || /add|source-over/i.test(first.maskComposite)) {
      throw new Error(`Working border standard mask ring is not active: ${first.maskComposite}`);
    }
    if (first.angle && second.angle && first.angle === second.angle) {
      throw new Error(`Registered angle did not interpolate at runtime: ${first.angle}`);
    }
    if (first.card.scrollWidth > first.card.clientWidth + 2 || first.card.left < -2 || first.card.right > first.viewportWidth + 2) {
      throw new Error(`Working border fixture overflowed: ${JSON.stringify(first.card)}`);
    }

    const screenshotPath = path.join(managerRoot, "working-border-shine-smoke.png");
    const image = await win.webContents.capturePage();
    fs.writeFileSync(screenshotPath, image.toPNG());

    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const reduced = await inspect(win);
    if (reduced.animationName !== "none") throw new Error(`Working border must stop with reduced motion: ${reduced.animationName}`);

    console.log("working border shine visual smoke passed");
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
