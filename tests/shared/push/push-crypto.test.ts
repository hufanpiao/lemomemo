// supabase/functions/_shared/push/ece.ts、vapid.ts（B2 安全审查第三节 C-1～C-9、第四节补齐；B2 第一天派工表“RFC 8291 附录 A 固定向量单测、接收方解密往返测试”）
// 接收方解密、VAPID 核对用测试开发的替身 tests/fakes/push-service-vapid.ts（和被测代码分开写的一份，C-11；替身只保留这一份）。
// Node（vitest）和 Deno（deno task test）各跑一遍
import { describe, expect, it } from 'vitest';
import { b64uDecode, b64uEncode } from '../../../supabase/functions/_shared/b64url.ts';
import { checkKeys } from '../../../supabase/functions/_shared/push/endpoint.ts';
import { encryptPush, encryptWithFixedKeysForTest, padRecord, PAD_TIERS, PushCryptoError } from '../../../supabase/functions/_shared/push/ece.ts';
import { JWT_TTL_S, loadVapid, VapidSigner } from '../../../supabase/functions/_shared/push/vapid.ts';
import { b64u, checkVapid, decryptPayload, newPushSubscriber, unb64u } from '../../fakes/push-service-vapid.ts';
import { RFC8291 } from '../../fixtures/rfc8291-appendix-a.ts';

/** 推送服务一侧核 Authorization 头：替身的 checkVapid 再加一条“签名是 64 字节 r‖s、不是 DER”（C-7）。通过回 null，否则回原因 */
async function checkVapidHeader(header: string, origin: string, nowSec: number): Promise<string | null> {
  const r = await checkVapid(header, { audienceOk: (a) => a === origin, nowSec });
  if (!r.ok) return r.why;
  const sig = /^vapid t=[\w-]+\.[\w-]+\.([\w-]+),/.exec(header)?.[1] ?? '';
  return unb64u(sig).length === 64 ? null : 'sig_not_raw_rs';
}

/** 测试用的 VAPID 假钥匙（每次现生成，用完即丢；不是任何环境的真钥匙）：VAPID_PRIVATE_KEY 的 JWK 串和 VAPID_PUBLIC_KEY */
async function fakeVapidEnv(): Promise<{ priv: string; pub: string; jwk: { d: string; x: string; y: string } }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  const j = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const jwk = { d: j.d ?? '', x: j.x ?? '', y: j.y ?? '' };
  const pub = b64u(new Uint8Array([4, ...unb64u(jwk.x), ...unb64u(jwk.y)]));
  return { priv: JSON.stringify({ kty: 'EC', crv: 'P-256', ...jwk }), pub, jwk };
}

/** 从正文头读 rs、keyid（RFC 8188 2.1） */
function header(body: Uint8Array): { rs: number; keyid: Uint8Array } {
  return { rs: new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0), keyid: body.slice(21, 21 + (body[20] ?? 0)) };
}

const te = new TextEncoder();
const td = new TextDecoder();

async function rejects(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof PushCryptoError ? e.code : e instanceof Error ? e.message : String(e);
  }
  return 'resolved';
}

// RFC 8291 附录 A 的测试向量：共用模块 tests/fixtures/rfc8291-appendix-a.ts（出处、不报警的写法见那里）
const RFC = RFC8291;

describe('RFC 8291 附录 A 固定向量（C-5）', () => {
  it('附录 A 的输入逐字节得出附录里的整份正文（86 字节头 + 密文）', async () => {
    const asPub = unb64u(RFC.asPublic);
    const jwk = { d: RFC.asPrivate, x: b64u(asPub.slice(1, 33)), y: b64u(asPub.slice(33, 65)) };
    const record = new Uint8Array([...unb64u(RFC.plaintext), 2]);   // 附录 A：明文后接 0x02，不另补齐
    const out = await encryptWithFixedKeysForTest(record, unb64u(RFC.uaPublic), unb64u(RFC.auth), jwk, unb64u(RFC.salt));
    expect(out.length).toBe(86 + record.length + 16);
    expect(b64uEncode(out.slice(0, 86))).toBe(RFC.header);
    expect(b64uEncode(out.slice(86))).toBe(RFC.ciphertext);
    expect(td.decode(unb64u(RFC.plaintext))).toBe('When I grow up, I want to be a watermelon');
  });
  it('正式入口 encryptPush 不接受外部传入的临时密钥和 salt（只有三个参数）', () => {
    expect(encryptPush.length).toBe(3);
  });
});

