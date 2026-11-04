// push-dispatch 骨架（B2 第一天派工表第 4 行；架构 5.3、第 6 节；B2 安全审查第五节第 4～8 条、1.5 第 ② 点 D1-8、C-9；TC-B2-80 环境变量组、TC-B2-88）。
// 这一份测 core.ts 的 handle、filterUsable 和 _shared/push/stub.ts（index.ts 只是把 Deno.env、supabase-js 接上）；发送在 push-send.test.ts。
// 放 tests/edge（只走 tsconfig.node）：测试开发的替身 tests/fakes/push-service.ts 用了 node:http，tests/functions 的 workers 类型编译不了它。
// 钥匙一律现生成的假 VAPID（用完即丢），不碰任何环境的真钥匙
import { describe, expect, it, vi } from 'vitest';
import { filterUsable, handle, type Deps, type HeartbeatDetail } from '../../supabase/functions/push-dispatch/core.ts';
import { isLocalStubEnv, resolveOverride } from '../../supabase/functions/_shared/push/stub.ts';
import { loadVapid, type VapidKeys } from '../../supabase/functions/_shared/push/vapid.ts';
import { b64u, unb64u } from '../fakes/push-service-vapid.ts';
import { LOGIC, MemDb } from './push-dispatch-mem.ts';
import { DETAIL_FIELDS_BY_NAME } from '../../supabase/functions/usage-report/core.ts';

const PUSH_ALLOW = DETAIL_FIELDS_BY_NAME['push-dispatch'] ?? { num: [], bool: [] };
import { evaluatePush, PUSH_DETAIL_FIELDS } from '../../workers/lemo-ops/src/rules.ts';

const CRON = 'c'.repeat(40);

async function fakeVapid(): Promise<{ priv: string; pub: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  const j = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u(new Uint8Array([4, ...unb64u(j.x ?? ''), ...unb64u(j.y ?? '')]));
  return { priv: JSON.stringify({ kty: 'EC', crv: 'P-256', d: j.d, x: j.x, y: j.y }), pub };
}

async function keys(): Promise<{ keys: VapidKeys; pub: string }> {
  const v = await fakeVapid();
  const r = await loadVapid(v.priv, v.pub, 'https://lemomemo.com');
  if (!r.ok) throw new Error(r.reason);
  return { keys: r.keys, pub: v.pub };
}

function cronReq(secret: string | null, method = 'POST'): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['x-cron-secret'] = secret;
  return new Request('http://kong:8000/functions/v1/push-dispatch', { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) });
}

function deps(over: Partial<Deps> = {}): Deps & { beats: HeartbeatDetail[]; logs: string[] } {
  const beats: HeartbeatDetail[] = [];
  const logs: string[] = [];
  return {
    cronSecret: CRON,
    override: { ok: true, url: null },
    vapid: async () => ({ ok: true, keys: (await keys()).keys }),
    // BE-2 起 store 是整份 DispatchStore：空的内存库（一轮里没有任何条目），心跳记进 beats
    store: Object.assign(new MemDb(), { writeHeartbeat: async (d: HeartbeatDetail) => { beats.push(d); } }),
    logic: LOGIC,
    isUsable: async () => true,
    now: () => 1_793_000_000_000,
    log: (c) => logs.push(c),
    beats,
    logs,
    ...over,
  };
}

describe('handle：鉴权先于配置检查', () => {
  it('只收 POST', async () => {
    expect((await handle(cronReq(CRON, 'GET'), deps())).status).toBe(405);
  });
  it('新增 cron 函数必有：没设 CRON_SECRET、不带头、空头、错密钥都回 401，不自检 VAPID、不写心跳', async () => {
    const vapid = vi.fn(async () => ({ ok: true as const, keys: (await keys()).keys }));
    for (const [secret, d] of [[CRON, deps({ cronSecret: undefined, vapid })], [null, deps({ vapid })], ['', deps({ vapid })], [`${CRON}x`, deps({ vapid })], ['c'.repeat(39), deps({ vapid })]] as const) {
      const r = await handle(cronReq(secret), d);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'unauthorized' });
      expect(d.beats).toHaveLength(0);
    }
    expect(vapid).not.toHaveBeenCalled();
  });
  it('配置坏了也先过鉴权：错密钥 + 替身配错 → 401（没带对密钥的调用方看不出函数配没配）', async () => {
    expect((await handle(cronReq('wrong'), deps({ override: { ok: false } }))).status).toBe(401);
  });
});

describe('handle：500 misconfigured，一条都不发（日志只记原因码）', () => {
  it('CRON_SECRET 不到 32 字节', async () => {
    const short = 's'.repeat(31);
    const d = deps({ cronSecret: short });
    expect((await handle(cronReq(short), d)).status).toBe(500);
    expect(d.logs).toEqual(['misconfigured:cron_secret']);
  });
  it('PUSH_SERVICE_OVERRIDE_URL 不合规（线上设了、或本机地址不对）', async () => {
    const d = deps({ override: { ok: false } });
    const r = await handle(cronReq(CRON), d);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'misconfigured' });
    expect(d.logs).toEqual(['misconfigured:override']);
    expect(d.beats).toHaveLength(0);
  });
  it('数据库客户端没有', async () => {
    const d = deps({ store: null });
    expect((await handle(cronReq(CRON), d)).status).toBe(500);
    expect(d.logs).toEqual(['misconfigured:store']);
  });
  it('C-9：VAPID 私钥和 VAPID_PUBLIC_KEY 不配对 → 500', async () => {
    const a = await fakeVapid();
    const b = await fakeVapid();
    const d = deps({ vapid: () => loadVapid(a.priv, b.pub, 'https://lemomemo.com') });
    expect((await handle(cronReq(CRON), d)).status).toBe(500);
    expect(d.logs).toEqual(['misconfigured:vapid_keypair_mismatch']);
    expect(d.beats).toHaveLength(0);
  });
  it('TC-B2-88：VAPID_PUBLIC_KEY 没设、或是空串，和不配对一样回 500', async () => {
    const a = await fakeVapid();
    for (const pub of [undefined, '']) {
      const d = deps({ vapid: () => loadVapid(a.priv, pub, 'https://lemomemo.com') });
      const r = await handle(cronReq(CRON), d);
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: 'misconfigured' });
      expect(d.logs).toEqual(['misconfigured:vapid_missing']);
      expect(d.beats).toHaveLength(0);
    }
  });
  it('私钥、subject 缺或坏；自检抛异常也按坏钥匙算', async () => {
    const a = await fakeVapid();
    for (const [v, code] of [
      [() => loadVapid(undefined, a.pub, 'https://lemomemo.com'), 'misconfigured:vapid_missing'],
      [() => loadVapid('{x', a.pub, 'https://lemomemo.com'), 'misconfigured:vapid_bad_key'],
      [() => loadVapid(a.priv, a.pub, undefined), 'misconfigured:vapid_missing'],
      [() => loadVapid(a.priv, a.pub, 'lemomemo.com'), 'misconfigured:vapid_bad_subject'],
      [() => Promise.reject(new Error('boom')), 'misconfigured:vapid_bad_key'],
    ] as const) {
      const d = deps({ vapid: v as Deps['vapid'] });
      expect((await handle(cronReq(CRON), d)).status).toBe(500);
      expect(d.logs).toEqual([code]);
    }
  });
});

describe('handle：心跳', () => {
  it('写 push-dispatch 心跳，detail 只有 claimed、sent、failed、budget_hit（空库一轮都是 0 / false；回包另带 left）', async () => {
    const d = deps();
    const r = await handle(cronReq(CRON), d);
    expect(r.status).toBe(200);
    expect(d.beats).toEqual([{ claimed: 0, sent: 0, failed: 0, budget_hit: false }]);
    expect(await r.json()).toEqual({ ok: true, claimed: 0, sent: 0, failed: 0, budget_hit: false, left: 0 });
  });
  it('写心跳失败回 503，日志只记 heartbeat_failed', async () => {
    const d = deps({ store: Object.assign(new MemDb(), { writeHeartbeat: async () => { throw new Error('db down: secret stuff'); } }) });
    expect((await handle(cronReq(CRON), d)).status).toBe(503);
    expect(d.logs).toEqual(['heartbeat_failed']);
  });
});

describe('filterUsable（停用、冷静期的不发，经 private.account_usable）', () => {
  it('去重、保序；查询出错的那个人这一轮跳过，不影响别人', async () => {
    const logs: string[] = [];
    const usable = async (u: string) => {
      if (u === 'boom') throw new Error('x');
      return u !== 'off';
    };
    expect(await filterUsable(['a', 'off', 'boom', 'b', 'a'], usable, (c) => logs.push(c))).toEqual(['a', 'b']);
    expect(logs).toEqual(['usable_check_failed']);
  });
});

