const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const managerRoot = path.resolve(__dirname, "..");
const preload = path.join(managerRoot, "electron", "preload.cjs");
const errors = [];
const repos = [
  { fullName: "songvedem260597/GameCaro-MFC", defaultBranch: "master", private: false },
  { fullName: "songvedem260597/stickvideo-studio", defaultBranch: "main", private: true }
];
const cloudWorker = {
  worker_id: "api:render-deepseek", worker_type: "api",
  label: "Worker Cloud", provider: "openai-compatible",
  model: "deepseek-v4.1-flash:free", connected: true, activity: "idle"
};
const status = {
  config: { port: 8793, hostname: "", root: managerRoot },
  checkedAt: new Date().toISOString(), local: { ok: true, latency: 1 }, tunnel: { ok: false },
  browserProfiles: [], workers: [cloudWorker], workerJobs: [],
  workerExtensionVersion: "0.5.124"
};
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-cloud-dropdown-")));
for (const channel of new Set([...fs.readFileSync(preload, "utf8").matchAll(/invoke(?:Result)?\("([^"]+)"/g)].map((match) => match[1]))) {
  ipcMain.handle(channel, () => {
    if (channel === "codexpro:status") return status;
    if (channel === "codexpro:github-cloud-repositories") return repos;
    if (["codexpro:projects", "codexpro:api-worker-configs", "codexpro:workers"].includes(channel)) return [];
    if (channel === "codexpro:get-manager-settings") return { autoUpdateWorkers: false };
    return { ok: true, value: {}, entries: [] };
  });
}
const deadline = setTimeout(() => { console.error("Worker Cloud dropdown QA timed out"); app.exit(1); }, 20000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 980, show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, offscreen: true }
  });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === 3) errors.push(event.message);
  });
  try {
    await win.loadFile(path.join(managerRoot, "dist", "index.html"));
    await sleep(1600);
    const shown = await win.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll(".api-worker-card")].find((node) => node.textContent.includes("Worker Cloud"));
      if (!card) return { error: "Worker Cloud card missing", text: document.body.innerText.slice(0, 800) };
      card.querySelector(".profile-chat")?.click();
      return { clicked: true };
    })()`);
    assert.equal(shown.clicked, true, JSON.stringify({ ...shown, errors }));
    await sleep(500);
    let state = await win.webContents.executeJavaScript(`(() => {
      const picker = document.querySelector(".api-job-modal .project-dropdown");
      const trigger = picker?.querySelector(".project-dropdown-trigger");
      return { hasPicker: !!picker, nativeSelect: !!document.querySelector(".api-job-modal select"),
        text: trigger?.innerText || "", disabled: trigger?.disabled,
        modalWidth: document.querySelector(".api-job-modal")?.getBoundingClientRect().width || 0,
        pickerWidth: trigger?.getBoundingClientRect().width || 0,
        errors: document.querySelector(".request-send-error")?.textContent || "" };
    })()`);
    assert.equal(state.hasPicker, true, JSON.stringify(state));
    const backdropCoversSidebar = await win.webContents.executeJavaScript(`(() => {
      const backdrop = document.querySelector(".api-job-modal")?.closest(".modal-backdrop");
      return !!backdrop && document.elementFromPoint(40, 200) === backdrop;
    })()`);
    assert.equal(backdropCoversSidebar, true, "API modal overlay must cover the sidebar, not render below its stacking context");
    assert.equal(state.nativeSelect, false, "Cloud modal must not render native select");
    assert.equal(state.disabled, false, JSON.stringify(state));
    assert.ok(state.pickerWidth >= 400 && state.pickerWidth <= state.modalWidth, JSON.stringify(state));

    await win.webContents.executeJavaScript(`document.querySelector(".api-job-modal .project-dropdown-trigger").click()`);
    await sleep(100);
    state = await win.webContents.executeJavaScript(`(() => {
      const menu = document.querySelector(".api-job-modal .project-dropdown-menu");
      return { hasSearch: !!menu?.querySelector('input[type="search"]'),
        options: [...(menu?.querySelectorAll('[role="option"]') || [])].map((el) => el.innerText),
        scroll: getComputedStyle(menu).overflowY, height: getComputedStyle(menu).maxHeight,
        allAllowed: !![...(menu?.querySelectorAll('[role="option"]') || [])].find((el) => el.innerText.includes("Tất cả vùng được cấp quyền")) };
    })()`);
    assert.equal(state.hasSearch, true);
    assert.equal(state.options.length, 2, JSON.stringify(state));
    assert.equal(state.allAllowed, false);
    assert.equal(state.scroll, "auto");
    assert.equal(state.height, "300px");

    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector(".api-job-modal .project-dropdown-search input");
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setValue.call(input, "stickvideo");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await sleep(120);
    state = await win.webContents.executeJavaScript(`(() => [...document.querySelectorAll(".api-job-modal .project-dropdown-option")].map((el) => el.innerText))()`);
    assert.equal(state.length, 1, JSON.stringify(state));
    assert.match(state[0], /stickvideo-studio/);
    await win.webContents.executeJavaScript(`document.querySelector(".api-job-modal .project-dropdown-option").click()`);
    await sleep(120);
    state = await win.webContents.executeJavaScript(`(() => {
      const picker = document.querySelector(".api-job-modal .project-dropdown");
      return { value: picker.querySelector(".project-dropdown-value").innerText,
        open: !!picker.querySelector(".project-dropdown-menu"), selected: !!document.querySelector(".api-job-modal select") };
    })()`);
    assert.match(state.value, /stickvideo-studio/);
    assert.match(state.value, /main/);
    assert.match(state.value, /songvedem260597\/stickvideo-studio/);
    assert.equal(state.open, false);
    await win.webContents.executeJavaScript(`document.querySelector(".api-job-modal .project-dropdown-trigger").click()`);
    await sleep(120);
    state = await win.webContents.executeJavaScript(`(() => {
      const selected = document.querySelector(".api-job-modal .project-dropdown-option.is-selected");
      return { checked: !!selected?.querySelector(".project-dropdown-check"),
        text: selected?.innerText || "" };
    })()`);
    assert.equal(state.checked, true, JSON.stringify(state));
    assert.deepEqual(errors, [], "Cloud modal must render with no console errors");
    const artifactDir = path.resolve(managerRoot, "..", ".ai-bridge");
    fs.mkdirSync(artifactDir, { recursive: true });
    const screenshot = path.join(artifactDir, "worker-cloud-dropdown-visual.png");
    await sleep(350);
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    console.log("✓ Worker Cloud production dropdown interactions and visual QA PASS");
    console.log("Screenshot:", screenshot);
  } finally {
    clearTimeout(deadline);
    win.destroy();
  }
}).then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });
