import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexBridge, codexArguments, inspectSandboxSchema, resolveCodexExecutable } from '../server/codex.mjs';

// Minimal shape from the official restricted read-access RPC schema; not a live model response.
const restrictedSchema = {
  definitions: {
    SandboxPolicy: { oneOf: [{ properties: { type: { enum: ['readOnly'] }, access: { $ref: '#/definitions/ReadOnlyAccess' } } }] },
    ReadOnlyAccess: { oneOf: [{ properties: { type: { enum: ['restricted'] }, readableRoots: { type: 'array' }, includePlatformDefaults: { type: 'boolean' } } }] },
    AskForApproval: { oneOf: [{ enum: ['untrusted', 'on-request', 'never'] }] },
  },
};
// Exact relevant 0.147.0 schema shape generated locally: readOnly has no access property.
const legacySchema = { definitions: { SandboxPolicy: { oneOf: [{ properties: { type: { enum: ['readOnly'] }, networkAccess: { default: false, type: 'boolean' } } }] } } };
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function setup(t, { schema = restrictedSchema, response = null, delayedKill = false, ...options } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'whisper-codex-test-')));
  const events = [], children = [], messages = [];
  let tokenCalls = 0;
  const spawnImpl = (command, args, config) => {
    const child = new EventEmitter(); Object.assign(child, { command, args, config, exitCode: null, killed: [] });
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.emitFrame = (frame) => child.stdout.write(`${JSON.stringify(frame)}\n`);
    child.kill = (signal) => { child.killed.push(signal); if (!delayedKill) { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); } return true; };
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const message = JSON.parse(String(chunk)); messages.push(message); callback();
      if (!message.method || message.id === undefined) return;
      queueMicrotask(() => {
        if (response && response(message, child) === false) return;
        let result = {};
        if (message.method === 'thread/start') result = { thread: { id: 'thread-test' }, cwd: config.cwd, approvalPolicy: 'untrusted', sandbox: { type: 'readOnly' } };
        if (message.method === 'turn/start') result = { turn: { id: 'turn-test', status: 'inProgress' } };
        child.emitFrame({ id: message.id, result });
      });
    } });
    children.push(child);
    if (args[1] === 'generate-json-schema') queueMicrotask(async () => {
      const out = args[args.indexOf('--out') + 1];
      await mkdir(path.join(out, 'v2'), { recursive: true });
      await writeFile(path.join(out, 'v2', 'TurnStartParams.json'), JSON.stringify(schema));
      child.exitCode = 0; child.emit('close', 0);
    });
    return child;
  };
  const bridge = new CodexBridge({ dataDir: path.join(root, 'runtime'), workspace: path.join(root, 'workspace'),
    getAccessToken: async () => { tokenCalls++; return 'only-test-credential-123'; }, onEvent: (event) => events.push(event),
    spawnImpl, rpcTimeoutMs: 1000, killGraceMs: 10, ...options });
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  const start = (extra = {}) => bridge.start({ taskId: 'task-1', prompt: '查看任务目录', model: 'gpt-test', confirmed: true, ...extra });
  return { bridge, start, events, children, messages, root, get tokenCalls() { return tokenCalls; } };
}

test('rejects legacy schemas instead of silently granting broad reads', () => {
  assert.throws(() => inspectSandboxSchema(legacySchema), { code: 'CODEX_READ_ISOLATION_UNAVAILABLE' });
  assert.deepEqual(inspectSandboxSchema(restrictedSchema), { approvalPolicy: 'untrusted' });
});

test('resolves CLI from an explicit host PATH without inheriting it into the child', async (t) => {
  const context = await setup(t);
  const binaryDir = path.join(context.root, '.local', 'bin'); await mkdir(binaryDir, { recursive: true });
  const binary = path.join(binaryDir, 'codex');
  await writeFile(binary, 'This fixture is never executed.'); await chmod(binary, 0o700);
  assert.equal(await resolveCodexExecutable('codex', `/missing${path.delimiter}${binaryDir}`), binary);
  assert.equal(await resolveCodexExecutable(binary), binary);
  await assert.rejects(resolveCodexExecutable('codex', '.:relative/bin:/missing'), { code: 'CODEX_NOT_INSTALLED' });
  await context.start();
  assert.equal(context.children[1].config.env.PATH.includes(binaryDir), false);
});

