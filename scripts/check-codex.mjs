import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { CodexBridge } from '../server/codex.mjs';

// Capability inspection only. Never creates a thread, fetches a token or runs inference.
const directory=await mkdtemp(path.join(os.tmpdir(),'whisper-capability-'));
let tokenRequested=false;
const bridge=new CodexBridge({dataDir:path.join(directory,'runtime'),workspace:path.join(directory,'workspace'),
  getAccessToken(){tokenRequested=true;throw new Error('This inspection must never request credentials.');}});
const result={checkedAt:new Date().toISOString(),supported:false,tokenRequested:false};
try{
  const context=await bridge.prepare();result.executable=context.command;
  const {stdout}=await promisify(execFile)(context.command,['--version'],{env:context.env,cwd:context.runDir,timeout:15000,maxBuffer:65536});
  result.version=stdout.match(/codex-cli\s+([\w.+-]+)/)?.[1]||'unknown';
  await bridge.checkCapability(context);result.supported=true;
}catch(error){
  result.code=error.code||'INSPECTION_FAILED';
  result.message=error.code==='CODEX_READ_ISOLATION_UNAVAILABLE'?'发布协议缺少本应用要求的目录读取隔离；真实任务继续禁用。':'无法确认 CLI 隔离能力，请检查安装与官方协议。';
}finally{
  await bridge.close();await rm(directory,{recursive:true,force:true});
  result.tokenRequested=tokenRequested;
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(!result.supported)process.exitCode=2;
}
