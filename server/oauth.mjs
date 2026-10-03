import { randomBytes, randomUUID, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, lstat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryTokenStore } from './token-store.mjs';

export const OPENAI_ISSUER = 'https://auth.openai.com';
export const OPENAI_RESOURCE = 'https://api.openai.com/v1';
export const OAUTH_SCOPES = Object.freeze(['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']);
const AUTHORIZE_URL = `${OPENAI_ISSUER}/api/accounts/authorize`;
const DISCOVERY_URL = `${OPENAI_ISSUER}/.well-known/openid-configuration`;
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const TEN_MINUTES = 10 * 60_000;
const MAX_JSON_BYTES = 256 * 1024;
const TERMINAL_REFRESH_ERRORS = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

export class OAuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}
const fail = (code, message, status) => { throw new OAuthError(code, message, status); };
const random = () => randomBytes(32).toString('base64url');
const text = (value, max = 512) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : null;
const clientIdValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) && value !== 'dynamic_agent_client';
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const publicAccount = registration => registration ? {
  label: registration.label, email: registration.email ?? null,
  subject: registration.subject ?? null, clientId: registration.clientId,
} : null;

function safeEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_discovery', 'OpenAI 登录配置无效。', 502); }
  if (url.origin !== OPENAI_ISSUER || url.username || url.password || url.hash || url.search) {
    fail('invalid_discovery', 'OpenAI 登录端点不在允许的官方域名。', 502);
  }
  return url.href;
}

async function readSmallJSON(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) fail('invalid_storage', '登录元数据文件无效。');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

/** One local runtime and one active account. No network or credential access in constructor/init. */
export class OAuthManager {
  #dataDir; #redirectUri; #fetch; #now; #persistentStore; #memoryStore = new MemoryTokenStore();
  #sessionStore = this.#memoryStore; #record = null; #pending = null; #callbackBusy = false;
  #meta = { version: 1, hostId: null, selectedClientId: null, pendingClientId: null, registrations: [] };
  #ready = false; #closed = false; #lock = null; #discovery = null; #jwks = null;
  #refresh = null; #epoch = 0; #signingOut = false; #warning = null; #starting = false;
  #requestControllers = new Set(); #bodyReaders = new Set();

