const BRIDGE = 'http://127.0.0.1:9224';
const HEADERS = {'content-type':'application/json','x-codexpro-extension':'profile-bridge-v1'};

async function profileInfo() {
  const stored = await chrome.storage.local.get(['profileId','active']);
  const profileId = stored.profileId || crypto.randomUUID();
  if (!stored.profileId) await chrome.storage.local.set({profileId});
  let email = '';
  try { email = (await chrome.identity.getProfileUserInfo({accountStatus:'ANY'})).email || ''; } catch {}
  return {id:profileId,email,label:email || `Chrome ${profileId.slice(0,8)}`,active:Boolean(stored.active)};
}

async function main() {
  const profile = await profileInfo();
  document.querySelector('#label').textContent = profile.label;
  document.querySelector('#email').textContent = profile.email || profile.id;
  const button = document.querySelector('#activate');
  button.disabled = false;
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
}

main();
