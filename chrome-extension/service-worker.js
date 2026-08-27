const BRIDGE = 'http://127.0.0.1:9224';
const HEADERS = {'content-type':'application/json','x-codexpro-extension':'profile-bridge-v1'};
const CHAT_REQUEST_STALE_MS = 30 * 60 * 1000;
let polling = false;
let installing = false;
const activeChatRequests = new Map();
const domBusySinceByTab = new Map();
let recentConversationCache = {at:0,items:[]};
const TITLE_OVERRIDE_TTL_MS = 10 * 60 * 1000;
let conversationTitleOverrides = null;

function isChatGenerationRequest(details) {
  if(details.tabId < 0 || details.method !== 'POST')return false;
  try{
    const url=new URL(details.url);
    const path=url.pathname.replace(/\/+$/,'');
    if(url.hostname!=='chatgpt.com')return false;
    const conversationEndpoint=/\/(?:backend-api|backend-anon)\/(?:f\/)?conversation$/.test(path);
    const responsesEndpoint=/\/backend-api\/(?:codex\/)?responses$/.test(path);
    if(!conversationEndpoint&&!responsesEndpoint)return false;
    const raw=Array.isArray(details.requestBody?.raw)
      ? details.requestBody.raw.map(part=>part.bytes?new TextDecoder().decode(part.bytes):'').join('')
      : '';
    if(!raw)return false;
    const payload=JSON.parse(raw);
    if(!payload||typeof payload!=='object')return false;
    const action=String(payload.action||'').toLowerCase();
    const hasGenerationAction=['next','variant','retry'].includes(action);
    const hasMessages=Array.isArray(payload.messages)&&payload.messages.length>0;
    const hasInput=Array.isArray(payload.input)?payload.input.length>0:Boolean(payload.input);
    // ChatGPT may silently POST action=continue to resume an old stream while a
    // completed conversation is open. It is background synchronization, not a
    // new user job, unless that request also carries a new message.
    return conversationEndpoint?(hasMessages||hasGenerationAction):(hasInput||hasMessages);
  }catch{return false;}
}

function beginChatRequest(details) {
  if(!isChatGenerationRequest(details))return;
  activeChatRequests.set(details.requestId,{tabId:details.tabId,startedAt:Date.now()});
}

function finishChatRequest(details) {
  activeChatRequests.delete(details.requestId);
}

function chatRequestState(tabId) {
  const now=Date.now();
  let startedAt=0;
  let count=0;
  for(const [requestId,request] of activeChatRequests){
    if(now-request.startedAt>CHAT_REQUEST_STALE_MS){activeChatRequests.delete(requestId);continue;}
    if(request.tabId===tabId){count+=1;startedAt=startedAt?Math.min(startedAt,request.startedAt):request.startedAt;}
  }
  return {busy:count>0,busy_request_count:count,busy_since:startedAt?new Date(startedAt).toISOString():''};
}

function detectChatBusyPage() {
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  const stopSelectors=['button[data-testid="stop-button"]','button[aria-label*="Stop generating" i]','button[aria-label*="Stop streaming" i]','button[aria-label*="Dừng" i]'];
  if(stopSelectors.some(selector=>visible(document.querySelector(selector))))return {busy:true,settling:false,source:'stop-selector'};
  const composerSubmit=document.querySelector('#composer-submit-button');
  const submitLabel=String(composerSubmit?.innerText||composerSubmit?.textContent||composerSubmit?.getAttribute?.('aria-label')||'').trim();
  if(visible(composerSubmit)&&/(?:stop\s+(?:answering|generating|streaming)|dừng(?:\s+trả\s+lời)?)/i.test(submitLabel))return {busy:true,settling:false,source:'composer-stop'};

  const sections=Array.from(document.querySelectorAll('main section,section[data-testid^="conversation-turn-"],article[data-testid^="conversation-turn-"]')).filter(visible);
  for(let index=sections.length-1;index>=0;index-=1){
    const section=sections[index];
    const buttons=Array.from(section.querySelectorAll('button'));
    const toolActivity=buttons.some(button=>/(?:called tool|worked for|thinking|reasoning)/i.test(String(button.innerText||button.textContent||'').trim()));
    if(!toolActivity)continue;
    const responseNode=section.querySelector('.markdown,.prose,[class*="markdown"]');
    const text=String(responseNode?.innerText||responseNode?.textContent||'').replace(/\u200b/g,'').trim();
    const finalLine=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).at(-1)||'';
    const settling=text.length>0&&text.length<80&&/[,;:–—-]\s*[^.!?…]{1,16}$/u.test(finalLine);
    return {busy:false,settling,source:settling?'tool-final-settling':''};
  }
  return {busy:false,settling:false,source:''};
}

