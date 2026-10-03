import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FileTools, FILE_TOOL_MAX_BYTES } from '../server/file-tools.mjs';

const exec = promisify(execFile);
let buildDirectory, helperPath;
before(async () => {
  assert.equal(process.platform, 'darwin', 'file-tools helper intentionally targets macOS');
  buildDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'whisper-file-helper-')));
  helperPath = fileURLToPath(new URL('../scripts/file-tools.py', import.meta.url));
  await exec('/usr/bin/python3', ['-I', '-S', '-c', 'import os, sys; assert sys.flags.isolated and sys.flags.no_site; assert os.open in os.supports_dir_fd'], {
    env: { LANG: 'en_US.UTF-8' }, timeout: 10_000,
  });
});
after(async () => { if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true }); });

async function setup(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'whisper-file-tools-test-')));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace, { mode: 0o700 });
  const tools = new FileTools({ workspace, helperPath });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, tools };
}

function rawRequest(request, argv = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-S', helperPath, ...argv], { env: { LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; child.stdout.on('data', (chunk) => chunks.push(chunk)); child.stderr.resume(); child.once('error', reject);
    child.once('close', (exitCode) => {
      try { resolve({ exitCode, ...JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); }
    });
    child.stdin.end(typeof request === 'string' ? request : JSON.stringify(request));
  });
}

test('initialization binds stable directory identity and exposes immutable tool catalog', async (t) => {
  const { tools, workspace } = await setup(t);
  const metadata = await tools.init();
  assert.equal(metadata.workspace, workspace); assert.match(metadata.rootIdentity.ino, /^\d+$/);
  assert.equal(metadata.maxBytes, 131072); assert.equal(metadata.operatingSystemSandbox, false);
  assert.deepEqual(tools.catalog.map(({ name }) => name), ['list_files', 'read_file', 'create_file']);
  assert.equal(Object.isFrozen(tools.catalog), true);
  assert.equal(Object.isFrozen(tools.catalog[2].parameters.properties), true);
  assert.deepEqual(await tools.init(), metadata);
});

test('describe is pure, validates exact arguments, freezes approval content and supports Chinese', async (t) => {
  const { tools, workspace } = await setup(t);
  const args = { name: '任务笔记.md', content: '你好，世界。\n' };
  const review = tools.describe('create_file', args); args.content = 'mutated';
  assert.equal(review.args.content, '你好，世界。\n'); assert.equal(review.access, 'write');
  assert.equal(Object.isFrozen(review.args), true); assert.equal(typeof review.title, 'string');
  assert.equal(typeof review.detail, 'string'); assert.deepEqual(await readdir(workspace), []);
  await assert.rejects(tools.execute('list_files', {}), { code: 'FILE_TOOLS_NOT_READY' });
  assert.throws(() => tools.describe('read_file', { name: 'ok.txt', workspace: '/tmp' }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => tools.describe('shell', { command: 'pwd' }), { code: 'INVALID_OPERATION' });
  assert.throws(() => tools.describe('read_file', Object.create({ name: 'ok.txt' })), { code: 'INVALID_ARGUMENTS' });
});

test('approved-shaped operations create/read/list UTF-8 files without exposing helper outside workspace', async (t) => {
  const { tools, workspace } = await setup(t); await tools.init();
  const content = '标题\n中文与 café\n';
  const created = await tools.execute('create_file', { name: '任务笔记.md', content });
  assert.deepEqual(created, { name: '任务笔记.md', sizeBytes: Buffer.byteLength(content), created: true });
  assert.deepEqual(await tools.execute('read_file', { name: '任务笔记.md' }), { name: '任务笔记.md', sizeBytes: Buffer.byteLength(content), content });
  assert.deepEqual((await tools.execute('list_files', {})).files, [{ name: '任务笔记.md', sizeBytes: Buffer.byteLength(content) }]);
  assert.deepEqual(await readdir(workspace), ['任务笔记.md']);
});

test('never overwrites or deletes an existing target', async (t) => {
  const { tools, workspace } = await setup(t); await tools.init();
  await writeFile(path.join(workspace, 'keep.txt'), 'original');
  await assert.rejects(tools.execute('create_file', { name: 'keep.txt', content: 'replacement' }), { code: 'FILE_EXISTS', mayHaveCreatedFile: false });
  assert.equal(await readFile(path.join(workspace, 'keep.txt'), 'utf8'), 'original');
  assert.deepEqual(await readdir(workspace), ['keep.txt']);
  await assert.rejects(tools.execute('delete_file', { name: 'keep.txt' }), { code: 'INVALID_OPERATION' });
});

test('concurrent creation is exclusive and publishes one complete approved payload', async (t) => {
  const { tools, workspace } = await setup(t); await tools.init();
  const contents = ['甲'.repeat(40_000), '乙'.repeat(40_000)];
  const results = await Promise.allSettled(contents.map((content) => tools.execute('create_file', { name: 'race.txt', content })));
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.find(({ status }) => status === 'rejected').reason.code, 'FILE_EXISTS');
  const final = await readFile(path.join(workspace, 'race.txt'), 'utf8');
  assert.ok(contents.includes(final)); assert.deepEqual(await readdir(workspace), ['race.txt']);
});

