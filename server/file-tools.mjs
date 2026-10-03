import { spawn } from 'node:child_process';
import path from 'node:path';
import { lstat, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';

export const FILE_TOOL_MAX_BYTES = 128 * 1024;
export const FILE_TOOL_EXTENSIONS = Object.freeze(['.txt', '.md', '.csv', '.json']);
const MAX_HELPER_OUTPUT = 1024 * 1024;
const OPERATIONS = ['list_files', 'read_file', 'create_file'];
const makeError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function assertKeys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw makeError('INVALID_ARGUMENTS', '文件工具参数包含不支持的字段。');
}
function filename(name) {
  if (typeof name !== 'string' || !name.isWellFormed() || !name || Buffer.byteLength(name) > 180 || name.startsWith('.') || name.includes('..') || name.trim() !== name || !/^[\p{L}\p{M}\p{Nd} _.-]+$/u.test(name) || !FILE_TOOL_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    throw makeError('INVALID_FILENAME', '只允许顶层的 .txt、.md、.csv、.json 文件名；支持中文，不能含路径、隐藏名或特殊字符。');
  }
  return name;
}
function immutable(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}
const nameSchema = { type: 'string', description: '工作区顶层文件名，允许中文，仅 .txt/.md/.csv/.json；不得包含路径或隐藏名。' };
const CATALOG = immutable([
  { type: 'function', name: 'list_files', description: '列出专用工作区顶层允许后缀的普通文件名和大小，不读取内容。需要用户单次审批。', strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  { type: 'function', name: 'read_file', description: '读取专用工作区内不超过128KiB的UTF-8普通文本文件。需要用户单次审批。', strict: true,
    parameters: { type: 'object', properties: { name: nameSchema }, required: ['name'], additionalProperties: false } },
  { type: 'function', name: 'create_file', description: '原子新建UTF-8草稿，只允许新文件，绝不覆盖、删除或执行。需要用户审阅完整内容并单次审批。', strict: true,
    parameters: { type: 'object', properties: { name: nameSchema, content: { type: 'string', description: '要新建的完整UTF-8文本，最多128KiB。' } }, required: ['name', 'content'], additionalProperties: false } },
]);

/**
 * A narrow local file API, NOT an OS sandbox. The task engine must bind each
 * execute() to a single-use approval over describe().operation + .args.
 */
export class FileTools {
  constructor({ workspace, helperPath, timeoutMs = 10_000 } = {}) {
    if (!path.isAbsolute(workspace ?? '') || !path.isAbsolute(helperPath ?? '')) throw makeError('INVALID_CONFIG', '工作区和 Python 工具脚本必须是服务端固定的绝对路径。');
    this.workspace = path.resolve(workspace); this.helperPath = path.resolve(helperPath);
    if (this.workspace === path.parse(this.workspace).root) throw makeError('UNSAFE_WORKSPACE', '不能把系统根目录设为任务工作区。');
    this.timeoutMs = timeoutMs; this.rootIdentity = null; this.initializing = null;
  }

  get catalog() { return CATALOG; }

  async init() {
    if (this.rootIdentity) return this.metadata();
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const root = await lstat(this.workspace, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink()) throw makeError('UNSAFE_WORKSPACE', '工作区必须是普通目录，不能是符号链接。');
      const helper = await lstat(this.helperPath);
      if (!helper.isFile() || helper.isSymbolicLink()) throw makeError('INVALID_HELPER', 'helper 必须是服务端固定的普通 Python 脚本，不能是符号链接。');
      await access(this.helperPath, constants.R_OK);
      this.workspace = await realpath(this.workspace); this.helperPath = await realpath(this.helperPath);
      if (this.helperPath === this.workspace || this.helperPath.startsWith(`${this.workspace}${path.sep}`)) throw makeError('INVALID_CONFIG', 'helper 不能放在模型可操作的任务目录内。');
      const result = await this.invoke('inspect', {}, {});
      if (!object(result.rootIdentity) || typeof result.rootIdentity.dev !== 'string' || typeof result.rootIdentity.ino !== 'string' || !/^-?\d+$/.test(result.rootIdentity.dev) || !/^\d+$/.test(result.rootIdentity.ino)) throw makeError('INVALID_HELPER_RESPONSE', 'helper 未返回有效目录身份。');
      if (result.rootIdentity.dev !== String(root.dev) || result.rootIdentity.ino !== String(root.ino)) throw makeError('WORKSPACE_CHANGED', '初始化期间任务目录发生变化，已拒绝绑定。');
      this.rootIdentity = Object.freeze({ dev: result.rootIdentity.dev, ino: result.rootIdentity.ino });
      return this.metadata();
    })();
    try { return await this.initializing; } finally { this.initializing = null; }
  }

  metadata() {
    return { workspace: this.workspace, rootIdentity: this.rootIdentity, maxBytes: FILE_TOOL_MAX_BYTES,
      extensions: [...FILE_TOOL_EXTENSIONS], operations: [...OPERATIONS], requiresApproval: true,
      boundary: 'restricted-file-api', operatingSystemSandbox: false };
  }

  describe(operation, args = {}) {
    if (!OPERATIONS.includes(operation)) throw makeError('INVALID_OPERATION', '不支持该文件操作。');
    const allowed = operation === 'list_files' ? [] : operation === 'read_file' ? ['name'] : ['name', 'content'];
    assertKeys(args, allowed);
    let normalized = {};
    if (operation !== 'list_files') normalized.name = filename(args.name);
    if (operation === 'create_file') {
      if (typeof args.content !== 'string' || !args.content.isWellFormed()) throw makeError('INVALID_UTF8', '新建内容必须是有效的 Unicode 文本。');
      if (Buffer.byteLength(args.content, 'utf8') > FILE_TOOL_MAX_BYTES) throw makeError('FILE_TOO_LARGE', '新建内容不能超过 128 KiB。');
      normalized.content = args.content;
    }
    const title = operation === 'list_files' ? '列出任务文件' : operation === 'read_file' ? `读取 ${normalized.name}` : `新建 ${normalized.name}`;
    const detail = operation === 'list_files' ? '仅列出专用工作区顶层允许后缀的普通文件名和大小，不读取内容。' : operation === 'read_file'
      ? '读取整个 UTF-8 文件；审批后结果可能发送给当前模型。'
      : `新建 ${Buffer.byteLength(normalized.content, 'utf8')} 字节的草稿；同名文件存在时失败，不覆盖。`;
    return immutable({ operation, args: normalized, title, detail, summary: `${title}：${detail}`, access: operation === 'create_file' ? 'write' : 'read' });
  }

  async execute(operation, args = {}, { signal } = {}) {
    if (!this.rootIdentity) throw makeError('FILE_TOOLS_NOT_READY', '文件工具尚未初始化。');
    const review = this.describe(operation, args);
    if (signal?.aborted) throw makeError('FILE_TOOL_ABORTED', '操作已取消。', { mayHaveCreatedFile: false });
    return this.invoke(operation, review.args, { signal });
  }

  invoke(operation, args, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(makeError('FILE_TOOL_ABORTED', '操作已取消。', { mayHaveCreatedFile: false }));
      const request = { operation, workspace: this.workspace, args, ...(operation === 'inspect' ? {} : { expectedRoot: this.rootIdentity }) };
      let settled = false, outputBytes = 0, output = [], timer, killTimer, stoppingError;
      const child = spawn('/usr/bin/python3', ['-I', '-S', this.helperPath], { cwd: '/', env: { LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
      const finish = (error, result) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(result); };
      const stop = (code, message) => {
        if (settled || stoppingError) return;
        stoppingError = makeError(code, message, { mayHaveCreatedFile: operation === 'create_file' });
        child.kill('SIGTERM');
        // Reject only after the process exits or is forcefully stopped, so a
        // subsequent request cannot overlap a still-running cancelled write.
        killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 250);
      };
      const abort = () => stop('FILE_TOOL_ABORTED', '操作已取消；已开始的原子新建可能已经提交，请核对任务目录。');
      child.stderr.resume();
      child.stdout.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_HELPER_OUTPUT) return stop('INVALID_HELPER_RESPONSE', 'helper 输出超出限制。');
        output.push(chunk);
      });
      child.once('error', () => finish(makeError('FILE_HELPER_UNAVAILABLE', '无法启动系统 Python 文件工具，请检查固定解释器和脚本。', { mayHaveCreatedFile: false })));
      child.stdin.on('error', () => { /* close/error will report the sanitized result. */ });
      child.once('close', (code, exitSignal) => {
        if (settled) return;
        if (stoppingError) return finish(stoppingError);
        if (exitSignal) return finish(makeError('FILE_HELPER_TERMINATED', '文件 helper 被系统终止，操作未自动重试。', {
          signal: exitSignal, mayHaveCreatedFile: operation === 'create_file',
        }));
        let envelope;
        try { envelope = JSON.parse(Buffer.concat(output).toString('utf8')); } catch { return finish(makeError('INVALID_HELPER_RESPONSE', 'helper 未返回有效结果。', { mayHaveCreatedFile: operation === 'create_file' })); }
        if (!object(envelope)) return finish(makeError('INVALID_HELPER_RESPONSE', 'helper 返回格式无效。', { mayHaveCreatedFile: operation === 'create_file' }));
        if (code !== 0 || envelope.ok !== true) {
          const code = typeof envelope.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(envelope.error.code) ? envelope.error.code : 'FILE_TOOL_FAILED';
          const message = typeof envelope.error?.message === 'string' ? envelope.error.message.slice(0, 300) : '文件操作未完成。';
          return finish(makeError(code, message, { mayHaveCreatedFile: operation === 'create_file' && !['FILE_EXISTS', 'INVALID_ARGUMENTS', 'INVALID_FILENAME', 'WORKSPACE_CHANGED', 'UNSAFE_WORKSPACE'].includes(code) }));
        }
        if (!object(envelope.result)) return finish(makeError('INVALID_HELPER_RESPONSE', 'helper 返回格式无效。', { mayHaveCreatedFile: operation === 'create_file' }));
        finish(null, envelope.result);
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('FILE_TOOL_TIMEOUT', '文件工具超时；已开始的原子新建可能已经提交，请核对任务目录。'), this.timeoutMs);
      child.stdin.end(JSON.stringify(request));
    });
  }
}
