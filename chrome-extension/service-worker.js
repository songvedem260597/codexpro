const BRIDGE = 'http://127.0.0.1:9224';
const HEADERS = {'content-type':'application/json','x-codexpro-extension':'profile-bridge-v1'};
const CHAT_REQUEST_STALE_MS = 30 * 60 * 1000;
const CHAT_NETWORK_STATE_KEY = 'codexproChatNetworkStateV1';
const DOM_READ_TIMEOUT_MS = 2500;
const DOM_ACTION_TIMEOUT_MS = 5000;
const DOM_SEND_TIMEOUT_MS = 35000;
const NETWORK_START_TIMEOUT_MS = 10000;
const CONVERSATION_LIMIT_PROBE_TIMEOUT_MS = 1500;
const PENDING_CONVERSATION_TTL_MS = 60 * 1000;
let polling = false;
let installing = false;
const chatNetworkStateByTab = new Map();
const pendingConversationByTab = new Map();
let chatNetworkStateLoaded = false;
let chatNetworkStateLoadPromise = null;
let recentConversationCache = {at:0,items:[]};
const TITLE_OVERRIDE_TTL_MS = 10 * 60 * 1000;
let conversationTitleOverrides = null;

function conversationIdFromUrl(value) {
  try{return new URL(String(value||'')).pathname.match(/^\/c\/([A-Za-z0-9-]{8,160})/)?.[1]||'';}catch{return '';}
}

function isChatGenerationRequest(details) {
  if(details.tabId < 0 || details.method !== 'POST')return false;
  try{
    const url=new URL(details.url);
    const path=url.pathname.replace(/\/+$/,'');
    if(url.hostname!=='chatgpt.com')return false;
    return /\/(?:backend-api|backend-anon)\/(?:f\/)?conversation$/.test(path)
      || /\/backend-api\/(?:codex\/)?responses$/.test(path);
  }catch{return false;}
}

async function ensureChatNetworkStateLoaded() {
  if(chatNetworkStateLoaded)return;
  if(chatNetworkStateLoadPromise)return await chatNetworkStateLoadPromise;
  chatNetworkStateLoadPromise=(async()=>{
    try{
      const stored=await chrome.storage.local.get(CHAT_NETWORK_STATE_KEY);
      const raw=stored[CHAT_NETWORK_STATE_KEY]&&typeof stored[CHAT_NETWORK_STATE_KEY]==='object'?stored[CHAT_NETWORK_STATE_KEY]:{};
      const now=Date.now();
      for(const [tabId,value] of Object.entries(raw)){
        if(!value||typeof value!=='object')continue;
        const at=Number(value.completed_at_ms||value.started_at_ms||0);
        if(!at||now-at>CHAT_REQUEST_STALE_MS)continue;
        chatNetworkStateByTab.set(Number(tabId),value);
      }
    }catch{}
    chatNetworkStateLoaded=true;
    chatNetworkStateLoadPromise=null;
  })();
  await chatNetworkStateLoadPromise;
}

async function persistChatNetworkState() {
  try{
    const now=Date.now();
    const entries=[...chatNetworkStateByTab.entries()]
      .filter(([,value])=>now-Number(value?.completed_at_ms||value?.started_at_ms||0)<=CHAT_REQUEST_STALE_MS)
      .slice(-50);
    await chrome.storage.local.set({[CHAT_NETWORK_STATE_KEY]:Object.fromEntries(entries.map(([tabId,value])=>[String(tabId),value]))});
  }catch{}
}

function generationContextFor(details) {
  const pending=pendingConversationByTab.get(details.tabId);
  if(pending&&Date.now()-Number(pending.at||0)<PENDING_CONVERSATION_TTL_MS){
    pendingConversationByTab.delete(details.tabId);
    return {conversation_id:String(pending.conversation_id||''),source:String(pending.source||'codexpro')};
  }
  return {conversation_id:conversationIdFromUrl(details.documentUrl),source:'page'};
}

function beginChatRequest(details) {
  if(!isChatGenerationRequest(details))return;
  void (async()=>{
    await ensureChatNetworkStateLoaded();
    const context=generationContextFor(details);
    const now=Date.now();
    chatNetworkStateByTab.set(details.tabId,{
      state:'generating',
      request_id:String(details.requestId||''),
      started_at_ms:now,
      completed_at_ms:0,
      conversation_id:context.conversation_id,
      source:context.source,
      status_code:0,
      error:''
    });
    await persistChatNetworkState();
    scheduleRealtimeProfilePush();
  })();
}

function finishChatRequest(details,state) {
  if(!isChatGenerationRequest(details))return;
  void (async()=>{
    await ensureChatNetworkStateLoaded();
    const current=chatNetworkStateByTab.get(details.tabId);
    if(current?.request_id&&String(current.request_id)!==String(details.requestId||''))return;
    const now=Date.now();
    const startedAt=Number(current?.started_at_ms||now);
    const statusCode=Number(details.statusCode)||0;
    const failed=state==='failed'||statusCode>=400;
    chatNetworkStateByTab.set(details.tabId,{
      ...(current||{}),
      state:failed?'failed':'completed',
      request_id:String(details.requestId||current?.request_id||''),
      started_at_ms:startedAt,
      completed_at_ms:now,
      conversation_id:String(current?.conversation_id||conversationIdFromUrl(details.documentUrl)||''),
      source:String(current?.source||'page'),
      status_code:statusCode,
      error:failed?String(details.error||`HTTP ${statusCode||'error'}`).slice(0,300):''
    });
    await persistChatNetworkState();
    scheduleRealtimeProfilePush();
  })();
}

async function bindConversationToTab(tabId,conversationId) {
  if(!conversationId)return;
  await ensureChatNetworkStateLoaded();
  const current=chatNetworkStateByTab.get(tabId);
  if(current){chatNetworkStateByTab.set(tabId,{...current,conversation_id:conversationId});await persistChatNetworkState();}
}

async function chatRequestState(tabId,conversationId='') {
  await ensureChatNetworkStateLoaded();
  const now=Date.now();
  const current=chatNetworkStateByTab.get(tabId);
  if(!current)return {busy:false,busy_request_count:0,busy_since:'',network_state:'idle',network_source:'',network_last_started_at:'',network_last_completed_at:'',network_status_code:0,network_error:'',network_duration_ms:0};
  const at=Number(current.completed_at_ms||current.started_at_ms||0);
  if(!at||now-at>CHAT_REQUEST_STALE_MS){chatNetworkStateByTab.delete(tabId);void persistChatNetworkState();return {busy:false,busy_request_count:0,busy_since:'',network_state:'idle',network_source:'',network_last_started_at:'',network_last_completed_at:'',network_status_code:0,network_error:'',network_duration_ms:0};}
  if(conversationId&&current.conversation_id&&current.conversation_id!==conversationId)return {busy:false,busy_request_count:0,busy_since:'',network_state:'idle',network_source:'',network_last_started_at:'',network_last_completed_at:'',network_status_code:0,network_error:'',network_duration_ms:0};
  const busy=current.state==='generating';
  return {
    busy,
    busy_request_count:busy?1:0,
    busy_since:busy&&current.started_at_ms?new Date(current.started_at_ms).toISOString():'',
    network_state:String(current.state||'idle'),
    network_source:String(current.source||''),
    network_last_started_at:current.started_at_ms?new Date(current.started_at_ms).toISOString():'',
    network_last_completed_at:current.completed_at_ms?new Date(current.completed_at_ms).toISOString():'',
    network_status_code:Number(current.status_code)||0,
    network_error:String(current.error||''),
    network_duration_ms:current.completed_at_ms&&current.started_at_ms?Math.max(0,Number(current.completed_at_ms)-Number(current.started_at_ms)):0
  };
}

async function waitForNetworkGeneration(tabId,startedAfterMs,timeoutMs=NETWORK_START_TIMEOUT_MS) {
  await ensureChatNetworkStateLoaded();
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const current=chatNetworkStateByTab.get(tabId);
    if(current&&Number(current.started_at_ms||0)>=startedAfterMs&&['generating','completed','failed'].includes(String(current.state||''))){
      return await chatRequestState(tabId,String(current.conversation_id||''));
    }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('Không thấy request generation của ChatGPT sau khi bấm gửi.');
}