test('rejects traversal, absolute, nested, hidden, extension and malformed Unicode names in both layers', async (t) => {
  const { tools, workspace } = await setup(t); const metadata = await tools.init();
  const names = ['/tmp/outside.txt', '../outside.txt', 'nested/file.txt', 'nested\\file.txt', '.secret.txt', 'a..txt', 'ok.exe', 'ok.TXT', ' before.txt', 'after.txt ', 'line\n.txt', 'zero\0.txt', 'x'.repeat(181) + '.txt'];
  for (const name of names) {
    assert.throws(() => tools.describe('read_file', { name }), { code: 'INVALID_FILENAME' }, name);
    const result = await rawRequest({ operation: 'read_file', workspace, expectedRoot: metadata.rootIdentity, args: { name } });
    assert.equal(result.ok, false, name); assert.equal(result.error.code, 'INVALID_FILENAME', name);
  }
  assert.throws(() => tools.describe('create_file', { name: 'a.txt', content: '\uD800' }), { code: 'INVALID_UTF8' });
});

test('enforces UTF-8 byte limit rather than character count and supports exact-limit content', async (t) => {
  const { tools, workspace } = await setup(t); const metadata = await tools.init();
  assert.throws(() => tools.describe('create_file', { name: 'big.txt', content: '界'.repeat(50_000) }), { code: 'FILE_TOO_LARGE' });
  const content = 'a'.repeat(FILE_TOOL_MAX_BYTES);
  await tools.execute('create_file', { name: 'limit.txt', content });
  assert.equal((await tools.execute('read_file', { name: 'limit.txt' })).content, content);
  const direct = await rawRequest({ operation: 'create_file', workspace, expectedRoot: metadata.rootIdentity, args: { name: 'bypass.txt', content: content + 'x' } });
  assert.equal(direct.error.code, 'FILE_TOO_LARGE');
  await writeFile(path.join(workspace, 'oversize.txt'), content + 'x');
  await assert.rejects(tools.execute('read_file', { name: 'oversize.txt' }), { code: 'FILE_TOO_LARGE' });
});

test('rejects non-UTF8 and preserves empty valid UTF-8 text', async (t) => {
  const { tools, workspace } = await setup(t); await tools.init();
  await writeFile(path.join(workspace, 'binary.txt'), Buffer.from([0xC3, 0x28]));
  await assert.rejects(tools.execute('read_file', { name: 'binary.txt' }), { code: 'INVALID_UTF8' });
  await tools.execute('create_file', { name: 'empty.json', content: '' });
  assert.equal((await tools.execute('read_file', { name: 'empty.json' })).content, '');
});

test('refuses symlinks, hardlinks, directories and FIFOs without following or reading them', async (t) => {
  const { tools, workspace, root } = await setup(t); await tools.init();
  const external = path.join(root, 'external.txt'); await writeFile(external, 'outside-test-sentinel');
  await symlink(external, path.join(workspace, 'symbolic.txt'));
  await link(external, path.join(workspace, 'hard.txt'));
  await mkdir(path.join(workspace, 'directory.txt'));
  await exec('/usr/bin/mkfifo', [path.join(workspace, 'pipe.txt')]);
  for (const name of ['symbolic.txt', 'hard.txt', 'directory.txt', 'pipe.txt']) {
    await assert.rejects(tools.execute('read_file', { name }), { code: 'UNSAFE_FILE' }, name);
  }
  await assert.rejects(tools.execute('create_file', { name: 'symbolic.txt', content: 'bad' }), { code: 'FILE_EXISTS' });
  assert.equal(await readFile(external, 'utf8'), 'outside-test-sentinel');
  const listing = await tools.execute('list_files', {});
  assert.deepEqual(listing.files, []); assert.equal(listing.skippedCount, 4);
});

