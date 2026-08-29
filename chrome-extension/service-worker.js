const BRIDGE = 'http://127.0.0.1:9224';
const HEADERS = {'content-type':'application/json','x-codexpro-extension':'profile-bridge-v1'};
const CHAT_REQUEST_STALE_MS = 30 * 60 * 1000;
const CHAT_NETWORK_STATE_KEY = 'codexproChatNetworkStateV1';
const CHAT_ATTACHMENT_OWNERSHIP_KEY = 'codexproChatAttachmentOwnershipV1';
const CHAT_ATTACHMENT_OWNERSHIP_TTL_MS = 30 * 60 * 1000;
const DOM_READ_TIMEOUT_MS = 2500;
const DOM_ACTIVITY_PROBE_TIMEOUT_MS = 800;
const DOM_ACTIVITY_PROBE_CACHE_MS = 5000;
const DOM_ACTIVITY_RECENT_NETWORK_MS = 2*60*1000;
const CANONICAL_READ_TIMEOUT_MS = 15000;
const DOM_ACTION_TIMEOUT_MS = 5000;
const SCREENSHOT_TIMEOUT_MS = 15000;
const TRUSTED_INPUT_TIMEOUT_MS = 10000;
const DOM_PREPARE_TIMEOUT_MS = 15000;
const ATTACHMENT_PREPARE_TIMEOUT_MS = 60000;
const NETWORK_START_TIMEOUT_MS = 30000;
const CDP_NETWORK_START_TIMEOUT_MS = 15000;
const CDP_NETWORK_TRACKER_MAX_MS = 30 * 60 * 1000;
const CANONICAL_COMPLETION_PROBE_MS = 30000;
const CANONICAL_COMPLETION_PROBE_AFTER_MS = 60000;
const DEBUGGER_SESSION_IDLE_MS = 30000;
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 30000;
const ATTACHMENT_UPLOAD_QUIET_FALLBACK_MS = 12000;
const CONVERSATION_LIMIT_PROBE_TIMEOUT_MS = 1500;
const PENDING_CONVERSATION_TTL_MS = 60 * 1000;
let polling = false;
let installing = false;
const chatNetworkStateByTab = new Map();
const chatNetworkPostLogByTab = new Map();
const chatNetworkPostVersionByTab = new Map();
const chatNetworkPostWaitersByTab = new Map();
const chatNetworkWaitersByTab = new Map();
const cdpNetworkTrackersByTab = new Map();
const debuggerSessionsByTab = new Map();
const debuggerEventSubscribersByTab = new Map();
const browserMutationTailsByTab = new Map();
const canonicalCompletionProbeAtByTab = new Map();
const pendingConversationByTab = new Map();
const chatAttachmentOwnershipByTab = new Map();
const chatDomActivityByTab = new Map();
let chatNetworkStateLoaded = false;
let chatNetworkStateLoadPromise = null;
let chatAttachmentOwnershipLoaded = false;
let chatAttachmentOwnershipLoadPromise = null;
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
    if(url.hostname!=='chatgpt.com'&&!url.hostname.endsWith('.chatgpt.com'))return false;
    return /\/(?:backend-api|backend-anon)\/(?:f\/)?(?:conversation|steer_turn)$/.test(path)
      || /\/backend-api\/(?:f\/)?(?:codex\/)?responses$/.test(path);
  }catch{return false;}
}

function safeChatRequestEndpoint(value) {
  try{
    const url=new URL(String(value||''));
    if(url.hostname!=='chatgpt.com'&&!url.hostname.endsWith('.chatgpt.com'))return '';
    return url.pathname.replace(/\/+$/,'')||'/';
  }catch{return '';}
}

function attributedChatRequestDetails(details) {
  if(details.tabId>=0)return details;
  const endpoint=safeChatRequestEndpoint(details.url);
  if(!endpoint)return details;
  const tracked=[...chatNetworkStateByTab.entries()].find(([,state])=>state?.request_id&&String(state.request_id)===String(details.requestId||''));
  if(tracked)return {...details,tabId:tracked[0]};
  const pending=[...pendingConversationByTab.entries()].filter(([,value])=>Date.now()-Number(value?.at||0)<PENDING_CONVERSATION_TTL_MS);
  if(pending.length===1)return {...details,tabId:pending[0][0]};
  return details;
}

function recordChatPost(details,phase,statusCode=0,error='') {
  if(details.tabId<0||details.method!=='POST')return;
  const endpoint=safeChatRequestEndpoint(details.url);
  if(!endpoint)return;
  const current=chatNetworkPostLogByTab.get(details.tabId)||[];
  const entry={
    request_id:String(details.requestId||''),
    endpoint,
    resource_type:String(details.type||''),
    phase:String(phase||''),
    matched_generation:isChatGenerationRequest(details),
    status_code:Number(statusCode)||0,
    error:String(error||'').slice(0,200),
    observed_at_ms:Date.now()
  };
  const index=current.findIndex(item=>item.request_id&&item.request_id===entry.request_id);
  if(index>=0)current[index]={...current[index],...entry};
  else current.push(entry);
  chatNetworkPostLogByTab.set(details.tabId,current.slice(-60));
  chatNetworkPostVersionByTab.set(details.tabId,(chatNetworkPostVersionByTab.get(details.tabId)||0)+1);
  const waiters=chatNetworkPostWaitersByTab.get(details.tabId);
  if(waiters?.size){for(const waiter of [...waiters]){waiters.delete(waiter);clearTimeout(waiter.timer);waiter.resolve();}chatNetworkPostWaitersByTab.delete(details.tabId);}
}

function recentChatPostEvidence(tabId,startedAfterMs=0) {
  return (chatNetworkPostLogByTab.get(tabId)||[])
    .filter(item=>Number(item.observed_at_ms||0)>=Number(startedAfterMs||0))
    .map(item=>({
      endpoint:item.endpoint,
      resource_type:item.resource_type,
      phase:item.phase,
      matched_generation:Boolean(item.matched_generation),
      status_code:Number(item.status_code)||0,
      error:item.error,
      observed_at:new Date(item.observed_at_ms).toISOString()
    }));
}

function networkGenerationStartedAfter(tabId,startedAfterMs) {
  const current=chatNetworkStateByTab.get(tabId);
  return Boolean(current&&Number(current.started_at_ms||0)>=Number(startedAfterMs||0)&&['generating','completed','failed'].includes(String(current.state||'')));
}

function notifyChatNetworkWaiters(tabId) {
  const waiters=chatNetworkWaitersByTab.get(tabId);
  if(!waiters?.size||!networkGenerationStartedAfter(tabId,Math.min(...[...waiters].map(waiter=>waiter.startedAfterMs))))return;
  for(const waiter of [...waiters]){
    if(!networkGenerationStartedAfter(tabId,waiter.startedAfterMs))continue;
    waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(chatRequestState(tabId,String(chatNetworkStateByTab.get(tabId)?.conversation_id||'')));
  }
  if(!waiters.size)chatNetworkWaitersByTab.delete(tabId);
}

function rejectChatNetworkWaiters(tabId,error) {
  const waiters=chatNetworkWaitersByTab.get(tabId);
  if(!waiters)return;
  chatNetworkWaitersByTab.delete(tabId);
  for(const waiter of waiters){clearTimeout(waiter.timer);waiter.reject(error);}
}

function isChatSubmitLifecycleEvidence(item) {
  const endpoint=String(item?.endpoint||'');
  return Boolean(item?.matched_generation)||/\/(?:backend-api|backend-anon)\/(?:sentinel\/|(?:f\/)?(?:conversation|steer_turn)|(?:f\/)?(?:codex\/)?responses)/.test(endpoint);
}

function isAttachmentUploadEndpoint(endpoint) {
  return /\/backend-api\/files(?:\/|$)/.test(String(endpoint||''));
}

async function waitForAttachmentUploadNetwork(tabId,startedAfterMs,timeoutMs=ATTACHMENT_UPLOAD_TIMEOUT_MS) {
  const deadline=Date.now()+timeoutMs;
  const waitForChange=async waitMs=>await new Promise((resolve,reject)=>{
    const waiter={resolve,reject,timer:null};
    waiter.timer=setTimeout(()=>{const waiters=chatNetworkPostWaitersByTab.get(tabId);waiters?.delete(waiter);if(waiters&&!waiters.size)chatNetworkPostWaitersByTab.delete(tabId);resolve();},Math.max(1,waitMs));
    const waiters=chatNetworkPostWaitersByTab.get(tabId)||new Set();waiters.add(waiter);chatNetworkPostWaitersByTab.set(tabId,waiters);
  });
  while(Date.now()<deadline){
    const uploads=(chatNetworkPostLogByTab.get(tabId)||[]).filter(item=>Number(item.observed_at_ms||0)>=Number(startedAfterMs||0)&&isAttachmentUploadEndpoint(item.endpoint));
    const failed=uploads.find(item=>item.phase==='failed'||Number(item.status_code)>=400);
    if(failed)throw new Error(`ChatGPT upload file thất bại tại ${failed.endpoint}: ${failed.error||`HTTP ${failed.status_code}`}`);
    const processingSeen=uploads.some(item=>/\/process_upload_stream$/.test(item.endpoint));
    const processingComplete=uploads.some(item=>/\/process_upload_stream$/.test(item.endpoint)&&item.phase==='completed'&&Number(item.status_code)>0&&Number(item.status_code)<400);
    if(processingComplete)return {acknowledged:true,endpoint:'/backend-api/files/process_upload_stream',fallback:false};
    const baseCompleted=[...uploads].reverse().find(item=>item.endpoint==='/backend-api/files'&&item.phase==='completed'&&Number(item.status_code)>0&&Number(item.status_code)<400);
    const quietRemaining=baseCompleted&&!processingSeen?Math.max(0,ATTACHMENT_UPLOAD_QUIET_FALLBACK_MS-(Date.now()-Number(baseCompleted.observed_at_ms||0))):null;
    if(quietRemaining===0){
      return {acknowledged:true,endpoint:'/backend-api/files',fallback:true};
    }
    await waitForChange(Math.min(deadline-Date.now(),quietRemaining===null?deadline-Date.now():quietRemaining));
  }
  throw new Error('ChatGPT chưa hoàn tất upload file trong thời gian cho phép; chưa submit để tránh gửi thiếu attachment.');
}

function shouldUseTrustedClickFallback(attemptState,evidence=[]) {
  return Boolean(attemptState?.draft_owned&&attemptState?.draft_present&&!evidence.some(isChatSubmitLifecycleEvidence));
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
      generation_endpoint:safeChatRequestEndpoint(details.url),
      status_code:0,
      error:''
    });
    notifyChatNetworkWaiters(details.tabId);
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
      generation_endpoint:String(current?.generation_endpoint||safeChatRequestEndpoint(details.url)||''),
      status_code:statusCode,
      error:failed?String(details.error||`HTTP ${statusCode||'error'}`).slice(0,300):''
    });
    notifyChatNetworkWaiters(details.tabId);
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
  if(!current)return {busy:false,busy_request_count:0,busy_since:'',network_state:'idle',network_source:'',network_generation_endpoint:'',network_last_started_at:'',network_last_completed_at:'',network_status_code:0,network_error:'',network_duration_ms:0};
  const at=Number(current.completed_at_ms||current.started_at_ms||0);
  if(!at||now-at>CHAT_REQUEST_STALE_MS){chatNetworkStateByTab.delete(tabId);void persistChatNetworkState();return {busy:false,busy_request_count:0,busy_since:'',network_state:'idle',network_source:'',network_generation_endpoint:'',network_last_started_at:'',network_last_completed_at:'',network_status_code:0,network_error:'',network_duration_ms:0};}
  if(conversationId&&current.conversation_id&&current.conversation_id!==conversationId)return {busy:false,busy_request_count:0,busy_since:'',network_state:'idle',network_source:'',network_generation_endpoint:'',network_last_started_at:'',network_last_completed_at:'',network_status_code:0,network_error:'',network_duration_ms:0};
  const busy=current.state==='generating';
  return {
    busy,
    busy_request_count:busy?1:0,
    busy_since:busy&&current.started_at_ms?new Date(current.started_at_ms).toISOString():'',
    network_state:String(current.state||'idle'),
    network_source:String(current.source||''),
    network_generation_endpoint:String(current.generation_endpoint||''),
    network_last_started_at:current.started_at_ms?new Date(current.started_at_ms).toISOString():'',
    network_last_completed_at:current.completed_at_ms?new Date(current.completed_at_ms).toISOString():'',
    network_status_code:Number(current.status_code)||0,
    network_error:String(current.error||''),
    network_duration_ms:current.completed_at_ms&&current.started_at_ms?Math.max(0,Number(current.completed_at_ms)-Number(current.started_at_ms)):0
  };
}

async function waitForNetworkGeneration(tabId,startedAfterMs,timeoutMs=NETWORK_START_TIMEOUT_MS) {
  await ensureChatNetworkStateLoaded();
  if(networkGenerationStartedAfter(tabId,startedAfterMs))return await chatRequestState(tabId,String(chatNetworkStateByTab.get(tabId)?.conversation_id||''));
  return await new Promise((resolve,reject)=>{
    const waiter={startedAfterMs:Number(startedAfterMs)||0,resolve,reject,timer:null};
    waiter.timer=setTimeout(()=>{
      const waiters=chatNetworkWaitersByTab.get(tabId);
      waiters?.delete(waiter);
      if(waiters&&!waiters.size)chatNetworkWaitersByTab.delete(tabId);
      reject(new Error('Không thấy request generation của ChatGPT sau khi bấm gửi.'));
    },Math.max(100,Number(timeoutMs)||NETWORK_START_TIMEOUT_MS));
    const waiters=chatNetworkWaitersByTab.get(tabId)||new Set();
    waiters.add(waiter);
    chatNetworkWaitersByTab.set(tabId,waiters);
    notifyChatNetworkWaiters(tabId);
  });
}

let realtimeProfilePushTimer=null;
let domActivityRefreshTimer=null;
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

async function ensureChatAttachmentOwnershipLoaded() {
  if(chatAttachmentOwnershipLoaded)return;
  if(chatAttachmentOwnershipLoadPromise)return await chatAttachmentOwnershipLoadPromise;
  chatAttachmentOwnershipLoadPromise=(async()=>{
    try{
      const stored=await chrome.storage.local.get(CHAT_ATTACHMENT_OWNERSHIP_KEY);
      const raw=stored[CHAT_ATTACHMENT_OWNERSHIP_KEY]&&typeof stored[CHAT_ATTACHMENT_OWNERSHIP_KEY]==='object'?stored[CHAT_ATTACHMENT_OWNERSHIP_KEY]:{};
      const now=Date.now();
      for(const [tabId,value] of Object.entries(raw)){
        if(!value||typeof value!=='object'||now-Number(value.at||0)>CHAT_ATTACHMENT_OWNERSHIP_TTL_MS)continue;
        chatAttachmentOwnershipByTab.set(Number(tabId),value);
      }
    }catch{}
    chatAttachmentOwnershipLoaded=true;
    chatAttachmentOwnershipLoadPromise=null;
  })();
  await chatAttachmentOwnershipLoadPromise;
}

async function persistChatAttachmentOwnership() {
  try{
    const now=Date.now();
    const entries=[...chatAttachmentOwnershipByTab.entries()]
      .filter(([,value])=>now-Number(value?.at||0)<=CHAT_ATTACHMENT_OWNERSHIP_TTL_MS)
      .slice(-30);
    await chrome.storage.local.set({[CHAT_ATTACHMENT_OWNERSHIP_KEY]:Object.fromEntries(entries.map(([tabId,value])=>[String(tabId),value]))});
  }catch{}
}

async function chatAttachmentOwnership(tabId,conversationId='') {
  await ensureChatAttachmentOwnershipLoaded();
  const ownership=chatAttachmentOwnershipByTab.get(tabId);
  if(!ownership)return null;
  if(Date.now()-Number(ownership.at||0)>CHAT_ATTACHMENT_OWNERSHIP_TTL_MS){chatAttachmentOwnershipByTab.delete(tabId);await persistChatAttachmentOwnership();return null;}
  const ownedConversation=String(ownership.conversation_id||'');
  if(ownedConversation&&conversationId&&ownedConversation!==conversationId)return null;
  return ownership;
}

async function rememberChatAttachmentOwnership(tabId,conversationId,attemptId,names,labels=[]) {
  await ensureChatAttachmentOwnershipLoaded();
  chatAttachmentOwnershipByTab.set(tabId,{conversation_id:String(conversationId||''),attempt_id:String(attemptId||''),names:(Array.isArray(names)?names:[]).map(String).filter(Boolean).slice(0,4),labels:(Array.isArray(labels)?labels:[]).map(String).filter(Boolean).slice(0,4),at:Date.now()});
  await persistChatAttachmentOwnership();
}

async function clearChatAttachmentOwnership(tabId,attemptId='') {
  await ensureChatAttachmentOwnershipLoaded();
  const current=chatAttachmentOwnershipByTab.get(tabId);
  if(!current||attemptId&&String(current.attempt_id||'')!==String(attemptId))return false;
  chatAttachmentOwnershipByTab.delete(tabId);
  await persistChatAttachmentOwnership();
  return true;
}

function scheduleDomActivityRefresh(delayMs=1000) {
  if(domActivityRefreshTimer)return;
  domActivityRefreshTimer=setTimeout(()=>{
    domActivityRefreshTimer=null;
    scheduleRealtimeProfilePush(0);
  },delayMs);
}

