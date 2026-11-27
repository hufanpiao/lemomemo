// 本机推送替身（tests/fakes/push-service.ts）的 VAPID 和订阅方自测：验签、aud 绑定本次请求的源（代码审查 M1）、exp ≤ 12 小时、sub、typ、
// 签名长度、指定公钥、TTL、编码、Content-Type、解密负载、只记录不拦；按订阅方配回复（M3）；被拒的请求不消耗规则次数（S6）
import { describe, expect, it } from 'vitest';
import { type FakePushService, newPushSubscriber, reply } from '../fakes/push-service.ts';
import { encrypt, fakeFactory, nowSec, pushHeaders, vapidHeader, vapidKey } from './push-service-fake-sender.ts';

const fake = fakeFactory();
const FCM = 'https://fcm.googleapis.com';
const MOZ = 'https://updates.push.services.mozilla.com';
const EP = `${FCM}/fcm/send/v`;

async function setup(opt: Parameters<typeof fake>[0] = {}) {
  const sub = await newPushSubscriber(EP);
  const key = await vapidKey();
  const f = fake({ vapid: {}, subscribers: [sub], ...opt });
  return { sub, key, f };
}
const claims = (over: Record<string, unknown> = {}) => ({ aud: FCM, exp: nowSec() + 3600, sub: 'mailto:ops@lemomemo.com', ...over });
async function send(f: FakePushService, auth: string, body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}, url = EP) {
  return f.fetch(url, { method: 'POST', headers: pushHeaders(auth, headers), body });
}