test('requires per-task confirmation and rejects path/config injection before starting', async (t) => {
  const context = await setup(t);
  await assert.rejects(context.start({ confirmed: false }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(context.start({ cwd: '/Users' }), { code: 'INVALID_TASK' });
  await assert.rejects(context.start({ model: 'x\n-c sandbox_mode=danger-full-access' }), { code: 'INVALID_TASK' });
  assert.equal(context.children.length, 0); assert.equal(context.tokenCalls, 0);
});

test('0.147 capability failure occurs before fetching credentials or launching a turn', async (t) => {
  const context = await setup(t, { schema: legacySchema });
  await assert.rejects(context.start(), { code: 'CODEX_READ_ISOLATION_UNAVAILABLE' });
  assert.equal(context.tokenCalls, 0); assert.equal(context.children.length, 1);
  assert.equal(context.bridge.status().status, 'failed');
  assert.equal(context.bridge.status().blockedReason, 'CODEX_READ_ISOLATION_UNAVAILABLE');
});

test('uses isolated HOME, CODEX_HOME, a whitelist environment and fixed official provider', async (t) => {
  const context = await setup(t); await context.start();
  const child = context.children[1], env = child.config.env;
  assert.ok(env.HOME.startsWith(context.root)); assert.ok(env.CODEX_HOME.startsWith(env.HOME));
  assert.equal(env.ACCESS_TOKEN, 'only-test-credential-123');
  assert.deepEqual(Object.keys(env).sort(), ['ACCESS_TOKEN', 'CODEX_HOME', 'HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME']);
  assert.equal(child.config.shell, false); assert.deepEqual(child.config.stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(codexArguments().includes('model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"'));
  assert.ok(codexArguments().includes('model_providers.openai_chatgpt_plan.requires_openai_auth=false'));
  assert.ok(codexArguments().includes('model_providers.openai_chatgpt_plan.supports_websockets=false'));
  assert.ok(codexArguments().includes('shell_environment_policy.inherit="none"'));
  assert.equal(JSON.stringify(child.args).includes(env.ACCESS_TOKEN), false);
  assert.deepEqual(context.messages.slice(0, 4).map(({ method }) => method), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.equal(context.messages[0].params.clientInfo.name, 'Whisper');
  const turn = context.messages.find(({ method }) => method === 'turn/start');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false, access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [context.bridge.workspace] } });
});

test('rejects workspace symlinks before credentials or processes', async (t) => {
  const context = await setup(t);
  await mkdir(context.bridge.workspace); await symlink('/Users', path.join(context.bridge.workspace, 'outside'));
  await assert.rejects(context.start(), { code: 'WORKSPACE_SYMLINK' });
  assert.equal(context.children.length, 0); assert.equal(context.tokenCalls, 0);
});

test('streams bounded events and redacts a credential echoed by the child', async (t) => {
  const context = await setup(t); await context.start(); const child = context.children[1];
  child.emitFrame({ method: 'item/agentMessage/delta', params: { threadId: 'thread-test', itemId: 'a1', delta: 'hello only-test-credential-123' } });
  child.emitFrame({ method: 'turn/plan/updated', params: { explanation: '准备只读检查', plan: [{ step: '查看文件', status: 'inProgress' }] } });
  assert.equal(context.events.find(({ type }) => type === 'delta').text, 'hello [REDACTED]');
  assert.equal(context.events.find(({ method }) => method === 'turn/plan/updated').data[0].step, '查看文件');
  assert.equal(JSON.stringify(context.events).includes('only-test-credential-123'), false);
});

test('redacts a token split at every possible delta boundary without delaying ordinary text', async (t) => {
  const context = await setup(t); await context.start(); const child = context.children[1];
  const token = 'only-test-credential-123';
  for (let split = 1; split < token.length; split++) {
    const itemId = `split-${split}`;
    child.emitFrame({ method: 'item/agentMessage/delta', params: { itemId, delta: `Ready ${token.slice(0, split)}` } });
    assert.equal(context.events.filter((event) => event.type === 'delta' && event.itemId === itemId).map(({ text }) => text).join(''), 'Ready ');
    child.emitFrame({ method: 'item/agentMessage/delta', params: { itemId, delta: `${token.slice(split)} done` } });
    assert.equal(context.events.filter((event) => event.type === 'delta' && event.itemId === itemId).map(({ text }) => text).join(''), 'Ready [REDACTED] done');
  }
  assert.equal(context.bridge.textStreams.size, 0);
  assert.equal(JSON.stringify(context.events).includes(token), false);
});

test('redacts character-by-character tokens and command output split over progress events', async (t) => {
  const context = await setup(t); await context.start(); const child = context.children[1];
  const token = 'only-test-credential-123';
  for (const character of token.repeat(2)) child.emitFrame({ method: 'item/commandExecution/outputDelta', params: { itemId: 'cmd-1', delta: character } });
  assert.equal(context.events.filter(({ method }) => method === 'item/commandExecution/outputDelta').map(({ message }) => message).join(''), '[REDACTED][REDACTED]');
  child.emitFrame({ method: 'item/agentMessage/delta', params: { itemId: 'plain', delta: 'only' } });
  child.emitFrame({ method: 'item/agentMessage/delta', params: { itemId: 'plain', delta: ' ordinary words' } });
  assert.equal(context.events.filter(({ type, itemId }) => type === 'delta' && itemId === 'plain').map(({ text }) => text).join(''), 'only ordinary words');
});

test('item completion safely replaces an unfinished token prefix in that item only', async (t) => {
  const context = await setup(t); await context.start(); const child = context.children[1];
  child.emitFrame({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'only-test-' } });
  child.emitFrame({ method: 'item/commandExecution/outputDelta', params: { itemId: 'b', delta: 'only-test-' } });
  child.emitFrame({ method: 'item/completed', params: { item: { id: 'a', type: 'agentMessage' } } });
  assert.equal(context.events.filter(({ type }) => type === 'delta').map(({ text }) => text).join(''), '[REDACTED]');
  assert.equal(context.bridge.textStreams.size, 1);
  assert.equal(JSON.stringify(context.events).includes('only-test-'), false);
  child.emitFrame({ method: 'item/commandExecution/outputDelta', params: { itemId: 'b', delta: 'credential-123' } });
  assert.equal(context.events.filter(({ method }) => method === 'item/commandExecution/outputDelta').map(({ message }) => message).join(''), '[REDACTED]');
});