test('lists only eligible top-level names and file sizes', async (t) => {
  const { tools, workspace } = await setup(t); await tools.init();
  await writeFile(path.join(workspace, 'z.csv'), 'a,b'); await writeFile(path.join(workspace, 'a.md'), '# title');
  await writeFile(path.join(workspace, '.hidden.txt'), 'hidden'); await writeFile(path.join(workspace, 'script.js'), 'ignore');
  await mkdir(path.join(workspace, 'nested'));
  const listing = await tools.execute('list_files', {});
  assert.deepEqual(listing.files, [{ name: 'a.md', sizeBytes: 7 }, { name: 'z.csv', sizeBytes: 3 }]);
  assert.equal(listing.skippedCount, 3);
});

test('directory replacement cannot redirect operations into a different root inode', async (t) => {
  const { tools, workspace, root } = await setup(t); await tools.init();
  await rename(workspace, path.join(root, 'original-workspace')); await mkdir(workspace);
  await writeFile(path.join(workspace, 'new.txt'), 'new-root-content');
  for (const [operation, args] of [['list_files', {}], ['read_file', { name: 'new.txt' }], ['create_file', { name: 'escape.txt', content: 'no' }]]) {
    await assert.rejects(tools.execute(operation, args), { code: 'WORKSPACE_CHANGED' });
  }
  assert.deepEqual(await readdir(workspace), ['new.txt']);
  assert.deepEqual(await readdir(path.join(root, 'original-workspace')), []);
});

test('root symlinks including trailing-slash spelling are rejected, both before and after init', async (t) => {
  const { root, workspace } = await setup(t);
  const alias = path.join(root, 'alias'); await symlink(workspace, alias);
  await assert.rejects(new FileTools({ workspace: alias + '/', helperPath }).init(), { code: 'UNSAFE_WORKSPACE' });
  const direct = await rawRequest({ operation: 'inspect', workspace: alias + '/', args: {} });
  assert.equal(direct.error.code, 'INVALID_REQUEST');
  const tools = new FileTools({ workspace, helperPath }); await tools.init();
  await rename(workspace, path.join(root, 'previous')); await symlink(path.join(root, 'previous'), workspace);
  await assert.rejects(tools.execute('list_files', {}), { code: 'UNSAFE_WORKSPACE' });
});

test('helper requires stdin JSON, expected identity, exact keys and supported operations', async (t) => {
  const { workspace } = await setup(t);
  const request = { operation: 'inspect', workspace, args: {} };
  assert.equal((await rawRequest(request, ['read_file'])).error.code, 'INVALID_REQUEST');
  assert.equal((await rawRequest('not-json')).error.code, 'INVALID_REQUEST');
  assert.equal((await rawRequest({ ...request, arbitraryCommand: 'pwd' })).error.code, 'INVALID_ARGUMENTS');
  assert.equal((await rawRequest({ ...request, operation: 'list_files' })).error.code, 'WORKSPACE_CHANGED');
  assert.equal((await rawRequest({ ...request, operation: 'list_files', expectedRoot: { dev: '1', ino: '2' } })).error.code, 'WORKSPACE_CHANGED');
  assert.equal((await rawRequest({ ...request, operation: 'shell' })).error.code, 'INVALID_REQUEST');
});

test('already cancelled actions never start a write', async (t) => {
  const { tools, workspace } = await setup(t); await tools.init();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tools.execute('create_file', { name: 'cancelled.txt', content: 'no' }, { signal: controller.signal }), { code: 'FILE_TOOL_ABORTED', mayHaveCreatedFile: false });
  assert.deepEqual(await readdir(workspace), []);
});

