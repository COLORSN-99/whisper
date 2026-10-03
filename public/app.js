import {createStateSyncGuard} from './ui-state.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icons = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8.5 11.5h.01m4 0h.01m4 0h.01"/>',
  task: '<rect x="5" y="4" width="14" height="17" rx="3"/><path d="M9 4V3h6v1M9 10h6m-6 4h4m-4 4h3"/>',
  devices: '<rect x="2" y="4" width="15" height="12" rx="2"/><path d="M6 21h7m-3.5-5v5"/><rect x="16" y="10" width="6" height="11" rx="1.5"/>',
  settings: '<path d="m9.5 3-.6 2.1-2 .9-2-.5-2.5 4.3 1.4 1.6v2.3l-1.4 1.6L4.9 19l2-.5 2 .9.6 2.1h5l.6-2.1 2-.9 2 .5 2.5-4.3-1.4-1.6v-2.3l1.4-1.6L19.1 5l-2 .5-2-.9-.6-2.1h-5Z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  link: '<path d="m10 13 4-4m-6 7-1.5 1.5a3.5 3.5 0 0 1-5-5L6 8a3.5 3.5 0 0 1 5 0m2 8a3.5 3.5 0 0 0 5 0l4.5-4.5a3.5 3.5 0 0 0-5-5L16 8" transform="translate(0 -1)"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16m-5-10-2 2 2 2"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  send: '<path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  shield: '<path d="M12 3 3.5 6v6c0 5 8.5 9 8.5 9s8.5-4 8.5-9V6L12 3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  group: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-17a3 3 0 0 1 0 6m3 11v-3a6 6 0 0 0-3-5"/>',
  bulb: '<path d="M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 3l-4 18"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4m-3 14h2"/>',
  computer: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  external: '<path d="M14 3h7v7m0-7-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7m2-4v6l4 2"/>',
  leaf: '<path d="M20 3C9 3 3 7 3 13a7 7 0 0 0 7 7c6 0 10-6 10-17Z"/><path d="M4 21 15 10"/>',
};
function icon(name) {
  const el = document.createElement('span');
  // All markup in this helper is a fixed application-owned icon, never user/model content.
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.chat}</svg>`;
  return el;
}
function node(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content !== undefined && content !== null) el.textContent = String(content);
  return el;
}
function button(label, className, onClick, iconName) {
  const el = node('button', className);
  el.type = 'button';
  if (iconName) el.append(icon(iconName));
  if (label) el.append(node('span', '', label));
  if (onClick) el.addEventListener('click', onClick);
  return el;
}
function groupAvatar() {
  const el = node('span', 'group-avatars');
  for (let i = 0; i < 4; i++) el.append(node('span'));
  return el;
}
const state = {csrf:'', auth:{connected:false,persistence:'memory'}, providers:[], conversations:[], tasks:[], audit:[], workspace:null, fileTools:{available:false}, activeId:null, query:'', connected:false};
const pendingChats = new Set();
const approvalRequests = new Set();
const stateSync = createStateSyncGuard();
let messageSendPending = false;
let currentDialog = null;
let activeApprovalDialog = null;
let refreshTaskDialog = null;
let approvalStateFresh = false;
let events = null;
let reconnecting = false;
let rebootstrapPending = null;
const PLAN_NOTICE_KEY = 'whisper.plan-usage-notice.v1';
let planNoticeSeen = false;
// This is only a non-secret UI hint; credentials and account data never enter browser storage.
try { planNoticeSeen = localStorage.getItem(PLAN_NOTICE_KEY) === 'seen'; } catch { /* Private browsing may disable storage. */ }
let taskPanelOpen = window.innerWidth > 1070;
const app = $('#app');
const dialog = $('#app-dialog');
const statusNames = {queued:'等待开始',running:'进行中',needs_approval:'等待你的决定',completed:'已完成',failed:'未完成',cancelled:'已取消'};
const taskModes = {demo:{label:'本地演示',icon:'leaf'},files:{label:'本机文件 · 真实操作',icon:'task'},agent:{label:'ChatGPT · 文件工具',icon:'sparkle'},codex:{label:'Codex · 受阻断',icon:'computer'}};
const fileOperationNames = {list_files:'列出文件',read_file:'读取文件',create_file:'新建文件'};
const workspacePath = () => state.fileTools?.workspace || (typeof state.workspace==='string'?state.workspace:state.workspace?.path||state.workspace?.root) || '专用工作区路径尚未就绪';
const getConversation = () => state.conversations.find(c => c.id === state.activeId);
const getProvider = id => state.providers.find(p => p.id === id);
const isDemoConversation = c => !c?.members?.some(m => getProvider(m.providerId)?.kind !== 'demo');
const isRunning = c => !!c && (pendingChats.has(c.id) || c.messages?.some(m => m.status === 'streaming') || c.status === 'running' || c.generating === true);
function safeDate(value, options) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', options);
}
const timeLabel = value => safeDate(value,{hour:'2-digit',minute:'2-digit',hour12:false});
function toast(message, error = false) {
  const el = node('div', `toast${error?' error':''}`, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), error ? 6500 : 3800);
}
async function api(path, body) {
  const options = {headers:{Accept:'application/json'}};
  if (body !== undefined) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.headers['X-CSRF-Token'] = state.csrf;
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); } catch { throw new Error('本地服务返回了无法读取的响应，请稍后重试。'); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `请求未完成（${response.status}）`);
  return data;
}
function mergeState(data) {
  for (const key of ['csrf','auth','providers','conversations','tasks','audit','workspace','fileTools']) if (data[key] !== undefined) state[key] = data[key];
  if (!state.conversations.some(c => c.id === state.activeId)) state.activeId = state.conversations[0]?.id || null;
  for (const c of state.conversations) if (!c.messages?.some(m => m.status === 'streaming') && c.status !== 'running' && !c.generating) pendingChats.delete(c.id);
}
async function bootstrap() {
  const snapshotToken = stateSync.beginSnapshot();
  const data = await api('/api/bootstrap');
  const currentFields = stateSync.acceptSnapshot(data, snapshotToken);
  if (!currentFields) return;
  mergeState(currentFields);
  approvalStateFresh=true;
  renderAll();
  // Let the caller finish updating its settings dialog before showing the one-time welcome.
  setTimeout(maybeShowPlanNotice,0);
}
function refreshAfterReconnect() {
  if (rebootstrapPending) return rebootstrapPending;
  rebootstrapPending = bootstrap().catch(error => toast(error.message,true)).finally(() => { rebootstrapPending = null; });
  return rebootstrapPending;
}
function connectEvents() {
  events = new EventSource('/api/events');
  events.onopen = () => {
    state.connected = true;
    $('#server-status').textContent = '本地服务已连接';
    $('#server-status-dot').className = 'status-dot connected';
    if (reconnecting) { reconnecting = false; refreshAfterReconnect(); }
    else renderTasks();
  };
  events.onerror = () => {
    state.connected = false;
    approvalStateFresh=false;
    reconnecting = true;
    $('#server-status').textContent = '连接中断，正在重连';
    $('#server-status-dot').className = 'status-dot offline';
    renderTasks();syncApprovalDialog();
  };
  events.onmessage = event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'state') { stateSync.noteEvent(Object.keys(data.state || {}));mergeState(data.state || {});if(Array.isArray(data.state?.tasks))approvalStateFresh=true;renderAll(); }
    else if (data.type === 'message.delta') {
      const c = state.conversations.find(c => c.id === data.conversationId);
      if (!c) return;
      stateSync.noteEvent(['conversations']);
      let message = c.messages?.find(m => m.id === data.messageId);
      if (!message) {
        message = {id:data.messageId,role:'assistant',memberId:data.memberId,name:data.name,content:'',status:'streaming',createdAt:new Date().toISOString()};
        (c.messages ||= []).push(message);
        if (c.id === state.activeId) renderMessages();
      }
      message.content = (message.content || '') + (data.delta || '');
      message.status = 'streaming';
      pendingChats.add(c.id);
      if (c.id === state.activeId) {
        const nearBottom = isNearBottom();
        const el = [...$('#messages').children].find(el => el.dataset.messageId === message.id);
        const content = el && $('.message-content',el);
        if (content) content.textContent = message.content;
        else renderMessages();
        if (nearBottom) scrollBottom();
        renderComposer();
      }
    }
    else if (data.type === 'message.updated') {
      const c = state.conversations.find(c => c.id === data.conversationId);
      if (!c) return;
      stateSync.noteEvent(['conversations']);
      c.messages ||= [];
      const index = c.messages.findIndex(m => m.id === data.message.id);
      if (index < 0) c.messages.push(data.message); else c.messages[index] = {...c.messages[index],...data.message};
      if (!c.messages.some(m => m.status === 'streaming')) pendingChats.delete(c.id);
      c.updatedAt = data.message.createdAt || new Date().toISOString();
      if (c.id === state.activeId) {renderMessages();renderComposer();}
      renderConversations();
    }
    else if (data.type === 'auth.updated') {
      stateSync.noteEvent(['auth']);
      state.auth = data.auth || {connected:false};
      renderAuth(); renderComposer();
      if (currentDialog === 'settings') renderSettings();
      refreshAfterReconnect();
      if (state.auth.connected) toast(state.auth.planEnabled?'ChatGPT 已连接，刷新可用模型后即可聊天。':'已登录 ChatGPT；还需要开启计划额度权限。');
    }
    else if (data.type === 'error') {
      if (data.conversationId) pendingChats.delete(data.conversationId);
      toast(data.message || '操作未完成，请重试。',true);renderComposer();
    }
  };
}
function renderAll() {
  renderConversations();renderHeader();renderMessages();renderComposer();renderTasks();renderAuth();
  if(currentDialog==='task')refreshTaskDialog?.();
  syncApprovalDialog();
}
function selectConversation(id) {
  state.activeId = id;
  app.classList.add('mobile-chat');
  renderConversations();renderHeader();renderMessages(true);renderComposer();
  if (window.innerWidth > 760) $('#message-input').focus();
}
function renderConversations() {
  const list = $('#conversation-list');
  list.replaceChildren();
  const conversations = [...state.conversations].filter(c => !state.query || `${c.title} ${c.members?.map(m=>m.name).join(' ')}`.toLowerCase().includes(state.query)).sort((a,b)=>new Date(b.updatedAt||0)-new Date(a.updatedAt||0));
  for (const c of conversations) {
    const item = button('',`conversation-item${c.id===state.activeId?' active':''}`,()=>selectConversation(c.id));
    item.setAttribute('aria-label',`${c.title}${c.mode==='group'?'，群聊':'，私聊'}`);
    if(c.id===state.activeId)item.setAttribute('aria-current','true');
    const avatar = node('span',`avatar${c.mode==='group'?' group':''}`);
    avatar.append(c.mode==='group'?groupAvatar():icon(isDemoConversation(c)?'leaf':'sparkle'));
    const copy = node('span','conversation-copy');
    const line = node('span','conversation-line');
    line.append(node('strong','',c.title||'新会话'),node('time','',timeLabel(c.updatedAt)));
    const last = c.messages?.at(-1);
    const preview = last?.content?.replace(/\s+/g,' ').slice(0,70) || (c.mode==='group'?`${c.members?.length||0} 位伙伴，等你开启讨论`:'从一个想法开始聊聊');
    copy.append(line,node('p','',preview));
    item.append(avatar,copy);
    if(isRunning(c))item.append(node('span','conversation-pending'));
    list.append(item);
  }
  if(!conversations.length) list.append(node('div','empty-search',state.query?'没有找到这个会话':'还没有会话，点击右上角开始。'));
}
function renderHeader() {
  const c = getConversation();
  $('#chat-title').textContent = c?.title || '你的聊天空间';
  $('#chat-subtitle').textContent = c ? `${c.mode==='group'?`${c.members?.length||0} 位模型伙伴`:'私聊'} · ${c.members?.map(m=>m.name).join('、')||'等待添加成员'}` : '从一句话开始';
  $('#chat-avatar').className = `avatar header-avatar${c?.mode==='group'?' group':''}`;
  $('#chat-avatar').replaceChildren(c?.mode==='group'?groupAvatar():icon('leaf'));
  $('#chat-mode-badge').textContent = isDemoConversation(c)?'演示模式':'模型会话';
  $('#chat-mode-badge').className = `mode-badge${isDemoConversation(c)?'':' live'}`;
}
function isNearBottom() { const el=$('#chat-scroll');return el.scrollHeight-el.scrollTop-el.clientHeight<140; }
function scrollBottom() { requestAnimationFrame(()=>{const el=$('#chat-scroll');el.scrollTop=el.scrollHeight;}); }
function renderMessages(forceScroll=false) {
  const messages=$('#messages');
  const nearBottom=forceScroll||isNearBottom();
  const c=getConversation();
  messages.replaceChildren();
  if(!c?.messages?.length) {messages.append(welcome(c));return;}
  messages.append(node('div','day-divider',safeDate(c.messages[0].createdAt,{month:'long',day:'numeric'})||'新的对话'));
  for(const m of c.messages) messages.append(messageElement(m,c));
  if(nearBottom)scrollBottom();
}
function welcome(c) {
  const wrapper=node('div','welcome');
  const art=node('div','welcome-art');
  const orb=node('div','welcome-orb');orb.append(icon('leaf'));
  art.append(orb,node('span','welcome-spark','✦'),node('span','welcome-spark second','✧'),node('span','welcome-dot'));
  const group=c?.mode==='group';
  wrapper.append(art,node('span','eyebrow','A LITTLE LIGHT, A NEW IDEA'),node('h3','',group?'让不同的想法，在这里相遇。':'想法，慢慢聊成现实。'),node('p','welcome-description',group?'把问题抛给几位伙伴，听听不同的思路。你来掌握讨论的方向。':'一个问题、一点灵感，或一件想完成的事。这里有愿意陪你一起思考的伙伴。'));
  const starters=node('div','starter-grid');
  const suggestions=group?[['group','一起出个主意','让几位伙伴讨论同一个想法','请从各自的角度聊聊：怎样做一个真正有用的个人 AI 助手？'],['code','多一个视角','一起梳理方案与取舍','帮我讨论一个产品点子，并分别提出机会、实现思路和需要验证的问题。']]:[['bulb','聊一个新想法','把脑海里的灵感展开','我有一个新想法，想请你帮我一起梳理。'],['task','整理一件小事','把模糊的目标变成下一步','帮我把今天要做的事整理成几个清楚、容易开始的步骤。']];
  for(const [i,title,description,text] of suggestions){const b=button('','starter-card',()=>{if(!c)return openConversationDialog();$('#message-input').value=text;updateInput();$('#message-input').focus();});const copy=node('span');copy.append(node('strong','',title),node('small','',description));b.append(icon(i),copy);starters.append(b);}
  wrapper.append(starters,node('p','welcome-note',isDemoConversation(c)?'当前是本地演示。连接 ChatGPT 后，即可与真实模型聊天。':'消息会发送给你选择的模型；任务执行需要另行确认。'));
  return wrapper;
}
function messageElement(m,c) {
  const row=node('article',`message-row${m.role==='user'?' user':''}${m.status==='error'?' error':''}`);row.dataset.messageId=m.id;
  const member=c.members?.find(member=>member.id===m.memberId);
  const avatar=node('div','avatar');if(m.role==='user')avatar.textContent='我';else avatar.append(icon(member?.providerId==='demo'?'leaf':'sparkle'));
  const body=node('div','message-body');
  const meta=node('div','message-meta');meta.append(node('strong','',m.role==='user'?'我':m.name||member?.name||'模型伙伴'));
  if(m.role!=='user'&&getProvider(member?.providerId)?.kind==='demo')meta.append(node('span','demo-label','演示'));
  if(m.createdAt)meta.append(node('time','',timeLabel(m.createdAt)));
  const content=node('div','message-content',m.content||'');
  if(m.status==='streaming'&&!m.content){const typing=node('span','typing-indicator');typing.setAttribute('aria-label','正在回复');typing.append(node('i'),node('i'),node('i'));content.append(typing);}
  body.append(meta,content);
  if(m.status==='error')body.append(node('div','message-status error',m.error||'这条回复未完成'));
  else if(m.status==='streaming')body.append(node('div','message-status','正在回复…'));
  else if(m.status==='cancelled')body.append(node('div','message-status','已停止生成'));
  row.append(avatar,body);return row;
}
function renderComposer() {
  const c=getConversation();const running=isRunning(c);
  const context=$('#composer-context');context.replaceChildren(icon(c?.mode==='group'?'group':'sparkle'),node('span','',c?.members?.map(m=>`${m.name}`).join(' · ')||'选择一位模型伙伴'));
  $('#message-input').disabled=!c||messageSendPending;
  $('#send-message').disabled=!c||running||messageSendPending||!$('#message-input').value.trim();
  $('#cancel-message').classList.toggle('hidden',!running);
  $('#composer-footnote').textContent=isDemoConversation(c)?'演示回复由本地测试适配器生成，不会消耗模型额度。':'模型可能出错，请核对重要信息。电脑任务需独立授权后才会执行。';
  const usesChatGPTPlan=state.auth.connected&&state.auth.planEnabled&&c?.members?.some(m=>getProvider(m.providerId)?.kind==='chatgpt');
  const planUsage=$('#composer-plan-usage');
  planUsage.classList.toggle('hidden',!usesChatGPTPlan);
  planUsage.replaceChildren();
  if(usesChatGPTPlan)planUsage.append(planUsageSummary(true));
}
function updateInput(){const input=$('#message-input');input.style.height='auto';input.style.height=`${Math.min(input.scrollHeight,180)}px`;renderComposer();}
async function sendMessage(event){
  event?.preventDefault();const c=getConversation();const text=$('#message-input').value.trim();
  if(!c||!text||isRunning(c)||messageSendPending)return;
  messageSendPending=true;renderComposer();
  try{await api('/api/messages',{conversationId:c.id,text});$('#message-input').value='';updateInput();pendingChats.add(c.id);await bootstrap();scrollBottom();}
  catch(error){toast(error.message,true);}
  finally{messageSendPending=false;renderComposer();$('#message-input').focus();}
}
async function cancelMessage(){const c=getConversation();if(!c)return;const b=$('#cancel-message');b.disabled=true;try{await api('/api/chat/cancel',{conversationId:c.id});pendingChats.delete(c.id);await bootstrap();toast('已停止这次回复。');}catch(e){toast(e.message,true);}finally{b.disabled=false;renderComposer();}}
function setTaskPanel(open){taskPanelOpen=open;app.classList.toggle('tasks-closed',!open);$('#toggle-tasks').setAttribute('aria-expanded',String(open));$('#toggle-tasks').setAttribute('aria-label',open?'收起任务进展':'打开任务进展');$('#nav-tasks').classList.toggle('selected',open);}
function renderTasks(){
  const body=$('#task-panel-body');body.replaceChildren();
  if(state.tasks?.length){body.append(button('发起新任务','outline-button panel-new-task',()=>openTaskDialog(),'plus'));const active=task=>['queued','running','needs_approval'].includes(task.status)?1:0;const tasks=[...state.tasks].sort((a,b)=>active(b)-active(a)||new Date(b.createdAt||b.events?.[0]?.time||0)-new Date(a.createdAt||a.events?.[0]?.time||0));for(const task of tasks)body.append(taskElement(task));}
  else{
    const empty=node('div','task-empty');const illustration=node('div','task-illustration');illustration.append(icon('task'));empty.append(illustration,node('h3','','一起，把事情\n向前推。'),node('p','','让聊天延伸到行动。每一个关键进展，你都看得见。'),button('发起一个任务','outline-button',()=>openTaskDialog(),'plus'));body.append(empty);
  }
  const capabilities=node('div','capability-section');capabilities.append(node('p','panel-section-label','把主动权，留在你手里'));
  for(const [i,title,text] of [['history','过程清楚可见','任务进展与操作结果，实时呈现。'],['shield','每次文件操作都需确认','看清文件与内容，再允许这一次操作。'],['computer','只在专用文件空间内','列出、读取、新建文本；不开放任意命令。']]){const item=node('div','capability-item');const copy=node('div');copy.append(node('strong','',title),node('p','',text));item.append(icon(i),copy);capabilities.append(item);}
  const devices=node('div','device-note');devices.append(icon('phone'),button('Android 与远程设备 · 尚未接入','',openDevices));capabilities.append(devices);body.append(capabilities);
}
function taskElement(task){
  const card=node('article','task-card');
  const taskMode=taskModes[task.mode]||{label:'本地任务',icon:'task'};
  const header=node('div','task-card-header');header.append(icon(taskMode.icon),node('span','',taskMode.label),node('span',`task-state ${task.status}`,statusNames[task.status]||task.status));
  card.append(header,node('h3','',task.prompt||'任务'));
  const timeline=node('ol','task-timeline');
  for(const event of task.events||[]){const entry=node('li');const copy=node('div',`event-copy${['output','result','tool-result'].includes(event.kind)?' event-output':''}`,formatTaskEvent(event));copy.append(node('time','',timeLabel(event.time||event.createdAt)));entry.append(node('span','timeline-point'),copy);timeline.append(entry);}
  card.append(timeline);
  if(task.approval&&task.status==='needs_approval'){
    const approval=node('div','task-approval');approval.append(node('strong','',task.approval.title||'需要你确认'),node('pre','approval-preview',typeof task.approval.detail==='string'?task.approval.detail:JSON.stringify(task.approval.detail||{},null,2)));
    if(['files','agent'].includes(task.mode))approval.append(node('p','approval-boundary',task.mode==='agent'?'允许后，操作结果会发送给 OpenAI；读取动作会发送文件文本，供当前任务使用。':'本次由本地文件工具执行，不连接模型、不联网。'));
    approval.append(button('展开完整审批详情','text-link',()=>openTaskApproval(task.id)));
    const actions=node('div','approval-actions');
    for(const [label,decision] of [['同意本次操作','accept'],['拒绝','decline']]){const action=button(label,'',()=>submitTaskDecision(task.id,task.approval.id,decision));action.disabled=!canDecideTask(task,decision);actions.append(action);}
    approval.append(actions);card.append(approval);
  }
  if(['queued','running','needs_approval'].includes(task.status)){const footer=node('div','task-card-footer');footer.append(button('停止任务','',async e=>{const b=e.currentTarget;b.disabled=true;try{await api('/api/tasks/cancel',{taskId:task.id});await bootstrap();toast('已请求停止任务。');}catch(error){toast(error.message,true);b.disabled=false;}}));card.append(footer);}
  return card;
}
function formatTaskEvent(event){
  const message=event.message||event.text||event.kind||'状态已更新';
  if(event.kind!=='result')return message;
  let result=event.result;
  if(!result){try{result=JSON.parse(message);}catch{return message;}}
  if(Array.isArray(result?.files)){
    const files=result.files.filter(file=>file&&typeof file.name==='string');
    return `专用工作区里的合规文本文件（${files.length} 个）\n${files.length?files.map(file=>`• ${file.name} · ${Number(file.sizeBytes)||0} 字节`).join('\n'):'暂时没有合规文本文件。'}${result.skippedCount?`\n另有 ${result.skippedCount} 个不符合规则的项目，未读取。`:''}`;
  }
  if(typeof result?.content==='string'&&typeof result?.name==='string')return `已读取：${result.name} · ${Number(result.sizeBytes)||0} 字节\n\n${result.content}`;
  if(result?.created===true&&typeof result?.name==='string')return `已真实新建：${result.name}\n${Number(result.sizeBytes)||0} 字节 · 没有覆盖已有文件`;
  return message;
}
function canDecideTask(task,decision){
  if(!state.connected||!approvalStateFresh||task?.status!=='needs_approval'||!task.approval?.id||approvalRequests.has(`${task.id}:${task.approval.id}`))return false;
  if(decision==='accept'&&(!taskModes[task.mode]||typeof task.approval.detail!=='string'||!task.approval.detail.trim()))return false;
  if(decision==='accept'&&['files','agent'].includes(task.mode)&&(!fileOperationNames[task.approval.operation]||!Number.isFinite(task.approval.expiresAt)||task.approval.expiresAt<=Date.now()))return false;
  return true;
}
async function submitTaskDecision(taskId,approvalId,decision){
  const task=state.tasks.find(item=>item.id===taskId);
  if(task?.approval?.id!==approvalId||!canDecideTask(task,decision))return toast('当前审批状态不可用，请等待连接恢复或查看最新任务。');
  const key=`${taskId}:${approvalId}`;approvalRequests.add(key);renderTasks();syncApprovalDialog();
  try{await api('/api/tasks/decision',{taskId,approvalId,decision});if(currentDialog==='task-approval')dialog.close();await bootstrap();}
  catch(error){toast(error.message,true);await refreshAfterReconnect();}
  finally{approvalRequests.delete(key);renderTasks();syncApprovalDialog();}
}
function syncApprovalDialog(){
  if(currentDialog!=='task-approval'||!activeApprovalDialog)return;
  const task=state.tasks.find(item=>item.id===activeApprovalDialog.taskId);
  if(task?.status!=='needs_approval'||task.approval?.id!==activeApprovalDialog.approvalId){dialog.close();return;}
  for(const action of $$('[data-decision]',dialog))action.disabled=!canDecideTask(task,action.dataset.decision);
}
function openTaskApproval(taskId){
  const task=state.tasks.find(item=>item.id===taskId);
  if(!task?.approval||task.status!=='needs_approval')return toast('这次审批已结束，请查看任务最新状态。');
  const body=openDialog('task-approval',task.approval.title||'确认这一次操作','REVIEW THIS ACTION');
  activeApprovalDialog={taskId,approvalId:task.approval.id};
  body.append(node('p','dialog-intro',task.mode==='agent'?'这是 ChatGPT 提出的单次文件操作。批准后，操作结果会发送给 OpenAI，读取动作会发送文件文本，用于当前任务；拒绝会停止该动作。':task.mode==='files'?'这是一次真实的本地文件操作，不会联网。先核对操作、文件名和完整内容，再决定是否允许。':'请核对这次操作的范围，再作决定。'));
  body.append(node('code','workspace-path',workspacePath()),node('pre','approval-preview approval-preview-expanded',typeof task.approval.detail==='string'?task.approval.detail:JSON.stringify(task.approval.detail||{},null,2)));
  const actions=node('div','dialog-actions');
  for(const [label,decision] of [['拒绝这次操作','decline'],['同意本次操作','accept']]){const action=button(label,decision==='accept'?'primary-button':'secondary-button',()=>submitTaskDecision(taskId,task.approval.id,decision));action.dataset.decision=decision;action.disabled=!canDecideTask(task,decision);actions.append(action);}body.append(actions);
}
function renderAuth(){
  const auth=state.auth||{};
  $('#connection-title').textContent=auth.connected?(auth.planEnabled?'ChatGPT 已连接':'连接待开启计划权限'):'连接你的 ChatGPT';
  $('#connection-description').textContent=auth.connected?(auth.account?.label||auth.account?.email||'官方订阅登录'):'使用订阅计划的可用额度';
  $('#profile-button').title=auth.connected?'管理 ChatGPT 连接':'个人连接';
}
function openDialog(type,title,eyebrow='YOUR PERSONAL SPACE'){
  currentDialog=type;$('#dialog-content').replaceChildren();
  const header=node('div','dialog-header');const copy=node('div');copy.append(node('span','eyebrow',eyebrow),node('h2','',title));
  const close=button('','icon-button',()=>dialog.close(),'close');close.setAttribute('aria-label','关闭弹窗');header.append(copy,close);
  const body=node('div','dialog-body');$('#dialog-content').append(header,body);dialog.setAttribute('aria-label',title);if(!dialog.open)dialog.showModal();return body;
}
function field(label,type='text',placeholder='',value=''){
  const wrapper=node('div','field');const id=`field-${Math.random().toString(36).slice(2,10)}`;
  const input=node(type==='textarea'?'textarea':'input');if(type!=='textarea')input.type=type;input.id=id;input.placeholder=placeholder;input.value=value;
  const labelEl=node('label','',label);labelEl.htmlFor=id;wrapper.append(labelEl,input);return {wrapper,input};
}
function check(label){const wrapper=node('label','check-field');const input=node('input');input.type='checkbox';wrapper.append(input,node('span','',label));return {wrapper,input};}
function formError(container,error){let el=$('.form-error',container);if(!el){el=node('div','form-error');el.setAttribute('role','alert');container.append(el);}el.textContent=error.message||String(error);}
function select(options,value){const el=node('select');for(const option of options){const item=node('option','',option.label);item.value=option.value;if(option.disabled)item.disabled=true;el.append(item);}if(value!==undefined)el.value=value;return el;}
function openConversationDialog(initialMode='direct'){
  let mode=initialMode;let members=[];
  const body=openDialog('conversation','开启一段新对话','START A CONVERSATION');body.append(node('p','dialog-intro','选一位陪你思考的伙伴，或邀请多个模型，一起讨论。'));
  const segmented=node('div','segmented');
  const name=field('会话名称','text','给这段对话起个名字');name.input.maxLength=60;
  const label=node('div','field-label','模型伙伴');const list=node('div','member-list');const add=button('添加一位伙伴','text-button',()=>{if(members.length>=6)return toast('一个群聊最多 6 位伙伴。');members.push(defaultMember(members.length));renderMembers();},'plus');
  function defaultMember(index){const p=state.providers.find(p=>p.kind==='demo')||state.providers[0];return {name:mode==='direct'?'灵感伙伴':['灵感伙伴','实践伙伴','审阅伙伴'][index]||`伙伴 ${index+1}`,providerId:p?.id||'demo',model:p?.models?.[index%Math.max(p?.models?.length||1,1)]?.id||p?.models?.[0]?.id||'demo-guide'};}
  function renderMembers(){
    list.replaceChildren();
    members.forEach((member,index)=>{
      const row=node('div','member-row');const top=node('div','member-row-top');top.append(node('span','member-index',`伙伴 ${index+1}`));const n=node('input');n.value=member.name;n.placeholder='称呼 / 角色';n.maxLength=30;n.setAttribute('aria-label',`伙伴 ${index+1} 的称呼`);n.addEventListener('input',()=>{member.name=n.value;});top.append(n);
      if(mode==='group'&&members.length>2){const remove=button('','icon-button',()=>{members.splice(index,1);renderMembers();},'close');remove.setAttribute('aria-label',`移除伙伴 ${index+1}`);top.append(remove);}
      const selectors=node('div','member-selects');const provider=select(state.providers.map(p=>({value:p.id,label:`${p.label}${p.kind==='demo'?' · 演示':!p.connected?' · 未连接':''}`})),member.providerId);provider.setAttribute('aria-label',`伙伴 ${index+1} 的供应商`);
      const model=node('select');model.setAttribute('aria-label',`伙伴 ${index+1} 的模型`);
      function renderModels(){const p=getProvider(member.providerId);model.replaceChildren();for(const m of p?.models||[]){const option=node('option','',m.name||m.id);option.value=m.id;model.append(option);}if(!p?.models?.length){const option=node('option','','请先连接并获取模型');option.value='';model.append(option);member.model='';}if((p?.models||[]).some(m=>m.id===member.model))model.value=member.model;else member.model=model.value;}
      provider.addEventListener('change',()=>{member.providerId=provider.value;member.model='';renderModels();});model.addEventListener('change',()=>{member.model=model.value;});renderModels();selectors.append(provider,model);row.append(top,selectors);list.append(row);
    });add.classList.toggle('hidden',mode!=='group');
  }
  function changeMode(value){mode=value;for(const b of segmented.children)b.classList.toggle('active',b.dataset.mode===mode);members=mode==='direct'?[members[0]||defaultMember(0)]:[members[0]||defaultMember(0),members[1]||defaultMember(1)];renderMembers();}
  for(const [value,text] of [['direct','一对一私聊'],['group','多模型群聊']]){const b=button(text,'',()=>changeMode(value));b.dataset.mode=value;segmented.append(b);}
  body.append(segmented,name.wrapper,label,list,add,node('p','form-note','演示伙伴仅生成本地测试回复。使用真实模型前，请先在连接设置中完成授权。'));
  const actions=node('div','dialog-actions');const create=button('开始聊天','primary-button',async()=>{
    if(members.some(m=>!m.name.trim()||!m.model))return formError(body,new Error('请为每位伙伴填写称呼，并选择可用模型。'));
    if(new Set(members.map(m=>m.name.trim())).size!==members.length)return formError(body,new Error('请给每位伙伴不同的称呼，以便在群聊中区分。'));
    if(members.some(m=>getProvider(m.providerId)?.kind!=='demo'&&!getProvider(m.providerId)?.connected))return formError(body,new Error('请先连接所选的供应商，再创建这段对话。'));
    create.disabled=true;
    try{const result=await api('/api/conversations',{title:name.input.value.trim()||(mode==='group'?'新的讨论':`与${members[0].name.trim()}聊天`),mode,members:members.map(m=>({...m,name:m.name.trim()}))});if(result.conversation&&!state.conversations.some(c=>c.id===result.conversation.id))state.conversations.push(result.conversation);dialog.close();await bootstrap();selectConversation(result.conversation.id);}
    catch(e){formError(body,e);}finally{create.disabled=false;}
  });actions.append(button('取消','secondary-button',()=>dialog.close()),create);body.append(actions);changeMode(mode);
}
let settingsTab='chatgpt';
function planUsageSummary(enabled){
  const row=node('div','plan-usage-row');
  row.append(node('span','',enabled?'Using ChatGPT plan':'ChatGPT plan usage · 尚未启用'));
  const link=node('a','plan-usage-link','管理用量');
  link.href='https://chatgpt.com/settings/usage';link.target='_blank';link.rel='noopener noreferrer';
  link.setAttribute('aria-label','管理用量（Manage usage，在 ChatGPT 新页面打开）');link.append(icon('external'));row.append(link);
  return row;
}
function maybeShowPlanNotice(){
  if(planNoticeSeen||!state.auth.connected||!state.auth.planEnabled||currentDialog==='plan-usage')return;
  if(currentDialog&&currentDialog!=='settings')return;
  planNoticeSeen=true;
  try { localStorage.setItem(PLAN_NOTICE_KEY,'seen'); } catch { /* The in-memory flag still avoids repeated notices this session. */ }
  const body=openDialog('plan-usage','已启用你的 ChatGPT 计划','CHATGPT PLAN USAGE');
  body.append(node('p','dialog-intro','Whisper 中符合条件的 AI 请求会使用你的 ChatGPT 计划或积分额度。你可以在 ChatGPT 设置中查看用量并调整限额。此提示不会发送消息或启动任务。'),planUsageSummary(true));
  const actions=node('div','dialog-actions');actions.append(button('我知道了','primary-button',()=>dialog.close()));body.append(actions);
}
function openSettings(tab='chatgpt'){settingsTab=tab;renderSettings();}
function renderSettings(){
  const body=openDialog('settings','连接与设置','MAKE IT YOURS');
  const tabs=node('div','segmented');for(const [id,title] of [['chatgpt','ChatGPT 订阅'],['compatible','其他供应商']])tabs.append(button(title,id===settingsTab?'active':'',()=>{settingsTab=id;renderSettings();}));body.append(tabs);
  if(settingsTab==='chatgpt')renderChatGPTSettings(body);else renderCompatibleSettings(body);
}
function showAuthorizationLink(body,result){
  const url=new URL(result.url);
  if(url.protocol!=='https:')throw new Error('登录地址不是安全的官方授权链接，请检查服务配置。');
  $('.connection-link',body)?.remove();$('.inline-status',body)?.remove();
  const link=node('a','connection-link','前往官方页面完成授权');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.append(icon('external'));
  body.append(link,node('p','inline-status','官方登录已准备好。请点击上方链接，在新页面确认登录和授权；完成后此处会自动更新。'));
  link.focus();
}
function renderChatGPTSettings(body){
  const auth=state.auth||{};
  if(auth.warning)body.append(node('div','reconnect-banner',auth.warning));
  if(auth.revocation)body.append(node('div','reconnect-banner',typeof auth.revocation==='string'?auth.revocation:JSON.stringify(auth.revocation)));
  const summary=node('div','auth-summary');const header=node('div','auth-summary-header');const copy=node('div');copy.append(node('strong','',auth.connected?(auth.planEnabled?'已连接 ChatGPT':'已登录 · 计划额度未授权'):'使用你的 ChatGPT 计划'),node('small','',auth.connected?(auth.account?.label||auth.account?.email||'个人授权连接'):'通过 OpenAI 官方登录完成授权'));header.append(icon(auth.connected?'check':'sparkle'),copy);summary.append(header);
  summary.append(node('p','',auth.connected?`凭据${(auth.persistence||auth.storage)==='keychain'?'已保存到本应用的 macOS 钥匙串':'仅保留在当前服务内存，退出后需要重新登录'}。可用模型和额度由你的计划及官方接入权限决定。`:'在官方登录页选择你的账户。若该页面提供 Google 登录，你可以在那里继续。可用额度由你的计划与官方支持范围决定。'));body.append(summary);
  if(auth.connected){
    body.append(planUsageSummary(auth.planEnabled));
    if(!auth.planEnabled){
      const consent=check('我同意重新打开官方授权页，申请在 Whisper 中使用 ChatGPT 计划额度；最终权限由我在官方页面确认。');
      const persisted=(auth.persistence||auth.storage)==='keychain';
      const keep=check('我允许将重新授权后的凭据继续保存到 Whisper 自己的 macOS 钥匙串。');
      body.append(consent.wrapper);if(persisted)body.append(keep.wrapper);
      const authorize=button('重新授权计划额度','primary-button',async()=>{authorize.disabled=true;try{showAuthorizationLink(body,await api('/api/auth/start',{consent:true,enablePlan:true,persist:persisted,persistenceConsent:persisted&&keep.input.checked}));}catch(error){formError(body,error);}finally{authorize.disabled=!consent.input.checked||(persisted&&!keep.input.checked);}},'external');
      const update=()=>{authorize.disabled=!consent.input.checked||(persisted&&!keep.input.checked);};consent.input.addEventListener('change',update);keep.input.addEventListener('change',update);update();body.append(authorize);
    }
    const actions=node('div','dialog-actions stacked');
    actions.append(button('刷新可用模型','secondary-button',async e=>{const trigger=e.currentTarget;trigger.disabled=true;try{const result=await api('/api/models?providerId=chatgpt');const p=state.providers.find(p=>p.kind==='chatgpt');if(p)p.models=result.models||[];toast(`已更新 ${result.models?.length||0} 个可用模型。`);}catch(error){formError(body,error);}finally{trigger.disabled=false;}}));
    actions.append(button('退出并清除此应用的登录凭据','secondary-button',async e=>{const trigger=e.currentTarget;trigger.disabled=true;try{const result=await api('/api/auth/logout',{});await bootstrap();renderSettings();toast(result.auth?.warning||(result.auth?.revocationConfirmed?'已退出，并确认撤销此应用的授权。':'已退出此应用的本地连接。'),!!result.auth?.warning);}catch(error){formError(body,error);trigger.disabled=false;}}));body.append(actions,node('p','form-note','这会清除此应用的内存 / 钥匙串凭据。官方账户上的授权是否撤销，以服务返回的状态和官方账户管理页面为准。'));
  }else{
    body.append(node('p','dialog-intro','这是 Whisper 的新连接。不会读取或复用现有 Codex 登录，也不会继承你与 Dear 的身份、历史或私有工具权限。'));
    const consent=check('我同意为 Whisper 创建新的 ChatGPT 授权连接，并在官方页面确认后使用计划额度聊天或执行我批准的任务。');
    const persist=check('允许把这次连接的凭据保存到本应用的 macOS 钥匙串，方便下次由我明确恢复。默认只在内存中保存。');
    persist.input.disabled=auth.persistenceAvailable!==true;
    body.append(consent.wrapper,persist.wrapper);
    if(auth.persistenceAvailable!==true)body.append(node('p','form-note','本机尚未准备好钥匙串组件；当前可使用内存连接。若要启用保存与恢复，请在本项目目录运行 npm run build:keychain，然后重启本地服务。'));
    const login=button('Continue with ChatGPT','primary-button',async()=>{
      if(!consent.input.checked)return;
      login.disabled=true;$('.form-error',body)?.remove();
      try{
        const result=await api('/api/auth/start',{consent:true,persist:persist.input.checked,persistenceConsent:persist.input.checked});
        showAuthorizationLink(body,result);
      }catch(error){formError(body,error);}finally{login.disabled=!consent.input.checked;}
    },'external');login.disabled=true;consent.input.addEventListener('change',()=>{login.disabled=!consent.input.checked;});
    const actions=node('div','dialog-actions stacked');actions.append(login);body.append(actions);
    body.append(node('div','divider-label','已经为 Whisper 保存过连接'));
    const resume=button('确认从本应用钥匙串恢复','secondary-button',async()=>{resume.disabled=true;try{const result=await api('/api/auth/resume',{consent:true});await bootstrap();renderSettings();toast(result.auth?.connected?'已恢复本应用的连接。':'尚未找到 Whisper 保存的连接，请先完成新连接。');}catch(error){formError(body,error);}finally{resume.disabled=auth.persistenceAvailable!==true;}});resume.disabled=auth.persistenceAvailable!==true;resume.style.width='100%';body.append(resume,node('p','form-note','点击恢复表示允许读取 Whisper 自己的钥匙串项目；不会读取其他应用的凭据。'));
  }
  body.append(node('p','form-note','此接入使用客户端会话历史；不导入 ChatGPT 历史。模型请求仅在你发送消息或明确发起任务后开始。'));
}
function renderCompatibleSettings(body){
  body.append(node('p','dialog-intro','接入支持 OpenAI 兼容聊天接口的其他供应商。密钥仅留在当前本地服务内存中，不写入浏览器存储。'));
  for(const p of state.providers.filter(p=>p.kind==='compatible')){const card=node('div','provider-card');const copy=node('div');copy.append(node('strong','',p.label),node('small','',`${p.models?.length||0} 个模型`));card.append(icon('link'),copy,node('span','connected-pill',p.connected?'已连接':'未连接'));const remove=button('移除','text-button',async()=>{remove.disabled=true;try{await api('/api/providers/remove',{id:p.id});await bootstrap();renderSettings();toast('已移除此内存连接。');}catch(error){formError(body,error);remove.disabled=false;}});remove.setAttribute('aria-label',`移除 ${p.label} 的内存连接`);card.append(remove);body.append(card);}
  const name=field('连接名称','text','例如：我的模型服务');name.input.maxLength=60;
  const base=field('API Base URL','url','https://api.example.com/v1');base.input.autocomplete='off';
  const key=field('API Key','password','只保存在服务内存中');key.input.autocomplete='new-password';key.input.spellcheck=false;
  const models=field('模型 ID','text','例如：model-a, model-b');models.wrapper.append(node('small','','多个模型用英文逗号分隔，以供应商提供的模型 ID 为准。'));
  body.append(name.wrapper,base.wrapper,key.wrapper,models.wrapper);
  const consent=check('我确认此地址与密钥属于我要使用的供应商。发送消息会将会话内容交给该供应商，并可能产生费用。');body.append(consent.wrapper);
  const save=button('保存内存连接','primary-button',async()=>{save.disabled=true;try{const modelIds=models.input.value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);if(!name.input.value.trim()||!base.input.value.trim()||!key.input.value||!modelIds.length)throw new Error('请填写连接名称、地址、密钥与至少一个模型 ID。');await api('/api/providers',{name:name.input.value.trim(),baseUrl:base.input.value.trim(),apiKey:key.input.value,models:modelIds});key.input.value='';await bootstrap();renderSettings();toast('连接已保存到当前服务内存。');}catch(error){formError(body,error);}finally{save.disabled=!consent.input.checked;}});save.disabled=true;consent.input.addEventListener('change',()=>{save.disabled=!consent.input.checked;});const actions=node('div','dialog-actions');actions.append(save);body.append(actions);
}
function openTaskDialog(){
  const body=openDialog('task','让想法往前一步','A TASK, WITH YOU IN CONTROL');
  body.append(node('p','dialog-intro','选择执行方式。真实文件操作会先列出待批动作，由你逐次确认。'));
  const segmented=node('div','segmented task-mode-tabs');
  let mode=state.fileTools?.available===true?'files':'demo';
  let submitting=false;
  const operationField=node('div','field');
  const operationLabel=node('label','','文件操作');operationLabel.htmlFor='task-file-operation';
  const operation=select(Object.entries(fileOperationNames).map(([value,label])=>({value,label})),'list_files');operation.id='task-file-operation';
  operationField.append(operationLabel,operation);
  const filename=field('文件名','text','例如：任务笔记.md');filename.input.maxLength=180;filename.input.autocomplete='off';filename.input.spellcheck=false;
  filename.wrapper.append(node('small','','支持文字、数字、空格、_、-、.，UTF-8 最多 180 字节；不能以 . 开头，不能含 .. 或首尾空格。后缀仅 .txt、.md、.csv、.json。'));
  const content=field('新文件的完整内容','textarea','写下要保存的文字；提交后仍需你批准。');content.input.maxLength=131072;content.input.rows=5;
  const byteCount=node('small','file-byte-count');content.wrapper.append(byteCount);
  const prompt=field('想完成什么？','textarea','例如：列出专用工作区文件，读取我批准的笔记并提出下一步。');prompt.input.maxLength=12000;
  const modelField=node('div','field');
  const modelLabel=node('label','','执行模型');modelLabel.htmlFor='task-agent-model';
  const chatgpt=state.providers.find(p=>p.kind==='chatgpt');
  const model=select((chatgpt?.models||[]).map(m=>({value:m.id,label:m.name||m.id})));model.id='task-agent-model';modelField.append(modelLabel,model);
  const availability=node('div','file-tools-availability');
  const warning=node('div','task-dialog-warning');
  const usage=node('div');usage.append(planUsageSummary(true));
  const permissions=node('div','file-permissions');
  permissions.append(node('strong','','本次文件权限范围'),node('code','workspace-path',workspacePath()),node('p','','仅列出、读取、新建此目录顶层的 .txt / .md / .csv / .json 文本文件。新建不会覆盖已有文件；不删除、不访问应用外文件、不授予任意 shell 或手机控制权限，也不变更系统权限。'));
  const example=button('填入“创建任务笔记”示例','text-link',()=>{
    if(mode==='files'){
      operation.value='create_file';filename.input.value='task-notes.md';
      content.input.value='# 任务笔记\n\n目标：把一个想法整理成可以完成的小步骤。\n\n- [ ] 明确目标\n- [ ] 做一个小验证\n- [ ] 记录结果\n';
    }else if(mode==='agent')prompt.input.value='请先列出专用工作区的文件，再建议一份 task-notes.md 任务笔记；所有文件动作都先给我审批，禁止覆盖已有文件。';
    else prompt.input.value='演示一次任务进展，并在下一步模拟动作前请我确认。';
    resetConsent();update();
  });
  const consent=check('');
  const consentCopy=$('span',consent.wrapper);
  const run=button('提交，等待审批','primary-button',async()=>{
    update();
    if(run.disabled||submitting)return;
    const text=prompt.input.value.trim();
    let request={mode,consent:true};
    if(mode==='files'){
      const name=filename.input.value;
      const validName=name&&name===name.trim()&&!name.startsWith('.')&&!name.includes('..')&&/^[\p{L}\p{M}\p{Nd} _.-]+$/u.test(name)&&new TextEncoder().encode(name).length<=180&&/[.](txt|md|csv|json)$/.test(name);
      if(operation.value!=='list_files'&&!validName)return formError(body,new Error('文件名不符合专用工作区规则，请检查字符、长度和小写扩展名。'));
      if(operation.value==='create_file'&&new TextEncoder().encode(content.input.value).length>131072)return formError(body,new Error('新文件内容超过 128 KiB，请缩短后再提交。'));
      request={...request,operation:operation.value,args:operation.value==='list_files'?{}:{name,...(operation.value==='create_file'?{content:content.input.value}:{})},prompt:operation.value==='list_files'?'列出专用工作区里的文本文件':`${fileOperationNames[operation.value]}：${name}`};
    }else{
      if(!text)return formError(body,new Error('请先描述你希望完成的任务。'));
      request={...request,prompt:text,...(mode==='agent'?{model:model.value}:{})};
    }
    submitting=true;update();$('.form-error',body)?.remove();
    try{
      await api('/api/tasks',request);dialog.close();setTaskPanel(true);await bootstrap();
      toast(mode==='demo'?'演示任务已开始。':mode==='files'?'文件操作已提交。请在任务面板核对并审批。':'ChatGPT 文件任务已开始；每个文件动作仍需你审批。');
    }catch(error){formError(body,error);}finally{submitting=false;update();}
  });
  function resetConsent(){consent.input.checked=false;$('.form-error',body)?.remove();}
  function update(){
    const real=mode!=='demo';
    const helperReady=state.fileTools?.available===true;
    const accountReady=state.auth.connected===true&&state.auth.planEnabled===true;
    $('.workspace-path',permissions).textContent=workspacePath();
    for(const tab of segmented.children){tab.classList.toggle('active',tab.dataset.mode===mode);tab.disabled=tab.dataset.mode==='agent'&&!accountReady;}
    operationField.classList.toggle('hidden',mode!=='files');
    filename.wrapper.classList.toggle('hidden',mode!=='files'||operation.value==='list_files');
    content.wrapper.classList.toggle('hidden',mode!=='files'||operation.value!=='create_file');
    prompt.wrapper.classList.toggle('hidden',mode==='files');modelField.classList.toggle('hidden',mode!=='agent');usage.classList.toggle('hidden',mode!=='agent');
    byteCount.textContent=`${new TextEncoder().encode(content.input.value).length.toLocaleString('zh-CN')} / 131,072 字节（UTF-8，上限 128 KiB）；新建禁止覆盖。`;
    availability.replaceChildren();
    if(!helperReady){const reason=state.fileTools?.reason||'受限文件工具尚未准备好。';availability.append(node('p','reconnect-banner',reason.includes('npm run build:files')?reason:`${reason} 请在本项目运行 npm run build:files，然后重启服务。`));}
    if(!accountReady)availability.append(node('p','form-note','ChatGPT 调度需要先完成登录与计划额度授权；本机文件操作无需登录、不调用模型。'));
    else if(mode==='agent'&&!model.value)availability.append(node('p','form-note','请先到连接设置刷新可用模型，再创建 ChatGPT 文件任务。'));
    warning.replaceChildren();
    if(mode==='demo')warning.append(node('strong','','本地演示 · 不调用模型，不读写文件'),node('div','','测试适配器只模拟进展与审批，结果会明确标注演示。'));
    else if(mode==='files')warning.append(node('strong','','真实本机文件操作 · 不联网'),node('div','','提交只创建待批动作；你确认后才会列出、读取或新建文件。操作结果保存在本应用的任务记录中。'));
    else warning.append(node('strong','','ChatGPT 调度 · 仅可用同一组受限文件工具'),node('div','','启动后，你填写的任务目标会发送给 OpenAI 并使用计划额度。每个文件动作都单独审批；批准读取后，文件文本会发送给 OpenAI 供当前任务使用。'));
    permissions.classList.toggle('hidden',!real);
    example.textContent=mode==='files'?'填入“创建任务笔记”示例':mode==='agent'?'填入文件助手示例':'填入演示示例';
    consentCopy.textContent=mode==='files'?'我已了解文件范围，确认提交待批操作；此次勾选不会直接执行读写。':mode==='agent'?'我同意将任务目标发送给 OpenAI 并使用 ChatGPT 计划额度；文件动作与文件内容发送仍需逐次批准。':'我已了解这是演示，确认启动本次模拟任务。';
    run.textContent=mode==='files'?'提交，等待审批':mode==='agent'?'开始 ChatGPT 文件任务':'开始演示任务';
    run.disabled=submitting||!consent.input.checked||(real&&!helperReady)||(mode==='agent'&&(!accountReady||!model.value));
  }
  for(const [value,label] of [['demo','演示'],['files','本机文件'],['agent','ChatGPT 调度']]){
    const tab=button(label,'',()=>{mode=value;resetConsent();update();});tab.dataset.mode=value;segmented.append(tab);
  }
  operation.addEventListener('change',()=>{resetConsent();update();});
  for(const input of [filename.input,content.input,prompt.input])input.addEventListener('input',()=>{resetConsent();update();});
  model.addEventListener('change',()=>{resetConsent();update();});consent.input.addEventListener('change',update);
  const legacy=node('details','legacy-execution-note');legacy.append(node('summary','','关于 Codex 命令执行'),node('p','','当前 Codex 桥使用的 RPC 与本机 CLI 不兼容，通用命令暂未开放。命名权限策略正另行验证；这里的受限文件工具可独立使用。'));
  const actions=node('div','dialog-actions');actions.append(button('稍后再说','secondary-button',()=>dialog.close()),run);
  body.append(segmented,availability,operationField,filename.wrapper,content.wrapper,prompt.wrapper,modelField,usage,warning,example,permissions,consent.wrapper,actions,legacy);
  refreshTaskDialog=update;
  update();
}
function openDevices(){
  const body=openDialog('devices','你的设备','YOUR DEVICES, YOUR CONTROL');body.append(node('p','dialog-intro','让伙伴在你允许的范围内帮忙。远程设备接入仍在后续阶段，当前没有已配对的手机或远程电脑。'));
  for(const [i,title,text,status] of [['computer','这台 Mac · 专用文件空间','可逐次批准列出、读取或新建受限文本文件；不开放任意命令，不覆盖或删除文件。',state.fileTools?.available?'受限文件工具可用':'文件工具待准备'],['devices','远程电脑','尚未接入。未来需要明确授权、可撤销配对、操作审计与关键动作确认。','未配对'],['phone','Android 手机','尚未接入。未来仅在本人设备的明确授权范围内提供移动 Agent 操作。','尚未开放']]){
    const card=node('div','device-card');const iconEl=icon(i);iconEl.className='device-icon';const copy=node('div');copy.append(node('h3','',title),node('p','',text),node('span','device-pill',status));if(i==='computer'&&state.workspace)copy.append(node('code','workspace-path',workspacePath()));card.append(iconEl,copy);body.append(card);
  }
  body.append(node('p','form-note','本地服务只在回环地址上工作，不对公网提供执行接口。'));
}
function openAudit(){
  const body=openDialog('audit','操作记录','A CLEAR RECORD');body.append(node('p','dialog-intro','查看此本地会话中的连接、任务与审批事件。记录不包含密钥或令牌。'));
  const list=node('div','audit-list');
  const actions={'auth.started':'准备官方登录','auth.connected':'ChatGPT 已连接','auth.disconnected':'已退出 ChatGPT 连接','conversation.created':'创建会话','provider.connected':'添加供应商连接','provider.removed':'移除供应商连接','task.started':'启动任务','task.decision':'确认任务决策','task.cancelled':'停止任务','tool.proposed':'文件动作等待审批','tool.result':'文件动作返回结果'};
  for(const entry of [...(state.audit||[])].reverse().slice(0,100)){const el=node('article','audit-entry');el.append(node('strong','',entry.message||actions[entry.action]||entry.action||entry.type||entry.kind||'操作事件'));const detail=entry.detail||entry.details;if(detail)el.append(node('p','',typeof detail==='string'?detail:JSON.stringify(detail)));if(entry.mode)el.append(node('p','',taskModes[entry.mode]?.label||'本地任务'));if(entry.operation)el.append(node('p','',`${fileOperationNames[entry.operation]||entry.operation}${entry.name?` · ${entry.name}`:''}`));if(entry.decision)el.append(node('p','',entry.decision==='accept'?'允许一次':'已拒绝'));el.append(node('time','',safeDate(entry.time||entry.createdAt||entry.at,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})));list.append(el);}
  if(!state.audit?.length)list.append(node('div','empty-search','暂时没有操作记录。'));body.append(list);
}
function openChatDetails(){const c=getConversation();if(!c)return;const body=openDialog('details',c.title||'会话成员','CONVERSATION MEMBERS');body.append(node('p','dialog-intro',c.mode==='group'?'各位伙伴会使用相同的会话上下文依次回复。':'此会话的模型与供应商。'));for(const m of c.members||[]){const el=node('div','member-info');const avatar=node('span','avatar');avatar.append(icon(getProvider(m.providerId)?.kind==='demo'?'leaf':'sparkle'));const copy=node('div');copy.append(node('strong','',m.name),node('p','',`${getProvider(m.providerId)?.label||m.providerId} · ${m.model}${getProvider(m.providerId)?.kind==='demo'?' · 本地演示':''}`));el.append(avatar,copy);body.append(el);}}
function setup(){
  for(const [id,name] of [['nav-chats','chat'],['nav-tasks','task'],['nav-devices','devices'],['nav-audit','shield'],['nav-settings','settings'],['new-conversation','plus'],['search-icon','search'],['connection-icon','sparkle'],['connection-arrow','arrow'],['mobile-back','back'],['chat-details','more'],['toggle-tasks','panel'],['send-message','send'],['close-tasks','close'],['shield-icon','shield']])$('#'+id).append(icon(name));
  $('#cancel-message').append(icon('stop'),node('span','','停止'));
  $('#nav-chats').addEventListener('click',()=>{app.classList.remove('mobile-chat');if(window.innerWidth<=1070)setTaskPanel(false);});
  $('#nav-tasks').addEventListener('click',()=>setTaskPanel(!taskPanelOpen));
  $('#nav-devices').addEventListener('click',openDevices);$('#nav-audit').addEventListener('click',openAudit);
  for(const id of ['nav-settings','profile-button','connection-card'])$('#'+id).addEventListener('click',()=>openSettings());
  $('#new-conversation').addEventListener('click',()=>openConversationDialog());$('#new-group').addEventListener('click',()=>openConversationDialog('group'));
  $('#conversation-search').addEventListener('input',e=>{state.query=e.target.value.trim().toLowerCase();renderConversations();});
  $('#toggle-tasks').addEventListener('click',()=>setTaskPanel(!taskPanelOpen));$('#close-tasks').addEventListener('click',()=>setTaskPanel(false));$('#composer-task').addEventListener('click',()=>{setTaskPanel(true);openTaskDialog();});
  $('#mobile-back').addEventListener('click',()=>app.classList.remove('mobile-chat'));$('#chat-details').addEventListener('click',openChatDetails);
  $('#message-form').addEventListener('submit',sendMessage);$('#message-input').addEventListener('input',updateInput);$('#message-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMessage();}});$('#cancel-message').addEventListener('click',cancelMessage);
  dialog.addEventListener('close',()=>{currentDialog=null;activeApprovalDialog=null;refreshTaskDialog=null;$('#dialog-content').replaceChildren();maybeShowPlanNotice();});
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(dialog.open)dialog.close();app.classList.remove('mobile-chat');$('#conversation-search').focus();}if(e.key==='Escape'&&!dialog.open&&taskPanelOpen&&window.innerWidth<=1070)setTaskPanel(false);});
  window.addEventListener('resize',()=>{if(window.innerWidth<=1070&&taskPanelOpen&&!window.matchMedia('(min-width: 1071px)').matches)setTaskPanel(false);});
  setTaskPanel(taskPanelOpen);renderHeader();renderComposer();renderTasks();
}
setup();
bootstrap().then(connectEvents).catch(error=>{toast(`无法连接本地服务：${error.message}`,true);$('#server-status').textContent='本地服务暂不可用';$('#server-status-dot').className='status-dot offline';$('#conversation-list').replaceChildren(node('div','empty-search','服务连接失败。请确认本地服务已启动，然后刷新页面。'));});
