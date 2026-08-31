const BRIDGE = 'http://127.0.0.1:9224';
const BOOTSTRAP_RELOAD = new URLSearchParams(location.search).get('codexpro_reload') === '1';

async function bootstrapReload() {
  history.replaceState({}, '', location.pathname);
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (tab?.id) await chrome.storage.local.set({codexproReloadTabId: tab.id});
  document.body.textContent = 'CodexPro đang reload extension…';
  setTimeout(() => chrome.runtime.reload(), 1400);
}
const HEADERS = {'content-type':'application/json','x-codexpro-extension':'profile-bridge-v1'};

async function profileInfo() {
  const stored = await chrome.storage.local.get(['profileId','active','connectorInstall','workerEnabled','workerEnabledUpdatedAt']);
  const profileId = stored.profileId || crypto.randomUUID();
  if (!stored.profileId) await chrome.storage.local.set({profileId});
  let email = '';
  try { email = (await chrome.identity.getProfileUserInfo({accountStatus:'ANY'})).email || ''; } catch {}
  return {id:profileId,email,label:email || `Chrome ${profileId.slice(0,8)}`,version:chrome.runtime.getManifest().version,connector_install:stored.connectorInstall||null,active:Boolean(stored.active),enabled:stored.workerEnabled!==false,worker_enabled_updated_at:Math.max(0,Number(stored.workerEnabledUpdatedAt)||0)};
}