  constructor({ dataDir, redirectUri, fetchImpl = globalThis.fetch, store, now = Date.now } = {}) {
    if (!dataDir || !path.isAbsolute(dataDir)) fail('invalid_config', 'OAuth dataDir 必须是本项目的绝对路径。');
    let redirect;
    try { redirect = new URL(redirectUri); } catch { fail('invalid_redirect', '登录回调地址无效。'); }
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port ||
        redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/auth/callback') {
      fail('invalid_redirect', '登录回调必须使用 http://127.0.0.1:端口/auth/callback。');
    }
    this.#dataDir = path.resolve(dataDir);
    this.#redirectUri = redirect.href;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#persistentStore = store?.persistent ? store : null;
    if (store && !store.persistent) this.#sessionStore = this.#memoryStore = store;
  }

  async init() {
    if (this.#ready) return this.status();
    try {
      const directory = await lstat(this.#dataDir);
      if (!directory.isDirectory() || directory.isSymbolicLink()) fail('invalid_storage', '登录数据目录不能是符号链接。');
      const data = await readSmallJSON(path.join(this.#dataDir, 'oauth-metadata.json'));
      if (data.version !== 1 || !/^urn:uuid:[0-9a-f-]{36}$/i.test(data.hostId) || !Array.isArray(data.registrations) || data.registrations.length > 100) {
        fail('invalid_storage', '登录元数据无效，请检查本项目数据目录。');
      }
      const registrations = data.registrations.map((item, i) => {
        if (!clientIdValid(item.clientId) || (item.subject != null && !text(item.subject))) fail('invalid_storage', '账户注册信息无效。');
        return { clientId: item.clientId, subject: item.subject ?? null, issuer: OPENAI_ISSUER, email: text(item.email), label: text(item.label, 100) || `ChatGPT ${i + 1}` };
      });
      if (new Set(registrations.map(item => item.clientId)).size !== registrations.length) fail('invalid_storage', '账户注册信息重复。');
      this.#meta = { version: 1, hostId: data.hostId, registrations,
        selectedClientId: registrations.some(item => item.clientId === data.selectedClientId) ? data.selectedClientId : null,
        pendingClientId: registrations.some(item => item.clientId === data.pendingClientId) ? data.pendingClientId : null };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error instanceof OAuthError) throw error;
        fail('invalid_storage', '无法安全读取本项目登录元数据。');
      }
    }
    this.#ready = true;
    return this.status();
  }

  #assertReady() {
    if (!this.#ready || this.#closed) fail('unavailable', '登录管理器尚未初始化或已关闭。', 503);
  }

  status() {
    const account = this.#record?.account ?? this.#meta.registrations.find(item => item.clientId === this.#meta.selectedClientId);
    return {
      connected: Boolean(this.#record && !this.#signingOut),
      planEnabled: Boolean(this.#record && !this.#signingOut && this.#record.scopes.includes(DIRECT_SCOPE) && this.#record.scopes.includes('resource.invoke')),
      persistence: this.#record && this.#sessionStore.persistent ? 'keychain' : 'memory',
      persistenceAvailable: Boolean(this.#persistentStore),
      account: publicAccount(account),
      accounts: this.#meta.registrations.filter(item => item.subject).map(publicAccount),
      expiresAt: this.#record?.expiresAt ?? null,
      pending: Boolean(this.#pending && this.#pending.expiresAt > this.#now()),
      warning: this.#warning,
    };
  }

  async #acquireLockAndHost() {
    if (this.#lock) return;
    await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.#dataDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid_storage', '登录数据目录不能是符号链接。');
    await chmod(this.#dataDir, 0o700);
    const lockFile = path.join(this.#dataDir, 'oauth-session.lock');
    try {
      this.#lock = await open(lockFile, 'wx', 0o600);
      await this.#lock.writeFile(JSON.stringify({ pid: process.pid }));
    } catch (error) {
      if (error.code === 'EEXIST') fail('session_locked', '另一个进程正在使用此登录目录；先关闭它。崩溃后请确认无进程运行再删除 oauth-session.lock。', 409);
      throw new OAuthError('storage_failed', '无法创建本项目登录锁。', 500);
    }
    if (!this.#meta.hostId) {
      this.#meta.hostId = `urn:uuid:${randomUUID()}`;
      await this.#saveMetadata();
    }
  }

  async #saveMetadata() {
    const target = path.join(this.#dataDir, 'oauth-metadata.json');
    const temporary = path.join(this.#dataDir, `.oauth-metadata-${randomUUID()}.tmp`);
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(`${JSON.stringify(this.#meta, null, 2)}\n`);
      await file.sync();
      await file.close(); file = null;
      await rename(temporary, target);
    } catch {
      fail('storage_failed', '无法保存本项目登录注册信息。', 500);
    } finally {
      await file?.close();
      await unlink(temporary).catch(() => {});
    }
  }

  async begin({ consent = false, persist = false, persistenceConsent = false, newAccount = false, clientId, enablePlan = false } = {}) {
    this.#assertReady();
    if (consent !== true) fail('consent_required', '请先明确同意前往 OpenAI 官方页面授权。');
    if (persist && (persistenceConsent !== true || !this.#persistentStore)) fail('persistence_consent_required', '持久保存需要已配置的 macOS Keychain 和单独明确同意。');
    if (this.#starting || this.#callbackBusy || this.#signingOut || this.#refresh) fail('auth_busy', '登录状态正在更新，请稍后再试。', 409);
    if (newAccount && this.#record) fail('sign_out_first', '首版请先退出当前账户，再添加另一个账户。', 409);
    if (this.#record && persist !== Boolean(this.#sessionStore.persistent)) fail('sign_out_first', '切换凭据保存方式前请先退出登录。', 409);
    this.#starting = true;
    try {
      await this.#acquireLockAndHost();
      this.#assertReady();
      const selected = newAccount ? null : this.#meta.registrations.find(item => item.clientId === (clientId || this.#meta.selectedClientId || this.#meta.pendingClientId));
      if (clientId && !selected) fail('unknown_account', '请选择已保存的账户或明确添加新账户。');
      if (this.#record && selected?.clientId !== this.#record.account.clientId) fail('sign_out_first', '切换账户前请先退出当前账户。', 409);
      const state = random(); const nonce = random(); const verifier = random();
      this.#pending = { state, nonce, verifier, redirectUri: this.#redirectUri,
        expiresAt: this.#now() + TEN_MINUTES, persist: Boolean(persist), account: selected ? { ...selected } : null,
        clientId: selected?.clientId ?? 'dynamic_agent_client', epoch: this.#epoch };
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({ client_id: this.#pending.clientId, ext_agent_host_id: this.#meta.hostId,
        response_type: 'code', redirect_uri: this.#redirectUri, scope: OAUTH_SCOPES.join(' '), resource: OPENAI_RESOURCE,
        state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
      if (!selected) url.searchParams.set('agent_name_hint', 'Whisper');
      if (selected?.email) url.searchParams.set('login_hint', selected.email);
      // Deliberately omit id_token_hint: this URL is returned to browser JS. No token leaves this runtime.
      if (enablePlan === true) url.searchParams.set('prompt', 'consent');
      this.#warning = null;
      return { url: url.href, expiresAt: this.#pending.expiresAt };
    } finally { this.#starting = false; }
  }

  async callback(callbackUrl) {
    this.#assertReady();
    if (this.#callbackBusy) fail('auth_busy', '该登录回调已在处理中。', 409);
    const pending = this.#pending;
    if (!pending || pending.expiresAt <= this.#now()) {
      this.#pending = null;
      fail('invalid_state', '登录请求已过期或已使用，请重新登录。');
    }
    let url;
    try { url = new URL(callbackUrl); } catch { fail('invalid_callback', '登录回调地址无效。'); }
    if (`${url.origin}${url.pathname}` !== pending.redirectUri || url.hash || url.username || url.password) fail('invalid_callback', '登录回调与本次请求不一致。');
    for (const name of ['state', 'code', 'client_id', 'error', 'iss']) {
      if (url.searchParams.getAll(name).length > 1) fail('invalid_callback', '登录回调参数重复。');
    }
    if (!equal(url.searchParams.get('state'), pending.state)) fail('invalid_state', '登录状态校验失败，请重新登录。');
    // Consume a matching attempt before any async work or OAuth error handling.
    // An unrelated cross-site request cannot burn the user's legitimate attempt.
    this.#pending = null;
    if (url.searchParams.has('iss') && url.searchParams.get('iss') !== OPENAI_ISSUER) fail('invalid_issuer', '登录回调发行者不匹配。');
    if (url.searchParams.has('error')) fail('authorization_denied', 'OpenAI 授权未完成；你可以稍后重新登录。');
    const code = url.searchParams.get('code');
    if (!code || code.length > 8192) fail('missing_code', '登录回调缺少有效授权码。');
    const returnedClient = url.searchParams.get('client_id');
    if (pending.clientId !== 'dynamic_agent_client' && returnedClient && returnedClient !== pending.clientId) fail('client_mismatch', '本次授权返回了不同的账户注册。');
    const clientId = pending.clientId === 'dynamic_agent_client' ? returnedClient : pending.clientId;
    if (!clientIdValid(clientId)) fail('missing_client_id', 'OpenAI 未返回有效注册 ID，请重新登录。');
    this.#callbackBusy = true;
    try {
      if (pending.clientId === 'dynamic_agent_client' && !this.#meta.registrations.some(item => item.clientId === clientId)) {
        this.#meta.registrations.push({ clientId, subject: null, issuer: OPENAI_ISSUER, email: null, label: `ChatGPT ${this.#meta.registrations.length + 1}` });
        this.#meta.pendingClientId = clientId;
        await this.#saveMetadata();
      }
      const configuration = await this.#getDiscovery();
      const tokens = await this.#tokenRequest(configuration.token_endpoint, {
        grant_type: 'authorization_code', client_id: clientId, code,
        code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: OPENAI_RESOURCE,
      });
      const claims = await this.#verifyIdentity(tokens.id_token, clientId, { nonce: pending.nonce, accessToken: tokens.access_token });
      if (pending.account?.subject && pending.account.subject !== claims.sub) fail('account_mismatch', '重新登录的账户与选中的账户不一致。');
      const account = { clientId, issuer: OPENAI_ISSUER, subject: claims.sub, email: text(claims.email),
        label: this.#meta.registrations.find(item => item.clientId === clientId)?.label || 'ChatGPT 1' };
      const record = this.#buildRecord(tokens, account, pending.nonce);
      if (pending.epoch !== this.#epoch || this.#closed || this.#signingOut) fail('cancelled', '本次登录已取消。');
      const sessionStore = pending.persist ? this.#persistentStore : this.#memoryStore;
      // Commit non-secret registration first: filesystem failure must not orphan
      // a newly persisted credential record that logout would not know about.
      const previousMetadata = this.#meta;
      this.#meta = { ...this.#meta, registrations: this.#meta.registrations.map(item => item.clientId === clientId ? account : item), selectedClientId: clientId, pendingClientId: null };
      try { await this.#saveMetadata(); }
      catch (error) { this.#meta = previousMetadata; throw error; }
      if (pending.epoch !== this.#epoch || this.#closed) fail('cancelled', '本次登录已取消。');
      try { await sessionStore.save(record); }
      catch {
        // A helper may have written before its IPC failed. Keep the account and
        // latest tokens manageable, but report the uncertain persistence state.
        if (!this.#closed && pending.epoch === this.#epoch) {
          this.#record = record;
          this.#sessionStore = sessionStore;
          this.#epoch += 1;
          this.#warning = '授权已完成，但凭据保存未确认；请重试安全存储或退出登录。';
        }
        fail('credential_save_failed', '授权已完成，但凭据保存未确认。', 500);
      }
      if (pending.epoch !== this.#epoch || this.#closed) {
        await sessionStore.clear().catch(() => {});
        fail('cancelled', '本次登录已取消。');
      }
      this.#sessionStore = sessionStore;
      this.#record = record;
      this.#epoch += 1;
      return this.status();
    } finally { this.#callbackBusy = false; }
  }

  async #request(url, init = {}) {
    const controller = new AbortController();
    this.#requestControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref?.();
    try {
      return await this.#fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    } catch {
      fail('oauth_network_error', '无法连接 OpenAI 登录服务，请稍后重试。', 502);
    } finally { clearTimeout(timer); this.#requestControllers.delete(controller); }
  }

  async #json(response) {
    let reader;
    let timer;
    try {
      reader = response.body?.getReader();
      if (!reader) throw new Error();
      this.#bodyReaders.add(reader);
      const chunks = [];
      let bytes = 0;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('response timeout')), 15_000);
        timer.unref?.();
      });
      while (true) {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_JSON_BYTES) throw new Error();
        chunks.push(Buffer.from(value));
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
      return result;
    } catch {
      reader?.cancel().catch(() => {});
      fail('invalid_response', 'OpenAI 登录响应无效、过大或读取超时。', 502);
    } finally { clearTimeout(timer); this.#bodyReaders.delete(reader); }
  }

  async #getDiscovery() {
    if (this.#discovery) return this.#discovery;
    const response = await this.#request(DISCOVERY_URL, { headers: { accept: 'application/json' } });
    if (!response.ok) fail('discovery_failed', '无法读取 OpenAI 登录配置。', 502);
    const document = await this.#json(response);
    if (document.issuer !== OPENAI_ISSUER || !document.id_token_signing_alg_values_supported?.includes('RS256')) fail('invalid_discovery', 'OpenAI 登录发行者或签名配置无效。', 502);
    this.#discovery = {
      issuer: document.issuer, token_endpoint: safeEndpoint(document.token_endpoint),
      jwks_uri: safeEndpoint(document.jwks_uri), revocation_endpoint: safeEndpoint(document.revocation_endpoint),
    };
    return this.#discovery;
  }

  async #getKeys(force = false) {
    if (!force && this.#jwks?.expiresAt > this.#now()) return this.#jwks.keys;
    const configuration = await this.#getDiscovery();
    const response = await this.#request(configuration.jwks_uri, { headers: { accept: 'application/json' } });
    if (!response.ok) fail('jwks_failed', '无法读取 OpenAI 签名公钥。', 502);
    const data = await this.#json(response);
    if (!Array.isArray(data.keys) || data.keys.length > 100) fail('invalid_jwks', 'OpenAI 签名公钥无效。', 502);
    this.#jwks = { keys: data.keys, expiresAt: this.#now() + 5 * 60_000 };
    return data.keys;
  }

  async #verifyIdentity(idToken, clientId, { nonce, allowMissingNonce = false, allowExpired = false, accessToken } = {}) {
    if (typeof idToken !== 'string' || idToken.length > 24_000) fail('invalid_id_token', '缺少有效身份令牌。');
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) fail('invalid_id_token', '身份令牌格式无效。');
    let header; let claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); }
    catch { fail('invalid_id_token', '身份令牌格式无效。'); }
    if (!header || !claims || header.alg !== 'RS256' || !text(header.kid) || header.crit !== undefined) fail('invalid_signature', '身份令牌签名算法不受支持。');
    const matching = keys => keys.filter(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256') && (!key.key_ops || key.key_ops.includes('verify')));
    let keys = matching(await this.#getKeys());
    if (keys.length === 0) keys = matching(await this.#getKeys(true));
    if (keys.length !== 1) fail('invalid_signature', '身份令牌签名公钥不匹配。');
    try {
      const key = createPublicKey({ key: keys[0], format: 'jwk' });
      if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new Error();
    } catch { fail('invalid_signature', '身份令牌签名校验失败。'); }
    if (claims.iss !== OPENAI_ISSUER) fail('invalid_issuer', '身份令牌发行者不匹配。');
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (!Array.isArray(audiences) || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId)) fail('invalid_audience', '身份令牌不属于本应用注册。');
    const nowSeconds = Math.floor(this.#now() / 1000);
    if (!Number.isSafeInteger(claims.exp) || (!allowExpired && claims.exp <= nowSeconds - 5)) fail('expired_id_token', '身份令牌已过期。');
    if (!Number.isSafeInteger(claims.iat) || claims.iat > nowSeconds + 5 || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > nowSeconds + 5))) fail('invalid_token_time', '身份令牌时间无效。');
    if (!text(claims.sub) || !claims.sub) fail('invalid_subject', '身份令牌缺少账户身份。');
    if (!(allowMissingNonce && claims.nonce === undefined) && !equal(claims.nonce, nonce)) fail('invalid_nonce', '身份令牌与本次登录请求不匹配。');
    if (claims.at_hash !== undefined && accessToken) {
      const hash = createHash('sha256').update(accessToken).digest().subarray(0, 16).toString('base64url');
      if (!equal(claims.at_hash, hash)) fail('invalid_token_hash', '访问令牌与身份令牌不匹配。');
    }
    return claims;
  }

  async #tokenRequest(endpoint, fields) {
    const response = await this.#request(endpoint, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    const data = await this.#json(response);
    if (!response.ok) {
      const code = typeof data.error === 'string' ? data.error : data.error?.code;
      const known = TERMINAL_REFRESH_ERRORS.has(code) || code === 'invalid_client';
      const error = new OAuthError(known ? code : 'token_exchange_failed', 'OpenAI 未能完成令牌交换；请重试或重新登录。', 502);
      error.upstreamStatus = response.status;
      throw error;
    }
    return data;
  }

  #buildRecord(tokens, account, nonce, previous = null) {
    if (!text(tokens.access_token, 24_000) || !tokens.access_token || String(tokens.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || tokens.expires_in > 31_536_000) fail('invalid_token_response', '访问令牌或有效期无效。');
    const scope = tokens.scope === undefined && previous ? previous.scopes.join(' ') : tokens.scope;
    if (typeof scope !== 'string' || scope.length > 4096) fail('invalid_scope', 'OpenAI 未返回有效权限范围。');
    const scopes = [...new Set(scope.split(/\s+/).filter(Boolean))];
    const refreshToken = tokens.refresh_token;
    if (scopes.includes('offline_access') && (!text(refreshToken, 24_000) || !refreshToken)) fail('missing_refresh_token', 'OpenAI 未返回可续期会话令牌。');
    const earliest = typeof tokens.earliest_refresh_at === 'number' ? tokens.earliest_refresh_at * 1000 : Date.parse(tokens.earliest_refresh_at);
    return { version: 1, account, hostId: this.#meta.hostId, accessToken: tokens.access_token,
      refreshToken: refreshToken || null, idToken: tokens.id_token || previous?.idToken, nonce,
      tokenType: 'Bearer', scopes, expiresAt: this.#now() + tokens.expires_in * 1000,
      earliestRefreshAt: Number.isFinite(earliest) ? earliest : null };
  }

  async getAccessToken({ forceRefresh = false } = {}) {
    this.#assertReady();
    if (this.#signingOut || !this.#record) fail('not_connected', '请先使用 ChatGPT 登录。', 401);
    if (!this.status().planEnabled) fail('plan_permission_required', '本账户尚未允许使用 ChatGPT 订阅额度。', 403);
    if (this.#callbackBusy || this.#starting) fail('auth_busy', '账户授权正在更新，请稍后重试。', 409);
    if (!forceRefresh && this.#record.expiresAt > this.#now() + 60_000) return this.#record.accessToken;
    if (this.#record.earliestRefreshAt > this.#now()) {
      if (!forceRefresh && this.#record.expiresAt > this.#now() + 5_000) return this.#record.accessToken;
      fail('refresh_not_yet_allowed', '会话暂时不能刷新，请稍后重试。', 429);
    }
    if (!this.#refresh) {
      this.#refresh = this.#refreshSession().finally(() => { this.#refresh = null; });
    }
    await this.#refresh;
    if (!this.#record || this.#signingOut || this.#closed) fail('not_connected', '登录会话已结束。', 401);
    if (!this.status().planEnabled) fail('plan_permission_required', 'ChatGPT 订阅额度权限已变更。', 403);
    return this.#record.accessToken;
  }

  async #refreshSession() {
    const previous = this.#record;
    const epoch = this.#epoch;
    if (!previous.refreshToken) fail('sign_in_required', '当前会话无法续期，请重新登录。', 401);
    try {
      const configuration = await this.#getDiscovery();
      const tokens = await this.#tokenRequest(configuration.token_endpoint, { grant_type: 'refresh_token', client_id: previous.account.clientId, refresh_token: previous.refreshToken, resource: OPENAI_RESOURCE });
      if (tokens.id_token) {
        const identity = await this.#verifyIdentity(tokens.id_token, previous.account.clientId, { nonce: previous.nonce, allowMissingNonce: true, accessToken: tokens.access_token });
        if (identity.sub !== previous.account.subject) fail('account_mismatch', '续期返回了不同的账户身份。');
      }
      const next = this.#buildRecord(tokens, previous.account, previous.nonce, previous);
      if (epoch !== this.#epoch || this.#closed) fail('cancelled', '会话续期已取消。');
      // Preserve a rotated replacement in memory if a persistent write fails.
      // Retrying the old refresh token could invalidate the renewable session.
      this.#record = next;
      try { await this.#sessionStore.save(next); }
      catch {
        this.#warning = '会话已续期，但最新凭据保存失败；本次运行仍可使用，重启后可能需要重新登录。';
        fail('credential_save_failed', '会话已续期，但凭据保存失败，请检查本机安全存储。', 500);
      }
      if (epoch !== this.#epoch || this.#closed) {
        this.#record = null;
        fail('cancelled', '会话续期已取消。');
      }
    } catch (error) {
      if (TERMINAL_REFRESH_ERRORS.has(error.code) || error.code === 'account_mismatch') {
        this.#record = null;
        this.#epoch += 1;
        await this.#sessionStore.clear();
      }
      throw error;
    }
  }

  /** Only call after a user explicitly chooses to read this app's saved Keychain session. */
  async resume({ consent = false } = {}) {
    this.#assertReady();
    if (consent !== true || !this.#persistentStore) fail('persistence_consent_required', '请先明确同意读取本应用保存的 Keychain 会话。');
    if (this.#record || this.#callbackBusy || this.#starting || this.#signingOut) fail('auth_busy', '当前已有会话或登录正在进行。', 409);
    this.#starting = true;
    const epoch = this.#epoch;
    try {
      await this.#acquireLockAndHost();
      const record = await this.#persistentStore.load();
      if (!record) return this.status();
      const saved = this.#meta.registrations.find(item => item.clientId === record.account?.clientId);
      if (!saved?.subject || record.hostId !== this.#meta.hostId || saved.subject !== record.account.subject || !Array.isArray(record.scopes) || record.scopes.some(item => typeof item !== 'string') || !text(record.accessToken, 24_000) || !Number.isFinite(record.expiresAt)) fail('invalid_saved_session', '保存的会话与本应用注册不匹配，请重新登录。');
      const identity = await this.#verifyIdentity(record.idToken, saved.clientId, { nonce: record.nonce, allowMissingNonce: true, allowExpired: true });
      if (identity.sub !== saved.subject) fail('account_mismatch', '保存会话的身份不匹配。');
      if (epoch !== this.#epoch || this.#closed) fail('cancelled', '会话恢复已取消。');
      this.#record = { ...record, account: saved };
      this.#sessionStore = this.#persistentStore;
      this.#meta.selectedClientId = saved.clientId;
      this.#epoch += 1;
      return this.status();
    } finally { this.#starting = false; }
  }

  async logout() {
    this.#assertReady();
    if (this.#signingOut || this.#callbackBusy || this.#starting) fail('auth_busy', '账户状态正在更新，请稍后再试。', 409);
    this.#signingOut = true;
    this.#pending = null;
    let revocationConfirmed = false;
    let localCleared = true;
    try {
      // Wait for a rotating refresh to finish, then revoke its latest replacement.
      await this.#refresh?.catch(() => {});
      const record = this.#record;
      if (record?.refreshToken) {
        try {
          const configuration = await this.#getDiscovery();
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const response = await this.#request(configuration.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: record.refreshToken, token_type_hint: 'refresh_token', client_id: record.account.clientId }) });
              if (response.status === 200) { revocationConfirmed = true; break; }
              if (response.status < 500) break;
            } catch { /* Retry bounded network failures without exposing the token. */ }
            if (attempt < 2) await delay(150 * 2 ** attempt);
          }
        } catch { /* Local logout still proceeds if discovery is unavailable. */ }
      } else { revocationConfirmed = !record; }
      this.#record = null;
      this.#epoch += 1;
      try { await this.#sessionStore.clear(); } catch { localCleared = false; }
      this.#sessionStore = this.#memoryStore;
      this.#warning = !localCleared ? '本地内存会话已退出，但 Keychain 清除未确认。请在 ChatGPT 设置中撤销此应用，并检查本应用钥匙串条目。' : !revocationConfirmed ? '已退出本地会话；远程撤销未确认，请在 ChatGPT 设置中断开此应用。' : null;
      return { ...this.status(), revocationConfirmed, localCleared, warning: this.#warning };
    } finally { this.#signingOut = false; }
  }

  async close() {
    this.#closed = true;
    this.#epoch += 1;
    this.#pending = null;
    this.#record = null;
    for (const controller of this.#requestControllers) controller.abort();
    for (const reader of this.#bodyReaders) reader.cancel().catch(() => {});
    await this.#refresh?.catch(() => {});
    await this.#memoryStore.close();
    // Closing the app is not sign-out: an explicitly persisted session remains in Keychain.
    if (this.#persistentStore) await this.#persistentStore.close();
    if (this.#lock) {
      await this.#lock.close(); this.#lock = null;
      await unlink(path.join(this.#dataDir, 'oauth-session.lock')).catch(() => {});
    }
  }
}
