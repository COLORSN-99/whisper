import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='darwin')throw new Error('此受限文件执行器目前只支持macOS。');
// Compatibility command: validate the fixed isolated system interpreter and
// source without executing a file action or producing a local binary.
const source=path.join(root,'scripts','file-tools.py');
const program='import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read()); assert sys.version_info >= (3,9); print("受限文件工具环境与语法检查通过；没有执行文件操作、读取凭据或更改系统权限。")';
const child=spawn('/usr/bin/python3',['-I','-S','-c',program,source],{
  cwd:'/',env:{LANG:'en_US.UTF-8'},stdio:'inherit',shell:false,
});
child.on('error',()=>{process.stderr.write('系统Python不可用，未安装任何新软件。\n');process.exitCode=1;});
child.on('close',(code,signal)=>{if(code!==0||signal)process.exitCode=code||1;});
