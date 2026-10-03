import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { StateStore } from './store.mjs';
import { ProviderRegistry } from './providers.mjs';
import { OAuthManager } from './oauth.mjs';
import { MacOSKeychainTokenStore } from './token-store.mjs';
import { CodexBridge } from './codex.mjs';
import { FileTools } from './file-tools.mjs';
import { FileAgent } from './file-agent.mjs';

const PROJECT_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ACTIVE_TASKS=new Set(['queued','running','needs_approval']);
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
const escapeHTML=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function selectMentionedMembers(members,text) {
  const byLength=[...members].sort((a,b)=>b.name.length-a.name.length);
  const matched=new Set();
  for(const match of text.matchAll(/@/g)){
    const suffix=text.slice(match.index+1);
    const member=byLength.find(m=>suffix.startsWith(m.name)&&(!suffix[m.name.length]||/[\s,，:：;；.!?。！？]/u.test(suffix[m.name.length])));
    if(member)matched.add(member);
  }
  const selected=members.filter(m=>matched.has(m));
  return selected.length?selected:members;
}

async function readJSON(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')) throw Object.assign(new Error('请求需要 JSON。'),{status:415});
  const chunks=[]; let bytes=0;
  // A 128 KiB UTF-8 draft can expand up to sixfold when JSON escapes controls.
  for await (const chunk of req) { bytes+=chunk.length;if(bytes>1_000_000)throw Object.assign(new Error('请求过大。'),{status:413});chunks.push(chunk); }
  const text=Buffer.concat(chunks).toString('utf8');
  try {const data=JSON.parse(text||'{}');if(!data||Array.isArray(data)||typeof data!=='object')throw 0;return data;}
  catch {throw Object.assign(new Error('请求格式错误。'),{status:400});}
}

function safeError(error) {
  // Controlled module errors are readable; transport exceptions may contain credentialed URLs.
  const text=String(error?.message||'操作失败。');
  if (text.length>500 || /https?:|Bearer |access_token|refresh_token|id_token|sk-/i.test(text)) return '请求未完成。请检查连接或重新登录；敏感诊断未写入日志。';
  return text;
}