let realtimeProfilePushTimer=null;
function scheduleRealtimeProfilePush(delayMs=40) {
  if(realtimeProfilePushTimer)clearTimeout(realtimeProfilePushTimer);
  realtimeProfilePushTimer=setTimeout(()=>{
    realtimeProfilePushTimer=null;
    void (async()=>{
      try{
        const [profile,tabs]=await Promise.all([profileInfo(),tabList()]);
        await fetch(`${BRIDGE}/register`,{method:'POST',headers:HEADERS,body:JSON.stringify({profile,tabs})});
      }catch{}
    })();
  },delayMs);
}

chrome.webRequest.onBeforeRequest.addListener(beginChatRequest,{urls:['https://chatgpt.com/*'],types:['xmlhttprequest','other']});
chrome.webRequest.onCompleted.addListener(details=>finishChatRequest(details,'completed'),{urls:['https://chatgpt.com/*'],types:['xmlhttprequest','other']});
chrome.webRequest.onErrorOccurred.addListener(details=>finishChatRequest(details,'failed'),{urls:['https://chatgpt.com/*'],types:['xmlhttprequest','other']});
chrome.webRequest.onBeforeRedirect.addListener(details=>finishChatRequest(details,'completed'),{urls:['https://chatgpt.com/*'],types:['xmlhttprequest','other']});
chrome.tabs.onRemoved.addListener(tabId=>{pendingConversationByTab.delete(tabId);void (async()=>{await ensureChatNetworkStateLoaded();chatNetworkStateByTab.delete(tabId);await persistChatNetworkState();})();});

async function profileInfo() {
  const stored = await chrome.storage.local.get(['profileId','active','connectorInstall']);
  const profileId = stored.profileId || crypto.randomUUID();
  if (!stored.profileId) await chrome.storage.local.set({profileId});
  let email = '';
  try { email = (await chrome.identity.getProfileUserInfo({accountStatus:'ANY'})).email || ''; } catch {}
  return {id:profileId,email,label:email || `Chrome ${profileId.slice(0,8)}`,version:chrome.runtime.getManifest().version,connector_install:stored.connectorInstall||null,active:Boolean(stored.active)};
}

async function getConversationTitleOverrides() {
  if(conversationTitleOverrides===null){
    const stored=await chrome.storage.local.get('codexproConversationTitleOverrides');
    const raw=stored.codexproConversationTitleOverrides&&typeof stored.codexproConversationTitleOverrides==='object'?stored.codexproConversationTitleOverrides:{};
    const now=Date.now();
    conversationTitleOverrides=Object.fromEntries(Object.entries(raw).filter(([,value])=>value&&typeof value==='object'&&String(value.title||'').trim()&&now-Number(value.at||0)<TITLE_OVERRIDE_TTL_MS));
    if(Object.keys(conversationTitleOverrides).length!==Object.keys(raw).length)await chrome.storage.local.set({codexproConversationTitleOverrides:conversationTitleOverrides});
  }
  return conversationTitleOverrides;
}

async function saveConversationTitleOverride(conversationId,title) {
  const overrides=await getConversationTitleOverrides();
  overrides[conversationId]={title:String(title||'').trim().slice(0,120),at:Date.now()};
  await chrome.storage.local.set({codexproConversationTitleOverrides:overrides});
}

async function tabList() {
  const tabs = await chrome.tabs.query({});
  const titleOverrides=await getConversationTitleOverrides();
  return await Promise.all(tabs.map(async tab => {
    const conversationId=conversationIdFromUrl(tab.url);
    const networkState=await chatRequestState(tab.id,conversationId);
    const titleOverride=conversationId?titleOverrides[conversationId]:null;
    return {
      id:tab.id,
      window_id:tab.windowId,
      active:Boolean(tab.active),
      title:String(titleOverride?.title||tab.title||''),
      url:tab.url || '',
      busy:networkState.busy,
      settling:false,
      busy_request_count:networkState.busy_request_count,
      busy_since:networkState.busy_since,
      busy_source:networkState.busy?'network':'',
      network_state:networkState.network_state,
      network_source:networkState.network_source,
      network_last_started_at:networkState.network_last_started_at,
      network_last_completed_at:networkState.network_last_completed_at,
      network_status_code:networkState.network_status_code,
      network_error:networkState.network_error,
      network_duration_ms:networkState.network_duration_ms,
      conversation_limit_reached:false,
      conversation_limit_message:''
    };
  }));
}

async function fetchRecentConversationsPage(limit) {
  let apiError='';
  try{
    const candidateLimit=Math.max(limit,Math.min(20,limit*3));
    const response=await fetch(`/backend-api/conversations?offset=0&limit=${candidateLimit}&order=updated`,{credentials:'include',cache:'no-store'});
    if(response.ok){
      const payload=await response.json();
      const items=Array.isArray(payload?.items)?payload.items.filter(item=>item?.is_visible!==false&&item?.is_archived!==true):[];
      if(items.length)return {ok:true,source:'api',items:items.slice(0,candidateLimit).map(item=>({id:String(item.id||''),title:String(item.title||'Đoạn chat chưa có tiêu đề'),updated_at:Number(item.update_time||item.updated_at||0)}))};
      apiError='ChatGPT API không trả conversation.';
    }else apiError=`ChatGPT HTTP ${response.status}`;
  }catch(error){apiError=String(error?.message||error);}
  const seen=new Set(),items=[];
  for(const anchor of document.querySelectorAll('a[href*="/c/"]')){
    let match;
    try{match=new URL(anchor.href,location.origin).pathname.match(/^\/c\/([A-Za-z0-9-]{8,160})/);}catch{continue;}
    const id=match?.[1];
    if(!id||seen.has(id))continue;
    seen.add(id);
    const title=String(anchor.innerText||anchor.getAttribute('aria-label')||anchor.title||'Đoạn chat chưa có tiêu đề').trim();
    items.push({id,title:title||'Đoạn chat chưa có tiêu đề',updated_at:0});
    if(items.length>=limit)break;
  }
  return items.length?{ok:true,source:'sidebar',items}:{ok:false,error:apiError||'Không đọc được danh sách conversation gần đây.'};
}

async function recentConversationList(limit=3) {
  const now=Date.now();
  if(now-recentConversationCache.at<30000)return recentConversationCache.items;
  const tabs=await chrome.tabs.query({url:['https://chatgpt.com/*']});
  const source=tabs.find(tab=>tab.active)||tabs[0];
  if(!source?.id)return recentConversationCache.items;
  try{
    const [injected]=await chrome.scripting.executeScript({target:{tabId:source.id},world:'MAIN',func:fetchRecentConversationsPage,args:[limit]});
    if(!injected.result?.ok)return recentConversationCache.items;
    const stored=await chrome.storage.local.get('codexproHiddenConversationIds');
    const hiddenIds=new Set((Array.isArray(stored.codexproHiddenConversationIds)?stored.codexproHiddenConversationIds:[]).map(String));
    const titleOverrides=await getConversationTitleOverrides();
    const items=(injected.result.items||[])
      .filter(item=>/^[A-Za-z0-9-]{8,160}$/.test(String(item.id||''))&&!hiddenIds.has(String(item.id||'')))
      .slice(0,limit)
      .map(item=>{const id=String(item.id);return {id,title:String(titleOverrides[id]?.title||item.title||'Đoạn chat chưa có tiêu đề').slice(0,300),url:`https://chatgpt.com/c/${id}`,updated_at:Number(item.updated_at)||0};});
    recentConversationCache={at:now,items};
    return items;
  }catch{return recentConversationCache.items;}
}

