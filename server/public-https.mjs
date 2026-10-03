import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { checkServerIdentity } from 'node:tls';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked.addSubnet(address, prefix, 'ipv4');
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
// Reject special-purpose/transition ranges as well as non-global IPv6.
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 &&
    globalIPv6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

const cancelled = () => new DOMException('模型连接已取消或超时。', 'AbortError');
const transportError = () => new Error('兼容模型的安全 HTTPS 连接失败。请检查供应商地址与证书。');

function endpointURL(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('请输入有效的 HTTPS API 地址。'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.port && url.port !== '443' || isIP(hostname.replace(/^\[|\]$/g, '')) ||
      !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
      /(^|\.)(localhost|local|internal|openai\.com|chatgpt\.com)$/.test(hostname)) {
    throw new Error('其他厂商仅支持公开 HTTPS 域名；OpenAI 请使用官方 ChatGPT 登录。');
  }
  url.hostname = hostname;
  return url;
}

async function resolveEndpoint(baseUrl, lookupImpl, signal) {
  const url = endpointURL(baseUrl);
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  const addresses = await new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    if (bounded.aborted) return onAbort();
    bounded.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => lookupImpl(url.hostname, { all: true })).then(resolve, () => reject(transportError()))
      .finally(() => bounded.removeEventListener('abort', onAbort));
  });
  if (bounded.aborted) throw cancelled();
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !item || !isPublicAddress(item.address))) {
    throw new Error('API 地址不能指向本地、私有或保留网络。');
  }
  // Copy only the verified primitive; never retain a resolver-owned mutable array.
  return { url, address: addresses[0].address, family: isIP(addresses[0].address) };
}

export async function validateEndpoint(baseUrl, lookupImpl = lookup) {
  return (await resolveEndpoint(baseUrl, lookupImpl)).url.href.replace(/\/+$/, '');
}

/** One POST, one verified address, no proxy/connection pool/redirect/retry. */
export async function postPublicHTTPS(baseUrl, { authorization, body, signal, lookupImpl = lookup, requestImpl = request } = {}) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
  const { url, address, family } = await resolveEndpoint(baseUrl, lookupImpl, signal);
  if (signal?.aborted) throw cancelled();
  return new Promise((resolve, reject) => {
    let req, res, reader, controller;
    let stopped = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const stop = () => {
      if (stopped) return;
      stopped = true; cleanup(); req?.destroy(); res?.destroy();
      void reader?.cancel().catch(() => {});
    };
    const fail = error => {
      if (stopped) return;
      controller?.error(error); reject(error); stop();
    };
    const onAbort = () => fail(cancelled());
    const pinnedLookup = (hostname, options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (hostname !== url.hostname) return callback(transportError());
      if (options?.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      req = requestImpl({
        protocol: 'https:', hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`,
        method: 'POST', agent: false, family, lookup: pinnedLookup,
        servername: url.hostname, rejectUnauthorized: true,
        checkServerIdentity: (_hostname, cert) => checkServerIdentity(url.hostname, cert),
        headers: { Host: url.hostname, Authorization: authorization, 'Content-Type': 'application/json',
          Accept: 'text/event-stream', 'Accept-Encoding': 'identity' },
      }, incoming => {
        if (stopped) { incoming.destroy(); return; }
        res = incoming;
        const status = res.statusCode;
        if (status >= 300 && status < 400) { fail(new Error('兼容模型服务返回了重定向，已拒绝跟随。')); return; }
        if (!Number.isInteger(status) || status < 200 || status > 599) { fail(transportError()); return; }
        if (status >= 400) { resolve({ ok: false, status, body: null }); stop(); return; }
        try {
          reader = Readable.toWeb(res).getReader();
          const stream = new ReadableStream({
            start(value) { controller = value; },
            async pull(value) {
              try {
                const next = await reader.read();
                if (stopped) return;
                if (next.done) { value.close(); stop(); }
                else value.enqueue(next.value);
              } catch { fail(signal?.aborted ? cancelled() : transportError()); }
            },
            cancel() { stop(); },
          });
          resolve({ ok: true, status, body: stream });
        } catch { fail(transportError()); }
      });
      req.on('error', () => fail(signal?.aborted ? cancelled() : transportError()));
      req.on('close', () => { if (!res) fail(transportError()); });
      req.on('upgrade', (_response, socket) => { socket.destroy(); fail(transportError()); });
      if (stopped) { req.destroy(); return; }
      if (signal?.aborted) { onAbort(); return; }
      req.end(body);
    } catch { fail(transportError()); }
  });
}