export function createApp({port=4783,dataDir=path.join(PROJECT_ROOT,'.data'),oauthFactory,providerFactory,bridgeFactory,fileToolsFactory,fileAgentFactory}={}) {
  const base=`http://127.0.0.1:${port}`;
  const workspace=path.join(dataDir,'task-workspace');
  if (fs.existsSync(dataDir)&&fs.lstatSync(dataDir).isSymbolicLink()) throw new Error('应用数据目录不能为符号链接。');
  if (fs.existsSync(workspace)&&fs.lstatSync(workspace).isSymbolicLink()) throw new Error('任务工作区不能为符号链接。');
  fs.mkdirSync(workspace,{recursive:true,mode:0o700});
  const store=new StateStore(dataDir);
  const helperPath=path.join(PROJECT_ROOT,'.runtime','whisper-keychain');
  const persistentStore=process.platform==='darwin'&&fs.existsSync(helperPath)&&!fs.lstatSync(helperPath).isSymbolicLink()
    ?new MacOSKeychainTokenStore({helperPath,account:`local-${createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0,24)}`}):undefined;
  const oauth=oauthFactory?.()||new OAuthManager({dataDir:path.join(dataDir,'oauth'),redirectUri:`${base}/auth/callback`,store:persistentStore});
  const providers=providerFactory?.(oauth)||new ProviderRegistry({getAccessToken:()=>oauth.getAccessToken()});
  const sessions=new Map(), listeners=new Set(), activeChats=new Map(), taskTimers=new Map();
  let closed=false;
  let fileToolsStatus={available:false,workspace,reason:'受限文件工具尚未初始化。'};
  const emit=event=>{for(const client of listeners)client.write(`data: ${JSON.stringify(event)}\n\n`);};
  const state=()=>({...store.state,auth:oauth.status(),providers:providers.list(oauth.status()),workspace,fileTools:fileToolsStatus});
  const emitState=()=>emit({type:'state',state:state()});
  const taskEvent=(task,kind,message)=>{const text=String(message);task.events.push({id:randomUUID(),time:new Date().toISOString(),kind,message:text.length>12_000?text.slice(0,12_000)+'\n[界面记录已截断；文件内容未改变]':text});task.events=task.events.slice(-200);};
  const onCodexEvent=event=>{
    const task=store.state.tasks.find(t=>t.id===event.taskId);if(!task)return;
    if(event.type==='state')task.status=({'starting':'running','awaiting-approval':'needs_approval'}[event.status]||event.status);
    if(event.type==='approval'){
      task.status='needs_approval';task.approval={id:event.id,title:'批准这次只读命令？',detail:`${event.command}\n目录：${event.cwd}\n${event.reason||''}`};
      taskEvent(task,'decision',task.approval.detail);
    }else if(event.type==='approval-resolved'){delete task.approval;task.status='running';taskEvent(task,'decision',['allow-once','accept'].includes(event.decision)?'你允许了这一次操作。':'你拒绝了这一次操作。');}
    else if(event.type==='delta') {
      const last=task.events.at(-1);
      if(last?.kind==='output')last.message=(last.message+event.text).slice(-12_000);else taskEvent(task,'output',event.text);
    } else if(event.type==='completed'){task.status=event.status;delete task.approval;taskEvent(task,'status',`任务${event.status==='completed'?'已完成':event.status==='cancelled'?'已取消':'未完成'}。`);}
    else if(['error','blocked','progress'].includes(event.type)){if(event.type==='error')task.status='failed';taskEvent(task,event.type,event.message||event.reason||event.method);}
    store.save();emitState();
  };
  const bridge=bridgeFactory?.(onCodexEvent)||new CodexBridge({dataDir:path.join(dataDir,'codex'),workspace,getAccessToken:()=>oauth.getAccessToken(),onEvent:onCodexEvent});
  const fileTools=fileToolsFactory?.()||new FileTools({workspace,helperPath:path.join(PROJECT_ROOT,'scripts','file-tools.py')});
  const onFileEvent=event=>{
    const task=store.state.tasks.find(t=>t.id===event.taskId);if(!task)return;
    if(event.type==='approval'){
      task.status='needs_approval';
      task.approval={id:event.id,title:event.title,detail:event.detail,operation:event.operation,args:event.args,hash:event.hash,expiresAt:event.expiresAt};
      taskEvent(task,'decision',`${event.title}\n${event.operation||''}`);
      store.audit('tool.proposed',{taskId:task.id,operation:event.operation,name:event.args?.name,hash:event.hash});emitState();return;
    }
    if(event.type==='progress'&&event.kind==='result'){
      taskEvent(task,'result',event.message||JSON.stringify(event.result));
      store.audit('tool.result',{taskId:task.id,operation:event.operation,outcome:event.result?.ok===false?'failed':'completed',
        code:event.result?.error,mayHaveCreatedFile:event.result?.mayHaveCreatedFile===true});emitState();return;
    }
    onCodexEvent(event);
  };
  const fileAgent=fileAgentFactory?.(onFileEvent,fileTools)||new FileAgent({fileTools,getAccessToken:()=>oauth.getAccessToken(),onEvent:onFileEvent});
  const ready=Promise.all([Promise.resolve(oauth.init()),fileTools.init().then(metadata=>{
    fileToolsStatus={available:true,...metadata};
  }).catch(error=>{fileToolsStatus={available:false,workspace,reason:'受限文件工具不可用，请在本项目运行 npm run build:files 检查环境后重启。',code:error.code||'FILE_TOOLS_UNAVAILABLE'};})]);
  const ownedTask=id=>{const task=store.state.tasks.find(x=>x.id===id);if(!task)throw new Error('任务不存在。');return task;};
  const authenticated=req=>{
    const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('whisper_session='))?.slice(16);
    const session=sessions.get(cookie);
    if(!session||session.expires<Date.now())return null;
    session.expires=Date.now()+12*60*60*1000;return session;
  };
  const trusted=req=>{
    const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
    if(!hosts.includes(req.headers.host))return false;
    const origin=req.headers.origin;
    if(origin&&!hosts.map(h=>`http://${h}`).includes(origin))return false;
    if(req.headers['sec-fetch-site']==='cross-site')return false;
    return true;
  };
  const cancelDemo=task=>{clearTimeout(taskTimers.get(task.id));taskTimers.delete(task.id);task.status='cancelled';delete task.approval;taskEvent(task,'status','演示任务已取消，没有执行任何电脑操作。');};
  async function runChat(conversation,text,controller) {
    const selected=selectMentionedMembers(conversation.members,text);
    try {
      for(const m of selected){
        controller.signal.throwIfAborted();
        const history=conversation.messages.filter(x=>x.status==='complete'&&x.content).map(x=>({role:x.role,content:x.content,name:x.name}));
        const message={id:randomUUID(),role:'assistant',memberId:m.id,name:m.name,providerId:m.providerId,model:m.model,content:'',status:'streaming',createdAt:new Date().toISOString()};
        conversation.messages.push(message);store.save();emitState();
        try{
          for await(const delta of providers.stream({...m,history,signal:controller.signal})){
            if(message.content.length+delta.length>200_000)throw new Error('回复超过本地长度限制，已保留收到的内容。');
            message.content+=delta;emit({type:'message.delta',conversationId:conversation.id,messageId:message.id,delta});
          }
          message.status='complete';
        }catch(error){message.status='error';message.error=controller.signal.aborted?'已停止生成。':safeError(error);if(!message.content)message.content=message.error;}
        conversation.updatedAt=new Date().toISOString();store.save();emit({type:'message.updated',conversationId:conversation.id,message});
      }
    }catch(error){if(!controller.signal.aborted)emit({type:'error',message:safeError(error)});}
    finally{activeChats.delete(conversation.id);store.save();emitState();}
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try{
      if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//'))return json(res,400,{error:'请求地址无效。'});
      const url=new URL(req.url,base);
      await ready;
      // OAuth is a cross-site top-level redirect; manager validates single-use state and nonce.
      if(url.pathname==='/auth/callback'&&req.method==='GET'){
        if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return json(res,403,{error:'请求来源无效。'});
        try{await oauth.callback(url);providers.clearChatGPT();store.audit('auth.connected');emit({type:'auth.updated',auth:oauth.status()});emitState();
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>Whisper · 登录完成</title><h1>已连接 ChatGPT</h1><p>可以关闭此页面，返回Whisper刷新模型列表。</p><a href="/">返回Whisper</a></html>');
        }catch(error){res.writeHead(400,{'Content-Type':'text/html; charset=utf-8'});res.end(`<h1>登录未完成</h1><p>${escapeHTML(safeError(error))}</p><a href="/">返回Whisper</a>`);}return;
      }
      if(!trusted(req))return json(res,403,{error:'只允许本机同源访问。'});
      if(url.pathname==='/api/bootstrap'&&req.method==='GET'){
        let session=authenticated(req);
        if(!session){
          for(const [key,value]of sessions)if(value.expires<Date.now())sessions.delete(key);
          if(sessions.size>50)return json(res,429,{error:'本地会话过多，请重启应用。'});
          const id=randomBytes(32).toString('hex');session={csrf:randomBytes(32).toString('hex'),expires:Date.now()+12*60*60*1000};sessions.set(id,session);
          res.setHeader('Set-Cookie',`whisper_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        }
        return json(res,200,{csrf:session.csrf,...state()});
      }
      if(url.pathname.startsWith('/api/')){
        const session=authenticated(req);if(!session)return json(res,401,{error:'请刷新页面建立本地会话。'});
        if(req.method==='GET'&&url.pathname==='/api/events'){
          if(listeners.size>=20)return json(res,429,{error:'实时连接过多。'});
          res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});res.write(': connected\n\n');listeners.add(res);
          const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),20000);heartbeat.unref();req.on('close',()=>{clearInterval(heartbeat);listeners.delete(res);});return;
        }
        if(req.method==='GET'&&url.pathname==='/api/models'){
          const models=await providers.models(url.searchParams.get('providerId'));emitState();return json(res,200,{models});
        }
        if(req.method!=='POST')return json(res,404,{error:'接口不存在。'});
        const csrf=Buffer.from(req.headers['x-csrf-token']||'');const expected=Buffer.from(session.csrf);
        if(csrf.length!==expected.length||!timingSafeEqual(csrf,expected))return json(res,403,{error:'本地安全校验失败，请刷新页面。'});
        const body=await readJSON(req);
        switch(url.pathname){
          case '/api/conversations':{
            if(!['direct','group'].includes(body.mode)||!Array.isArray(body.members)||!body.members.length||body.members.length>6||body.mode==='direct'&&body.members.length!==1)throw new Error('私聊需一位成员；群聊支持一至六位成员。');
            const members=body.members.map(m=>{
              if(!m||typeof m.name!=='string'||!m.name.trim()||m.name.length>30||/[\u0000-\u001f@]/.test(m.name)||!providers.hasModel(m.providerId,m.model))throw new Error('成员名称或模型无效，请刷新模型列表。');
              return {id:randomUUID(),name:m.name.trim(),providerId:m.providerId,model:m.model};
            });
            if(new Set(members.map(m=>m.name)).size!==members.length)throw new Error('群成员名称不能重复。');
            if(store.state.conversations.length>=100)throw new Error('首版最多保存100个会话。');
            const conversation={id:randomUUID(),title:String(body.title||'新对话').trim().slice(0,60)||'新对话',mode:body.mode,members,messages:[],updatedAt:new Date().toISOString()};
            store.state.conversations.unshift(conversation);store.audit('conversation.created',{conversationId:conversation.id});emitState();return json(res,201,{conversation});
          }
          case '/api/messages':{
            const conversation=store.state.conversations.find(x=>x.id===body.conversationId);if(!conversation)throw new Error('会话不存在。');
            if(activeChats.has(conversation.id))throw new Error('这个会话仍在生成回复，请先停止或等待。');
            if(typeof body.text!=='string'||!body.text.trim()||body.text.length>16000)throw new Error('请输入1至16000字的消息。');
            if(conversation.messages.length>=500)throw new Error('当前会话已达首版上下文上限，请建立新会话。');
            const controller=new AbortController();activeChats.set(conversation.id,controller);
            conversation.messages.push({id:randomUUID(),role:'user',name:'我',content:body.text.trim(),status:'complete',createdAt:new Date().toISOString()});
            store.save();emitState();json(res,202,{accepted:true});void runChat(conversation,body.text,controller);return;
          }
          case '/api/chat/cancel':activeChats.get(body.conversationId)?.abort();return json(res,200,{ok:true});
          case '/api/auth/start':{
            const result=await oauth.begin(body);store.audit('auth.started',{persistence:body.persist?'keychain':'memory'});return json(res,200,result);
          }
          case '/api/auth/resume':{
            if(body.consent!==true)throw new Error('请明确确认读取Whisper保存的凭据。');
            await oauth.resume(body);providers.clearChatGPT();emitState();return json(res,200,{auth:oauth.status()});
          }
          case '/api/auth/logout':{
            for(const controller of activeChats.values())controller.abort();await bridge.cancel();
            if(fileAgent.status().mode==='agent')await fileAgent.cancel();
            const auth=await oauth.logout();providers.clearChatGPT();store.audit('auth.disconnected');emit({type:'auth.updated',auth});emitState();return json(res,200,{auth});
          }
          case '/api/providers':{const provider=await providers.addCompatible(body);store.audit('provider.connected',{providerId:provider.id});emitState();return json(res,201,{provider});}
          case '/api/providers/remove':providers.remove(body.id);store.audit('provider.removed');emitState();return json(res,200,{ok:true});
          case '/api/tasks':{
            if(body.consent!==true)throw new Error('请确认本次任务的执行模式与权限。');
            if(!['demo','codex','files','agent'].includes(body.mode)||typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>12000)throw new Error('任务模式或内容无效。');
            if(store.state.tasks.some(t=>ACTIVE_TASKS.has(t.status)))throw new Error('请先完成或取消当前任务。');
            if(['codex','agent'].includes(body.mode)&&(!oauth.status().connected||!oauth.status().planEnabled))throw new Error('请先登录并授权 ChatGPT 计划用量。');
            if(['codex','agent'].includes(body.mode)&&!providers.hasModel('chatgpt',body.model))throw new Error('请先刷新并选择账户可用模型。');
            if(['files','agent'].includes(body.mode)&&!fileToolsStatus.available)throw new Error(fileToolsStatus.reason);
            if(body.mode==='files')fileTools.describe(body.operation,body.args);
            const task={id:randomUUID(),prompt:body.prompt.trim(),mode:body.mode,status:'running',events:[],createdAt:new Date().toISOString()};
            taskEvent(task,'status',body.mode==='demo'?'演示任务开始：未调用真实模型或执行电脑操作。':body.mode==='files'?'本地文件任务：仅专用工作区，每个实际动作等待确认；不调用模型。':body.mode==='agent'?'ChatGPT 文件任务：只提供受限文件工具，每个动作先审批。':'检查本机 Codex 协议与隔离能力。');store.state.tasks.unshift(task);store.state.tasks=store.state.tasks.slice(0,100);
            store.audit('task.started',{taskId:task.id,mode:task.mode});emitState();json(res,202,{task});
            if(task.mode==='demo'){
              const timer=setTimeout(()=>{if(task.status!=='running'||closed)return;task.status='needs_approval';task.approval={id:randomUUID(),title:'继续演示下一步？',detail:'模拟：读取专用工作区并生成摘要。此按钮不会执行命令或访问文件。'};taskEvent(task,'decision','等待你的决定：允许一次或拒绝。');store.save();emitState();},500);timer.unref();taskTimers.set(task.id,timer);
            }else if(['files','agent'].includes(task.mode)){
              try{fileAgent.start({taskId:task.id,mode:task.mode,prompt:task.prompt,model:body.model,operation:body.operation,args:body.args,confirmed:true});}
              catch(error){task.status='failed';taskEvent(task,'error',safeError(error));store.save();emitState();}
            }else void bridge.start({taskId:task.id,prompt:task.prompt,model:body.model,confirmed:true}).catch(error=>{
              if(task.status==='cancelled'||error?.code==='TASK_CANCELLED')return;
              task.status='failed';delete task.approval;taskEvent(task,'error',safeError(error));store.save();emitState();
            });
            return;
          }
          case '/api/tasks/decision':{
            const task=ownedTask(body.taskId);if(task.status!=='needs_approval'||task.approval?.id!==body.approvalId||!['accept','decline'].includes(body.decision))throw new Error('审批已过期或与当前任务不匹配。');
            const approvalMetadata={taskId:task.id,decision:body.decision,hash:task.approval.hash,operation:task.approval.operation,name:task.approval.args?.name};
            if(task.mode==='demo'){
              delete task.approval;
              if(body.decision==='decline'){task.status='cancelled';taskEvent(task,'status','你拒绝了模拟步骤，演示已停止。');}
              else{task.status='completed';taskEvent(task,'status','你允许了一次模拟步骤。');taskEvent(task,'result','演示完成：进度、决策、结果已记录。没有访问电脑文件、执行命令或消耗模型额度。');}
            }else if(['files','agent'].includes(task.mode))fileAgent.decide({approvalId:body.approvalId,decision:body.decision});
            else await bridge.approve({id:body.approvalId,decision:body.decision==='accept'?'allow-once':'deny'});
            store.audit('task.decision',approvalMetadata);emitState();return json(res,200,{task});
          }
          case '/api/tasks/cancel':{
            const task=ownedTask(body.taskId);if(!ACTIVE_TASKS.has(task.status))throw new Error('任务已经结束。');
            if(task.mode==='demo')cancelDemo(task);else {if(['files','agent'].includes(task.mode))await fileAgent.cancel();else await bridge.cancel();task.status='cancelled';delete task.approval;}
            store.audit('task.cancelled',{taskId:task.id});emitState();return json(res,200,{task});
          }
          default:return json(res,404,{error:'接口不存在。'});
        }
      }
      if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'不支持此请求。'});
      const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/ui-state.js':'ui-state.js','/styles.css':'styles.css'};
      const filename=files[url.pathname];if(!filename)return json(res,404,{error:'页面不存在。'});
      const file=path.join(PROJECT_ROOT,'public',filename);const data=await fs.promises.readFile(file);
      res.writeHead(200,{'Content-Type':filename.endsWith('.html')?'text/html; charset=utf-8':filename.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'});res.end(req.method==='HEAD'?undefined:data);
    }catch(error){if(!res.headersSent)json(res,error.status||400,{error:safeError(error)});else res.end();}
  });
  server.requestTimeout=30_000;server.headersTimeout=15_000;
  return {server,ready,store,oauth,providers,bridge,fileAgent,fileTools,state,
    async listen(){await ready;await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return base;},
    async close(){closed=true;for(const controller of activeChats.values())controller.abort();for(const timer of taskTimers.values())clearTimeout(timer);for(const client of listeners)client.end();await bridge.close();await fileAgent.close();await oauth.close();await new Promise(resolve=>server.close(resolve));},
  };
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.WHISPER_PORT||4783);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('WHISPER_PORT 需在1024至65535之间。');
  const app=createApp({port});
  app.listen().then(url=>process.stdout.write(`Whisper 已启动：${url}\n仅本机访问；尚未自动登录或调用真实模型。\n`)).catch(()=>{process.stderr.write('无法启动Whisper，请检查端口是否被占用或数据目录权限。\n');process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
}