async function renameConversationPage(conversationId,title) {
  try{
    const sessionResponse=await fetch('/api/auth/session',{credentials:'include',cache:'no-store'});
    const session=await sessionResponse.json().catch(()=>({}));
    const accessToken=String(session?.accessToken||'');
    if(!accessToken)return {ok:false,status:sessionResponse.status,error:'ChatGPT session không trả access token.'};
    const accountId=String(session?.account?.id||session?.accountId||session?.user?.account_id||session?.user?.accountId||session?.accounts?.[0]?.id||'').trim();
    const requestHeaders={'content-type':'application/json',authorization:`Bearer ${accessToken}`,...(accountId?{'chatgpt-account-id':accountId}:{})};
    const candidates=[
      {endpoint:`/backend-api/conversation/id/${encodeURIComponent(conversationId)}/rename`,method:'POST'},
      {endpoint:`/backend-api/conversations/${encodeURIComponent(conversationId)}`,method:'PATCH'},
      {endpoint:`/backend-api/conversation/${encodeURIComponent(conversationId)}`,method:'PATCH'}
    ];
    let lastError='';
    for(const candidate of candidates){
      const response=await fetch(candidate.endpoint,{method:candidate.method,credentials:'include',cache:'no-store',headers:requestHeaders,body:JSON.stringify({title})});
      const payload=await response.json().catch(()=>({}));
      if(response.ok){
        const verifyResponse=await fetch(`/backend-api/conversations/${encodeURIComponent(conversationId)}?include_has_versions=true&num_turns=1`,{credentials:'include',cache:'no-store',headers:requestHeaders});
        const verified=await verifyResponse.json().catch(()=>({}));
        const verifiedTitle=String(verified?.title||'');
        if(verifyResponse.ok&&verifiedTitle===title)return {ok:true,status:response.status,endpoint:candidate.endpoint,method:candidate.method,conversation_id:conversationId,title,verified_title:verifiedTitle,payload};
        return {ok:false,status:response.status,endpoint:candidate.endpoint,method:candidate.method,error:`ChatGPT nhận lệnh nhưng chưa lưu tên mới (đang là “${verifiedTitle||'không đọc được'}”).`};
      }
      const reason=payload?.detail??payload?.error??`ChatGPT HTTP ${response.status}`;
      lastError=`${candidate.endpoint}: ${typeof reason==='string'?reason:JSON.stringify(reason)}`;
      if(![404,405].includes(response.status))break;
    }
    return {ok:false,error:lastError||'ChatGPT không nhận endpoint đổi tên.'};
  }catch(error){return {ok:false,error:String(error?.message||error)};}
}

async function hideConversationPage(conversationId) {
  try{
    const sessionResponse=await fetch('/api/auth/session',{credentials:'include',cache:'no-store'});
    const session=await sessionResponse.json().catch(()=>({}));
    const accessToken=String(session?.accessToken||'');
    if(!accessToken)return {ok:false,status:sessionResponse.status,error:'ChatGPT session không trả access token.'};
    const candidates=[`/backend-api/conversations/${encodeURIComponent(conversationId)}`,`/backend-api/conversation/${encodeURIComponent(conversationId)}`];
    let lastError='';
    for(const endpoint of candidates){
      const response=await fetch(endpoint,{method:'PATCH',credentials:'include',cache:'no-store',headers:{'content-type':'application/json',authorization:`Bearer ${accessToken}`},body:JSON.stringify({is_visible:false})});
      const payload=await response.json().catch(()=>({}));
      if(response.ok)return {ok:true,status:response.status,endpoint,conversation_id:conversationId};
      if(payload?.code==='conversation_deleted'||payload?.detail?.code==='conversation_deleted')return {ok:true,status:response.status,endpoint,conversation_id:conversationId,already_deleted:true};
      const reason=payload?.detail??payload?.error??`ChatGPT HTTP ${response.status}`;
      lastError=`${endpoint}: ${typeof reason==='string'?reason:JSON.stringify(reason)}`;
      if(![404,405].includes(response.status))break;
    }
    return {ok:false,error:lastError||'ChatGPT không nhận endpoint ẩn conversation.'};
  }catch(error){return {ok:false,error:String(error?.message||error)};}
}

function snapshotPage(maxChars) {
  const visible = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'; };
  const selectorFor = el => {
    if(el.id)return '#'+CSS.escape(el.id);
    for(const attr of ['data-testid','data-test','name','aria-label']){const value=el.getAttribute(attr);if(value){const candidate=el.tagName.toLowerCase()+'['+attr+'='+JSON.stringify(value)+']';try{if(document.querySelectorAll(candidate).length===1)return candidate;}catch{}}}
    const parts=[];let node=el;
    while(node&&node.nodeType===1&&node!==document.documentElement){let part=node.tagName.toLowerCase();const siblings=node.parentElement?Array.from(node.parentElement.children).filter(child=>child.tagName===node.tagName):[];if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(node)+1)+')';parts.unshift(part);const candidate=parts.join(' > ');try{if(document.querySelectorAll(candidate).length===1)return candidate;}catch{}node=node.parentElement;}
    return parts.join(' > ');
  };
  const elements=Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')).filter(visible).slice(0,500).map(el=>{const label=(el.innerText||el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('name')||'').trim();return {tag:el.tagName.toLowerCase(),selector:selectorFor(el),role:el.getAttribute('role'),type:el.getAttribute('type'),text:label.slice(0,300),disabled:Boolean(el.disabled),checked:Boolean(el.checked),aria_pressed:el.getAttribute('aria-pressed'),data_state:el.getAttribute('data-state'),value_length:typeof el.value==='string'?el.value.length:0};});
  const composer=document.querySelector('#prompt-textarea');
  return {title:document.title,url:location.href,text:(document.body?.innerText||'').slice(0,maxChars),elements,composer_html:(composer?.innerHTML||'').slice(0,5000)};
}

function clickPage(selector) {
  const el=document.querySelector(selector);if(!el)return {ok:false,error:'Element not found'};el.scrollIntoView({block:'center',inline:'center'});el.click();return {ok:true,tag:el.tagName.toLowerCase(),text:(el.innerText||el.getAttribute('aria-label')||'').slice(0,300)};
}

function typePage(selector,text) {
  const el=document.querySelector(selector);if(!el)return {ok:false,error:'Element not found'};el.scrollIntoView({block:'center',inline:'center'});el.focus();
  if(el.isContentEditable){
    if(el.querySelector('[data-inline-selection-pill]')){
      const selection=window.getSelection(),range=document.createRange(),paragraph=el.querySelector('p:last-child')||el;
      range.selectNodeContents(paragraph);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
      document.execCommand('insertText',false,` ${text}`);
    }else el.textContent=text;
  }else{const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(el,text);else el.value=text;}
  el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,tag:el.tagName.toLowerCase(),length:text.length};
}

