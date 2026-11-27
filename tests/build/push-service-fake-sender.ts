// 推送替身自测用的“发送方”最小实现（push-service-fake*.test.ts 共用）：签 VAPID JWT、按 RFC 8291 加密一条记录。
// 只为喂替身，正式实现由后端写在 supabase/functions。HKDF 这里用 Web Crypto 的，替身那边是手写 HMAC，两种写法互相核对
import { afterEach } from 'vitest';
import { b64u, createFakePush, type FakePushService, type PushSubscriber, unb64u } from '../fakes/push-service.ts';

const te = new TextEncoder();

/** 建替身并在每条用例后关掉 */
export function fakeFactory() {
  const live: FakePushService[] = [];
  afterEach(async () => {
    await Promise.all(live.splice(0).map((f) => f.close()));
  });
  return (...a: Parameters<typeof createFakePush>): FakePushService => {
    const f = createFakePush(...a);
    live.push(f);
    return f;
  };
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, n: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, n * 8));
}

export function cat(...p: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) {
    o.set(x, i);
    i += x.length;
  }
  return o;
}

/** aes128gcm 单条记录：salt(16) ‖ rs = 4096 ‖ idlen = 65 ‖ 发送方公钥 ‖ 密文 */
export async function encrypt(sub: PushSubscriber, text: string): Promise<Uint8Array<ArrayBuffer>> {
  const as = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', unb64u(sub.p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(unb64u(sub.auth), ecdh, cat(te.encode('WebPush: info\0'), unb64u(sub.p256dh), asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, cat(te.encode(text), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0, 65]), asPub, ct);
}

export async function vapidKey() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { priv: kp.privateKey, pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}

export async function vapidHeader(k: { priv: CryptoKey; pub: string }, claims: Record<string, unknown>, head: Record<string, unknown> = { typ: 'JWT', alg: 'ES256' }): Promise<string> {
  const h = b64u(te.encode(JSON.stringify(head)));
  const p = b64u(te.encode(JSON.stringify(claims)));
  const s = b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.priv, te.encode(`${h}.${p}`)));
  return `vapid t=${h}.${p}.${s}, k=${k.pub}`;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

/** 真推送服务要的请求头：Authorization、TTL、Content-Encoding、Content-Type */
export const pushHeaders = (authorization: string, over: Record<string, string> = {}) => ({
  authorization,
  ttl: '60',
  'content-encoding': 'aes128gcm',
  'content-type': 'application/octet-stream',
  ...over,
});