test('timeout and cancellation terminate a stuck helper with honest uncertain-write status', async (t) => {
  const { tools, root } = await setup(t); await tools.init();
  const stub = path.join(root, 'stuck-helper.py');
  await writeFile(stub, 'import time\ntime.sleep(100)\n');
  tools.helperPath = stub; tools.timeoutMs = 60;
  await assert.rejects(tools.execute('read_file', { name: 'pending.txt' }), { code: 'FILE_TOOL_TIMEOUT', mayHaveCreatedFile: false });
  tools.timeoutMs = 1000;
  const controller = new AbortController();
  const creating = tools.execute('create_file', { name: 'pending.txt', content: 'not-run' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(creating, { code: 'FILE_TOOL_ABORTED', mayHaveCreatedFile: true });
});

test('an unexpected helper signal is distinguished from invalid JSON without retrying', async (t) => {
  const { tools, root } = await setup(t); await tools.init();
  const stub = path.join(root, 'terminated-helper.py');
  await writeFile(stub, 'import os, signal\nos.kill(os.getpid(), signal.SIGKILL)\n');
  tools.helperPath = stub;
  await assert.rejects(tools.execute('read_file', { name: 'pending.txt' }), { code: 'FILE_HELPER_TERMINATED', signal: 'SIGKILL', mayHaveCreatedFile: false });
});

test('runs only the fixed system Python with isolation and site loading disabled', async (t) => {
  const { tools, root } = await setup(t); await tools.init();
  const stub = path.join(root, 'inspect-python-flags.py');
  await writeFile(stub, 'import json, os, sys\nprint(json.dumps({"ok":True,"result":{"isolated":sys.flags.isolated,"noSite":sys.flags.no_site,"argvCount":len(sys.argv),"pythonPathPresent":"PYTHONPATH" in os.environ}}))\n');
  tools.helperPath = stub;
  const result = await tools.execute('list_files', {});
  assert.deepEqual(result, { isolated: 1, noSite: 1, argvCount: 1, pythonPathPresent: false });
});

test('Python entry independently rejects escaped surrogate Unicode from raw JSON', async (t) => {
  const { tools, workspace } = await setup(t); const metadata = await tools.init();
  const badContent = await rawRequest({ operation: 'create_file', workspace, expectedRoot: metadata.rootIdentity, args: { name: 'bad.txt', content: '\uD800' } });
  assert.equal(badContent.error.code, 'INVALID_UTF8');
  const badName = await rawRequest({ operation: 'read_file', workspace, expectedRoot: metadata.rootIdentity, args: { name: '\uD800.txt' } });
  assert.equal(badName.error.code, 'INVALID_FILENAME');
});

test('create failures after invocation conservatively report possibly committed results', async (t) => {
  const { tools, root } = await setup(t); await tools.init();
  const stub = path.join(root, 'uncertain-result.py'); tools.helperPath = stub;
  for (const code of ['FILE_NOT_FOUND', 'FILE_TOO_LARGE']) {
    await writeFile(stub, `import json, sys\nprint(json.dumps({"ok":False,"error":{"code":"${code}","message":"文件在发布后发生变化。"}})); sys.exit(1)\n`);
    await assert.rejects(tools.execute('create_file', { name: 'pending.txt', content: 'draft' }), { code, mayHaveCreatedFile: true });
  }
  await writeFile(stub, 'import os\nos._exit(0)\n');
  await assert.rejects(tools.execute('create_file', { name: 'pending.txt', content: 'draft' }), { code: 'INVALID_HELPER_RESPONSE', mayHaveCreatedFile: true });
  for (const output of ['null', '[]', 'true']) {
    await writeFile(stub, `print('${output}')\n`);
    await assert.rejects(tools.execute('create_file', { name: 'pending.txt', content: 'draft' }), { code: 'INVALID_HELPER_RESPONSE', mayHaveCreatedFile: true });
  }
});

test('directory enumeration stops at a bounded count', async (t) => {
  const { tools, workspace } = await setup(t); await tools.init();
  for (let start = 0; start < 4095; start += 128) {
    await Promise.all(Array.from({ length: Math.min(128, 4095 - start) }, (_, index) => writeFile(path.join(workspace, `file-${start + index}.txt`), '')));
  }
  await assert.rejects(tools.execute('list_files', {}), { code: 'TOO_MANY_FILES' });
});