async function sendChatRequestPage(text,attachments=[],attemptId='',deadlineAt=0) {
  const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
  const expired=()=>Boolean(deadlineAt&&Date.now()>Number(deadlineAt));
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  const normalizedText=value=>String(value||'').replace(/[\u200B-\u200D\uFEFF]/g,'').trim();
  const composerText=element=>element?.isContentEditable?normalizedText(element.innerText||element.textContent||''):normalizedText(element?.value||'');
  if(location.origin!=='https://chatgpt.com'||(!location.pathname.startsWith('/c/')&&location.pathname!=='/'))return {ok:false,error:'Tab đã chọn không phải ChatGPT.'};
  const composerSelectors=['#prompt-textarea','[contenteditable="true"][data-lexical-editor="true"]','textarea[data-id="root"]','textarea[placeholder]'];
  const findComposer=()=>composerSelectors.map(selector=>document.querySelector(selector)).find(element=>visible(element));
  const composerRootFor=element=>element?.closest('form')||element?.closest('[data-type="unified-composer"]')||element?.parentElement;
  const attachmentButtons=root=>Array.from((root||document).querySelectorAll('button[aria-label*="Remove file" i],button[aria-label*="Remove attachment" i],button[aria-label*="Xóa tệp" i],button[aria-label*="Xóa file" i]')).filter(visible);
  const attachmentLabel=button=>String(button?.getAttribute?.('aria-label')||button?.innerText||button?.textContent||'').trim();
  const clearOwnedDraft=async()=>{
    let textCleared=false,attachmentsRemoved=0;
    const current=findComposer();
    const root=composerRootFor(current);
    if(current&&current.dataset.codexproDraftAttempt===attemptId){
      current.focus();
      if(current.isContentEditable){
        const selection=window.getSelection(),range=document.createRange();
        range.selectNodeContents(current);selection.removeAllRanges();selection.addRange(range);
        if(!document.execCommand('delete',false))current.textContent='';
      }else{
        const proto=current instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
        if(setter)setter.call(current,'');else current.value='';
      }
      current.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward',data:null}));
      current.dispatchEvent(new Event('change',{bubbles:true}));
      textCleared=!composerText(current);
      delete current.dataset.codexproDraftAttempt;
    }
    let ownedLabels=new Set();
    if(root?.dataset?.codexproAttachmentAttempt===attemptId){
      try{ownedLabels=new Set(JSON.parse(root.dataset.codexproAttachmentLabels||'[]'));}catch{}
    }
    for(const button of attachmentButtons(root)){
      const owned=button.dataset.codexproAttachmentAttempt===attemptId||ownedLabels.has(attachmentLabel(button));
      if(!owned)continue;
      button.click();attachmentsRemoved+=1;await sleep(40);
    }
    if(root?.dataset?.codexproAttachmentAttempt===attemptId){
      delete root.dataset.codexproAttachmentAttempt;
      delete root.dataset.codexproAttachmentLabels;
    }
    return {text_cleared:textCleared,attachments_removed:attachmentsRemoved};
  };
  const fail=async(error,extra={})=>({ok:false,error,...extra,cleanup:await clearOwnedDraft()});
  let composer=findComposer();
  if(!composer)return {ok:false,error:'Không tìm thấy ô nhập đang hiển thị trong đoạn chat.'};
  const root=composerRootFor(composer);
  const contentEditableEmpty=Boolean(composer.isContentEditable&&composer.querySelector('[data-empty-paragraph="true"]')&&!Array.from(composer.querySelectorAll('p')).some(node=>!node.hasAttribute('data-empty-paragraph')&&String(node.textContent||'').replace(/[\u200B-\u200D\uFEFF]/g,'').trim()));
  const rawDraft=composer.isContentEditable?String(composer.innerText||''):String(composer.value||'');
  const normalizedDraft=rawDraft.replace(/[\u200B-\u200D\uFEFF]/g,'').trim();
  const placeholder=String(composer.getAttribute?.('data-placeholder')||composer.getAttribute?.('placeholder')||'').trim();
  const draft=contentEditableEmpty||normalizedDraft===placeholder||/^(?:ask|message|chat with)\s+chatgpt[.…]*$/i.test(normalizedDraft)?'':normalizedDraft;
  const ownedExistingDraft=Boolean(draft&&composer.dataset.codexproDraftAttempt===attemptId&&draft===normalizedText(text));
  if(draft&&!ownedExistingDraft)return {ok:false,error:'Ô ChatGPT đang có một bản nháp khác. CodexPro không ghi đè bản nháp của người dùng.'};
  const existingAttachments=attachmentButtons(root);
  if(existingAttachments.length)return {ok:false,error:'Ô chat đang có file chưa gửi; CodexPro không ghi đè file/bản nháp có sẵn.'};
  if(expired())return {ok:false,error:'Lần gửi đã hết hạn trước khi thao tác composer.',expired:true};

  if(attachments.length){
    const candidates=Array.from((root||document).querySelectorAll('input[type="file"]')).filter(input=>!input.disabled);
    const fallbackCandidates=Array.from(document.querySelectorAll('input[type="file"]')).filter(input=>!input.disabled);
    const fileInput=candidates.find(input=>input.multiple)||candidates[0]||fallbackCandidates.find(input=>input.multiple)||fallbackCandidates[0];
    if(!fileInput)return {ok:false,error:'ChatGPT chưa hiển thị ô nhận file trong đoạn chat này.'};
    const transfer=new DataTransfer();
    try{
      for(const attachment of attachments){
        const binary=atob(attachment.data_base64),bytes=new Uint8Array(binary.length);
        for(let index=0;index<binary.length;index+=1)bytes[index]=binary.charCodeAt(index);
        transfer.items.add(new File([bytes],attachment.name,{type:attachment.mime_type||'application/octet-stream',lastModified:Date.now()}));
      }
      if(root)root.dataset.codexproAttachmentAttempt=attemptId;
      fileInput.files=transfer.files;
      fileInput.dispatchEvent(new Event('input',{bubbles:true}));
      fileInput.dispatchEvent(new Event('change',{bubbles:true}));
    }catch(error){return await fail('Không thể gắn file: '+(error?.message||error));}
    let readyButtons=[];
    while(!expired()){
      readyButtons=attachmentButtons(root);
      if(readyButtons.length>=attachments.length)break;
      await sleep(100);
    }
    if(readyButtons.length<attachments.length)return await fail('ChatGPT chưa xác nhận file đính kèm đã sẵn sàng để gửi.',{expired:expired()});
    const ownedButtons=readyButtons.slice(0,attachments.length);
    ownedButtons.forEach(button=>{button.dataset.codexproAttachmentAttempt=attemptId;});
    if(root){
      root.dataset.codexproAttachmentLabels=JSON.stringify(ownedButtons.map(attachmentLabel));
    }
    const stableUntil=Math.min(Number(deadlineAt)||Date.now()+2500,Date.now()+2500);
    while(Date.now()<stableUntil){
      if(expired())return await fail('Lần gửi đã hết hạn trong lúc chờ file ổn định.',{expired:true});
      if(attachmentButtons(root).length<attachments.length)return await fail('Attachment biến mất trước khi sẵn sàng gửi.');
      await sleep(100);
    }
    composer=findComposer();
    if(!composer)return await fail('Ô nhập ChatGPT đang hiển thị biến mất sau khi gắn file.');
  }

  if(text&&!ownedExistingDraft){
    if(expired())return await fail('Lần gửi đã hết hạn trước khi nhập nội dung.',{expired:true});
    composer.scrollIntoView({block:'center',inline:'center'});composer.focus();
    composer.dataset.codexproDraftAttempt=attemptId;
    if(composer.isContentEditable){
      if(composer.querySelector('[data-inline-selection-pill]')){
        const selection=window.getSelection(),range=document.createRange(),paragraph=composer.querySelector('p:last-child')||composer;
        range.selectNodeContents(paragraph);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
        document.execCommand('insertText',false,' '+text);
      }else{
        const selection=window.getSelection(),range=document.createRange();
        range.selectNodeContents(composer);selection.removeAllRanges();selection.addRange(range);
        if(!document.execCommand('insertText',false,text))composer.textContent=text;
      }
    }else{
      const proto=composer instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
      if(setter)setter.call(composer,text);else composer.value=text;
    }
    composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
    composer.dispatchEvent(new Event('change',{bubbles:true}));
    while(!expired()&&composerText(composer)!==normalizedText(text))await sleep(50);
    if(composerText(composer)!==normalizedText(text))return await fail('ChatGPT chưa nhận nội dung vào composer; chưa gửi để tránh báo thành công giả.',{expired:expired()});
  }

  let send;
  while(!expired()){
    send=['#composer-submit-button','button[data-testid="send-button"]','button[aria-label*="Send" i]','button[aria-label*="Gửi" i]'].map(selector=>(root||document).querySelector(selector)||document.querySelector(selector)).find(element=>{
      if(!visible(element)||element.disabled||element.getAttribute?.('aria-disabled')==='true'||element.hasAttribute?.('data-visually-disabled'))return false;
      const label=String(element.innerText||element.textContent||element.getAttribute?.('aria-label')||'').trim();
      return !/(?:stop\s+(?:answering|generating|streaming)|dừng(?:\s+trả\s+lời)?)/i.test(label);
    });
    if(send)break;
    await sleep(100);
  }
  if(!send)return await fail(attachments.length?'ChatGPT chưa tải file xong hoặc không chấp nhận định dạng file này.':'Đã nhập yêu cầu nhưng nút gửi chưa sẵn sàng.',{expired:expired()});
  if(expired())return await fail('Lần gửi đã hết hạn ngay trước khi bấm gửi; CodexPro đã hủy để tránh gửi trùng.',{expired:true});
  send.click();
  return {ok:true,title:document.title,url:location.href,length:text.length,attachment_count:attachments.length,attachment_names:attachments.map(file=>file.name),submitted:true,submitted_by:'ui-click',attempt_id:attemptId};
}

