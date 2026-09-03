const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const managerRoot = path.resolve(__dirname, "..");
const templateRoot = path.join(managerRoot, "electron", "app-plugins", "templates", "gitdiagram");
const fixture = {
  schema_version: 1,
  source: "GitDiagram adapter + CodexGraph",
  title: "System architecture overview",
  nodes: [
    { id: "n1", key: "manager/src", label: "Manager UI", path: "manager/src", layer: 0 },
    { id: "n2", key: "manager/electron", label: "Manager Runtime", path: "manager/electron", layer: 1 },
    { id: "n3", key: "manager/worker-core", label: "Worker Core", path: "manager/electron/worker-core", layer: 2 },
    { id: "n4", key: "chrome-extension", label: "Chrome Extension", path: "chrome-extension", layer: 2 },
    { id: "n5", key: "src/analysis", label: "Analysis Engine", path: "src/analysis", layer: 3 }
  ],
  edges: [
    { from: "n1", to: "n2", label: "IPC", kind: "ipc", weight: 12 },
    { from: "n2", to: "n3", label: "calls", kind: "calls", weight: 8 },
    { from: "n2", to: "n4", label: "IPC", kind: "ipc", weight: 5 },
    { from: "n3", to: "n5", label: "uses", kind: "references", weight: 3 }
  ],
  details: {
    "manager/electron": {
      component_key: "manager/electron",
      component_label: "Manager Runtime",
      nodes: [
        { id: "n2m1", key: "manager/electron/main.mjs", label: "Main", path: "manager/electron/main.mjs", layer: 0 },
        { id: "n2m2", key: "manager/electron/worker-core", label: "Worker Core", path: "manager/electron/worker-core/runtime.mjs", layer: 1 }
      ],
      edges: [{ from: "n2m1", to: "n2m2", label: "calls", kind: "calls", weight: 8 }],
      mermaid: "flowchart TD\n  n2m1[\"Main\"]\n  n2m2[\"Worker Core\"]\n  n2m1 -->|calls| n2m2",
      stats: { modules: 2, connections: 1, source_symbols: 1800 }
    }
  },
  mermaid: "flowchart TD\n  n1[\"Manager UI\"]\n  n2[\"Manager Runtime\"]\n  n1 -->|IPC| n2",
  stats: { components: 5, detail_modules: 2, connections: 4, source_symbols: 16850, source_relationships: 38474 },
  warnings: []
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    backgroundColor: "#0b1017",
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true }
  });

  try {
    await win.loadFile(path.join(templateRoot, "index.html"));
    await win.webContents.executeJavaScript(`(() => {
      window.__gitDiagramAnalyzeRequestId = "";
      window.addEventListener("message", (event) => {
        if (event.data?.type === "codexpro:gitdiagram-analyze") window.__gitDiagramAnalyzeRequestId = String(event.data.request_id || "");
      });
      window.postMessage({
        type: "codexpro:plugin-context",
        projects: [{ root: "C:\\\\repo", name: "CodexPro", repoFullName: "rebel0789/codexpro", branch: "main", isGit: true }]
      }, "*");
    })()`);
    await wait(120);

    const initial = await win.webContents.executeJavaScript(`(() => ({
      options: document.querySelectorAll("#project option").length,
      analyzeDisabled: document.querySelector("#analyze")?.disabled,
      status: document.querySelector("#status")?.textContent?.trim() || ""
    }))()`);
    if (initial.options !== 1 || initial.analyzeDisabled) throw new Error(`Plugin context did not initialize: ${JSON.stringify(initial)}`);

    await win.webContents.executeJavaScript(`document.querySelector("#analyze").click()`);
    let requestId = "";
    for (let index = 0; index < 20 && !requestId; index += 1) {
      await wait(40);
      requestId = await win.webContents.executeJavaScript(`window.__gitDiagramAnalyzeRequestId || ""`);
    }
    if (!/^[a-f0-9]{16}$/i.test(requestId)) throw new Error(`Analyze bridge did not emit a valid request id: ${requestId}`);

    await win.webContents.executeJavaScript(`window.postMessage(${JSON.stringify({ type: "codexpro:gitdiagram-result", request_id: "__REQUEST_ID__", result: fixture }).replace("__REQUEST_ID__", requestId)}, "*")`);
    await wait(180);

    const rendered = await win.webContents.executeJavaScript(`(() => {
      const wrap = document.querySelector(".diagram-wrap");
      const diagram = document.querySelector("#diagram");
      const firstNode = document.querySelector(".flow-node");
      const lastNode = [...document.querySelectorAll(".flow-node")].at(-1);
      const firstRect = firstNode?.getBoundingClientRect();
      const lastRect = lastNode?.getBoundingClientRect();
      return {
        status: document.querySelector("#status")?.textContent?.trim() || "",
        summaryHidden: document.querySelector("#summary")?.hidden,
        components: document.querySelector("#components")?.textContent?.trim() || "",
        modules: document.querySelector("#modules")?.textContent?.trim() || "",
        connections: document.querySelector("#connections")?.textContent?.trim() || "",
        copyDisabled: document.querySelector("#copy")?.disabled,
        nodeCount: document.querySelectorAll(".flow-node").length,
        edgeCount: document.querySelectorAll("#diagram svg path[marker-end]").length,
        labelCount: document.querySelectorAll(".edge-label").length,
        width: diagram?.scrollWidth || 0,
        height: diagram?.scrollHeight || 0,
        viewport: wrap?.clientWidth || 0,
        firstNode: firstRect ? { left: firstRect.left, top: firstRect.top, width: firstRect.width, height: firstRect.height } : null,
        lastNode: lastRect ? { left: lastRect.left, top: lastRect.top, width: lastRect.width, height: lastRect.height } : null
      };
    })()`);

    if (rendered.summaryHidden || rendered.components !== "5" || rendered.modules !== "2" || rendered.connections !== "4") throw new Error(`Summary did not render: ${JSON.stringify(rendered)}`);
    if (rendered.copyDisabled) throw new Error("Copy Mermaid must be enabled after a successful analysis.");
    if (rendered.nodeCount !== fixture.nodes.length || rendered.edgeCount !== fixture.edges.length || rendered.labelCount !== fixture.edges.length) {
      throw new Error(`Diagram geometry is incomplete: ${JSON.stringify(rendered)}`);
    }
    if (rendered.width < 760 || rendered.height < 560 || !rendered.firstNode || !rendered.lastNode || rendered.lastNode.top <= rendered.firstNode.top) {
      throw new Error(`Architecture flow layout is invalid: ${JSON.stringify(rendered)}`);
    }

    await win.webContents.executeJavaScript(`[...document.querySelectorAll(".flow-node")].find((node) => node.textContent.includes("Manager Runtime"))?.click()`);
    await wait(120);
    const detail = await win.webContents.executeJavaScript(`(() => ({
      title: document.querySelector("#view-title")?.textContent?.trim() || "",
      hint: document.querySelector("#view-hint")?.textContent?.trim() || "",
      backHidden: document.querySelector("#back")?.hidden,
      nodeCount: document.querySelectorAll(".flow-node").length,
      edgeCount: document.querySelectorAll("#diagram svg path[marker-end]").length,
      labels: [...document.querySelectorAll(".flow-node strong")].map((node) => node.textContent.trim())
    }))()`);
    if (detail.title !== "Manager Runtime" || detail.backHidden || detail.nodeCount !== 2 || detail.edgeCount !== 1) throw new Error(`Detail drill-down did not render: ${JSON.stringify(detail)}`);
    if (!detail.labels.includes("Main") || !detail.labels.includes("Worker Core")) throw new Error(`Detail module labels are incomplete: ${JSON.stringify(detail)}`);

    const screenshotPath = path.join(os.tmpdir(), "codexpro-gitdiagram-visual-smoke.png");
    const image = await win.webContents.capturePage();
    fs.writeFileSync(screenshotPath, image.toPNG());
    const imageSize = fs.statSync(screenshotPath).size;
    if (imageSize < 20_000) throw new Error(`Visual screenshot is unexpectedly small: ${imageSize}`);

    await win.webContents.executeJavaScript(`document.querySelector("#back")?.click()`);
    await wait(80);
    const restoredNodeCount = await win.webContents.executeJavaScript(`document.querySelectorAll(".flow-node").length`);
    if (restoredNodeCount !== fixture.nodes.length) throw new Error(`Back navigation did not restore overview: ${restoredNodeCount}`);

    console.log("gitdiagram-visual-smoke: ok");
    console.log(JSON.stringify({ ...rendered, detail, screenshotPath, screenshotBytes: imageSize }, null, 2));
  } finally {
    win.destroy();
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