describe('推送替身：VAPID', () => {
  it('签名、aud、exp、sub 都对：201，记下明文负载和订阅方', async () => {
    const { sub, key, f } = await setup();
    const r = await send(f, await vapidHeader(key, claims()), await encrypt(sub, '{"kind":"todo","n":1}'));
    expect(r.status).toBe(201);
    expect(f.requests[0]?.vapid).toMatchObject({ ok: true, publicKey: key.pub });
    expect(f.requests[0]?.payload).toBe('{"kind":"todo","n":1}');
    expect(f.requests[0]?.subscriber).toEqual({ index: 0, p256dh: sub.p256dh, endpoint: EP });
  });

  it.each([
    ['aud 不是推送服务的源', { aud: 'https://evil.example' }, 'bad_aud'],
    ['跨源 aud：发往 FCM，aud 签成 Mozilla（M1）', { aud: MOZ }, 'bad_aud'],
    ['exp 已过', { exp: nowSec() - 1 }, 'expired'],
    ['exp 超过 12 小时', { exp: nowSec() + 12 * 3600 + 60 }, 'exp_too_far'],
    ['sub 不是 mailto: 或 https://', { sub: 'lemomemo.com' }, 'bad_sub'],
    ['sub 写成 https: 少了 //', { sub: 'https:lemomemo.com' }, 'bad_sub'],
  ])('%s：403', async (_, over, why) => {
    const { sub, key, f } = await setup();
    const r = await send(f, await vapidHeader(key, claims(over)), await encrypt(sub, 'x'));
    expect(r.status).toBe(403);
    expect(await r.text()).toBe(why);
    expect(f.requests[0]?.vapid).toEqual({ ok: false, why });
  });

  it('签名对不上 / 不是 64 字节：bad_signature；alg 不是 ES256：bad_alg；typ 不是 JWT：bad_typ', async () => {
    const { sub, key, f } = await setup();
    const other = await vapidKey();
    const forged = (await vapidHeader(other, claims())).replace(/k=.*$/, `k=${key.pub}`);
    const longSig = (await vapidHeader(key, claims())).replace(/\.([\w-]+), k=/, '.$1AAAA, k=');
    const cases: [string, string][] = [
      [forged, 'bad_signature'],
      [longSig, 'bad_signature'],
      [await vapidHeader(key, claims(), { typ: 'JWT', alg: 'HS256' }), 'bad_alg'],
      [await vapidHeader(key, claims(), { alg: 'ES256' }), 'bad_typ'],
    ];
    for (const [auth] of cases) expect((await send(f, auth, await encrypt(sub, 'x'))).status).toBe(403);
    expect(f.requests.map((q) => q.vapid)).toEqual(cases.map(([, why]) => ({ ok: false, why })));
  });

  it('指定了公钥时，别的钥匙签的一律 403 unknown_key', async () => {
    const { sub, key, f } = await setup({ vapid: { publicKey: (await vapidKey()).pub } });
    expect((await send(f, await vapidHeader(key, claims()), await encrypt(sub, 'x'))).status).toBe(403);
    expect(f.requests[0]?.vapid).toEqual({ ok: false, why: 'unknown_key' });
  });

  it('缺 TTL、编码不是 aes128gcm、Content-Type 不对、负载解不开：400', async () => {
    const { sub, key, f } = await setup();
    const auth = await vapidHeader(key, claims());
    const stranger = await newPushSubscriber(EP);
    expect((await send(f, auth, await encrypt(sub, 'x'), { ttl: '' })).status).toBe(400);
    expect((await send(f, auth, await encrypt(sub, 'x'), { 'content-encoding': 'aesgcm' })).status).toBe(400);
    expect((await send(f, auth, await encrypt(sub, 'x'), { 'content-type': 'text/plain' })).status).toBe(400);
    expect((await send(f, auth, await encrypt(stranger, 'x'))).status).toBe(400);
    expect(f.requests.map((q) => q.vapid?.ok === false && q.vapid.why)).toEqual(['missing_ttl', 'bad_encoding', 'bad_content_type', 'decrypt_failed']);
  });

  it('请求体超过 4096 字节：413（推送服务的上限，不开 VAPID 也拦）', async () => {
    const f = fake();
    const r = await f.fetch(EP, { method: 'POST', body: new Uint8Array(4097) });
    expect(r.status).toBe(413);
    expect((await f.fetch(EP, { method: 'POST', body: new Uint8Array(4096) })).status).toBe(201);
  });

  it('enforce: false 只记录、照常按规则回（例如测 410 时不关心签名）', async () => {
    const f = fake({ vapid: { enforce: false }, defaultReply: reply.gone() });
    const r = await f.fetch(EP, { method: 'POST', body: 'x' });
    expect(r.status).toBe(410);
    expect(f.requests[0]?.vapid).toEqual({ ok: false, why: 'bad_authorization' });
  });

  it('端口模式：aud 按解开负载的订阅方的真实端点的源核（M1）——FCM 收，Mozilla、替身自己、host.docker.internal 都 403', async () => {
    const { sub, key, f } = await setup();
    const origin = await f.listen();
    const post = async (aud: string) =>
      (await fetch(`${origin}/push`, { method: 'POST', headers: pushHeaders(await vapidHeader(key, claims({ aud }))), body: await encrypt(sub, 'hi') })).status;
    expect(await post(FCM)).toBe(201);
    expect(await post(MOZ)).toBe(403);
    expect(await post(origin)).toBe(403);
    expect(await post(f.overrideUrl('host.docker.internal'))).toBe(403);
    expect(f.requests.map((q) => (q.vapid?.ok ? 'ok' : q.vapid?.why))).toEqual(['ok', 'bad_aud', 'bad_aud', 'bad_aud']);
    expect(f.requests[0]?.payload).toBe('hi');
  });
});