const CHATGPT_REQUEST_FILTER={urls:['https://chatgpt.com/*','https://*.chatgpt.com/*']};
chrome.webRequest.onBeforeRequest.addListener(details=>{const attributed=attributedChatRequestDetails(details);recordChatPost(attributed,'started');beginChatRequest(attributed);},CHATGPT_REQUEST_FILTER);
chrome.webRequest.onCompleted.addListener(details=>{const attributed=attributedChatRequestDetails(details);recordChatPost(attributed,'completed',details.statusCode);finishChatRequest(attributed,'completed');},CHATGPT_REQUEST_FILTER);
chrome.webRequest.onErrorOccurred.addListener(details=>{const attributed=attributedChatRequestDetails(details);recordChatPost(attributed,'failed',0,details.error);finishChatRequest(attributed,'failed');},CHATGPT_REQUEST_FILTER);
chrome.webRequest.onBeforeRedirect.addListener(details=>{const attributed=attributedChatRequestDetails(details);recordChatPost(attributed,'redirected',details.statusCode);finishChatRequest(attributed,'completed');},CHATGPT_REQUEST_FILTER);
chrome.tabs.onRemoved.addListener(tabId=>{pendingConversationByTab.delete(tabId);void clearChatAttachmentOwnership(tabId);chatDomActivityByTab.delete(tabId);chatNetworkPostLogByTab.delete(tabId);chatNetworkPostVersionByTab.delete(tabId);canonicalCompletionProbeAtByTab.delete(tabId);const postWaiters=chatNetworkPostWaitersByTab.get(tabId);if(postWaiters){chatNetworkPostWaitersByTab.delete(tabId);for(const waiter of postWaiters){clearTimeout(waiter.timer);waiter.reject(new Error('Tab ChatGPT đã đóng trong lúc chờ upload network.'));}}rejectChatNetworkWaiters(tabId,new Error('Tab ChatGPT đã đóng trong lúc chờ network ACK.'));const tracker=cdpNetworkTrackersByTab.get(tabId);if(tracker)void tracker.cleanup();const session=debuggerSessionsByTab.get(tabId);if(session?.detachTimer)clearTimeout(session.detachTimer);debuggerSessionsByTab.delete(tabId);debuggerEventSubscribersByTab.delete(tabId);browserMutationTailsByTab.delete(tabId);void (async()=>{await ensureChatNetworkStateLoaded();chatNetworkStateByTab.delete(tabId);await persistChatNetworkState();})();});

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

function probeChatActivityPage() {
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  const stopControl=Array.from(document.querySelectorAll('button,[role="button"]')).find(control=>{
    if(!visible(control))return false;
    const testId=String(control.getAttribute?.('data-testid')||'').trim();
    if(testId==='stop-button')return true;
    const label=String(control.getAttribute?.('aria-label')||control.innerText||control.textContent||'').trim();
    return /^(?:stop(?: answering| generating| streaming)?|dừng(?: trả lời)?)$/i.test(label);
  });
  const assistantNodes=Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  const latestText=String(assistantNodes.at(-1)?.innerText||assistantNodes.at(-1)?.textContent||'').replace(/\u200b/g,'').trim();
  const thinkingPlaceholder=/(?:^|\n)(?:thinking|đang suy nghĩ)(?:\s*[.…]{1,3})?$/i.test(latestText);
  const activityLines=latestText.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!/^(?:called tool|thinking|đang suy nghĩ|chatgpt can make mistakes)/i.test(line));
  const activityText=String(activityLines.at(-1)||'').slice(0,220);
  return {busy:Boolean(stopControl||thinkingPlaceholder),source:stopControl?'dom_stop':thinkingPlaceholder?'dom_thinking':'',activity_text:activityText,observed_at:Date.now()};
}

async function chatDomActivityState(tabId,conversationId,options={}) {
  if(!Number.isInteger(tabId)||!conversationId)return {available:false,busy:false,source:'',activity_text:''};
  const now=Date.now();
  const fresh=options?.fresh===true;
  let cached=chatDomActivityByTab.get(tabId);
  if(cached?.promise){
    const pendingValue=await cached.promise;
    if(!fresh)return pendingValue;
    cached=chatDomActivityByTab.get(tabId);
  }
  if(!fresh&&cached?.value&&now-Number(cached.at||0)<DOM_ACTIVITY_PROBE_CACHE_MS)return cached.value;
  const promise=(async()=>{
    try{
      const [injected]=await promiseWithTimeout(
        chrome.scripting.executeScript({target:{tabId},func:probeChatActivityPage}),
        DOM_ACTIVITY_PROBE_TIMEOUT_MS,
        'Chrome renderer không phản hồi khi kiểm tra trạng thái ChatGPT.'
      );
      const result=injected?.result&&typeof injected.result==='object'?injected.result:{};
      return {available:true,busy:Boolean(result.busy),source:String(result.source||''),activity_text:String(result.activity_text||'').trim().slice(0,220),observed_at:Number(result.observed_at)||Date.now()};
    }catch(error){return {available:false,busy:false,source:'',activity_text:'',error:String(error?.message||error).slice(0,300)};}
  })();
  chatDomActivityByTab.set(tabId,{at:Number(cached?.at)||0,value:cached?.value||null,promise});
  const value=await promise;
  chatDomActivityByTab.set(tabId,{at:Date.now(),value,promise:null});
  return value;
}

