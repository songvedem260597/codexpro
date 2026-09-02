const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const managerRoot = path.resolve(__dirname, "..");
const styles = fs.readFileSync(path.join(managerRoot, "src", "styles.css"), "utf8");

const orbitStars = [
  [2, .72, 30, 7, 1], [3, .86, 38, 11, 4], [2, .58, 44, 9, 7], [4, .82, 50, 15, 2],
  [2, .66, 56, 13, 8], [3, .78, 62, 17, 5], [2, .54, 68, 12, 9], [3, .9, 74, 19, 3]
].map(([size, alpha, distance, duration, delay]) => `<span class="chat-galaxy-star" style="--size:${size}px;--alpha:${alpha};--distance:${distance}px;--duration:${duration}s;--delay:${delay}s"></span>`).join("");
const staticStars = [[18, 28, 2, .78], [34, 72, 3, .88], [68, 24, 2, .7], [82, 67, 3, .82]]
  .map(([x, y, size, alpha]) => `<span class="chat-galaxy-star is-static" style="--x:${x}%;--y:${y}%;--size:${size}px;--alpha:${alpha}"></span>`).join("");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${styles}
html, body { margin: 0; min-height: 100%; background: #0b0f16; color: #e8edf6; }
body { min-height: 100vh; display: grid; place-items: center; }
.fixture { width: 520px; padding: 56px; border: 1px solid #273144; border-radius: 18px; background: #111720; font-family: system-ui, sans-serif; }
.fixture-title { margin-bottom: 24px; color: #9eabc0; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.profile-action-buttons { width: 244px; }
</style></head><body>
  <div class="fixture">
    <div class="fixture-title">Chat galaxy button · no outer glow</div>
    <div class="profile-action-buttons">
      <button class="button primary profile-chat chat-galaxy-button" type="button">
        <span class="chat-galaxy-backdrop" aria-hidden="true"></span>
        <span class="chat-galaxy-spark" aria-hidden="true"></span>
        <span class="chat-galaxy-static" aria-hidden="true">${staticStars}</span>
        <span class="chat-galaxy-orbit" aria-hidden="true"><span class="chat-galaxy-ring">${orbitStars}</span></span>
        <span class="chat-galaxy-label">Chat</span>
      </button>
    </div>
  </div>
</body></html>`;

async function inspect(win) {
  return win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('.chat-galaxy-button');
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const backdrop = getComputedStyle(document.querySelector('.chat-galaxy-backdrop'));
    const orbit = getComputedStyle(document.querySelector('.chat-galaxy-orbit'));
    const spark = getComputedStyle(document.querySelector('.chat-galaxy-spark'), '::before');
    const star = getComputedStyle(document.querySelector('.chat-galaxy-star:not(.is-static)'));
    return {
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      boxShadow: style.boxShadow,
      transform: style.transform,
      color: style.color,
      background: style.backgroundColor,
      backdrop: backdrop.backgroundImage,
      orbitOpacity: orbit.opacity,
      sparkAnimation: spark.animationName,
      starAnimation: star.animationName,
      viewport: { width: innerWidth, height: innerHeight }
    };
  })()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 760, height: 430, show: false, backgroundColor: "#0b0f16", webPreferences: { offscreen: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const idle = await inspect(win);
    const cx = Math.round((idle.rect.left + idle.rect.right) / 2);
    const cy = Math.round((idle.rect.top + idle.rect.bottom) / 2);
    win.webContents.sendInputEvent({ type: "mouseMove", x: cx, y: cy, movementX: 0, movementY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 320));
    const hovered = await inspect(win);

    if (idle.boxShadow !== "none" || hovered.boxShadow !== "none") throw new Error(`Chat button gained an outer glow: idle=${idle.boxShadow} hover=${hovered.boxShadow}`);
    if (Number(hovered.orbitOpacity) < 0.95) throw new Error(`Galaxy did not become visible on hover: ${hovered.orbitOpacity}`);
    if (!/radial-gradient/i.test(hovered.backdrop)) throw new Error(`Galaxy hover backdrop is missing: ${hovered.backdrop}`);
    if (hovered.sparkAnimation !== "chat-galaxy-spark-rotate") throw new Error(`Rotating spark is not active: ${hovered.sparkAnimation}`);
    if (hovered.starAnimation !== "chat-galaxy-orbit") throw new Error(`Orbiting stars are not active: ${hovered.starAnimation}`);
    if (hovered.rect.left < 0 || hovered.rect.right > hovered.viewport.width || hovered.rect.top < 0 || hovered.rect.bottom > hovered.viewport.height) throw new Error(`Chat button overflowed fixture viewport: ${JSON.stringify(hovered.rect)}`);

    const screenshotPath = path.join(managerRoot, "chat-galaxy-button-smoke.png");
    const image = await win.webContents.capturePage();
    fs.writeFileSync(screenshotPath, image.toPNG());

    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const reduced = await inspect(win);
    if (reduced.sparkAnimation !== "none" || reduced.starAnimation !== "none") throw new Error(`Reduced motion did not stop galaxy animation: ${JSON.stringify(reduced)}`);

    console.log(`✓ Chat galaxy visual smoke passed: ${JSON.stringify({ idle, hovered, reduced: { sparkAnimation: reduced.sparkAnimation, starAnimation: reduced.starAnimation } })}`);
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
