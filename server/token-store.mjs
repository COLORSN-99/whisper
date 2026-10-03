import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

const SERVICE = 'com.whisper.oauth';
const MAX_IPC_BYTES = 256 * 1024;
const HELPER_TIMEOUT_MS = 15_000;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$(?![\s\S])/;

/** Error messages deliberately never contain helper output or token material. */
export class TokenStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TokenStoreError';
    this.code = code;
  }
}

function closedError() {
  return new TokenStoreError('STORE_CLOSED', 'Token storage is closed.');
}

export class MemoryTokenStore {
  persistent = false;
  #record = null;
  #closed = false;

  async load() {
    if (this.#closed) throw closedError();
    return structuredClone(this.#record);
  }

  async save(record) {
    if (this.#closed) throw closedError();
    this.#record = structuredClone(record);
  }

  async clear() {
    if (this.#closed) throw closedError();
    this.#record = null;
  }

  async close() {
    this.#record = null;
    this.#closed = true;
  }
}

/**
 * App-specific Keychain IPC. Construction performs no filesystem or Keychain IO.
 * The caller must obtain explicit user consent before using persistent methods.
 * helperPath must point at the compiled scripts/keychain.swift executable.
 */
export class MacOSKeychainTokenStore {
  persistent = true;
  #helperPath;
  #service;
  #account;
  #spawn;
  #closed = false;
  #queue = Promise.resolve();
  #cancel = new Set();

  constructor({ helperPath, service = SERVICE, account = 'default', spawnImpl = spawn } = {}) {
    if (typeof helperPath !== 'string' || !isAbsolute(helperPath) || helperPath.includes('\0')) {
      throw new TokenStoreError('INVALID_HELPER', 'A compiled helper absolute path is required.');
    }
    if (service !== SERVICE || typeof account !== 'string' || !ACCOUNT_PATTERN.test(account)) {
      throw new TokenStoreError('INVALID_SCOPE', 'Invalid application token storage scope.');
    }
    if (typeof spawnImpl !== 'function') {
      throw new TokenStoreError('INVALID_HELPER', 'A helper launcher is required.');
    }
    this.#helperPath = helperPath;
    this.#service = service;
    this.#account = account;
    this.#spawn = spawnImpl;
  }

  async load() {
    const result = await this.#enqueue('load');
    if (result.record === null) return null;
    if (!result.record || typeof result.record !== 'object' || Array.isArray(result.record)) {
      throw new TokenStoreError('INVALID_RESPONSE', 'Token storage returned an invalid response.');
    }
    return structuredClone(result.record);
  }

  async save(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TokenStoreError('INVALID_RECORD', 'Token storage requires an object record.');
    }
    // Serialize immediately so later caller mutation cannot alter a queued save.
    await this.#enqueue('save', record);
  }

  async clear() {
    await this.#enqueue('clear');
  }

  async close() {
    this.#closed = true;
    for (const cancel of this.#cancel) cancel();
    await this.#queue;
  }

  #enqueue(operation, record) {
    if (this.#closed) return Promise.reject(closedError());
    let input;
    try {
      input = JSON.stringify({ operation, service: this.#service, account: this.#account, ...(operation === 'save' ? { record } : {}) });
    } catch {
      return Promise.reject(new TokenStoreError('INVALID_RECORD', 'Token storage requires a JSON record.'));
    }
    if (Buffer.byteLength(input, 'utf8') > MAX_IPC_BYTES) {
      return Promise.reject(new TokenStoreError('RECORD_TOO_LARGE', 'Token storage request is too large.'));
    }
    const next = this.#queue.then(() => {
      if (this.#closed) throw closedError();
      return this.#request(input);
    });
    this.#queue = next.catch(() => {});
    return next;
  }

  #request(input) {
    return new Promise((resolve, reject) => {
      let child;
      let timer;
      let settled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const chunks = [];

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#cancel.delete(cancel);
        // Raw output remains private IPC; never include it in errors or logs.
        chunks.length = 0;
        if (error) {
          child?.kill('SIGKILL');
          reject(error);
        } else {
          resolve(result);
        }
      };
      const cancel = () => finish(closedError());
      this.#cancel.add(cancel);
      try {
        child = this.#spawn(this.#helperPath, [], {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
        });
      } catch {
        finish(new TokenStoreError('HELPER_UNAVAILABLE', 'Token storage helper could not start.'));
        return;
      }
      timer = setTimeout(() => {
        finish(new TokenStoreError('HELPER_TIMEOUT', 'Token storage request timed out.'));
      }, HELPER_TIMEOUT_MS);
      timer.unref?.();

      child.on('error', () => finish(new TokenStoreError('HELPER_UNAVAILABLE', 'Token storage helper could not start.')));
      child.stdin.on('error', () => finish(new TokenStoreError('HELPER_IO', 'Token storage request failed.')));
      child.stdout.on('error', () => finish(new TokenStoreError('HELPER_IO', 'Token storage request failed.')));
      child.stderr.on('error', () => finish(new TokenStoreError('HELPER_IO', 'Token storage request failed.')));
      child.stdout.on('data', (chunk) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.length;
        if (stdoutBytes > MAX_IPC_BYTES) {
          finish(new TokenStoreError('HELPER_OUTPUT_LIMIT', 'Token storage response exceeded its size limit.'));
          return;
        }
        chunks.push(bytes);
      });
      child.stderr.on('data', (chunk) => {
        if (settled) return;
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_IPC_BYTES) {
          finish(new TokenStoreError('HELPER_OUTPUT_LIMIT', 'Token storage response exceeded its size limit.'));
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new TokenStoreError('KEYCHAIN_FAILED', 'The application Keychain request failed.'));
          return;
        }
        let result;
        try {
          result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          finish(new TokenStoreError('INVALID_RESPONSE', 'Token storage returned an invalid response.'));
          return;
        }
        if (!result || result.ok !== true) {
          finish(new TokenStoreError('KEYCHAIN_FAILED', 'The application Keychain request failed.'));
          return;
        }
        finish(null, result);
      });
      try {
        child.stdin.end(input, 'utf8');
      } catch {
        finish(new TokenStoreError('HELPER_IO', 'Token storage request failed.'));
      }
    });
  }
}