describe('推送替身：端口模式下 aud 必须绑到订阅方的 endpoint（复核 N3）', () => {
  it('订阅方没带 endpoint：aud 是四家之一也不放行，403 aud_unbound', async () => {
    const sub = await newPushSubscriber();
    const key = await vapidKey();
    const f = fake({ vapid: {}, subscribers: [sub] });
    const origin = await f.listen();
    const r = await fetch(`${origin}/push`, { method: 'POST', headers: pushHeaders(await vapidHeader(key, claims())), body: await encrypt(sub, 'x') });
    expect(r.status).toBe(403);
    expect(f.requests[0]?.vapid).toEqual({ ok: false, why: 'aud_unbound' });
    expect(f.requests[0]?.payload).toBe('x');
  });

  it('没配订阅方：同样 aud_unbound；配了订阅方却谁都解不开：400 decrypt_failed', async () => {
    const key = await vapidKey();
    const auth = await vapidHeader(key, claims());
    const none = fake({ vapid: {} });
    const o1 = await none.listen();
    expect((await fetch(`${o1}/push`, { method: 'POST', headers: pushHeaders(auth), body: await encrypt(await newPushSubscriber(EP), 'x') })).status).toBe(403);
    expect(none.requests[0]?.vapid).toEqual({ ok: false, why: 'aud_unbound' });
    const { f } = await setup();
    const o2 = await f.listen();
    expect((await fetch(`${o2}/push`, { method: 'POST', headers: pushHeaders(auth), body: await encrypt(await newPushSubscriber(EP), 'x') })).status).toBe(400);
    expect(f.requests[0]?.vapid).toEqual({ ok: false, why: 'decrypt_failed' });
  });

  it('进程内不受影响：订阅方没带 endpoint 时按请求地址的源核，201', async () => {
    const sub = await newPushSubscriber();
    const key = await vapidKey();
    const f = fake({ vapid: {}, subscribers: [sub] });
    expect((await send(f, await vapidHeader(key, claims()), await encrypt(sub, 'x'))).status).toBe(201);
  });
});

describe('推送替身：按订阅方配回复（M3）', () => {
  it('端口模式下路径都一样，也能按订阅方（p256dh 或 endpoint）回不同的状态，记录写明是谁', async () => {
    const a = await newPushSubscriber(`${FCM}/fcm/send/a`);
    const b = await newPushSubscriber(`${MOZ}/wpush/v2/b`);
    const c = await newPushSubscriber(`${FCM}/fcm/send/c`);
    const f = fake({
      subscribers: [a, b, c],
      rules: [
        { subscriber: b.p256dh, reply: reply.gone() },
        { subscriber: `${FCM}/fcm/send/c`, reply: reply.tooMany(5) },
      ],
    });
    const origin = await f.listen();
    const post = async (s: typeof a) => (await fetch(`${origin}/push`, { method: 'POST', headers: pushHeaders(''), body: await encrypt(s, 'p') })).status;
    expect([await post(a), await post(b), await post(c)]).toEqual([201, 410, 429]);
    expect(f.requests.map((q) => q.subscriber?.index)).toEqual([0, 1, 2]);
    expect(f.requests[1]?.subscriber?.endpoint).toBe(`${MOZ}/wpush/v2/b`);
  });

  it('请求路径等于某个订阅方端点的路径时先试它；addSubscriber 后加的也认', async () => {
    const f = fake();
    const s = await newPushSubscriber(`${FCM}/fcm/send/late`);
    f.addSubscriber(s);
    const origin = await f.listen();
    await fetch(`${origin}/fcm/send/late`, { method: 'POST', headers: pushHeaders(''), body: await encrypt(s, 'late') });
    expect(f.requests[0]).toMatchObject({ payload: 'late', subscriber: { index: 0 } });
  });
});

describe('推送替身：被拒的请求不消耗规则次数（S6）', () => {
  it('第一次 VAPID 不过回 403，规则的 times 还在；下一次才命中 429，再下一次落到 201', async () => {
    const { sub, key, f } = await setup({ rules: [{ reply: reply.tooMany(), times: 1 }] });
    const good = await vapidHeader(key, claims());
    expect((await send(f, await vapidHeader(key, claims({ aud: MOZ })), await encrypt(sub, 'x'))).status).toBe(403);
    expect((await send(f, good, await encrypt(sub, 'x'))).status).toBe(429);
    expect((await send(f, good, await encrypt(sub, 'x'))).status).toBe(201);
  });
});