for (const ending of ['completed', 'failed', 'cancelled', 'error', 'close']) {
  test(`safely flushes incomplete stream candidates on ${ending}`, async (t) => {
    const context = await setup(t); await context.start(); const child = context.children[1];
    child.emitFrame({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'before only-test-' } });
    child.emitFrame({ method: 'item/commandExecution/outputDelta', params: { itemId: 'b', delta: 'before only-test-' } });
    if (ending === 'cancelled') await context.bridge.cancel();
    else if (ending === 'close') await context.bridge.close();
    else if (ending === 'error') child.stdout.write('malformed\n');
    else child.emitFrame({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: ending } } });
    assert.equal(context.bridge.textStreams.size, 0);
    assert.equal(context.events.filter(({ type }) => type === 'delta').map(({ text }) => text).join(''), 'before [REDACTED]');
    assert.equal(context.events.filter(({ method }) => method === 'item/commandExecution/outputDelta').map(({ message }) => message).join(''), 'before [REDACTED]');
    assert.equal(JSON.stringify(context.events).includes('only-test-'), false);
  });
}

test('only fixed local read commands can receive a single-use approval', async (t) => {
  const context = await setup(t); await context.start(); const child = context.children[1];
  const params = { threadId: 'thread-test', turnId: 'turn-test', cwd: context.bridge.workspace, command: 'ls -la', itemId: 'i1' };
  child.emitFrame({ id: 100, method: 'item/commandExecution/requestApproval', params });
  assert.equal(context.bridge.status().status, 'awaiting-approval');
  assert.deepEqual(context.bridge.status().approvals[0].decisions, ['allow-once', 'deny']);
  assert.throws(() => context.bridge.approve({ id: 100, decision: 'acceptForSession' }), { code: 'INVALID_DECISION' });
  context.bridge.approve({ id: '100', decision: 'allow-once' });
  assert.deepEqual(context.messages.at(-1), { id: 100, result: { decision: 'accept' } });
  assert.throws(() => context.bridge.approve({ id: '100', decision: 'allow-once' }), { code: 'APPROVAL_NOT_FOUND' });
  child.emitFrame({ id: 101, method: 'item/commandExecution/requestApproval', params: { ...params, command: 'pwd' } });
  context.bridge.approve({ id: 101, decision: 'deny' });
  assert.deepEqual(context.messages.at(-1), { id: 101, result: { decision: 'decline' } });
});

test('denies writes, network, sandbox extension, arbitrary shell and unknown RPC requests', async (t) => {
  const context = await setup(t); await context.start(); const child = context.children[1];
  const params = { threadId: 'thread-test', turnId: 'turn-test', cwd: context.bridge.workspace, command: 'ls' };
  const cases = [
    ['item/fileChange/requestApproval', params],
    ['item/commandExecution/requestApproval', { ...params, networkApprovalContext: { host: 'example.com' } }],
    ['item/commandExecution/requestApproval', { ...params, additionalPermissions: { fileSystem: {} } }],
    ['item/commandExecution/requestApproval', { ...params, command: 'ls; cat ~/.codex/auth.json' }],
    ['item/commandExecution/requestApproval', { ...params, cwd: '/Users' }],
    ['item/commandExecution/requestApproval', { ...params, threadId: 'other' }],
    ['item/permissions/requestApproval', params],
    ['account/chatgptAuthTokens/refresh', params],
    ['item/tool/call', params],
  ];
  cases.forEach(([method, eventParams], index) => child.emitFrame({ id: `deny-${index}`, method, params: eventParams }));
  assert.equal(context.bridge.status().approvals.length, 0);
  assert.equal(context.events.filter(({ type }) => type === 'blocked').length, cases.length);
  for (let i = 0; i < cases.length; i++) {
    const answer = context.messages.find(({ id }) => id === `deny-${i}`);
    assert.ok(answer.error || answer.result?.decision === 'decline');
  }
});

test('cancel sends interrupt and stops child; each next task gets a fresh token and home', async (t) => {
  const context = await setup(t); await context.start();
  const firstHome = context.children[1].config.env.CODEX_HOME;
  await context.bridge.cancel();
  assert.equal(context.bridge.status().status, 'cancelled');
  assert.deepEqual(context.messages.find(({ method }) => method === 'turn/interrupt').params, { threadId: 'thread-test', turnId: 'turn-test' });
  assert.ok(context.children[1].killed.includes('SIGTERM'));
  await context.start({ taskId: 'task-2' });
  assert.notEqual(context.children[3].config.env.CODEX_HOME, firstHome); assert.equal(context.tokenCalls, 2);
});

test('only completed counts as success and releases the process', async (t) => {
  const context = await setup(t); await context.start();
  context.children[1].emitFrame({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'failed' } } });
  await tick(); assert.equal(context.bridge.status().status, 'failed');
  assert.equal(context.events.find(({ type }) => type === 'completed').status, 'failed');
  assert.ok(context.children[1].killed.includes('SIGTERM'));
});

test('a new start waits for cleanup and cannot lose redaction or inherit a cancellation event', async (t) => {
  const context = await setup(t, { delayedKill: true }); await context.start();
  const cancellation = context.bridge.cancel();
  await context.start({ taskId: 'task-2' }); await cancellation;
  context.children[3].emitFrame({ method: 'item/agentMessage/delta', params: { delta: 'only-test-credential-123' } });
  assert.equal(context.events.at(-1).text, '[REDACTED]');
  assert.equal(context.events.find(({ type, status }) => type === 'completed' && status === 'cancelled').taskId, 'task-1');
  assert.ok(context.children[1].killed.includes('SIGKILL'));
});

test('cancel during preparation prevents a late capability probe or token fetch', async (t) => {
  const context = await setup(t);
  let release;
  context.bridge.prepare = () => new Promise((resolve) => { release = resolve; });
  const starting = context.start(); await tick();
  await context.bridge.cancel(); release({});
  await assert.rejects(starting, { code: 'TASK_CANCELLED' });
  assert.equal(context.children.length, 0); assert.equal(context.tokenCalls, 0);
});

test('task execution timeout terminates a child waiting indefinitely', async (t) => {
  const context = await setup(t, { taskTimeoutMs: 40 }); await context.start();
  await new Promise((resolve) => setTimeout(resolve, 65));
  assert.equal(context.bridge.status().blockedReason, 'TASK_TIMEOUT');
  assert.ok(context.children[1].killed.includes('SIGTERM'));
});

test('RPC initialization timeout does not start a turn', async (t) => {
  const context = await setup(t, { rpcTimeoutMs: 30, response: (message) => message.method !== 'initialize' });
  await assert.rejects(context.start(), { code: 'CODEX_RPC_TIMEOUT' });
  assert.equal(context.messages.some(({ method }) => method === 'turn/start'), false);
});

test('token retrieval is bounded and provider error details are not exposed', async (t) => {
  const context = await setup(t, { rpcTimeoutMs: 30, getAccessToken: () => new Promise(() => {}) });
  await assert.rejects(context.start(), { code: 'AUTH_TIMEOUT' });
  assert.equal(context.children.length, 1);
  context.bridge.getAccessToken = async () => { throw Object.assign(new Error('private-provider-diagnostic'), { code: 'SECRET_DIAGNOSTIC' }); };
  await assert.rejects(context.start(), { code: 'AUTH_REQUIRED' });
  assert.equal(JSON.stringify(context.events).includes('private-provider-diagnostic'), false);
});

test('policy mismatch and malformed output stop execution', async (t) => {
  const context = await setup(t, { response(message, child) {
    if (message.method !== 'thread/start') return true;
    child.emitFrame({ id: message.id, result: { thread: { id: 'wrong' }, cwd: child.config.cwd, approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } } });
    return false;
  } });
  await assert.rejects(context.start(), { code: 'CODEX_POLICY_MISMATCH' });
  assert.equal(context.messages.some(({ method }) => method === 'turn/start'), false);
});

test('a malformed child frame stops the active turn', async (t) => {
  const context = await setup(t); await context.start(); context.children[1].stdout.write('not-json\n');
  assert.equal(context.bridge.status().blockedReason, 'CODEX_INVALID_FRAME');
});
