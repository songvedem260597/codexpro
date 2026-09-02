const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
]);

app.setPath("userData", path.join(os.tmpdir(), `codexpro-worker-border-sync-${process.pid}`));

app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    let filePath;
    if (request.url === "/src/styles.css") filePath = path.join(__dirname, "../src/styles.css");
    else if (request.url === "/src/worker-border-sync.js") filePath = path.join(__dirname, "../src/worker-border-sync.js");
    else filePath = path.join(__dirname, "worker-border-sync-fixture.html");
    response.setHeader("Content-Type", filePath.endsWith(".css") ? "text/css" : filePath.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(fs.readFileSync(filePath));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const window = new BrowserWindow({
    width: 1180,
    height: 360,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true }
  });
  try {
    await withTimeout(window.loadURL(`http://127.0.0.1:${address.port}/fixture.html`), 5000, "fixture load");
    const deadline = Date.now() + 9000;
    let result = null;
    while (Date.now() < deadline) {
      result = await withTimeout(window.webContents.executeJavaScript("window.__workerBorderSyncResult || null", true), 1000, "fixture result read");
      if (result) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!result?.ok) throw new Error(`Worker border sync fixture failed: ${JSON.stringify(result)}`);
    const screenshotPath = path.join(os.tmpdir(), "codexpro-worker-border-sync.png");
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
    console.log(`✓ Worker border synchronization Electron smoke passed: ${JSON.stringify(result)}`);
    console.log(`  Visual fixture: ${screenshotPath}`);
    server.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    server.close();
    app.exit(1);
  }
});
