import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const member = (name, model) => ({id:randomUUID(),name,providerId:'demo',model});
export class StateStore {
  constructor(dataDir) {
    this.dataDir=dataDir; this.path=path.join(dataDir,'conversations.json');
    fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
    if (fs.existsSync(this.path)) {
      if (fs.lstatSync(this.path).isSymbolicLink()) throw new Error('数据文件不能为符号链接。');
      this.state=JSON.parse(fs.readFileSync(this.path,'utf8'));
      if (!Array.isArray(this.state.conversations) || !Array.isArray(this.state.tasks) || !Array.isArray(this.state.audit)) throw new Error('本地数据格式错误，请先备份并检查。');
      for (const c of this.state.conversations) for (const m of c.messages) if (m.status === 'streaming') m.status='error';
      for (const task of this.state.tasks) if (['running','needs_approval','queued'].includes(task.status)) {task.status='cancelled';delete task.approval;}
    } else {
      this.state={version:1,conversations:[
        {id:randomUUID(),title:'我的助手',mode:'direct',members:[member('向导','demo-guide')],messages:[],updatedAt:new Date().toISOString()},
        {id:randomUUID(),title:'灵感小组',mode:'group',members:[member('向导','demo-guide'),member('构建者','demo-builder'),member('审阅者','demo-reviewer')],messages:[],updatedAt:new Date().toISOString()},
      ],tasks:[],audit:[]};
    }
    this.save();
  }
  save() {
    const temp=this.path+'.tmp';
    const fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,0o600);
    try {fs.writeFileSync(fd,JSON.stringify(this.state,null,2));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.renameSync(temp,this.path);
  }
  audit(action, detail={}) {
    this.state.audit.push({id:randomUUID(),time:new Date().toISOString(),action,...detail});
    this.state.audit=this.state.audit.slice(-300); this.save();
  }
}
