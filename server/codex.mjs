import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, readdir, lstat, stat } from 'node:fs/promises';
import path from 'node:path';

const PROVIDER = 'openai_chatgpt_plan';
const MAX_LINE = 1024 * 1024;
const SAFE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const SHELL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const ACTIVE = new Set(['starting', 'running', 'awaiting-approval']);

function failure(code, message) { return Object.assign(new Error(message), { code }); }

// Resolve the installed CLI with the host application's PATH, then launch its
// absolute path with a separate child environment. This never executes a shell.
export async function resolveCodexExecutable(command = 'codex', searchPath = process.env.PATH ?? SAFE_PATH) {
  const candidates = path.isAbsolute(command) ? [command] : command === 'codex'
    ? searchPath.split(path.delimiter).filter((directory) => path.isAbsolute(directory)).map((directory) => path.join(directory, command)) : [];
  for (const candidate of candidates) {
    try {
      const executable = await realpath(candidate);
      await access(executable, constants.X_OK);
      if ((await stat(executable)).isFile()) return executable;
    } catch { /* Continue through explicit PATH entries; do not inspect file contents. */ }
  }
  throw failure('CODEX_NOT_INSTALLED', '无法找到可执行的 Codex CLI，请安装后重试。');
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function schemaRef(schema, node) {
  if (node?.$ref?.startsWith('#/')) return node.$ref.slice(2).split('/').reduce((value, key) => value?.[key], schema);
  return node;
}

// Fail closed when an older binary would silently ignore read-access restrictions.
export function inspectSandboxSchema(schema) {
  const policy = schema.definitions?.SandboxPolicy ?? schema.$defs?.SandboxPolicy;
  const readOnly = policy?.oneOf?.find((entry) => entry.properties?.type?.enum?.includes('readOnly'));
  const access = schemaRef(schema, readOnly?.properties?.access);
  const restricted = access?.oneOf?.find((entry) => entry.properties?.type?.enum?.includes('restricted'));
  const ask = schema.definitions?.AskForApproval ?? schema.$defs?.AskForApproval;
  const choices = JSON.stringify(ask ?? {});
  const approvalPolicy = choices.includes('"untrusted"') ? 'untrusted' : choices.includes('"unlessTrusted"') ? 'unlessTrusted' : null;
  if (!restricted?.properties?.readableRoots || !restricted.properties.includePlatformDefaults || !approvalPolicy) {
    throw failure('CODEX_READ_ISOLATION_UNAVAILABLE', '该 CLI 未提供已验证目录读取隔离，真实任务已禁用；需兼容协议或另行实现经过验证的系统沙箱。');
  }
  return { approvalPolicy };
}

export function codexArguments() {
  const config = {
    model_provider: JSON.stringify(PROVIDER),
    [`model_providers.${PROVIDER}.name`]: '"ChatGPT plan"',
    [`model_providers.${PROVIDER}.base_url`]: '"https://api.openai.com/v1"',
    [`model_providers.${PROVIDER}.env_key`]: '"ACCESS_TOKEN"',
    [`model_providers.${PROVIDER}.wire_api`]: '"responses"',
    [`model_providers.${PROVIDER}.requires_openai_auth`]: 'false',
    [`model_providers.${PROVIDER}.supports_websockets`]: 'false',
    sandbox_mode: '"read-only"',
    approval_policy: '"untrusted"',
    approvals_reviewer: '"user"',
    cli_auth_credentials_store: '"ephemeral"',
    'shell_environment_policy.inherit': '"none"',
    'shell_environment_policy.set.PATH': JSON.stringify(SHELL_PATH),
    'shell_environment_policy.set.LANG': '"en_US.UTF-8"',
    'history.persistence': '"none"',
    'analytics.enabled': 'false',
    'features.shell_snapshot': 'false',
    'features.multi_agent': 'false',
    'features.code_mode': 'false',
    project_doc_max_bytes: '0',
    web_search: '"disabled"',
    mcp_servers: '{}',
  };
  return ['app-server', '--listen', 'stdio://', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${value}`])];
}

async function checkWorkspace(root) {
  // Prevent a file supplied to this narrow task directory from pointing at another project.
  const visit = async (dir, depth = 0) => {
    if (depth > 24) throw failure('WORKSPACE_TOO_DEEP', '任务目录层级过深。');
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw failure('WORKSPACE_SYMLINK', '任务目录不能包含符号链接。');
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), depth + 1);
    }
  };
  await visit(root);
}

/** Local-only task adapter. The HTTP layer must obtain a fresh UI confirmation for each start. */
export class CodexBridge {
  constructor({ dataDir, workspace, getAccessToken, onEvent = () => {}, command = 'codex', spawnImpl = spawn,
    taskTimeoutMs = 10 * 60_000, rpcTimeoutMs = 15_000, killGraceMs = 1000 } = {}) {
    if (!path.isAbsolute(dataDir ?? '') || !path.isAbsolute(workspace ?? '')) throw failure('INVALID_CONFIG', 'Codex 路径必须是服务端固定的绝对路径。');
    if (inside(workspace, dataDir) || inside(dataDir, workspace)) throw failure('INVALID_CONFIG', '任务目录与运行时凭据目录必须分离。');
    if (typeof getAccessToken !== 'function') throw failure('INVALID_CONFIG', '缺少 OAuth 凭据提供器。');
    Object.assign(this, { dataDir, workspace, getAccessToken, onEvent, command, spawnImpl, taskTimeoutMs, rpcTimeoutMs, killGraceMs });
    this.state = 'idle'; this.taskId = null; this.threadId = null; this.turnId = null;
    this.pending = new Map(); this.approvals = new Map(); this.nextId = 1;
    this.textStreams = new Map();
    this.child = null; this.probeChild = null; this.secret = ''; this.generation = 0;
  }

  status() {
    return { status: this.state, taskId: this.taskId, threadId: this.threadId, turnId: this.turnId,
      workspace: this.workspace, sandbox: 'read-only', networkAccess: false,
      approvals: [...this.approvals.values()].map(({ event }) => event), blockedReason: this.blockedReason ?? null };
  }

  event(type, details = {}) {
    const event = { type, taskId: this.taskId, timestamp: new Date().toISOString(), ...details };
    if (type === 'error' || type === 'completed' || (type === 'state' && ['completed', 'failed', 'cancelled'].includes(details.status)) || (type === 'progress' && details.method === 'error')) {
      this.flushTextStreams();
    } else if (type === 'progress' && details.method === 'item/completed') {
      this.flushTextStreams(details.itemId);
    }
    if (type === 'delta') return this.streamText(event, 'text');
    if (type === 'progress' && details.method === 'item/commandExecution/outputDelta') return this.streamText(event, 'message');
    return this.emitSanitized(event);
  }

  streamText(event, field) {
    if (!this.secret) return this.emitSanitized(event);
    const key = JSON.stringify([event.taskId, event.type, event.method ?? null, event.itemId ?? null]);
    const previous = this.textStreams.get(key);
    const text = `${previous?.tail ?? ''}${String(event[field] ?? '')}`.split(this.secret).join('[REDACTED]');
    // Release ordinary text immediately; withhold the longest suffix that could
    // still become the current access token when the next delta arrives.
    let held = Math.min(this.secret.length - 1, text.length);
    while (held > 0 && !text.endsWith(this.secret.slice(0, held))) held--;
    this.textStreams.delete(key);
    if (held > 0) {
      // Bound memory even if a faulty child invents unbounded item IDs.
      if (this.textStreams.size >= 256) this.flushTextStreams();
      this.textStreams.set(key, { event: { ...event, [field]: '' }, field, tail: text.slice(-held) });
    }
    const safeText = held > 0 ? text.slice(0, -held) : text;
    if (!safeText) return null;
    return this.emitSanitized({ ...event, [field]: safeText });
  }

  flushTextStreams(itemId) {
    for (const [key, stream] of this.textStreams) {
      if (itemId !== undefined && stream.event.itemId !== itemId) continue;
      this.textStreams.delete(key);
      // A final incomplete candidate must never be flushed as plaintext, even
      // when cancellation or an error prevents us from seeing the next chunk.
      this.emitSanitized({ ...stream.event, timestamp: new Date().toISOString(), [stream.field]: '[REDACTED]' });
    }
  }

  emitSanitized(rawEvent) {
    // Raw app-server frames and stderr must never be passed directly to the browser.
    const redact = (value) => {
      if (typeof value === 'string') return this.secret ? value.split(this.secret).join('[REDACTED]') : value;
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, /token|authorization|secret/i.test(key) ? '[REDACTED]' : redact(part)]));
      return value;
    };
    const event = redact(rawEvent);
    try { this.onEvent(event); } catch { /* A UI observer cannot change execution policy. */ }
    return event;
  }

  setState(status) { this.state = status; this.event('state', { status }); }

  async prepare() {
    for (const directory of [this.dataDir, this.workspace]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory)).isSymbolicLink()) throw failure('INVALID_CONFIG', '运行目录不能是符号链接。');
    }
    this.dataDir = await realpath(this.dataDir); this.workspace = await realpath(this.workspace);
    if (inside(this.workspace, this.dataDir) || inside(this.dataDir, this.workspace)) throw failure('INVALID_CONFIG', '运行目录不能重叠。');
    await checkWorkspace(this.workspace);
    const runDir = await mkdtemp(path.join(this.dataDir, 'run-'));
    const isolatedHome = path.join(runDir, 'home');
    const codexHome = path.join(isolatedHome, '.codex');
    const tempDir = path.join(runDir, 'tmp');
    await Promise.all([mkdir(codexHome, { recursive: true, mode: 0o700 }), mkdir(tempDir, { mode: 0o700 })]);
    const command = this.spawnImpl === spawn ? await resolveCodexExecutable(this.command) : this.command;
    return { runDir, command, env: { PATH: SAFE_PATH, HOME: isolatedHome, CODEX_HOME: codexHome,
      TMPDIR: tempDir, XDG_CONFIG_HOME: path.join(isolatedHome, '.config'), LANG: 'en_US.UTF-8', TERM: 'dumb' } };
  }

  async checkCapability(context) {
    const schemaDir = path.join(context.runDir, 'schema');
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (this.probeChild === child) this.probeChild = null;
        error ? reject(error) : resolve();
      };
      const child = this.spawnImpl(context.command, ['app-server', 'generate-json-schema', '--out', schemaDir], {
        cwd: this.workspace, env: context.env, stdio: ['ignore', 'ignore', 'ignore'], shell: false,
      });
      this.probeChild = child;
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(failure('CODEX_PROBE_TIMEOUT', 'Codex 协议检查超时。')); }, this.rpcTimeoutMs);
      child.once('error', () => finish(failure('CODEX_NOT_INSTALLED', '无法启动 Codex CLI，请安装后重试。')));
      child.once('close', (code) => finish(code === 0 ? null : failure('CODEX_PROBE_FAILED', 'Codex 协议检查失败，任务未启动。')));
    });
    const schema = JSON.parse(await readFile(path.join(schemaDir, 'v2', 'TurnStartParams.json'), 'utf8'));
    return inspectSandboxSchema(schema);
  }

  async accessToken() {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.getAccessToken()).catch(() => { throw failure('AUTH_REQUIRED', '无法取得应用授权，请检查登录状态。'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure('AUTH_TIMEOUT', '取得授权超时，请重试。')), this.rpcTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async start(options = {}) {
    const { taskId, prompt, model, confirmed } = options;
    if (Object.keys(options).some((key) => !['taskId', 'prompt', 'model', 'confirmed'].includes(key))) throw failure('INVALID_TASK', '任务不能覆盖路径、命令或权限配置。');
    if (confirmed !== true) throw failure('CONFIRMATION_REQUIRED', '每次本地任务都需要在界面明确确认。');
    if (ACTIVE.has(this.state)) throw failure('TASK_BUSY', '已有本地任务正在执行。');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId ?? '') || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000 || !/^[A-Za-z0-9._:-]{1,100}$/.test(model ?? '')) throw failure('INVALID_TASK', '任务 ID、内容或模型无效。');
    const priorCleanup = this.cleanupPromise ?? (this.child ? this.stopChild() : null);
    this.taskId = taskId; this.threadId = null; this.turnId = null; this.blockedReason = null;
    const generation = ++this.generation;
    this.setState('starting');
    this.taskTimer = setTimeout(() => this.fail(failure('TASK_TIMEOUT', '任务达到执行时限，已停止。')), this.taskTimeoutMs);
    try {
      await priorCleanup;
      if (generation !== this.generation || !ACTIVE.has(this.state)) throw failure('TASK_CANCELLED', '任务已取消。');
      const context = await this.prepare();
      if (generation !== this.generation || !ACTIVE.has(this.state)) throw failure('TASK_CANCELLED', '任务已取消。');
      const { approvalPolicy } = await this.checkCapability(context);
      if (generation !== this.generation || !ACTIVE.has(this.state)) throw failure('TASK_CANCELLED', '任务已取消。');
      const token = await this.accessToken();
      if (generation !== this.generation || !ACTIVE.has(this.state)) throw failure('TASK_CANCELLED', '任务已取消。');
      if (typeof token !== 'string' || token.length < 10 || /[\r\n\0]/.test(token)) throw failure('AUTH_REQUIRED', '请先通过官方页面登录并授权。');
      this.secret = token;
      const child = this.spawnImpl(context.command, codexArguments(), { cwd: this.workspace,
        env: { ...context.env, ACCESS_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true });
      this.child = child; this.buffer = ''; child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { if (this.child === child) this.receive(chunk); });
      child.stderr.resume(); // Do not log diagnostics that might contain credentials.
      child.stdin.on('error', () => { if (this.child === child) this.fail(failure('CODEX_PIPE_CLOSED', 'Codex 连接已关闭。')); });
      child.once('error', () => { if (this.child === child) this.fail(failure('CODEX_START_FAILED', '无法启动 Codex app-server。')); });
      child.once('close', () => { if (this.child === child && ACTIVE.has(this.state)) this.fail(failure('CODEX_EXITED', 'Codex 在任务完成前退出。')); });
      await this.request('initialize', { clientInfo: { name: 'Whisper', title: 'Whisper', version: '0.1.0' } });
      this.send({ method: 'initialized', params: {} });
      const result = await this.request('thread/start', { model, modelProvider: PROVIDER, cwd: this.workspace,
        approvalPolicy, approvalsReviewer: 'user', sandbox: 'read-only', ephemeral: true,
        developerInstructions: 'Only inspect the dedicated task workspace. Do not write files, access credentials, use networks, add tools, or request broader permissions. Report progress and blockers in Chinese.' });
      if (!result.thread?.id || result.sandbox?.type !== 'readOnly' || result.approvalPolicy !== approvalPolicy || result.cwd !== this.workspace) throw failure('CODEX_POLICY_MISMATCH', 'Codex 未确认只读权限配置，已停止。');
      this.threadId = result.thread.id;
      const turn = await this.request('turn/start', { threadId: this.threadId,
        input: [{ type: 'text', text: prompt }], cwd: this.workspace, model, approvalPolicy,
        approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false,
          access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [this.workspace] } } });
      this.turnId = turn.turn?.id ?? this.turnId;
      if (!this.turnId) throw failure('CODEX_INVALID_RESPONSE', 'Codex 没有返回任务回合 ID。');
      if (this.state === 'starting') this.setState('running');
      return this.status();
    } catch (error) {
      const safe = error.code ? error : failure('CODEX_SETUP_FAILED', 'Codex 初始化失败。');
      if (generation === this.generation && ACTIVE.has(this.state)) this.fail(safe);
      throw safe;
    }
  }

  send(message) {
    if (!this.child?.stdin.writable) throw failure('CODEX_PIPE_CLOSED', 'Codex 连接已关闭。');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('CODEX_RPC_TIMEOUT', 'Codex 请求超时。')); }, this.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) return this.fail(failure('CODEX_FRAME_TOO_LARGE', 'Codex 消息超出限制，任务已停止。'));
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { this.handle(JSON.parse(line)); } catch { this.fail(failure('CODEX_INVALID_FRAME', 'Codex 返回无效消息，任务已停止。')); return; }
    }
  }

  handle(message) {
    if (message.method && message.id !== undefined) return this.handleApproval(message);
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(failure('CODEX_RPC_ERROR', `Codex 拒绝请求（${Number(message.error.code) || '未知错误'}）。`));
      else pending.resolve(message.result ?? {});
      return;
    }
    const { method, params = {} } = message;
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    if (method === 'turn/started') this.turnId = params.turn?.id ?? this.turnId;
    if (method === 'item/agentMessage/delta') this.event('delta', { text: String(params.delta ?? ''), itemId: params.itemId });
    else if (method === 'serverRequest/resolved') {
      const id = String(params.requestId); this.approvals.delete(id);
      if (!this.approvals.size && this.state === 'awaiting-approval') this.setState('running');
    } else if (method === 'turn/completed') {
      const result = params.turn?.status;
      const status = result === 'completed' ? 'completed' : result === 'interrupted' ? 'cancelled' : 'failed';
      clearTimeout(this.taskTimer); this.setState(status);
      this.event('completed', { status, threadId: this.threadId, turnId: params.turn?.id ?? this.turnId });
      void this.stopChild();
    } else if (['item/started', 'item/completed', 'turn/plan/updated', 'item/commandExecution/outputDelta', 'error'].includes(method)) {
      this.event('progress', { method, itemId: params.item?.id ?? params.itemId,
        message: method === 'error' ? 'Codex 报告任务错误，请检查授权或模型权限。' : params.delta ?? params.item?.text ?? params.item?.command ?? params.explanation ?? params.item?.type ?? method,
        ...(Array.isArray(params.plan) ? { data: params.plan.map(({ step, status }) => ({ step, status })) } : {}) });
    }
  }

  handleApproval({ id: rpcId, method, params = {} }) {
    const id = String(rpcId);
    const deny = (reason) => {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) this.send({ id: rpcId, result: { decision: 'decline' } });
      else this.send({ id: rpcId, error: { code: -32601, message: 'This client denies unsupported requests.' } });
      this.event('blocked', { method, reason });
    };
    if (method !== 'item/commandExecution/requestApproval') return deny(method === 'item/fileChange/requestApproval' ? '首版禁止文件写入。' : '未支持的授权请求已拒绝。');
    if (params.threadId !== this.threadId || (this.turnId && params.turnId !== this.turnId)) return deny('授权请求不属于当前任务。');
    if (params.networkApprovalContext || params.additionalPermissions || params.grantRoot || params.environmentId || params.proposedNetworkPolicyAmendments?.length) return deny('首版不允许扩展网络、文件或远程环境权限。');
    // A command approval can escape the sandbox. Only trivial fixed read commands are eligible.
    if (params.cwd !== this.workspace || !/^(?:\/bin\/)?(?:pwd|ls(?: -(?:l|a|la|al))?)$/.test(params.command ?? '')) return deny('只读首版只允许单次确认 pwd 或 ls；其他命令审批已拒绝。');
    if (this.approvals.has(id)) return deny('重复授权请求已拒绝。');
    const event = this.event('approval', { id, kind: 'commandExecution', command: params.command,
      cwd: params.cwd, reason: params.reason ?? '查看专用任务目录。', decisions: ['allow-once', 'deny'] });
    this.approvals.set(id, { rpcId, event }); this.setState('awaiting-approval');
  }

  approve({ id, decision } = {}) {
    if (!['allow-once', 'deny'].includes(decision)) throw failure('INVALID_DECISION', '仅支持允许一次或拒绝。');
    const pending = this.approvals.get(String(id));
    if (!pending) throw failure('APPROVAL_NOT_FOUND', '该审批已过期或不存在。');
    this.send({ id: pending.rpcId, result: { decision: decision === 'allow-once' ? 'accept' : 'decline' } });
    this.approvals.delete(String(id)); this.event('approval-resolved', { id: String(id), decision });
    if (!this.approvals.size) this.setState('running');
    return this.status();
  }

  fail(error) {
    if (!ACTIVE.has(this.state)) return;
    clearTimeout(this.taskTimer); this.blockedReason = error.code;
    this.event('error', { code: error.code, message: error.message }); this.setState('failed');
    void this.stopChild();
  }

  async cancel() {
    if (!ACTIVE.has(this.state)) return this.status();
    ++this.generation; clearTimeout(this.taskTimer);
    const cancelledTask = { taskId: this.taskId, threadId: this.threadId, turnId: this.turnId };
    if (this.child && this.threadId && this.turnId) {
      try { this.send({ id: this.nextId++, method: 'turn/interrupt', params: { threadId: this.threadId, turnId: this.turnId } }); } catch { /* Termination below is the fallback. */ }
    }
    this.setState('cancelled'); await this.stopChild();
    this.event('completed', { status: 'cancelled', ...cancelledTask });
    return this.status();
  }

  stopChild() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.cleanupChild().finally(() => { this.cleanupPromise = null; });
    return this.cleanupPromise;
  }

  async cleanupChild() {
    this.flushTextStreams();
    this.probeChild?.kill('SIGKILL'); this.probeChild = null;
    const child = this.child; this.child = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure('TASK_STOPPED', '任务已停止。')); }
    this.pending.clear(); this.approvals.clear();
    if (child) await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const signal = (value) => {
        try { if (child.pid && this.spawnImpl === spawn) process.kill(-child.pid, value); else child.kill(value); } catch { /* Already exited. */ }
      };
      const timer = setTimeout(() => { signal('SIGKILL'); finish(); }, this.killGraceMs);
      child.once('close', finish); signal('SIGTERM');
      if (child.exitCode !== null && child.exitCode !== undefined) finish();
    });
    this.secret = '';
  }

  async close() { await this.cancel(); clearTimeout(this.taskTimer); await this.stopChild(); }
}
