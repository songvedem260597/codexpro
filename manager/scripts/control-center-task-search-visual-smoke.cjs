const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
]);

app.setPath("userData", path.join(os.tmpdir(), `codexpro-task-search-visual-${process.pid}`));

app.whenReady().then(async () => {
  const managerRoot = path.resolve(__dirname, "..");
  const outputRoot = path.join(os.tmpdir(), `codexpro-task-search-visual-build-${process.pid}`);
  const fixtureHtml = path.join(__dirname, "control-center-task-search-visual-fixture.html");
  const screenshotPath = process.env.CODEXPRO_VISUAL_OUTPUT
    ? path.resolve(managerRoot, "..", process.env.CODEXPRO_VISUAL_OUTPUT)
    : path.join(os.tmpdir(), "codexpro-task-search-visual.png");
  const { build } = await import("vite");

  await build({
    root: managerRoot,
    base: "./",
    logLevel: "error",
    build: { outDir: outputRoot, emptyOutDir: true, rollupOptions: { input: fixtureHtml } }
  });

  const builtHtml = path.join(outputRoot, "scripts", "control-center-task-search-visual-fixture.html");
  if (!fs.existsSync(builtHtml)) throw new Error(`Task search visual fixture output missing: ${builtHtml}`);

  const window = new BrowserWindow({
    width: 1480,
    height: 900,
    show: false,
    backgroundColor: "#090d12",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true }
  });

  const setSearch = async (value) => {
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.control-task-search');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`, true);
    await wait(120);
    return window.webContents.executeJavaScript(`(() => ({
      value: document.querySelector('.control-task-search')?.value || '',
      running: [...document.querySelectorAll('.control-task')].map((el) => el.innerText),
      completed: [...document.querySelectorAll('.control-terminal-section.is-completed .control-terminal-task')].map((el) => el.innerText),
      failed: [...document.querySelectorAll('.control-terminal-section.is-failed .control-terminal-task')].map((el) => el.innerText),
      unfinished: [...document.querySelectorAll('.control-terminal-section.is-unfinished .control-terminal-task')].map((el) => el.innerText),
      emptyText: document.querySelector('.control-task-section .control-empty')?.innerText || ''
    }))()`, true);
  };

  try {
    await withTimeout(window.loadFile(builtHtml), 10000, "task search visual fixture load");
    await wait(500);
    const inputMetrics = await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.control-task-search');
      const tools = document.querySelector('.control-task-search-tools');
      const r = input?.getBoundingClientRect();
      return { exists: Boolean(input), width: Math.round(r?.width || 0), height: Math.round(r?.height || 0), toolsWidth: Math.round(tools?.getBoundingClientRect().width || 0), bodyScrollWidth: document.body.scrollWidth, bodyClientWidth: document.body.clientWidth };
    })()`, true);
    if (!inputMetrics.exists || inputMetrics.width < 190 || inputMetrics.height < 32) throw new Error(`Task search input layout is invalid: ${JSON.stringify(inputMetrics)}`);
    if (inputMetrics.bodyScrollWidth > inputMetrics.bodyClientWidth + 3) throw new Error(`Task search fixture has horizontal overflow: ${JSON.stringify(inputMetrics)}`);

    const running = await setSearch("repo picker");
    if (running.running.length !== 1 || !running.running[0].includes("Sửa lỗi repo picker")) throw new Error(`Running task title search failed: ${JSON.stringify(running)}`);

    const completed = await setSearch("can padding");
    if (completed.completed.length !== 1 || !completed.completed[0].includes("Cân padding tin nhắn") || completed.running.length !== 0) throw new Error(`Accent-insensitive completed task search failed: ${JSON.stringify(completed)}`);

    const failed = await setSearch("nhap nhay");
    if (failed.failed.length !== 1 || !failed.failed[0].includes("Fix nhấp nháy khung chat")) throw new Error(`Accent-insensitive failed task search failed: ${JSON.stringify(failed)}`);

    const unfinished = await setSearch("transcript");
    if (unfinished.unfinished.length !== 1 || !unfinished.unfinished[0].includes("Tải transcript streaming")) throw new Error(`Unfinished task search failed: ${JSON.stringify(unfinished)}`);

    const none = await setSearch("khong ton tai");
    if (none.running.length || none.completed.length || none.failed.length || none.unfinished.length || !/Không tìm thấy task đang chạy/.test(none.emptyText)) throw new Error(`No-result task search state failed: ${JSON.stringify(none)}`);

    await setSearch("can padding");
    await window.webContents.executeJavaScript(`(() => { const el=document.querySelector('.control-task-section'); const r=el.getBoundingClientRect(); window.scrollTo({top:Math.max(0, window.scrollY + r.top - 18), behavior:'instant'}); })()`, true);
    await wait(100);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
    console.log("control-center-task-search-visual-smoke: ok");
    console.log(JSON.stringify({ inputMetrics, screenshotPath }, null, 2));
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    app.exit(1);
  }
});
