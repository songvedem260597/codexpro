(() => {
  if (globalThis.__codexProConnectorInstaller) return;
  globalThis.__codexProConnectorInstaller = true;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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

  function clickAction(labels, root = document, exact = true) {
    const element = findAction(labels, root, exact);
    if (!element) return false;
    element.scrollIntoView({block: 'center', inline: 'center'});
    element.click();
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

  function connectorAlreadyListed() {
    return Boolean(document.querySelector('a[aria-label="Open CodexPro"]'));
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
        value.includes('them plugin') || value.includes('tao ung dung') || value.includes('trinh ket noi tuy chinh');
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
      const option = [...select.options].find(item => ['no auth', 'none', 'khong xac thuc'].includes(normalize(item.textContent)));
      if (!option) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter) setter.call(select, option.value);
      else select.value = option.value;
      select.dispatchEvent(new Event('input', {bubbles: true}));
      select.dispatchEvent(new Event('change', {bubbles: true}));
      return true;
    }

    const currentNoAuth = findAction(['No Auth', 'None', 'Không xác thực'], dialog);
    if (currentNoAuth) return true;
    const combo = findLabelledControl(dialog, ['Authentication', 'Xác thực'], '[role="combobox"],button');
    if (!combo) return false;
    combo.click();
    const option = await waitFor(() => findAction(['No Auth', 'None', 'Không xác thực']), 5000);
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
    const serverUrlButton = dialog.querySelector('button[aria-label="Server URL"]') || findAction(['Server URL'], dialog);
    if (!serverUrlButton) throw new Error('Không tìm thấy lựa chọn Server URL trong form ChatGPT.');
    const serverUrlSelected = serverUrlButton.getAttribute('data-state') === 'on' || serverUrlButton.getAttribute('aria-pressed') === 'true';
    if (!serverUrlSelected) serverUrlButton.click();
    const selectedUrlInput = await waitFor(() => {
      const current = creationDialog() || dialog;
      const selected = current.querySelector('button[aria-label="Server URL"]')?.getAttribute('data-state') === 'on';
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

    setNativeValue(nameInput, connector.name || 'CodexPro');
    setNativeValue(urlInput, connector.server_url);
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
    submit.click();

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
          followUp.click();
          followUpClicks += 1;
          lastFollowUpAt = Date.now();
        }
      }
      return false;
    }, 35000);
    if (!finished) throw new Error(formError(dialog) || 'ChatGPT không xác nhận kết nối MCP trong thời gian chờ.');
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
      status('CodexPro đã có trong profile này. Đang mở chat kiểm tra…', 'ok');
      return {ok: true, alreadyInstalled: true};
    }

    await enableDeveloperMode();
    const dialog = await openCreationDialog();
    if (!dialog) {
      throw new Error('Không mở được form New Plugin. Tài khoản có thể chưa được cấp quyền Developer mode.');
    }
    status('CodexPro: đang nhập MCP URL và chọn No Auth…');
    await fillAndSubmit(connector, dialog);
    status('Đã thêm CodexPro. Đang mở chat mới để kiểm tra…', 'ok');
    return {ok: true, alreadyInstalled: false};
  }

  async function checkInstalled() {
    await waitFor(() => document.body, 10000);
    await sleep(1200);
    if (/auth|login|signup/i.test(location.pathname)) {
      throw new Error('Profile Chrome này chưa đăng nhập ChatGPT.');
    }
    await preparePluginSearch();
    if (connectorAlreadyListed()) return {ok: true, installed: true};
    const createLabels = ['Create', 'New plugin', 'Add plugin', 'Create app', 'Add custom connector', 'Tạo', 'Thêm plugin', 'Tạo ứng dụng'];
    const settingsReady = Boolean(document.querySelector('button[aria-label="Create app"]') || findAction(createLabels));
    if (!settingsReady) throw new Error('ChatGPT chưa tải xong danh sách Plugins hoặc profile không có quyền tạo app.');
    return {ok: true, installed: false};
  }

  function composer() {
    return document.querySelector('#prompt-textarea,textarea[data-id="root"],textarea[placeholder],[contenteditable="true"][data-lexical-editor="true"],[contenteditable="true"]');
  }

  async function ensureChatMode() {
    const chatButton = await waitFor(() => candidates().find(element => text(element) === 'chat'), 20000);
    const workButton = candidates().find(element => text(element) === 'work');
    if (!chatButton) {
      if (workButton?.getAttribute('data-state') === 'on') throw new Error('Không tìm thấy nút Chat để thoát chế độ Work.');
      return;
    }
    if (chatButton.getAttribute('data-state') !== 'on') {
      chatButton.click();
      const chatReady = await waitFor(() => candidates().find(element => text(element) === 'chat' && element.getAttribute('data-state') === 'on'), 15000);
      if (!chatReady) throw new Error('Không chuyển được từ Work sang Chat.');
    }
    const activeWork = candidates().find(element => text(element) === 'work' && element.getAttribute('data-state') === 'on');
    if (activeWork) throw new Error('ChatGPT vẫn đang ở Work; đã hủy test để không dùng Work.');
  }

  async function connectionTest() {
    status('CodexPro: đang tạo chat kiểm tra…');
    await ensureChatMode();
    const input = await waitFor(() => {
      const element = composer();
      return element || null;
    }, 45000);
    if (!input) throw new Error('Không tìm thấy ô nhập chat mới.');

    if (input.isContentEditable) {
      input.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, '@CodexPro');
      input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: '@CodexPro'}));
    } else {
      setNativeValue(input, '@CodexPro');
    }
    const mention = await waitFor(() => {
      const pluginItems = [...document.querySelectorAll('[data-composer-plugin-impression-id] [tabindex="0"]')].filter(visible);
      const pluginItem = pluginItems.find(element => text(element).includes('codexpro'));
      if (pluginItem) return pluginItem;
      const options = [...document.querySelectorAll('[role="option"],[role="menuitem"],button')].filter(visible);
      return options.find(option => text(option) === 'codexpro' || text(option).startsWith('codexpro '));
    }, 30000);
    if (!mention) throw new Error('CodexPro chưa xuất hiện trong menu @ của ChatGPT thường.');
    mention.click();
    await sleep(350);

    const prompt = 'Hãy gọi server_config và trả lời “CodexPro READY” nếu kết nối thành công.';
    if (input.isContentEditable) {
      input.focus();
      document.execCommand('insertText', false, ` ${prompt}`);
      input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: ` ${prompt}`}));
    } else {
      const current = input.value || '';
      setNativeValue(input, `${current}${current ? ' ' : ''}${prompt}`);
    }
    const promptInserted = await waitFor(() => normalize(input.innerText || input.value || '').includes('hay goi server_config'), 3000);
    if (!promptInserted) throw new Error('ChatGPT không nhận nội dung test vào composer.');

    const send = await waitFor(() => {
      const selectors = ['button[data-testid="send-button"]', 'button[aria-label*="Send"]', 'button[aria-label*="Gửi"]'];
      return selectors.map(selector => document.querySelector(selector)).find(element => element && !element.disabled);
    }, 8000);
    if (!send) throw new Error('Đã thêm CodexPro nhưng không tìm thấy nút gửi để chạy chat kiểm tra.');
    send.click();
    const consent = await waitFor(() => findAction(['Connect', 'Kết nối']), 15000);
    if (consent) {
      consent.click();
      status('CodexPro: đang cấp quyền kết nối lần đầu…');
      const permissionPage = await waitFor(() => location.hash.includes('add-connector-link') || normalize(document.body?.innerText).includes('add codexpro to chatgpt'), 30000);
      if (permissionPage) {
        const finalConsent = await waitFor(() => {
          const buttons = candidates().filter(element => ['connect', 'ket noi'].includes(text(element)));
          return buttons.at(-1) || null;
        }, 30000);
        if (!finalConsent) throw new Error('Không tìm thấy nút Connect cuối để cấp quyền CodexPro.');
        finalConsent.click();
        await waitFor(() => !location.hash.includes('add-connector-link'), 30000);
      }
      status('CodexPro: đã xác nhận Connect, đang chờ phản hồi READY…');
    }
    status('CodexPro: đã gửi test, đang chờ phản hồi READY…');
    const ready = await waitFor(() => {
      const replies = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      const reply = normalize(replies.at(-1)?.innerText || '');
      const page = normalize(document.body?.innerText || '');
      const connected = page.includes('codexpro da ket noi') || page.includes('codexpro connected');
      return reply.includes('codexpro ready') || (page.includes('called tool') && connected) || (reply.includes('server_config') && reply.includes('codexpro'));
    }, 70000, 500);
    if (!ready) throw new Error('Đã gửi test nhưng chưa nhận được phản hồi CodexPro READY trong 70 giây.');
    status('CodexPro READY · cài đặt và kiểm tra hoàn tất.', 'ok');
    return {ok: true, message: 'CodexPro READY · đã tự thêm và kiểm tra kết nối thành công.'};
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
    if (message?.type === 'codexpro-run-connection-test') {
      connectionTest()
        .then(sendResponse)
        .catch(error => {
          status(`CodexPro: ${String(error?.message || error)}`, 'error');
          sendResponse({ok: false, error: String(error?.message || error)});
        });
      return true;
    }
    return false;
  });
})();
