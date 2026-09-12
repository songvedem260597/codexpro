const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-renderer-memory-')));

(async () => {
  const { collectRendererMemoryMetrics } = await import('../electron/renderer-memory-metrics.mjs');
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL('data:text/html,<html><body><div id="probe-root"></div></body></html>');
    const legacy = async () => await win.webContents.executeJavaScript(`(() => ({
      used: Number(performance?.memory?.usedJSHeapSize) || 0,
      total: Number(performance?.memory?.totalJSHeapSize) || 0,
      nodes: document.getElementsByTagName('*').length
    }))()`, true);
    const beforeLegacy = await legacy();
    const before = await collectRendererMemoryMetrics(win.webContents);

    await win.webContents.executeJavaScript(`(() => {
      globalThis.__codexproHeapProbe = Array.from({ length: 120000 }, (_, i) => ({
        index: i,
        payload: ('codexpro-memory-probe-' + i + '-').padEnd(320, String(i % 10))
      }));
      const root = document.getElementById('probe-root');
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < 500; i += 1) {
        const node = document.createElement('span');
        node.textContent = 'probe-' + i;
        fragment.appendChild(node);
      }
      root.appendChild(fragment);
      return true;
    })()`, true);
    const duringLegacy = await legacy();
    const during = await collectRendererMemoryMetrics(win.webContents);

    await win.webContents.executeJavaScript(`(() => {
      globalThis.__codexproHeapProbe = null;
      document.getElementById('probe-root').replaceChildren();
      return true;
    })()`, true);
    let attachedHere = false;
    try {
      if (!win.webContents.debugger.isAttached()) {
        win.webContents.debugger.attach('1.3');
        attachedHere = true;
      }
      await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');
    } finally {
      if (attachedHere && win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterLegacy = await legacy();
    const after = await collectRendererMemoryMetrics(win.webContents);

    assert.equal(before.heap_source, 'cdp.Runtime.getHeapUsage');
    assert.equal(before.heap_precise, true);
    assert.ok(during.js_heap_used_bytes - before.js_heap_used_bytes > 8 * 1024 * 1024, `precise heap did not materially increase: ${before.js_heap_used_bytes} -> ${during.js_heap_used_bytes}`);
    assert.ok(during.dom_node_count - before.dom_node_count >= 500, `DOM count did not increase by 500: ${before.dom_node_count} -> ${during.dom_node_count}`);
    assert.ok(after.dom_node_count <= before.dom_node_count + 2, `DOM count did not recover: ${before.dom_node_count} -> ${after.dom_node_count}`);
    assert.ok(after.js_heap_used_bytes < during.js_heap_used_bytes - 8 * 1024 * 1024, `precise heap did not fall after release/GC: ${during.js_heap_used_bytes} -> ${after.js_heap_used_bytes}`);
    assert.equal(win.webContents.debugger.isAttached(), false, 'collector must detach CDP after each low-frequency sample');

    const fallback = await collectRendererMemoryMetrics({
      getOSProcessId: () => 123,
      debugger: {
        isAttached: () => false,
        attach: () => { throw new Error('synthetic attach failure'); }
      },
      executeJavaScript: async () => ({
        js_heap_used_bytes: 10_000_000,
        js_heap_total_bytes: 10_000_000,
        js_heap_limit_bytes: 3_760_000_000,
        dom_node_count: 9,
        document_hidden: false,
        visibility_state: 'visible'
      })
    });
    assert.equal(fallback.heap_precise, false);
    assert.equal(fallback.heap_source, 'performance.memory_fallback');
    assert.match(fallback.heap_error, /synthetic attach failure/);
    assert.equal(fallback.dom_node_count, 9);

    const legacyValues = [beforeLegacy.used, duringLegacy.used, afterLegacy.used];
    const legacyMillionQuantized = legacyValues.every((value) => value % 1_000_000 === 0);
    console.log(JSON.stringify({
      JS_HEAP_PROBE_PRECISE: true,
      legacy_performance_memory: {
        before: beforeLegacy,
        during: duringLegacy,
        after: afterLegacy,
        million_quantized: legacyMillionQuantized
      },
      cdp_runtime_heap_usage: {
        before,
        during,
        after
      }
    }, null, 2));
  } finally {
    if (!win.isDestroyed()) win.destroy();
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
