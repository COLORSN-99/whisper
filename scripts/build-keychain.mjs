import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='darwin')throw new Error('Keychain helper仅支持macOS；其他平台使用默认内存凭据。');
const runtime=path.join(root,'.runtime');
await mkdir(runtime,{recursive:true,mode:0o700});
// Compile only. This script never executes the helper or reads/writes a Keychain item.
const child=spawn('/usr/bin/swiftc',['-module-cache-path',path.join(runtime,'swift-module-cache-whisper'),
  '-o',path.join(runtime,'whisper-keychain'),path.join(root,'scripts','keychain.swift')],{stdio:'inherit',shell:false});
child.on('error',()=>{process.stderr.write('Swift编译器不可用，请安装Apple Command Line Tools或使用内存模式。\n');process.exitCode=1;});
child.on('exit',code=>{if(code===0)process.stdout.write('已编译Keychain helper，未读取或保存任何凭据。重启应用后可在明确同意下使用。\n');else process.exitCode=code||1;});
