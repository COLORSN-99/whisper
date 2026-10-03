import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { OAuthManager, OPENAI_ISSUER, OAUTH_SCOPES } from '../server/oauth.mjs';
import { MemoryTokenStore, MacOSKeychainTokenStore } from '../server/token-store.mjs';

// Synthetic tokens signed with an ephemeral test-only RSA key. No network or Keychain IO.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'offline-test-key', use: 'sig', alg: 'RS256' };
const redirectUri = 'http://127.0.0.1:4783/auth/callback';
const clientId = 'oaiapp_whisper_test';
const discovery = {
  issuer: OPENAI_ISSUER, token_endpoint: `${OPENAI_ISSUER}/api/accounts/oauth/token`,
  authorization_endpoint: `${OPENAI_ISSUER}/api/accounts/authorize`,
  revocation_endpoint: `${OPENAI_ISSUER}/api/accounts/oauth/revoke`,
  jwks_uri: `${OPENAI_ISSUER}/.well-known/jwks.json`, id_token_signing_alg_values_supported: ['RS256'],
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function jwt(payload, headerOverrides = {}) {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, ...headerOverrides })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}

async function fixture(t, { store } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'whisper-oauth-test-'));
  const dataDir = path.join(root, 'data');
  const state = { now: Date.now(), auth: null, claims: {}, headers: {}, tokenOverrides: {}, tokenCalls: [], fetches: [], refreshCalls: 0, revocations: [], discovery, tokenError: null, revokeStatus: 200, delayRefresh: false, mutateJWT: x => x };
  const fetchImpl = async (url, init = {}) => {
    state.fetches.push(String(url));
    assert.equal(new URL(url).origin, OPENAI_ISSUER, 'all requests stay on the official auth origin');
    assert.equal(init.redirect, 'error');
    if (url === `${OPENAI_ISSUER}/.well-known/openid-configuration`) return json(state.discovery);
    if (url === discovery.jwks_uri) {
      await state.jwksHook?.();
      return json({ keys: [jwk] });
    }
    if (url === discovery.revocation_endpoint) {
      state.revocations.push(Object.fromEntries(init.body));
      if (state.revokeStatus === 'network') throw new Error('synthetic network failure');
      return new Response('', { status: state.revokeStatus });
    }
    assert.equal(url, discovery.token_endpoint);
    const fields = Object.fromEntries(init.body);
    state.tokenCalls.push(fields);
    if (state.tokenError) return json({ error: state.tokenError }, 400);
    const refresh = fields.grant_type === 'refresh_token';
    if (refresh) {
      state.refreshCalls += 1;
      if (state.delayRefresh) await new Promise(resolve => setTimeout(resolve, 25));
    }
    const payload = {
      iss: OPENAI_ISSUER, aud: fields.client_id, sub: 'test-subject-a', email: 'synthetic@example.invalid',
      iat: Math.floor(state.now / 1000), exp: Math.floor(state.now / 1000) + 3600,
      ...(refresh ? {} : { nonce: state.auth.searchParams.get('nonce') }), ...state.claims,
    };
    const n = state.tokenCalls.length;
    return json({ id_token: state.mutateJWT(jwt(payload, state.headers)), token_type: 'Bearer',
      access_token: `SYNTHETIC-access-${n}`, refresh_token: `SYNTHETIC-refresh-${n}`,
      expires_in: 3600, scope: OAUTH_SCOPES.join(' '), ...state.tokenOverrides });
  };
  const manager = new OAuthManager({ dataDir, redirectUri, fetchImpl, store, now: () => state.now });
  await manager.init();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const start = async (options = {}) => {
    const result = await manager.begin({ consent: true, ...options });
    state.auth = new URL(result.url);
    return result;
  };
  const callback = (parameters = {}) => {
    const url = new URL(redirectUri);
    url.search = new URLSearchParams({ state: state.auth.searchParams.get('state'), code: 'SYNTHETIC-code', client_id: clientId, ...parameters });
    return manager.callback(url);
  };
  const login = async (options = {}) => { await start(options); return callback(); };
  return { manager, state, dataDir, root, start, callback, login, fetchImpl };
}

