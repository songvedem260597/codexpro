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
  const stored = await chrome.storage.local.get(['profileId','active','connectorInstall']);
  const profileId = stored.profileId || crypto.randomUUID();
  if (!stored.profileId) await chrome.storage.local.set({profileId});
  let email = '';
  try { email = (await chrome.identity.getProfileUserInfo({accountStatus:'ANY'})).email || ''; } catch {}
  return {id:profileId,email,label:email || `Chrome ${profileId.slice(0,8)}`,version:chrome.runtime.getManifest().version,connector_install:stored.connectorInstall||null,active:Boolean(stored.active)};
}

async function main() {
  const profile = await profileInfo();
  document.querySelector('#label').textContent = profile.label;
  document.querySelector('#email').textContent = profile.email || profile.id;
  const button = document.querySelector('#activate');
  const installButton = document.querySelector('#install');
  const installStatus = document.querySelector('#installStatus');
  button.disabled = false;
  installButton.disabled = false;
  if (profile.active) { button.textContent='ACTIVE ✓'; button.classList.add('active'); }
  try {
    const response = await fetch(`${BRIDGE}/register`, {method:'POST',headers:HEADERS,body:JSON.stringify({profile})});
    const state = response.ok ? await response.json() : {};
    const isActive = state.active_profile_id === profile.id;
    if (profile.active !== isActive) await chrome.storage.local.set({active:isActive});
    if (isActive) { button.textContent='ACTIVE ✓'; button.classList.add('active'); }
    else { button.textContent='ACTIVE PROFILE NÀY'; button.classList.remove('active'); }
    document.querySelector('#status').textContent = response.ok ? (isActive ? 'Bridge: online · profile đang ACTIVE' : 'Bridge: online') : `Bridge: HTTP ${response.status}`;
  } catch { document.querySelector('#status').textContent='Bridge: offline'; }

  button.addEventListener('click', async () => {
    button.disabled=true; button.textContent='ĐANG ACTIVE…';
    try {
      const response=await fetch(`${BRIDGE}/activate`,{method:'POST',headers:HEADERS,body:JSON.stringify({profile})});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      await chrome.storage.local.set({active:true});
      button.textContent='ACTIVE ✓';button.classList.add('active');
      document.querySelector('#status').textContent='Bridge: online · profile đang ACTIVE';
    }catch(error){button.textContent='THỬ LẠI';document.querySelector('#status').textContent=`Bridge: ${error.message}`;}
    finally{button.disabled=false;}
  });

  const saved = await chrome.storage.local.get(['connectorInstall']);
  if (saved.connectorInstall?.ok) {
    installButton.textContent = 'CÀI LẠI / KIỂM TRA LẠI';
    installStatus.textContent = saved.connectorInstall.message || 'CodexPro đã được thêm và mở chat kiểm tra.';
    installStatus.dataset.tone = 'ok';
  } else if (saved.connectorInstall?.message) {
    installStatus.textContent = saved.connectorInstall.message;
    installStatus.dataset.tone = 'error';
  }

  installButton.addEventListener('click', async () => {
    installButton.disabled = true;
    installButton.textContent = 'ĐANG TỰ ĐỘNG THÊM…';
    installStatus.textContent = 'Đang mở ChatGPT và cấu hình CodexPro từ A đến Z…';
    installStatus.dataset.tone = 'busy';
    try {
      const result = await chrome.runtime.sendMessage({type:'codexpro-install-connector'});
      if (!result?.ok) throw new Error(result?.error || 'Không thể hoàn tất cài đặt.');
      installButton.textContent = 'CÀI LẠI / KIỂM TRA LẠI';
      installStatus.textContent = result.message || 'Đã thêm CodexPro và mở chat kiểm tra.';
      installStatus.dataset.tone = 'ok';
    } catch (error) {
      installButton.textContent = 'THỬ LẠI';
      installStatus.textContent = error?.message || String(error);
      installStatus.dataset.tone = 'error';
    } finally {
      installButton.disabled = false;
    }
  });
}

if (BOOTSTRAP_RELOAD) void bootstrapReload();
else void main();