async function cleanupChatRequestDraftPage(attemptId='') {
  const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  const composerSelectors=['#prompt-textarea','[contenteditable="true"][data-lexical-editor="true"]','textarea[data-id="root"]','textarea[placeholder]'];
  const composer=composerSelectors.map(selector=>document.querySelector(selector)).find(element=>visible(element));
  const root=composer?.closest('form')||composer?.closest('[data-type="unified-composer"]')||composer?.parentElement;
  let textCleared=false,attachmentsRemoved=0;
  if(composer&&composer.dataset.codexproDraftAttempt===attemptId){
    composer.focus();
    if(composer.isContentEditable){
      const selection=window.getSelection(),range=document.createRange();
      range.selectNodeContents(composer);selection.removeAllRanges();selection.addRange(range);
      if(!document.execCommand('delete',false))composer.textContent='';
    }else{
      const proto=composer instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
      if(setter)setter.call(composer,'');else composer.value='';
    }
    composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward',data:null}));
    composer.dispatchEvent(new Event('change',{bubbles:true}));
    delete composer.dataset.codexproDraftAttempt;textCleared=true;
  }
  let ownedLabels=new Set();
  if(root?.dataset?.codexproAttachmentAttempt===attemptId){
    try{ownedLabels=new Set(JSON.parse(root.dataset.codexproAttachmentLabels||'[]'));}catch{}
  }
  const buttons=Array.from((root||document).querySelectorAll('button[aria-label*="Remove file" i],button[aria-label*="Remove attachment" i],button[aria-label*="Xóa tệp" i],button[aria-label*="Xóa file" i]')).filter(visible);
  for(const button of buttons){
    const label=String(button.getAttribute?.('aria-label')||button.innerText||button.textContent||'').trim();
    const owned=button.dataset.codexproAttachmentAttempt===attemptId||ownedLabels.has(label);
    if(!owned)continue;
    button.click();attachmentsRemoved+=1;await sleep(40);
  }
  if(root?.dataset?.codexproAttachmentAttempt===attemptId){
    delete root.dataset.codexproAttachmentAttempt;
    delete root.dataset.codexproAttachmentLabels;
  }
  return {ok:true,text_cleared:textCleared,attachments_removed:attachmentsRemoved};
}

async function readChatResponsePage() {
  const nodeText=node=>String(node?.innerText||node?.textContent||'').replace(/\u200b/g,'').trim();
  const structuredText=node=>{
    if(!node)return '';
    const clone=node.cloneNode(true);
    clone.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode('\n')));
    clone.querySelectorAll('ul,ol').forEach(list=>{
      const ordered=list.tagName==='OL';
      const start=ordered?(Number(list.getAttribute('start'))||1):1;
      Array.from(list.children).filter(child=>child.tagName==='LI').forEach((item,index)=>{
        const marker=ordered?`${start+index}. `:'• ';
        const firstBlock=Array.from(item.children).find(child=>!['UL','OL'].includes(child.tagName))||item;
        firstBlock.insertBefore(document.createTextNode(marker),firstBlock.firstChild);
      });
    });
    clone.querySelectorAll('p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,tr').forEach(block=>block.appendChild(document.createTextNode('\n')));
    return String(clone.textContent||'').replace(/\u200b/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  };
  if(!location.pathname.startsWith('/c/'))return {ok:false,error:'Tab đã chọn không phải đoạn chat ChatGPT.'};
  const messageNodes=Array.from(document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')).slice(-20);
  const messages=messageNodes.map((message,index)=>{
    const role=message.getAttribute('data-message-author-role')==='user'?'user':'assistant';
    const content=role==='assistant'?message.querySelector('.markdown,.prose,[class*="markdown"]')||message:message.querySelector('.whitespace-pre-wrap,[class*="whitespace-pre-wrap"],[data-message-content]')||message;
    const raw=role==='assistant'?structuredText(content):nodeText(content);
    const text=raw.slice(0,40000);
    return raw?{id:`${role}-${index}`,role,text,truncated:raw.length>text.length}:null;
  }).filter(Boolean);
  const latestAssistant=[...messages].reverse().find(message=>message.role==='assistant');
  const text=latestAssistant?.text||'';
  return {ok:true,title:document.title,url:location.href,text,text_length:text.length,truncated:Boolean(latestAssistant?.truncated),incomplete:false,incomplete_reason:'',conversation_limit_reached:false,conversation_limit_message:'',conversation_limit_button_label:'',message_count:messages.filter(message=>message.role==='assistant').length,total_message_count:messages.length,messages,busy:false,updated_at:new Date().toISOString()};
}

async function probeConversationLimitPage() {
  const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
  const limitPattern=/(?:you(?:'|’)?ve reached the maximum length for this conversation|maximum length for this conversation|đ(?:ã|a) (?:đạt|chạm|tới).*?(?:độ dài|do dai).*?(?:tối đa|toi da).*?(?:cuộc trò chuyện|đoạn chat))/i;
  const startNewChatPattern=/(?:start new chat|bắt đầu (?:một )?(?:cuộc trò chuyện|đoạn chat) mới)/i;
  const findLimit=()=>{
    const controls=Array.from(document.querySelectorAll('button,a,[role="button"]'));
    for(const control of controls){
      const label=String(control.innerText||control.textContent||control.getAttribute?.('aria-label')||'').trim();
      if(!startNewChatPattern.test(label))continue;
      let node=control;
      for(let depth=0;node&&depth<4;depth+=1,node=node.parentElement){
        const text=String(node.innerText||node.textContent||'').replace(/\u200b/g,'').trim();
        if(text.length<=1400&&limitPattern.test(text))return {reached:true,message:text.slice(0,500),button_label:label};
      }
    }
    return null;
  };
  const deadline=Date.now()+1200;
  while(Date.now()<deadline){
    const found=findLimit();
    if(found)return found;
    await sleep(100);
  }
  return findLimit()||{reached:false,message:'',button_label:''};
}

async function targetTab(args) {
  const targetId=Number(args.target_id);
  if (Number.isInteger(targetId)&&targetId>=0) return await chrome.tabs.get(targetId);
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id) throw new Error('No active Chrome tab.');
  return tab;
}

async function promiseWithTimeout(promise,timeoutMs,label) {
  let timer;
  try{
    return await Promise.race([
      promise,
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label||'Timed out.')),timeoutMs);})
    ]);
  }finally{if(timer)clearTimeout(timer);}
}

async function probeConversationLimit(tabId) {
  try{
    const [injected]=await promiseWithTimeout(
      chrome.scripting.executeScript({target:{tabId},func:probeConversationLimitPage}),
      CONVERSATION_LIMIT_PROBE_TIMEOUT_MS,
      'Chrome renderer không phản hồi khi kiểm tra giới hạn chat.'
    );
    return injected?.result&&typeof injected.result==='object'?injected.result:{reached:false,message:'',button_label:''};
  }catch{return {reached:false,message:'',button_label:''};}
}

async function execute(command) {
  const {action,args={}}=command;
  if(action==='reload_extension'){
    await chrome.alarms.create('codexpro-reconnect',{when:Date.now()+3000});
    setTimeout(()=>chrome.runtime.reload(),1200);
    return {action,ok:true,reloading:true,version:chrome.runtime.getManifest().version};
  }
  if(action==='check_chatgpt')return {action,...await checkConnectorInstalled()};
  if(action==='setup_chatgpt')return {action,...await installConnector()};
  if(action==='list_tabs')return {action,tabs:await tabList()};
  if(action==='send_chat_request'){
    const text=String(args.text||'').trim();
    const attachments=Array.isArray(args.attachments)?args.attachments.slice(0,4).map(file=>({name:String(file?.name||'').trim().slice(0,255),mime_type:String(file?.mime_type||'application/octet-stream').trim().slice(0,160),data_base64:String(file?.data_base64||'')})):[];
    const newChat=Boolean(args.new_chat);
    if(!text&&!attachments.length)throw new Error('Yêu cầu và file đính kèm không được cùng để trống.');
    if(text.length>12000)throw new Error('Yêu cầu dài quá 12.000 ký tự.');
    if(attachments.some(file=>!file.name||!file.data_base64))throw new Error('File đính kèm không hợp lệ.');
    if(attachments.reduce((total,file)=>total+file.data_base64.length,0)>14000000)throw new Error('Tổng file đính kèm quá lớn.');
    const requestedId=Number(args.target_id);
    const conversationId=String(args.conversation_id||'').trim();
    if(!newChat&&conversationId&&!/^[A-Za-z0-9-]{8,160}$/.test(conversationId))throw new Error('Conversation id không hợp lệ.');
    const tabs=await chrome.tabs.query({});
    const conversations=tabs.filter(candidate=>candidate.id&&String(candidate.url||'').startsWith('https://chatgpt.com/c/'));
    let tab=newChat
      ? await chrome.tabs.create({url:'https://chatgpt.com/',active:false})
      : conversationId
        ? conversations.find(candidate=>{try{return new URL(candidate.url).pathname==='/c/'+conversationId;}catch{return false;}})
        : Number.isInteger(requestedId)
          ? conversations.find(candidate=>candidate.id===requestedId)
          : conversations.find(candidate=>candidate.active)||conversations[0];
    if(newChat){await waitForTab(tab.id,45000);tab=await chrome.tabs.get(tab.id);}
    if(!tab&&conversationId){
      const recent=await recentConversationList(3);
      if(!recent.some(conversation=>conversation.id===conversationId))throw new Error('Đoạn chat không còn thuộc 3 chat gần nhất của profile này.');
      tab=await chrome.tabs.create({url:'https://chatgpt.com/c/'+conversationId,active:false});await waitForTab(tab.id,45000);tab=await chrome.tabs.get(tab.id);
    }
    if(!tab?.id)throw new Error('Profile này không có đoạn chat dự án đang mở.');
    if((await chatRequestState(tab.id,conversationId)).busy)throw new Error('Đoạn chat đang xử lý yêu cầu khác.');

    const submitStartedAt=Date.now();
    const attemptId=crypto.randomUUID();
    const deadlineAt=submitStartedAt+DOM_SEND_TIMEOUT_MS-1500;
    pendingConversationByTab.set(tab.id,{conversation_id:newChat?'':conversationId||conversationIdFromUrl(tab.url),source:'codexpro',at:submitStartedAt});
    const cleanupAttempt=async()=>{
      try{
        await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:cleanupChatRequestDraftPage,args:[attemptId]}),DOM_ACTION_TIMEOUT_MS,'Cleanup composer timeout.');
      }catch{}
    };
    const resultForNetwork=async(networkAck,injectedResult={})=>{
      pendingConversationByTab.delete(tab.id);
      if(networkAck.network_state==='failed'){
        const limit=await probeConversationLimit(tab.id);
        if(limit.reached)throw new Error('CONVERSATION_LIMIT_REACHED: '+(limit.message||'ChatGPT báo đoạn chat đã đạt giới hạn độ dài.'));
      }
      if(newChat){
        let created=null;
        try{created=await waitForConversationUrl(tab.id,networkAck.network_state==='failed'?5000:45000);}catch{}
        if(created?.conversationId){
          await bindConversationToTab(tab.id,created.conversationId);
          recentConversationCache={at:0,items:[]};
          return {action,target_id:tab.id,conversation_id:created.conversationId,new_chat:true,network_tracking:true,network_acknowledged:true,submission_state:'submitted',generation_state:networkAck.network_state,network_state:networkAck.network_state,network_error:networkAck.network_error,network_status_code:networkAck.network_status_code,...injectedResult,submitted:true,submitted_by:'network'};
        }
        return {action,target_id:tab.id,conversation_id:'',new_chat:true,network_tracking:true,network_acknowledged:true,submission_state:'submitted',generation_state:networkAck.network_state,network_state:networkAck.network_state,network_error:networkAck.network_error,network_status_code:networkAck.network_status_code,...injectedResult,submitted:true,submitted_by:'network',conversation_pending:true};
      }
      await bindConversationToTab(tab.id,conversationId);
      return {action,target_id:tab.id,conversation_id:conversationId,network_tracking:true,network_acknowledged:true,submission_state:'submitted',generation_state:networkAck.network_state,network_state:networkAck.network_state,network_error:networkAck.network_error,network_status_code:networkAck.network_status_code,...injectedResult,submitted:true,submitted_by:'network'};
    };
    let injected;
    try{
      [injected]=await promiseWithTimeout(
        chrome.scripting.executeScript({target:{tabId:tab.id},func:sendChatRequestPage,args:[text,attachments,attemptId,deadlineAt]}),
        DOM_SEND_TIMEOUT_MS,
        'Chrome renderer không phản hồi khi chuẩn bị/gửi tin nhắn.'
      );
    }catch(error){
      let networkAck=null;
      try{networkAck=await waitForNetworkGeneration(tab.id,submitStartedAt-100,5000);}catch{}
      if(networkAck)return await resultForNetwork(networkAck,{dom_timeout:true,dom_error:String(error?.message||error).slice(0,300)});
      pendingConversationByTab.delete(tab.id);
      await cleanupAttempt();
      const limit=await probeConversationLimit(tab.id);
      if(limit.reached)throw new Error('CONVERSATION_LIMIT_REACHED: '+(limit.message||'ChatGPT báo đoạn chat đã đạt giới hạn độ dài.'));
      return {action,target_id:tab.id,conversation_id:newChat?'':conversationId,new_chat:newChat,ok:true,submission_state:'uncertain',generation_state:'idle',network_state:'idle',network_tracking:true,network_acknowledged:false,submitted:false,send_uncertain:true,error:'SEND_UNCERTAIN: '+String(error?.message||error),attempt_id:attemptId};
    }
    if(!injected?.result?.ok){
      pendingConversationByTab.delete(tab.id);
      const limit=await probeConversationLimit(tab.id);
      if(limit.reached)throw new Error('CONVERSATION_LIMIT_REACHED: '+(limit.message||'ChatGPT báo đoạn chat đã đạt giới hạn độ dài.'));
      if(injected?.result?.expired)return {action,target_id:tab.id,conversation_id:newChat?'':conversationId,new_chat:newChat,ok:true,submission_state:'uncertain',generation_state:'idle',network_state:'idle',network_tracking:true,network_acknowledged:false,submitted:false,send_uncertain:true,error:'SEND_UNCERTAIN: '+(injected.result.error||'Lần gửi đã hết hạn.'),attempt_id:attemptId,cleanup:injected.result.cleanup};
      if(newChat)await chrome.tabs.remove(tab.id).catch(()=>{});
      throw new Error(injected?.result?.error||'Không gửi được yêu cầu vào ChatGPT.');
    }
    let networkAck=null;
    try{networkAck=await waitForNetworkGeneration(tab.id,submitStartedAt-100,NETWORK_START_TIMEOUT_MS);}catch{}
    if(!networkAck){
      pendingConversationByTab.delete(tab.id);
      await cleanupAttempt();
      const limit=await probeConversationLimit(tab.id);
      if(limit.reached)throw new Error('CONVERSATION_LIMIT_REACHED: '+(limit.message||'ChatGPT báo đoạn chat đã đạt giới hạn độ dài.'));
      return {action,target_id:tab.id,conversation_id:newChat?'':conversationId,new_chat:newChat,...injected.result,ok:true,submission_state:'uncertain',generation_state:'idle',network_state:'idle',network_tracking:true,network_acknowledged:false,submitted:false,send_uncertain:true,error:'SEND_UNCERTAIN: Đã bấm gửi nhưng chưa thấy generation request; CodexPro không tự gửi lại để tránh duplicate.',attempt_id:attemptId};
    }
    return await resultForNetwork(networkAck,injected.result);
  }