async function main() {
  const profile = await profileInfo();
  document.querySelector('#label').textContent = profile.label;
  document.querySelector('#email').textContent = profile.email || profile.id;
  document.querySelector('#version').textContent = `v${profile.version}`;
  const button = document.querySelector('#activate');
  const buttonLabel = document.querySelector('#activateLabel');
  const activeState = document.querySelector('#activeState');
  const workerToggle = document.querySelector('#workerToggle');
  const workerDetails = document.querySelector('#workerDetails');
  const disabledState = document.querySelector('#disabledState');
  const installButton = document.querySelector('#install');
  const installLabel = document.querySelector('#installLabel');
  const installStatus = document.querySelector('#installStatus');
  const installTitle = document.querySelector('#installTitle');
  const installStatusText = document.querySelector('#installStatusText');
  const installIcon = document.querySelector('#installIcon');
  const bridgeStatus = document.querySelector('#status');
  const bridgeStatusText = document.querySelector('#statusText');

  const setBridgeStatus = (message, tone = 'neutral') => {
    bridgeStatusText.textContent = message;
    bridgeStatus.dataset.tone = tone;
  };
  const setActiveState = (isActive) => {
    button.hidden=isActive;
    activeState.hidden=!isActive;
    button.disabled = false;
    buttonLabel.textContent = 'Chọn làm profile chính';
  };
  const setInstallState = (message, tone = 'neutral') => {
    const detail = tone === 'ok' && /^codexpro ready$/i.test(String(message || '').trim())
      ? 'MCP và extension đã sẵn sàng.'
      : message;
    installStatusText.textContent = detail;
    installStatus.dataset.tone = tone;
    installTitle.textContent = tone === 'ok' ? 'CodexPro READY' : tone === 'error' ? 'Cần kiểm tra lại' : tone === 'busy' ? 'Đang cấu hình' : 'Kết nối CodexPro';
    installIcon.textContent = tone === 'ok' ? '✓' : tone === 'error' ? '!' : tone === 'busy' ? '…' : 'i';
  };
  const setWorkerState = (enabled) => {
    workerToggle.setAttribute('aria-checked', String(enabled));
    workerDetails.hidden = !enabled;
    disabledState.hidden = enabled;
  };
  const registerProfile = async (enabled) => {
    const registeredProfile = {...profile,enabled,active:enabled ? profile.active : false};
    return await fetch(`${BRIDGE}/register`, {method:'POST',headers:HEADERS,body:JSON.stringify({profile:registeredProfile})});
  };

  setActiveState(profile.active);
  setWorkerState(profile.enabled);
  installButton.disabled = false;
  if (profile.enabled) {
    try {
      const response = await registerProfile(true);
      const state = response.ok ? await response.json() : {};
      const isActive = state.active_profile_id === profile.id;
      if (profile.active !== isActive) await chrome.storage.local.set({active:isActive});
      profile.active = isActive;
      setActiveState(isActive);
      setBridgeStatus(response.ok ? 'Bridge online' : `Bridge HTTP ${response.status}`, response.ok ? 'ok' : 'error');
    } catch {
      setBridgeStatus('Bridge offline', 'error');
    }
  } else {
    void registerProfile(false).catch(() => {});
  }

  workerToggle.addEventListener('click', async () => {
    const workerEnabled = workerToggle.getAttribute('aria-checked') !== 'true';
    workerToggle.disabled = true;
    try {
      const workerEnabledUpdatedAt = Date.now();
      profile.enabled = workerEnabled;
      profile.worker_enabled_updated_at = workerEnabledUpdatedAt;
      if (!workerEnabled) {
        profile.active = false;
        await chrome.storage.local.set({workerEnabled:false,workerEnabledUpdatedAt,active:false});
        setActiveState(false);
        setWorkerState(false);
        const response = await fetch(`${BRIDGE}/register`, {method:'POST',headers:HEADERS,body:JSON.stringify({profile:{...profile,enabled:false,active:false}})});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } else {
        await chrome.storage.local.set({workerEnabled:true,workerEnabledUpdatedAt});
        setWorkerState(true);
        const response = await registerProfile(true);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const state = await response.json();
        const isActive = state.active_profile_id === profile.id;
        profile.active = isActive;
        await chrome.storage.local.set({active:isActive});
        setActiveState(isActive);
        setBridgeStatus('Bridge online', 'ok');
      }
    } catch (error) {
      setBridgeStatus(`Bridge ${error.message}`, 'error');
    } finally {
      workerToggle.disabled = false;
    }
  });

  button.addEventListener('click', async () => {
    button.disabled = true;
    buttonLabel.textContent = 'Đang kích hoạt…';
    try {
      const response = await fetch(`${BRIDGE}/activate`, {method:'POST',headers:HEADERS,body:JSON.stringify({profile})});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await chrome.storage.local.set({active:true});
      setActiveState(true);
      setBridgeStatus('Bridge online', 'ok');
    } catch (error) {
      buttonLabel.textContent = 'Thử lại';
      setBridgeStatus(`Bridge ${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  });

  const saved = await chrome.storage.local.get(['connectorInstall']);
  if (saved.connectorInstall?.ok) {
    installButton.hidden=true;
    setInstallState(saved.connectorInstall.message || 'Đã kết nối và sẵn sàng sử dụng.', 'ok');
  } else if (saved.connectorInstall?.message) {
    installButton.hidden = false;
    installLabel.textContent = 'Thử kết nối lại';
    setInstallState(saved.connectorInstall.message, 'error');
  }

  installButton.addEventListener('click', async () => {
    installButton.hidden = false;
    installButton.disabled = true;
    installLabel.textContent = 'Đang thêm CodexPro…';
    setInstallState('Đang mở ChatGPT và cấu hình CodexPro tự động…', 'busy');
    try {
      const result = await chrome.runtime.sendMessage({type:'codexpro-install-connector'});
      if (!result?.ok) throw new Error(result?.error || 'Không thể hoàn tất cài đặt.');
      installButton.hidden = true;
      setInstallState(result.message || 'Đã kết nối và sẵn sàng sử dụng.', 'ok');
    } catch (error) {
      installLabel.textContent = 'Thử kết nối lại';
      setInstallState(error?.message || String(error), 'error');
    } finally {
      installButton.disabled = false;
    }
  });
}

if (BOOTSTRAP_RELOAD) void bootstrapReload();
else void main();