async function domChatState(tabId) {
  try{
    const [injected]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:detectChatBusyPage});
    return {busy:Boolean(injected?.result?.busy),settling:Boolean(injected?.result?.settling),source:String(injected?.result?.source||'')};
  }catch{return {busy:false,settling:false,source:''};}
}

chrome.webRequest.onBeforeRequest.addListener(beginChatRequest,{urls:['https://chatgpt.com/*'],types:['xmlhttprequest','other']},['requestBody']);
chrome.webRequest.onCompleted.addListener(finishChatRequest,{urls:['https://chatgpt.com/*'],types:['xmlhttprequest','other']});
chrome.webRequest.onErrorOccurred.addListener(finishChatRequest,{urls:['https://chatgpt.com/*'],types:['xmlhttprequest','other']});
chrome.webRequest.onBeforeRedirect.addListener(finishChatRequest,{urls:['https://chatgpt.com/*'],types:['xmlhttprequest','other']});
chrome.tabs.onRemoved.addListener(tabId=>{for(const [requestId,request] of activeChatRequests){if(request.tabId===tabId)activeChatRequests.delete(requestId);}domBusySinceByTab.delete(tabId);});

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
    const networkState=chatRequestState(tab.id);
    const isChatGpt=String(tab.url||'').startsWith('https://chatgpt.com/');
    const domState=isChatGpt?await domChatState(tab.id):{busy:false,settling:false,source:''};
    if(domState.busy&&!domBusySinceByTab.has(tab.id))domBusySinceByTab.set(tab.id,Date.now());
    if(!domState.busy)domBusySinceByTab.delete(tab.id);
    const domStartedAt=domBusySinceByTab.get(tab.id)||0;
    const networkStartedAt=networkState.busy_since?Date.parse(networkState.busy_since):0;
    const startedAt=[networkStartedAt,domStartedAt].filter(Boolean).sort((a,b)=>a-b)[0]||0;
    const busy=networkState.busy||domState.busy;
    const conversationId=String(tab.url||'').match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1]||'';
    const titleOverride=conversationId?titleOverrides[conversationId]:null;
    return {
      id:tab.id,
      window_id:tab.windowId,
      active:Boolean(tab.active),
      title:String(titleOverride?.title||tab.title||''),
      url:tab.url || '',
      busy,
      settling:Boolean(domState.settling),
      busy_request_count:networkState.busy_request_count||Number(domState.busy),
      busy_since:busy&&startedAt?new Date(startedAt).toISOString():'',
      busy_source:networkState.busy&&domState.busy?'network+dom':networkState.busy?'network':domState.busy?domState.source||'dom':domState.settling?domState.source||'settling':''
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

async function sendChatRequestPage(text,attachments=[]) {
  const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  if(location.origin!=='https://chatgpt.com'||(!location.pathname.startsWith('/c/')&&location.pathname!=='/'))return {ok:false,error:'Tab đã chọn không phải ChatGPT.'};
  const stopSelectors=['button[data-testid="stop-button"]','button[aria-label*="Stop generating" i]','button[aria-label*="Stop streaming" i]','button[aria-label*="Dừng" i]'];
  const composerSubmit=document.querySelector('#composer-submit-button');
  const composerSubmitLabel=String(composerSubmit?.innerText||composerSubmit?.textContent||composerSubmit?.getAttribute?.('aria-label')||'').trim();
  const composerStopping=visible(composerSubmit)&&/(?:stop\s+(?:answering|generating|streaming)|dừng(?:\s+trả\s+lời)?)/i.test(composerSubmitLabel);
  if(composerStopping||stopSelectors.some(selector=>visible(document.querySelector(selector))))return {ok:false,error:'Đoạn chat đang xử lý yêu cầu khác.'};
  const composerSelectors=['#prompt-textarea','[contenteditable="true"][data-lexical-editor="true"]','textarea[data-id="root"]','textarea[placeholder]'];
  const findComposer=()=>composerSelectors.map(selector=>document.querySelector(selector)).find(element=>visible(element));
  let composer=findComposer();
  if(!composer)return {ok:false,error:'Không tìm thấy ô nhập đang hiển thị trong đoạn chat.'};
  const contentEditableEmpty=Boolean(composer.isContentEditable&&composer.querySelector('[data-empty-paragraph="true"]')&&!Array.from(composer.querySelectorAll('p')).some(node=>!node.hasAttribute('data-empty-paragraph')&&String(node.textContent||'').replace(/[\u200B-\u200D\uFEFF]/g,'').trim()));
  const rawDraft=composer.isContentEditable?String(composer.innerText||''):String(composer.value||'');
  const normalizedDraft=rawDraft.replace(/[\u200B-\u200D\uFEFF]/g,'').trim();
  const placeholder=String(composer.getAttribute?.('data-placeholder')||composer.getAttribute?.('placeholder')||'').trim();
  const draft=contentEditableEmpty||normalizedDraft===placeholder||/^(?:ask|message|chat with)\s+chatgpt[.…]*$/i.test(normalizedDraft)?'':normalizedDraft;
  const retryingSameDraft=Boolean(text&&draft&&draft===text);
  if(draft&&!retryingSameDraft)return {ok:false,error:'Ô ChatGPT đang có một bản nháp khác. Hãy gửi/xóa bản nháp đó trong Chrome rồi thử lại.'};
  const composerRoot=composer.closest('form')||composer.parentElement;
  const existingFileDraft=Boolean(composerRoot?.querySelector('[data-testid="attachment-item"],[data-testid^="file-upload"],button[aria-label*="Remove file" i],button[aria-label*="Remove attachment" i],button[aria-label*="Xóa tệp" i]'))||Array.from(document.querySelectorAll('input[type="file"]')).some(input=>input.files?.length);
  if(existingFileDraft)return {ok:false,error:'Ô chat đang có file chưa gửi; CodexPro không ghi đè bản nháp.'};
  if(attachments.length){
    const candidates=Array.from(document.querySelectorAll('input[type="file"]')).filter(input=>!input.disabled);
    const form=composer.closest('form');
    const fileInput=candidates.find(input=>form?.contains(input))||candidates.find(input=>input.multiple)||candidates[0];
    if(!fileInput)return {ok:false,error:'ChatGPT chưa hiển thị ô nhận file trong đoạn chat này.'};
    const transfer=new DataTransfer();
    try{
      for(const attachment of attachments){
        const binary=atob(attachment.data_base64),bytes=new Uint8Array(binary.length);
        for(let index=0;index<binary.length;index+=1)bytes[index]=binary.charCodeAt(index);
        transfer.items.add(new File([bytes],attachment.name,{type:attachment.mime_type||'application/octet-stream',lastModified:Date.now()}));
      }
      fileInput.files=transfer.files;
      fileInput.dispatchEvent(new Event('input',{bubbles:true}));
      fileInput.dispatchEvent(new Event('change',{bubbles:true}));
    }catch(error){return {ok:false,error:`Không thể gắn file: ${error?.message||error}`};}
    await sleep(500);
    composer=findComposer();
    if(!composer)return {ok:false,error:'Ô nhập ChatGPT đang hiển thị biến mất sau khi gắn file.'};
  }
  if(text&&!retryingSameDraft){
    composer.scrollIntoView({block:'center',inline:'center'});composer.focus();
    if(composer.isContentEditable){
      if(composer.querySelector('[data-inline-selection-pill]')){
        const selection=window.getSelection(),range=document.createRange(),paragraph=composer.querySelector('p:last-child')||composer;
        range.selectNodeContents(paragraph);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
        document.execCommand('insertText',false,` ${text}`);
      }else composer.textContent=text;
    }else{const proto=composer instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(composer,text);else composer.value=text;}
    composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
    composer.dispatchEvent(new Event('change',{bubbles:true}));
  }
  let send;
  for(let attempt=0;attempt<(attachments.length?900:40);attempt+=1){
    send=['#composer-submit-button','button[data-testid="send-button"]','button[aria-label*="Send" i]','button[aria-label*="Gửi" i]'].map(selector=>document.querySelector(selector)).find(element=>{
      if(!visible(element)||element.disabled)return false;
      const label=String(element.innerText||element.textContent||element.getAttribute?.('aria-label')||'').trim();
      return !/(?:stop\s+(?:answering|generating|streaming)|dừng(?:\s+trả\s+lời)?)/i.test(label);
    });
    if(send)break;
    await sleep(100);
  }
  if(!send)return {ok:false,error:attachments.length?'ChatGPT chưa tải file xong hoặc không chấp nhận định dạng file này.':'Đã nhập yêu cầu nhưng nút gửi chưa sẵn sàng.'};
  send.click();
  return {ok:true,title:document.title,url:location.href,length:text.length,attachment_count:attachments.length,attachment_names:attachments.map(file=>file.name)};
}

async function readChatResponsePage() {
  const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
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
    return String(clone.textContent||'')
      .replace(/\u200b/g,'')
      .replace(/[ \t]+\n/g,'\n')
      .replace(/\n{3,}/g,'\n\n')
      .trim();
  };
  if(!location.pathname.startsWith('/c/'))return {ok:false,error:'Tab đã chọn không phải đoạn chat ChatGPT.'};
  let messageNodes=[];
  for(let attempt=0;attempt<80;attempt+=1){
    messageNodes=Array.from(document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]'));
    if(messageNodes.length||document.querySelector('#prompt-textarea'))break;
    await sleep(100);
  }
  const allMessages=messageNodes.map((message,index)=>{
    const role=message.getAttribute('data-message-author-role')==='user'?'user':'assistant';
    const content=role==='assistant'
      ? message.querySelector('.markdown,.prose,[class*="markdown"]')||message
      : message.querySelector('.whitespace-pre-wrap,[class*="whitespace-pre-wrap"],[data-message-content]')||message;
    const raw=role==='assistant'?structuredText(content):nodeText(content);
    const text=raw.slice(0,40000);
    return raw?{id:`${role}-${index}`,role,text,truncated:raw.length>text.length}:null;
  }).filter(Boolean);
  const messages=allMessages.slice(-20);
  const latestAssistant=[...allMessages].reverse().find(message=>message.role==='assistant');
  const stopSelectors=['button[data-testid="stop-button"]','button[aria-label*="Stop generating" i]','button[aria-label*="Stop streaming" i]','button[aria-label*="Dừng" i]'];
  const composerSubmit=document.querySelector('#composer-submit-button');
  const composerSubmitLabel=nodeText(composerSubmit)||String(composerSubmit?.getAttribute?.('aria-label')||'').trim();
  const composerStopping=visible(composerSubmit)&&/(?:stop\s+(?:answering|generating|streaming)|dừng(?:\s+trả\s+lời)?)/i.test(composerSubmitLabel);
  const busy=composerStopping||stopSelectors.some(selector=>visible(document.querySelector(selector)));

  const sections=Array.from(document.querySelectorAll('main section,section[data-testid^="conversation-turn-"],article[data-testid^="conversation-turn-"]')).filter(visible);
  const assistantSections=sections.filter(section=>{
    if(section.querySelector('[data-message-author-role="assistant"]'))return true;
    if(section.querySelector('button[aria-label="Copy response" i],button[aria-label*="Rate response" i]'))return true;
    return Array.from(section.querySelectorAll('button')).some(button=>/(?:called tool|worked for|thinking|reasoning)/i.test(nodeText(button)));
  });
  const cleanSectionText=raw=>String(raw||'')
    .replace(/\s*ChatGPT can make mistakes[\s\S]*$/i,'')
    .replace(/^\s*ChatGPT said:\s*/i,'')
    .split(/\r?\n/)
    .filter(line=>!/^\s*(?:Worked for\s+.+|Called tool|Thinking|Reasoning)\s*$/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
  let sectionText='';
  let sectionTruncated=false;
  let selectedSectionHadToolActivity=false;
  for(let index=assistantSections.length-1;index>=0&&!sectionText;index-=1){
    const section=assistantSections[index];
    const toolActivity=Array.from(section.querySelectorAll('button')).some(button=>/(?:called tool|worked for|thinking|reasoning)/i.test(nodeText(button)));
    const rawChunks=Array.from(section.querySelectorAll('.markdown,.prose,[class*="markdown"]'))
      .filter(visible)
      .map(node=>structuredText(node))
      .filter(Boolean);
    const chunks=[];
    for(const chunk of rawChunks){if(!chunks.includes(chunk)&&!chunks.some(existing=>existing.includes(chunk)))chunks.push(chunk);}
    let raw=cleanSectionText(chunks.join('\n\n'));
    if(!raw){
      const clone=section.cloneNode(true);
      clone.querySelectorAll('button,[role="group"],input,textarea,select,svg,img,[data-message-author-role="user"],[aria-label*="User uploaded image" i]').forEach(node=>node.remove());
      raw=cleanSectionText(clone.textContent||'');
    }
    if(!raw)continue;
    sectionText=raw.slice(0,40000);
    sectionTruncated=raw.length>sectionText.length;
    selectedSectionHadToolActivity=toolActivity;
  }

  const text=sectionText||(latestAssistant?.text||'');
  const truncated=sectionText?sectionTruncated:Boolean(latestAssistant?.truncated);
  const finalLine=String(text||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).at(-1)||'';
  const incomplete=!busy&&selectedSectionHadToolActivity&&text.length>0&&text.length<80&&/[,;:–—-]\s*[^.!?…]{1,16}$/u.test(finalLine);
  return {ok:true,title:document.title,url:location.href,text,text_length:text.length,truncated,incomplete,incomplete_reason:incomplete?'tool_final_cut_off':'',message_count:allMessages.filter(message=>message.role==='assistant').length,total_message_count:allMessages.length,messages,busy,updated_at:new Date().toISOString()};
}

async function targetTab(args) {
  const targetId=Number(args.target_id);
  if (Number.isInteger(targetId)&&targetId>=0) return await chrome.tabs.get(targetId);
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id) throw new Error('No active Chrome tab.');
  return tab;
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
        ? conversations.find(candidate=>{try{return new URL(candidate.url).pathname===`/c/${conversationId}`;}catch{return false;}})
        : Number.isInteger(requestedId)
          ? conversations.find(candidate=>candidate.id===requestedId)
          : conversations.find(candidate=>candidate.active)||conversations[0];
    if(newChat){await waitForTab(tab.id,45000);tab=await chrome.tabs.get(tab.id);}
    if(!tab&&conversationId){
      const recent=await recentConversationList(3);
      if(!recent.some(conversation=>conversation.id===conversationId))throw new Error('Đoạn chat không còn thuộc 3 chat gần nhất của profile này.');
      tab=await chrome.tabs.create({url:`https://chatgpt.com/c/${conversationId}`,active:false});await waitForTab(tab.id,45000);tab=await chrome.tabs.get(tab.id);
    }
    if(!tab?.id)throw new Error('Profile này không có đoạn chat dự án đang mở.');
    if(chatRequestState(tab.id).busy)throw new Error('Đoạn chat đang xử lý yêu cầu khác.');
    const [injected]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:sendChatRequestPage,args:[text,attachments]});
    if(!injected.result?.ok){if(newChat)await chrome.tabs.remove(tab.id).catch(()=>{});throw new Error(injected.result?.error||'Không gửi được yêu cầu vào ChatGPT.');}
    if(newChat){
      const created=await waitForConversationUrl(tab.id,45000);
      recentConversationCache={at:0,items:[]};
      return {action,target_id:tab.id,conversation_id:created.conversationId,new_chat:true,...injected.result};
    }
    return {action,target_id:tab.id,conversation_id:conversationId,...injected.result};
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
    const [injected]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:readChatResponsePage});
    if(!injected.result?.ok)throw new Error(injected.result?.error||'Không đọc được phản hồi ChatGPT.');
    return {action,target_id:tab.id,...injected.result};
  }
  if(action==='open_tab'){const tab=await chrome.tabs.create({url:args.url,active:true});return {action,target_id:tab.id,title:tab.title||'',url:tab.url||args.url};}
  const tab=await targetTab(args);
  if(action==='activate_tab'){await chrome.tabs.update(tab.id,{active:true});if(tab.windowId)await chrome.windows.update(tab.windowId,{focused:true});return {action,target_id:tab.id,ok:true};}
  if(action==='close_tab'){await chrome.tabs.remove(tab.id);return {action,target_id:tab.id,ok:true};}
  if(action==='navigate'){const updated=await chrome.tabs.update(tab.id,{url:args.url});return {action,target_id:tab.id,url:updated.url||args.url,title:updated.title||''};}
  if(action==='snapshot'){const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:snapshotPage,args:[Math.max(500,Math.min(50000,args.max_chars||20000))]});return {action,target_id:tab.id,...result.result};}
  if(action==='click'){const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:clickPage,args:[args.selector]});if(!result.result?.ok)throw new Error(result.result?.error||'Click failed');return {action,target_id:tab.id,selector:args.selector,...result.result};}
  if(action==='type'){const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:typePage,args:[args.selector,String(args.text||'')]});if(!result.result?.ok)throw new Error(result.result?.error||'Type failed');return {action,target_id:tab.id,selector:args.selector,...result.result};}
  if(action==='screenshot'){await chrome.tabs.update(tab.id,{active:true});const dataUrl=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});return {action,target_id:tab.id,mime_type:'image/png',image_base64:dataUrl.split(',')[1]};}
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

async function sendPageMessage(tabId,message) {
  await chrome.scripting.executeScript({target:{tabId},files:['connector-installer.js']}).catch(()=>{});
  return await chrome.tabs.sendMessage(tabId,message);
}

async function sendInstallerMessage(tabId,connector) {
  return await sendPageMessage(tabId,{type:'codexpro-run-connector-installer',connector});
}

async function installConnector() {
  if(installing)throw new Error('CodexPro đang được thêm trong profile này.');
  installing=true;
  await chrome.action.setBadgeBackgroundColor({color:'#ffb020'});
  await chrome.action.setBadgeText({text:'…'});
  try{
    const profile=await profileInfo();
    const connector=await connectorInfo(profile);
    const settingsUrl=connector.settings_url || 'https://chatgpt.com/plugins?q=CodexPro';
    const tab=await openChatGpt(settingsUrl);
    const result=await sendInstallerMessage(tab.id,connector);
    if(!result?.ok)throw new Error(result?.error || 'ChatGPT không hoàn tất thêm CodexPro.');
    await chrome.tabs.update(tab.id,{url:settingsUrl,active:true});
    await waitForTab(tab.id,45000);
    const opened=await sendPageMessage(tab.id,{type:'codexpro-open-installed-connector'});
    if(!opened?.ok)throw new Error(opened?.error || 'Không mở được CodexPro sau khi cài.');
    if(opened.href){
      await chrome.tabs.update(tab.id,{url:opened.href,active:true});
      await waitForTab(tab.id,45000);
    }else{
      await new Promise(resolve=>setTimeout(resolve,1800));
      await waitForTab(tab.id,45000);
    }
    const chatLaunch=await sendPageMessage(tab.id,{type:'codexpro-open-connector-chat'});
    if(!chatLaunch?.ok)throw new Error(chatLaunch?.error || 'Không mở được CodexPro trong đoạn chat.');
    if(chatLaunch.href){
      await chrome.tabs.update(tab.id,{url:chatLaunch.href,active:true});
      await waitForTab(tab.id,45000);
    }else{
      await new Promise(resolve=>setTimeout(resolve,1800));
      await waitForTab(tab.id,45000);
    }
    const testResult=await sendPageMessage(tab.id,{type:'codexpro-run-connection-test'});
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
    const result=await sendPageMessage(tab.id,{type:'codexpro-check-connector'});
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