describe('D1-8：本机替身怎么认（TC-B2-80 环境变量组，安全审查 1.5 第 ② 点）', () => {
  const OK_URL = 'http://kong:8000';
  it('本机要两条都满足：SUPABASE_URL 是 http 且主机为 kong / 127.0.0.1 / localhost，并且 LEMO_LOCAL_PUSH_STUB=1', () => {
    for (const u of ['http://kong:8000', 'http://127.0.0.1:54321', 'http://localhost:54321']) expect(isLocalStubEnv(u, '1'), u).toBe(true);
    for (const [u, f] of [
      ['https://x.supabase.co', '1'], ['http://kong:8000', undefined], ['http://kong:8000', 'true'], ['http://kong:8000', ''],
      ['https://kong:8000', '1'], ['http://kong.evil.com:8000', '1'], ['http://10.0.0.1:8000', '1'], [undefined, '1'], ['not a url', '1'],
      ['http://host.docker.internal:54321', '1'],
    ] as const) expect(isLocalStubEnv(u, f), `${String(u)} ${String(f)}`).toBe(false);
  });
  it('线上（缺一条）只要替身变量非空，不管值是什么都 {ok:false} → 500；没设或空串不改投', () => {
    expect(resolveOverride('http://127.0.0.1:54399', 'https://x.supabase.co', '1')).toEqual({ ok: false });
    expect(resolveOverride('http://127.0.0.1:54399', 'http://kong:8000', undefined)).toEqual({ ok: false });
    expect(resolveOverride('garbage', 'https://x.supabase.co', undefined)).toEqual({ ok: false });
    expect(resolveOverride(undefined, 'https://x.supabase.co', undefined)).toEqual({ ok: true, url: null });
    expect(resolveOverride('', 'https://x.supabase.co', '1')).toEqual({ ok: true, url: null });
  });
  it('两条都满足：127.0.0.1、localhost、host.docker.internal 的合规地址认', () => {
    for (const u of ['http://host.docker.internal:54399', 'http://127.0.0.1:54399/push', 'http://localhost:1024', 'http://127.0.0.1:65535/a/b=c']) {
      expect(resolveOverride(u, OK_URL, '1'), u).toEqual({ ok: true, url: u });
    }
  });
  it('本机也拒：别的主机、IP、https、端口 < 1024 或 > 65535、带用户名、查询串、#', () => {
    for (const u of [
      'http://host.docker.internal.evil.com:54399', 'http://10.0.0.1:54399', 'https://host.docker.internal:54399', 'http://host.docker.internal:80',
      'http://127.0.0.1:65536', 'http://127.0.0.1:099999', 'http://127.0.0.1', 'http://u:p@127.0.0.1:54399', 'http://127.0.0.1:54399/?x=1',
      'http://127.0.0.1:54399/#x', 'HTTP://127.0.0.1:54399', 'http://127.0.0.1:54399 ', 'http://[::1]:54399',
    ]) expect(resolveOverride(u, OK_URL, '1'), u).toEqual({ ok: false });
  });
});

describe('心跳 detail 和 lemo-ops 对得上（rules.ts PUSH_DETAIL_FIELDS 11-03 核对）', () => {
  it('handle 真写出的心跳字段名 = claimed、sent、failed、budget_hit；usage-report 白名单全收；转发后 evaluatePush 认得（换个名就判不了）', async () => {
    const d = deps();
    expect((await handle(cronReq(CRON), d)).status).toBe(200);
    const beat = d.beats[0] as HeartbeatDetail;
    expect(Object.keys(beat).sort()).toEqual(['budget_hit', 'claimed', 'failed', 'sent']);
    for (const k of PUSH_DETAIL_FIELDS) expect(PUSH_ALLOW.num, k).toContain(k);
    expect(PUSH_ALLOW.bool).toContain('budget_hit');
    // 照 usage-report 的 pickDetail 口径转发（按心跳名分开的白名单 DETAIL_FIELDS_BY_NAME['push-dispatch']：数字只收非负整数、布尔只收 true/false）
    const forward = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k, v]) =>
      (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && PUSH_ALLOW.num.includes(k)) || (typeof v === 'boolean' && PUSH_ALLOW.bool.includes(k))));
    // 用真实心跳的键，只换数值：认领 4、成功 1、失败 3 → 失败过半
    const vals: Record<string, number> = { claimed: 4, sent: 1, failed: 3 };
    const bad = Object.fromEntries(Object.entries(beat).map(([k, v]) => [k, vals[k] ?? v]));
    expect(evaluatePush(forward(bad))?.key).toBe('push-failed');
    expect(evaluatePush(forward(beat as unknown as Record<string, unknown>))).toBeNull();
    // 反例：字段名对不上（例如写成 ok / fail），evaluatePush 就判不出来
    expect(evaluatePush(forward({ claimed: 4, ok: 1, fail: 3 }))).toBeNull();
  });
});
