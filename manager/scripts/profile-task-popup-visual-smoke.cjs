const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const managerRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(managerRoot, "..");
const styles = fs.readFileSync(path.join(managerRoot, "src", "styles.css"), "utf8");
const source = fs.readFileSync(path.join(managerRoot, "src", "main.jsx"), "utf8");

for (const required of ["profile-task-button", "profile-task-modal", "profile-task-worker-state", "profile-task-item", "profile-task-resume"]) {
  if (!source.includes(required) && !styles.includes(`.${required}`)) throw new Error(`missing ${required}`);
}

const taskItem = ({ status, label, title, progress, current = false, reason = "", completed = false }) => `
<article class="profile-task-item is-${status} ${current ? "is-current" : ""}">
  <div class="profile-task-item-head">
    <div class="profile-task-item-title">
      <div><span class="profile-task-status is-${status}">${label}</span>${current ? '<span class="profile-task-current">HIỆN TẠI</span>' : ""}</div>
      <strong>${title}</strong><code>cpt_da517933d666171dcec72c08</code>
    </div><time>04:55 04/09</time>
  </div>
  <div class="profile-task-progress-row"><span>Tiến độ</span><strong>${progress}%</strong></div>
  <div class="profile-task-progress-track"><i style="width:${progress}%"></i></div>
  <div class="profile-task-parts"><span class="is-done">✓ Phân tích source · Chốt UX popup</span><span class="is-left">→ Build/test · Commit/push</span></div>
  ${reason ? `<div class="profile-task-reason"><span>Lý do gần nhất</span><p>${reason}</p></div>` : ""}
  <div class="profile-task-item-foot"><span>codexpro-source</span>${completed ? '<span class="profile-task-done">✓ Đã hoàn thành</span>' : '<button class="button primary profile-task-resume">Tiếp tục task</button>'}</div>
</article>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}
html,body{margin:0;width:100%;height:100%;background:#080b10;color:#e7edf6;overflow:hidden}.qa-stage{min-height:100vh;padding:38px;box-sizing:border-box}.qa-card-wrap{width:520px;display:block}.qa-card-wrap.profile-list.is-card-layout{grid-template-columns:1fr}.qa-card-wrap .browser-profile{width:520px;min-height:430px;box-sizing:border-box}.qa-card-wrap .profile-worker{width:150px;height:150px}.qa-card-wrap .profile-worker img{display:none}.qa-card-wrap .profile-worker::before{content:'Worker';display:grid;place-items:center;width:100%;height:100%;color:#91a0b6;font:600 14px system-ui}.profile-task-modal-backdrop{background:#05070bc2}</style></head><body>
<div class="qa-stage"><div class="qa-card-wrap profile-list is-card-layout"><article class="browser-profile is-online is-idle">
<div class="profile-worker"><span class="profile-worker-dot"></span></div><div class="profile-main"><div class="profile-title"><strong>Chrome 8fcfb133</strong><span class="badge connected">ĐANG RẢNH</span></div><span class="active-repo-chip">songvedem260597/codexpro</span><div class="profile-meta"><span>Extension online</span><span>v0.5.118</span><span>1 tab</span></div><div class="profile-task-summary"><span>TASK GẦN NHẤT</span><strong>Rà soát code chưa hoàn tất</strong></div></div>
<div class="profile-actions"><button class="button secondary profile-task-button"><span>Task</span><b>6</b></button><div class="profile-action-buttons"><button class="button primary profile-chat">Chat</button><button class="button secondary open-profile">Mở Chrome</button></div><span class="already-connected is-idle">✓ Đã thêm CodexPro</span></div>
</article></div></div>
<div class="modal-backdrop profile-task-modal-backdrop"><div class="modal profile-task-modal">
<div class="modal-head profile-task-modal-head"><div><p class="eyebrow">TASK · Chrome 8fcfb133</p><h2>Danh sách task</h2><p>2 task có thể tiếp tục ngay.</p></div><button><span>×</span></button></div>
<div class="profile-task-worker-state is-idle"><span class="profile-task-worker-dot"></span><strong>Worker đang rảnh</strong><small>Có thể tiếp tục task thất bại hoặc chưa hoàn thành.</small></div>
<div class="profile-task-list">
${taskItem({status:"running",label:"Chưa hoàn thành",title:"Rà soát code chưa hoàn tất",progress:72,current:true})}
${taskItem({status:"failed",label:"Thất bại",title:"Sửa upload attachment cũ",progress:45,reason:"Network ACK dừng trước finalize; còn build và verify."})}
${taskItem({status:"completed",label:"Hoàn thành",title:"Ẩn worktree khỏi repo picker",progress:100,completed:true})}
</div></div></div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1120, height: 860, show: false, backgroundColor: "#080b10", webPreferences: { offscreen: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const metrics = await win.webContents.executeJavaScript(`(() => {
      const modal = document.querySelector('.profile-task-modal').getBoundingClientRect();
      const taskButton = document.querySelector('.profile-task-button').getBoundingClientRect();
      const chatButton = document.querySelector('.profile-action-buttons .profile-chat').getBoundingClientRect();
      const list = document.querySelector('.profile-task-list');
      const resume = document.querySelector('.profile-task-resume');
      return { modal: {left:modal.left,right:modal.right,top:modal.top,bottom:modal.bottom,width:modal.width,height:modal.height}, viewport:{w:innerWidth,h:innerHeight}, taskTop:taskButton.top, chatTop:chatButton.top, list:{scrollHeight:list.scrollHeight,clientHeight:list.clientHeight}, resumeDisabled:resume.disabled };
    })()`);
    if (metrics.modal.left < 0 || metrics.modal.right > metrics.viewport.w || metrics.modal.top < 0 || metrics.modal.bottom > metrics.viewport.h) throw new Error(`task popup overflow: ${JSON.stringify(metrics)}`);
    if (!(metrics.taskTop < metrics.chatTop)) throw new Error(`Task button is not above Chat/Mở Chrome: ${JSON.stringify(metrics)}`);
    if (metrics.resumeDisabled) throw new Error("Resume button should be enabled for idle fixture");
    const outputDir = path.join(repoRoot, ".ai-bridge");
    fs.mkdirSync(outputDir, { recursive: true });
    const screenshotPath = path.join(outputDir, "profile-task-popup-visual.png");
    fs.writeFileSync(screenshotPath, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('.profile-task-modal-backdrop').style.display = 'none'`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const buttonScreenshotPath = path.join(outputDir, "profile-task-button-visual.png");
    fs.writeFileSync(buttonScreenshotPath, (await win.webContents.capturePage()).toPNG());
    console.log("profile task popup visual smoke passed");
    console.log(`visual screenshot: ${screenshotPath}`);
    console.log(`button screenshot: ${buttonScreenshotPath}`);
  } finally {
    win.destroy();
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });
