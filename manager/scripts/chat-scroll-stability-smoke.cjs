const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
]);

app.setPath("userData", path.join(os.tmpdir(), `codexpro-chat-scroll-smoke-${process.pid}`));

app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const filePath = request.url === "/src/chat-scroll.js"
      ? path.join(__dirname, "../src/chat-scroll.js")
      : path.join(__dirname, "chat-scroll-stability-fixture.html");
    response.setHeader("Content-Type", filePath.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(fs.readFileSync(filePath));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true }
  });
  try {
    await withTimeout(window.loadURL(`http://127.0.0.1:${address.port}/fixture.html`), 5000, "fixture load");
    const deadline = Date.now() + 5000;
    let result = null;
    while (Date.now() < deadline) {
      result = await withTimeout(window.webContents.executeJavaScript("window.__chatScrollResult || null", true), 1000, "fixture result read");
      if (result) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!result?.ok) {
      const diagnostics = await withTimeout(window.webContents.executeJavaScript("({ readyState: document.readyState, moduleStarted: Boolean(window.__chatScrollModuleStarted), errors: window.__chatScrollErrors || [], result: window.__chatScrollResult || null })", true), 1000, "fixture diagnostics");
      throw new Error(`Chat scroll stability fixture failed: ${JSON.stringify(diagnostics)}`);
    }
    if (result.order.join("|") !== "old assistant one|old user|old assistant two|new user|canonical response") throw new Error(`Chat order changed: ${JSON.stringify(result.order)}`);
    if (result.oldMessageHeights.some((height) => height < 74)) throw new Error(`Old messages shrank or overlapped: ${JSON.stringify(result.oldMessageHeights)}`);
    const screenshotPath = path.join(os.tmpdir(), "codexpro-chat-scroll-stability.png");
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
    console.log(`✓ Chat scroll stability Electron smoke passed: ${JSON.stringify(result.steps)}`);
    console.log(`  Visual fixture: ${screenshotPath}`);
    server.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    server.close();
    app.exit(1);
  }
});