async function tabList() {
  const tabs = await chrome.tabs.query({});
  const liveTabIds=new Set(tabs.map(tab=>tab.id).filter(Number.isInteger));
  for(const tabId of chatDomActivityByTab.keys())if(!liveTabIds.has(tabId))chatDomActivityByTab.delete(tabId);
  const titleOverrides=await getConversationTitleOverrides();
  const summaries=await Promise.all(tabs.map(async tab => {
    const conversationId=conversationIdFromUrl(tab.url);
    const networkState=await chatRequestState(tab.id,conversationId);
    const cachedDomActivity=chatDomActivityByTab.get(tab.id)?.value;
    const networkObservedAt=Math.max(Date.parse(networkState.network_last_started_at||'')||0,Date.parse(networkState.network_last_completed_at||'')||0);
    const shouldProbeDom=Boolean(conversationId&&(tab.active||networkState.busy||cachedDomActivity?.busy||Date.now()-networkObservedAt<DOM_ACTIVITY_RECENT_NETWORK_MS));
    const domActivity=shouldProbeDom?await chatDomActivityState(tab.id,conversationId):{available:false,busy:false,source:'',activity_text:''};
    const networkStream=conversationId&&networkState.network_state!=='idle'?await chatNetworkStreamCapture(tab.id,conversationId):{};
    const titleOverride=conversationId?titleOverrides[conversationId]:null;
    const streamBusy=Boolean(networkStream.in_progress);
    const networkBusy=Boolean(networkState.busy||streamBusy);
    const streamActivity=String(networkStream.activity_text||'').trim().slice(0,220);
    return {
      id:tab.id,
      window_id:tab.windowId,
      active:Boolean(tab.active),
      title:String(titleOverride?.title||tab.title||''),
      url:tab.url || '',
      busy:networkBusy,
      settling:!networkBusy&&domActivity.busy,
      busy_request_count:networkState.busy_request_count,
      busy_since:networkState.busy_since,
      busy_source:streamBusy?'network_stream':networkState.busy?'network':domActivity.busy?domActivity.source:'',
      activity_text:streamBusy?(streamActivity||'CodexPro đang sử dụng tool'):domActivity.busy?domActivity.activity_text:'',
      network_stream_in_progress:streamBusy,
      dom_busy:domActivity.busy,
      dom_probe_available:domActivity.available,
      network_state:networkState.network_state,
      network_source:networkState.network_source,
      network_generation_endpoint:networkState.network_generation_endpoint,
      network_last_started_at:networkState.network_last_started_at,
      network_last_completed_at:networkState.network_last_completed_at,
      network_status_code:networkState.network_status_code,
      network_error:networkState.network_error,
      network_duration_ms:networkState.network_duration_ms,
      network_recent_posts:recentChatPostEvidence(tab.id,Date.now()-5*60*1000),
      renderer_unresponsive:Boolean(shouldProbeDom&&!domActivity.available),
      renderer_error:String(domActivity.error||''),
      conversation_limit_reached:false,
      conversation_limit_message:''
    };
  }));
  if(summaries.some(tab=>tab.settling))scheduleDomActivityRefresh();
  return summaries;
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
      const [injected]=await promiseWithTimeout(
        chrome.scripting.executeScript({target:{tabId:source.id},world:'MAIN',func:fetchRecentConversationsPage,args:[limit]}),
        DOM_ACTION_TIMEOUT_MS,
        'Chrome renderer không phản hồi khi đọc danh sách chat gần đây.'
      );
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

function snapshotPage(maxChars,delta=false) {
  const registry=globalThis.__codexproSemanticRegistry||(globalThis.__codexproSemanticRegistry={next:1,sequence:0,refs:new Map(),reverse:new WeakMap(),previous:new Map(),previousText:''});
  const visible = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'; };
  const selectorFor = el => {
    if(el.id)return '#'+CSS.escape(el.id);
    for(const attr of ['data-testid','data-test','name','aria-label']){const value=el.getAttribute(attr);if(value){const candidate=el.tagName.toLowerCase()+'['+attr+'='+JSON.stringify(value)+']';try{if(document.querySelectorAll(candidate).length===1)return candidate;}catch{}}}
    const parts=[];let node=el;
    while(node&&node.nodeType===1&&node!==document.documentElement){let part=node.tagName.toLowerCase();const siblings=node.parentElement?Array.from(node.parentElement.children).filter(child=>child.tagName===node.tagName):[];if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(node)+1)+')';parts.unshift(part);const candidate=parts.join(' > ');try{if(document.querySelectorAll(candidate).length===1)return candidate;}catch{}node=node.parentElement;}
    return parts.join(' > ');
  };
  const implicitRole=el=>el.getAttribute('role')||({BUTTON:'button',A:'link',INPUT:(el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':'textbox'),TEXTAREA:'textbox',SELECT:'combobox'}[el.tagName]||'');
  const accessibleName=el=>String(el.getAttribute('aria-label')||el.getAttribute('title')||el.labels?.[0]?.innerText||el.innerText||el.textContent||el.getAttribute('placeholder')||el.getAttribute('name')||'').trim().slice(0,300);
  const current=new Map();
  const allElements=Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"],[data-testid],[data-test]')).filter(visible).slice(0,500).map(el=>{let ref=registry.reverse.get(el);if(!ref){ref='@e'+registry.next++;registry.reverse.set(el,ref);}registry.refs.set(ref,el);const item={ref,tag:el.tagName.toLowerCase(),selector:selectorFor(el),role:implicitRole(el),name:accessibleName(el),type:el.getAttribute('type'),placeholder:String(el.getAttribute('placeholder')||'').slice(0,300),test_id:String(el.getAttribute('data-testid')||el.getAttribute('data-test')||'').slice(0,300),disabled:Boolean(el.disabled),checked:Boolean(el.checked),aria_pressed:el.getAttribute('aria-pressed'),data_state:el.getAttribute('data-state'),value_length:typeof el.value==='string'?el.value.length:0};current.set(ref,JSON.stringify(item));return item;});
  for(const [ref,el] of registry.refs){if(!el?.isConnected)registry.refs.delete(ref);}
  const removed_refs=[...registry.previous.keys()].filter(ref=>!current.has(ref));
  const elements=delta?allElements.filter(item=>registry.previous.get(item.ref)!==current.get(item.ref)):allElements;
  const bodyText=String(document.body?.innerText||'').slice(0,maxChars),textChanged=bodyText!==registry.previousText;
  registry.previous=current;registry.previousText=bodyText;registry.sequence+=1;
  return {title:document.title,url:location.href,text:delta?(textChanged?bodyText:''):bodyText,text_changed:textChanged,elements,element_count:allElements.length,removed_refs,semantic_refs:true,delta:Boolean(delta),snapshot_sequence:registry.sequence};
}

async function browserElementActionPage(action,locator={},text='',state='visible',timeoutMs=10000) {
  const registry=globalThis.__codexproSemanticRegistry;
  const implicitRole=el=>el.getAttribute('role')||({BUTTON:'button',A:'link',INPUT:(el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':'textbox'),TEXTAREA:'textbox',SELECT:'combobox'}[el.tagName]||'');
  const accessibleName=el=>String(el.getAttribute('aria-label')||el.getAttribute('title')||el.labels?.[0]?.innerText||el.innerText||el.textContent||el.getAttribute('placeholder')||el.getAttribute('name')||'').trim();
  const resolve=()=>{
    if(!locator.ref&&!locator.selector&&!locator.role&&!locator.name&&!locator.placeholder&&!locator.label&&!locator.test_id)return document.body;
    if(locator.ref){const direct=registry?.refs?.get(locator.ref);return direct?.isConnected?direct:null;}
    if(locator.selector){try{return document.querySelector(locator.selector);}catch{return null;}}
    let candidates=Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"],[data-testid],[data-test]'));
    if(locator.role)candidates=candidates.filter(el=>implicitRole(el).toLowerCase()===String(locator.role).toLowerCase());
    if(locator.name)candidates=candidates.filter(el=>accessibleName(el).toLowerCase().includes(String(locator.name).toLowerCase()));
    if(locator.placeholder)candidates=candidates.filter(el=>String(el.getAttribute('placeholder')||'').toLowerCase().includes(String(locator.placeholder).toLowerCase()));
    if(locator.label)candidates=candidates.filter(el=>String(el.labels?.[0]?.innerText||el.getAttribute('aria-label')||'').toLowerCase().includes(String(locator.label).toLowerCase()));
    if(locator.test_id)candidates=candidates.filter(el=>String(el.getAttribute('data-testid')||el.getAttribute('data-test')||'')===String(locator.test_id));
    return candidates[Math.max(0,Number(locator.nth)||0)]||null;
  };
  const describe=el=>{const rect=el.getBoundingClientRect(),style=getComputedStyle(el);return {ok:true,tag:el.tagName.toLowerCase(),text:String(el.innerText||el.textContent||el.getAttribute('aria-label')||'').trim().slice(0,1000),value:typeof el.value==='string'?el.value.slice(0,1000):'',disabled:Boolean(el.disabled),checked:Boolean(el.checked),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},style:{display:style.display,visibility:style.visibility,opacity:style.opacity,pointer_events:style.pointerEvents,position:style.position,z_index:style.zIndex},attributes:Object.fromEntries(Array.from(el.attributes||[]).slice(0,40).map(attr=>[attr.name,String(attr.value).slice(0,500)]))};};
  if(action==='wait_for')return await new Promise(resolveWait=>{let timer;const observer=new MutationObserver(()=>check());const cleanup=()=>{observer.disconnect();clearTimeout(timer);};const check=()=>{const el=resolve(),attached=Boolean(el),visible=Boolean(el&&(()=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';})()),haystack=el?String(el.innerText||el.textContent||''):String(document.body?.innerText||''),textMatched=!text||haystack.includes(text),matched=state==='attached'?attached&&textMatched:state==='visible'?visible&&textMatched:state==='hidden'?!visible:state==='detached'?!attached:false;if(matched){cleanup();resolveWait({ok:true,matched,attached,visible,text_matched:textMatched,state});return true;}return false;};if(check())return;observer.observe(document.documentElement||document,{subtree:true,childList:true,attributes:true,characterData:true});timer=setTimeout(()=>{cleanup();resolveWait({ok:false,error:`Timed out waiting for ${state}.`,state});},Math.max(100,Math.min(60000,Number(timeoutMs)||10000)));});
  const el=resolve();if(!el)return {ok:false,error:'Element not found'};
  if(action==='click'){el.scrollIntoView({block:'center',inline:'center'});el.click();return {ok:true,tag:el.tagName.toLowerCase(),text:accessibleName(el).slice(0,300)};}
  if(action==='type'){el.scrollIntoView({block:'center',inline:'center'});el.focus();if(el.isContentEditable)el.textContent=text;else{const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(el,text);else el.value=text;}el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,tag:el.tagName.toLowerCase(),length:text.length};}
  if(action==='locate'){el.scrollIntoView({block:'center',inline:'center'});const rect=el.getBoundingClientRect();return {ok:true,x:rect.left+rect.width/2,y:rect.top+rect.height/2,tag:el.tagName.toLowerCase(),text:accessibleName(el).slice(0,300)};}
  if(action==='inspect')return describe(el);
  return {ok:false,error:'Unsupported element action'};
}

async function sendChatRequestPage(text,attachments=[],attemptId='',deadlineAt=0,staleAttachmentOwnership=null) {
  const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
  const expired=()=>Boolean(deadlineAt&&Date.now()>Number(deadlineAt));
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  const normalizedText=value=>String(value||'').replace(/[\u200B-\u200D\uFEFF]/g,'').trim();
  const comparableText=value=>normalizedText(value).replace(/\u00a0/g,' ').replace(/\s+/g,' ').replace(/^@\s*(?=CodexPro\b)/i,'').trim();
  const composerText=element=>element?.isContentEditable?normalizedText(element.innerText||element.textContent||''):normalizedText(element?.value||'');
  if(location.origin!=='https://chatgpt.com'||(!location.pathname.startsWith('/c/')&&location.pathname!=='/'))return {ok:false,error:'Tab đã chọn không phải ChatGPT.'};
  const composerSelectors=['#prompt-textarea','[contenteditable="true"][data-lexical-editor="true"]','textarea[data-id="root"]','textarea[placeholder]'];
  const findComposer=()=>composerSelectors.map(selector=>document.querySelector(selector)).find(element=>visible(element));
  const composerRootFor=element=>element?.closest('form')||element?.closest('[data-type="unified-composer"]')||element?.parentElement;
  const attachmentButtons=root=>Array.from((root||document).querySelectorAll('button[aria-label*="Remove file" i],button[aria-label*="Remove attachment" i],button[aria-label*="Xóa tệp" i],button[aria-label*="Xóa file" i]')).filter(visible);
  const attachmentLabel=button=>String(button?.getAttribute?.('aria-label')||button?.innerText||button?.textContent||'').trim();
  const markedRootForAttempt=ownedAttemptId=>ownedAttemptId?document.querySelector(`[data-codexpro-attachment-attempt="${CSS.escape(ownedAttemptId)}"]`):null;
  let initialRoot=null;
  const clearOwnedAttempt=async ownedAttemptId=>{
    let textCleared=false,attachmentsRemoved=0;
    const current=findComposer();
    const root=composerRootFor(current)||markedRootForAttempt(ownedAttemptId)||initialRoot;
    if(current&&current.dataset.codexproDraftAttempt===ownedAttemptId){
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
      delete current.dataset.codexproDraftText;
    }
    let ownedLabels=new Set();
    if(root?.dataset?.codexproAttachmentAttempt===ownedAttemptId){
      try{ownedLabels=new Set(JSON.parse(root.dataset.codexproAttachmentLabels||'[]'));}catch{}
    }
    for(const button of attachmentButtons(root)){
      const owned=button.dataset.codexproAttachmentAttempt===ownedAttemptId||ownedLabels.has(attachmentLabel(button));
      if(!owned)continue;
      button.click();attachmentsRemoved+=1;await sleep(40);
    }
    if(root?.dataset?.codexproAttachmentAttempt===ownedAttemptId){
      delete root.dataset.codexproAttachmentAttempt;
      delete root.dataset.codexproAttachmentLabels;
    }
    return {text_cleared:textCleared,attachments_removed:attachmentsRemoved};
  };
  const clearOwnedDraft=async()=>await clearOwnedAttempt(attemptId);
  const fail=async(error,extra={})=>({ok:false,error,...extra,cleanup:await clearOwnedDraft()});
  let composer=findComposer();
  if(!composer)return {ok:false,error:'Không tìm thấy ô nhập đang hiển thị trong đoạn chat.'};
  initialRoot=composerRootFor(composer);
  let root=initialRoot;
  const markedAttempts=[composer.dataset.codexproDraftAttempt,root?.dataset?.codexproAttachmentAttempt].filter(Boolean);
  const staleAttempts=[...new Set(markedAttempts)].filter(value=>value!==attemptId);
  let staleOwnedCleanup=null;
  if(staleAttempts.length===1){
    const staleAttemptId=staleAttempts[0];
    const staleButtons=attachmentButtons(root);
    let staleLabels=new Set();
    if(root?.dataset?.codexproAttachmentAttempt===staleAttemptId){
      try{staleLabels=new Set(JSON.parse(root.dataset.codexproAttachmentLabels||'[]'));}catch{}
    }
    const staleAttachmentsOwned=staleButtons.length>0&&staleButtons.every(button=>button.dataset.codexproAttachmentAttempt===staleAttemptId||staleLabels.has(attachmentLabel(button)));
    const staleDraft=composerText(composer);
    const markedDraftText=String(composer.dataset.codexproDraftText||'');
    const staleDraftOwned=!staleDraft||(composer.dataset.codexproDraftAttempt===staleAttemptId&&((markedDraftText&&comparableText(staleDraft)===comparableText(markedDraftText))||comparableText(staleDraft)===comparableText(text)));
    if(staleAttachmentsOwned&&staleDraftOwned){
      staleOwnedCleanup=await clearOwnedAttempt(staleAttemptId);
      composer=findComposer();
      if(!composer)return {ok:false,error:'Ô nhập ChatGPT biến mất sau khi dọn attachment cũ của CodexPro.'};
      initialRoot=composerRootFor(composer);
      root=initialRoot;
    }
  }
  const contentEditableEmpty=Boolean(composer.isContentEditable&&composer.querySelector('[data-empty-paragraph="true"]')&&!Array.from(composer.querySelectorAll('p')).some(node=>!node.hasAttribute('data-empty-paragraph')&&String(node.textContent||'').replace(/[\u200B-\u200D\uFEFF]/g,'').trim()));
  const rawDraft=composer.isContentEditable?String(composer.innerText||''):String(composer.value||'');
  const normalizedDraft=rawDraft.replace(/[\u200B-\u200D\uFEFF]/g,'').trim();
  const placeholder=String(composer.getAttribute?.('data-placeholder')||composer.getAttribute?.('placeholder')||'').trim();
  const draft=contentEditableEmpty||normalizedDraft===placeholder||/^(?:ask|message|chat with)\s+chatgpt[.…]*$/i.test(normalizedDraft)?'':normalizedDraft;
  const ownedExistingDraft=Boolean(draft&&composer.dataset.codexproDraftAttempt===attemptId&&draft===normalizedText(text));
  if(draft&&!ownedExistingDraft)return {ok:false,error:'Ô ChatGPT đang có một bản nháp khác. CodexPro không ghi đè bản nháp của người dùng.'};
  let existingAttachments=attachmentButtons(root);
  const persistedNames=Array.isArray(staleAttachmentOwnership?.names)?staleAttachmentOwnership.names.map(name=>String(name||'').trim().toLocaleLowerCase()).filter(Boolean):[];
  const persistedLabels=Array.isArray(staleAttachmentOwnership?.labels)?staleAttachmentOwnership.labels.map(label=>String(label||'').trim().toLocaleLowerCase()).filter(Boolean):[];
  const existingLabelsBeforeCleanup=existingAttachments.map(button=>attachmentLabel(button).toLocaleLowerCase());
  const persistedOwnershipMatches=Boolean(
    !draft&&staleAttachmentOwnership?.attempt_id&&staleAttachmentOwnership.attempt_id!==attemptId&&
    existingAttachments.length>0&&existingAttachments.length===persistedNames.length&&
    persistedNames.every(name=>existingLabelsBeforeCleanup.some(label=>label.includes(name)))&&
    (!persistedLabels.length||persistedLabels.every(label=>existingLabelsBeforeCleanup.includes(label)))
  );
  if(persistedOwnershipMatches){
    let attachmentsRemoved=0;
    for(const button of existingAttachments){button.click();attachmentsRemoved+=1;await sleep(60);}
    const cleanupDeadline=Date.now()+1500;
    while(Date.now()<cleanupDeadline&&attachmentButtons(root).length)await sleep(60);
    if(!attachmentButtons(root).length){
      staleOwnedCleanup={text_cleared:false,attachments_removed:attachmentsRemoved,source:'extension-ownership',attempt_id:String(staleAttachmentOwnership.attempt_id||'')};
      composer=findComposer();
      if(!composer)return {ok:false,error:'Ô nhập ChatGPT biến mất sau khi dọn attachment cũ của CodexPro.'};
      root=composerRootFor(composer);
      existingAttachments=[];
    }
  }
  const expectedAttachmentNames=attachments.map(file=>String(file.name||'').trim().toLocaleLowerCase()).filter(Boolean);
  const existingAttachmentLabels=existingAttachments.map(button=>attachmentLabel(button).toLocaleLowerCase());
  let existingOwnedLabels=new Set();
  if(root?.dataset?.codexproAttachmentAttempt===attemptId){
    try{existingOwnedLabels=new Set(JSON.parse(root.dataset.codexproAttachmentLabels||'[]'));}catch{}
  }
  const ownedExistingAttachments=Boolean(existingAttachments.length&&root?.dataset?.codexproAttachmentAttempt===attemptId&&existingAttachments.every(button=>button.dataset.codexproAttachmentAttempt===attemptId||existingOwnedLabels.has(attachmentLabel(button))));
  const matchingExistingAttachments=Boolean(!draft&&existingAttachments.length===expectedAttachmentNames.length&&expectedAttachmentNames.every(name=>existingAttachmentLabels.some(label=>label.includes(name))));
  const reusableExistingAttachments=ownedExistingAttachments||matchingExistingAttachments;
  if(existingAttachments.length&&!reusableExistingAttachments)return {ok:false,error:'Ô chat đang có file chưa gửi; CodexPro không ghi đè file/bản nháp có sẵn.'};
  if(expired())return {ok:false,error:'Lần gửi đã hết hạn trước khi thao tác composer.',expired:true};
  let attachmentPreparePath='';

  if(attachments.length&&!reusableExistingAttachments){
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
    const inputPreviewDeadline=Math.min(Number(deadlineAt)||Date.now()+3000,Date.now()+3000);
    while(!expired()&&Date.now()<inputPreviewDeadline){
      readyButtons=attachmentButtons(root);
      if(readyButtons.length>=attachments.length)break;
      await sleep(100);
    }
    if(readyButtons.length<attachments.length&&!expired()){
      try{
        const pasteTransfer=new DataTransfer();
        for(const file of Array.from(fileInput.files||[]))pasteTransfer.items.add(file);
        let pasteEvent;
        try{pasteEvent=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:pasteTransfer});}
        catch{pasteEvent=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(pasteEvent,'clipboardData',{value:pasteTransfer});}
        composer.dispatchEvent(pasteEvent);
        attachmentPreparePath='paste-fallback';
      }catch(error){return await fail('ChatGPT không nhận file qua input và paste fallback thất bại: '+(error?.message||error));}
    }else attachmentPreparePath='file-input';
    while(!expired()){
      readyButtons=attachmentButtons(root);
      const ownedButtons=readyButtons.slice(0,attachments.length);
      ownedButtons.forEach(button=>{button.dataset.codexproAttachmentAttempt=attemptId;});
      if(root)root.dataset.codexproAttachmentLabels=JSON.stringify(ownedButtons.map(attachmentLabel));
      if(readyButtons.length>=attachments.length)break;
      await sleep(100);
    }
    if(readyButtons.length<attachments.length)return await fail('ChatGPT chưa xác nhận file đính kèm đã sẵn sàng để gửi.',{expired:expired()});
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
    composer.dataset.codexproDraftText=text;
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
    const expectedText=normalizedText(text);
    const expectedComparable=comparableText(expectedText);
    const verifyDeadline=Math.min(Number(deadlineAt)||Date.now()+3000,Date.now()+3000);
    while(!expired()&&Date.now()<verifyDeadline){
      const currentComposer=findComposer();
      if(comparableText(composerText(currentComposer))===expectedComparable){
        composer=currentComposer;
        composer.dataset.codexproDraftAttempt=attemptId;
        composer.dataset.codexproDraftText=text;
        break;
      }
      await sleep(50);
    }
    if(comparableText(composerText(composer))!==expectedComparable){const observed=composerText(composer);return await fail('ChatGPT chưa nhận đúng nội dung vào composer; chưa gửi để tránh báo thành công giả.',{expired:expired(),observed_length:observed.length,expected_length:expectedText.length});}
  }

  if(expired())return await fail('Lần gửi đã hết hạn ngay trước khi submit; CodexPro đã hủy để tránh gửi trùng.',{expired:true});
  const currentComposer=findComposer();
  if(!currentComposer)return await fail('Ô nhập ChatGPT biến mất ngay trước khi submit.');
  composer=currentComposer;
  composer.dataset.codexproSubmitAttempt=attemptId;
  return {ok:true,title:document.title,url:location.href,length:text.length,attachment_count:attachments.length,attachment_names:attachments.map(file=>file.name),attachment_labels:attachmentButtons(root).map(attachmentLabel),existing_attachment_count:attachmentButtons(root).length,attachment_prepare_path:ownedExistingAttachments?'existing-attempt':matchingExistingAttachments?'matching-existing-file':attachmentPreparePath,attachment_reused:Boolean(reusableExistingAttachments),stale_owned_cleanup:staleOwnedCleanup,prepared:true,composer_prepared:true,requires_trusted_submit:true,internal_submit_found:false,internal_submit_reason:'ChatGPT không công khai một frontend submit action ổn định; dùng trusted Enter cho text và page-context submit đã khóa attempt cho attachment để SPA tự chạy Sentinel/PoW.',submitted:false,submitted_by:'prepared',attempt_id:attemptId};
}

async function cleanupChatRequestDraftPage(attemptId='') {
  const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  const composerSelectors=['#prompt-textarea','[contenteditable="true"][data-lexical-editor="true"]','textarea[data-id="root"]','textarea[placeholder]'];
  const composer=composerSelectors.map(selector=>document.querySelector(selector)).find(element=>visible(element));
  const markedRoot=attemptId?document.querySelector(`[data-codexpro-attachment-attempt="${CSS.escape(attemptId)}"]`):null;
  const root=composer?.closest('form')||composer?.closest('[data-type="unified-composer"]')||markedRoot||composer?.parentElement;
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
    delete composer.dataset.codexproDraftAttempt;delete composer.dataset.codexproDraftText;textCleared=true;
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
  const messageNodes=Array.from(document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')).slice(-12);
  const messages=messageNodes.map((message,index)=>{
    const role=message.getAttribute('data-message-author-role')==='user'?'user':'assistant';
    const content=role==='assistant'?message.querySelector('.markdown,.prose,[class*="markdown"]')||message:message.querySelector('.whitespace-pre-wrap,[class*="whitespace-pre-wrap"],[data-message-content]')||message;
    const raw=role==='assistant'?structuredText(content):nodeText(content);
    const text=raw.slice(0,40000);
    return raw?{id:`${role}-${index}`,role,text,truncated:raw.length>text.length}:null;
  }).filter(Boolean);
  const latestAssistant=[...messages].reverse().find(message=>message.role==='assistant');
  const text=latestAssistant?.text||'';
  const stopControl=Array.from(document.querySelectorAll('button,[role="button"]')).find(control=>{
    const label=String(control.getAttribute?.('aria-label')||control.innerText||control.textContent||'').trim();
    return /^(?:stop(?: answering| generating| streaming)?|dừng(?: trả lời)?)$/i.test(label);
  });
  const thinkingPlaceholder=/^(?:thinking|đang suy nghĩ)(?:\s*[.…]{1,3})?$/i.test(text);
  const busy=Boolean(stopControl||thinkingPlaceholder);
  return {ok:true,title:document.title,url:location.href,text,text_length:text.length,truncated:Boolean(latestAssistant?.truncated),incomplete:busy,incomplete_reason:busy?(thinkingPlaceholder?'thinking_placeholder':'generation_in_progress'):'',conversation_limit_reached:false,conversation_limit_message:'',conversation_limit_button_label:'',message_count:messages.filter(message=>message.role==='assistant').length,total_message_count:messages.length,messages,busy,updated_at:new Date().toISOString()};
}

function inspectChatSendAttemptPage(attemptId='') {
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  const composer=['#prompt-textarea','[contenteditable="true"][data-lexical-editor="true"]','textarea[data-id="root"]','textarea[placeholder]'].map(selector=>document.querySelector(selector)).find(visible);
  const text=String(composer?.isContentEditable?(composer.innerText||composer.textContent||''):(composer?.value||'')).replace(/[\u200B-\u200D\uFEFF]/g,'').trim();
  return {ok:true,draft_owned:Boolean(composer&&composer.dataset.codexproDraftAttempt===attemptId),draft_present:Boolean(text),draft_length:text.length,composer_found:Boolean(composer)};
}

async function focusChatComposerForSubmitPage(attemptId='',expectedText='') {
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  const normalized=value=>String(value||'').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').replace(/^@\s*(?=CodexPro\b)/i,'').trim();
  const composerText=element=>element?.isContentEditable?String(element.innerText||element.textContent||''):String(element?.value||'');
  const marked=document.querySelector(`[data-codexpro-submit-attempt="${CSS.escape(attemptId)}"]`);
  const current=['#prompt-textarea','[contenteditable="true"][data-lexical-editor="true"]','textarea[data-id="root"]','textarea[placeholder]'].map(selector=>document.querySelector(selector)).find(visible);
  const recovered=Boolean(!marked&&current&&normalized(composerText(current))===normalized(expectedText));
  const composer=marked||recovered&&current;
  if(!composer)return {ok:false,error:'Composer của attempt đã bị React thay thế và draft hiện tại không còn khớp payload.'};
  composer.dataset.codexproDraftAttempt=attemptId;
  composer.dataset.codexproDraftText=expectedText;
  composer.dataset.codexproSubmitAttempt=attemptId;
  composer.scrollIntoView({block:'center',inline:'center'});
  composer.focus({preventScroll:true});
  const selection=getSelection(),range=document.createRange();
  range.selectNodeContents(composer);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
  for(let focusAttempt=0;focusAttempt<15;focusAttempt+=1){
    if(document.activeElement===composer)return {ok:true,focused:true,focus_wait_ms:focusAttempt*50,composer_recovered_after_react:recovered};
    await new Promise(resolve=>setTimeout(resolve,50));
    composer.focus({preventScroll:true});
  }
  return {ok:true,focused:document.activeElement===composer,selection_inside:Boolean(getSelection()?.anchorNode&&composer.contains(getSelection().anchorNode)),focus_wait_ms:750,composer_recovered_after_react:recovered};
}

function prepareTrustedClickFallbackPage(attemptId='',expectedText='') {
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  const composer=['#prompt-textarea','[contenteditable="true"][data-lexical-editor="true"]','textarea[data-id="root"]','textarea[placeholder]'].map(selector=>document.querySelector(selector)).find(visible);
  const normalized=value=>String(value||'').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').replace(/^@\s*(?=CodexPro\b)/i,'').trim();
  const composerText=composer?.isContentEditable?String(composer.innerText||composer.textContent||''):String(composer?.value||'');
  const recovered=Boolean(composer&&composer.dataset.codexproDraftAttempt!==attemptId&&expectedText&&normalized(composerText)===normalized(expectedText));
  if(!composer||composer.dataset.codexproDraftAttempt!==attemptId&&!recovered)return {ok:false,error:'Composer không còn giữ đúng draft của attempt này.'};
  composer.dataset.codexproDraftAttempt=attemptId;
  composer.dataset.codexproDraftText=expectedText;
  const root=composer.closest('form')||composer.closest('[data-type="unified-composer"]')||composer.parentElement;
  const send=['#composer-submit-button','button[data-testid="send-button"]','button[aria-label*="Send" i]','button[aria-label*="Gửi" i]'].flatMap(selector=>[root?.querySelector(selector),document.querySelector(selector)]).filter(Boolean).find(element=>{
    if(!visible(element)||element.disabled||element.getAttribute?.('aria-disabled')==='true'||element.hasAttribute?.('data-visually-disabled'))return false;
    const label=String(element.innerText||element.textContent||element.getAttribute?.('aria-label')||'').trim();
    return !/(?:stop\s+(?:answering|generating|streaming)|dừng(?:\s+trả\s+lời)?)/i.test(label);
  });
  if(!send)return {ok:false,error:'Không tìm thấy nút Send khả dụng cho fallback cuối cùng.'};
  send.dataset.codexproSendAttempt=attemptId;
  return {ok:true,send_found:true,composer_recovered_after_react:recovered};
}

function clickPreparedChatSendButtonPage(attemptId='') {
  const composer=document.querySelector(`[data-codexpro-submit-attempt="${CSS.escape(attemptId)}"]`);
  const send=document.querySelector(`[data-codexpro-send-attempt="${CSS.escape(attemptId)}"]`);
  if(!composer||composer.dataset.codexproDraftAttempt!==attemptId)return {ok:false,error:'Composer không còn thuộc attachment attempt này.',click_dispatched:false};
  if(!send||send.disabled||send.getAttribute('aria-disabled')==='true')return {ok:false,error:'Nút Send attachment không còn khả dụng.',click_dispatched:false};
  send.click();
  return {ok:true,click_dispatched:true};
}

async function readCanonicalConversationPage(conversationId) {
  const messageText=message=>{
    const parts=Array.isArray(message?.content?.parts)?message.content.parts:[];
    return parts.map(part=>{
      if(typeof part==='string')return part;
      if(typeof part?.text==='string')return part.text;
      if(typeof part?.content==='string')return part.content;
      return '';
    }).filter(Boolean).join('\n').replace(/\u200b/g,'').trim();
  };
  const messagesFromPayload=payload=>{
    const directMessages=Array.isArray(payload?.messages)?payload.messages.map((message,index)=>{
      const role=String(message?.author?.role||message?.role||'');
      if(!['user','assistant'].includes(role))return null;
      const contentType=String(message?.content?.content_type||'');
      if(role==='assistant'&&!['text','multimodal_text'].includes(contentType))return null;
      const text=messageText(message);
      return text?{id:String(message?.id||`${role}-${index}`),role,text:text.slice(0,40000),truncated:text.length>40000,content_type:contentType,status:String(message?.status||''),end_turn:message?.end_turn===true,create_time:Number(message?.create_time)||0,order:index}:null;
    }).filter(Boolean):[];
    if(directMessages.length)return directMessages;
    const mapping=payload?.mapping||payload?.conversation?.mapping;
    if(!mapping||typeof mapping!=='object')return [];
    const nodes=[];
    const currentId=String(payload?.current_node||payload?.conversation?.current_node||'');
    if(currentId&&mapping[currentId]){
      const seen=new Set();let cursor=mapping[currentId];
      while(cursor&&!seen.has(cursor.id)){
        seen.add(cursor.id);nodes.push(cursor);cursor=mapping[cursor.parent];
      }
      nodes.reverse();
    }else{
      nodes.push(...Object.values(mapping).sort((left,right)=>Number(left?.message?.create_time||0)-Number(right?.message?.create_time||0)));
    }
    return nodes.map((node,index)=>{
      const message=node?.message;
      const role=String(message?.author?.role||'');
      if(!['user','assistant'].includes(role))return null;
      const contentType=String(message?.content?.content_type||'');
      if(role==='assistant'&&!['text','multimodal_text','code','tether_browsing'].includes(contentType))return null;
      const text=messageText(message);
      return text?{id:String(message.id||node.id||`${role}-${index}`),role,text:text.slice(0,40000),truncated:text.length>40000,content_type:contentType,status:String(message?.status||''),end_turn:message?.end_turn===true,create_time:Number(message?.create_time)||0,order:index}:null;
    }).filter(Boolean).slice(-20);
  };
  try{
    const sessionResponse=await fetch('/api/auth/session',{credentials:'include',cache:'no-store'});
    const session=await sessionResponse.json().catch(()=>({}));
    const accessToken=String(session?.accessToken||'');
    if(!accessToken)return {ok:false,error:'ChatGPT session không trả access token.'};
    const accountId=String(session?.account?.id||session?.accountId||session?.user?.account_id||session?.user?.accountId||session?.accounts?.[0]?.id||'').trim();
    const headers={authorization:`Bearer ${accessToken}`,...(accountId?{'chatgpt-account-id':accountId}:{})};
    const endpoints=[

      `/backend-api/conversations/${encodeURIComponent(conversationId)}?include_has_versions=true&num_turns=6`
    ];
    let lastError='';
    for(const endpoint of endpoints){
      const response=await fetch(endpoint,{credentials:'include',cache:'no-store',headers});
      const payload=await response.json().catch(()=>({}));
      if(response.ok){
        const messages=messagesFromPayload(payload);
        const latestUserIndex=messages.findLastIndex(message=>message.role==='user');
        const assistantAfterUser=messages.slice(latestUserIndex+1).findLast(message=>message.role==='assistant');
        const latestAssistant=assistantAfterUser||[...messages].reverse().find(message=>message.role==='assistant');
        const responseReady=Boolean(assistantAfterUser&&(assistantAfterUser.end_turn||assistantAfterUser.status==='finished_successfully'));
        if(latestAssistant)return {ok:true,endpoint,messages,text:assistantAfterUser?.text||'',text_length:String(assistantAfterUser?.text||'').length,response_ready:responseReady,busy:Boolean(latestUserIndex>=0&&!responseReady),latest_user_id:String(messages[latestUserIndex]?.id||''),latest_assistant_id:String(assistantAfterUser?.id||'')};
        lastError=`${endpoint}: conversation chưa có assistant message.`;
      }else lastError=`${endpoint}: ChatGPT HTTP ${response.status}`;
      if(![404,405].includes(response.status))break;
    }
    return {ok:false,error:lastError||'ChatGPT không trả conversation canonical.'};
  }catch(error){return {ok:false,error:String(error?.message||error)};}
}

function readChatNetworkStreamCapturePage(conversationId='') {
  const capture=globalThis.__codexproNetworkStreamCaptureV1;
  if(!capture||typeof capture.read!=='function')return {available:false,capture_installed:false,conversation_id:String(conversationId||'')};
  try{return capture.read(String(conversationId||''));}
  catch(error){return {available:false,capture_installed:true,conversation_id:String(conversationId||''),error:String(error?.message||error).slice(0,500)};}
}

async function ensureChatNetworkStreamCapture(tabId) {
  try{
    await promiseWithTimeout(
      chrome.scripting.executeScript({target:{tabId},world:'MAIN',files:['network-capture.js']}),
      DOM_ACTION_TIMEOUT_MS,
      'ChatGPT network capture install timeout.'
    );
    return true;
  }catch{return false;}
}

async function chatNetworkStreamCapture(tabId,conversationId) {
  const installed=await ensureChatNetworkStreamCapture(tabId);
  if(!installed)return {available:false,capture_installed:false,conversation_id:String(conversationId||'')};
  try{
    const [injected]=await promiseWithTimeout(
      chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:readChatNetworkStreamCapturePage,args:[conversationId]}),
      DOM_ACTION_TIMEOUT_MS,
      'ChatGPT network stream read timeout.'
    );
    return injected?.result&&typeof injected.result==='object'?injected.result:{available:false,capture_installed:true,conversation_id:String(conversationId||'')};
  }catch(error){return {available:false,capture_installed:true,conversation_id:String(conversationId||''),error:String(error?.message||error).slice(0,500)};}
}

async function reconcileChatNetworkCompletion(tabId,conversationId,source='canonical_api') {
  await ensureChatNetworkStateLoaded();
  const current=chatNetworkStateByTab.get(tabId);
  if(!current)return false;
  const trackerTimeoutFailure=current.state==='failed'&&/CDP generation tracker exceeded maximum lifetime/i.test(String(current.error||''));
  if(current.state!=='generating'&&!trackerTimeoutFailure)return false;
  const currentConversation=String(current.conversation_id||'');
  if(conversationId&&currentConversation&&currentConversation!==conversationId)return false;
  const now=Date.now();
  chatNetworkStateByTab.set(tabId,{
    ...current,
    state:'completed',
    completed_at_ms:now,
    conversation_id:String(conversationId||currentConversation),
    status_code:Number(current.status_code)||200,
    error:'',
    completion_source:String(source||'reconciled')
  });
  notifyChatNetworkWaiters(tabId);
  await persistChatNetworkState();
  scheduleRealtimeProfilePush();
  const tracker=cdpNetworkTrackersByTab.get(tabId);
  if(tracker)void tracker.cleanup();
  return true;
}

async function probeCanonicalCompletion(tabId,conversationId,force=false) {
  if(!conversationId)return false;
  const now=Date.now(),last=Number(canonicalCompletionProbeAtByTab.get(tabId)||0);
  if(!force&&now-last<CANONICAL_COMPLETION_PROBE_MS)return false;
  canonicalCompletionProbeAtByTab.set(tabId,now);
  try{
    const [injected]=await promiseWithTimeout(
      chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:readCanonicalConversationPage,args:[conversationId]}),
      CANONICAL_READ_TIMEOUT_MS,
      'ChatGPT không phản hồi khi xác minh completion canonical.'
    );
    const canonical=injected?.result;
    if(canonical?.ok&&canonical.response_ready&&!canonical.busy)return await reconcileChatNetworkCompletion(tabId,conversationId,'canonical_api');
  }catch{}
  return false;
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

function browserLocatorArgs(args={}) {
  const selector=String(args.selector||'').trim().slice(0,2000);
  const ref=String(args.ref||(selector.startsWith('@e')?selector:'')).trim().slice(0,80);
  return {selector:ref?'':selector,ref,role:String(args.role||'').trim().slice(0,80),name:String(args.name||'').trim().slice(0,500),placeholder:String(args.placeholder||'').trim().slice(0,500),label:String(args.label||'').trim().slice(0,500),test_id:String(args.test_id||'').trim().slice(0,500),nth:Number.isInteger(Number(args.nth))&&Number(args.nth)>=0?Number(args.nth):0};
}

function hasBrowserLocator(args={}) {
  const locator=browserLocatorArgs(args);
  return Boolean(locator.selector||locator.ref||locator.role||locator.name||locator.placeholder||locator.label||locator.test_id);
}

async function execute(command) {
  const {action,args={}}=command;
  const commandExpiresAt=Number(command?.expires_at_ms)||0;
  if(commandExpiresAt&&Date.now()>=commandExpiresAt)throw new Error('COMMAND_EXPIRED: Lệnh đã hết hạn trong bridge và bị hủy trước khi chạm vào ChatGPT.');
  if(action==='reload_extension'){
    const tabs=await tabList();
    const busyTabs=tabs.filter(tab=>tab?.busy||tab?.settling||String(tab?.network_state||'')==='generating');
    if(busyTabs.length)throw new Error(`WORKER_BUSY: ${busyTabs.length} ChatGPT tab đang xử lý; hoãn reload extension để không gián đoạn task.`);
    await chrome.alarms.create('codexpro-reconnect',{when:Date.now()+3000});
    setTimeout(()=>chrome.runtime.reload(),1200);
    return {action,ok:true,reloading:true,version:chrome.runtime.getManifest().version};
  }
  if(action==='check_chatgpt')return {action,...await checkConnectorInstalled()};
  if(action==='setup_chatgpt')return {action,...await installConnector()};
  if(action==='list_tabs')return {action,tabs:await tabList()};
  if(action==='recover_chat_tab'){
    const conversationId=String(args.conversation_id||'').trim();
    const requestedId=Number(args.target_id);
    if(!/^[A-Za-z0-9-]{8,160}$/.test(conversationId))throw new Error('Conversation id cần khôi phục không hợp lệ.');
    const tabs=await chrome.tabs.query({});
    const tab=tabs.find(candidate=>candidate.id===requestedId)||tabs.find(candidate=>{try{return new URL(String(candidate.url||'')).pathname===`/c/${conversationId}`;}catch{return false;}});
    if(!tab?.id)throw new Error('Không còn tab ChatGPT cũ để khôi phục.');
    const networkState=await chatRequestState(tab.id,conversationId);
    if(networkState.busy)throw new Error('WORKER_BUSY: ChatGPT vẫn đang generation; không thay tab để tránh gián đoạn hoặc gửi trùng.');
    const replaced=await replaceUnresponsiveChatTab(tab,`https://chatgpt.com/c/${conversationId}`);
    let windowInfo=null;
    if(Number.isInteger(replaced.tab.windowId)){
      try{await chrome.tabs.update(replaced.tab.id,{active:true});}catch{}
      try{await chrome.windows.update(replaced.tab.windowId,{state:'maximized'});}catch{}
      try{windowInfo=await chrome.windows.update(replaced.tab.windowId,{focused:true});}catch{}
    }
    return {action,ok:true,conversation_id:conversationId,target_id:replaced.tab.id,renderer_replaced:true,replaced_tab_id:replaced.replaced_tab_id,recovery_tab_id:replaced.recovery_tab_id,recovery_url:replaced.recovery_url,window_id:replaced.tab.windowId,window_state:String(windowInfo?.state||''),window_focused:Boolean(windowInfo?.focused)};
  }
  if(action==='send_chat_request'){
    const commandDeadlineAt=commandExpiresAt||Date.now()+175000;
    const remainingCommandMs=()=>Math.max(0,commandDeadlineAt-Date.now());
    const commandQueuedMs=Math.max(0,Date.now()-(Number(command?.created_at_ms)||Date.now()));
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
    if(newChat){await waitForTab(tab.id,Math.max(1000,Math.min(45000,remainingCommandMs()-2000)));tab=await chrome.tabs.get(tab.id);}
    if(!tab&&conversationId){
      const recent=await recentConversationList(3);
      if(!recent.some(conversation=>conversation.id===conversationId))throw new Error('Đoạn chat không còn thuộc 3 chat gần nhất của profile này.');
      tab=await chrome.tabs.create({url:'https://chatgpt.com/c/'+conversationId,active:false});await waitForTab(tab.id,Math.max(1000,Math.min(45000,remainingCommandMs()-2000)));tab=await chrome.tabs.get(tab.id);
    }
    if(!tab?.id)throw new Error('Profile này không có đoạn chat dự án đang mở.');
    const networkCaptureInstalled=await ensureChatNetworkStreamCapture(tab.id);
    if((await chatRequestState(tab.id,conversationId)).busy)throw new Error('Đoạn chat đang xử lý yêu cầu khác.');
    if(!newChat&&(await chatDomActivityState(tab.id,conversationId,{fresh:true})).busy)throw new Error('Đoạn chat vẫn đang hoàn tất lượt trước. Chờ ChatGPT về trạng thái rảnh để không nhập tin nhắn mới vào turn cũ.');
    const targetTemporarilyActivated=false;
    const submitStartedAt=Date.now();
    const attemptId=crypto.randomUUID();
    const targetConversationId=newChat?'':conversationId||conversationIdFromUrl(tab.url);
    const staleAttachmentOwnership=await chatAttachmentOwnership(tab.id,targetConversationId);
    const prepareTimeoutMs=attachments.length?ATTACHMENT_PREPARE_TIMEOUT_MS:DOM_PREPARE_TIMEOUT_MS;
    let deadlineAt=Math.min(submitStartedAt+prepareTimeoutMs-1500,commandDeadlineAt-1500);
    pendingConversationByTab.set(tab.id,{conversation_id:newChat?'':conversationId||conversationIdFromUrl(tab.url),source:'codexpro',at:submitStartedAt});
    const cleanupAttempt=async()=>{
      try{
        await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:cleanupChatRequestDraftPage,args:[attemptId]}),DOM_ACTION_TIMEOUT_MS,'Cleanup composer timeout.');
      }catch{}
    };
    const resultForNetwork=async(networkAck,injectedResult={})=>{
      pendingConversationByTab.delete(tab.id);
      await clearChatAttachmentOwnership(tab.id,attemptId);
      const submittedBy=String(injectedResult.submitted_by||'network-observed');
      const networkEvidence=recentChatPostEvidence(tab.id,submitStartedAt-100);
      const shared={network_tracking:true,network_acknowledged:true,network_stream_capture_installed:networkCaptureInstalled,submission_state:'submitted',generation_state:networkAck.network_state,network_state:networkAck.network_state,network_generation_endpoint:networkAck.network_generation_endpoint,network_error:networkAck.network_error,network_status_code:networkAck.network_status_code,network_evidence:networkEvidence,command_queued_ms:commandQueuedMs,...injectedResult,submitted:true,submitted_by:submittedBy};
      if(networkAck.network_state==='failed'){
        const limit=await probeConversationLimit(tab.id);
        if(limit.reached)throw new Error('CONVERSATION_LIMIT_REACHED: '+(limit.message||'ChatGPT báo đoạn chat đã đạt giới hạn độ dài.'));
      }
      if(newChat){
        let created=null;
        try{created=await waitForConversationUrl(tab.id,Math.max(1000,Math.min(networkAck.network_state==='failed'?5000:15000,remainingCommandMs()-1000)));}catch{}
        if(created?.conversationId){
          await bindConversationToTab(tab.id,created.conversationId);
          recentConversationCache={at:0,items:[]};
          return {action,target_id:tab.id,conversation_id:created.conversationId,new_chat:true,...shared};
        }
        return {action,target_id:tab.id,conversation_id:'',new_chat:true,...shared,conversation_pending:true};
      }
      await bindConversationToTab(tab.id,conversationId);
      return {action,target_id:tab.id,conversation_id:conversationId,...shared};
    };
    let injected;
    let preparationRecovery={prepare_attempts:1,renderer_reloaded:false};
    const prepareErrors=[];
    for(let prepareAttempt=0;prepareAttempt<2;prepareAttempt+=1){
      try{
        const currentPrepareTimeoutMs=Math.max(1000,Math.min(prepareTimeoutMs,remainingCommandMs()-1500));
        deadlineAt=Math.min(Date.now()+currentPrepareTimeoutMs-500,commandDeadlineAt-1000);
        [injected]=await promiseWithTimeout(
          chrome.scripting.executeScript({target:{tabId:tab.id},func:sendChatRequestPage,args:[text,attachments,attemptId,deadlineAt,staleAttachmentOwnership]}),
          currentPrepareTimeoutMs,
          attachments.length?'Chrome renderer không phản hồi khi chuẩn bị file đính kèm.':'Chrome renderer không phản hồi khi chuẩn bị tin nhắn.'
        );
        const prepareResult=injected?.result;
        const recoverablePrepareFailure=prepareResult?.ok===false&&(prepareResult.expired||/không tìm thấy ô nhập|ô nhập chatgpt.*biến mất|renderer/i.test(String(prepareResult.error||'')));
        if(recoverablePrepareFailure)throw new Error('PREPARE_RECOVERABLE: '+String(prepareResult.error||'ChatGPT chưa sẵn sàng để nhập tin nhắn.'));
        preparationRecovery={...preparationRecovery,prepare_attempts:prepareAttempt+1,prepare_recovered:prepareAttempt>0};
        break;
      }catch(error){
        const prepareError=String(error?.message||error).slice(0,500);
        prepareErrors.push(prepareError);
        const hardRendererHang=/Chrome renderer không phản hồi/i.test(prepareError);
        let networkAck=null;
        try{if(remainingCommandMs()>500)networkAck=await waitForNetworkGeneration(tab.id,submitStartedAt-100,Math.max(100,Math.min(5000,remainingCommandMs()-500)));}catch{}
        if(networkAck)return await resultForNetwork(networkAck,{dom_timeout:true,dom_error:prepareError,prepare_attempts:prepareAttempt+1});
        if(!hardRendererHang)await cleanupAttempt();
        if(prepareAttempt===0){
          try{
            if(hardRendererHang){
              const hungTabId=tab.id;
              const recoveryUrl=String(tab.url||(newChat?'https://chatgpt.com/':`https://chatgpt.com/c/${conversationId}`));
              const recoveryWindowId=tab.windowId;
              const recoveryActive=Boolean(tab.active);
              pendingConversationByTab.delete(hungTabId);
              await chrome.tabs.remove(hungTabId);
              tab=await chrome.tabs.create({windowId:recoveryWindowId,url:recoveryUrl,active:recoveryActive});
              await waitForTab(tab.id,Math.max(1000,Math.min(45000,remainingCommandMs()-2000)));
              preparationRecovery={prepare_attempts:2,renderer_reloaded:true,renderer_replaced:true,replaced_tab_id:hungTabId,recovery_tab_id:tab.id,prepare_recovery_reason:prepareError};
            }else{
              await chrome.tabs.reload(tab.id);
              await new Promise(resolve=>setTimeout(resolve,500));
              await waitForTab(tab.id,Math.max(1000,Math.min(45000,remainingCommandMs()-2000)));
              tab=await chrome.tabs.get(tab.id);
              preparationRecovery={prepare_attempts:2,renderer_reloaded:true,renderer_replaced:false,prepare_recovery_reason:prepareError};
            }
            await ensureChatNetworkStreamCapture(tab.id);
            deadlineAt=Math.min(Date.now()+prepareTimeoutMs-1500,commandDeadlineAt-1500);
            pendingConversationByTab.set(tab.id,{conversation_id:newChat?'':conversationId||conversationIdFromUrl(tab.url),source:'codexpro',at:Date.now()});
            continue;
          }catch(reloadError){prepareErrors.push('Reload recovery: '+String(reloadError?.message||reloadError).slice(0,500));}
        }
        pendingConversationByTab.delete(tab.id);
        const limit=await probeConversationLimit(tab.id);
        if(limit.reached)throw new Error('CONVERSATION_LIMIT_REACHED: '+(limit.message||'ChatGPT báo đoạn chat đã đạt giới hạn độ dài.'));
        return {action,target_id:tab.id,conversation_id:newChat?'':conversationId,new_chat:newChat,ok:true,submission_state:'failed',generation_state:'idle',network_state:'idle',network_tracking:true,network_acknowledged:false,submitted:false,submitted_by:'prepare-recovery-retry',submit_path:'prepare-recovery-retry',path_attempted:['prepare',preparationRecovery.renderer_replaced?'replace-tab':'reload','prepare'],send_uncertain:false,error:'PREPARE_FAILED: '+prepareErrors.join(' | '),attempt_id:attemptId,prepare_attempts:prepareAttempt+1,renderer_reloaded:preparationRecovery.renderer_reloaded,renderer_replaced:Boolean(preparationRecovery.renderer_replaced)};
      }
    }
    if(!injected?.result?.ok){
      pendingConversationByTab.delete(tab.id);
      const limit=await probeConversationLimit(tab.id);
      if(limit.reached)throw new Error('CONVERSATION_LIMIT_REACHED: '+(limit.message||'ChatGPT báo đoạn chat đã đạt giới hạn độ dài.'));
      if(injected?.result?.expired)return {action,target_id:tab.id,conversation_id:newChat?'':conversationId,new_chat:newChat,ok:true,submission_state:'failed',generation_state:'idle',network_state:'idle',network_tracking:true,network_acknowledged:false,submitted:false,submitted_by:'prepare-timeout',submit_path:'prepare-timeout',path_attempted:['prepare'],send_uncertain:false,error:`${attachments.length?'ATTACHMENT_PREPARE_TIMEOUT':'PREPARE_TIMEOUT'}: ${injected.result.error||'Lần chuẩn bị đã hết hạn trước khi phát lệnh gửi.'}`,attempt_id:attemptId,cleanup:injected.result.cleanup};
      if(newChat)await chrome.tabs.remove(tab.id).catch(()=>{});
      throw new Error(injected?.result?.error||'Không gửi được yêu cầu vào ChatGPT.');
    }
    if(injected.result.stale_owned_cleanup?.source==='extension-ownership'){
      await clearChatAttachmentOwnership(tab.id,String(injected.result.stale_owned_cleanup.attempt_id||''));
    }else if(staleAttachmentOwnership&&!attachments.length&&Number(injected.result.existing_attachment_count||0)===0){
      await clearChatAttachmentOwnership(tab.id,String(staleAttachmentOwnership.attempt_id||''));
    }
    if(attachments.length){
      await rememberChatAttachmentOwnership(tab.id,targetConversationId,attemptId,injected.result.attachment_names||attachments.map(file=>file.name),injected.result.attachment_labels||[]);
    }
    if(remainingCommandMs()<=1500){
      pendingConversationByTab.delete(tab.id);
      const cleanup=await cleanupAttempt();
      return {action,target_id:tab.id,conversation_id:newChat?'':conversationId,new_chat:newChat,ok:true,submission_state:'failed',generation_state:'idle',network_state:'idle',network_tracking:true,network_acknowledged:false,submitted:false,submitted_by:'command-expired-pre-dispatch',submit_path:'command-expired-pre-dispatch',path_attempted:['prepare'],send_uncertain:false,error:'COMMAND_EXPIRED_PRE_DISPATCH: Lệnh hết hạn sau bước chuẩn bị nhưng trước trusted input; chưa gửi và có thể thử lại an toàn.',attempt_id:attemptId,command_queued_ms:commandQueuedMs,cleanup};
    }
    const preparationPath=preparationRecovery.renderer_reloaded?['prepare',preparationRecovery.renderer_replaced?'replace-tab':'reload','prepare']:[];
    let submitResult={...injected.result,...preparationRecovery,submit_path:'trusted-enter',path_attempted:[...preparationPath,'trusted-enter'],trusted_enter_dispatched:false,trusted_click_dispatched:false,submitted_by:'trusted-enter'};
    if(injected.result.requires_trusted_submit){
      if(attachments.length&&!injected.result.attachment_reused){
        try{
          const uploadAck=await waitForAttachmentUploadNetwork(tab.id,submitStartedAt-100,Math.max(1000,Math.min(ATTACHMENT_UPLOAD_TIMEOUT_MS,remainingCommandMs()-1500)));
          submitResult={...submitResult,attachment_upload_acknowledged:true,attachment_upload_endpoint:uploadAck.endpoint,attachment_upload_fallback:Boolean(uploadAck.fallback)};
        }catch(error){
          pendingConversationByTab.delete(tab.id);
          const cleanup=await cleanupAttempt();
          return {action,target_id:tab.id,conversation_id:newChat?'':conversationId,new_chat:newChat,...submitResult,ok:true,submission_state:'failed',generation_state:'idle',network_state:'idle',network_tracking:true,network_acknowledged:false,submitted:false,send_uncertain:false,error:'ATTACHMENT_UPLOAD_FAILED: '+String(error?.message||error),attempt_id:attemptId,cleanup};
        }
      }else if(attachments.length){
        submitResult={...submitResult,attachment_upload_acknowledged:true,attachment_upload_endpoint:'existing-composer-file',attachment_upload_fallback:true};
      }
      const attachmentSubmit=attachments.length>0;
      if(attachmentSubmit)submitResult={...submitResult,submit_path:'dom-click-attachment',path_attempted:[...preparationPath,'dom-click-attachment'],submitted_by:'dom-click-attachment'};
      try{
        const trustedSubmit=await promiseWithTimeout(
          attachmentSubmit?submitChatAttachmentButtonTab(tab.id,attemptId,text):trustedSubmitChatComposerTab(tab.id,attemptId,text),
          TRUSTED_INPUT_TIMEOUT_MS,
          attachmentSubmit?'Chrome không phản hồi khi submit attachment trong page context.':'Chrome không phản hồi khi gửi bằng Enter trusted.'
        );
        submitResult=attachmentSubmit
          ? {...submitResult,dom_click_dispatched:true,...trustedSubmit}
          : {...submitResult,trusted_enter_dispatched:true,...trustedSubmit};
      }catch(error){
        let networkAck=null;
        try{if(remainingCommandMs()>500)networkAck=await waitForNetworkGeneration(tab.id,submitStartedAt-100,Math.max(100,Math.min(3000,remainingCommandMs()-500)));}catch{}
        const trustedSubmitError=String(error?.message||error).slice(0,300);
        if(networkAck)return await resultForNetwork(networkAck,{...submitResult,...(attachmentSubmit?{dom_click_error:trustedSubmitError}:{trusted_enter_error:trustedSubmitError})});
        const definitelyNotDispatched=trustedSubmitError.startsWith(attachmentSubmit?'ATTACHMENT_DOM_CLICK_PRE_DISPATCH:':'TRUSTED_ENTER_PRE_DISPATCH:');
        if(definitelyNotDispatched&&!attachmentSubmit&&remainingCommandMs()>1500){
          try{
            const [fallbackReady]=await promiseWithTimeout(
              chrome.scripting.executeScript({target:{tabId:tab.id},func:prepareTrustedClickFallbackPage,args:[attemptId,text]}),
              DOM_ACTION_TIMEOUT_MS,
              'Chrome không phản hồi khi chuẩn bị trusted click sau lỗi focus pre-dispatch.'
            );
            if(!fallbackReady?.result?.ok)throw new Error(fallbackReady?.result?.error||'Không tìm thấy nút Send sau lỗi focus pre-dispatch.');
            await promiseWithTimeout(
              trustedActivateChatSendButtonTab(tab.id,attemptId),
              TRUSTED_INPUT_TIMEOUT_MS,
              'Chrome không phản hồi khi bấm Send sau lỗi focus pre-dispatch.'
            );
            submitResult={...submitResult,submit_path:'trusted-click-fallback',path_attempted:[...preparationPath,'trusted-enter-pre-dispatch','trusted-click-fallback'],submitted_by:'trusted-click-fallback',trusted_click_dispatched:true,trusted_enter_error:trustedSubmitError,fallback_reason:'Enter chưa dispatch vì không xác lập được focus; draft vẫn đúng attempt nên dùng trusted click.'};
          }catch(fallbackError){
            submitResult={...submitResult,trusted_enter_error:trustedSubmitError,trusted_click_error:String(fallbackError?.message||fallbackError).slice(0,300)};
          }
        }
        if(submitResult.trusted_click_dispatched) {
          // The safe pre-dispatch fallback was sent; continue to the existing network ACK path.
        } else {
        const evidence=recentChatPostEvidence(tab.id,submitStartedAt-100);
        pendingConversationByTab.delete(tab.id);
        const limit=await probeConversationLimit(tab.id);
        if(limit.reached)throw new Error('CONVERSATION_LIMIT_REACHED: '+(limit.message||'ChatGPT báo đoạn chat đã đạt giới hạn độ dài.'));
        const cleanup=definitelyNotDispatched?await cleanupAttempt():null;
        return {action,target_id:tab.id,conversation_id:newChat?'':conversationId,new_chat:newChat,...submitResult,ok:true,submission_state:definitelyNotDispatched?'failed':'uncertain',generation_state:'idle',network_state:'idle',network_tracking:true,network_acknowledged:false,network_evidence:evidence,submitted:false,send_uncertain:!definitelyNotDispatched,error:`${definitelyNotDispatched?'ATTACHMENT_SUBMIT_FAILED':'SEND_UNCERTAIN'}: ${attachmentSubmit?'Attachment page submit':'Trusted Enter'} không hoàn tất và chưa thấy generation request.${definitelyNotDispatched?' Chưa phát click nên có thể retry an toàn.':' Không tự gửi lại vì trạng thái dispatch chưa chắc chắn, tránh duplicate.'}`,...(attachmentSubmit?{dom_click_error:trustedSubmitError}:{trusted_enter_error:trustedSubmitError}),attempt_id:attemptId,cleanup,cleanup_skipped:!definitelyNotDispatched,cleanup_reason:definitelyNotDispatched?'Chưa phát click attachment; đã dọn đúng draft thuộc attempt.':'Dispatch không chắc chắn.'};
        }
      }

      let earlyAck=null;
      try{earlyAck=await waitForNetworkGeneration(tab.id,submitStartedAt-100,Math.max(100,Math.min(6000,remainingCommandMs()-500)));}catch{}
      if(earlyAck)return await resultForNetwork(earlyAck,submitResult);

      const [attemptState]=await promiseWithTimeout(
        chrome.scripting.executeScript({target:{tabId:tab.id},func:inspectChatSendAttemptPage,args:[attemptId]}),
        DOM_ACTION_TIMEOUT_MS,
        'Chrome không phản hồi khi kiểm tra draft sau trusted Enter.'
      );
      const earlyEvidence=recentChatPostEvidence(tab.id,submitStartedAt-100);
      const submitActivity=earlyEvidence.filter(isChatSubmitLifecycleEvidence);
      const safeClickFallback=remainingCommandMs()>1500&&shouldUseTrustedClickFallback(attemptState?.result,earlyEvidence);
      if(!attachmentSubmit&&safeClickFallback){
        const fallbackReason='Trusted Enter đã dispatch nhưng draft vẫn nguyên và không có request submit nào; dùng trusted click cuối cùng.';
        const [fallbackReady]=await promiseWithTimeout(
          chrome.scripting.executeScript({target:{tabId:tab.id},func:prepareTrustedClickFallbackPage,args:[attemptId,text]}),
          DOM_ACTION_TIMEOUT_MS,
          'Chrome không phản hồi khi chuẩn bị trusted click fallback.'
        );
        if(fallbackReady?.result?.ok){
          try{
            await promiseWithTimeout(
              trustedActivateChatSendButtonTab(tab.id,attemptId),
              TRUSTED_INPUT_TIMEOUT_MS,
              'Chrome không phản hồi khi bấm nút Send fallback.'
            );
            submitResult={...submitResult,submit_path:'trusted-click-fallback',path_attempted:['trusted-enter','trusted-click-fallback'],submitted_by:'trusted-click-fallback',trusted_click_dispatched:true,fallback_reason:fallbackReason};
          }catch(error){
            submitResult={...submitResult,submit_path:'trusted-click-fallback',path_attempted:['trusted-enter','trusted-click-fallback'],submitted_by:'trusted-click-fallback',fallback_reason:fallbackReason,trusted_click_error:String(error?.message||error).slice(0,300)};
          }
        }else submitResult={...submitResult,fallback_reason:fallbackReason,trusted_click_error:String(fallbackReady?.result?.error||'Không chuẩn bị được nút Send fallback.').slice(0,300)};
      }else{
        submitResult={...submitResult,fallback_reason:attemptState?.result?.draft_present?'Không click fallback vì đã thấy submit/network activity; tránh duplicate.':'Draft không còn trong composer; không retry để tránh duplicate.',fallback_skipped:true};
      }
    }

    let networkAck=null;
    try{if(remainingCommandMs()>500)networkAck=await waitForNetworkGeneration(tab.id,submitStartedAt-100,Math.max(100,Math.min(NETWORK_START_TIMEOUT_MS,remainingCommandMs()-500)));}catch{}
    if(!networkAck){
      const evidence=recentChatPostEvidence(tab.id,submitStartedAt-100);
      let attemptState=null;
      try{[attemptState]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:inspectChatSendAttemptPage,args:[attemptId]});}catch{}
      const submitActivity=evidence.filter(isChatSubmitLifecycleEvidence);
      const definitelyUnsent=shouldUseTrustedClickFallback(attemptState?.result,evidence);
      pendingConversationByTab.delete(tab.id);
      const cleanup=definitelyUnsent?await cleanupAttempt():null;
      const limit=await probeConversationLimit(tab.id);
      if(limit.reached)throw new Error('CONVERSATION_LIMIT_REACHED: '+(limit.message||'ChatGPT báo đoạn chat đã đạt giới hạn độ dài.'));
      const reason=submitActivity.length
        ? `Đã thấy submit lifecycle (${submitActivity.map(item=>item.endpoint).join(', ')}) nhưng tracker chưa thấy generation endpoint hoàn tất.`
        : attemptState?.result?.draft_present
          ? 'Draft vẫn còn và không có generation request.'
          : 'Draft đã rời composer nhưng chưa có network ACK.';
      return {action,target_id:tab.id,conversation_id:newChat?'':conversationId,new_chat:newChat,...submitResult,ok:true,submission_state:'uncertain',generation_state:'idle',network_state:'idle',network_tracking:true,network_acknowledged:false,network_evidence:evidence,submitted:false,send_uncertain:true,error:`SEND_UNCERTAIN: ${reason} CodexPro không tự gửi lại để tránh duplicate.`,attempt_id:attemptId,command_queued_ms:commandQueuedMs,command_deadline_reached:remainingCommandMs()===0,cleanup,cleanup_skipped:!definitelyUnsent,cleanup_reason:definitelyUnsent?'Draft được xác nhận chưa gửi.':'Có dấu hiệu submit hoặc draft đã rời composer.'};
    }
    return await resultForNetwork(networkAck,{...submitResult,target_temporarily_activated:targetTemporarilyActivated});
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
    let networkState=await chatRequestState(tab.id,conversationId);
    const networkPayloadOf=(state)=>({
      network_state:state.network_state,
      network_source:state.network_source,
      network_generation_endpoint:state.network_generation_endpoint,
      network_last_started_at:state.network_last_started_at,
      network_last_completed_at:state.network_last_completed_at,
      network_status_code:state.network_status_code,
      network_error:state.network_error,
      network_duration_ms:state.network_duration_ms
    });
    let networkPayload=networkPayloadOf(networkState);
    const networkStream=await chatNetworkStreamCapture(tab.id,conversationId);
    if(networkState.busy&&networkStream.completed&&!networkStream.error){
      await reconcileChatNetworkCompletion(tab.id,conversationId,'network_stream');
      networkState=await chatRequestState(tab.id,conversationId);
      networkPayload=networkPayloadOf(networkState);
    }else if(networkState.busy&&!networkStream.available){
      const startedAt=Date.parse(networkState.network_last_started_at||'');
      if(Number.isFinite(startedAt)&&Date.now()-startedAt>=CANONICAL_COMPLETION_PROBE_AFTER_MS&&await probeCanonicalCompletion(tab.id,conversationId,false)){
        networkState=await chatRequestState(tab.id,conversationId);
        networkPayload=networkPayloadOf(networkState);
      }
    }
    const networkStreamMessages=Array.isArray(networkStream.messages)?networkStream.messages.slice(-20):[];
    const networkStreamText=String(networkStream.text||'');
    const networkStreamActivityText=String(networkStream.activity_text||'').trim().slice(0,220);
    const networkStreamInProgress=Boolean(networkStream.in_progress);
    const effectiveNetworkBusy=Boolean(networkState.busy||networkStreamInProgress);
    const networkStreamPayload={
      network_stream_available:Boolean(networkStream.available&&(networkStreamText||networkStreamMessages.length||networkStreamActivityText)),
      network_stream_capture_installed:Boolean(networkStream.capture_installed),
      network_stream_endpoint:String(networkStream.endpoint||''),
      network_stream_event_count:Number(networkStream.event_count)||0,
      network_stream_error:String(networkStream.error||''),
      network_stream_activity_text:networkStreamActivityText,
      network_stream_in_progress:networkStreamInProgress,
      network_stream_started_at:String(networkStream.started_at||''),
      network_stream_updated_at:String(networkStream.updated_at||'')
    };
    if(args.read_dom===false){
      return {action,target_id:tab.id,ok:true,title:String(tab.title||''),url:String(tab.url||''),text:networkStreamText,text_length:networkStreamText.length,truncated:false,incomplete:effectiveNetworkBusy,incomplete_reason:effectiveNetworkBusy?(networkStreamText?'network_stream_in_progress':networkStreamActivityText?'tool_activity_in_progress':'generation_in_progress'):'',conversation_limit_reached:false,conversation_limit_message:'',message_count:networkStreamMessages.length,total_message_count:networkStreamMessages.length,messages:networkStreamMessages,busy:effectiveNetworkBusy,dom_available:false,dom_skipped:true,dom_error:'',response_source:networkStreamText?'network_stream':networkStreamActivityText?'network_tool_activity':'network_state',updated_at:networkStream.updated_at||new Date().toISOString(),...networkStreamPayload,...networkPayload};
    }
    let canonical={ok:false,error:''};
    try{
      const [canonicalInjection]=await promiseWithTimeout(
        chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:readCanonicalConversationPage,args:[conversationId]}),
        CANONICAL_READ_TIMEOUT_MS,
        'ChatGPT không phản hồi khi đọc conversation canonical.'
      );
      canonical=canonicalInjection?.result||canonical;
    }catch(error){canonical={ok:false,error:String(error?.message||error).slice(0,500)};}
    if(canonical.ok&&canonical.response_ready&&!canonical.busy){
      await reconcileChatNetworkCompletion(tab.id,conversationId,'canonical_api');
      networkState=await chatRequestState(tab.id,conversationId);
      networkPayload=networkPayloadOf(networkState);
    }
    try{
      const [injected]=await promiseWithTimeout(
        chrome.scripting.executeScript({target:{tabId:tab.id},func:readChatResponsePage}),
        DOM_READ_TIMEOUT_MS,
        'Chrome renderer không phản hồi khi đọc DOM.'
      );
      if(!injected?.result?.ok)throw new Error(injected?.result?.error||'Không đọc được phản hồi ChatGPT.');
      let domResult=injected.result;
      const canonicalText=String(canonical.text||'').trim();
      const domTextBeforeMerge=String(domResult.text||'').trim();
      if(canonical.ok&&(canonical.response_ready||canonical.busy||canonicalText.length>domTextBeforeMerge.length)){
        const latestAssistant=[...(canonical.messages||[])].reverse().find(message=>message.role==='assistant');
        domResult={...domResult,text:canonicalText,text_length:canonicalText.length,messages:canonical.messages||domResult.messages,message_count:(canonical.messages||[]).filter(message=>message.role==='assistant').length,total_message_count:(canonical.messages||[]).length,truncated:Boolean(latestAssistant?.truncated),busy:Boolean(canonical.busy),response_ready:Boolean(canonical.response_ready),response_source:'canonical_api',updated_at:new Date().toISOString()};
      }
      const recovery={dom_recovery_checked:false,dom_recovered:false,dom_reloaded:false,dom_replaced:false,replaced_tab_id:0,recovery_tab_id:0,dom_recovery_source:'',dom_recovery_error:''};
      if(args.recover_stale_dom===true&&canonical.ok&&canonical.response_ready&&!canonical.busy){
        recovery.dom_recovery_checked=true;
        try{
          const domText=domTextBeforeMerge;
          const staleContent=canonicalText.length>domText.length&&(!domText||canonicalText.startsWith(domText)||domText.length<160);
          const staleActivity=Boolean(injected.result.busy);
          const stale=staleContent||staleActivity;
          if(stale){
            recovery.dom_recovery_source=staleActivity?'canonical_activity':'canonical_api';
            await new Promise(resolve=>setTimeout(resolve,900));
            await chrome.tabs.reload(tab.id);
            await waitForTab(tab.id,45000);
            recovery.dom_reloaded=true;
            let rendererRefreshed=false;
            const deadline=Date.now()+12000;
            while(Date.now()<deadline){
              await new Promise(resolve=>setTimeout(resolve,400));
              try{
                const [refreshed]=await promiseWithTimeout(
                  chrome.scripting.executeScript({target:{tabId:tab.id},func:readChatResponsePage}),
                  DOM_READ_TIMEOUT_MS,
                  'Chrome renderer không phản hồi sau khi reload conversation.'
                );
                if(refreshed?.result?.ok){rendererRefreshed=true;domResult=refreshed.result;}
                if(!domResult.busy&&String(domResult.text||'').trim().length>=canonicalText.length)break;
              }catch{}
            }
            if(!rendererRefreshed){
              const replaced=await replaceUnresponsiveChatTab(tab,`https://chatgpt.com/c/${conversationId}`);
              tab=replaced.tab;
              recovery.dom_replaced=true;
              recovery.replaced_tab_id=replaced.replaced_tab_id;
              recovery.recovery_tab_id=replaced.recovery_tab_id;
              const [replacementRead]=await promiseWithTimeout(
                chrome.scripting.executeScript({target:{tabId:tab.id},func:readChatResponsePage}),
                DOM_READ_TIMEOUT_MS,
                'Chrome renderer mới không phản hồi sau khi thay tab conversation.'
              );
              if(replacementRead?.result?.ok)domResult=replacementRead.result;
            }
            if(String(domResult.text||'').trim().length<canonicalText.length){
              const latestAssistant=[...(canonical.messages||[])].reverse().find(message=>message.role==='assistant');
              domResult={...domResult,text:canonicalText,text_length:canonicalText.length,messages:canonical.messages||domResult.messages,message_count:(canonical.messages||[]).filter(message=>message.role==='assistant').length,total_message_count:(canonical.messages||[]).length,truncated:Boolean(latestAssistant?.truncated),updated_at:new Date().toISOString()};
            }
            recovery.dom_recovered=String(domResult.text||'').trim().length>=canonicalText.length;
          }else if(!canonical.ok)recovery.dom_recovery_error=String(canonical.error||'Không đọc được conversation canonical.').slice(0,500);
        }catch(error){
          recovery.dom_recovery_error=String(error?.message||error).slice(0,500);
        }
      }
      return {action,target_id:tab.id,...domResult,busy:Boolean(effectiveNetworkBusy||canonical.busy||domResult.busy),dom_available:true,dom_busy:Boolean(domResult.busy),canonical_available:Boolean(canonical.ok),canonical_error:String(canonical.error||''),...networkStreamPayload,...recovery,...networkPayload};
    }catch(error){
      if(canonical.ok){
        const latestAssistant=[...(canonical.messages||[])].reverse().find(message=>message.role==='assistant');
        return {action,target_id:tab.id,ok:true,title:String(tab.title||''),url:String(tab.url||''),text:String(canonical.text||''),text_length:String(canonical.text||'').length,truncated:Boolean(latestAssistant?.truncated),incomplete:Boolean(canonical.busy||networkStreamInProgress),incomplete_reason:canonical.busy?'canonical_generation_in_progress':networkStreamInProgress?'tool_activity_in_progress':'',conversation_limit_reached:false,conversation_limit_message:'',message_count:(canonical.messages||[]).filter(message=>message.role==='assistant').length,total_message_count:(canonical.messages||[]).length,messages:canonical.messages||[],busy:Boolean(effectiveNetworkBusy||canonical.busy),dom_available:false,dom_error:String(error?.message||error).slice(0,500),canonical_available:true,response_ready:Boolean(canonical.response_ready&&!networkStreamInProgress),response_source:'canonical_api',updated_at:new Date().toISOString(),...networkStreamPayload,...networkPayload};
      }
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
        busy:effectiveNetworkBusy,
        dom_available:false,
        dom_error:String(error?.message||error).slice(0,500),
        updated_at:new Date().toISOString(),
        ...networkStreamPayload,
        ...networkPayload
      };
    }
  }
  if(action==='open_tab'){const tab=await chrome.tabs.create({url:args.url,active:false});return {action,target_id:tab.id,title:tab.title||'',url:tab.url||args.url,background:true};}
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
  const executeOnTab=async(action,args)=>{
  if(action==='navigate'){const updated=await chrome.tabs.update(tab.id,{url:args.url});return {action,target_id:tab.id,url:updated.url||args.url,title:updated.title||''};}
  if(action==='batch'){
    const steps=Array.isArray(args.steps)?args.steps.slice(0,50):[];
    if(!steps.length)throw new Error('batch requires at least one step.');
    const allowed=new Set(['snapshot','navigate','click','trusted_click','type','press','hover','scroll','wait_for','inspect_element','evaluate','screenshot']);
    const results=[];
    for(let index=0;index<steps.length;index+=1){
      const step=steps[index]&&typeof steps[index]==='object'?steps[index]:{};
      const stepAction=String(step.action||'');
      if(!allowed.has(stepAction))throw new Error(`Unsupported batch step at index ${index}: ${stepAction||'missing'}`);
      results.push(await executeOnTab(stepAction,{...step,target_id:tab.id,trace:false}));
    }
    return {action,target_id:tab.id,ok:true,step_count:results.length,results};
  }
  if(action==='snapshot'){const [result]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:snapshotPage,args:[Math.max(500,Math.min(50000,args.max_chars||20000)),Boolean(args.delta)]}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi snapshot.');return {action,target_id:tab.id,...result.result};}
  if(action==='click'){const locator=browserLocatorArgs(args);const [result]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:browserElementActionPage,args:['click',locator,'','visible',10000]}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi click.');if(!result.result?.ok)throw new Error(result.result?.error||'Click failed');return {action,target_id:tab.id,selector:args.selector,ref:locator.ref,...result.result};}
  if(action==='trusted_click'){
    const locator=browserLocatorArgs(args);const [located]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:browserElementActionPage,args:['locate',locator,'','visible',10000]}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi định vị trusted click.');
    if(!located?.result?.ok)throw new Error(located?.result?.error||'Trusted click element not found');
    await trustedClickTab(tab.id,Number(located.result.x),Number(located.result.y));
    return {action,target_id:tab.id,selector:args.selector,ok:true,tag:located.result.tag,text:located.result.text};
  }
  if(action==='type'){const locator=browserLocatorArgs(args);const [result]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:browserElementActionPage,args:['type',locator,String(args.text||''),'visible',10000]}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi nhập text.');if(!result.result?.ok)throw new Error(result.result?.error||'Type failed');return {action,target_id:tab.id,selector:args.selector,ref:locator.ref,...result.result};}
  if(action==='hover'){
    const locator=browserLocatorArgs(args);const [located]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:browserElementActionPage,args:['locate',locator,'','visible',10000]}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi định vị hover.');
    if(!located?.result?.ok)throw new Error(located?.result?.error||'Hover element not found');
    await withDebuggerTab(tab.id,target=>chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseMoved',x:Number(located.result.x),y:Number(located.result.y),button:'none'}));
    return {action,target_id:tab.id,selector:args.selector,ok:true,tag:located.result.tag};
  }
  if(action==='scroll'){
    let point={x:0,y:0};
    if(hasBrowserLocator(args)){const locator=browserLocatorArgs(args);const [located]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:browserElementActionPage,args:['locate',locator,'','visible',10000]}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi định vị scroll.');if(!located?.result?.ok)throw new Error(located?.result?.error||'Scroll element not found');point={x:Number(located.result.x),y:Number(located.result.y)};}
    else{const [viewport]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>({x:innerWidth/2,y:innerHeight/2})});point=viewport.result;}
    const deltaX=Number.isFinite(Number(args.delta_x))?Number(args.delta_x):0,deltaY=Number.isFinite(Number(args.delta_y))?Number(args.delta_y):600;
    await withDebuggerTab(tab.id,target=>chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseWheel',x:point.x,y:point.y,deltaX,deltaY}));
    return {action,target_id:tab.id,selector:args.selector,delta_x:deltaX,delta_y:deltaY,ok:true};
  }
  if(action==='wait_for'){
    const timeoutMs=Math.max(100,Math.min(60000,Number(args.timeout_ms)||10000));
    const state=['attached','visible','hidden','detached'].includes(String(args.state||''))?String(args.state):'visible';
    const locator=browserLocatorArgs(args);const [result]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:browserElementActionPage,args:['wait_for',locator,String(args.text||''),state,timeoutMs]}),timeoutMs+1500,'Chrome renderer không phản hồi khi wait_for.');
    if(!result?.result?.ok)throw new Error(result?.result?.error||'wait_for failed');
    return {action,target_id:tab.id,selector:args.selector,text:args.text,state,timeout_ms:timeoutMs,...result.result};
  }
  if(action==='inspect_element'){
    const locator=browserLocatorArgs(args);const [result]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:browserElementActionPage,args:['inspect',locator,'','visible',10000]}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi inspect element.');
    if(!result?.result?.ok)throw new Error(result?.result?.error||'inspect_element failed');
    return {action,target_id:tab.id,selector:args.selector,...result.result};
  }
  if(action==='evaluate'){
    const expression=String(args.expression||'').trim();if(!expression)throw new Error('A JavaScript expression is required.');
    const evaluated=await withDebuggerTab(tab.id,target=>chrome.debugger.sendCommand(target,'Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true}));
    if(evaluated?.exceptionDetails)throw new Error(String(evaluated.exceptionDetails.text||'Runtime.evaluate failed'));
    return {action,target_id:tab.id,value:evaluated?.result?.value,persistent_debugger:true};
  }
  if(action==='screenshot'){const capture=await withDebuggerTab(tab.id,async target=>{await promiseWithTimeout(chrome.debugger.sendCommand(target,'Page.enable',{}),SCREENSHOT_TIMEOUT_MS,'Chrome debugger không bật được Page domain để chụp ảnh.');await chrome.debugger.sendCommand(target,'Emulation.setFocusEmulationEnabled',{enabled:true}).catch(()=>{});try{return await promiseWithTimeout(chrome.debugger.sendCommand(target,'Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:Boolean(args.full_page)}),SCREENSHOT_TIMEOUT_MS,'Chrome debugger chụp ảnh quá thời gian cho phép.');}finally{await chrome.debugger.sendCommand(target,'Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});}});return {action,target_id:tab.id,mime_type:'image/png',image_base64:String(capture?.data||''),background_capture:true,persistent_debugger:true,focus_emulation:true};}
  if(action==='press'){
    const target=await acquireDebuggerTab(tab.id);
    try{const key=String(args.key||'');await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'keyDown',key});await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'keyUp',key});}
    finally{releaseDebuggerTab(tab.id);}return {action,target_id:tab.id,key:args.key,ok:true,persistent_debugger:true};
  }
    throw new Error(`Unsupported action: ${action}`);
  };
  return await serializeBrowserTabMutation(tab.id,action,args,()=>withExtensionCdpTrace(tab.id,args,()=>executeOnTab(action,args)));
}