describe('加密往返（接收方另写一份解密，C-1、C-6、C-11）', () => {
  it('解密回原文；头部 rs = 4096、idlen = 65；分隔字节 0x02', async () => {
    const sub = await newPushSubscriber();
    const k = checkKeys(sub.p256dh, sub.auth);
    if (!k.ok) throw new Error('keys');
    const payload = JSON.stringify({ kind: 'todo', id: '0b9f3c2e-1111-4222-8333-444455556666', title: '买柠檬 🍋', due_at: 1793000000000 });
    const body = await encryptPush(k.uaPublic, k.authSecret, te.encode(payload));
    expect(await decryptPayload(sub, body)).toBe(payload);
    const h = header(body);
    expect(h.rs).toBe(4096);
    expect(h.keyid.length).toBe(65);
    expect(h.keyid[0]).toBe(4);
  });
  it('C-1、C-2：同一份明文对同一个订阅加密两次，as_public 和 salt 都不一样', async () => {
    const sub = await newPushSubscriber();
    const k = checkKeys(sub.p256dh, sub.auth);
    if (!k.ok) throw new Error('keys');
    const a = await encryptPush(k.uaPublic, k.authSecret, te.encode('x'));
    const b = await encryptPush(k.uaPublic, k.authSecret, te.encode('x'));
    expect(b64uEncode(a.slice(0, 16)) === b64uEncode(b.slice(0, 16))).toBe(false);
    expect(b64uEncode(a.slice(21, 86)) === b64uEncode(b.slice(21, 86))).toBe(false);
  });
  it('C-3：p256dh 不在曲线上 → bad_keys（不抛到整轮）', async () => {
    const notOnCurve = new Uint8Array(65);
    notOnCurve.set([4]);
    notOnCurve.set([1], 64);
    expect(await rejects(encryptPush(notOnCurve, new Uint8Array(16), te.encode('x')))).toBe('bad_keys');
    expect(await rejects(encryptPush(new Uint8Array(65), new Uint8Array(16), te.encode('x')))).toBe('bad_keys');
  });
});

describe('补齐（安全审查第四节）', () => {
  it('三档 1024、2048、3072；分隔字节 0x02 后面全是 0x00，JSON 一字不差', async () => {
    expect([...PAD_TIERS]).toEqual([1024, 2048, 3072]);
    const sub = await newPushSubscriber();
    const k = checkKeys(sub.p256dh, sub.auth);
    if (!k.ok) throw new Error('keys');
    const lens: number[] = [];
    for (const n of [0, 1, 500, 1023, 1024, 2047, 2048, 3071]) {
      const json = n < 2 ? '7'.repeat(n) : JSON.stringify('x'.repeat(n - 2));   // 正好 n 字节
      const body = await encryptPush(k.uaPublic, k.authSecret, te.encode(json));
      lens.push(body.length);
      expect(await decryptPayload(sub, body)).toBe(json);
      const record = body.length - 86 - 16;
      expect(record === 1024 || record === 2048 || record === 3072).toBe(true);
      expect(body.length <= 4096).toBe(true);
    }
    expect(lens).toEqual([1126, 1126, 1126, 1126, 2150, 2150, 3174, 3174]);
  });
  it('明文 + 1 超过 3072 → payload_too_large（由 notify-text 截断标题，不加档）', () => {
    expect(padRecord(new Uint8Array(3071)).length).toBe(3072);
    let code = '';
    try {
      padRecord(new Uint8Array(3072));
    } catch (e) {
      code = e instanceof PushCryptoError ? e.code : 'other';
    }
    expect(code).toBe('payload_too_large');
  });
});

