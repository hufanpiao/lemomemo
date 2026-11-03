// 本机推送替身解密一侧的固定向量（代码审查 M2；安全审查 C-11）：替身的 HKDF 是手写 HMAC 写法，和后端（Web Crypto 的 HKDF）不同，
// 先用 RFC 5869 的向量钉住 HKDF，再用 RFC 8291 附录 A 的完整消息钉住解密——这样替身说“解得开”才不是同一份写法自己验自己。
// 另外核 aes128gcm 头的检查（代码审查 S4）：idlen 不是 65、rs < 18、多于一条记录
import { describe, expect, it } from 'vitest';
import { newPushSubscriber, subscriberFromKeys, unb64u } from '../fakes/push-service.ts';
import { decryptPayload, hkdfHmac, parseAes128gcm } from '../fakes/push-service-vapid.ts';
import { cat, encrypt, fakeFactory, nowSec, pushHeaders, vapidHeader, vapidKey } from './push-service-fake-sender.ts';

const fake = fakeFactory();
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// RFC 8291 附录 A（www.rfc-editor.org/rfc/rfc8291.txt）的测试向量，原样抄，可逐字和 RFC 原文对照。
// 按 RFC 里的出现顺序放进数组、按序号取，不写成“字段名: 值”：那种写法会被 gitleaks 的 generic-api-key 规则当成密钥误报
const RFC8291_APPENDIX_A = [
  // [0] 接收方（UA）公钥 ua_public
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  // [1] 接收方私钥 ua_private
  'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  // [2] 认证密钥 auth_secret
  'BTBZMqHH6r4Tts7J_aSIgg',
  // [3] 完整的推送消息（含 aes128gcm 头）
  'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  // [4] 明文
  'When I grow up, I want to be a watermelon',
] as const;
const RFC8291 = {
  uaPublic: RFC8291_APPENDIX_A[0],
  uaPrivate: RFC8291_APPENDIX_A[1],
  auth: RFC8291_APPENDIX_A[2],
  message: RFC8291_APPENDIX_A[3],
  plaintext: RFC8291_APPENDIX_A[4],
};

describe('替身的 HKDF（手写 HMAC）', () => {
  it('RFC 5869 A.1（42 字节，走两轮 expand）', async () => {
    const okm = await hkdfHmac(hex('000102030405060708090a0b0c'), new Uint8Array(22).fill(0x0b), hex('f0f1f2f3f4f5f6f7f8f9'), 42);
    expect(toHex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  });

  it('RFC 5869 A.3（salt、info 为空）', async () => {
    const okm = await hkdfHmac(new Uint8Array(0), new Uint8Array(22).fill(0x0b), new Uint8Array(0), 42);
    expect(toHex(okm)).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8');
  });
});

describe('RFC 8291 附录 A：固定订阅方解固定消息', () => {
  it('decryptPayload 解出原文', async () => {
    const sub = await subscriberFromKeys(RFC8291.uaPrivate, RFC8291.uaPublic, RFC8291.auth);
    expect(await decryptPayload(sub, unb64u(RFC8291.message))).toBe(RFC8291.plaintext);
  });

  it('经替身（进程内）：记录里的 payload 是原文，订阅方是它', async () => {
    const sub = await subscriberFromKeys(RFC8291.uaPrivate, RFC8291.uaPublic, RFC8291.auth, 'https://fcm.googleapis.com/fcm/send/rfc');
    const f = fake({ subscribers: [sub] });
    const r = await f.fetch('https://fcm.googleapis.com/fcm/send/rfc', { method: 'POST', headers: pushHeaders(''), body: unb64u(RFC8291.message) });
    expect(r.status).toBe(201);
    expect(f.requests[0]).toMatchObject({ payload: RFC8291.plaintext, subscriber: { index: 0, p256dh: RFC8291.uaPublic } });
  });

  it('消息改一个字节就解不开', async () => {
    const sub = await subscriberFromKeys(RFC8291.uaPrivate, RFC8291.uaPublic, RFC8291.auth);
    const m = unb64u(RFC8291.message);
    m[m.length - 1] = (m[m.length - 1] ?? 0) ^ 1;
    await expect(decryptPayload(sub, m)).rejects.toThrow();
  });
});

describe('aes128gcm 头的检查（S4）', () => {
  it('RFC 8291 附录 A 的消息：rs = 4096、idlen = 65、一条记录', () => {
    const b = parseAes128gcm(unb64u(RFC8291.message));
    expect(typeof b === 'string' ? b : [b.rs, b.keyid.length, b.ct.length]).toEqual([4096, 65, 58]);
  });

  it.each([
    ['太短', (m: Uint8Array<ArrayBuffer>) => m.slice(0, 20), 'bad_body'],
    ['idlen 不是 65', (m: Uint8Array<ArrayBuffer>) => cat(m.slice(0, 20), new Uint8Array([64]), m.slice(22)), 'bad_keyid'],
    ['keyid 不是 0x04 开头', (m: Uint8Array<ArrayBuffer>) => cat(m.slice(0, 21), new Uint8Array([5]), m.slice(22)), 'bad_keyid'],
    ['rs < 18', (m: Uint8Array<ArrayBuffer>) => cat(m.slice(0, 16), new Uint8Array([0, 0, 0, 17]), m.slice(20)), 'bad_rs'],
    ['多于一条记录（密文比 rs 长）', (m: Uint8Array<ArrayBuffer>) => cat(m.slice(0, 16), new Uint8Array([0, 0, 0, 18]), m.slice(20)), 'multi_record'],
  ])('%s：%s', (_, mutate, why) => {
    expect(parseAes128gcm(mutate(unb64u(RFC8291.message)))).toBe(why);
  });

  it('开了 VAPID 时，头不合规回 400 并记原因', async () => {
    const sub = await newPushSubscriber('https://fcm.googleapis.com/fcm/send/h');
    const key = await vapidKey();
    const f = fake({ vapid: {}, subscribers: [sub] });
    const auth = await vapidHeader(key, { aud: 'https://fcm.googleapis.com', exp: nowSec() + 600, sub: 'mailto:ops@lemomemo.com' });
    const body = await encrypt(sub, 'x');
    body[20] = 64;
    const r = await f.fetch('https://fcm.googleapis.com/fcm/send/h', { method: 'POST', headers: pushHeaders(auth), body });
    expect(r.status).toBe(400);
    expect(f.requests[0]?.vapid).toEqual({ ok: false, why: 'bad_keyid' });
  });
});
