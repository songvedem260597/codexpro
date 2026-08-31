(() => {
  const INSTALLER_REVISION = '2026-08-31-27';
  if (globalThis.__codexProConnectorInstaller === INSTALLER_REVISION) return;
  globalThis.__codexProConnectorInstaller = INSTALLER_REVISION;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const visible = element => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const text = element => normalize(element?.innerText || element?.textContent || element?.getAttribute?.('aria-label') || '');

  async function waitFor(check, timeoutMs = 20000, intervalMs = 250) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await check();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  function status(message, tone = 'busy') {
    let element = document.querySelector('#codexpro-setup-status');
    if (!element) {
      element = document.createElement('div');
      element.id = 'codexpro-setup-status';
      Object.assign(element.style, {
        position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483647',
        maxWidth: '360px', padding: '12px 14px', borderRadius: '12px',
        background: '#17191f', color: '#f7f7f8', border: '1px solid #3b404b',
        boxShadow: '0 14px 40px rgba(0,0,0,.35)', font: '600 13px/1.45 system-ui,sans-serif'
      });
      document.documentElement.appendChild(element);
    }
    element.style.borderColor = tone === 'error' ? '#e5484d' : tone === 'ok' ? '#39d98a' : '#ffb020';
    element.textContent = message;
  }

  function candidates(root = document) {
    return [...root.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],a,label')].filter(visible);
  }

  function findAction(labels, root = document, exact = true) {
    const wanted = labels.map(normalize);
    return candidates(root).find(element => {
      const value = text(element);
      return exact ? wanted.includes(value) : wanted.some(label => value.includes(label));
    });
  }

  function pointerClick(element) {
    if (!(element instanceof Element)) return false;
    element.scrollIntoView({block: 'center', inline: 'center'});
    try { element.focus({preventScroll: true}); } catch { element.focus?.(); }
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + Math.max(1, rect.width / 2);
    const clientY = rect.top + Math.max(1, rect.height / 2);
    const base = {bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX, clientY};
    try { element.dispatchEvent(new PointerEvent('pointerdown', {...base, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true})); } catch {}
    try { element.dispatchEvent(new MouseEvent('mousedown', {...base, buttons: 1})); } catch {}
    try { element.dispatchEvent(new PointerEvent('pointerup', {...base, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true})); } catch {}
    try { element.dispatchEvent(new MouseEvent('mouseup', {...base, buttons: 0})); } catch {}
    try { element.dispatchEvent(new MouseEvent('click', {...base, buttons: 0})); } catch { element.click(); }
    return true;
  }

  async function trustedClick(element) {
    if (!(element instanceof Element)) return false;
    element.scrollIntoView({block: 'center', inline: 'center'});
    try { element.focus({preventScroll: true}); } catch { element.focus?.(); }
    const rect = element.getBoundingClientRect();
    const x = rect.left + Math.max(1, rect.width / 2);
    const y = rect.top + Math.max(1, rect.height / 2);
    try {
      const response = await chrome.runtime.sendMessage({type: 'codexpro-trusted-click', x, y});
      if (response?.ok) return true;
    } catch {}
    return pointerClick(element);
  }

  async function trustedActivate(element) {
    if (!(element instanceof Element)) return false;
    element.scrollIntoView({block: 'center', inline: 'center'});
    const rect = element.getBoundingClientRect();
    const x = rect.left + Math.max(1, rect.width / 2);
    const y = rect.top + Math.max(1, rect.height / 2);
    try {
      const response = await chrome.runtime.sendMessage({type: 'codexpro-trusted-activate', x, y});
      if (response?.ok) return true;
    } catch {}
    return trustedClick(element);
  }

  async function trustedSetText(element, value) {
    if (!(element instanceof Element)) return false;
    element.scrollIntoView({block: 'center', inline: 'center'});
    const rect = element.getBoundingClientRect();
    const x = rect.left + Math.max(1, rect.width / 2);
    const y = rect.top + Math.max(1, rect.height / 2);
    try {
      const response = await chrome.runtime.sendMessage({type: 'codexpro-trusted-set-text', x, y, value: String(value ?? '')});
      if (response?.ok) return true;
    } catch {}
    setNativeValue(element, String(value ?? ''));
    return true;
  }
  function clickAction(labels, root = document, exact = true) {
    const element = findAction(labels, root, exact);
    if (!element) return false;
    pointerClick(element);
    return true;
  }

  function setNativeValue(element, value) {
    element.scrollIntoView({block: 'center', inline: 'center'});
    element.focus();
    if (element.isContentEditable) {
      element.textContent = value;
    } else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
    }
    element.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: value}));
    element.dispatchEvent(new Event('change', {bubbles: true}));
    element.blur();
  }

  function findLabelledControl(root, labels, selector) {
    const wanted = labels.map(normalize);
    const labelNodes = [...root.querySelectorAll('label,span,div,p')]
      .filter(visible)
      .filter(element => wanted.includes(text(element)));
    for (const label of labelNodes) {
      if (label instanceof HTMLLabelElement && label.htmlFor) {
        const linked = document.getElementById(label.htmlFor);
        if (linked?.matches(selector)) return linked;
      }
      let container = label.parentElement;
      for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
        const control = container.querySelector(selector);
        if (control && visible(control)) return control;
      }
    }
    return null;
  }

  function connectorActionLabelMatches(aria, value, interactive) {
    if (aria === 'actions for codexpro' || aria === 'hanh dong cho codexpro') return true;
    if (!interactive) return false;
    return value === 'codexpro' || value.startsWith('codexpro ');
  }

  function installedConnectorAction() {
    return candidates().find(element => connectorActionLabelMatches(
      normalize(element.getAttribute?.('aria-label') || ''),
      text(element),
      element.matches('button,[role="button"],[role="menuitem"],[role="option"]')
    )) || null;
  }

  function connectorAlreadyListed() {
    return Boolean(installedConnectorAction());
  }

  function connectorCheckEvidence(match = installedConnectorAction()) {
    const allCandidates = candidates();
    const codexProCandidates = allCandidates.filter(element => {
      const value = `${text(element)} ${normalize(element.getAttribute?.('aria-label') || '')}`.trim();
      return value === 'codexpro' || value.startsWith('codexpro ') || value.includes(' actions for codexpro') || value.includes(' hanh dong cho codexpro');
    });
    return {
      revision: INSTALLER_REVISION,
      url: location.href,
      hash: location.hash,
      language: String(document.documentElement.lang || ''),
      plugin_search_present: Boolean(document.querySelector('#plugin-search')),
      candidate_count: allCandidates.length,
      codexpro_candidate_count: codexProCandidates.length,
      matched: Boolean(match),
      match_tag: String(match?.tagName || '').toLowerCase(),
      match_role: String(match?.getAttribute?.('role') || ''),
      match_text: text(match).slice(0, 240),
      match_aria: normalize(match?.getAttribute?.('aria-label') || '').slice(0, 240)
    };
  }

  function installedConnectorId() {
    const link = [...document.querySelectorAll('a[href*="/plugins/plugin_"]')]
      .filter(visible)
      .find(element => text(element).includes('codexpro') || normalize(element.getAttribute('aria-label') || '').includes('codexpro'));
    const href = String(link?.getAttribute('href') || '');
    const match = href.match(/\/(plugin_[^/?#]+)/i);
    return match?.[1] || '';
  }

  async function preparePluginSearch() {
    const input = await waitFor(() => {
      const element = document.querySelector('#plugin-search');
      return element && visible(element) ? element : null;
    }, 20000);
    if (!input) throw new Error('ChatGPT chưa tải được trang Plugins.');
    if (normalize(input.value) !== 'codexpro') {
      setNativeValue(input, 'CodexPro');
      await sleep(1200);
    }
    await waitFor(() => connectorAlreadyListed() || document.querySelector('button[aria-label="Create app"]'), 10000);
    return input;
  }

  function creationDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"],dialog')].filter(visible);
    return dialogs.find(dialog => {
      const value = text(dialog);
      return value.includes('new plugin') || value.includes('create app') || value.includes('custom connector') ||
        value.includes('plugin moi') || value.includes('them plugin') || value.includes('tao ung dung') ||
        value.includes('ung dung moi') || value.includes('trinh ket noi tuy chinh');
    }) || null;
  }

  async function enableDeveloperMode() {
    const createLabels = ['Create', 'New plugin', 'Add plugin', 'Create app', 'Add custom connector', 'Tạo', 'Thêm plugin', 'Tạo ứng dụng'];
    if (findAction(createLabels)) return true;

    status('CodexPro: đang bật Developer mode…');
    clickAction(['Advanced settings', 'Advanced Settings', 'Cài đặt nâng cao'], document, false);
    await sleep(800);

    const developerText = [...document.querySelectorAll('div,span,p,label')]
      .filter(visible)
      .find(element => text(element) === 'developer mode' || text(element) === 'che do nha phat trien');
    if (developerText) {
      let row = developerText.parentElement;
      let toggle = null;
      for (let depth = 0; row && depth < 5; depth += 1, row = row.parentElement) {
        toggle = row.querySelector('[role="switch"],input[type="checkbox"]');
        if (toggle && visible(toggle)) break;
      }
      if (toggle) {
        const enabled = toggle.getAttribute('aria-checked') === 'true' || Boolean(toggle.checked);
        if (!enabled) {
          toggle.click();
          await sleep(700);
          clickAction(['Enable', 'Turn on', 'Continue', 'Bật', 'Tiếp tục']);
          await sleep(1000);
        }
      }
    }

    clickAction(['Close', 'Done', 'Đóng', 'Xong']);
    await sleep(500);
    if (!location.hash.toLowerCase().includes('connector')) {
      location.hash = '#settings/Connectors';
      await sleep(1200);
    }
    return Boolean(findAction(createLabels));
  }

  async function openCreationDialog() {
    const existing = creationDialog();
    if (existing) return existing;
    const labels = ['Create', 'New plugin', 'Add plugin', 'Create app', 'Add custom connector', 'Tạo', 'Thêm plugin', 'Tạo ứng dụng'];
    const button = findAction(labels) || findAction(['create', 'new plugin', 'add plugin', 'custom connector', 'thêm plugin'], document, false);
    if (!button) return null;
    button.click();
    return await waitFor(creationDialog, 12000);
  }

  async function chooseNoAuth(dialog) {
    const select = findLabelledControl(dialog, ['Authentication', 'Xác thực'], 'select');
    if (select) {
      const option = [...select.options].find(item => [
        'no auth',
        'none',
        'khong xac thuc',
        'khong co tinh nang xac thuc'
      ].includes(normalize(item.textContent)));
      if (!option) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter) setter.call(select, option.value);
      else select.value = option.value;
      select.dispatchEvent(new Event('input', {bubbles: true}));
      select.dispatchEvent(new Event('change', {bubbles: true}));
      return true;
    }

    const currentNoAuth = findAction(['No Auth', 'None', 'Không xác thực', 'Không có tính năng xác thực'], dialog);
    if (currentNoAuth) return true;
    const combo = findLabelledControl(dialog, ['Authentication', 'Xác thực'], '[role="combobox"],button');
    if (!combo) return false;
    combo.click();
    const option = await waitFor(() => findAction(['No Auth', 'None', 'Không xác thực', 'Không có tính năng xác thực']), 5000);
    if (!option) return false;
    option.click();
    return true;
  }

  function formError(dialog) {
    const messages = [...dialog.querySelectorAll('[role="alert"],.text-red-500,.text-red-600,[data-error]')]
      .filter(visible)
      .map(element => (element.innerText || '').trim())
      .filter(Boolean);
    return messages.join(' · ');
  }

  async function fillAndSubmit(connector, dialog) {
    const serverUrlButton = dialog.querySelector('button[aria-label="Server URL"],button[aria-label="URL máy chủ"]') ||
      findAction(['Server URL', 'URL máy chủ'], dialog);
    if (!serverUrlButton) throw new Error('Không tìm thấy lựa chọn Server URL trong form ChatGPT.');
    const serverUrlSelected = serverUrlButton.getAttribute('data-state') === 'on' || serverUrlButton.getAttribute('aria-pressed') === 'true';
    if (!serverUrlSelected) serverUrlButton.click();
    const selectedUrlInput = await waitFor(() => {
      const current = creationDialog() || dialog;
      const selectedButton = current.querySelector('button[aria-label="Server URL"],button[aria-label="URL máy chủ"]');
      const selected = selectedButton?.getAttribute('data-state') === 'on' || selectedButton?.getAttribute('aria-pressed') === 'true';
      const element = current.querySelector('#custom-connector-url,#custom-connector-server-url,input[type="url"],input[placeholder*="https" i]');
      return selected && element && visible(element) ? element : null;
    }, 5000);
    if (!selectedUrlInput) throw new Error('ChatGPT không chuyển từ Tunnel sang Server URL.');

    const editableSelector = 'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]):not([type="button"]):not([type="submit"]),textarea';
    dialog = creationDialog() || dialog;
    const controls = [...dialog.querySelectorAll(editableSelector)].filter(visible);
    const labelledName = dialog.querySelector('#custom-connector-name') || findLabelledControl(dialog, ['Name', 'Tên'], editableSelector);
    const labelledDescription = dialog.querySelector('#custom-connector-description') || findLabelledControl(dialog, ['Description', 'Mô tả'], editableSelector);
    const nameInput = controls.includes(labelledName) ? labelledName : controls[0];
    const descriptionInput = controls.includes(labelledDescription) ? labelledDescription : null;
    let urlInput = dialog.querySelector('#custom-connector-url,#custom-connector-server-url') || selectedUrlInput || findLabelledControl(dialog, ['Server URL', 'URL'], 'input,textarea') ||
      controls.find(element => element.type === 'url' || /https|url/i.test(element.placeholder || '') || /url/i.test(element.name || ''));
    if (!urlInput) urlInput = controls.find(element => element !== nameInput && element !== descriptionInput) || controls.at(-1);
    if (!nameInput || !urlInput || nameInput === urlInput) throw new Error('Không tìm thấy đủ ô Name và Server URL trong form ChatGPT.');

    await trustedSetText(nameInput, connector.name || 'CodexPro');
    await trustedSetText(urlInput, connector.server_url);
    if (!(await chooseNoAuth(dialog))) throw new Error('Không chọn được No Auth trong form ChatGPT.');

    for (const checkbox of [...dialog.querySelectorAll('input[type="checkbox"]')].filter(visible)) {
      if (!checkbox.checked) checkbox.click();
    }
    for (const checkbox of [...dialog.querySelectorAll('[role="checkbox"]')].filter(visible)) {
      if (checkbox.getAttribute('aria-checked') !== 'true') checkbox.click();
    }

    await sleep(400);
    const submit = await waitFor(() => {
      const current = creationDialog();
      if (!current) return null;
      return [...current.querySelectorAll('button[type="submit"],button,[role="button"]')]
        .filter(visible)
        .filter(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true')
        .reverse()
        .find(button => ['create', 'connect', 'add', 'save', 'tao', 'ket noi', 'them', 'luu'].includes(text(button))) || null;
    }, 6000);
    if (!submit) throw new Error('Nút Create/Connect của ChatGPT chưa sẵn sàng.');
    await trustedClick(submit);

    let followUpClicks = 0;
    let lastFollowUpAt = 0;
    const finished = await waitFor(async () => {
      const current = creationDialog();
      if (!current) return true;
      const error = formError(current);
      if (error) throw new Error(error);
      if (Date.now() - lastFollowUpAt > 1200 && followUpClicks < 3) {
        const followUp = [...current.querySelectorAll('button,[role="button"]')]
          .filter(visible)
          .filter(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true')
          .reverse()
          .find(button => ['connect', 'continue', 'done', 'ket noi', 'tiep tuc', 'xong'].includes(text(button)));
        if (followUp) {
          await trustedActivate(followUp);
          followUpClicks += 1;
          lastFollowUpAt = Date.now();
        }
      }
      return false;
    }, 35000);
    if (!finished) throw new Error(formError(dialog) || 'ChatGPT không xác nhận kết nối MCP trong thời gian chờ.');
  }

  function settingsDialog() {
    return [...document.querySelectorAll('[role="dialog"],dialog')]
      .filter(visible)
      .find(dialog => {
        const value = text(dialog);
        return (value.includes('settings') || value.includes('cai dat')) && (value.includes('plugin') || value.includes('ung dung'));
      }) || null;
  }

  function settingsCodexProButton(root) {
    if (!root) return null;
    return [...root.querySelectorAll('button,a,[role="button"]')]
      .filter(visible)
      .find(button => {
        const value = text(button);
        // ChatGPT appends the current permission summary to the row's
        // accessible text (for example "CodexPro Allow all"). Match the
        // plugin-name prefix while keeping the search scoped to Settings.
        return value === 'codexpro' || value.startsWith('codexpro ');
      }) || null;
  }

  async function deleteConnectorDefinition() {
    await waitFor(() => document.body, 10000);
    const root = await waitFor(settingsDialog, 20000, 150);
    if (!root) throw new Error('ChatGPT chưa mở được Settings > Plugins để cập nhật CodexPro.');

    const pluginButton = settingsCodexProButton(root);
    if (!pluginButton) return {ok: true, deleted: false, absent: true};
    await trustedClick(pluginButton);

    const actionButton = await waitFor(() => {
      const current = settingsDialog();
      if (!current) return null;
      return [...current.querySelectorAll('button')].filter(visible).find(button => {
        const aria = normalize(button.getAttribute('aria-label') || '');
        return aria === 'plugin actions' || aria === 'hanh dong plugin';
      }) || null;
    }, 12000, 120);
    if (!actionButton) throw new Error('Không tìm thấy menu Plugin actions của CodexPro.');
    await trustedClick(actionButton);

    const deleteAction = await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')]
      .filter(visible)
      .find(item => ['delete', 'xoa'].includes(text(item))) || null, 7000, 100);
    if (!deleteAction) throw new Error('Không tìm thấy Delete để xóa definition CodexPro cũ.');
    await trustedClick(deleteAction);

    await sleep(400);
    const confirm = [...document.querySelectorAll('[role="dialog"],dialog')]
      .filter(visible)
      .map(dialog => findAction(['Delete', 'Xóa'], dialog, true))
      .find(Boolean);
    if (confirm) await trustedClick(confirm);

    const deleted = await waitFor(() => {
      const current = settingsDialog();
      if (!current) return false;
      return !settingsCodexProButton(current) && !location.hash.toLowerCase().includes('/plugin_');
    }, 15000, 150);
    if (!deleted) throw new Error('ChatGPT chưa xóa definition CodexPro cũ.');
    return {ok: true, deleted: true};
  }

  async function connectConnectorDefinition() {
    await waitFor(() => document.body, 10000);
    let root = await waitFor(settingsDialog, 20000, 150);
    if (!root) throw new Error('ChatGPT chưa mở được Settings > Plugins để kết nối CodexPro.');

    const initialValue = text(root);
    const hasConnectionMarker = value => value.includes('connection') || value.includes('ket noi');
    const detailAlreadyOpen = location.hash.toLowerCase().includes('/plugin_') || (initialValue.includes('codexpro') && hasConnectionMarker(initialValue));
    const pluginButton = detailAlreadyOpen ? null : settingsCodexProButton(root);
    if (pluginButton) {
      const detailView = () => {
        const current = settingsDialog();
        if (!current) return null;
        const value = text(current);
        return location.hash.toLowerCase().includes('/plugin_') || (value.includes('codexpro') && hasConnectionMarker(value)) ? current : null;
      };
      // This row is an ordinary React navigation control, not a protected
      // submit/consent action. Native click is more reliable than CDP here
      // because CDP hover/pointer events can make the virtualized row rerender.
      pluginButton.click();
      let opened = await waitFor(detailView, 10000, 120);
      if (!opened) {
        const currentButton = settingsCodexProButton(settingsDialog());
        if (currentButton) pointerClick(currentButton);
        opened = await waitFor(detailView, 10000, 120);
      }
      if (!opened) throw new Error('Không mở được trang chi tiết CodexPro trong Settings.');
    }
    root = await waitFor(() => {
      const current = settingsDialog();
      if (!current) return null;
      const value = text(current);
      return value.includes('codexpro') && hasConnectionMarker(value) ? current : null;
    }, 18000, 150);
    if (!root) throw new Error('Không mở được trang chi tiết CodexPro trong Settings.');

    const connection = await waitFor(() => [...root.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .find(button => {
        const value = text(button);
        return hasConnectionMarker(value) && (value.includes('connect') || value.includes('connected') || value.includes('ket noi'));
      }) || null, 5000, 100);
    if (!connection) {
      const pageText = text(root);
      if (hasConnectionMarker(pageText) && pageText.includes('codexpro')) {
        return {ok: true, connected: true, alreadyConnected: true};
      }
      throw new Error('Không tìm thấy mục Connection của CodexPro.');
    }

    const connectionText = text(connection);
    if (connectionText.includes('connected') || connectionText.includes('da ket noi')) {
      return {ok: true, connected: true, alreadyConnected: true};
    }
    await trustedClick(connection);

    const consentMarker = value => value.includes('add codexpro to chatgpt')
      || value.includes('them codexpro vao chatgpt')
      || (value.includes('codexpro') && (value.includes('permissions always respected') || value.includes('cac quyen nay se luon duoc tuan thu')));
    const consent = await waitFor(() => [...document.querySelectorAll('[role="dialog"],dialog')]
      .filter(visible)
      .reverse()
      .find(dialog => {
        const value = text(dialog);
        return consentMarker(value);
      }) || null, 15000, 120);
    if (!consent) {
      const current = settingsDialog();
      const currentConnection = current ? [...current.querySelectorAll('button,[role="button"]')].filter(visible).find(button => hasConnectionMarker(text(button))) : null;
      if (currentConnection && (text(currentConnection).includes('connected') || text(currentConnection).includes('da ket noi'))) {
        return {ok: true, connected: true, alreadyConnected: true};
      }
      const visibleDialogs = [...document.querySelectorAll('[role="dialog"],dialog')].filter(visible);
      const evidence = JSON.stringify({
        code: 'CONNECT_CONSENT_NOT_FOUND',
        url: location.href,
        language: String(document.documentElement.lang || ''),
        visible_dialog_count: visibleDialogs.length,
        dialog_markers: visibleDialogs.slice(-4).map(dialog => {
          const value = text(dialog);
          return {codexpro: value.includes('codexpro'), connection: hasConnectionMarker(value), consent: consentMarker(value), text_prefix: value.slice(0, 240)};
        })
      }).slice(0, 3000);
      throw new Error(`ChatGPT không mở hộp xác nhận Connect cho CodexPro. [CODEXPRO_SETUP_EVIDENCE ${evidence}]`);
    }
    // The consent copy can render one frame before its primary action. Wait
    // for the actual button instead of treating visible dialog text as proof
    // that the action is already mounted.
    const finalConnect = await waitFor(() => [...consent.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .reverse()
      .find(button => ['connect', 'ket noi'].includes(text(button))) || null, 10000, 100);
    if (!finalConnect) throw new Error('Không tìm thấy nút Connect cuối của CodexPro.');
    await trustedClick(finalConnect);

    const closed = await waitFor(() => !document.contains(consent) || !visible(consent), 30000, 200);
    if (!closed) throw new Error('ChatGPT chưa hoàn tất Connect CodexPro.');
    return {ok: true, connected: true, alreadyConnected: false};
  }

  async function install(connector) {
    if (!connector?.server_url) throw new Error('CodexPro bridge không trả về MCP URL.');
    status('CodexPro: đang kiểm tra Developer mode…');
    await waitFor(() => document.body, 10000);
    await sleep(1000);

    if (/auth|login|signup/i.test(location.pathname)) {
      throw new Error('Profile Chrome này chưa đăng nhập ChatGPT.');
    }
    await preparePluginSearch();
    if (connectorAlreadyListed()) {
      return {ok: true, alreadyInstalled: true, migrationRequired: true, connectorId: installedConnectorId()};
    }

    await enableDeveloperMode();
    const dialog = await openCreationDialog();
    if (!dialog) {
      throw new Error('Không mở được form New Plugin. Tài khoản có thể chưa được cấp quyền Developer mode.');
    }
    status('CodexPro: đang nhập MCP URL và chọn No Auth…');
    await fillAndSubmit(connector, dialog);
    status('Đã tạo CodexPro theo profile. Đang hoàn tất Connection…', 'ok');
    await sleep(500);
    return {ok: true, alreadyInstalled: false, connectorId: installedConnectorId()};
  }

  async function checkInstalled() {
    await waitFor(() => document.body, 10000);
    await sleep(1200);
    if (/auth|login|signup/i.test(location.pathname)) {
      throw new Error('Profile Chrome này chưa đăng nhập ChatGPT.');
    }
    await preparePluginSearch();
    const connectorAction = installedConnectorAction();
    if (connectorAction) return {ok: true, installed: true, diagnostic: connectorCheckEvidence(connectorAction)};
    const createLabels = ['Create', 'New plugin', 'Add plugin', 'Create app', 'Add custom connector', 'Tạo', 'Thêm plugin', 'Tạo ứng dụng'];
    const settingsReady = Boolean(document.querySelector('button[aria-label="Create app"]') || findAction(createLabels));
    if (!settingsReady) throw new Error('ChatGPT chưa tải xong danh sách Plugins hoặc profile không có quyền tạo app.');
    return {ok: true, installed: false, diagnostic: connectorCheckEvidence()};
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'codexpro-check-connector') {
      checkInstalled()
        .then(sendResponse)
        .catch(error => sendResponse({ok: false, error: String(error?.message || error)}));
      return true;
    }
    if (message?.type === 'codexpro-run-connector-installer') {
      install(message.connector)
        .then(sendResponse)
        .catch(error => {
          status(`CodexPro: ${String(error?.message || error)}`, 'error');
          sendResponse({ok: false, error: String(error?.message || error)});
        });
      return true;
    }
    if (message?.type === 'codexpro-delete-connector-definition') {
      deleteConnectorDefinition()
        .then(sendResponse)
        .catch(error => sendResponse({ok: false, error: String(error?.message || error)}));
      return true;
    }
    if (message?.type === 'codexpro-connect-connector-definition') {
      connectConnectorDefinition()
        .then(sendResponse)
        .catch(error => sendResponse({ok: false, error: String(error?.message || error)}));
      return true;
    }
    return false;
  });
})();
