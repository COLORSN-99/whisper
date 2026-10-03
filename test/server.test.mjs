import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, selectMentionedMembers } from '../server/index.mjs';
import { ProviderRegistry } from '../server/providers.mjs';

test('Mentions do not trigger members whose names are prefixes of another member',()=>{
  const members=[{name:'小明'},{name:'小明同学'},{name:'Review [A]'}];
  assert.deepEqual(selectMentionedMembers(members,'@小明同学 请回应'),[members[1]]);
  assert.deepEqual(selectMentionedMembers(members,'请 @小明，@Review [A] 看看'),[members[0],members[2]]);
  const spaced=[{name:'Claude'},{name:'Claude Sonnet'},{name:'Claude, reviewer'}];
  assert.deepEqual(selectMentionedMembers(spaced,'@Claude Sonnet 请回应'),[spaced[1]]);
  assert.deepEqual(selectMentionedMembers(spaced,'@Claude, reviewer 请回应'),[spaced[2]]);
});

test('Local service gates requests, persists chat and enforces one-use demo decisions',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whisper-server-test-'));
  const port=19483;let oauthStarted=0;
  const oauth={init(){},status(){return{connected:false,planEnabled:false,persistence:'memory'};},begin(){oauthStarted++;return{url:'https://auth.openai.com/test'};},getAccessToken(){throw new Error('real token forbidden');},async callback(){throw new Error('<test callback failure>');},close(){},async logout(){return this.status();}};
  const app=createApp({port,dataDir:dir,oauthFactory:()=>oauth,providerFactory:()=>new ProviderRegistry({demoDelay:0}),bridgeFactory:()=>({cancel(){},close(){},start(){throw new Error('must not start live execution');}})});
  await app.listen();t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${port}`;
  const first=await fetch(url+'/api/bootstrap');assert.equal(first.status,200);
  const cookie=first.headers.get('set-cookie').split(';')[0];const initial=await first.json();const csrf=initial.csrf;
  const headers={'Content-Type':'application/json','Cookie':cookie,'X-CSRF-Token':csrf};
  const post=async(route,body,overrides={})=>fetch(url+route,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify(body)});
  const bootstrap=async()=>fetch(url+'/api/bootstrap',{headers:{Cookie:cookie}}).then(r=>r.json());
  assert.equal((await fetch(url+'/api/events')).status,401);
  assert.equal((await post('/api/auth/start',{consent:true},{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await post('/api/auth/start',{consent:true},{Origin:'https://evil.example'})).status,403);
  assert.equal((await post('/api/auth/start',{consent:true},{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal(oauthStarted,0);
  const hostileHost=await new Promise(resolve=>{const req=http.get(url+'/api/bootstrap',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',()=>resolve(0));});
  assert.equal(hostileHost,403);
  const malformedTarget=await new Promise(resolve=>{const req=http.get(url,{path:'http://['},res=>{res.resume();resolve(res.statusCode);});req.on('error',()=>resolve(0));});
  assert.equal(malformedTarget,400);
  assert.equal((await fetch(url+'/.data/conversations.json')).status,404);
  const callback=await fetch(url+'/auth/callback?state=test');assert.match(await callback.text(),/&lt;test callback failure&gt;/);
  const c=initial.conversations[0];
  assert.equal((await post('/api/messages',{conversationId:c.id,text:'离线测试'})).status,202);
  let snapshot;
  for(let i=0;i<100;i++){await delay(20);snapshot=await bootstrap();if(snapshot.conversations[0].messages.at(-1)?.status==='complete'&&snapshot.conversations[0].messages.length===2)break;}
  assert.match(snapshot.conversations[0].messages[1].content,/测试适配器/);
  assert.equal(snapshot.conversations[0].messages[1].status,'complete');
  const denied=await post('/api/tasks',{mode:'codex',prompt:'test',consent:true,model:'whatever'});assert.equal(denied.status,400);
  const taskResponse=await post('/api/tasks',{mode:'demo',prompt:'演示任务',consent:true});assert.equal(taskResponse.status,202);const {task}=await taskResponse.json();
  await delay(550);snapshot=await bootstrap();const pending=snapshot.tasks.find(x=>x.id===task.id);assert.equal(pending.status,'needs_approval');
  assert.equal((await post('/api/tasks/decision',{taskId:task.id,approvalId:'wrong',decision:'accept'})).status,400);
  const decision={taskId:task.id,approvalId:pending.approval.id,decision:'accept'};
  assert.equal((await post('/api/tasks/decision',decision)).status,200);
  assert.equal((await post('/api/tasks/decision',decision)).status,400);
  const persisted=JSON.parse(await fs.readFile(path.join(dir,'conversations.json'),'utf8'));
  assert.equal(persisted.tasks[0].status,'completed');assert.equal(persisted.conversations[0].messages[0].content,'离线测试');
  assert.equal(JSON.stringify(persisted).includes(csrf),false);
  const group=initial.conversations[1];
  const unicodeBody=Buffer.from(JSON.stringify({conversationId:group.id,text:'@向导 你好'}));
  const split=unicodeBody.indexOf(Buffer.from('你'))+1;
  const splitResponse=await new Promise(resolve=>{
    const req=http.request(url+'/api/messages',{method:'POST',headers},res=>{res.resume();resolve(res.statusCode);});
    req.write(unicodeBody.subarray(0,split));setTimeout(()=>req.end(unicodeBody.subarray(split)),15);
  });
  assert.equal(splitResponse,202);
  assert.equal((await bootstrap()).conversations[1].messages[0].content,'@向导 你好');
});

test('A late cancelled Codex start cannot overwrite cancellation with failure',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whisper-cancel-test-'));
  let rejectStart;
  const oauth={init(){},status(){return{connected:true,planEnabled:true};},close(){}};
  const registry=new ProviderRegistry();registry.chatgptModels=[{id:'fake',name:'Fake'}];
  const app=createApp({port:19484,dataDir:dir,oauthFactory:()=>oauth,providerFactory:()=>registry,
    bridgeFactory:()=>({start(){return new Promise((_,reject)=>{rejectStart=reject;});},cancel(){},close(){}})});
  await app.listen();t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:19484';const response=await fetch(base+'/api/bootstrap');const cookie=response.headers.get('set-cookie').split(';')[0];const {csrf}=await response.json();
  const post=(route,body)=>fetch(base+route,{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const {task}=await (await post('/api/tasks',{prompt:'Fake',mode:'codex',model:'fake',consent:true})).json();
  await post('/api/tasks/cancel',{taskId:task.id});
  rejectStart(Object.assign(new Error('cancelled'),{code:'TASK_CANCELLED'}));await delay(5);
  assert.equal(app.store.state.tasks[0].status,'cancelled');
});