test('init/status perform no network, token IO, directory creation or host generation', async t => {
  const h = await fixture(t);
  assert.equal(h.manager.status().connected, false);
  assert.deepEqual(h.state.fetches, []);
  await assert.rejects(stat(h.dataDir), { code: 'ENOENT' });
  await assert.rejects(h.manager.begin(), { code: 'consent_required' });
  await assert.rejects(stat(h.dataDir), { code: 'ENOENT' });
});

test('authorization uses first-time client, stable host, one-time state/nonce and PKCE S256', async t => {
  const h = await fixture(t);
  await h.start();
  const first = h.state.auth;
  assert.equal(first.origin, OPENAI_ISSUER);
  assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.searchParams.get('agent_name_hint'), 'Whisper');
  assert.equal(first.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(first.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.equal(first.searchParams.get('code_challenge_method'), 'S256');
  assert.match(first.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  await h.callback();
  const exchanged = h.state.tokenCalls[0];
  assert.equal(exchanged.client_id, clientId);
  assert.equal(exchanged.redirect_uri, redirectUri);
  assert.equal(createHash('sha256').update(exchanged.code_verifier).digest('base64url'), first.searchParams.get('code_challenge'));
  assert.equal('client_secret' in exchanged, false);
  await h.start();
  assert.equal(h.state.auth.searchParams.get('client_id'), clientId);
  assert.equal(h.state.auth.searchParams.has('agent_name_hint'), false);
  assert.equal(h.state.auth.searchParams.has('id_token_hint'), false);
  assert.equal(h.state.auth.searchParams.get('ext_agent_host_id'), first.searchParams.get('ext_agent_host_id'));
  assert.notEqual(h.state.auth.searchParams.get('state'), first.searchParams.get('state'));
  assert.notEqual(h.state.auth.searchParams.get('nonce'), first.searchParams.get('nonce'));
});

test('valid signed login exposes only safe metadata and keeps tokens off disk', async t => {
  const h = await fixture(t);
  const status = await h.login();
  assert.equal(status.connected, true);
  assert.equal(status.planEnabled, true);
  assert.equal(status.persistence, 'memory');
  assert.equal(status.account.subject, 'test-subject-a');
  assert.equal(await h.manager.getAccessToken(), 'SYNTHETIC-access-1');
  assert.doesNotMatch(JSON.stringify(status), /SYNTHETIC|idToken|refreshToken|nonce|verifier/);
  assert.deepEqual((await readdir(h.dataDir)).sort(), ['oauth-metadata.json', 'oauth-session.lock']);
  const metadata = await readFile(path.join(h.dataDir, 'oauth-metadata.json'), 'utf8');
  assert.doesNotMatch(metadata, /SYNTHETIC|idToken|refreshToken|nonce|verifier/);
  assert.equal((await stat(path.join(h.dataDir, 'oauth-metadata.json'))).mode & 0o777, 0o600);
});

test('rejects missing, mismatched, expired and reused state before token exchange', async t => {
  const h = await fixture(t);
  await h.start();
  await assert.rejects(h.callback({ state: 'wrong' }), { code: 'invalid_state' });
  assert.equal(h.state.tokenCalls.length, 0);
  assert.equal(h.manager.status().pending, true);
  await h.callback();
  await assert.rejects(h.callback(), { code: 'invalid_state' });
  await h.start();
  h.state.now += 11 * 60_000;
  await assert.rejects(h.callback(), { code: 'invalid_state' });
  await h.start();
  await h.callback();
  await assert.rejects(h.callback(), { code: 'invalid_state' });
});

test('denied authorization validates state and never exchanges a code', async t => {
  const h = await fixture(t);
  await h.start();
  await assert.rejects(h.callback({ error: 'access_denied' }), { code: 'authorization_denied' });
  assert.equal(h.state.tokenCalls.length, 0);
  assert.equal(h.manager.status().pending, false);
});

test('callback rejects wrong origin/path, duplicate parameters, and missing issued client', async t => {
  const h = await fixture(t);
  await h.start();
  const url = new URL('http://localhost:4783/auth/callback');
  url.searchParams.set('state', h.state.auth.searchParams.get('state'));
  await assert.rejects(h.manager.callback(url), { code: 'invalid_callback' });
  await h.start();
  await assert.rejects(h.manager.callback(`${redirectUri}?state=a&state=b`), { code: 'invalid_callback' });
  await h.start();
  await assert.rejects(h.callback({ client_id: '' }), { code: 'missing_client_id' });
});

for (const [name, patch, code] of [
  ['nonce', { nonce: 'wrong-nonce' }, 'invalid_nonce'],
  ['audience', { aud: 'oaiapp_other' }, 'invalid_audience'],
  ['multiple audiences without azp', { aud: [clientId, 'other'] }, 'invalid_audience'],
  ['issuer', { iss: 'https://attacker.invalid' }, 'invalid_issuer'],
  ['expiration', { exp: 1 }, 'expired_id_token'],
  ['subject', { sub: '' }, 'invalid_subject'],
  ['issued time', { iat: 9_999_999_999 }, 'invalid_token_time'],
  ['not-before time', { nbf: 9_999_999_999 }, 'invalid_token_time'],
  ['access token hash', { at_hash: 'wrong-hash' }, 'invalid_token_hash'],
]) {
  test(`rejects signed ID token with invalid ${name}`, async t => {
    const h = await fixture(t);
    h.state.claims = patch;
    await assert.rejects(h.login(), { code });
    assert.equal(h.manager.status().connected, false);
  });
}

test('rejects signature tampering and unsupported algorithms', async t => {
  const h = await fixture(t);
  h.state.mutateJWT = value => value.slice(0, value.lastIndexOf('.') + 1) + Buffer.alloc(256).toString('base64url');
  await assert.rejects(h.login(), { code: 'invalid_signature' });
  h.state.mutateJWT = value => value;
  h.state.headers = { alg: 'HS256' };
  await assert.rejects(h.login(), { code: 'invalid_signature' });
});

test('discovery refuses credential endpoints on foreign origins', async t => {
  const h = await fixture(t);
  h.state.discovery = { ...discovery, token_endpoint: 'https://attacker.invalid/token' };
  await assert.rejects(h.login(), { code: 'invalid_discovery' });
  assert.equal(h.state.tokenCalls.length, 0);
});

test('granted scope controls inference even when callback claims full scope', async t => {
  const h = await fixture(t);
  h.state.tokenOverrides.scope = 'openid profile email';
  const status = await h.login();
  assert.equal(status.connected, true);
  assert.equal(status.planEnabled, false);
  await assert.rejects(h.manager.getAccessToken(), { code: 'plan_permission_required' });
});

test('reauthorization rejects changed client and subject without replacing active credentials', async t => {
  const h = await fixture(t);
  await h.login();
  await h.start();
  await assert.rejects(h.callback({ client_id: 'oaiapp_other' }), { code: 'client_mismatch' });
  assert.equal(await h.manager.getAccessToken(), 'SYNTHETIC-access-1');
  h.state.claims = { sub: 'test-subject-b' };
  await h.start();
  await assert.rejects(h.callback(), { code: 'account_mismatch' });
  assert.equal(h.manager.status().account.subject, 'test-subject-a');
  assert.equal(await h.manager.getAccessToken(), 'SYNTHETIC-access-1');
});

test('retains issued registration after expired code and reuses it on retry', async t => {
  const h = await fixture(t);
  h.state.tokenError = 'invalid_grant';
  await assert.rejects(h.login(), { code: 'invalid_grant' });
  await h.start();
  assert.equal(h.state.auth.searchParams.get('client_id'), clientId);
  assert.equal(h.state.auth.searchParams.has('agent_name_hint'), false);
  h.state.tokenError = null;
  await h.callback({ client_id: '' });
  assert.equal(h.manager.status().connected, true);
});

test('refresh is serialized and atomically rotates tokens without scope parameter', async t => {
  const h = await fixture(t);
  await h.login();
  h.state.now += 3_550_000;
  h.state.delayRefresh = true;
  const tokens = await Promise.all(Array.from({ length: 8 }, () => h.manager.getAccessToken()));
  assert.deepEqual(new Set(tokens), new Set(['SYNTHETIC-access-2']));
  assert.equal(h.state.refreshCalls, 1);
  assert.equal(h.state.tokenCalls[1].refresh_token, 'SYNTHETIC-refresh-1');
  assert.equal(h.state.tokenCalls[1].client_id, clientId);
  assert.equal('scope' in h.state.tokenCalls[1], false);
  await h.manager.getAccessToken({ forceRefresh: true });
  assert.equal(h.state.tokenCalls[2].refresh_token, 'SYNTHETIC-refresh-2');
});

test('terminal refresh failure clears tokens but keeps registration for reauthorization', async t => {
  const h = await fixture(t);
  await h.login();
  h.state.tokenError = 'refresh_token_reused';
  await assert.rejects(h.manager.getAccessToken({ forceRefresh: true }), { code: 'refresh_token_reused' });
  assert.equal(h.manager.status().connected, false);
  await h.start();
  assert.equal(h.state.auth.searchParams.get('client_id'), clientId);
});

test('temporary refresh errors retain credentials and never silently change billing', async t => {
  const h = await fixture(t);
  await h.login();
  h.state.tokenError = 'temporary_failure';
  await assert.rejects(h.manager.getAccessToken({ forceRefresh: true }), { code: 'token_exchange_failed' });
  assert.equal(h.manager.status().connected, true);
  assert.equal(await h.manager.getAccessToken(), 'SYNTHETIC-access-1');
});

function fakePersistentStore() {
  return { persistent: true, record: null, saves: 0, clears: 0,
    async load() { return structuredClone(this.record); },
    async save(record) { this.saves++; this.record = structuredClone(record); },
    async clear() { this.clears++; this.record = null; },
    async close() {},
  };
}

test('metadata commit failure never orphans a new Keychain record', async t => {
  const store = fakePersistentStore();
  const h = await fixture(t, { store });
  h.state.jwksHook = async () => {
    const file = path.join(h.dataDir, 'oauth-metadata.json');
    await rm(file);
    await mkdir(file); // Simulate final atomic rename failure after the code exchange.
  };
  await assert.rejects(h.login({ persist: true, persistenceConsent: true }), { code: 'storage_failed' });
  assert.equal(store.saves, 0);
  assert.equal(store.record, null);
  const loggedOut = await h.manager.logout();
  assert.equal(loggedOut.connected, false);
  assert.equal(loggedOut.localCleared, true);
});

test('uncertain initial persistent save remains manageable and logout clears it', async t => {
  const store = fakePersistentStore();
  const save = store.save.bind(store);
  store.save = async record => { await save(record); throw new Error('simulated lost helper response'); };
  const h = await fixture(t, { store });
  await assert.rejects(h.login({ persist: true, persistenceConsent: true }), { code: 'credential_save_failed' });
  assert.equal(h.manager.status().connected, true);
  assert.match(h.manager.status().warning, /保存未确认/);
  const result = await h.manager.logout();
  assert.equal(result.localCleared, true);
  assert.equal(store.record, null);
  assert.equal(store.clears, 1);
  assert.equal(h.state.revocations[0].token, 'SYNTHETIC-refresh-1');
});

test('failed rotation persistence retains latest replacement instead of retrying spent token', async t => {
  const store = fakePersistentStore();
  const h = await fixture(t, { store });
  await h.login({ persist: true, persistenceConsent: true });
  const save = store.save.bind(store);
  store.save = async () => { throw new Error('simulated persistence unavailable'); };
  await assert.rejects(h.manager.getAccessToken({ forceRefresh: true }), { code: 'credential_save_failed' });
  assert.equal(await h.manager.getAccessToken(), 'SYNTHETIC-access-2');
  store.save = save;
  await h.manager.getAccessToken({ forceRefresh: true });
  assert.equal(h.state.tokenCalls[2].refresh_token, 'SYNTHETIC-refresh-2');
});

test('closing during persisted-session identity validation cannot resurrect authentication', async t => {
  const store = fakePersistentStore();
  const h = await fixture(t, { store });
  await h.login({ persist: true, persistenceConsent: true });
  await h.manager.close();
  const second = new OAuthManager({ dataDir: h.dataDir, redirectUri, fetchImpl: h.fetchImpl, store, now: () => h.state.now });
  await second.init();
  t.after(() => second.close());
  let release;
  let reached;
  const reachedKeys = new Promise(resolve => { reached = resolve; });
  h.state.jwksHook = async () => { reached(); await new Promise(resolve => { release = resolve; }); };
  const resuming = second.resume({ consent: true });
  await reachedKeys;
  await second.close();
  release();
  await assert.rejects(resuming, { code: 'cancelled' });
  assert.equal(second.status().connected, false);
});

test('logout waits for a rotating refresh, revokes latest replacement, retains account mapping', async t => {
  const h = await fixture(t);
  await h.login();
  h.state.delayRefresh = true;
  const refresh = h.manager.getAccessToken({ forceRefresh: true });
  const refreshRejected = assert.rejects(refresh, { code: 'not_connected' });
  const result = await h.manager.logout();
  await refreshRejected;
  assert.equal(result.connected, false);
  assert.equal(result.revocationConfirmed, true);
  assert.equal(h.state.revocations[0].token, 'SYNTHETIC-refresh-2');
  await assert.rejects(h.manager.getAccessToken(), { code: 'not_connected' });
  await h.start();
  assert.equal(h.state.auth.searchParams.get('client_id'), clientId);
});

test('unconfirmed remote logout is visible and local credentials are still removed', async t => {
  const h = await fixture(t);
  await h.login();
  h.state.revokeStatus = 503;
  const result = await h.manager.logout();
  assert.equal(result.revocationConfirmed, false);
  assert.equal(result.connected, false);
  assert.match(result.warning, /远程撤销未确认/);
  assert.equal(h.state.revocations.length, 3);
});

test('persistent storage requires separate consent and is never loaded by init', async t => {
  const store = new MemoryTokenStore();
  store.persistent = true;
  const originalLoad = store.load.bind(store);
  let reads = 0;
  store.load = async () => { reads++; return originalLoad(); };
  const h = await fixture(t, { store });
  assert.equal(reads, 0);
  await assert.rejects(h.start({ persist: true }), { code: 'persistence_consent_required' });
  await h.login({ persist: true, persistenceConsent: true });
  assert.equal(h.manager.status().persistence, 'keychain');
  assert.equal((await originalLoad()).accessToken, 'SYNTHETIC-access-1');
  assert.equal(reads, 0);
  await h.manager.logout();
  assert.equal(await originalLoad(), null);
});

test('two runtimes cannot rotate one persisted session simultaneously', async t => {
  const h = await fixture(t);
  await h.start();
  const second = new OAuthManager({ dataDir: h.dataDir, redirectUri, fetchImpl: h.fetchImpl });
  await second.init();
  t.after(() => second.close());
  await assert.rejects(second.begin({ consent: true }), { code: 'session_locked' });
});

test('only an explicit 127.0.0.1 loopback callback is accepted', () => {
  for (const uri of ['http://localhost:4783/auth/callback', 'http://0.0.0.0:4783/auth/callback', 'https://example.com/auth/callback', 'http://127.0.0.1:4783/callback']) {
    assert.throws(() => new OAuthManager({ dataDir: '/tmp/test-unused', redirectUri: uri }), { code: 'invalid_redirect' });
  }
});

test('metadata symlinks are refused', async t => {
  const h = await fixture(t);
  await h.start();
  await h.manager.close();
  await rm(path.join(h.dataDir, 'oauth-metadata.json'));
  await symlink('/dev/null', path.join(h.dataDir, 'oauth-metadata.json'));
  const second = new OAuthManager({ dataDir: h.dataDir, redirectUri, fetchImpl: h.fetchImpl });
  await assert.rejects(second.init(), { code: 'invalid_storage' });
});

test('Keychain adapter passes secrets only through stdin, with isolated service and no shell', async () => {
  let call;
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    let body = '';
    child.stdin = new Writable({ write(chunk, encoding, callback) { body += chunk.toString(); callback(); }, final(callback) {
      call = { file, args, options, request: JSON.parse(body) };
      queueMicrotask(() => { child.stdout.write('{"ok":true}'); child.emit('close', 0); });
      callback();
    } });
    return child;
  };
  const store = new MacOSKeychainTokenStore({ helperPath: '/tmp/never-executed-test-helper', spawnImpl });
  assert.equal(call, undefined);
  await store.save({ token: 'SYNTHETIC-only-in-stdin' });
  assert.deepEqual(call.args, []);
  assert.equal(call.options.shell, false);
  assert.equal(call.request.service, 'com.whisper.oauth');
  assert.equal(call.request.record.token, 'SYNTHETIC-only-in-stdin');
  assert.doesNotMatch(JSON.stringify(call.options), /SYNTHETIC/);
  await store.close();
});