describe('VAPID 读入和自检（C-8、C-9）', () => {
  it('配对的钥匙通过；公钥逐字节和 VAPID_PUBLIC_KEY 一致', async () => {
    const v = await fakeVapidEnv();
    const r = await loadVapid(v.priv, v.pub, 'https://lemomemo.com');
    expect(r.ok).toBe(true);
    expect(r.ok && r.keys.publicB64).toBe(v.pub);
    expect(r.ok && r.keys.key.extractable).toBe(false);
  });
  it('换一个 d、换一个 x、换一个 y：vapid_keypair_mismatch 或 vapid_bad_key（不能发）', async () => {
    const v = await fakeVapidEnv();
    const w = await fakeVapidEnv();
    const swap = (k: 'd' | 'x' | 'y') => JSON.stringify({ kty: 'EC', crv: 'P-256', ...v.jwk, [k]: w.jwk[k] });
    expect((await loadVapid(swap('d'), v.pub, 'https://lemomemo.com')).ok).toBe(false);
    expect((await loadVapid(swap('x'), v.pub, 'https://lemomemo.com')).ok).toBe(false);
    expect((await loadVapid(swap('y'), v.pub, 'https://lemomemo.com')).ok).toBe(false);
    // Node 的 Web Crypto 导入时就核对 d 和 x、y（回 vapid_bad_key）；Deno 不核对（11-03 实测），靠签名自检回 vapid_keypair_mismatch
    const r = await loadVapid(swap('d'), v.pub, 'https://lemomemo.com');
    expect(!r.ok && (r.reason === 'vapid_keypair_mismatch' || r.reason === 'vapid_bad_key')).toBe(true);
  });
  it('VAPID_PUBLIC_KEY 和私钥不是一对：vapid_keypair_mismatch', async () => {
    const v = await fakeVapidEnv();
    const w = await fakeVapidEnv();
    const r = await loadVapid(v.priv, w.pub, 'https://lemomemo.com');
    expect(!r.ok && r.reason).toBe('vapid_keypair_mismatch');
  });
  it('缺变量、坏 JSON、坏 subject', async () => {
    const v = await fakeVapidEnv();
    expect(await loadVapid(undefined, v.pub, 'https://lemomemo.com')).toEqual({ ok: false, reason: 'vapid_missing' });
    expect(await loadVapid(v.priv, undefined, 'https://lemomemo.com')).toEqual({ ok: false, reason: 'vapid_missing' });
    expect(await loadVapid(v.priv, v.pub, undefined)).toEqual({ ok: false, reason: 'vapid_missing' });
    expect(await loadVapid('{not json', v.pub, 'https://lemomemo.com')).toEqual({ ok: false, reason: 'vapid_bad_key' });
    expect(await loadVapid(JSON.stringify({ kty: 'EC', crv: 'P-384', ...v.jwk }), v.pub, 'https://lemomemo.com')).toEqual({ ok: false, reason: 'vapid_bad_key' });
    expect(await loadVapid(v.priv, v.pub, 'http://lemomemo.com')).toEqual({ ok: false, reason: 'vapid_bad_subject' });
    expect(await loadVapid(v.priv, v.pub, 'lemomemo.com')).toEqual({ ok: false, reason: 'vapid_bad_subject' });
    expect((await loadVapid(v.priv, v.pub, 'mailto:push@lemomemo.com')).ok).toBe(true);
  });
  it('BE1-S1：subject 和 R-283、O-1 脚本一致——小写主机、不带端口、路径只许安全字符，或者 mailto（域名小写）', async () => {
    const v = await fakeVapidEnv();
    for (const ok of ['https://lemomemo.com', 'https://push.lemomemo.com/contact', 'https://lemomemo.com/a-b_c.d~e/', 'mailto:Ops.Team+push@lemomemo.com']) {
      expect((await loadVapid(v.priv, v.pub, ok)).ok).toBe(true);
    }
    const bad = [
      'https://LemoMemo.com', 'HTTPS://lemomemo.com', 'https://lemomemo.com:443', 'https://localhost', 'https://lemomemo.com/a?b=1',
      'https://lemomemo.com/a#b', 'https://lemomemo.com/%2e', 'https://user@lemomemo.com', 'mailto:ops@LemoMemo.com', 'MAILTO:ops@lemomemo.com',
      'mailto:ops@localhost', 'mailto:a b@lemomemo.com',
    ];
    for (const s of bad) expect(await loadVapid(v.priv, v.pub, s)).toEqual({ ok: false, reason: 'vapid_bad_subject' });
  });
});

