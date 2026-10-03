import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/index.mjs';
import { FileTools } from '../server/file-tools.mjs';

test('Real local files require one-use approval; create/read/list work without model credentials',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'whisper-file-http-'));
  const helper=fileURLToPath(new URL('../scripts/file-tools.py',import.meta.url));
  let tokenRequests=0;
  const dataDir=path.join(root,'data'),workspace=path.join(dataDir,'task-workspace');
  const oauth={init(){},status(){return{connected:false,planEnabled:false};},close(){},getAccessToken(){tokenRequests++;throw new Error('Must never request credentials');}};
  const app=createApp({port:19485,dataDir,oauthFactory:()=>oauth,fileToolsFactory:()=>new FileTools({workspace,helperPath:helper}),
    bridgeFactory:()=>({cancel(){},close(){}})});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const base=await app.listen();const response=await fetch(base+'/api/bootstrap');const cookie=response.headers.get('set-cookie').split(';')[0];
  const first=await response.json();assert.equal(first.fileTools.available,true);
  const headers={Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':first.csrf};
  const post=async(route,body,override={})=>fetch(base+route,{method:'POST',headers:{...headers,...override},body:JSON.stringify(body)});
  const current=async id=>(await fetch(base+'/api/bootstrap',{headers:{Cookie:cookie}}).then(r=>r.json())).tasks.find(t=>t.id===id);
  const waitFor=async(id,status)=>{for(let i=0;i<100;i++){const task=await current(id);if(task.status===status)return task;if(task.status==='failed')assert.fail(JSON.stringify(task.events));await delay(20);}assert.fail(`Task never became ${status}`);};
  const create=async(operation,args)=>{
    const r=await post('/api/tasks',{mode:'files',operation,args,prompt:'真实文件离线验收',consent:true});assert.equal(r.status,202);
    const {task}=await r.json();return waitFor(task.id,'needs_approval');
  };
  const task=await create('create_file',{name:'验收笔记.md',content:'# 实际文件\n你好，Whisper。'});
  assert.ok(task.approval.hash);assert.match(task.approval.detail,/你好/);
  await assert.rejects(access(path.join(workspace,'验收笔记.md')));
  const decision={taskId:task.id,approvalId:task.approval.id,decision:'accept'};
  assert.equal((await post('/api/tasks/decision',decision,{'X-CSRF-Token':'bad'})).status,403);
  await assert.rejects(access(path.join(workspace,'验收笔记.md')));
  assert.equal((await post('/api/tasks/decision',decision)).status,200);
  assert.equal((await post('/api/tasks/decision',decision)).status,400);
  await waitFor(task.id,'completed');
  assert.equal(await readFile(path.join(workspace,'验收笔记.md'),'utf8'),'# 实际文件\n你好，Whisper。');
  for(const operation of ['list_files','read_file']){
    const next=await create(operation,operation==='read_file'?{name:'验收笔记.md'}:{});
    await post('/api/tasks/decision',{taskId:next.id,approvalId:next.approval.id,decision:'accept'});
    const result=await waitFor(next.id,'completed');assert.match(JSON.stringify(result.events),/验收笔记/);
  }
  const denied=await create('create_file',{name:'拒绝.txt',content:'不能落盘'});
  await post('/api/tasks/decision',{taskId:denied.id,approvalId:denied.approval.id,decision:'decline'});
  await delay(30);await assert.rejects(access(path.join(workspace,'拒绝.txt')));
  const bad=await post('/api/tasks',{mode:'files',operation:'create_file',args:{name:'../outside.txt',content:'no'},prompt:'bad',consent:true});
  assert.equal(bad.status,400);await assert.rejects(access(path.join(dataDir,'outside.txt')));
  const duplicate=await create('create_file',{name:'验收笔记.md',content:'不允许覆盖'});
  await post('/api/tasks/decision',{taskId:duplicate.id,approvalId:duplicate.approval.id,decision:'accept'});
  for(let i=0;i<100;i++){if((await current(duplicate.id)).status==='failed')break;await delay(20);}
  assert.equal((await current(duplicate.id)).status,'failed');
  assert.equal(await readFile(path.join(workspace,'验收笔记.md'),'utf8'),'# 实际文件\n你好，Whisper。');
  const escapedContent='\n'.repeat(128*1024);
  const escaped=await create('create_file',{name:'JSON转义边界.txt',content:escapedContent});
  await post('/api/tasks/decision',{taskId:escaped.id,approvalId:escaped.approval.id,decision:'accept'});
  await waitFor(escaped.id,'completed');
  assert.equal(await readFile(path.join(workspace,'JSON转义边界.txt'),'utf8'),escapedContent);
  assert.equal(tokenRequests,0);
});