if(action==='rename_chat'){
    const conversationId=String(args.conversation_id||'').trim();
    const title=String(args.title||'').trim();
    if(!/^[A-Za-z0-9-]{8,160}$/.test(conversationId))throw new Error('Conversation id không hợp lệ.');
    if(!title||title.length>120)throw new Error('Tên đoạn chat phải từ 1 đến 120 ký tự.');
    const tabs=await chrome.tabs.query({url:['https://chatgpt.com/*']});
    const source=tabs.find(tab=>tab.id&&tab.active)||tabs.find(tab=>tab.id);
    if(!source?.id)throw new Error('Profile này chưa có tab ChatGPT để gọi API đổi tên.');
    const [injected]=await chrome.scripting.executeScript({target:{tabId:source.id},world:'MAIN',func:renameConversationPage,args:[conversationId,title]});
    if(!injected.result?.ok)throw new Error(injected.result?.error||'ChatGPT không đổi tên đoạn chat.');
    await saveConversationTitleOverride(conversationId,title);
    recentConversationCache={at:0,items:[]};
    return {action,...injected.result};
  }
  if(action==='hide_chat'){
    const conversationId=String(args.conversation_id||'').trim();
    if(!/^[A-Za-z0-9-]{8,160}$/.test(conversationId))throw new Error('Conversation id không hợp lệ.');
    const tabs=await chrome.tabs.query({url:['https://chatgpt.com/*']});
    const source=tabs.find(tab=>tab.id&&tab.active)||tabs.find(tab=>tab.id);
    if(!source?.id)throw new Error('Profile này chưa có tab ChatGPT để gọi API cleanup.');
    const [injected]=await chrome.scripting.executeScript({target:{tabId:source.id},world:'MAIN',func:hideConversationPage,args:[conversationId]});
    if(!injected.result?.ok)throw new Error(injected.result?.error||'ChatGPT không ẩn conversation probe.');
    const stored=await chrome.storage.local.get('codexproHiddenConversationIds');
    const hiddenIds=[conversationId,...(Array.isArray(stored.codexproHiddenConversationIds)?stored.codexproHiddenConversationIds:[]).map(String).filter(id=>id!==conversationId)].slice(0,50);
    await chrome.storage.local.set({codexproHiddenConversationIds:hiddenIds});
    recentConversationCache={at:0,items:[]};
    return {action,...injected.result};
  }
  if(action==='get_chat_response'){
    const conversationId=String(args.conversation_id||'').trim();
    if(!/^[A-Za-z0-9-]{8,160}$/.test(conversationId))throw new Error('Conversation id không hợp lệ.');
    const tabs=await chrome.tabs.query({});
    const conversations=tabs.filter(candidate=>candidate.id&&String(candidate.url||'').startsWith('https://chatgpt.com/c/'));
    let tab=conversations.find(candidate=>{try{return new URL(candidate.url).pathname===`/c/${conversationId}`;}catch{return false;}});
    if(!tab){
      const recent=await recentConversationList(3);
      if(!recent.some(conversation=>conversation.id===conversationId))throw new Error('Đoạn chat không còn thuộc 3 chat gần nhất của profile này.');
      tab=await chrome.tabs.create({url:`https://chatgpt.com/c/${conversationId}`,active:false});await waitForTab(tab.id,45000);tab=await chrome.tabs.get(tab.id);
    }
    if(!tab?.id)throw new Error('Không mở được đoạn chat cần đọc phản hồi.');
    const networkState=await chatRequestState(tab.id,conversationId);
    const networkPayload={
      network_state:networkState.network_state,
      network_source:networkState.network_source,
      network_last_started_at:networkState.network_last_started_at,
      network_last_completed_at:networkState.network_last_completed_at,
      network_status_code:networkState.network_status_code,
      network_error:networkState.network_error,
      network_duration_ms:networkState.network_duration_ms
    };
    if(args.read_dom===false){
      return {action,target_id:tab.id,ok:true,title:String(tab.title||''),url:String(tab.url||''),text:'',text_length:0,truncated:false,incomplete:false,incomplete_reason:'',conversation_limit_reached:false,conversation_limit_message:'',message_count:0,total_message_count:0,messages:[],busy:networkState.busy,dom_available:false,dom_skipped:true,dom_error:'',updated_at:new Date().toISOString(),...networkPayload};
    }
    try{
      const [injected]=await promiseWithTimeout(
        chrome.scripting.executeScript({target:{tabId:tab.id},func:readChatResponsePage}),
        DOM_READ_TIMEOUT_MS,
        'Chrome renderer không phản hồi khi đọc DOM.'
      );
      if(!injected?.result?.ok)throw new Error(injected?.result?.error||'Không đọc được phản hồi ChatGPT.');
      return {action,target_id:tab.id,...injected.result,busy:networkState.busy,dom_available:true,dom_busy:Boolean(injected.result.busy),...networkPayload};
    }catch(error){
      return {
        action,
        target_id:tab.id,
        ok:true,
        title:String(tab.title||''),
        url:String(tab.url||''),
        text:'',
        text_length:0,
        truncated:false,
        incomplete:false,
        incomplete_reason:'',
        conversation_limit_reached:false,
        conversation_limit_message:'',
        message_count:0,
        total_message_count:0,
        messages:[],
        busy:networkState.busy,
        dom_available:false,
        dom_error:String(error?.message||error).slice(0,500),
        updated_at:new Date().toISOString(),
        ...networkPayload
      };
    }
  }
  if(action==='open_tab'){const tab=await chrome.tabs.create({url:args.url,active:true});return {action,target_id:tab.id,title:tab.title||'',url:tab.url||args.url};}
  const tab=await targetTab(args);
  if(action==='activate_tab'){
    await chrome.tabs.update(tab.id,{active:true});
    let windowInfo=null;
    if(Number.isInteger(tab.windowId)){
      try{await chrome.windows.update(tab.windowId,{state:'maximized'});}catch{}
      try{windowInfo=await chrome.windows.update(tab.windowId,{focused:true});}catch{}
    }
    return {action,target_id:tab.id,ok:true,window_id:tab.windowId,window_state:String(windowInfo?.state||''),window_focused:Boolean(windowInfo?.focused)};
  }
  if(action==='close_tab'){await chrome.tabs.remove(tab.id);return {action,target_id:tab.id,ok:true};}
  if(action==='navigate'){const updated=await chrome.tabs.update(tab.id,{url:args.url});return {action,target_id:tab.id,url:updated.url||args.url,title:updated.title||''};}
  if(action==='snapshot'){const [result]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:snapshotPage,args:[Math.max(500,Math.min(50000,args.max_chars||20000))]}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi snapshot.');return {action,target_id:tab.id,...result.result};}
  if(action==='click'){const [result]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:clickPage,args:[args.selector]}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi click.');if(!result.result?.ok)throw new Error(result.result?.error||'Click failed');return {action,target_id:tab.id,selector:args.selector,...result.result};}
  if(action==='type'){const [result]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:typePage,args:[args.selector,String(args.text||'')]}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi nhập text.');if(!result.result?.ok)throw new Error(result.result?.error||'Type failed');return {action,target_id:tab.id,selector:args.selector,...result.result};}
  if(action==='screenshot'){await chrome.tabs.update(tab.id,{active:true});const dataUrl=await promiseWithTimeout(chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'}),DOM_ACTION_TIMEOUT_MS,'Chrome không phản hồi khi chụp màn hình.');return {action,target_id:tab.id,mime_type:'image/png',image_base64:dataUrl.split(',')[1]};}
  if(action==='press'){
    const target={tabId:tab.id};await chrome.debugger.attach(target,'1.3');
    try{const key=String(args.key||'');await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'keyDown',key});await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'keyUp',key});}
    finally{await chrome.debugger.detach(target).catch(()=>{});}return {action,target_id:tab.id,key:args.key,ok:true};
  }
  throw new Error(`Unsupported action: ${action}`);
}