describe('VAPID JWT（C-7、D1-6）', () => {
  it('推送服务一侧独立验签通过；aud = 请求的 origin；exp = 签发 + 12 小时；签名是 64 字节 r‖s', async () => {
    const v = await fakeVapidEnv();
    const r = await loadVapid(v.priv, v.pub, 'https://lemomemo.com');
    if (!r.ok) throw new Error(r.reason);
    const now = 1_793_000_000_000;
    const s = new VapidSigner(r.keys, () => now);
    const h = await s.authorization('https://fcm.googleapis.com');
    expect(await checkVapidHeader(h, 'https://fcm.googleapis.com', now / 1000)).toBe(null);
    expect(await checkVapidHeader(h, 'https://web.push.apple.com', now / 1000)).toBe('bad_aud');
    const claims = JSON.parse(td.decode(unb64u(h.split('.')[1] ?? ''))) as { exp: number };
    expect(claims.exp).toBe(now / 1000 + JWT_TTL_S);
    expect(h.endsWith(`, k=${v.pub}`)).toBe(true);
  });
  it('改一个字节验签失败', async () => {
    const v = await fakeVapidEnv();
    const r = await loadVapid(v.priv, v.pub, 'https://lemomemo.com');
    if (!r.ok) throw new Error(r.reason);
    const h = await new VapidSigner(r.keys, () => 1_793_000_000_000).authorization('https://fcm.googleapis.com');
    const sig = h.slice(h.lastIndexOf('.') + 1, h.indexOf(','));
    const raw = b64uDecode(sig);
    if (!raw) throw new Error('sig');
    raw.set([(raw[0] ?? 0) ^ 1], 0);
    const bad = h.replace(sig, b64uEncode(raw));
    expect(await checkVapidHeader(bad, 'https://fcm.googleapis.com', 1_793_000_000)).toBe('bad_signature');
  });
  it('按 origin 分开缓存；同一 origin 复用，剩不到 1 小时重签', async () => {
    const v = await fakeVapidEnv();
    const r = await loadVapid(v.priv, v.pub, 'https://lemomemo.com');
    if (!r.ok) throw new Error(r.reason);
    let now = 1_793_000_000_000;
    const s = new VapidSigner(r.keys, () => now);
    const a1 = await s.authorization('https://fcm.googleapis.com');
    const b1 = await s.authorization('https://web.push.apple.com');
    expect(a1 === b1).toBe(false);
    expect(s.size).toBe(2);
    now += 10 * 3600 * 1000;   // 还剩 2 小时：复用
    expect(await s.authorization('https://fcm.googleapis.com')).toBe(a1);
    now += 3600 * 1000 + 1000;   // 剩不到 1 小时：重签
    const a3 = await s.authorization('https://fcm.googleapis.com');
    expect(a3 === a1).toBe(false);
    expect(await checkVapidHeader(a3, 'https://fcm.googleapis.com', now / 1000)).toBe(null);
  });
});