function bridgeErrorEnvelope(error,command) {
  const message=String(error?.message||error||'Chrome extension action failed.').slice(0,4000);
  const code=String(error?.code||message.match(/^([A-Z][A-Z0-9_]+):/)?.[1]||'EXTENSION_ACTION_FAILED').slice(0,160);
  const stage=String(error?.stage||(/PREPARE|UPLOAD/.test(code)?'prepare':/SUBMIT|ENTER|CLICK|SEND/.test(code)?'submit':/NETWORK|ACK/.test(code)?'network':'execute')).slice(0,160);
  const sourceDetails=error?.details&&typeof error.details==='object'&&!Array.isArray(error.details)?error.details:{};
  const details={
    action:String(command?.action||'').slice(0,160),
    command_id:String(command?.id||'').slice(0,160),
    profile_id:String(command?.args?.profile_id||'').slice(0,160),
    target_id:Number.isInteger(Number(command?.args?.target_id))?Number(command.args.target_id):undefined,
    conversation_id:String(command?.args?.conversation_id||'').slice(0,160),
    ...Object.fromEntries(Object.entries(sourceDetails).slice(0,40).map(([key,value])=>[String(key).slice(0,100),typeof value==='string'?value.slice(0,4000):value]))
  };
  return {name:String(error?.name||'CodexProExtensionError').slice(0,120),message,code,stage,action:String(command?.action||'').slice(0,160),details};
}

async function postResult(profile,command,result,error) {
  const response=await fetch(`${BRIDGE}/result`,{method:'POST',headers:HEADERS,body:JSON.stringify({profile,command_id:command.id,result,error:error?bridgeErrorEnvelope(error,command):undefined})});
  if(!response.ok)throw new Error(`CodexPro bridge từ chối kết quả ${command?.action||'action'}: HTTP ${response.status}`);
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

async function replaceUnresponsiveChatTab(tab,recoveryUrl,timeoutMs=45000) {
  if(!tab?.id)throw new Error('Không tìm thấy tab ChatGPT cần khôi phục.');
  let safeUrl='';
  try{
    const parsed=new URL(String(recoveryUrl||tab.url||''));
    if(parsed.origin!=='https://chatgpt.com'||!/^\/(?:c\/[A-Za-z0-9-]{8,160})?\/?$/.test(parsed.pathname))throw new Error();
    safeUrl=parsed.href;
  }catch{throw new Error('URL ChatGPT cần khôi phục không hợp lệ.');}
  const replacedTabId=tab.id;
  const createArgs={url:safeUrl,active:Boolean(tab.active)};
  if(Number.isInteger(tab.windowId))createArgs.windowId=tab.windowId;
  let replacement=await chrome.tabs.create(createArgs);
  try{
    await waitForTab(replacement.id,timeoutMs);
    replacement=await chrome.tabs.get(replacement.id);
    await ensureChatNetworkStreamCapture(replacement.id);
  }catch(error){
    await chrome.tabs.remove(replacement.id).catch(()=>{});
    throw error;
  }
  await ensureChatNetworkStateLoaded();
  const previousState=chatNetworkStateByTab.get(replacedTabId);
  const previousPosts=chatNetworkPostLogByTab.get(replacedTabId);
  const previousVersion=chatNetworkPostVersionByTab.get(replacedTabId);
  if(previousState)chatNetworkStateByTab.set(replacement.id,{...previousState});
  if(previousPosts)chatNetworkPostLogByTab.set(replacement.id,[...previousPosts]);
  if(previousVersion)chatNetworkPostVersionByTab.set(replacement.id,previousVersion);
  pendingConversationByTab.delete(replacedTabId);
  await chrome.tabs.remove(replacedTabId);
  await persistChatNetworkState();
  recentConversationCache={at:0,items:[]};
  scheduleRealtimeProfilePush(0);
  return {tab:replacement,replaced_tab_id:replacedTabId,recovery_tab_id:replacement.id,recovery_url:safeUrl};
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
  let wantedPath='';
  try{wantedPath=new URL(url).pathname;}catch{}
  const reusable=candidates.find(candidate=>{
    try{return new URL(String(candidate.url||'')).pathname===wantedPath;}catch{return false;}
  });
  // Replacing an existing conversation tab with /plugins can be redirected back to
  // the ChatGPT home route. Use an already-open matching route or create a fresh tab.
  const tab=reusable
    ? await chrome.tabs.update(reusable.id,{active:true})
    : await chrome.tabs.create({url,active:true});
  if(tab.windowId)await chrome.windows.update(tab.windowId,{focused:true});
  const loaded=await new Promise((resolve,reject)=>{
    const matches=candidate=>{try{return candidate?.status==='complete'&&new URL(String(candidate.url||'')).pathname===wantedPath;}catch{return false;}};
    const timer=setTimeout(()=>{chrome.tabs.onUpdated.removeListener(listener);reject(new Error('ChatGPT tải trang đích quá lâu.'));},45000);
    const listener=(updatedId,changeInfo,current)=>{
      if(updatedId!==tab.id||!matches(current))return;
      clearTimeout(timer);chrome.tabs.onUpdated.removeListener(listener);resolve(current);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tab.id).then(current=>{
      if(!matches(current))return;
      clearTimeout(timer);chrome.tabs.onUpdated.removeListener(listener);resolve(current);
    }).catch(()=>{});
  });
  return loaded;
}

async function sendPageMessage(tabId,message,timeoutMs=DOM_ACTION_TIMEOUT_MS) {
  try{return await promiseWithTimeout(chrome.tabs.sendMessage(tabId,message),timeoutMs,'ChatGPT UI không phản hồi message của CodexPro.');}
  catch{
    await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId},files:['connector-installer.js']}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi nạp connector installer.');
    return await promiseWithTimeout(chrome.tabs.sendMessage(tabId,message),timeoutMs,'ChatGPT UI không phản hồi sau khi nạp connector installer.');
  }
}

async function sendInstallerMessage(tabId,connector) {
  await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId},files:['connector-installer.js']}),DOM_ACTION_TIMEOUT_MS,'Chrome renderer không phản hồi khi cập nhật connector installer.');
  return await sendPageMessage(tabId,{type:'codexpro-run-connector-installer',connector},120000);
}

async function connectorFingerprint(serverUrl) {
  const bytes=new TextEncoder().encode(String(serverUrl||''));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

async function probeConnectorEndpoint(serverUrl) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch(serverUrl,{
      method:'POST',
      headers:{'content-type':'application/json','accept':'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'CodexPro Profile Bridge',version:'0.5.39'}}}),
      signal:controller.signal
    });
    const body=(await response.text()).slice(0,20000);
    if(!response.ok)throw new Error(`MCP profile endpoint HTTP ${response.status}.`);
    if(!body.includes('"result"')||!body.toLowerCase().includes('codexpro'))throw new Error('MCP profile endpoint không trả về handshake CodexPro hợp lệ.');
    return {ok:true,status:response.status,session:Boolean(response.headers.get('mcp-session-id'))};
  }catch(error){
    if(error?.name==='AbortError')throw new Error('MCP profile endpoint không phản hồi trong 15 giây.');
    throw error;
  }finally{clearTimeout(timer);}
}

async function navigateInstallerTab(tabId,url) {
  await chrome.tabs.update(tabId,{url,active:true});
  await waitForTab(tabId,45000);
  await new Promise(resolve=>setTimeout(resolve,900));
}

async function openConnectorDetailPage() {
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const visible=element=>{if(!(element instanceof Element))return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  const normalized=element=>String(element?.innerText||element?.textContent||'').replace(/\s+/g,' ').trim().toLowerCase();
  const settingsRoot=()=>[...document.querySelectorAll('[role="dialog"],dialog')].filter(visible).find(dialog=>{const value=normalized(dialog);return value.includes('settings')&&value.includes('plugins');})||null;
  const detailReady=()=>{const root=settingsRoot();if(!root)return null;const value=normalized(root);return location.hash.toLowerCase().includes('/plugin_')||(value.includes('codexpro')&&value.includes('connection'))?root:null;};
  if(detailReady())return {ok:true,already_open:true,url:location.href};
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
    const root=settingsRoot();
    const button=root?[...root.querySelectorAll('button')].filter(visible).find(item=>normalized(item)==='codexpro'):null;
    if(button)button.click();
    for(let attempt=0;attempt<10;attempt+=1){if(detailReady())return {ok:true,already_open:false,url:location.href};await sleep(150);}
  }
  return {ok:false,error:'Không mở được trang chi tiết CodexPro trong Settings.',url:location.href};
}