async function postResult(profile,command,result,error) {
  await fetch(`${BRIDGE}/result`,{method:'POST',headers:HEADERS,body:JSON.stringify({profile,command_id:command.id,result,error:error?String(error.message||error):undefined})});
}

async function connectorInfo(profile) {
  const response = await fetch(`${BRIDGE}/connector`, {
    method:'POST',
    headers:HEADERS,
    body:JSON.stringify({profile})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `CodexPro bridge HTTP ${response.status}`);
  if (!payload.connector?.server_url) throw new Error('CodexPro chưa có public MCP URL để thêm vào ChatGPT.');
  return payload.connector;
}

async function waitForTab(tabId, timeoutMs=30000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return current;
  return await new Promise((resolve,reject) => {
    const timer=setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('ChatGPT tải quá lâu.')); },timeoutMs);
    const listener=(updatedId,changeInfo,tab) => {
      if(updatedId!==tabId||changeInfo.status!=='complete')return;
      clearTimeout(timer);chrome.tabs.onUpdated.removeListener(listener);resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function waitForConversationUrl(tabId,timeoutMs=30000) {
  const extract=tab=>{try{return new URL(String(tab?.url||'')).pathname.match(/^\/c\/([A-Za-z0-9-]{8,160})/)?.[1]||'';}catch{return '';}};
  const current=await chrome.tabs.get(tabId);
  const currentId=extract(current);
  if(currentId)return {tab:current,conversationId:currentId};
  return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{chrome.tabs.onUpdated.removeListener(listener);reject(new Error('ChatGPT chưa tạo conversation id sau khi gửi tin đầu tiên.'));},timeoutMs);
    const listener=(updatedId,changeInfo,tab)=>{
      if(updatedId!==tabId)return;
      const conversationId=extract(tab)||(()=>{try{return new URL(String(changeInfo.url||'')).pathname.match(/^\/c\/([A-Za-z0-9-]{8,160})/)?.[1]||'';}catch{return '';}})();
      if(!conversationId)return;
      clearTimeout(timer);chrome.tabs.onUpdated.removeListener(listener);resolve({tab,conversationId});
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function openChatGpt(url) {
  const candidates=await chrome.tabs.query({url:['https://chatgpt.com/*']});
  const tab=candidates[0]
    ? await chrome.tabs.update(candidates[0].id,{url,active:true})
    : await chrome.tabs.create({url,active:true});
  if(tab.windowId)await chrome.windows.update(tab.windowId,{focused:true});
  await waitForTab(tab.id);
  return await chrome.tabs.get(tab.id);
}

async function sendPageMessage(tabId,message,timeoutMs=DOM_ACTION_TIMEOUT_MS) {
  try{return await promiseWithTimeout(chrome.tabs.sendMessage(tabId,message),timeoutMs,'ChatGPT UI không phản hồi message của CodexPro.');}
  catch{
    await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId},files:['connector-installer.js']}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi nạp connector installer.');
    return await promiseWithTimeout(chrome.tabs.sendMessage(tabId,message),timeoutMs,'ChatGPT UI không phản hồi sau khi nạp connector installer.');
  }
}

async function sendInstallerMessage(tabId,connector) {
  return await sendPageMessage(tabId,{type:'codexpro-run-connector-installer',connector},120000);
}

async function installConnector() {
  if(installing)throw new Error('CodexPro đang được thêm trong profile này.');
  installing=true;
  await chrome.action.setBadgeBackgroundColor({color:'#ffb020'});
  await chrome.action.setBadgeText({text:'…'});
  try{
    const profile=await profileInfo();
    const connector=await connectorInfo(profile);
    const tab=await openChatGpt(connector.settings_url || 'https://chatgpt.com/plugins?q=CodexPro');
    const result=await sendInstallerMessage(tab.id,connector);
    if(!result?.ok)throw new Error(result?.error || 'ChatGPT không hoàn tất thêm CodexPro.');
    await chrome.tabs.update(tab.id,{url:'https://chatgpt.com/',active:true});
    await waitForTab(tab.id,45000);
    const testResult=await sendPageMessage(tab.id,{type:'codexpro-run-connection-test'},90000);
    if(!testResult?.ok)throw new Error(testResult?.error || 'Đã thêm CodexPro nhưng chưa gửi được chat kiểm tra.');
    const saved={ok:true,message:testResult.message || 'Đã thêm CodexPro và gửi chat kiểm tra.',at:new Date().toISOString()};
    await chrome.storage.local.set({connectorInstall:saved});
    await chrome.action.setBadgeBackgroundColor({color:'#39d98a'});
    await chrome.action.setBadgeText({text:'OK'});
    return saved;
  }catch(error){
    const saved={ok:false,message:String(error?.message||error),at:new Date().toISOString()};
    await chrome.storage.local.set({connectorInstall:saved});
    await chrome.action.setBadgeBackgroundColor({color:'#e5484d'});
    await chrome.action.setBadgeText({text:'!'});
    throw error;
  }finally{installing=false;}
}

async function checkConnectorInstalled() {
  const profile=await profileInfo();
  const connector=await connectorInfo(profile);
  const tab=await chrome.tabs.create({url:connector.settings_url || 'https://chatgpt.com/plugins?q=CodexPro',active:false});
  try{
    await waitForTab(tab.id);
    const result=await sendPageMessage(tab.id,{type:'codexpro-check-connector'},20000);
    if(!result?.ok)throw new Error(result?.error || 'Không kiểm tra được Apps trong ChatGPT.');
    const saved={
      ok:Boolean(result.installed),
      message:result.installed?'CodexPro đã có trong ChatGPT.':'Profile này chưa thêm CodexPro.',
      at:new Date().toISOString()
    };
    await chrome.storage.local.set({connectorInstall:saved});
    return {ok:true,installed:saved.ok,message:saved.message};
  }finally{
    await chrome.tabs.remove(tab.id).catch(()=>{});
  }
}

async function pollLoop() {
  if(polling)return;polling=true;
  try{
    while(true){
      try{
        const profile=await profileInfo();
        const [tabs,recentConversations]=await Promise.all([tabList(),recentConversationList(3)]);
        const response=await fetch(`${BRIDGE}/poll`,{method:'POST',headers:HEADERS,body:JSON.stringify({profile,active:profile.active,tabs,recent_conversations:recentConversations})});
        if(!response.ok)throw new Error(`Bridge HTTP ${response.status}`);
        const message=await response.json();
        const isActive=message.active_profile_id===profile.id;
        if(profile.active!==isActive)await chrome.storage.local.set({active:isActive});
        if(message.command){try{await postResult(profile,message.command,await execute(message.command));}catch(error){await postResult(profile,message.command,null,error);}}
      }catch{await new Promise(resolve=>setTimeout(resolve,2000));}
    }
  }finally{polling=false;}
}

function ensureBridgeAlarm(){
  chrome.alarms.create('codexpro-bridge',{delayInMinutes:0.1,periodInMinutes:0.5});
}

chrome.runtime.onInstalled.addListener(()=>{
  ensureBridgeAlarm();
  chrome.storage.local.get('codexproReloadTabId').then(async ({codexproReloadTabId})=>{
    if(Number.isInteger(codexproReloadTabId))await chrome.tabs.remove(codexproReloadTabId).catch(()=>{});
    await chrome.storage.local.remove('codexproReloadTabId');
  }).catch(()=>{});
  pollLoop();
});
chrome.runtime.onStartup.addListener(()=>{ensureBridgeAlarm();pollLoop();});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='codexpro-bridge'||alarm.name==='codexpro-reconnect'){ensureBridgeAlarm();pollLoop();}});
chrome.runtime.onMessage.addListener((message,_sender,sendResponse) => {
  if(message?.type!=='codexpro-install-connector')return false;
  installConnector().then(sendResponse).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));
  return true;
});
ensureBridgeAlarm();
pollLoop();
