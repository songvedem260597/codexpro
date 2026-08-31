const BRIDGE = 'http://127.0.0.1:9224';
const HEADERS = {'content-type':'application/json','x-codexpro-extension':'profile-bridge-v1'};
const CHAT_REQUEST_STALE_MS = 30 * 60 * 1000;
const CHAT_NETWORK_STATE_KEY = 'codexproChatNetworkStateV1';
const CHAT_ATTACHMENT_OWNERSHIP_KEY = 'codexproChatAttachmentOwnershipV1';
const CHAT_ATTACHMENT_OWNERSHIP_TTL_MS = 30 * 60 * 1000;
const DOM_READ_TIMEOUT_MS = 2500;
const NETWORK_STREAM_READ_TIMEOUT_MS = 650;
const DOM_ACTIVITY_PROBE_TIMEOUT_MS = 800;
const DOM_ACTIVITY_PROBE_CACHE_MS = 5000;
const DOM_ACTIVITY_RECENT_NETWORK_MS = 2*60*1000;
const CANONICAL_ACTIVITY_PROBE_MS = 5000;
const CANONICAL_ACTIVITY_STALE_MS = CHAT_REQUEST_STALE_MS;
const CANONICAL_ACTIVITY_GENERATION_SKEW_MS = 2*1000;
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
const ATTACHMENT_UPLOAD_QUIET_FALLBACK_MS = 2500;
const CONVERSATION_LIMIT_PROBE_TIMEOUT_MS = 1500;
const PENDING_CONVERSATION_TTL_MS = 60 * 1000;
const MAX_CHATGPT_TABS = 3;
const CHAT_TAB_CLEANUP_INTERVAL_MS = 30 * 1000;
const CHAT_TAB_HEALTH_TIMEOUT_MS = 1200;
const CHAT_TAB_HEALTH_FAILURES_TO_CLOSE = 2;
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
const chatCanonicalActivityByTab = new Map();
const chatCanonicalActivityProbesByTab = new Map();
const pendingConversationByTab = new Map();
const chatAttachmentOwnershipByTab = new Map();
const chatDomActivityByTab = new Map();
const chatTabHealthByTab = new Map();
let lastChatTabCleanupAt = 0;
let chatTabCreationTail = Promise.resolve();
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

function isChatGptTabUrl(value) {
  try{const url=new URL(String(value||''));return url.origin==='https://chatgpt.com';}catch{return false;}
}

function planChatTabCleanup(tabs,options={}) {
  const maxTabs=Math.max(1,Number(options.maxTabs)||MAX_CHATGPT_TABS);
  const recentIds=new Set((Array.isArray(options.recentConversationIds)?options.recentConversationIds:[]).map(String));
  const managed=(Array.isArray(tabs)?tabs:[]).filter(tab=>Number.isInteger(tab?.id)&&isChatGptTabUrl(tab?.url));
  const protectedTab=tab=>Boolean(tab.active||tab.pinned||tab.audible||tab.status==='loading'||tab.busy||tab.settling||tab.pending);
  const closable=managed.filter(tab=>!protectedTab(tab));
  const oldest=(left,right)=>Number(left.last_accessed||0)-Number(right.last_accessed||0)||Number(left.id)-Number(right.id);
  const planned=[],reasons={};
  for(const tab of closable.filter(tab=>Number(tab.health_failures||0)>=CHAT_TAB_HEALTH_FAILURES_TO_CLOSE).sort(oldest)){
    planned.push(tab.id);reasons[tab.id]='codexpro_unreachable';
  }
  let remaining=managed.length-planned.length;
  const overflow=Math.max(0,remaining-maxTabs);
  if(overflow){
    const candidates=closable.filter(tab=>!planned.includes(tab.id)).sort((left,right)=>{
      const leftConversation=conversationIdFromUrl(left.url),rightConversation=conversationIdFromUrl(right.url);
      const leftPriority=!leftConversation?0:recentIds.has(leftConversation)?2:1;
      const rightPriority=!rightConversation?0:recentIds.has(rightConversation)?2:1;
      return leftPriority-rightPriority||oldest(left,right);
    });
    for(const tab of candidates.slice(0,overflow)){planned.push(tab.id);reasons[tab.id]='tab_limit';remaining-=1;}
  }
  return {close_ids:planned,reasons,managed_count:managed.length,remaining_count:remaining,max_tabs:maxTabs};
}

async function probeChatGptTabHealth(tabId) {
  try{
    const [injected]=await promiseWithTimeout(
      chrome.scripting.executeScript({target:{tabId},func:()=>({ok:Boolean(document.documentElement)&&location.hostname==='chatgpt.com'})}),
      CHAT_TAB_HEALTH_TIMEOUT_MS,
      'Chrome renderer không phản hồi health probe của CodexPro.'
    );
    return injected?.result?.ok===true;
  }catch{return false;}
}

async function cleanupChatGptTabs(tabSummaries,recentConversations,options={}) {
  const now=Date.now();
  if(options.force!==true&&now-lastChatTabCleanupAt<CHAT_TAB_CLEANUP_INTERVAL_MS)return {skipped:true,closed_count:0};
  lastChatTabCleanupAt=now;
  const maxTabs=Math.max(1,Number(options.maxTabs)||MAX_CHATGPT_TABS);
  await ensureChatAttachmentOwnershipLoaded();
  const rawTabs=(await chrome.tabs.query({url:['https://chatgpt.com/*']})).filter(tab=>Number.isInteger(tab.id));
  const liveIds=new Set(rawTabs.map(tab=>tab.id));
  for(const tabId of chatTabHealthByTab.keys())if(!liveIds.has(tabId))chatTabHealthByTab.delete(tabId);
  const summaryById=new Map((Array.isArray(tabSummaries)?tabSummaries:[]).map(tab=>[tab.id,tab]));
  const probeCandidates=rawTabs.filter(tab=>{
    const summary=summaryById.get(tab.id)||{};
    const debuggerBusy=Number(debuggerSessionsByTab.get(tab.id)?.refs||0)>0;
    return !tab.active&&!tab.pinned&&!tab.audible&&tab.status!=='loading'&&!summary.busy&&!summary.settling&&!pendingConversationByTab.has(tab.id)&&!chatAttachmentOwnershipByTab.has(tab.id)&&!browserMutationTailsByTab.has(tab.id)&&!debuggerBusy;
  });
  await Promise.all(probeCandidates.map(async tab=>{
    const healthy=await probeChatGptTabHealth(tab.id);
    const previous=chatTabHealthByTab.get(tab.id)||{failures:0};
    const failures=healthy?0:Number(previous.failures||0)+1;
    chatTabHealthByTab.set(tab.id,{failures,last_probe_at:now});
  }));
  const policyTabs=rawTabs.map(tab=>{
    const summary=summaryById.get(tab.id)||{};
    const debuggerBusy=Number(debuggerSessionsByTab.get(tab.id)?.refs||0)>0;
    const pending=pendingConversationByTab.has(tab.id)||chatAttachmentOwnershipByTab.has(tab.id)||browserMutationTailsByTab.has(tab.id)||debuggerBusy;
    return {...tab,...summary,last_accessed:Number(tab.lastAccessed)||0,pending,health_failures:Number(chatTabHealthByTab.get(tab.id)?.failures||0)};
  });
  const plan=planChatTabCleanup(policyTabs,{
    maxTabs,
    recentConversationIds:(Array.isArray(recentConversations)?recentConversations:[]).map(item=>item?.id)
  });
  const closed=[];
  for(const tabId of plan.close_ids){
    try{
      const current=await chrome.tabs.get(tabId);
      const summary=summaryById.get(tabId)||{};
      const conversationId=conversationIdFromUrl(current.url);
      const networkState=await chatRequestState(tabId,conversationId);
      const canonicalActivity=canonicalActivityState(tabId,conversationId);
      const domActivity=chatDomActivityByTab.get(tabId)?.value;
      const debuggerBusy=Number(debuggerSessionsByTab.get(tabId)?.refs||0)>0;
      if(current.active||current.pinned||current.audible||current.status==='loading'||pendingConversationByTab.has(tabId)||chatAttachmentOwnershipByTab.has(tabId)||browserMutationTailsByTab.has(tabId)||debuggerBusy||summary.busy||summary.settling||networkState.busy||canonicalActivity.busy||domActivity?.busy)continue;
      await chrome.tabs.remove(tabId);
      closed.push({tab_id:tabId,reason:plan.reasons[tabId]||'tab_limit'});
    }catch{}
  }
  if(closed.length){
    await chrome.storage.local.set({codexproChatTabCleanup:{at:new Date().toISOString(),max_tabs:maxTabs,closed}}).catch(()=>{});
    recentConversationCache={at:0,items:[]};
    scheduleRealtimeProfilePush(0);
  }
  return {...plan,closed,closed_count:closed.length};
}

async function serializeChatGptTabCreation(operation) {
  const previous=chatTabCreationTail;
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const tail=previous.catch(()=>{}).then(()=>gate);
  chatTabCreationTail=tail;
  await previous.catch(()=>{});
  try{return await operation();}
  finally{
    release();
    if(chatTabCreationTail===tail)chatTabCreationTail=Promise.resolve();
  }
}

async function createChatGptTab(createArgs={}) {
  const url=String(createArgs?.url||'https://chatgpt.com/');
  if(!isChatGptTabUrl(url))return await chrome.tabs.create(createArgs);
  return await serializeChatGptTabCreation(async()=>{
    let current=(await chrome.tabs.query({url:['https://chatgpt.com/*']})).filter(tab=>Number.isInteger(tab.id));
    if(current.length>=MAX_CHATGPT_TABS){
      const summaries=await tabList();
      const recentConversations=await recentConversationList(MAX_CHATGPT_TABS);
      await cleanupChatGptTabs(summaries,recentConversations,{force:true,maxTabs:MAX_CHATGPT_TABS-1});
      current=(await chrome.tabs.query({url:['https://chatgpt.com/*']})).filter(tab=>Number.isInteger(tab.id));
    }
    if(current.length>=MAX_CHATGPT_TABS)throw new Error(`CHAT_TAB_LIMIT_REACHED: Worker chỉ cho phép tối đa ${MAX_CHATGPT_TABS} tab ChatGPT; các tab hiện tại đều đang hoạt động hoặc được bảo vệ.`);
    return await chrome.tabs.create(createArgs);
  });
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
    beginCanonicalActivityGeneration(details.tabId,context.conversation_id,now);
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
  const canonicalActivity=chatCanonicalActivityByTab.get(tabId);
  if(canonicalActivity&&!canonicalActivity.conversation_id)chatCanonicalActivityByTab.set(tabId,{...canonicalActivity,conversation_id:String(conversationId)});
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
        if(!profile.enabled)return;
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
chrome.tabs.onRemoved.addListener(tabId=>{pendingConversationByTab.delete(tabId);void clearChatAttachmentOwnership(tabId);chatDomActivityByTab.delete(tabId);chatTabHealthByTab.delete(tabId);chatCanonicalActivityByTab.delete(tabId);chatCanonicalActivityProbesByTab.delete(tabId);chatNetworkPostLogByTab.delete(tabId);chatNetworkPostVersionByTab.delete(tabId);canonicalCompletionProbeAtByTab.delete(tabId);const postWaiters=chatNetworkPostWaitersByTab.get(tabId);if(postWaiters){chatNetworkPostWaitersByTab.delete(tabId);for(const waiter of postWaiters){clearTimeout(waiter.timer);waiter.reject(new Error('Tab ChatGPT đã đóng trong lúc chờ upload network.'));}}rejectChatNetworkWaiters(tabId,new Error('Tab ChatGPT đã đóng trong lúc chờ network ACK.'));const tracker=cdpNetworkTrackersByTab.get(tabId);if(tracker)void tracker.cleanup();const session=debuggerSessionsByTab.get(tabId);if(session?.detachTimer)clearTimeout(session.detachTimer);debuggerSessionsByTab.delete(tabId);debuggerEventSubscribersByTab.delete(tabId);browserMutationTailsByTab.delete(tabId);void (async()=>{await ensureChatNetworkStateLoaded();chatNetworkStateByTab.delete(tabId);await persistChatNetworkState();})();});

async function profileInfo() {
  const stored = await chrome.storage.local.get(['profileId','active','connectorInstall','connectorServerFingerprint','workerEnabled','workerEnabledUpdatedAt']);
  const profileId = stored.profileId || crypto.randomUUID();
  if (!stored.profileId) await chrome.storage.local.set({profileId});
  let email = '';
  try { email = (await chrome.identity.getProfileUserInfo({accountStatus:'ANY'})).email || ''; } catch {}
  return {id:profileId,email,label:email || `Chrome ${profileId.slice(0,8)}`,version:chrome.runtime.getManifest().version,connector_install:stored.connectorInstall||null,connector_server_fingerprint:String(stored.connectorServerFingerprint||''),active:Boolean(stored.active),enabled:stored.workerEnabled!==false,worker_enabled_updated_at:Math.max(0,Number(stored.workerEnabledUpdatedAt)||0)};
}

async function confirmConnectorFromLiveToolActivity(tabs) {
  const observed=Array.isArray(tabs)&&tabs.some(tab=>Boolean(tab?.busy||tab?.settling)&&/^CodexPro đang\b/i.test(String(tab?.activity_text||'').trim()));
  if(!observed)return false;
  // Tool activity proves that some CodexPro definition is callable, but it
  // does not prove that its URL carries this Chrome profile id. Only the
  // fingerprint saved by installConnector may mark a connector profile-bound.
  return false;
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
  const conversationTurns=Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
  const assistantNodes=Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  const latestUserTurnIndex=conversationTurns.findLastIndex(turn=>Boolean(turn.querySelector?.('[data-message-author-role="user"]')));
  const assistantAfterLatestUser=latestUserTurnIndex>=0
    ? conversationTurns.slice(latestUserTurnIndex+1).map(turn=>turn.querySelector?.('[data-message-author-role="assistant"]')).filter(Boolean).at(-1)
    : assistantNodes.at(-1);
  const latestAssistant=assistantAfterLatestUser||assistantNodes.at(-1);
  const latestText=String(latestAssistant?.innerText||latestAssistant?.textContent||'').replace(/\u200b/g,'').trim();
  const thinkingPlaceholder=/(?:^|\n)(?:thinking|đang suy nghĩ)(?:\s*[.…]{1,3})?$/i.test(latestText);
  const latestTurn=conversationTurns.at(-1);
  const imageGenerationLoading=Boolean(latestTurn?.querySelector?.('[data-testid="image-gen-loading-state"],[data-testid="image-gen-loading-state-frame"],[aria-label^="Generating image" i]'));
  const generatedImage=Array.from(latestTurn?.querySelectorAll?.('img')||[]).find(image=>{
    const alt=String(image.getAttribute?.('alt')||'').trim();
    const src=String(image.currentSrc||image.src||'');
    const generatedWrapper=image.closest?.('[class*="imagegen-image"],[id^="image-"]');
    return Boolean((/^Generated image:/i.test(alt)||/\/backend-api\/estuary\/content(?:\?|$)/i.test(src)||generatedWrapper)&&(Number(image.naturalWidth)||Number(image.width)||src));
  });
  const imageResponseReady=Boolean(generatedImage&&!imageGenerationLoading);
  const pageText=String(document.body?.innerText||document.body?.textContent||'').replace(/\u200b/g,' ');
  const connectionInterrupted=/connection interrupted\.\s*waiting for the complete answer/i.test(pageText);
  const messageDeliveryTimedOut=/message delivery timed out\.\s*please try again/i.test(pageText);
  const recoveryRequired=connectionInterrupted||messageDeliveryTimedOut;
  const toolCallVisible=Array.from(latestTurn?.querySelectorAll?.('button,[role="button"],summary')||[]).some(control=>visible(control)&&/^(?:called|calling) tool\b|^(?:đã|đang) gọi tool\b/i.test(String(control.getAttribute?.('aria-label')||control.innerText||control.textContent||'').trim()));
  const toolCallActive=Boolean(!imageGenerationLoading&&!imageResponseReady&&stopControl&&toolCallVisible);
  const busy=Boolean(imageGenerationLoading||!imageResponseReady&&(stopControl||thinkingPlaceholder||recoveryRequired));
  const responseReady=Boolean(imageResponseReady||assistantAfterLatestUser&&!busy);
  const activityText=imageGenerationLoading?'ChatGPT đang tạo ảnh':messageDeliveryTimedOut?'Phản hồi quá hạn · đang khôi phục nội dung':connectionInterrupted?'Kết nối phản hồi bị ngắt · đang khôi phục':toolCallActive?'CodexPro đang gọi tool':thinkingPlaceholder&&!imageResponseReady?'ChatGPT đang suy nghĩ':stopControl&&!imageResponseReady?'ChatGPT đang tiếp tục xử lý':'';
  const source=imageGenerationLoading?'dom_image_generation':imageResponseReady?'dom_image_ready':responseReady?'dom_response_ready':messageDeliveryTimedOut?'dom_message_delivery_timeout':connectionInterrupted?'dom_connection_interrupted':toolCallActive?'dom_tool':stopControl?'dom_stop':thinkingPlaceholder?'dom_thinking':'';
  return {busy,response_ready:responseReady,source,activity_text:activityText,image_generation_in_progress:imageGenerationLoading,image_response_ready:imageResponseReady,connection_interrupted:recoveryRequired,message_delivery_timed_out:messageDeliveryTimedOut,observed_at:Date.now()};
}

async function chatDomActivityState(tabId,conversationId,options={}) {
  if(!Number.isInteger(tabId)||!conversationId)return {available:false,busy:false,source:'',activity_text:''};
  const now=Date.now();
  const fresh=options?.fresh===true;
  const maxAgeMs=Number.isFinite(Number(options?.maxAgeMs))?Math.max(0,Number(options.maxAgeMs)):DOM_ACTIVITY_PROBE_CACHE_MS;
  let cached=chatDomActivityByTab.get(tabId);
  if(cached?.promise){
    const pendingValue=await cached.promise;
    if(!fresh)return pendingValue;
    cached=chatDomActivityByTab.get(tabId);
  }
  if(!fresh&&cached?.value&&now-Number(cached.at||0)<maxAgeMs)return cached.value;
  const promise=(async()=>{
    try{
      const [injected]=await promiseWithTimeout(
        chrome.scripting.executeScript({target:{tabId},func:probeChatActivityPage}),
        DOM_ACTIVITY_PROBE_TIMEOUT_MS,
        'Chrome renderer không phản hồi khi kiểm tra trạng thái ChatGPT.'
      );
      const result=injected?.result&&typeof injected.result==='object'?injected.result:{};
      return {available:true,busy:Boolean(result.busy),response_ready:Boolean(result.response_ready),source:String(result.source||''),activity_text:String(result.activity_text||'').trim().slice(0,220),image_generation_in_progress:Boolean(result.image_generation_in_progress),image_response_ready:Boolean(result.image_response_ready),connection_interrupted:Boolean(result.connection_interrupted),message_delivery_timed_out:Boolean(result.message_delivery_timed_out),observed_at:Number(result.observed_at)||Date.now()};
    }catch(error){return {available:false,busy:false,response_ready:false,source:'',activity_text:'',image_generation_in_progress:false,image_response_ready:false,error:String(error?.message||error).slice(0,300)};}
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
  for(const tabId of chatCanonicalActivityByTab.keys())if(!liveTabIds.has(tabId))chatCanonicalActivityByTab.delete(tabId);
  for(const tabId of chatCanonicalActivityProbesByTab.keys())if(!liveTabIds.has(tabId))chatCanonicalActivityProbesByTab.delete(tabId);
  const titleOverrides=await getConversationTitleOverrides();
  const summaries=await Promise.all(tabs.map(async tab => {
    const conversationId=conversationIdFromUrl(tab.url);
    let networkState=await chatRequestState(tab.id,conversationId);
    const cachedDomActivity=chatDomActivityByTab.get(tab.id)?.value;
    const networkObservedAt=Math.max(Date.parse(networkState.network_last_started_at||'')||0,Date.parse(networkState.network_last_completed_at||'')||0);
    let canonicalActivity=canonicalActivityState(tab.id,conversationId);
    const shouldProbeCanonical=Boolean(conversationId&&(networkState.busy||canonicalActivity.busy||Date.now()-networkObservedAt<DOM_ACTIVITY_RECENT_NETWORK_MS));
    if(shouldProbeCanonical)canonicalActivity=await probeCanonicalActivity(tab.id,conversationId);
    const shouldProbeDom=Boolean(conversationId&&(tab.active||networkState.busy||canonicalActivity.busy||cachedDomActivity?.busy||Date.now()-networkObservedAt<DOM_ACTIVITY_RECENT_NETWORK_MS));
    const domActivity=shouldProbeDom?await chatDomActivityState(tab.id,conversationId):{available:false,busy:false,response_ready:false,source:'',activity_text:'',image_generation_in_progress:false,image_response_ready:false};
    if(domActivity.response_ready){
      if(canonicalActivity.busy){
        canonicalActivity={...canonicalActivity,busy:false,response_ready:true,busy_since:0,last_checked_at:Date.now()};
        chatCanonicalActivityByTab.set(tab.id,canonicalActivity);
      }
      if(networkState.busy){
        await reconcileChatNetworkCompletion(tab.id,conversationId,domActivity.image_response_ready?'dom_image':'dom_response');
        networkState=await chatRequestState(tab.id,conversationId);
      }
    }
    const networkStream=conversationId&&networkState.network_state!=='idle'?await chatNetworkStreamCapture(tab.id,conversationId):{};
    const titleOverride=conversationId?titleOverrides[conversationId]:null;
    const streamBusy=Boolean(networkStream.in_progress&&!domActivity.response_ready);
    const networkBusy=Boolean(networkState.busy||streamBusy);
    const domImageBusy=Boolean(domActivity.image_generation_in_progress);
    const domToolBusy=Boolean(domActivity.busy&&domActivity.source==='dom_tool');
    const canonicalBusy=Boolean(canonicalActivity.busy&&!domActivity.response_ready);
    const streamActivity=String(networkStream.activity_text||'').trim().slice(0,220);
    return {
      id:tab.id,
      window_id:tab.windowId,
      active:Boolean(tab.active),
      pinned:Boolean(tab.pinned),
      audible:Boolean(tab.audible),
      status:String(tab.status||''),
      last_accessed:Number(tab.lastAccessed)||0,
      title:String(titleOverride?.title||tab.title||''),
      url:tab.url || '',
      busy:networkBusy||domImageBusy||domToolBusy||canonicalBusy,
      settling:!networkBusy&&!domImageBusy&&!domToolBusy&&!canonicalBusy&&domActivity.busy,
      busy_request_count:Math.max(Number(networkState.busy_request_count)||0,domImageBusy||canonicalBusy?1:0),
      busy_since:networkState.busy_since||(canonicalBusy&&canonicalActivity.busy_since?new Date(canonicalActivity.busy_since).toISOString():''),
      busy_source:streamBusy?'network_stream':networkState.busy?'network':domImageBusy?'dom_image_generation':domToolBusy?'dom_tool':canonicalBusy?'canonical':domActivity.busy?domActivity.source:'',
      activity_text:streamBusy?(streamActivity||'CodexPro đang sử dụng tool'):domImageBusy?domActivity.activity_text:domToolBusy?domActivity.activity_text:canonicalBusy?'ChatGPT đang tiếp tục xử lý':domActivity.busy?domActivity.activity_text:'',
      network_stream_in_progress:streamBusy,
      dom_busy:domActivity.busy,
      image_generation_in_progress:Boolean(domActivity.image_generation_in_progress),
      image_response_ready:Boolean(domActivity.image_response_ready),
      response_ready:Boolean(domActivity.response_ready),
      connection_interrupted:Boolean(domActivity.connection_interrupted),
      message_delivery_timed_out:Boolean(domActivity.message_delivery_timed_out),
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
  const composerReadyDeadline=Math.min(Number(deadlineAt)||Date.now()+5000,Date.now()+5000);
  while(!composer&&!expired()&&Date.now()<composerReadyDeadline){await sleep(100);composer=findComposer();}
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
    const stableUntil=Math.min(Number(deadlineAt)||Date.now()+400,Date.now()+400);
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
    clone.querySelectorAll('button,[role="button"],script,style').forEach(control=>control.remove());
    clone.querySelectorAll('a[href]').forEach(anchor=>{
      const href=String(anchor.href||anchor.getAttribute('href')||'').trim();
      if(!/^(?:https?:\/\/|mailto:)/i.test(href))return;
      const label=String(anchor.textContent||'').replace(/\s+/g,' ').trim();
      const escapedLabel=String(label||href).replace(/\\/g,'\\\\').replace(/\[/g,'\\[').replace(/\]/g,'\\]');
      const escapedHref=href.replace(/\(/g,'%28').replace(/\)/g,'%29').replace(/ /g,'%20');
      const markdown=!label||label===href?href:`[${escapedLabel}](${escapedHref})`;
      anchor.replaceWith(document.createTextNode(markdown));
    });
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
  const linksFor=root=>{
    const seen=new Set();
    return Array.from(root?.querySelectorAll?.('a[href]')||[]).map(anchor=>{
      const href=String(anchor.href||anchor.getAttribute('href')||'').trim();
      if(!/^(?:https?:\/\/|mailto:)/i.test(href)||seen.has(href))return null;
      seen.add(href);
      return {text:String(anchor.textContent||'').replace(/\s+/g,' ').trim()||href,href};
    }).filter(Boolean).slice(0,24);
  };
  const generatedImagePreview=async image=>{
    const src=String(image?.currentSrc||image?.src||'').trim();
    if(!src)return null;
    const cache=globalThis.__codexproGeneratedImagePreviewCache||(globalThis.__codexproGeneratedImagePreviewCache={});
    if(cache[src]?.data_url)return cache[src];
    const sourceWidth=Math.max(1,Number(image?.naturalWidth)||Number(image?.width)||1);
    const sourceHeight=Math.max(1,Number(image?.naturalHeight)||Number(image?.height)||1);
    const maximumSide=1200;
    const scale=Math.min(1,maximumSide/Math.max(sourceWidth,sourceHeight));
    const width=Math.max(1,Math.round(sourceWidth*scale));
    const height=Math.max(1,Math.round(sourceHeight*scale));
    let dataUrl='',mimeType='image/jpeg';
    try{
      const canvas=document.createElement('canvas');
      canvas.width=width;canvas.height=height;
      const context=canvas.getContext('2d',{alpha:false});
      if(!context)throw new Error('canvas context unavailable');
      context.drawImage(image,0,0,width,height);
      dataUrl=canvas.toDataURL('image/jpeg',0.9);
    }catch{
      try{
        const response=await fetch(src,{credentials:'include',cache:'force-cache'});
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        const blob=await response.blob();
        mimeType=String(blob.type||'image/png');
        dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(reader.error||new Error('read failed'));reader.readAsDataURL(blob);});
      }catch{return null;}
    }
    if(!dataUrl.startsWith('data:image/'))return null;
    const alt=String(image?.getAttribute?.('alt')||'').trim();
    const fileId=String(src.match(/[?&]id=([^&]+)/)?.[1]||'').trim();
    const preview={
      id:fileId||`generated-${Date.now()}`,
      name:fileId?`${fileId}.jpg`:'Ảnh tạo bởi ChatGPT.jpg',
      alt:alt||'Ảnh tạo bởi ChatGPT',
      mime_type:mimeType,
      width,
      height,
      source_width:sourceWidth,
      source_height:sourceHeight,
      size:Math.max(0,Math.round((dataUrl.length-dataUrl.indexOf(',')-1)*0.75)),
      data_url:dataUrl
    };
    cache[src]=preview;
    const cacheKeys=Object.keys(cache);
    if(cacheKeys.length>6)cacheKeys.slice(0,cacheKeys.length-6).forEach(key=>delete cache[key]);
    return preview;
  };
  const generatedImagesFor=async root=>{
    const seen=new Set();
    const candidates=Array.from(root?.querySelectorAll?.('img')||[]).filter(image=>{
      const alt=String(image.getAttribute?.('alt')||'').trim();
      const src=String(image.currentSrc||image.src||'');
      return /^Generated image:/i.test(alt)||/\/backend-api\/estuary\/content(?:\?|$)/i.test(src)||Boolean(image.closest?.('[class*="imagegen-image"],[id^="image-"]'));
    }).filter(image=>{
      const src=String(image.currentSrc||image.src||'');
      if(!src||seen.has(src))return false;
      seen.add(src);return true;
    }).slice(0,4);
    return (await Promise.all(candidates.map(generatedImagePreview))).filter(Boolean);
  };
  const assistantContentFor=assistantMessage=>{
    if(!assistantMessage)return null;
    const candidates=Array.from(assistantMessage.querySelectorAll('.markdown,.prose,[data-message-content],[class*="markdown"]'));
    const best=candidates.reduce((current,candidate)=>nodeText(candidate).length>nodeText(current).length?candidate:current,null);
    const fullLength=nodeText(assistantMessage).length;
    const bestLength=nodeText(best).length;
    return !best||fullLength>bestLength+24?assistantMessage:best;
  };
  if(!location.pathname.startsWith('/c/'))return {ok:false,error:'Tab đã chọn không phải đoạn chat ChatGPT.'};
  const turnNodes=Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]')).filter(turn=>{
    const style=getComputedStyle(turn);
    return style.display!=='none'&&style.visibility!=='hidden'&&turn.getClientRects().length>0;
  }).slice(-12);
  const messages=(await Promise.all(turnNodes.map(async(turn,index)=>{
    const userMessage=turn.querySelector('[data-message-author-role="user"]');
    const assistantMessage=turn.querySelector('[data-message-author-role="assistant"]');
    if(userMessage){
      const content=userMessage.querySelector('.whitespace-pre-wrap,[class*="whitespace-pre-wrap"],[data-message-content]')||userMessage;
      const raw=nodeText(content);
      const text=raw.slice(0,40000);
      return raw?{id:`user-${index}`,role:'user',text,truncated:raw.length>text.length}:null;
    }
    const images=await generatedImagesFor(turn);
    if(!assistantMessage&&!images.length)return null;
    const content=assistantContentFor(assistantMessage);
    const raw=content?structuredText(content):'';
    const links=content?linksFor(content):[];
    const text=raw.slice(0,40000);
    return raw||images.length?{id:`assistant-${index}`,role:'assistant',text,truncated:raw.length>text.length,...(links.length?{links}:{}),...(images.length?{images}:{})}:null;
  }))).filter(Boolean);
  const latestUserIndex=messages.findLastIndex(message=>message.role==='user');
  const assistantAfterLatestUser=latestUserIndex>=0?messages.slice(latestUserIndex+1).findLast(message=>message.role==='assistant'):[...messages].reverse().find(message=>message.role==='assistant');
  const stopControl=Array.from(document.querySelectorAll('button,[role="button"]')).find(control=>{
    const label=String(control.getAttribute?.('aria-label')||control.innerText||control.textContent||'').trim();
    return /^(?:stop(?: answering| generating| streaming)?|dừng(?: trả lời)?)$/i.test(label);
  });
  const thinkingPlaceholder=/^(?:thinking|đang suy nghĩ)(?:\s*[.…]{1,3})?$/i.test(assistantAfterLatestUser?.text||'');
  const latestTurn=Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]')).at(-1);
  const imageGenerationLoading=Boolean(latestTurn?.querySelector?.('[data-testid="image-gen-loading-state"],[data-testid="image-gen-loading-state-frame"],[aria-label^="Generating image" i]'));
  const generatedImage=Array.from(latestTurn?.querySelectorAll?.('img')||[]).find(image=>{
    const alt=String(image.getAttribute?.('alt')||'').trim();
    const src=String(image.currentSrc||image.src||'');
    return Boolean((/^Generated image:/i.test(alt)||/\/backend-api\/estuary\/content(?:\?|$)/i.test(src)||image.closest?.('[class*="imagegen-image"],[id^="image-"]'))&&(Number(image.naturalWidth)||Number(image.width)||src));
  });
  const imageResponseReady=Boolean(generatedImage&&!imageGenerationLoading);
  const pageText=String(document.body?.innerText||document.body?.textContent||'').replace(/\u200b/g,' ');
  const connectionInterrupted=/connection interrupted\.\s*waiting for the complete answer/i.test(pageText);
  const messageDeliveryTimedOut=/message delivery timed out\.\s*please try again/i.test(pageText);
  const recoveryRequired=connectionInterrupted||messageDeliveryTimedOut;
  const busy=Boolean(imageGenerationLoading||!imageResponseReady&&(stopControl||thinkingPlaceholder||recoveryRequired));
  const responseReady=Boolean(imageResponseReady||assistantAfterLatestUser&&!busy);
  const finalizedMessages=messages.map((message,index)=>message.role==='assistant'?{...message,end_turn:index<latestUserIndex||responseReady}:message);
  const text=assistantAfterLatestUser?.text||'';
  const links=Array.isArray(assistantAfterLatestUser?.links)?assistantAfterLatestUser.links:[];
  return {ok:true,title:document.title,url:location.href,text,text_length:text.length,links,truncated:Boolean(assistantAfterLatestUser?.truncated),incomplete:busy,incomplete_reason:imageGenerationLoading?'image_generation_in_progress':messageDeliveryTimedOut?'message_delivery_timeout':connectionInterrupted?'connection_interrupted':busy?(thinkingPlaceholder?'thinking_placeholder':'generation_in_progress'):'',image_generation_in_progress:imageGenerationLoading,image_response_ready:imageResponseReady,response_kind:imageResponseReady||imageGenerationLoading?'image':'text',connection_interrupted:recoveryRequired,message_delivery_timed_out:messageDeliveryTimedOut,conversation_limit_reached:false,conversation_limit_message:'',conversation_limit_button_label:'',message_count:finalizedMessages.filter(message=>message.role==='assistant').length,total_message_count:finalizedMessages.length,messages:finalizedMessages,busy,response_ready:responseReady,response_source:'chatgpt_dom',updated_at:new Date().toISOString()};
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
    const finalizedMessages=messages=>messages.filter(message=>message.role==='user'||message.end_turn===true).slice(-20);
    const directMessages=Array.isArray(payload?.messages)?payload.messages.map((message,index)=>{
      const role=String(message?.author?.role||message?.role||'');
      if(!['user','assistant'].includes(role))return null;
      const contentType=String(message?.content?.content_type||'');
      if(role==='assistant'&&!['text','multimodal_text'].includes(contentType))return null;
      const text=messageText(message);
      return text?{id:String(message?.id||`${role}-${index}`),role,text:text.slice(0,40000),truncated:text.length>40000,content_type:contentType,status:String(message?.status||''),end_turn:message?.end_turn===true,create_time:Number(message?.create_time)||0,order:index}:null;
    }).filter(Boolean):[];
    if(directMessages.length)return finalizedMessages(directMessages);
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
    return finalizedMessages(nodes.map((node,index)=>{
      const message=node?.message;
      const role=String(message?.author?.role||'');
      if(!['user','assistant'].includes(role))return null;
      const contentType=String(message?.content?.content_type||'');
      if(role==='assistant'&&!['text','multimodal_text','code','tether_browsing'].includes(contentType))return null;
      const text=messageText(message);
      return text?{id:String(message.id||node.id||`${role}-${index}`),role,text:text.slice(0,40000),truncated:text.length>40000,content_type:contentType,status:String(message?.status||''),end_turn:message?.end_turn===true,create_time:Number(message?.create_time)||0,order:index}:null;
    }).filter(Boolean));
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
        const responseReady=Boolean(assistantAfterUser?.end_turn===true);
        if(messages.length)return {ok:true,endpoint,messages,text:assistantAfterUser?.text||'',text_length:String(assistantAfterUser?.text||'').length,response_ready:responseReady,busy:Boolean(latestUserIndex>=0&&!responseReady),latest_user_id:String(messages[latestUserIndex]?.id||''),latest_user_create_time:Number(messages[latestUserIndex]?.create_time)||0,latest_assistant_id:String(assistantAfterUser?.id||latestAssistant?.id||'')};
        lastError=`${endpoint}: conversation chưa có assistant message.`;
      }else lastError=`${endpoint}: ChatGPT HTTP ${response.status}`;
      if(![404,405].includes(response.status))break;
    }
    return {ok:false,error:lastError||'ChatGPT không trả conversation canonical.'};
  }catch(error){return {ok:false,error:String(error?.message||error)};}
}

function canonicalResponseSupersedesDom(canonical,domResult) {
  if(!canonical?.ok)return false;
  const hasAssistantAfterLatestUser=messages=>{
    const usable=Array.isArray(messages)?messages:[];
    const latestUserIndex=usable.findLastIndex(message=>message?.role==='user');
    return latestUserIndex>=0&&usable.slice(latestUserIndex+1).some(message=>message?.role==='assistant'&&String(message?.text||'').trim());
  };
  const canonicalHasResponse=Boolean(canonical.response_ready||hasAssistantAfterLatestUser(canonical.messages));
  const domHasResponse=hasAssistantAfterLatestUser(domResult?.messages);
  if(domHasResponse&&!canonicalHasResponse)return false;
  const canonicalText=String(canonical.text||'').trim();
  const domText=String(domResult?.text||'').trim();
  if(domHasResponse&&canonicalHasResponse&&domText.length>canonicalText.length)return false;
  return canonicalHasResponse||canonicalText.length>domText.length;
}

function shouldReloadChatRecovery(options) {
  const {connectionInterrupted=false,messageDeliveryTimedOut=false,staleContent=false,networkBusy=false,canonicalReady=false,rendererTimedOut=false}=options||{};
  if(rendererTimedOut)return true;
  if(networkBusy)return false;
  if(messageDeliveryTimedOut||connectionInterrupted)return true;
  if(staleContent&&canonicalReady)return true;
  return false;
}

function mergeChatRecoveryResponse(checkpoint,incoming) {
  const before=checkpoint&&typeof checkpoint==='object'?checkpoint:{};
  const after=incoming&&typeof incoming==='object'?incoming:{};
  const normalized=value=>String(value||'').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
  const progressiveText=(previousValue,incomingValue)=>{
    const previous=String(previousValue||'').trim(),next=String(incomingValue||'').trim();
    if(!previous)return next;
    if(!next)return previous;
    const previousComparable=normalized(previous),nextComparable=normalized(next);
    if(previousComparable===nextComparable)return next.length>=previous.length?next:previous;
    if(nextComparable.includes(previousComparable))return next;
    if(previousComparable.includes(nextComparable))return previous;
    const maximumOverlap=Math.min(previous.length,next.length),minimumOverlap=Math.min(12,maximumOverlap);
    for(let size=maximumOverlap;size>=minimumOverlap;size-=1)if(previous.slice(-size)===next.slice(0,size))return previous+next.slice(size);
    return next.length>previous.length?next:previous;
  };
  const previousMessages=Array.isArray(before.messages)?before.messages.filter(message=>String(message?.text||'').trim()):[];
  const incomingMessages=Array.isArray(after.messages)?after.messages.filter(message=>String(message?.text||'').trim()):[];
  let messages=incomingMessages.length?[...incomingMessages]:[...previousMessages];
  if(incomingMessages.length&&previousMessages.length){
    messages=messages.map((message,index)=>{
      if(message?.role!=='assistant')return message;
      const userIndex=messages.slice(0,index).findLastIndex(candidate=>candidate?.role==='user');
      const userText=normalized(messages[userIndex]?.text);
      let previousUserIndex=-1;
      for(let cursor=previousMessages.length-1;cursor>=0;cursor-=1){
        if(previousMessages[cursor]?.role==='user'&&normalized(previousMessages[cursor]?.text)===userText){previousUserIndex=cursor;break;}
      }
      if(previousUserIndex<0)return message;
      const nextUserIndex=previousMessages.findIndex((candidate,cursor)=>cursor>previousUserIndex&&candidate?.role==='user');
      const turnEnd=nextUserIndex<0?previousMessages.length:nextUserIndex;
      const previousAssistant=previousMessages.slice(previousUserIndex+1,turnEnd).findLast(candidate=>candidate?.role==='assistant');
      if(!previousAssistant)return message;
      return {...message,id:previousAssistant.id||message.id,text:progressiveText(previousAssistant.text,message.text),truncated:Boolean(previousAssistant.truncated&&message.truncated)};
    });
    const incomingLatestUserIndex=messages.findLastIndex(message=>message?.role==='user');
    const incomingHasAssistant=incomingLatestUserIndex<0||messages.slice(incomingLatestUserIndex+1).some(message=>message?.role==='assistant');
    const previousLatestUserIndex=previousMessages.findLastIndex(message=>message?.role==='user');
    const sameLatestUser=incomingLatestUserIndex>=0&&previousLatestUserIndex>=0&&normalized(messages[incomingLatestUserIndex]?.text)===normalized(previousMessages[previousLatestUserIndex]?.text);
    if(sameLatestUser&&!incomingHasAssistant&&previousMessages.slice(previousLatestUserIndex+1).some(message=>message?.role==='assistant'))messages=[...previousMessages];
  }
  messages=messages.slice(-12);
  const latestAssistant=[...messages].reverse().find(message=>message?.role==='assistant');
  const text=progressiveText(before.text,latestAssistant?.text||after.text);
  const checkpointApplied=text!==String(after.text||'').trim()||messages.length!==incomingMessages.length||messages.some((message,index)=>message?.text!==incomingMessages[index]?.text);
  return {...before,...after,text,text_length:text.length,messages,message_count:messages.filter(message=>message?.role==='assistant').length,total_message_count:messages.length,response_checkpoint_applied:checkpointApplied};
}

function responseAuditTextSummary(value) {
  const text=String(value||'').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/\u00a0/g,' ').replace(/\r\n/g,'\n').replace(/[ \t]+\n/g,'\n').replace(/\s+/g,' ').trim();
  if(!text)return null;
  let hash=0x811c9dc5;
  for(let index=0;index<text.length;index+=1){hash^=text.charCodeAt(index);hash=Math.imul(hash,0x01000193);}
  return {fingerprint:`${text.length}:${(hash>>>0).toString(16).padStart(8,'0')}`,length:text.length,preview:text.slice(-180)};
}

function responseAuditSnapshot(source,payload,available) {
  const messages=(Array.isArray(payload?.messages)?payload.messages:[]).filter(message=>['user','assistant'].includes(message?.role)&&String(message?.text||'').trim());
  const latestUserIndex=messages.findLastIndex(message=>message.role==='user');
  const assistantAfterLatestUser=latestUserIndex>=0?messages.slice(latestUserIndex+1).findLast(message=>message.role==='assistant'):messages.findLast(message=>message.role==='assistant');
  return {
    source,
    available:Boolean(available),
    response_ready:payload?.response_ready===true,
    busy:payload?.busy===true,
    message_count:messages.length,
    latest_user:responseAuditTextSummary(messages.findLast(message=>message.role==='user')?.text),
    latest_assistant:responseAuditTextSummary(messages.findLast(message=>message.role==='assistant')?.text),
    assistant_after_latest_user:responseAuditTextSummary(assistantAfterLatestUser?.text),
    error:String(payload?.error||'').slice(0,500),
    updated_at:String(payload?.updated_at||'')
  };
}

function withResponseAudit(result,{dom=null,canonical=null,networkStream=null}={}) {
  return {
    ...result,
    response_audit:{
      schema_version:1,
      selected_source:String(result?.response_source||''),
      chatgpt_dom:responseAuditSnapshot('chatgpt_dom',dom,Boolean(dom?.ok)),
      canonical_api:responseAuditSnapshot('canonical_api',canonical,Boolean(canonical?.ok)),
      network_stream:responseAuditSnapshot('network_stream',networkStream,Boolean(networkStream?.available))
    }
  };
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
  try{
    const [injected]=await promiseWithTimeout(
      chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:readChatNetworkStreamCapturePage,args:[conversationId]}),
      NETWORK_STREAM_READ_TIMEOUT_MS,
      'ChatGPT network stream read timeout.'
    );
    const result=injected?.result&&typeof injected.result==='object'?injected.result:{available:false,capture_installed:false,conversation_id:String(conversationId||'')};
    if(result.capture_installed===false)void ensureChatNetworkStreamCapture(tabId);
    return result;
  }catch(error){return {available:false,capture_installed:false,conversation_id:String(conversationId||''),error:String(error?.message||error).slice(0,500)};}
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

function emptyCanonicalActivity() {
  return {conversation_id:'',busy:false,response_ready:false,busy_since:0,last_checked_at:0,generation_started_at:0,baseline_user_id:'',latest_user_id:'',latest_user_create_time:0};
}

function beginCanonicalActivityGeneration(tabId,conversationId='',startedAt=Date.now()) {
  if(!Number.isInteger(tabId))return;
  const previous=chatCanonicalActivityByTab.get(tabId);
  if(previous?.busy&&(!conversationId||!previous.conversation_id||previous.conversation_id===conversationId)){
    chatCanonicalActivityByTab.set(tabId,{...previous,conversation_id:String(conversationId||previous.conversation_id||''),last_checked_at:0});
    return;
  }
  chatCanonicalActivityByTab.set(tabId,{
    conversation_id:String(conversationId||previous?.conversation_id||''),
    busy:true,
    response_ready:false,
    busy_since:Number(previous?.busy&&previous?.busy_since)||Number(startedAt)||Date.now(),
    last_checked_at:0,
    generation_started_at:Number(startedAt)||Date.now(),
    baseline_user_id:String(previous?.latest_user_id||''),
    latest_user_id:String(previous?.latest_user_id||''),
    latest_user_create_time:0
  });
}

function canonicalActivityState(tabId,conversationId='') {
  const current=chatCanonicalActivityByTab.get(tabId);
  if(!current)return emptyCanonicalActivity();
  if(conversationId&&current.conversation_id&&current.conversation_id!==conversationId){chatCanonicalActivityByTab.delete(tabId);return emptyCanonicalActivity();}
  const age=Date.now()-Math.max(Number(current.last_checked_at||0),Number(current.busy_since||0),Number(current.generation_started_at||0));
  if(age>CANONICAL_ACTIVITY_STALE_MS){chatCanonicalActivityByTab.delete(tabId);return emptyCanonicalActivity();}
  return current;
}

function canonicalMatchesCurrentGeneration(previous,canonical) {
  const generationStartedAt=Number(previous?.generation_started_at||0);
  if(!generationStartedAt)return true;
  const baselineUserId=String(previous?.baseline_user_id||'');
  const latestUserId=String(canonical?.latest_user_id||'');
  if(baselineUserId&&latestUserId)return baselineUserId!==latestUserId;
  const latestUserCreateMs=Number(canonical?.latest_user_create_time||0)*1000;
  if(!latestUserCreateMs)return false;
  return latestUserCreateMs+CANONICAL_ACTIVITY_GENERATION_SKEW_MS>=generationStartedAt;
}

function rememberCanonicalActivity(tabId,conversationId,canonical) {
  if(!Number.isInteger(tabId)||!conversationId||!canonical?.ok)return canonicalActivityState(tabId,conversationId);
  const now=Date.now();
  const previous=canonicalActivityState(tabId,conversationId);
  const matchesGeneration=canonicalMatchesCurrentGeneration(previous,canonical);
  const canonicalBusy=Boolean(canonical.busy);
  const canonicalReady=Boolean(canonical.response_ready&&!canonical.busy&&matchesGeneration);
  let next={
    ...previous,
    conversation_id:String(conversationId),
    last_checked_at:now,
    latest_user_id:String(canonical.latest_user_id||previous.latest_user_id||''),
    latest_user_create_time:Number(canonical.latest_user_create_time)||Number(previous.latest_user_create_time)||0
  };
  if(canonicalBusy&&matchesGeneration){
    next={...next,busy:true,response_ready:false,busy_since:Number(previous.busy_since)||now};
  }else if(canonicalReady){
    next={...next,busy:false,response_ready:true,busy_since:0};
  }
  chatCanonicalActivityByTab.set(tabId,next);
  const changed=Boolean(previous.busy)!==Boolean(next.busy)||Boolean(previous.response_ready)!==Boolean(next.response_ready)||String(previous.conversation_id||'')!==String(next.conversation_id||'');
  if(changed)scheduleRealtimeProfilePush(0);
  return next;
}

async function probeCanonicalActivity(tabId,conversationId,force=false) {
  if(!conversationId)return emptyCanonicalActivity();
  const current=canonicalActivityState(tabId,conversationId);
  if(!force&&Date.now()-Number(current.last_checked_at||0)<CANONICAL_ACTIVITY_PROBE_MS)return current;
  const running=chatCanonicalActivityProbesByTab.get(tabId);
  if(running)return running;
  const probe=(async()=>{
    try{
      const [injected]=await promiseWithTimeout(
        chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:readCanonicalConversationPage,args:[conversationId]}),
        CANONICAL_READ_TIMEOUT_MS,
        'ChatGPT không phản hồi khi đọc activity canonical.'
      );
      return rememberCanonicalActivity(tabId,conversationId,injected?.result);
    }catch{
      const previous=canonicalActivityState(tabId,conversationId);
      if(previous.conversation_id)chatCanonicalActivityByTab.set(tabId,{...previous,last_checked_at:Date.now()});
      return previous;
    }finally{
      chatCanonicalActivityProbesByTab.delete(tabId);
    }
  })();
  chatCanonicalActivityProbesByTab.set(tabId,probe);
  return probe;
}

async function probeCanonicalCompletion(tabId,conversationId,force=false) {
  if(!conversationId)return false;
  const now=Date.now(),last=Number(canonicalCompletionProbeAtByTab.get(tabId)||0);
  if(!force&&now-last<CANONICAL_COMPLETION_PROBE_MS)return false;
  canonicalCompletionProbeAtByTab.set(tabId,now);
  try{
    const canonical=await probeCanonicalActivity(tabId,conversationId,true);
    if(canonical.response_ready&&!canonical.busy)return await reconcileChatNetworkCompletion(tabId,conversationId,'canonical_api');
  }catch{}
  return false;
}

async function probeConversationLimitPage() {
  const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  const limitPattern=/(?:you(?:'|’)?ve reached the maximum length for this conversation|maximum length for this conversation|đ(?:ã|a) (?:đạt|chạm|tới).*?(?:độ dài|do dai).*?(?:tối đa|toi da).*?(?:cuộc trò chuyện|đoạn chat))/i;
  const startNewChatPattern=/(?:start new chat|bắt đầu (?:một )?(?:cuộc trò chuyện|đoạn chat) mới)/i;
  const findLimit=()=>{
    const controls=Array.from(document.querySelectorAll('button,a,[role="button"]'));
    for(const control of controls){
      if(!visible(control))continue;
      const label=String(control.innerText||control.textContent||control.getAttribute?.('aria-label')||'').trim();
      if(!startNewChatPattern.test(label))continue;
      let node=control;
      for(let depth=0;node&&depth<6;depth+=1,node=node.parentElement){
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

function stopChatGenerationPage() {
  const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
  const stopControl=Array.from(document.querySelectorAll('button,[role="button"]')).find(control=>{
    if(!visible(control)||control.disabled||control.getAttribute?.('aria-disabled')==='true')return false;
    const testId=String(control.getAttribute?.('data-testid')||'').trim();
    if(testId==='stop-button')return true;
    const label=String(control.getAttribute?.('aria-label')||control.innerText||control.textContent||'').trim();
    return /^(?:stop(?: answering| generating| streaming)?|dừng(?: trả lời)?)$/i.test(label);
  });
  if(!stopControl)return {ok:true,stopped:false,reason:'not_generating'};
  stopControl.click();
  return {ok:true,stopped:true};
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
  if(action==='stop_chat_generation'){
    const requestedId=Number(args.target_id);
    const conversationId=String(args.conversation_id||'').trim();
    const tabs=await chrome.tabs.query({});
    const tab=tabs.find(candidate=>candidate.id===requestedId)||tabs.find(candidate=>conversationId&&conversationIdFromUrl(candidate.url)===conversationId);
    if(!tab?.id)throw new Error('Không tìm thấy tab ChatGPT cần dừng.');
    const [injected]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId:tab.id},func:stopChatGenerationPage}),5000,'Chrome renderer không phản hồi khi dừng task.');
    const result=injected?.result&&typeof injected.result==='object'?injected.result:{ok:false,stopped:false};
    return {action,ok:Boolean(result.ok),stopped:Boolean(result.stopped),reason:String(result.reason||''),target_id:tab.id,conversation_id:conversationId||conversationIdFromUrl(tab.url)};
  }
  if(action==='recover_chat_tab'){
    const newChat=Boolean(args.new_chat);
    const conversationId=String(args.conversation_id||'').trim();
    const requestedId=Number(args.target_id);
    if(!newChat&&!/^[A-Za-z0-9-]{8,160}$/.test(conversationId))throw new Error('Conversation id cần khôi phục không hợp lệ.');
    const tabs=await chrome.tabs.query({});
    const tab=tabs.find(candidate=>candidate.id===requestedId)||tabs.find(candidate=>{try{return new URL(String(candidate.url||'')).pathname===`/c/${conversationId}`;}catch{return false;}});
    if(!tab?.id&&!newChat)throw new Error('Không còn tab ChatGPT cũ để khôi phục.');
    let replaced;
    if(newChat){
      if(tab?.id){
        await releaseChatDebuggerForRecovery(tab.id);
        replaced=await replaceUnresponsiveChatTab(tab,'https://chatgpt.com/',45000,{carryState:false});
      }else{
        if(Number.isInteger(requestedId))await releaseChatDebuggerForRecovery(requestedId);
        let replacement=await createChatGptTab({url:'https://chatgpt.com/',active:true});
        await waitForTab(replacement.id,45000);
        replacement=await chrome.tabs.get(replacement.id);
        await ensureChatNetworkStreamCapture(replacement.id);
        replaced={tab:replacement,replaced_tab_id:Number.isInteger(requestedId)?requestedId:null,recovery_tab_id:replacement.id,recovery_url:'https://chatgpt.com/'};
      }
    }else{
      const networkState=await chatRequestState(tab.id,conversationId);
      if(networkState.busy)throw new Error('WORKER_BUSY: ChatGPT vẫn đang generation; không thay tab để tránh gián đoạn hoặc gửi trùng.');
      replaced=await replaceUnresponsiveChatTab(tab,`https://chatgpt.com/c/${conversationId}`);
    }
    let windowInfo=null;
    if(Number.isInteger(replaced.tab.windowId)){
      try{await chrome.tabs.update(replaced.tab.id,{active:true});}catch{}
      try{await chrome.windows.update(replaced.tab.windowId,{state:'maximized'});}catch{}
      try{windowInfo=await chrome.windows.update(replaced.tab.windowId,{focused:true});}catch{}
    }
    return {action,ok:true,conversation_id:newChat?'':conversationId,abandoned_conversation_id:newChat?conversationId:'',target_id:replaced.tab.id,new_chat:newChat,renderer_replaced:true,replaced_tab_id:replaced.replaced_tab_id,recovery_tab_id:replaced.recovery_tab_id,recovery_url:replaced.recovery_url,window_id:replaced.tab.windowId,window_state:String(windowInfo?.state||''),window_focused:Boolean(windowInfo?.focused)};
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
      ? await createChatGptTab({url:'https://chatgpt.com/',active:false})
      : conversationId
        ? conversations.find(candidate=>{try{return new URL(candidate.url).pathname==='/c/'+conversationId;}catch{return false;}})
        : Number.isInteger(requestedId)
          ? conversations.find(candidate=>candidate.id===requestedId)
          : conversations.find(candidate=>candidate.active)||conversations[0];
    if(newChat){await waitForTab(tab.id,Math.max(1000,Math.min(45000,remainingCommandMs()-2000)));tab=await chrome.tabs.get(tab.id);}
    if(!tab&&conversationId){
      const recent=await recentConversationList(3);
      if(!recent.some(conversation=>conversation.id===conversationId))throw new Error('Đoạn chat không còn thuộc 3 chat gần nhất của profile này.');
      tab=await createChatGptTab({url:'https://chatgpt.com/c/'+conversationId,active:false});await waitForTab(tab.id,Math.max(1000,Math.min(45000,remainingCommandMs()-2000)));tab=await chrome.tabs.get(tab.id);
    }
    if(!tab?.id)throw new Error('Profile này không có đoạn chat dự án đang mở.');
    const targetConversationId=newChat?'':conversationId||conversationIdFromUrl(tab.url);
    const [networkCaptureInstalled,requestState,domActivity,staleAttachmentOwnership,conversationLimit]=await Promise.all([
      ensureChatNetworkStreamCapture(tab.id),
      chatRequestState(tab.id,conversationId),
      newChat?Promise.resolve({available:false,busy:false,source:'',activity_text:''}):chatDomActivityState(tab.id,conversationId,{maxAgeMs:750}),
      chatAttachmentOwnership(tab.id,targetConversationId),
      newChat?Promise.resolve({reached:false,message:'',button_label:''}):probeConversationLimit(tab.id)
    ]);
    if(conversationLimit.reached)throw new Error('CONVERSATION_LIMIT_REACHED: '+(conversationLimit.message||'ChatGPT báo đoạn chat đã đạt giới hạn độ dài.'));
    if(requestState.busy)throw new Error('Đoạn chat đang xử lý yêu cầu khác.');
    if(domActivity.busy)throw new Error('Đoạn chat vẫn đang hoàn tất lượt trước. Chờ ChatGPT về trạng thái rảnh để không nhập tin nhắn mới vào turn cũ.');
    const targetTemporarilyActivated=false;
    const submitStartedAt=Date.now();
    const attemptId=crypto.randomUUID();

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
    let preparationRecovery={prepare_attempts:1,renderer_reloaded:false,renderer_replaced:false,prepare_waited:false};
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
              pendingConversationByTab.delete(hungTabId);
              const replaced=await replaceUnresponsiveChatTab(tab,recoveryUrl,Math.max(1000,Math.min(45000,remainingCommandMs()-2000)));
              tab=replaced.tab;
              preparationRecovery={prepare_attempts:2,renderer_reloaded:false,renderer_replaced:true,prepare_waited:false,replaced_tab_id:replaced.replaced_tab_id,recovery_tab_id:replaced.recovery_tab_id,prepare_recovery_reason:prepareError};
            }else{
              await new Promise(resolve=>setTimeout(resolve,900));
              tab=await chrome.tabs.get(tab.id);
              preparationRecovery={prepare_attempts:2,renderer_reloaded:false,renderer_replaced:false,prepare_waited:true,prepare_recovery_reason:prepareError};
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
        return {action,target_id:tab.id,conversation_id:newChat?'':conversationId,new_chat:newChat,ok:true,submission_state:'failed',generation_state:'idle',network_state:'idle',network_tracking:true,network_acknowledged:false,submitted:false,submitted_by:'prepare-recovery-retry',submit_path:'prepare-recovery-retry',path_attempted:['prepare',preparationRecovery.renderer_replaced?'replace-tab':'wait','prepare'],send_uncertain:false,error:'PREPARE_FAILED: '+prepareErrors.join(' | '),attempt_id:attemptId,prepare_attempts:prepareAttempt+1,renderer_reloaded:false,renderer_replaced:Boolean(preparationRecovery.renderer_replaced)};
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
    const preparationPath=preparationRecovery.renderer_replaced?['prepare','replace-tab','prepare']:preparationRecovery.prepare_waited?['prepare','wait','prepare']:[];
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
    const responseTimingStartedAt=Date.now();
    const responsePhaseTimings={command_queue_ms:Math.max(0,responseTimingStartedAt-(Number(command?.created_at_ms)||responseTimingStartedAt))};
    const addResponsePhaseTiming=(name,startedAt)=>{responsePhaseTimings[name]=Math.max(0,Number(responsePhaseTimings[name]||0)+(Date.now()-startedAt));};
    const responseTimingPayload=()=>({response_phase_timings:{...responsePhaseTimings,extension_total_ms:Math.max(0,Date.now()-responseTimingStartedAt)}});
    const conversationId=String(args.conversation_id||'').trim();
    if(!/^[A-Za-z0-9-]{8,160}$/.test(conversationId))throw new Error('Conversation id không hợp lệ.');
    const findTabStartedAt=Date.now();
    const tabs=await chrome.tabs.query({});
    const conversations=tabs.filter(candidate=>candidate.id&&String(candidate.url||'').startsWith('https://chatgpt.com/c/'));
    let tab=conversations.find(candidate=>{try{return new URL(candidate.url).pathname===`/c/${conversationId}`;}catch{return false;}});
    if(!tab){
      const recent=await recentConversationList(3);
      if(!recent.some(conversation=>conversation.id===conversationId))throw new Error('Đoạn chat không còn thuộc 3 chat gần nhất của profile này.');
      tab=await createChatGptTab({url:`https://chatgpt.com/c/${conversationId}`,active:false});await waitForTab(tab.id,45000);tab=await chrome.tabs.get(tab.id);
    }
    if(!tab?.id)throw new Error('Không mở được đoạn chat cần đọc phản hồi.');
    addResponsePhaseTiming('find_tab_ms',findTabStartedAt);
    const networkStateStartedAt=Date.now();
    let networkState=await chatRequestState(tab.id,conversationId);
    addResponsePhaseTiming('network_state_ms',networkStateStartedAt);
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
    const networkOnly=args.read_dom===false&&args.canonical_only!==true;
    const networkStreamStartedAt=Date.now();
    const networkStream=await chatNetworkStreamCapture(tab.id,conversationId);
    addResponsePhaseTiming('network_stream_ms',networkStreamStartedAt);
    if(networkState.busy&&networkStream.completed&&!networkStream.error){
      const networkReconcileStartedAt=Date.now();
      await reconcileChatNetworkCompletion(tab.id,conversationId,'network_stream');
      networkState=await chatRequestState(tab.id,conversationId);
      networkPayload=networkPayloadOf(networkState);
      addResponsePhaseTiming('network_reconcile_ms',networkReconcileStartedAt);
    }else if(networkState.busy&&!networkStream.available){
      const startedAt=Date.parse(networkState.network_last_started_at||'');
      const shouldProbeCanonical=Number.isFinite(startedAt)&&Date.now()-startedAt>=CANONICAL_COMPLETION_PROBE_AFTER_MS;
      if(shouldProbeCanonical&&networkOnly){
        void probeCanonicalCompletion(tab.id,conversationId,false).catch(()=>{});
      }else if(shouldProbeCanonical&&await probeCanonicalCompletion(tab.id,conversationId,false)){
        networkState=await chatRequestState(tab.id,conversationId);
        networkPayload=networkPayloadOf(networkState);
      }
    }
    const networkStreamMessages=Array.isArray(networkStream.messages)?networkStream.messages.slice(-20):[];
    const networkStreamText=String(networkStream.text||'');
    const networkStreamActivityText=String(networkStream.activity_text||'').trim().slice(0,220);
    const networkStreamInProgress=Boolean(networkStream.in_progress);
    const effectiveNetworkBusy=Boolean(networkState.busy||networkStreamInProgress);
    const networkStreamLive=Boolean(effectiveNetworkBusy&&networkStream.available);
    const visibleNetworkStreamMessages=networkStreamLive?networkStreamMessages:[];
    const visibleNetworkStreamText=networkStreamLive?networkStreamText:'';
    const visibleNetworkStreamActivityText=networkStreamLive?networkStreamActivityText:'';
    const networkStreamPayload={
      network_stream_available:Boolean(networkStreamLive&&(visibleNetworkStreamText||visibleNetworkStreamMessages.length||visibleNetworkStreamActivityText)),
      network_stream_capture_installed:Boolean(networkStream.capture_installed),
      network_stream_endpoint:String(networkStream.endpoint||''),
      network_stream_event_count:Number(networkStream.event_count)||0,
      network_stream_error:String(networkStream.error||''),
      network_stream_activity_text:visibleNetworkStreamActivityText,
      network_stream_in_progress:networkStreamInProgress,
      network_stream_started_at:String(networkStream.started_at||''),
      network_stream_updated_at:String(networkStream.updated_at||'')
    };
    if(networkOnly){
      return withResponseAudit({action,target_id:tab.id,ok:true,title:String(tab.title||''),url:String(tab.url||''),text:visibleNetworkStreamText,text_length:visibleNetworkStreamText.length,truncated:false,incomplete:effectiveNetworkBusy,incomplete_reason:effectiveNetworkBusy?(visibleNetworkStreamText?'network_stream_in_progress':visibleNetworkStreamActivityText?'tool_activity_in_progress':'generation_in_progress'):'',conversation_limit_reached:false,conversation_limit_message:'',message_count:visibleNetworkStreamMessages.length,total_message_count:visibleNetworkStreamMessages.length,messages:visibleNetworkStreamMessages,busy:effectiveNetworkBusy,dom_available:false,dom_skipped:true,dom_error:'',response_ready:false,response_source:visibleNetworkStreamText?'network_stream':visibleNetworkStreamActivityText?'network_tool_activity':'network_state',updated_at:networkStream.updated_at||new Date().toISOString(),...networkStreamPayload,...networkPayload,...responseTimingPayload()},{networkStream});
    }
    let canonical={ok:false,error:''};
    const canonicalReadStartedAt=Date.now();
    try{
      const [canonicalInjection]=await promiseWithTimeout(
        chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:readCanonicalConversationPage,args:[conversationId]}),
        CANONICAL_READ_TIMEOUT_MS,
        'ChatGPT không phản hồi khi đọc conversation canonical.'
      );
      canonical=canonicalInjection?.result||canonical;
    }catch(error){canonical={ok:false,error:String(error?.message||error).slice(0,500)};}
    addResponsePhaseTiming('canonical_read_ms',canonicalReadStartedAt);
    const canonicalGenerationMatches=canonicalMatchesCurrentGeneration(canonicalActivityState(tab.id,conversationId),canonical);
    const rememberedCanonicalActivity=rememberCanonicalActivity(tab.id,conversationId,canonical);
    const currentCanonical=canonical.ok&&!canonicalGenerationMatches
      ? {...canonical,messages:[],text:'',text_length:0,response_ready:false,busy:true,generation_mismatch:true}
      : canonical;
    let canonicalActivityPayload={canonical_busy:Boolean(rememberedCanonicalActivity.busy),canonical_response_ready:Boolean(rememberedCanonicalActivity.response_ready&&!rememberedCanonicalActivity.busy),canonical_observed:Boolean(canonical.ok)};
    if(currentCanonical.ok&&currentCanonical.response_ready&&!currentCanonical.busy){
      const canonicalReconcileStartedAt=Date.now();
      await reconcileChatNetworkCompletion(tab.id,conversationId,'canonical_api');
      networkState=await chatRequestState(tab.id,conversationId);
      networkPayload=networkPayloadOf(networkState);
      addResponsePhaseTiming('canonical_reconcile_ms',canonicalReconcileStartedAt);
    }
    if(args.canonical_only===true){
      if(currentCanonical.ok){
        const latestAssistant=[...(currentCanonical.messages||[])].reverse().find(message=>message.role==='assistant');
        return withResponseAudit({action,target_id:tab.id,ok:true,title:String(tab.title||''),url:String(tab.url||''),text:String(currentCanonical.text||''),text_length:String(currentCanonical.text||'').length,truncated:Boolean(latestAssistant?.truncated),incomplete:Boolean(currentCanonical.busy||networkStreamInProgress),incomplete_reason:currentCanonical.busy?'canonical_generation_in_progress':networkStreamInProgress?'tool_activity_in_progress':'',conversation_limit_reached:false,conversation_limit_message:'',message_count:(currentCanonical.messages||[]).filter(message=>message.role==='assistant').length,total_message_count:(currentCanonical.messages||[]).length,messages:currentCanonical.messages||[],busy:Boolean(effectiveNetworkBusy||currentCanonical.busy),dom_available:false,dom_skipped:true,dom_error:'',canonical_available:true,canonical_error:'',canonical_generation_matches:canonicalGenerationMatches,response_ready:Boolean(currentCanonical.response_ready&&!networkStreamInProgress),response_source:'canonical_api',updated_at:new Date().toISOString(),...canonicalActivityPayload,...networkStreamPayload,...networkPayload,...responseTimingPayload()},{canonical,networkStream});
      }
      return withResponseAudit({action,target_id:tab.id,ok:true,title:String(tab.title||''),url:String(tab.url||''),text:visibleNetworkStreamText,text_length:visibleNetworkStreamText.length,truncated:false,incomplete:effectiveNetworkBusy,incomplete_reason:effectiveNetworkBusy?'generation_in_progress':'',conversation_limit_reached:false,conversation_limit_message:'',message_count:visibleNetworkStreamMessages.length,total_message_count:visibleNetworkStreamMessages.length,messages:visibleNetworkStreamMessages,busy:effectiveNetworkBusy,dom_available:false,dom_skipped:true,dom_error:'',canonical_available:false,canonical_error:String(canonical.error||''),response_ready:false,response_source:visibleNetworkStreamText?'network_stream':'network_state',updated_at:networkStream.updated_at||new Date().toISOString(),...canonicalActivityPayload,...networkStreamPayload,...networkPayload,...responseTimingPayload()},{canonical,networkStream});
    }
    const domReadStartedAt=Date.now();
    try{
      const [injected]=await promiseWithTimeout(
        chrome.scripting.executeScript({target:{tabId:tab.id},func:readChatResponsePage}),
        DOM_READ_TIMEOUT_MS,
        'Chrome renderer không phản hồi khi đọc DOM.'
      );
      addResponsePhaseTiming('dom_read_ms',domReadStartedAt);
      if(!injected?.result?.ok)throw new Error(injected?.result?.error||'Không đọc được phản hồi ChatGPT.');
      let observedDomResult=injected.result;
      let domResult=injected.result;
      const initialDomText=String(domResult.text||'').trim();
      const unverifiedShortDom=Boolean(domResult.response_ready&&initialDomText.length>0&&initialDomText.length<=2&&!currentCanonical.response_ready);
      if(unverifiedShortDom)domResult={...domResult,busy:true,response_ready:false,incomplete:true,incomplete_reason:'short_dom_response_unverified'};
      const initialDomResponseReady=Boolean(domResult.response_ready&&!domResult.busy&&!unverifiedShortDom);
      if(initialDomResponseReady){
        const previousCanonicalActivity=chatCanonicalActivityByTab.get(tab.id)||emptyCanonicalActivity();
        chatCanonicalActivityByTab.set(tab.id,{...previousCanonicalActivity,conversation_id:conversationId,busy:false,response_ready:true,busy_since:0,last_checked_at:Date.now()});
        canonicalActivityPayload={canonical_busy:false,canonical_response_ready:true,canonical_observed:Boolean(canonical.ok)};
        if(networkState.busy){
          await reconcileChatNetworkCompletion(tab.id,conversationId,domResult.image_response_ready?'dom_image':'dom_response');
          networkState=await chatRequestState(tab.id,conversationId);
          networkPayload=networkPayloadOf(networkState);
        }
      }
      const canonicalText=String(currentCanonical.text||'').trim();
      const domTextBeforeMerge=String(domResult.text||'').trim();
      if(canonicalResponseSupersedesDom(currentCanonical,domResult)){
        const latestAssistant=[...(currentCanonical.messages||[])].reverse().find(message=>message.role==='assistant');
        domResult={...domResult,text:canonicalText,text_length:canonicalText.length,messages:currentCanonical.messages||domResult.messages,message_count:(currentCanonical.messages||[]).filter(message=>message.role==='assistant').length,total_message_count:(currentCanonical.messages||[]).length,truncated:Boolean(latestAssistant?.truncated),busy:Boolean(currentCanonical.busy),response_ready:Boolean(currentCanonical.response_ready),response_source:'canonical_api',updated_at:new Date().toISOString()};
      }
      const recoveryCheckpoint=domResult;
      const recovery={dom_recovery_checked:false,dom_recovered:false,dom_reloaded:false,dom_replaced:false,dom_reload_deferred:false,dom_reload_decision:'',response_checkpoint_applied:false,replaced_tab_id:0,recovery_tab_id:0,dom_recovery_source:'',dom_recovery_error:'',resume_mode:'merge_only'};
      const connectionInterrupted=Boolean(injected.result.connection_interrupted);
      const messageDeliveryTimedOut=Boolean(injected.result.message_delivery_timed_out);
      const domRecoveryStartedAt=Date.now();
      if(args.recover_stale_dom===true&&(connectionInterrupted||messageDeliveryTimedOut||currentCanonical.ok&&currentCanonical.response_ready&&!currentCanonical.busy)){
        recovery.dom_recovery_checked=true;
        try{
          const domText=domTextBeforeMerge;
          const staleContent=canonicalText.length>domText.length&&(!domText||canonicalText.startsWith(domText)||domText.length<160);
          const staleActivity=Boolean(injected.result.busy);
          const stale=connectionInterrupted||staleContent||staleActivity;
          const canonicalReady=Boolean(currentCanonical.ok&&currentCanonical.response_ready&&!currentCanonical.busy);
          const reloadAllowed=shouldReloadChatRecovery({connectionInterrupted,messageDeliveryTimedOut,staleContent,domBusy:staleActivity,networkBusy:effectiveNetworkBusy,canonicalReady});
          recovery.dom_reload_decision=reloadAllowed?'allowed':'deferred';
          if(stale&&reloadAllowed){
            recovery.dom_recovery_source=messageDeliveryTimedOut?'message_delivery_timeout':connectionInterrupted?'connection_interrupted':staleActivity?'canonical_activity':'canonical_api';
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
                if(refreshed?.result?.ok){rendererRefreshed=true;observedDomResult=refreshed.result;domResult=refreshed.result;}
                if(!domResult.connection_interrupted&&(connectionInterrupted||!domResult.busy&&String(domResult.text||'').trim().length>=canonicalText.length))break;
              }catch{}
            }
            if(!rendererRefreshed||domResult.connection_interrupted){
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
              if(replacementRead?.result?.ok){observedDomResult=replacementRead.result;domResult=replacementRead.result;}
            }
            if(String(domResult.text||'').trim().length<canonicalText.length){
              const latestAssistant=[...(canonical.messages||[])].reverse().find(message=>message.role==='assistant');
              domResult={...domResult,text:canonicalText,text_length:canonicalText.length,messages:canonical.messages||domResult.messages,message_count:(canonical.messages||[]).filter(message=>message.role==='assistant').length,total_message_count:(canonical.messages||[]).length,truncated:Boolean(latestAssistant?.truncated),updated_at:new Date().toISOString()};
            }
          }else if(stale){
            recovery.dom_reload_deferred=true;
            recovery.dom_recovery_source=messageDeliveryTimedOut?'message_delivery_timeout':connectionInterrupted?'connection_interrupted':staleActivity?'active_generation':'canonical_api';
          }else if(!canonical.ok)recovery.dom_recovery_error=String(canonical.error||'Không đọc được conversation canonical.').slice(0,500);
        }catch(error){
          recovery.dom_recovery_error=String(error?.message||error).slice(0,500);
        }
      }
      if(args.recover_stale_dom===true)addResponsePhaseTiming('dom_recovery_ms',domRecoveryStartedAt);
      if(recovery.dom_reloaded||recovery.dom_replaced){
        domResult=mergeChatRecoveryResponse(recoveryCheckpoint,domResult);
        recovery.response_checkpoint_applied=Boolean(domResult.response_checkpoint_applied);
        recovery.dom_recovered=!domResult.connection_interrupted&&(connectionInterrupted||messageDeliveryTimedOut||String(domResult.text||'').trim().length>=canonicalText.length);
      }
      const domResponseReady=Boolean(domResult.response_ready&&!domResult.busy&&!unverifiedShortDom);
      const imageResponseReady=Boolean(domResponseReady&&domResult.image_response_ready);
      return withResponseAudit({action,target_id:tab.id,...domResult,busy:Boolean(!domResponseReady&&(effectiveNetworkBusy||currentCanonical.busy||domResult.busy)),incomplete:domResponseReady?false:Boolean(domResult.incomplete),incomplete_reason:domResponseReady?'':String(domResult.incomplete_reason||''),dom_available:true,dom_busy:Boolean(domResult.busy),canonical_available:Boolean(canonical.ok),canonical_error:String(canonical.error||''),canonical_generation_matches:canonicalGenerationMatches,short_dom_response_unverified:unverifiedShortDom,...canonicalActivityPayload,...networkStreamPayload,...recovery,...networkPayload,message_delivery_timed_out:messageDeliveryTimedOut,...responseTimingPayload(),...(domResponseReady?{canonical_busy:false,canonical_response_ready:true,network_stream_in_progress:false,response_ready:true,response_kind:imageResponseReady?'image':String(domResult.response_kind||'text')}:{})},{dom:observedDomResult,canonical,networkStream});
    }catch(error){
      if(responsePhaseTimings.dom_read_ms==null)addResponsePhaseTiming('dom_read_ms',domReadStartedAt);
      if(currentCanonical.ok){
        const latestAssistant=[...(currentCanonical.messages||[])].reverse().find(message=>message.role==='assistant');
        return withResponseAudit({action,target_id:tab.id,ok:true,title:String(tab.title||''),url:String(tab.url||''),text:String(currentCanonical.text||''),text_length:String(currentCanonical.text||'').length,truncated:Boolean(latestAssistant?.truncated),incomplete:Boolean(currentCanonical.busy||networkStreamInProgress),incomplete_reason:currentCanonical.busy?'canonical_generation_in_progress':networkStreamInProgress?'tool_activity_in_progress':'',conversation_limit_reached:false,conversation_limit_message:'',message_count:(currentCanonical.messages||[]).filter(message=>message.role==='assistant').length,total_message_count:(currentCanonical.messages||[]).length,messages:currentCanonical.messages||[],busy:Boolean(effectiveNetworkBusy||currentCanonical.busy),dom_available:false,dom_error:String(error?.message||error).slice(0,500),canonical_available:true,canonical_generation_matches:canonicalGenerationMatches,response_ready:Boolean(currentCanonical.response_ready&&!networkStreamInProgress),response_source:'canonical_api',updated_at:new Date().toISOString(),...canonicalActivityPayload,...networkStreamPayload,...networkPayload,...responseTimingPayload()},{dom:{ok:false,error:String(error?.message||error)},canonical,networkStream});
      }
      return withResponseAudit({
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
        ...networkPayload,
        ...responseTimingPayload()
      },{dom:{ok:false,error:String(error?.message||error)},canonical,networkStream});
    }
  }
  if(action==='open_tab'){const tab=await createChatGptTab({url:args.url,active:false});return {action,target_id:tab.id,title:tab.title||'',url:tab.url||args.url,background:true};}
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

async function replaceUnresponsiveChatTab(tab,recoveryUrl,timeoutMs=45000,options) {
  if(!tab?.id)throw new Error('Không tìm thấy tab ChatGPT cần khôi phục.');
  const carryState=options?.carryState!==false;
  let safeUrl='';
  try{
    const parsed=new URL(String(recoveryUrl||tab.url||''));
    if(parsed.origin!=='https://chatgpt.com'||!/^\/(?:c\/[A-Za-z0-9-]{8,160})?\/?$/.test(parsed.pathname))throw new Error();
    safeUrl=parsed.href;
  }catch{throw new Error('URL ChatGPT cần khôi phục không hợp lệ.');}
  const replacedTabId=tab.id;
  const createArgs={url:safeUrl,active:Boolean(tab.active)};
  if(Number.isInteger(tab.windowId))createArgs.windowId=tab.windowId;
  await ensureChatNetworkStateLoaded();
  const previousState=chatNetworkStateByTab.get(replacedTabId);
  const previousPosts=chatNetworkPostLogByTab.get(replacedTabId);
  const previousVersion=chatNetworkPostVersionByTab.get(replacedTabId);
  let replacedTabRemoved=false;
  let replacement=await serializeChatGptTabCreation(async()=>{
    const current=(await chrome.tabs.query({url:['https://chatgpt.com/*']})).filter(candidate=>Number.isInteger(candidate.id));
    if(current.length>=MAX_CHATGPT_TABS){
      await releaseChatDebuggerForRecovery(replacedTabId);
      await chrome.tabs.remove(replacedTabId);
      replacedTabRemoved=true;
    }
    return await chrome.tabs.create(createArgs);
  });
  try{
    await waitForTab(replacement.id,timeoutMs);
    replacement=await chrome.tabs.get(replacement.id);
    await ensureChatNetworkStreamCapture(replacement.id);
  }catch(error){
    await chrome.tabs.remove(replacement.id).catch(()=>{});
    throw error;
  }
  if(carryState&&previousState)chatNetworkStateByTab.set(replacement.id,{...previousState});
  if(carryState&&previousPosts)chatNetworkPostLogByTab.set(replacement.id,[...previousPosts]);
  if(carryState&&previousVersion)chatNetworkPostVersionByTab.set(replacement.id,previousVersion);
  pendingConversationByTab.delete(replacedTabId);
  if(!replacedTabRemoved){
    await releaseChatDebuggerForRecovery(replacedTabId);
    await chrome.tabs.remove(replacedTabId);
  }
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
    : await createChatGptTab({url,active:true});
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
    const endpoint=new URL(serverUrl);
    const token=endpoint.searchParams.get('codexpro_token')||endpoint.searchParams.get('token')||'';
    const headers={'content-type':'application/json','accept':'application/json, text/event-stream'};
    if(token)headers.authorization=`Bearer ${token}`;
    const response=await fetch(endpoint.toString(),{
      method:'POST',
      headers,
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
  const normalizedValue=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').replace(/\s+/g,' ').trim().toLowerCase();
  const normalized=element=>normalizedValue(element?.innerText||element?.textContent||element?.getAttribute?.('aria-label')||'');
  const settingsRoot=()=>[...document.querySelectorAll('[role="dialog"],dialog')].filter(visible).find(dialog=>{const value=normalized(dialog);const settingsMarker=value.includes('settings')||value.includes('cai dat');const pluginMarker=value.includes('plugin')||value.includes('ung dung');return settingsMarker&&pluginMarker;})||null;
  const connectionMarker=value=>value.includes('connection')||value.includes('ket noi');
  const detailReady=()=>{const root=settingsRoot();if(!root)return null;const value=normalized(root);return location.hash.toLowerCase().includes('/plugin_')||(value.includes('codexpro')&&connectionMarker(value))?root:null;};
  const candidates=root=>root?[...root.querySelectorAll('button,a,[role="button"]')].filter(visible).filter(item=>{const value=normalized(item);return value==='codexpro'||value.startsWith('codexpro ');}):[];
  const pointerClick=element=>{if(!(element instanceof Element))return false;element.scrollIntoView({block:'center',inline:'center'});try{element.focus({preventScroll:true});}catch{}const rect=element.getBoundingClientRect(),clientX=rect.left+Math.max(1,rect.width/2),clientY=rect.top+Math.max(1,rect.height/2),base={bubbles:true,cancelable:true,composed:true,view:window,button:0,clientX,clientY};try{element.dispatchEvent(new PointerEvent('pointerdown',{...base,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true}));}catch{}try{element.dispatchEvent(new MouseEvent('mousedown',{...base,buttons:1}));}catch{}try{element.dispatchEvent(new PointerEvent('pointerup',{...base,buttons:0,pointerId:1,pointerType:'mouse',isPrimary:true}));}catch{}try{element.dispatchEvent(new MouseEvent('mouseup',{...base,buttons:0}));}catch{}try{element.dispatchEvent(new MouseEvent('click',{...base,buttons:0}));}catch{element.click();}return true;};
  if(detailReady())return {ok:true,already_open:true,url:location.href,language:String(document.documentElement.lang||'')};
  const deadline=Date.now()+20000;
  let clickAttempts=0;
  while(Date.now()<deadline){
    const root=settingsRoot();
    const button=candidates(root)[0]||null;
    if(button){clickAttempts+=1;if(clickAttempts===1)button.click();else pointerClick(button);}
    for(let attempt=0;attempt<10;attempt+=1){if(detailReady())return {ok:true,already_open:false,url:location.href};await sleep(150);}
  }
  const dialogs=[...document.querySelectorAll('[role="dialog"],dialog')].filter(visible);
  const root=settingsRoot();
  const rootValue=normalized(root);
  return {ok:false,error:'Không mở được trang chi tiết CodexPro trong Settings.',diagnostic:{code:'SETTINGS_PLUGIN_DETAIL_NOT_FOUND',url:location.href,hash:location.hash,language:String(document.documentElement.lang||''),visible_dialog_count:dialogs.length,settings_root_found:Boolean(root),settings_marker:rootValue.includes('settings')?'settings':rootValue.includes('cai dat')?'cai_dat':'',plugin_marker:rootValue.includes('plugin')?'plugin':rootValue.includes('ung dung')?'ung_dung':'',connection_marker:connectionMarker(rootValue),codexpro_candidate_count:candidates(root).length,click_attempts:clickAttempts}};
}

async function ensureConnectorDetailTab(tabId) {
  const [injected]=await promiseWithTimeout(chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:openConnectorDetailPage}),30000,'Chrome renderer không phản hồi khi mở chi tiết CodexPro.');
  if(!injected?.result?.ok){const evidence=JSON.stringify(injected?.result?.diagnostic||{}).slice(0,3000);throw new Error(`${injected?.result?.error||'Không mở được trang chi tiết CodexPro trong Settings.'} [CODEXPRO_SETUP_EVIDENCE ${evidence}]`);}
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

    const saved={ok:true,message:'CodexPro READY',at:new Date().toISOString()};
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
  const tab=await createChatGptTab({url:connector.settings_url || 'https://chatgpt.com/plugins?q=CodexPro',active:true});
  try{
    if(tab.windowId)await chrome.windows.update(tab.windowId,{focused:true});
    await waitForTab(tab.id);
    const result=await sendPageMessage(tab.id,{type:'codexpro-check-connector'},30000);
    if(!result?.ok)throw new Error(result?.error || 'Không kiểm tra được Apps trong ChatGPT.');
    const saved={
      ok:Boolean(result.installed),
      message:result.installed?'CodexPro READY':'Profile này chưa thêm CodexPro.',
      at:new Date().toISOString()
    };
    await chrome.storage.local.set({connectorInstall:saved});
    return {ok:true,installed:saved.ok,message:saved.message,checked_at:saved.at,diagnostic:result.diagnostic||{}};
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
        if(!profile.enabled){await new Promise(resolve=>setTimeout(resolve,2000));continue;}
        let [tabs,recentConversations]=await Promise.all([tabList(),recentConversationList(3)]);
        const tabCleanup=await cleanupChatGptTabs(tabs,recentConversations);
        if(tabCleanup.closed_count)tabs=await tabList();
        await confirmConnectorFromLiveToolActivity(tabs);
        const response=await fetch(`${BRIDGE}/poll`,{method:'POST',headers:HEADERS,body:JSON.stringify({profile,active:profile.active,tabs,recent_conversations:recentConversations})});
        if(!response.ok)throw new Error(`Bridge HTTP ${response.status}`);
        const message=await response.json();
        const isActive=message.active_profile_id===profile.id;
        if(profile.active!==isActive)await chrome.storage.local.set({active:isActive});
        if(message.command){
          const heartbeat=setInterval(()=>{void chrome.storage.local.get('workerEnabled').then(({workerEnabled})=>workerEnabled===false?null:fetch(`${BRIDGE}/register`,{method:'POST',headers:HEADERS,body:JSON.stringify({profile})})).catch(()=>{});},10000);
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

async function releaseChatDebuggerForRecovery(tabId) {
  if(!Number.isInteger(tabId))return false;
  const tracker=cdpNetworkTrackersByTab.get(tabId);
  if(tracker){try{await tracker.cleanup();}catch{}}
  const session=debuggerSessionsByTab.get(tabId);
  if(!session)return Boolean(tracker);
  if(session.detachTimer)clearTimeout(session.detachTimer);
  debuggerSessionsByTab.delete(tabId);
  debuggerEventSubscribersByTab.delete(tabId);
  try{await chrome.debugger.detach(session.target);}catch{}
  return true;
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
