function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function clean(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

async function fallbackRendererMetrics(webContents) {
  const value = await webContents.executeJavaScript(`(() => {
    const memory = performance && performance.memory ? performance.memory : {};
    return {
      js_heap_used_bytes: Number(memory.usedJSHeapSize) || 0,
      js_heap_total_bytes: Number(memory.totalJSHeapSize) || 0,
      js_heap_limit_bytes: Number(memory.jsHeapSizeLimit) || 0,
      dom_node_count: document.getElementsByTagName('*').length,
      document_hidden: Boolean(document.hidden),
      visibility_state: String(document.visibilityState || '')
    };
  })()`, true);
  return {
    js_heap_used_bytes: finite(value?.js_heap_used_bytes),
    js_heap_total_bytes: finite(value?.js_heap_total_bytes),
    js_heap_limit_bytes: finite(value?.js_heap_limit_bytes),
    js_heap_embedder_bytes: 0,
    js_heap_backing_storage_bytes: 0,
    dom_node_count: finite(value?.dom_node_count),
    document_hidden: Boolean(value?.document_hidden),
    visibility_state: clean(value?.visibility_state, 40),
    heap_source: 'performance.memory_fallback',
    heap_precise: false
  };
}

export async function collectRendererMemoryMetrics(webContents) {
  const pid = Math.max(0, Number(webContents?.getOSProcessId?.()) || 0) || null;
  let attachedHere = false;
  try {
    const debug = webContents?.debugger;
    if (!debug) throw new Error('webContents.debugger unavailable');
    if (!debug.isAttached()) {
      debug.attach('1.3');
      attachedHere = true;
    }
    const [heap, ui] = await Promise.all([
      debug.sendCommand('Runtime.getHeapUsage'),
      debug.sendCommand('Runtime.evaluate', {
        expression: `(() => ({
          dom_node_count: document.getElementsByTagName('*').length,
          document_hidden: Boolean(document.hidden),
          visibility_state: String(document.visibilityState || ''),
          js_heap_limit_bytes: Number(globalThis.performance?.memory?.jsHeapSizeLimit) || 0
        }))()`,
        returnByValue: true,
        awaitPromise: false
      })
    ]);
    const uiValue = ui?.result?.value && typeof ui.result.value === 'object' ? ui.result.value : {};
    return {
      pid,
      js_heap_used_bytes: finite(heap?.usedSize),
      js_heap_total_bytes: finite(heap?.totalSize),
      js_heap_limit_bytes: finite(uiValue?.js_heap_limit_bytes),
      js_heap_embedder_bytes: finite(heap?.embedderHeapUsedSize),
      js_heap_backing_storage_bytes: finite(heap?.backingStorageSize),
      dom_node_count: finite(uiValue?.dom_node_count),
      document_hidden: Boolean(uiValue?.document_hidden),
      visibility_state: clean(uiValue?.visibility_state, 40),
      heap_source: 'cdp.Runtime.getHeapUsage',
      heap_precise: true,
      heap_error: ''
    };
  } catch (error) {
    try {
      const fallback = await fallbackRendererMetrics(webContents);
      return {
        pid,
        ...fallback,
        heap_error: clean(error?.message || error, 500)
      };
    } catch (fallbackError) {
      return {
        pid,
        js_heap_used_bytes: 0,
        js_heap_total_bytes: 0,
        js_heap_limit_bytes: 0,
        js_heap_embedder_bytes: 0,
        js_heap_backing_storage_bytes: 0,
        dom_node_count: 0,
        document_hidden: false,
        visibility_state: '',
        heap_source: 'unavailable',
        heap_precise: false,
        heap_error: clean(`${error?.message || error}; fallback: ${fallbackError?.message || fallbackError}`, 500)
      };
    }
  } finally {
    if (attachedHere) {
      try {
        if (webContents?.debugger?.isAttached()) webContents.debugger.detach();
      } catch {}
    }
  }
}
