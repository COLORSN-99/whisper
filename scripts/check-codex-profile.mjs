import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexExecutable } from '../server/codex.mjs';

const exec = promisify(execFile);
export const CODEX_CLI = 'codex';

// Deliberately do not inherit the parent environment or inspect existing credentials.
export function isolatedEnvironment(base) {
  return {
    HOME: path.join(base, 'home'), CODEX_HOME: path.join(base, 'codex'),
    TMPDIR: path.join(base, 'tmp'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
  };
}

export function permissionProfile(inside, { platformDefaults = false } = {}) {
  const runtime = platformDefaults
    ? '":minimal" = "read"\n"/System/Library/Perl" = "read"'
    : '"/usr/bin" = "read"\n"/usr/lib" = "read"\n"/System/Library" = "read"\n"/dev/fd" = "write"\n"/dev/null" = "write"';
  return `default_permissions = "fixture"\n\n[permissions.fixture.filesystem]\n":root" = "deny"\n":tmpdir" = "deny"\n":slash_tmp" = "deny"\n${runtime}\n${JSON.stringify(inside)} = "write"\n\n[permissions.fixture.network]\nenabled = false\n`;
}

// A single process probes only disposable fixture paths and local TCP.
// This is not a sandbox-exec policy: Codex produces and applies its official policy.
export const probeSource = String.raw`
use strict;
use warnings;
use Fcntl qw(O_RDONLY O_WRONLY O_CREAT O_EXCL);
use Socket qw(AF_INET SOCK_STREAM sockaddr_in inet_aton);
my $first = 1;
sub result {
  my ($name,$ok,$error)=@_;
  print ($first ? '' : ',');
  print '"'.$name.'":{"allowed":'.($ok?'true':'false').',"errno":'.$error.'}';
  $first=0;
}
sub read_probe {
  my ($name,$root,$leaf)=@_;
  $!=0; my $opened=sysopen(my $file,"$root/$leaf",O_RDONLY); my $error=0+$!;
  if($opened) { $!=0; my $count=sysread($file,my $contents,32); $error=0+$!; close($file); result($name,defined($count)&&$count>0,$error); }
  else { result($name,0,$error); }
}
sub write_probe {
  my ($name,$root,$leaf)=@_;
  $!=0; my $opened=sysopen(my $file,"$root/$leaf",O_WRONLY|O_CREAT|O_EXCL,0600); my $error=0+$!;
  if($opened) { $!=0; my $count=syswrite($file,"fixture only\n"); $error=0+$!; close($file); result($name,defined($count)&&$count==13,$error); }
  else { result($name,0,$error); }
}
my ($inside,$outside,$port)=@ARGV;
die "Expected three fixture arguments" unless @ARGV == 3;
print '{';
read_probe('insideRead',$inside,'sentinel.txt');
write_probe('insideCreate',$inside,'created.txt');
read_probe('outsideRead',$outside,'sentinel.txt');
write_probe('outsideCreate',$outside,'created.txt');
symlink("$outside/sentinel.txt","$inside/outside-link.txt");
symlink($outside,"$inside/outside-directory");
read_probe('symlinkRead',$inside,'outside-link.txt');
write_probe('symlinkCreate',$inside,'outside-directory/symlink-created.txt');
$!=0; my $linked=link("$outside/sentinel.txt","$inside/new-hardlink.txt"); my $link_error=0+$!;
result('createOutsideHardlink',$linked,$link_error);
read_probe('createdHardlinkRead',$inside,'new-hardlink.txt') if $linked;
$!=0;my $created=socket(my $socket,AF_INET,SOCK_STREAM,0);my $socket_error=0+$!;
if(!$created) { result('loopbackNetwork',0,$socket_error); }
else { $!=0;my $connected=connect($socket,sockaddr_in($port,inet_aton('127.0.0.1')));my $error=0+$!;close($socket);result('loopbackNetwork',$connected,$error); }
print "}\n";
`;

export function assessProbe(probe) {
  const allowed = ['insideRead', 'insideCreate'];
  const denied = ['outsideRead', 'outsideCreate', 'symlinkRead', 'symlinkCreate', 'createOutsideHardlink', 'loopbackNetwork'];
  const positiveControls = allowed.every(name => probe[name]?.allowed === true);
  // EPERM / EACCES is evidence of denial. Missing files or a closed port are not.
  const restrictedBoundary = positiveControls && denied.every(name =>
    probe[name]?.allowed === false && [1, 13].includes(probe[name]?.errno));
  return { positiveControls, restrictedBoundary };
}

export async function runProfileCheck({ platformDefaults = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('This bounded fixture requires macOS.');
  const cli = await resolveCodexExecutable(CODEX_CLI);
  const executable = cli.endsWith('.js') ? process.execPath : cli;
  const prefix = cli.endsWith('.js') ? [cli] : [];
  const base = await realpath(await mkdtemp('/tmp/whisper-profile-'));
  const env = isolatedEnvironment(base);
  const inside = path.join(base, 'inside');
  const outside = path.join(base, 'outside');
  const listener = net.createServer(socket => socket.end());
  const report = { checkedAt: new Date().toISOString(), cli,
    platform: process.platform, fixture: 'temporary files plus loopback TCP; no authentication or inference',
    configuration: { minimalRead: platformDefaults,
      runtimeRead: platformDefaults ? ['/System/Library/Perl'] : ['/usr/bin','/usr/lib','/System/Library'],
      runtimeWrite: platformDefaults ? [] : ['/dev/fd','/dev/null'], insideWrite: true,
      explicitDeny: [':root',':tmpdir',':slash_tmp'], networkEnabled: false, profile: 'fixture' } };
  try {
    for (const directory of [inside, outside, env.HOME, env.CODEX_HOME, env.TMPDIR]) await mkdir(directory);
    await writeFile(path.join(env.CODEX_HOME, 'config.toml'), permissionProfile(inside,{platformDefaults}), { mode: 0o600 });
    for (const directory of [inside, outside]) await writeFile(path.join(directory, 'sentinel.txt'), 'public fixture sentinel\n');
    await new Promise((resolve,reject) => {listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
    const port = String(listener.address().port);
    const command = ['/usr/bin/perl', '-e', probeSource, '--', inside, outside, port];
    const options = { env, cwd:inside,timeout:20000,maxBuffer:131072 };
    report.version = (await exec(executable,[...prefix,'--version'],options)).stdout.trim();
    report.control = JSON.parse((await exec(command[0],command.slice(1),options)).stdout);
    report.controlValid = Object.values(report.control).every(value => value.allowed === true);
    for (const filename of ['created.txt','new-hardlink.txt','outside-link.txt','outside-directory']) await rm(path.join(inside,filename),{force:true});
    for (const filename of ['created.txt','symlink-created.txt']) await rm(path.join(outside,filename),{force:true});
    report.bootstrap = [];
    for (const entry of [['/usr/bin/true'],['/usr/bin/perl','-e','print "runtime started\\n"']]) {
      try {
        const r = await exec(executable,[...prefix,'sandbox','-P','fixture','-C',inside,'--',...entry],options);
        report.bootstrap.push({command:entry[0],code:0,stdout:r.stdout,stderr:r.stderr});
      } catch(error) {
        report.bootstrap.push({command:entry[0],code:error.code,signal:error.signal,stdout:error.stdout,stderr:error.stderr});
      }
    }
    try {
      const result = await exec(executable,[...prefix,'sandbox','-P','fixture','-C',inside,'--',...command],options);
      report.probe = JSON.parse(result.stdout);
      report.assessment = assessProbe(report.probe);
      if(result.stderr.trim()) report.diagnostic = result.stderr.trim();
    } catch(error) {
      report.failure = { code: error.code, stderr: String(error.stderr || '').trim(), stdout: String(error.stdout || '').trim() };
    }
    report.fixtureBoundaryPassed = report.controlValid && report.assessment?.restrictedBoundary === true;
    report.existingOutsideSentinelUnchanged = (await readFile(path.join(outside,'sentinel.txt'),'utf8')) === 'public fixture sentinel\n';
    return report;
  } finally {
    if(listener.listening) await new Promise(resolve => listener.close(resolve));
    await rm(base,{recursive:true,force:true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.slice(2).some(arg=>arg!=='--platform-defaults'))throw new Error('Only --platform-defaults is supported.');
    const report = await runProfileCheck({platformDefaults:process.argv.includes('--platform-defaults')});
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
    if(!report.fixtureBoundaryPassed)process.exitCode=2;
  } catch(error) {
    process.stdout.write(JSON.stringify({failure:{code:error.code || 'FIXTURE_FAILED',signal:error.signal,message:error.message,stdout:error.stdout,stderr:error.stderr}},null,2)+'\n');
    process.exitCode=2;
  }
}
