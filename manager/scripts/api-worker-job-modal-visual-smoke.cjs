const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const managerRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(managerRoot, "..");
const styles = fs.readFileSync(path.join(managerRoot, "src", "styles.css"), "utf8");
const modalSource = fs.readFileSync(path.join(managerRoot, "src", "features", "api-workers", "api-worker-job-modal.jsx"), "utf8");

for (const required of ["api-job-modal", "chat-modal-head", "chat-popup-card", "request-composer", "request-card-actions"]) {
  if (!modalSource.includes(required) && !styles.includes(`.${required}`)) throw new Error(`missing ${required}`);
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}
html,body{margin:0;width:100%;height:100%;background:#080b10;color:#e7edf6;overflow:hidden}.qa-worker-placeholder{width:78px;height:78px;border-radius:22px;display:grid;place-items:center;background:#111925;border:1px solid #2b3b50;color:#9fb0c5;font:700 12px system-ui}.api-job-modal .project-dropdown{width:100%}.api-job-modal-backdrop{background:#05070bc2}</style></head><body>
<div class="modal-backdrop chat-modal-backdrop api-job-modal-backdrop"><div class="modal chat-modal api-job-modal">
  <div class="modal-head chat-modal-head"><div class="chat-modal-profile"><div class="qa-worker-placeholder">API</div><div><p class="eyebrow">API WORKER · 9router</p><div class="profile-title"><strong>9Router</strong><span class="badge connected">ĐANG RẢNH</span></div><code>api:9router-main · cc/claude-opus-4-6</code></div></div><button type="button"><span>×</span></button></div>
  <article class="request-card chat-popup-card is-online">
    <label class="request-label">Chọn repo và đường dẫn</label>
    <div class="project-dropdown"><button class="project-dropdown-trigger" type="button"><span class="project-dropdown-value"><strong>codexpro-source</strong><small>C:\\Users\\uchih\\Documents\\Codex\\codexpro-source</small></span><span class="project-dropdown-chevron">⌄</span></button></div>
    <label class="request-label request-section-label">Tin nhắn gần nhất</label>
    <div class="latest-response chat-transcript"><div class="chat-response is-inline"><div class="response-copy"><strong>Refactor API worker modal</strong><p>Đã chuẩn bị tách modal khỏi main.jsx và giữ nguyên hành vi gửi task.</p></div></div></div>
    <label class="request-label" for="api-job-request">Nhắn tiếp</label>
    <div class="request-composer"><textarea id="api-job-request" placeholder="Nhập file hoặc tin nhắn">Tiếp tục kiểm tra và build</textarea><div class="request-composer-toolbar"><button class="attach-button" type="button">＋</button><span>26/20.000 · TXT, PDF, mã nguồn, Office, ảnh…</span></div></div>
    <div class="request-card-foot"><span>AI tự đặt title 4–6 từ; Rules, AGENTS, CodexGraph và tool call đều đi qua MCP.</span><div class="request-card-actions"><button class="button secondary">Đóng</button><button class="button primary">Gửi yêu cầu</button></div></div>
  </article>
</div></div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 900, show: false, backgroundColor: "#080b10", webPreferences: { offscreen: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const metrics = await win.webContents.executeJavaScript(`(() => {
      const rect = (selector) => { const value = document.querySelector(selector).getBoundingClientRect(); return { left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height }; };
      const modal = document.querySelector('.api-job-modal'); return { modal:rect('.api-job-modal'), composer:rect('.request-composer'), footer:rect('.request-card-foot'), picker:rect('.project-dropdown-trigger'), viewport:{w:innerWidth,h:innerHeight}, scroll:{clientHeight:modal.clientHeight,scrollHeight:modal.scrollHeight} };
    })()`);
    if (metrics.modal.left < 0 || metrics.modal.right > metrics.viewport.w || metrics.modal.top < 0 || metrics.modal.bottom > metrics.viewport.h) throw new Error(`API job modal overflow: ${JSON.stringify(metrics)}`);
    if (metrics.composer.height < 90) throw new Error(`API job composer too short: ${JSON.stringify(metrics)}`);
    if (metrics.footer.bottom > metrics.modal.bottom + 1 && metrics.scroll.scrollHeight <= metrics.scroll.clientHeight) throw new Error(`API job footer escapes a non-scrollable modal: ${JSON.stringify(metrics)}`);
    if (metrics.picker.width < 400) throw new Error(`API job repo picker too narrow: ${JSON.stringify(metrics)}`);
    const outputDir = path.join(repoRoot, ".ai-bridge");
    fs.mkdirSync(outputDir, { recursive: true });
    const screenshotPath = path.join(outputDir, "api-worker-job-modal-visual.png");
    fs.writeFileSync(screenshotPath, (await win.webContents.capturePage()).toPNG());
    console.log("API worker job modal visual smoke passed");
    console.log(`visual screenshot: ${screenshotPath}`);
  } finally {
    win.destroy();
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });
