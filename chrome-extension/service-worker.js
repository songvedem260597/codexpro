const BRIDGE = 'http://127.0.0.1:9224';
const HEADERS = {'content-type':'application/json','x-codexpro-extension':'profile-bridge-v1'};
const CHAT_REQUEST_STALE_MS = 30 * 60 * 1000;
let polling = false;
let installing = false;
const activeChatRequests = new Map();
let recentConversationCache = {at:0,items:[]};

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

chrome.webRequest.onBeforeRequest.addListener(beginChatRequest,{urls:['https://chatgpt.com/*'],types:['xmlhttprequest','other']},['requestBody']);
chrome.webRequest.onCompleted.addListener(finishChatRequest,{urls:['https://chatgpt.com/*'],types:['xmlhttprequest','other']});
chrome.webRequest.onErrorOccurred.addListener(finishChatRequest,{urls:['https://chatgpt.com/*'],types:['xmlhttprequest','other']});
chrome.webRequest.onBeforeRedirect.addListener(finishChatRequest,{urls:['https://chatgpt.com/*'],types:['xmlhttprequest','other']});
chrome.tabs.onRemoved.addListener(tabId=>{for(const [requestId,request] of activeChatRequests){if(request.tabId===tabId)activeChatRequests.delete(requestId);}});

async function profileInfo() {
  const stored = await chrome.storage.local.get(['profileId','active','connectorInstall']);
  const profileId = stored.profileId || crypto.randomUUID();
  if (!stored.profileId) await chrome.storage.local.set({profileId});
  let email = '';
  try { email = (await chrome.identity.getProfileUserInfo({accountStatus:'ANY'})).email || ''; } catch {}
  return {id:profileId,email,label:email || `Chrome ${profileId.slice(0,8)}`,version:chrome.runtime.getManifest().version,connector_install:stored.connectorInstall||null,active:Boolean(stored.active)};
}

async function tabList() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(tab => ({id:tab.id,window_id:tab.windowId,active:Boolean(tab.active),title:tab.title || '',url:tab.url || '',...chatRequestState(tab.id)}));
}

async function fetchRecentConversationsPage(limit) {
  let apiError='';
  try{
    const response=await fetch(`/backend-api/conversations?offset=0&limit=${limit}&order=updated`,{credentials:'include',cache:'no-store'});
    if(response.ok){
      const payload=await response.json();
      const items=Array.isArray(payload?.items)?payload.items:[];
      if(items.length)return {ok:true,source:'api',items:items.slice(0,limit).map(item=>({id:String(item.id||''),title:String(item.title||'Đoạn chat chưa có tiêu đề'),updated_at:Number(item.update_time||item.updated_at||0)}))};
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
    const items=(injected.result.items||[])
      .filter(item=>/^[A-Za-z0-9-]{8,160}$/.test(String(item.id||'')))
      .slice(0,limit)
      .map(item=>({id:String(item.id),title:String(item.title||'Đoạn chat chưa có tiêu đề').slice(0,300),url:`https://chatgpt.com/c/${item.id}`,updated_at:Number(item.updated_at)||0}));
    recentConversationCache={at:now,items};
    return items;
  }catch{return recentConversationCache.items;}
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
  if(!location.pathname.startsWith('/c/'))return {ok:false,error:'Tab đã chọn không phải đoạn chat ChatGPT.'};
  const stopSelectors=['button[data-testid="stop-button"]','button[aria-label*="Stop generating" i]','button[aria-label*="Stop streaming" i]','button[aria-label*="Dừng" i]'];
  if(stopSelectors.some(selector=>visible(document.querySelector(selector))))return {ok:false,error:'Đoạn chat đang xử lý yêu cầu khác.'};
  let composer=document.querySelector('#prompt-textarea,textarea[data-id="root"],textarea[placeholder],[contenteditable="true"][data-lexical-editor="true"]');
  if(!composer)return {ok:false,error:'Không tìm thấy ô nhập trong đoạn chat.'};
  const draft=String(composer.innerText||composer.value||'').trim();
  if(draft)return {ok:false,error:'Ô chat đang có nội dung chưa gửi; CodexPro không ghi đè bản nháp.'};
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
    composer=document.querySelector('#prompt-textarea,textarea[data-id="root"],textarea[placeholder],[contenteditable="true"][data-lexical-editor="true"]');
    if(!composer)return {ok:false,error:'Ô nhập ChatGPT biến mất sau khi gắn file.'};
  }
  if(text){
    composer.scrollIntoView({block:'center',inline:'center'});composer.focus();
    if(composer.isContentEditable){document.execCommand('selectAll',false,null);document.execCommand('insertText',false,text);}
    else{const proto=composer instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(composer,text);else composer.value=text;}
    composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
    composer.dispatchEvent(new Event('change',{bubbles:true}));
  }
  let send;
  for(let attempt=0;attempt<(attachments.length?900:40);attempt+=1){
    send=['button[data-testid="send-button"]','button[aria-label*="Send" i]','button[aria-label*="Gửi" i]'].map(selector=>document.querySelector(selector)).find(element=>visible(element)&&!element.disabled);
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
    const raw=String(content?.innerText||content?.textContent||'').trim();
    const text=raw.slice(0,40000);
    return raw?{id:`${role}-${index}`,role,text,truncated:raw.length>text.length}:null;
  }).filter(Boolean);
  const messages=allMessages.slice(-20);
  const latestAssistant=[...allMessages].reverse().find(message=>message.role==='assistant');
  const text=latestAssistant?.text||'';
  const stopSelectors=['button[data-testid="stop-button"]','button[aria-label*="Stop generating" i]','button[aria-label*="Stop streaming" i]','button[aria-label*="Dừng" i]'];
  const busy=stopSelectors.some(selector=>visible(document.querySelector(selector)));
  return {ok:true,title:document.title,url:location.href,text,text_length:text.length,truncated:Boolean(latestAssistant?.truncated),message_count:allMessages.filter(message=>message.role==='assistant').length,total_message_count:allMessages.length,messages,busy,updated_at:new Date().toISOString()};
}