async function ensureConnectorDetailTab(tabId) {
  const [injected]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:openConnectorDetailPage}),30000,'Chrome renderer không phản hồi khi mở chi tiết CodexPro.');
  if(!injected?.result?.ok)throw new Error(injected?.result?.error||'Không mở được trang chi tiết CodexPro trong Settings.');
  return injected.result;
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
    const settingsPluginsUrl='https://chatgpt.com/#settings/Plugins';
    const fingerprint=await connectorFingerprint(connector.server_url);
    const stored=await chrome.storage.local.get(['connectorServerFingerprint']);
    const tab=await openChatGpt(settingsUrl);

    let result=null;
    if(stored.connectorServerFingerprint===fingerprint){
      const checked=await sendPageMessage(tab.id,{type:'codexpro-check-connector'},30000).catch(()=>null);
      if(checked?.ok&&checked.installed)result={ok:true,alreadyInstalled:true,migrationRequired:false};
    }
    if(!result)result=await sendInstallerMessage(tab.id,connector);
    if(!result?.ok)throw new Error(result?.error || 'ChatGPT không hoàn tất thêm CodexPro.');

    if(result.migrationRequired){
      const previousConnectorId=String(result.connectorId||'');
      await navigateInstallerTab(tab.id,settingsPluginsUrl);
      const deleted=await sendPageMessage(tab.id,{type:'codexpro-delete-connector-definition'},45000);
      if(!deleted?.ok)throw new Error(deleted?.error || 'Không xóa được definition CodexPro cũ.');
      await navigateInstallerTab(tab.id,settingsUrl);
      let recreateError=null;
      try{result=await sendInstallerMessage(tab.id,connector);}
      catch(error){recreateError=error;result=null;}
      // Creating a custom plugin can replace ChatGPT's SPA tree before the
      // content-script reply reaches the service worker. Because the old
      // definition was already confirmed deleted above, a fresh list match is
      // sufficient evidence that this create operation completed.
      if(!result?.ok&&deleted.deleted){
        const checked=await sendPageMessage(tab.id,{type:'codexpro-check-connector'},30000).catch(()=>null);
        if(checked?.ok&&checked.installed){
          result={ok:true,alreadyInstalled:false,migrationRequired:false,recreatedAfterDelete:true,replyRecovered:true};
        }
      }
      if(!result?.ok)throw new Error(result?.error || 'ChatGPT chưa tạo lại CodexPro theo profile mới.');
      if(result.migrationRequired&&deleted.deleted){
        // The current plugin list no longer exposes a stable id in its row
        // link. It was absent after Delete and is present again now, so this is
        // necessarily the newly-created profile definition.
        result={...result,migrationRequired:false,recreatedAfterDelete:true,replyRecovered:true,previousConnectorId};
      }
      if(recreateError&&result?.ok)result={...result,recreateReplyError:String(recreateError?.message||recreateError)};
    }

    await navigateInstallerTab(tab.id,settingsPluginsUrl);
    await ensureConnectorDetailTab(tab.id);
    const connected=await sendPageMessage(tab.id,{type:'codexpro-connect-connector-definition'},60000);
    if(!connected?.ok)throw new Error(connected?.error || 'ChatGPT chưa hoàn tất Connection cho CodexPro.');

    const probe=await probeConnectorEndpoint(connector.server_url);
    if(!probe.ok)throw new Error('Không xác minh được MCP endpoint của profile.');

    const saved={ok:true,message:'CodexPro READY · đã gắn đúng MCP theo profile và xác minh endpoint.',at:new Date().toISOString()};
    await chrome.storage.local.set({connectorInstall:saved,connectorServerFingerprint:fingerprint});
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
  const [previousActive]=await chrome.tabs.query({active:true,currentWindow:true});
  const tab=await chrome.tabs.create({url:connector.settings_url || 'https://chatgpt.com/plugins?q=CodexPro',active:true});
  try{
    if(tab.windowId)await chrome.windows.update(tab.windowId,{focused:true});
    await waitForTab(tab.id);
    const result=await sendPageMessage(tab.id,{type:'codexpro-check-connector'},30000);
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
    if(previousActive?.id)await chrome.tabs.update(previousActive.id,{active:true}).catch(()=>{});
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
        if(message.command){
          const heartbeat=setInterval(()=>{void fetch(`${BRIDGE}/register`,{method:'POST',headers:HEADERS,body:JSON.stringify({profile})}).catch(()=>{});},10000);
          try{await postResult(profile,message.command,await execute(message.command));}
          catch(error){await postResult(profile,message.command,null,error);}
          finally{clearInterval(heartbeat);}
        }
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
async function acquireDebuggerTab(tabId) {
  if(!Number.isInteger(tabId))throw new Error('Trusted input target không hợp lệ.');
  const existing=debuggerSessionsByTab.get(tabId);
  if(existing){
    if(existing.detachTimer)clearTimeout(existing.detachTimer);
    existing.detachTimer=null;
    existing.refs+=1;
    return existing.target;
  }
  const target={tabId};
  await chrome.debugger.attach(target,'1.3');
  debuggerSessionsByTab.set(tabId,{target,refs:1,detachTimer:null,attachedAt:Date.now(),lastUsedAt:Date.now()});
  return target;
}

function releaseDebuggerTab(tabId) {
  const session=debuggerSessionsByTab.get(tabId);
  if(!session)return;
  session.refs=Math.max(0,Number(session.refs||0)-1);
  session.lastUsedAt=Date.now();
  if(session.refs>0)return;
  if(session.detachTimer)clearTimeout(session.detachTimer);
  session.detachTimer=setTimeout(()=>{
    const current=debuggerSessionsByTab.get(tabId);
    if(!current||current.refs>0)return;
    debuggerSessionsByTab.delete(tabId);
    void chrome.debugger.detach(current.target).catch(()=>{});
  },DEBUGGER_SESSION_IDLE_MS);
}

async function withDebuggerTab(tabId,callback) {
  const target=await acquireDebuggerTab(tabId);
  try{return await callback(target);}
  finally{releaseDebuggerTab(tabId);}
}

function subscribeDebuggerEvents(tabId,listener) {
  const listeners=debuggerEventSubscribersByTab.get(tabId)||new Set();
  listeners.add(listener);
  debuggerEventSubscribersByTab.set(tabId,listeners);
  return ()=>{listeners.delete(listener);if(!listeners.size)debuggerEventSubscribersByTab.delete(tabId);};
}

chrome.debugger.onEvent.addListener((source,method,params)=>{
  const tabId=source?.tabId;
  if(!Number.isInteger(tabId))return;
  for(const listener of debuggerEventSubscribersByTab.get(tabId)||[]){try{listener({method,params:params||{},receivedAt:Date.now()});}catch{}}
});

function safeExtensionTraceEvent(event) {
  const method=String(event?.method||''),params=event?.params||{},at=Number(event?.receivedAt)||Date.now(),bounded=(value,max)=>String(value??'').slice(0,max),safeUrl=value=>{const raw=bounded(value,8000);try{const url=new URL(raw);url.username='';url.password='';url.hash='';for(const key of [...url.searchParams.keys()])url.searchParams.set(key,'<redacted>');return bounded(url.toString(),2000);}catch{return bounded(raw.split(/[?#]/,1)[0],2000);}};
  if(method==='Network.requestWillBeSent')return {at,event:method,request_id:bounded(params.requestId,160),method:bounded(params.request?.method,16),url:safeUrl(params.request?.url),resource_type:bounded(params.type,40)};
  if(method==='Network.responseReceived')return {at,event:method,request_id:bounded(params.requestId,160),status:Number(params.response?.status)||0,url:safeUrl(params.response?.url),mime_type:bounded(params.response?.mimeType,160),resource_type:bounded(params.type,40)};
  if(method==='Network.loadingFinished')return {at,event:method,request_id:bounded(params.requestId,160),encoded_bytes:Number(params.encodedDataLength)||0};
  if(method==='Network.loadingFailed')return {at,event:method,request_id:bounded(params.requestId,160),error:bounded(params.errorText,500),canceled:Boolean(params.canceled)};
  if(method==='Runtime.consoleAPICalled')return {at,event:method,level:bounded(params.type,40),text:(Array.isArray(params.args)?params.args.map(item=>bounded(item?.value??item?.description,300)).join(' '):'').slice(0,1000)};
  if(method==='Log.entryAdded')return {at,event:method,level:bounded(params.entry?.level,40),source:bounded(params.entry?.source,80),text:bounded(params.entry?.text,1000),url:safeUrl(params.entry?.url)};
  if(['Page.lifecycleEvent','Page.domContentEventFired','Page.loadEventFired','Page.frameNavigated'].includes(method))return {at,event:method,name:bounded(params.name,80),url:safeUrl(params.frame?.url)};
  return null;
}

async function withExtensionCdpTrace(tabId,args,operation) {
  if(!args?.trace)return await operation();
  const target=await acquireDebuggerTab(tabId),events=[],startedAt=Date.now();
  const unsubscribe=subscribeDebuggerEvents(tabId,event=>{const safe=safeExtensionTraceEvent(event);if(safe&&events.length<500)events.push(safe);});
  await Promise.allSettled([
    chrome.debugger.sendCommand(target,'Network.enable',{}),chrome.debugger.sendCommand(target,'Runtime.enable',{}),chrome.debugger.sendCommand(target,'Log.enable',{}),chrome.debugger.sendCommand(target,'Page.enable',{}),chrome.debugger.sendCommand(target,'Page.setLifecycleEventsEnabled',{enabled:true})
  ]);
  try{const result=await operation();const traceMs=Math.max(0,Math.min(10000,Number(args.trace_ms)||750));if(traceMs)await new Promise(resolve=>setTimeout(resolve,traceMs));return {...result,cdp_trace:{started_at:new Date(startedAt).toISOString(),duration_ms:Date.now()-startedAt,event_count:events.length,truncated:events.length>=500,events}};}
  finally{unsubscribe();releaseDebuggerTab(tabId);}
}

function browserActionMutates(action,args={}) {
  if(action==='batch')return (Array.isArray(args.steps)?args.steps:[]).some(step=>browserActionMutates(String(step?.action||''),step));
  return ['navigate','click','trusted_click','type','press','hover','scroll'].includes(action);
}

async function serializeBrowserTabMutation(tabId,action,args,operation) {
  if(!browserActionMutates(action,args))return await operation();
  const previous=browserMutationTailsByTab.get(tabId)||Promise.resolve();let release;
  const gate=new Promise(resolve=>{release=resolve;}),tail=previous.catch(()=>{}).then(()=>gate);
  browserMutationTailsByTab.set(tabId,tail);await previous.catch(()=>{});
  try{return await operation();}
  finally{release();if(browserMutationTailsByTab.get(tabId)===tail)browserMutationTailsByTab.delete(tabId);}
}

chrome.debugger.onDetach.addListener(source=>{
  const tabId=source?.tabId;
  if(!Number.isInteger(tabId))return;
  const session=debuggerSessionsByTab.get(tabId);
  if(session?.detachTimer)clearTimeout(session.detachTimer);
  debuggerSessionsByTab.delete(tabId);
  debuggerEventSubscribersByTab.delete(tabId);
});

async function startCdpChatNetworkTracker(tabId) {
  const existing=cdpNetworkTrackersByTab.get(tabId);
  if(existing)return existing;
  const target=await acquireDebuggerTab(tabId);
  try{await chrome.debugger.sendCommand(target,'Network.enable',{});}
  catch(error){releaseDebuggerTab(tabId);throw error;}
  let settled=false,cleaned=false,matchedRequestId='',matchedUrl='',statusCode=0,startTimeoutId=null,maxTimeoutId=null;
  let resolveStarted;
  const started=new Promise(resolve=>{resolveStarted=resolve;});
  const cleanup=async()=>{
    if(cleaned)return;
    cleaned=true;
    if(startTimeoutId)clearTimeout(startTimeoutId);
    if(maxTimeoutId)clearTimeout(maxTimeoutId);
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    cdpNetworkTrackersByTab.delete(tabId);
    releaseDebuggerTab(tabId);
  };
  const finishStarted=value=>{if(settled)return;settled=true;resolveStarted(value);};
  const onDetach=source=>{
    if(source.tabId!==tabId)return;
    const session=debuggerSessionsByTab.get(tabId);
    if(session?.detachTimer)clearTimeout(session.detachTimer);
    debuggerSessionsByTab.delete(tabId);
    cleaned=true;
    if(startTimeoutId)clearTimeout(startTimeoutId);
    if(maxTimeoutId)clearTimeout(maxTimeoutId);
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    cdpNetworkTrackersByTab.delete(tabId);
    finishStarted({network_acknowledged:false,detached:true});
  };
  const onEvent=(source,method,params)=>{
    if(source.tabId!==tabId)return;
    if(method==='Network.requestWillBeSent'){
      const request=params?.request||{};
      const details={tabId,method:String(request.method||''),url:String(request.url||''),requestId:String(params?.requestId||''),type:String(params?.type||'other').toLowerCase(),documentUrl:String(params?.documentURL||'')};
      recordChatPost(details,'cdp-started');
      if(!matchedRequestId&&isChatGenerationRequest(details)){
        matchedRequestId=details.requestId;matchedUrl=details.url;
        beginChatRequest(details);
        finishStarted({network_acknowledged:true,generation_endpoint:safeChatRequestEndpoint(details.url),request_id:details.requestId});
      }
      return;
    }
    if(!matchedRequestId||String(params?.requestId||'')!==matchedRequestId)return;
    const details={tabId,method:'POST',url:matchedUrl,requestId:matchedRequestId,statusCode,error:''};
    if(method==='Network.responseReceived'){
      statusCode=Number(params?.response?.status)||0;
      recordChatPost({...details,statusCode},'cdp-response',statusCode);
      const current=chatNetworkStateByTab.get(tabId);
      if(current?.request_id===matchedRequestId){chatNetworkStateByTab.set(tabId,{...current,status_code:statusCode});void persistChatNetworkState();}
    }else if(method==='Network.loadingFinished'){
      recordChatPost({...details,statusCode},'cdp-completed',statusCode);
      finishChatRequest({...details,statusCode},'completed');
      void cleanup();
    }else if(method==='Network.loadingFailed'){
      details.error=String(params?.errorText||'CDP Network.loadingFailed');
      recordChatPost(details,'cdp-failed',0,details.error);
      finishChatRequest(details,'failed');
      void cleanup();
    }
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  startTimeoutId=setTimeout(()=>{
    if(!matchedRequestId){finishStarted({network_acknowledged:false,timeout:true});void cleanup();}
  },CDP_NETWORK_START_TIMEOUT_MS);
  maxTimeoutId=setTimeout(()=>{
    void (async()=>{
      if(cleaned)return;
      if(matchedRequestId){
        let recovered=false;
        try{
          const tab=await chrome.tabs.get(tabId);
          const conversationId=conversationIdFromUrl(tab?.url);
          recovered=await probeCanonicalCompletion(tabId,conversationId,true);
        }catch{}
        if(!cleaned&&!recovered){
          const details={tabId,method:'POST',url:matchedUrl,requestId:matchedRequestId,statusCode,error:'CDP generation tracker exceeded maximum lifetime.'};
          recordChatPost(details,'cdp-failed',0,details.error);
          finishChatRequest(details,'failed');
        }
      }else finishStarted({network_acknowledged:false,timeout:true});
      await cleanup();
    })();
  },CDP_NETWORK_TRACKER_MAX_MS);
  const tracker={started,cleanup};
  cdpNetworkTrackersByTab.set(tabId,tracker);
  return tracker;
}

async function trustedClickTab(tabId,x,y) {
  if(!Number.isFinite(x)||!Number.isFinite(y))throw new Error('Trusted click target không hợp lệ.');
  await withDebuggerTab(tabId,async target=>{
    await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'none'});
    await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
    await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});
  });
}

async function trustedActivateChatSendButtonTab(tabId,attemptId) {
  if(!attemptId)throw new Error('Trusted send attempt không hợp lệ.');
  await withDebuggerTab(tabId,async target=>{
    const safeAttempt=String(attemptId).replace(/[\\"\r\n]/g,'');
    const expression=`(()=>{const el=document.querySelector('[data-codexpro-send-attempt="${safeAttempt}"]')||document.querySelector('#composer-submit-button,button[data-testid="send-button"]');if(!el||el.disabled||el.getAttribute('aria-disabled')==='true')return null;el.scrollIntoView({block:'center',inline:'center'});const rect=el.getBoundingClientRect();return rect.width&&rect.height?{x:rect.left+rect.width/2,y:rect.top+rect.height/2}:null;})()`;
    const evaluated=await chrome.debugger.sendCommand(target,'Runtime.evaluate',{expression,returnByValue:true});
    const point=evaluated?.result?.value;
    if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y))throw new Error('Không tìm được tọa độ nút gửi ChatGPT.');
    await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,button:'none'});
    await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1});
    await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1});
  });
}

async function trustedSubmitChatSendButtonTab(tabId,attemptId) {
  if(!attemptId)throw new Error('Trusted attachment send attempt không hợp lệ.');
  let tracker;
  try{tracker=await startCdpChatNetworkTracker(tabId);}
  catch(error){throw new Error('TRUSTED_CLICK_NOT_DISPATCHED: '+String(error?.message||error));}
  try{await trustedActivateChatSendButtonTab(tabId,attemptId);}
  catch(error){await tracker.cleanup();throw new Error('TRUSTED_CLICK_NOT_DISPATCHED: '+String(error?.message||error));}
  return {dispatched:true,page_brought_to_front:false,background_submit:true,focus_emulation_used:false,cdp_tracker_armed:true,cdp_network_acknowledged:false,cdp_generation_endpoint:'',cdp_request_id:'',cdp_tracker_timeout:false};
}

async function submitChatAttachmentButtonTab(tabId,attemptId,expectedText='') {
  if(!attemptId)throw new Error('ATTACHMENT_DOM_CLICK_PRE_DISPATCH: Attachment attempt không hợp lệ.');
  const [ready]=await chrome.scripting.executeScript({target:{tabId},func:prepareTrustedClickFallbackPage,args:[attemptId,expectedText]});
  if(ready?.result?.ok!==true)throw new Error('ATTACHMENT_DOM_CLICK_PRE_DISPATCH: '+(ready?.result?.error||'Không tìm thấy nút Send attachment thuộc đúng attempt.'));
  let tracker;
  try{tracker=await startCdpChatNetworkTracker(tabId);}
  catch(error){throw new Error('ATTACHMENT_DOM_CLICK_PRE_DISPATCH: '+String(error?.message||error));}
  let clicked;
  try{[clicked]=await chrome.scripting.executeScript({target:{tabId},func:clickPreparedChatSendButtonPage,args:[attemptId]});}
  catch(error){await tracker.cleanup();throw new Error('ATTACHMENT_DOM_CLICK_PRE_DISPATCH: '+String(error?.message||error));}
  if(clicked?.result?.ok!==true){await tracker.cleanup();throw new Error('ATTACHMENT_DOM_CLICK_PRE_DISPATCH: '+(clicked?.result?.error||'Attachment click chưa được dispatch.'));}
  return {dispatched:true,dom_click_dispatched:true,page_brought_to_front:false,background_submit:true,focus_emulation_used:false,cdp_tracker_armed:true,cdp_network_acknowledged:false,cdp_generation_endpoint:'',cdp_request_id:'',cdp_tracker_timeout:false};
}

async function trustedSubmitChatComposerTab(tabId,attemptId,expectedText='') {
  if(!attemptId)throw new Error('Trusted composer attempt không hợp lệ.');
  const [focused]=await chrome.scripting.executeScript({target:{tabId},func:focusChatComposerForSubmitPage,args:[attemptId,expectedText]});
  if(focused?.result?.ok!==true)throw new Error('TRUSTED_ENTER_PRE_DISPATCH: '+(focused?.result?.error||'Không xác minh được composer ChatGPT trước khi gửi bằng Enter.'));
  let tracker;
  try{tracker=await startCdpChatNetworkTracker(tabId);}
  catch(error){throw new Error('TRUSTED_ENTER_PRE_DISPATCH: '+String(error?.message||error));}
  const target={tabId};
  let focusEmulationEnabled=false;
  let keyDispatchStarted=false;
  let refocusedResult=null;
  try{
    await chrome.debugger.sendCommand(target,'Emulation.setFocusEmulationEnabled',{enabled:true});
    focusEmulationEnabled=true;
    await new Promise(resolve=>setTimeout(resolve,250));
    const [refocused]=await chrome.scripting.executeScript({target:{tabId},func:focusChatComposerForSubmitPage,args:[attemptId,expectedText]});
    refocusedResult=refocused?.result||null;
    if(refocused?.result?.ok!==true||refocused?.result?.focused!==true&&refocused?.result?.selection_inside!==true)throw new Error(refocused?.result?.error||'Composer mất focus trong background focus emulation lifecycle.');
    await new Promise(resolve=>setTimeout(resolve,250));
    keyDispatchStarted=true;
    await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
    await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'char',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
    await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
  }catch(error){if(focusEmulationEnabled)await chrome.debugger.sendCommand(target,'Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});await tracker.cleanup();throw new Error((keyDispatchStarted?'TRUSTED_ENTER_DISPATCH_UNCERTAIN: ':'TRUSTED_ENTER_PRE_DISPATCH: ')+String(error?.message||error));}
  if(focusEmulationEnabled)await chrome.debugger.sendCommand(target,'Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});
  return {dispatched:true,page_brought_to_front:false,background_submit:true,focus_emulation_used:true,composer_recovered_after_react:Boolean(focused?.result?.composer_recovered_after_react),composer_refocused_after_react:Boolean(refocusedResult?.composer_recovered_after_react),cdp_tracker_armed:true,cdp_network_acknowledged:false,cdp_generation_endpoint:'',cdp_request_id:'',cdp_tracker_timeout:false};
}

async function trustedKeyTab(tabId,key) {
  const normalized=String(key||'').trim();
  if(!['Enter','Tab','Escape','Space'].includes(normalized))throw new Error('Trusted key không hợp lệ.');
  const code=normalized==='Space'?'Space':normalized;
  const virtualKey=normalized==='Enter'?13:normalized==='Tab'?9:normalized==='Escape'?27:32;
  const text=normalized==='Enter'?'\r':normalized==='Space'?' ':'';
  await withDebuggerTab(tabId,async target=>{
    let focusEmulationEnabled=false;
    try{
      await chrome.debugger.sendCommand(target,'Emulation.setFocusEmulationEnabled',{enabled:true});
      focusEmulationEnabled=true;
      await new Promise(resolve=>setTimeout(resolve,100));
      await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'rawKeyDown',key:normalized,code,windowsVirtualKeyCode:virtualKey,nativeVirtualKeyCode:virtualKey});
      if(text)await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'char',key:normalized,code,text,unmodifiedText:text,windowsVirtualKeyCode:virtualKey,nativeVirtualKeyCode:virtualKey});
      await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'keyUp',key:normalized,code,windowsVirtualKeyCode:virtualKey,nativeVirtualKeyCode:virtualKey});
    }finally{if(focusEmulationEnabled)await chrome.debugger.sendCommand(target,'Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});}
  });
}

async function trustedActivateTab(tabId,x,y) {
  if(!Number.isFinite(x)||!Number.isFinite(y))throw new Error('Trusted activate target không hợp lệ.');
  await withDebuggerTab(tabId,async target=>{
    const expression=`(()=>{const el=document.elementFromPoint(${JSON.stringify(x)},${JSON.stringify(y)});if(!el)return false;const target=el.closest?.('button,[role="button"],a,input,select,textarea')||el;target.focus?.({preventScroll:true});return true;})()`;
    await chrome.debugger.sendCommand(target,'Runtime.evaluate',{expression,returnByValue:true});
    await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
    await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'char',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
    await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
  });
}

async function trustedSetTextTab(tabId,x,y,value) {
  if(!Number.isFinite(x)||!Number.isFinite(y))throw new Error('Trusted text target không hợp lệ.');
  const text=String(value??'');
  await withDebuggerTab(tabId,async target=>{
    const expression=`(()=>{const el=document.elementFromPoint(${JSON.stringify(x)},${JSON.stringify(y)});if(!el)return false;const target=el.closest?.('input,textarea,[contenteditable="true"]')||el;target.focus?.({preventScroll:true});if(typeof target.select==='function')target.select();else{const r=document.createRange();r.selectNodeContents(target);const s=getSelection();s.removeAllRanges();s.addRange(r);}return true;})()`;
    const focused=await chrome.debugger.sendCommand(target,'Runtime.evaluate',{expression,returnByValue:true});
    if(focused?.result?.value===false)throw new Error('Không focus được ô nhập ChatGPT.');
    await chrome.debugger.sendCommand(target,'Input.insertText',{text});
  });
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if(message?.type==='codexpro-trusted-click'){
    const tabId=sender.tab?.id;
    const x=Number(message.x);const y=Number(message.y);
    trustedClickTab(tabId,x,y).then(()=>sendResponse({ok:true})).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));
    return true;
  }
  if(message?.type==='codexpro-trusted-key'){
    const tabId=sender.tab?.id;
    trustedKeyTab(tabId,message.key).then(()=>sendResponse({ok:true})).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));
    return true;
  }
  if(message?.type==='codexpro-trusted-activate'){
    const tabId=sender.tab?.id;
    const x=Number(message.x);const y=Number(message.y);
    trustedActivateTab(tabId,x,y).then(()=>sendResponse({ok:true})).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));
    return true;
  }
  if(message?.type==='codexpro-trusted-set-text'){
    const tabId=sender.tab?.id;
    const x=Number(message.x);const y=Number(message.y);
    trustedSetTextTab(tabId,x,y,message.value).then(()=>sendResponse({ok:true})).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));
    return true;
  }
  if(message?.type!=='codexpro-install-connector')return false;
  installConnector().then(sendResponse).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));
  return true;
});
ensureBridgeAlarm();
pollLoop();
