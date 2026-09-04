const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const managerRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(managerRoot, "..");
const styles = fs.readFileSync(path.join(managerRoot, "src", "styles.css"), "utf8");
const composerSource = fs.readFileSync(path.join(managerRoot, "src", "features", "chat", "chat-request-composer.jsx"), "utf8");

for (const required of ["request-composer", "request-files", "request-composer-toolbar", "send-debug-evidence", "request-card-foot", "request-card-actions"]) {
  if (!composerSource.includes(required) && !styles.includes(`.${required}`)) throw new Error(`missing ${required}`);
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}
html,body{margin:0;width:100%;height:100%;background:#080b10;color:#e7edf6;overflow:hidden}.qa-stage{min-height:100vh;display:grid;place-items:center;padding:28px;box-sizing:border-box}.qa-chat{width:min(940px,94vw);max-height:92vh;overflow:auto}.qa-chat .chat-popup-card{margin:0}</style></head><body>
<div class="qa-stage"><div class="modal chat-modal qa-chat"><article class="request-card chat-popup-card is-online">
  <label class="request-label" for="request-qa">Nhắn tiếp</label>
  <div class="request-composer">
    <textarea id="request-qa" maxlength="20000" placeholder="Nhập file hoặc tin nhắn">Tiếp tục refactor main.jsx, giữ nguyên hành vi gửi follow-up.</textarea>
    <div class="request-files"><div class="request-file" role="button" tabindex="0"><span class="request-file-icon">▤</span><span class="request-file-copy"><strong>notes.txt</strong><small>12 KB</small></span><button type="button">×</button></div></div>
    <div class="request-composer-toolbar"><button type="button" class="attach-button" aria-label="Thêm file"><svg viewBox="0 0 24 24"><path d="M20.5 11.5 11 21a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.6l-10 10a2 2 0 1 1-2.9-2.8l9.6-9.6" /></svg></button><span>1/4 file · 12 KB</span></div>
  </div>
  <details class="send-debug-evidence" open><summary>Debug Evidence <span>network ACK</span></summary><div class="send-debug-grid"><div class="send-debug-row"><strong>Attempt</strong><code>cpt_visual_smoke</code></div><div class="send-debug-row"><strong>Submission</strong><code>submitted</code></div><div class="send-debug-row"><strong>Network ACK</strong><code>yes</code></div><div class="send-debug-row"><strong>HTTP</strong><code>200</code></div></div></details>
  <div class="request-card-foot"><span>Đang nhận phản hồi</span><div class="request-card-actions"><button class="button secondary">Đóng</button><button class="button secondary">Mở Chrome</button><button class="button primary">Gửi thêm</button></div></div>
</article></div></div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 900, show: false, backgroundColor: "#080b10", webPreferences: { offscreen: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const metrics = await win.webContents.executeJavaScript(`(() => {
      const rect = (selector) => { const value = document.querySelector(selector).getBoundingClientRect(); return { left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height }; };
      return { chat:rect('.qa-chat'), composer:rect('.request-composer'), textarea:rect('.request-composer textarea'), files:rect('.request-files'), debug:rect('.send-debug-evidence'), footer:rect('.request-card-foot'), viewport:{w:innerWidth,h:innerHeight} };
    })()`);
    if (metrics.chat.left < 0 || metrics.chat.right > metrics.viewport.w || metrics.chat.top < 0 || metrics.chat.bottom > metrics.viewport.h) throw new Error(`chat composer fixture overflow: ${JSON.stringify(metrics)}`);
    if (metrics.composer.width < 700 || metrics.textarea.height < 90) throw new Error(`chat composer geometry regressed: ${JSON.stringify(metrics)}`);
    if (metrics.files.bottom > metrics.composer.bottom + 1) throw new Error(`attachments escape composer: ${JSON.stringify(metrics)}`);
    if (metrics.footer.left < metrics.chat.left || metrics.footer.right > metrics.chat.right + 1) throw new Error(`chat composer footer alignment regressed: ${JSON.stringify(metrics)}`);
    const outputDir = path.join(repoRoot, ".ai-bridge");
    fs.mkdirSync(outputDir, { recursive: true });
    const screenshotPath = path.join(outputDir, "chat-request-composer-visual.png");
    fs.writeFileSync(screenshotPath, (await win.webContents.capturePage()).toPNG());
    console.log("Chat request composer visual smoke passed");
    console.log(`visual screenshot: ${screenshotPath}`);
  } finally {
    win.destroy();
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });
