const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const installer = fs.readFileSync(path.join(__dirname, "../../chrome-extension/connector-installer.js"), "utf8");
const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
]);

app.setPath("userData", path.join(os.tmpdir(), `codexpro-connector-dom-smoke-${process.pid}`));

app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html lang="vi"><head><style>
      body,main,dialog,button,input,div,span,h2,section { display:block; width:240px; min-height:24px; }
    </style></head><body><main><input id="plugin-search" value="CodexPro"><button aria-label="Create app">Create app</button></main>
    <script>window.chrome={runtime:{onMessage:{addListener(listener){window.__connectorListener=listener;}}}};</script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true }
  });
  try {
    const address = server.address();
    await withTimeout(window.loadURL(`http://127.0.0.1:${address.port}/plugins`), 5000, "fixture load");
    await window.webContents.executeJavaScript(installer, true);
    const delayedListResult = await withTimeout(window.webContents.executeJavaScript(`new Promise((resolve) => {
      setTimeout(() => {
        const card=document.createElement('button');
        card.setAttribute('aria-label','Actions for CodexPro');
        card.textContent='CodexPro';
        document.querySelector('main').appendChild(card);
      },1700);
      window.__connectorListener({type:'codexpro-check-connector'},null,resolve);
    })`, true), 15000, "delayed plugin list");
    if (!delayedListResult?.installed) throw new Error(`delayed CodexPro card was missed: ${JSON.stringify(delayedListResult)}`);

    const staticConnectionResult = await withTimeout(window.webContents.executeJavaScript(`new Promise((resolve) => {
      document.body.innerHTML='<dialog open role="dialog"><div>Settings</div><div>Plugins</div><section><h2>CodexPro</h2><div><span>Connection</span><span>Connected</span></div></section></dialog>';
      window.__connectorListener({type:'codexpro-check-connector-connection'},null,resolve);
    })`, true), 8000, "static Connection status");
    if (!staticConnectionResult?.connected || staticConnectionResult.connection_state !== "connected") {
      throw new Error(`static Connection status was missed: ${JSON.stringify(staticConnectionResult)}`);
    }

    const disconnectedResult = await withTimeout(window.webContents.executeJavaScript(`new Promise((resolve) => {
      document.body.innerHTML='<dialog open role="dialog"><div>Settings</div><div>Plugins</div><section><h2>CodexPro</h2><button>Connection Connect</button></section></dialog>';
      window.__connectorListener({type:'codexpro-check-connector-connection'},null,resolve);
    })`, true), 8000, "disconnected definition status");
    if (disconnectedResult?.connected || disconnectedResult.connection_state !== "disconnected") {
      throw new Error(`listed but disconnected definition was conflated with missing: ${JSON.stringify(disconnectedResult)}`);
    }
    const delayedStatus = await withTimeout(window.webContents.executeJavaScript(`new Promise((resolve) => {
      document.body.innerHTML='<dialog open role="dialog"><div>Cài đặt</div><div>Plugins</div><section><h2>CodexPro</h2><div><span>Kết nối</span><span id="connection-value"></span></div></section></dialog>';
      setTimeout(() => {document.querySelector('#connection-value').textContent='Đã kết nối';},700);
      window.__connectorListener({type:'codexpro-check-connector-connection'},null,resolve);
    })`, true), 8000, "delayed localized Connection status");
    if (!delayedStatus?.connected) throw new Error(`static label won over delayed connected status: ${JSON.stringify(delayedStatus)}`);

    const labelOnly = await withTimeout(window.webContents.executeJavaScript(`new Promise((resolve) => {
      document.body.innerHTML='<dialog open role="dialog"><div>Cài đặt</div><div>Plugins</div><section><h2>CodexPro</h2><div>Kết nối</div></section></dialog>';
      window.__connectorListener({type:'codexpro-check-connector-connection'},null,resolve);
    })`, true), 8000, "Connection label without status");
    if (labelOnly?.connection_state !== 'unknown') throw new Error(`a section heading is not a Connect action: ${JSON.stringify(labelOnly)}`);
    console.log("✓ Connector DOM smoke passed: delayed list/status, connected, disconnected action, and unknown label");
    server.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    server.close();
    app.exit(1);
  }
});