async function targetTab(args) {
  if (Number.isInteger(args.target_id)) return await chrome.tabs.get(args.target_id);
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
    if(!text&&!attachments.length)throw new Error('Yêu cầu và file đính kèm không được cùng để trống.');
    if(text.length>12000)throw new Error('Yêu cầu dài quá 12.000 ký tự.');
    if(attachments.some(file=>!file.name||!file.data_base64))throw new Error('File đính kèm không hợp lệ.');
    if(attachments.reduce((total,file)=>total+file.data_base64.length,0)>14000000)throw new Error('Tổng file đính kèm quá lớn.');
    const requestedId=Number(args.target_id);
    const conversationId=String(args.conversation_id||'').trim();
    if(conversationId&&!/^[A-Za-z0-9-]{8,160}$/.test(conversationId))throw new Error('Conversation id không hợp lệ.');
    const tabs=await chrome.tabs.query({});
    const conversations=tabs.filter(candidate=>candidate.id&&String(candidate.url||'').startsWith('https://chatgpt.com/c/'));
    let tab=conversationId
      ? conversations.find(candidate=>{try{return new URL(candidate.url).pathname===`/c/${conversationId}`;}catch{return false;}})
      : Number.isInteger(requestedId)
        ? conversations.find(candidate=>candidate.id===requestedId)
        : conversations.find(candidate=>candidate.active)||conversations[0];
    if(!tab&&conversationId){
      const recent=await recentConversationList(3);
      if(!recent.some(conversation=>conversation.id===conversationId))throw new Error('Đoạn chat không còn thuộc 3 chat gần nhất của profile này.');
      tab=await chrome.tabs.create({url:`https://chatgpt.com/c/${conversationId}`,active:false});await waitForTab(tab.id,45000);tab=await chrome.tabs.get(tab.id);
    }
    if(!tab?.id)throw new Error('Profile này không có đoạn chat dự án đang mở.');
    if(chatRequestState(tab.id).busy)throw new Error('Đoạn chat đang xử lý yêu cầu khác.');
    const [injected]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:sendChatRequestPage,args:[text,attachments]});
    if(!injected.result?.ok)throw new Error(injected.result?.error||'Không gửi được yêu cầu vào ChatGPT.');
    return {action,target_id:tab.id,...injected.result};
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
  try{return await chrome.tabs.sendMessage(tabId,message);}
  catch{
    await chrome.scripting.executeScript({target:{tabId},files:['connector-installer.js']});
    return await chrome.tabs.sendMessage(tabId,message);
  }
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
    const tab=await openChatGpt(connector.settings_url || 'https://chatgpt.com/plugins?q=CodexPro');
    const result=await sendInstallerMessage(tab.id,connector);
    if(!result?.ok)throw new Error(result?.error || 'ChatGPT không hoàn tất thêm CodexPro.');
    await chrome.tabs.update(tab.id,{url:'https://chatgpt.com/',active:true});
    await waitForTab(tab.id,45000);
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

chrome.runtime.onInstalled.addListener(()=>{
  chrome.alarms.create('codexpro-bridge',{periodInMinutes:0.5});
  chrome.storage.local.get('codexproReloadTabId').then(async ({codexproReloadTabId})=>{
    if(Number.isInteger(codexproReloadTabId))await chrome.tabs.remove(codexproReloadTabId).catch(()=>{});
    await chrome.storage.local.remove('codexproReloadTabId');
  }).catch(()=>{});
  pollLoop();
});
chrome.runtime.onStartup.addListener(pollLoop);
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='codexpro-bridge'||alarm.name==='codexpro-reconnect')pollLoop();});
chrome.runtime.onMessage.addListener((message,_sender,sendResponse) => {
  if(message?.type!=='codexpro-install-connector')return false;
  installConnector().then(sendResponse).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));
  return true;
});
pollLoop();
