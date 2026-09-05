(() => {
  function browserLocatorArgs(args = {}) {
    const selector = String(args.selector || '').trim().slice(0, 2000);
    const ref = String(args.ref || (selector.startsWith('@e') ? selector : '')).trim().slice(0, 80);
    return {
      selector: ref ? '' : selector,
      ref,
      role: String(args.role || '').trim().slice(0, 80),
      name: String(args.name || '').trim().slice(0, 500),
      placeholder: String(args.placeholder || '').trim().slice(0, 500),
      label: String(args.label || '').trim().slice(0, 500),
      test_id: String(args.test_id || '').trim().slice(0, 500),
      nth: Number.isInteger(Number(args.nth)) && Number(args.nth) >= 0 ? Number(args.nth) : 0
    };
  }

  function hasBrowserLocator(args = {}) {
    const locator = browserLocatorArgs(args);
    return Boolean(locator.selector || locator.ref || locator.role || locator.name || locator.placeholder || locator.label || locator.test_id);
  }

  function createBrowserControlExecutor(runtime) {
    const {
      chromeApi,
      promiseWithTimeout,
      snapshotPage,
      browserElementActionPage,
      trustedClickTab,
      withDebuggerTab,
      acquireDebuggerTab,
      releaseDebuggerTab,
      domActionTimeoutMs,
      screenshotTimeoutMs
    } = runtime;

    const executeOnTab = async (tab, action, args = {}) => {
      if (action === 'navigate') {
        const updated = await chromeApi.tabs.update(tab.id, { url: args.url });
        return { action, target_id: tab.id, url: updated.url || args.url, title: updated.title || '' };
      }
      if (action === 'batch') {
        const steps = Array.isArray(args.steps) ? args.steps.slice(0, 50) : [];
        if (!steps.length) throw new Error('batch requires at least one step.');
        const allowed = new Set(['snapshot', 'navigate', 'click', 'trusted_click', 'type', 'press', 'hover', 'scroll', 'wait_for', 'inspect_element', 'evaluate', 'screenshot']);
        const results = [];
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index] && typeof steps[index] === 'object' ? steps[index] : {};
          const stepAction = String(step.action || '');
          if (!allowed.has(stepAction)) throw new Error(`Unsupported batch step at index ${index}: ${stepAction || 'missing'}`);
          results.push(await executeOnTab(tab, stepAction, { ...step, target_id: tab.id, trace: false }));
        }
        return { action, target_id: tab.id, ok: true, step_count: results.length, results };
      }
      if (action === 'snapshot') {
        const [result] = await promiseWithTimeout(
          chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: snapshotPage, args: [Math.max(500, Math.min(50000, args.max_chars || 20000)), Boolean(args.delta)] }),
          domActionTimeoutMs,
          'Chrome renderer không phản hồi khi snapshot.'
        );
        return { action, target_id: tab.id, ...result.result };
      }
      if (action === 'click') {
        const locator = browserLocatorArgs(args);
        const [result] = await promiseWithTimeout(chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: browserElementActionPage, args: ['click', locator, '', 'visible', 10000] }), domActionTimeoutMs, 'Chrome renderer không phản hồi khi click.');
        if (!result.result?.ok) throw new Error(result.result?.error || 'Click failed');
        return { action, target_id: tab.id, selector: args.selector, ref: locator.ref, ...result.result };
      }
      if (action === 'trusted_click') {
        const locator = browserLocatorArgs(args);
        const [located] = await promiseWithTimeout(chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: browserElementActionPage, args: ['locate', locator, '', 'visible', 10000] }), domActionTimeoutMs, 'Chrome renderer không phản hồi khi định vị trusted click.');
        if (!located?.result?.ok) throw new Error(located?.result?.error || 'Trusted click element not found');
        await trustedClickTab(tab.id, Number(located.result.x), Number(located.result.y));
        return { action, target_id: tab.id, selector: args.selector, ok: true, tag: located.result.tag, text: located.result.text };
      }
      if (action === 'type') {
        const locator = browserLocatorArgs(args);
        const [result] = await promiseWithTimeout(chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: browserElementActionPage, args: ['type', locator, String(args.text || ''), 'visible', 10000] }), domActionTimeoutMs, 'Chrome renderer không phản hồi khi nhập text.');
        if (!result.result?.ok) throw new Error(result.result?.error || 'Type failed');
        return { action, target_id: tab.id, selector: args.selector, ref: locator.ref, ...result.result };
      }
      if (action === 'hover') {
        const locator = browserLocatorArgs(args);
        const [located] = await promiseWithTimeout(chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: browserElementActionPage, args: ['locate', locator, '', 'visible', 10000] }), domActionTimeoutMs, 'Chrome renderer không phản hồi khi định vị hover.');
        if (!located?.result?.ok) throw new Error(located?.result?.error || 'Hover element not found');
        await withDebuggerTab(tab.id, target => chromeApi.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: Number(located.result.x), y: Number(located.result.y), button: 'none' }));
        return { action, target_id: tab.id, selector: args.selector, ok: true, tag: located.result.tag };
      }
      if (action === 'scroll') {
        let point = { x: 0, y: 0 };
        if (hasBrowserLocator(args)) {
          const locator = browserLocatorArgs(args);
          const [located] = await promiseWithTimeout(chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: browserElementActionPage, args: ['locate', locator, '', 'visible', 10000] }), domActionTimeoutMs, 'Chrome renderer không phản hồi khi định vị scroll.');
          if (!located?.result?.ok) throw new Error(located?.result?.error || 'Scroll element not found');
          point = { x: Number(located.result.x), y: Number(located.result.y) };
        } else {
          const [viewport] = await chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ x: innerWidth / 2, y: innerHeight / 2 }) });
          point = viewport.result;
        }
        const deltaX = Number.isFinite(Number(args.delta_x)) ? Number(args.delta_x) : 0;
        const deltaY = Number.isFinite(Number(args.delta_y)) ? Number(args.delta_y) : 600;
        await withDebuggerTab(tab.id, target => chromeApi.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY }));
        return { action, target_id: tab.id, selector: args.selector, delta_x: deltaX, delta_y: deltaY, ok: true };
      }
      if (action === 'wait_for') {
        const timeoutMs = Math.max(100, Math.min(60000, Number(args.timeout_ms) || 10000));
        const state = ['attached', 'visible', 'hidden', 'detached'].includes(String(args.state || '')) ? String(args.state) : 'visible';
        const locator = browserLocatorArgs(args);
        const [result] = await promiseWithTimeout(chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: browserElementActionPage, args: ['wait_for', locator, String(args.text || ''), state, timeoutMs] }), timeoutMs + 1500, 'Chrome renderer không phản hồi khi wait_for.');
        if (!result?.result?.ok) throw new Error(result?.result?.error || 'wait_for failed');
        return { action, target_id: tab.id, selector: args.selector, text: args.text, state, timeout_ms: timeoutMs, ...result.result };
      }
      if (action === 'inspect_element') {
        const locator = browserLocatorArgs(args);
        const [result] = await promiseWithTimeout(chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: browserElementActionPage, args: ['inspect', locator, '', 'visible', 10000] }), domActionTimeoutMs, 'Chrome renderer không phản hồi khi inspect element.');
        if (!result?.result?.ok) throw new Error(result?.result?.error || 'inspect_element failed');
        return { action, target_id: tab.id, selector: args.selector, ...result.result };
      }
      if (action === 'evaluate') {
        const expression = String(args.expression || '').trim();
        if (!expression) throw new Error('A JavaScript expression is required.');
        const evaluated = await withDebuggerTab(tab.id, target => chromeApi.debugger.sendCommand(target, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }));
        if (evaluated?.exceptionDetails) throw new Error(String(evaluated.exceptionDetails.text || 'Runtime.evaluate failed'));
        return { action, target_id: tab.id, value: evaluated?.result?.value, persistent_debugger: true };
      }
      if (action === 'screenshot') {
        const capture = await withDebuggerTab(tab.id, async target => {
          await promiseWithTimeout(chromeApi.debugger.sendCommand(target, 'Page.enable', {}), screenshotTimeoutMs, 'Chrome debugger không bật được Page domain để chụp ảnh.');
          await chromeApi.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
          try {
            return await promiseWithTimeout(chromeApi.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: Boolean(args.full_page) }), screenshotTimeoutMs, 'Chrome debugger chụp ảnh quá thời gian cho phép.');
          } finally {
            await chromeApi.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
          }
        });
        return { action, target_id: tab.id, mime_type: 'image/png', image_base64: String(capture?.data || ''), background_capture: true, persistent_debugger: true, focus_emulation: true };
      }
      if (action === 'press') {
        const target = await acquireDebuggerTab(tab.id);
        try {
          const key = String(args.key || '');
          await chromeApi.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key });
          await chromeApi.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key });
        } finally {
          releaseDebuggerTab(tab.id, target);
        }
        return { action, target_id: tab.id, key: args.key, ok: true, persistent_debugger: true };
      }
      throw new Error(`Unsupported action: ${action}`);
    };

    return executeOnTab;
  }

  globalThis.CodexProBrowserControl = Object.freeze({
    browserLocatorArgs,
    hasBrowserLocator,
    createBrowserControlExecutor
  });
})();
