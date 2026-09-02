const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
]);

app.setPath("userData", path.join(os.tmpdir(), `codexpro-chat-border-smoke-${process.pid}`));

app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const filePath = request.url === "/src/styles.css"
      ? path.join(__dirname, "../src/styles.css")
      : path.join(__dirname, "chat-border-state-fixture.html");
    response.setHeader("Content-Type", filePath.endsWith(".css") ? "text/css" : "text/html");
    response.end(fs.readFileSync(filePath));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const window = new BrowserWindow({
    width: 1120,
    height: 430,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true }
  });
  try {
    await withTimeout(window.loadURL(`http://127.0.0.1:${address.port}/fixture.html`), 5000, "fixture load");
    const deadline = Date.now() + 6000;
    let result = null;
    while (Date.now() < deadline) {
      result = await withTimeout(window.webContents.executeJavaScript("window.__chatBorderStateResult || null", true), 1000, "fixture result read");
      if (result) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!result?.ok) throw new Error(`Chat border state fixture failed: ${JSON.stringify(result)}`);
    const screenshotPath = path.join(os.tmpdir(), "codexpro-chat-border-state.png");
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
    console.log(`✓ Chat border state Electron smoke passed: ${JSON.stringify(result)}`);
    console.log(`  Visual fixture: ${screenshotPath}`);
    server.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    server.close();
    app.exit(1);
  }
});
