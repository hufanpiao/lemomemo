// ai-parse、ai-voice、claude-intake 共用的门（supabase/functions/_shared/ai/gate.ts）和计数（store.ts 的 quotaStore）。
// B3 任务单 BE-4、S12；TC-B3-25（未同意 Gemini 调用 0 次、不扣次数）、TC-B3-58（太平洋时间换日）、TC-B3-06（额度用完写 exhausted_until）。
import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  aiGate, clientReason, exhaustedUntilFor, globalQuotaKey, holdKind, MINUTE_HOLD_DEFAULT_MS, MINUTE_HOLD_MAX_MS, MINUTE_HOLD_MIN_MS, minuteKey, minuteWaitMs, nextPacificMidnight, pacificDate,
  PER_MINUTE_LIMIT, settleFailure, takeDaily, userQuotaKey, type GateGo,
} from '../../supabase/functions/_shared/ai/gate.ts';
import { markExhausted, quotaStore, type StoreAdmin } from '../../supabase/functions/_shared/ai/store.ts';
import { COUNTER_KEY, fakeGate, UA, used } from './ai-fakes.ts';

const NOW = Date.UTC(2026, 9, 28, 3, 0);   // 太平洋 10-27 20:00

/** 门拦下来时回给客户端的 body（放行了回 'go'） */
const stopBody = async (g: Parameters<typeof aiGate>[0]) => {
  const r = await aiGate(g, UA, '');
  return r.stop ? r.body : 'go';
};

describe('计数键和太平洋日期', () => {
  it('键都过 counters 的格式约束；个人、全局按太平洋日期，每分钟按 UTC 分钟', () => {
    expect(userQuotaKey(UA, NOW)).toBe(`ai:${UA}:2026-10-27`);
    expect(globalQuotaKey(NOW)).toBe('ai:global:2026-10-27');
    expect(minuteKey(UA, NOW)).toBe(`ai-rate:${UA}:202610280300`);
    for (const k of [userQuotaKey(UA, NOW), globalQuotaKey(NOW), minuteKey(UA, NOW)]) expect(COUNTER_KEY.test(k), k).toBe(true);
  });
  it('TC-B3-58：太平洋午夜换日；夏令时（PDT）和冬令时（PST）各一例', () => {
    expect(pacificDate(Date.UTC(2026, 9, 28, 6, 59))).toBe('2026-10-27');
    expect(pacificDate(Date.UTC(2026, 9, 28, 7, 0))).toBe('2026-10-28');   // PDT = UTC-7
    expect(nextPacificMidnight(NOW)).toBe(Date.UTC(2026, 9, 28, 7, 0));
    expect(nextPacificMidnight(Date.UTC(2026, 11, 1, 12, 0))).toBe(Date.UTC(2026, 11, 2, 8, 0));   // PST = UTC-8
    expect(nextPacificMidnight(Date.UTC(2026, 10, 1, 8, 30))).toBe(Date.UTC(2026, 10, 2, 8, 0));   // 11-01 夏令时结束那天
  });
});

describe('aiGate：顺序（每一步不过就回，后面都不做）', () => {
  it('TC-B3-25：没同意 → consent_required，不读开关、不扣次数、不调服务商', async () => {
    let asked = 0;
    const g = fakeGate({ consent: false, features: async () => { asked++; return ['event']; } });
    expect(await aiGate(g, UA, '4.0.0')).toEqual({ stop: true, status: 200, body: { consent_required: true } });
    expect([asked, g.counts.size, g.provider.stub.calls.length]).toEqual([0, 0, 0]);
  });
  it('同意读不出 → 503 try_later；一种类型都不能用 → fallback feature_off；配置读不出、没配好 → fallback error，都不扣次数', async () => {
    expect(await aiGate(fakeGate({ consent: 'throw' }), UA, '')).toEqual({ stop: true, status: 503, body: { error: 'try_later' } });
    const off = fakeGate({ features: [] });
    expect(await aiGate(off, UA, '')).toEqual({ stop: true, status: 200, body: { fallback: true, reason: 'feature_off' } });
    expect(off.counts.size).toBe(0);
    for (const g of [fakeGate({ config: 'throw' }), fakeGate({ noProvider: true })]) {
      expect(await aiGate(g, UA, '')).toEqual({ stop: true, status: 200, body: { fallback: true, reason: 'error' } });
      expect(g.counts.size).toBe(0);
    }
  });
  it('每分钟 6 次：第 7 次 429 rate_limited', async () => {
    const g = fakeGate();
    for (let i = 0; i < PER_MINUTE_LIMIT; i++) expect((await aiGate(g, UA, '')).stop).toBe(false);
    expect(await aiGate(g, UA, '')).toEqual({ stop: true, status: 429, body: { error: 'rate_limited' } });
    expect(used(g, `ai:${UA}`)).toBe(PER_MINUTE_LIMIT);
  });
  it('谷歌额度用完、还没到太平洋午夜 → fallback quota，不扣次数；过了照常', async () => {
    const g = fakeGate({ exhaustedUntil: nextPacificMidnight(NOW) });   // 剩不到 5 分钟的按每分钟停用回 error，见下面“每分钟的停用”那组
    expect(await aiGate(g, UA, '')).toEqual({ stop: true, status: 200, body: { fallback: true, reason: 'quota' }, hold: 'day' });
    expect(used(g, 'ai:')).toBe(0);
    expect((await aiGate(fakeGate({ exhaustedUntil: NOW }), UA, '')).stop).toBe(false);
  });
  it('TC-B3-58：每人每天 per_user_daily 次用完 → quota_out、quota_left 0；换到太平洋第二天又能用', async () => {
    const g = fakeGate({ config: { per_user_daily: 2 } });
    const first = await aiGate(g, UA, '');
    expect(!first.stop && first.quotaLeft).toBe(1);
    g.setNow(NOW + 60_000);
    expect(!(await aiGate(g, UA, '')).stop).toBe(true);
    g.setNow(NOW + 120_000);
    expect(await aiGate(g, UA, '')).toEqual({ stop: true, status: 200, body: { quota_out: true, quota_left: 0 } });
    expect(g.counts.get(userQuotaKey(UA, NOW))).toBe(2);   // 超了的那次不留
    g.setNow(Date.UTC(2026, 9, 28, 7, 1));   // 太平洋 10-28 00:01
    const next = await aiGate(g, UA, '');
    expect(!next.stop && next.userKey).toBe(`ai:${UA}:2026-10-28`);
  });
  it('全项目每天用完 → 退回刚扣的个人那一次、fallback quota；global_daily 没配按 0（AI 一律不调）', async () => {
    const g = fakeGate({ config: { global_daily: 1 } });
    expect((await aiGate(g, UA, '')).stop).toBe(false);
    g.setNow(NOW + 60_000);
    expect(await aiGate(g, UA, '')).toEqual({ stop: true, status: 200, body: { fallback: true, reason: 'quota' } });
    expect([g.counts.get(userQuotaKey(UA, NOW)), g.counts.get(globalQuotaKey(NOW))]).toEqual([1, 1]);
    const none = fakeGate({ config: { global_daily: null } });
    expect(await aiGate(none, UA, '')).toEqual({ stop: true, status: 200, body: { fallback: true, reason: 'quota' } });
    expect(none.counts.get(userQuotaKey(UA, NOW))).toBe(0);
  });
  it('放行：带上能用的类型、服务商、剩余次数和两个键', async () => {
    const g = fakeGate({ features: ['event', 'todo'] });
    const r = await aiGate(g, UA, '4.0.0');
    expect(r.stop).toBe(false);
    const go = r as GateGo;
    expect([go.features, go.provider, go.quotaLeft, go.userKey, go.globalKey]).toEqual([['event', 'todo'], g.provider.stub, 49, userQuotaKey(UA, NOW), globalQuotaKey(NOW)]);
  });
});

describe('settleFailure：AI 没成功', () => {
  it('退回两边各 1 次；quota 写 exhausted_until（太平洋下一个午夜）；invalid 只把原因写 logs', async () => {
    const g = fakeGate();
    const go = (await aiGate(g, UA, '')) as GateGo;
    await settleFailure(g, go, UA, 'ai-parse', { reason: 'quota' });
    expect([g.counts.get(go.userKey), g.counts.get(go.globalKey)]).toEqual([0, 0]);
    expect(g.exhaustedAt).toEqual([nextPacificMidnight(NOW)]);
    g.setNow(nextPacificMidnight(NOW));   // 停到太平洋午夜：过了午夜门才放行
    const go2 = (await aiGate(g, UA, '')) as GateGo;
    expect(go2.stop).toBe(false);
    await settleFailure(g, go2, UA, 'ai-parse', { reason: 'invalid', invalid_reasons: ['missing_date_basis'] });
    expect(g.invalid).toEqual([{ userId: UA, src: 'ai-parse', reasons: ['missing_date_basis'] }]);
    await settleFailure({ ...g, markExhausted: async () => { throw new Error('db'); } }, go2, UA, 'x', { reason: 'quota' });
    expect(g.logs).toContain('settle_failed');
  });
});

describe('额度用完按类型写 exhausted_until（11-13 ai-eval #2：每分钟限额撞一下就停一整天）', () => {
  it('exhaustedUntilFor：minute 写 now + retryDelay（没给 60 秒、最多 5 分钟）；day、unknown、没带类型写太平洋下一个午夜', () => {
    expect([MINUTE_HOLD_DEFAULT_MS, MINUTE_HOLD_MAX_MS]).toEqual([60_000, 300_000]);
    expect(exhaustedUntilFor(NOW, { quotaKind: 'minute', retryMs: 12_000 })).toBe(NOW + 12_000);
    expect(exhaustedUntilFor(NOW, { quotaKind: 'minute', retryMs: null })).toBe(NOW + 60_000);
    expect(exhaustedUntilFor(NOW, { quotaKind: 'minute' })).toBe(NOW + 60_000);
    expect(exhaustedUntilFor(NOW, { quotaKind: 'minute', retryMs: 3_600_000 })).toBe(NOW + 300_000);
    expect(exhaustedUntilFor(NOW, { quotaKind: 'day', retryMs: 1000 })).toBe(nextPacificMidnight(NOW));   // 每天用完时谷歌也给 1s，不看
    expect(exhaustedUntilFor(NOW, { quotaKind: 'unknown', retryMs: 5000 })).toBe(nextPacificMidnight(NOW));
    expect(exhaustedUntilFor(NOW, {})).toBe(nextPacificMidnight(NOW));
  });
  it('settleFailure：minute 只停到 retryDelay 以后，过了门照常放行；day、unknown 照旧停到太平洋午夜', async () => {
    const until = async (fail: Parameters<typeof settleFailure>[4]) => {
      const g = fakeGate();
      await settleFailure(g, (await aiGate(g, UA, '')) as GateGo, UA, 'ai-parse', fail);
      return g.exhausted;
    };
    expect(await until({ reason: 'quota', quotaKind: 'minute', retryMs: 12_000 })).toBe(NOW + 12_000);
    expect(await until({ reason: 'quota', quotaKind: 'minute', retryMs: null })).toBe(NOW + 60_000);
    expect(await until({ reason: 'quota', quotaKind: 'day', retryMs: 1000 })).toBe(nextPacificMidnight(NOW));
    expect(await until({ reason: 'quota', quotaKind: 'unknown', retryMs: null })).toBe(nextPacificMidnight(NOW));
    const m = fakeGate({ exhaustedUntil: NOW + 12_000 });
    expect((await aiGate(m, UA, '')).stop).toBe(true);
    m.setNow(NOW + 12_001);
    expect((await aiGate(m, UA, '')).stop).toBe(false);
  });
  it('只往后延：先写每天的（午夜）、后写每分钟的（12 秒后），结果仍是午夜；反过来先每分钟后每天，延到午夜', async () => {
    const g = fakeGate();
    const go = (await aiGate(g, UA, '')) as GateGo;
    await settleFailure(g, go, UA, 'ai-parse', { reason: 'quota', quotaKind: 'day' });
    await settleFailure(g, go, UA, 'ai-parse', { reason: 'quota', quotaKind: 'minute', retryMs: 12_000 });
    expect([g.exhaustedAt, g.exhausted]).toEqual([[nextPacificMidnight(NOW), NOW + 12_000], nextPacificMidnight(NOW)]);
    g.setNow(NOW + 12_001);   // 每分钟那 12 秒过了，仍按午夜拦
    expect(await stopBody(g)).toEqual({ fallback: true, reason: 'quota' });
    const h = fakeGate();
    const go2 = (await aiGate(h, UA, '')) as GateGo;
    await settleFailure(h, go2, UA, 'ai-parse', { reason: 'quota', quotaKind: 'minute', retryMs: 12_000 });
    await settleFailure(h, go2, UA, 'ai-parse', { reason: 'quota', quotaKind: 'day' });
    expect(h.exhausted).toBe(nextPacificMidnight(NOW));
  });
});

describe('每分钟的停用不能让客户端当成“今天用完”（11-13 评审第 1 条）', () => {
  it('minuteWaitMs：没给 60 秒；"0s"（0）按 1 秒；夹在 1 秒到 5 分钟；不是有限数按 60 秒', () => {
    expect([MINUTE_HOLD_MIN_MS, MINUTE_HOLD_DEFAULT_MS, MINUTE_HOLD_MAX_MS]).toEqual([1000, 60_000, 300_000]);
    expect([minuteWaitMs(null), minuteWaitMs(undefined), minuteWaitMs(0), minuteWaitMs(400), minuteWaitMs(12_000), minuteWaitMs(3_600_000), minuteWaitMs(Number.NaN)])
      .toEqual([60_000, 60_000, 1000, 1000, 12_000, 300_000, 60_000]);
    expect(exhaustedUntilFor(NOW, { quotaKind: 'minute', retryMs: 0 })).toBe(NOW + 1000);
  });
  it('门第 ⑤ 步：每分钟的停用（剩 ≤ 5 分钟）回 {fallback, error}；每天的回 {fallback, quota}；都不扣次数、不调服务商', async () => {
    const m = fakeGate({ exhaustedUntil: NOW + 12_000 });
    expect(await aiGate(m, UA, '')).toEqual({ stop: true, status: 200, body: { fallback: true, reason: 'error' }, hold: 'minute' });
    const edge = fakeGate({ exhaustedUntil: NOW + MINUTE_HOLD_MAX_MS });
    expect(await stopBody(edge)).toEqual({ fallback: true, reason: 'error' });
    const d = fakeGate({ exhaustedUntil: nextPacificMidnight(NOW) });
    expect(await aiGate(d, UA, '')).toEqual({ stop: true, status: 200, body: { fallback: true, reason: 'quota' }, hold: 'day' });
    const over = fakeGate({ exhaustedUntil: NOW + MINUTE_HOLD_MAX_MS + 1 });
    expect(await stopBody(over)).toEqual({ fallback: true, reason: 'quota' });
    for (const g of [m, edge, d, over]) expect([used(g, 'ai:'), g.provider.stub.calls.length]).toEqual([0, 0]);
  });
  it('离太平洋午夜不到 5 分钟的每天停用也回 error：无害，只是客户端这次不锁到午夜，下一次照样被门拦下，过了午夜就恢复', async () => {
    const late = nextPacificMidnight(NOW) - 4 * 60_000;   // 太平洋 23:56
    const g = fakeGate({ now: late, exhaustedUntil: nextPacificMidnight(NOW) });
    expect(holdKind(nextPacificMidnight(NOW), late)).toBe('minute');
    expect(await stopBody(g)).toEqual({ fallback: true, reason: 'error' });
    g.setNow(nextPacificMidnight(NOW));
    expect((await aiGate(g, UA, '')).stop).toBe(false);
  });
  it('全项目每天用完照旧回 quota（不是每分钟的停用）', async () => {
    expect(await stopBody(fakeGate({ config: { global_daily: 0 } }))).toEqual({ fallback: true, reason: 'quota' });
  });
  it('clientReason：本次撞了每分钟限额回 error；每天、认不出、没带类型照旧 quota；别的原因原样', () => {
    expect([
      clientReason({ reason: 'quota', quotaKind: 'minute' }), clientReason({ reason: 'quota', quotaKind: 'day' }),
      clientReason({ reason: 'quota', quotaKind: 'unknown' }), clientReason({ reason: 'quota' }),
      clientReason({ reason: 'timeout' }), clientReason({ reason: 'invalid' }),
    ]).toEqual(['error', 'quota', 'quota', 'quota', 'timeout', 'invalid']);
  });
});

describe('takeDaily：aiGate 第 ⑥ 步和 ai-classify 共用的预扣', () => {
  const keys = [userQuotaKey(UA, NOW), globalQuotaKey(NOW)] as const;
  it('扣上了回扣后的个人合计；个人用完不扣；全项目用完退回个人那一次', async () => {
    const g = fakeGate();
    expect(await takeDaily(g.quota, { per_user_daily: 1, global_daily: 5 }, ...keys)).toEqual({ ok: true, used: 1 });
    expect(await takeDaily(g.quota, { per_user_daily: 1, global_daily: 5 }, ...keys)).toEqual({ ok: false, out: 'user' });
    const h = fakeGate();
    expect(await takeDaily(h.quota, { per_user_daily: 5, global_daily: null }, ...keys)).toEqual({ ok: false, out: 'global' });
    expect([h.counts.get(keys[0]), h.counts.get(keys[1]) ?? 0]).toEqual([0, 0]);
  });
  it('出错不抛：个人那一下扣上了、全项目那一下出错 → userTaken: true；退回出错 → userTaken: false（调用方不再退第二次）', async () => {
    const quota = (o: { globalThrows?: boolean; refundThrows?: boolean }) => ({
      take: async (k: string) => {
        if (k === keys[1] && o.globalThrows) throw new Error('db');
        return k === keys[1] ? null : 1;
      },
      refund: async () => { if (o.refundThrows) throw new Error('db'); },
    });
    const cfg = { per_user_daily: 5, global_daily: 5 };
    expect(await takeDaily(quota({ globalThrows: true }), cfg, ...keys)).toEqual({ ok: false, out: 'failed', userTaken: true });
    expect(await takeDaily(quota({ refundThrows: true }), cfg, ...keys)).toEqual({ ok: false, out: 'failed', userTaken: false });
    expect(await takeDaily({ take: async () => { throw new Error('db'); }, refund: async () => {} }, cfg, ...keys)).toEqual({ ok: false, out: 'failed', userTaken: false });
  });
  it('门第 ⑥ 步：个人扣上了、全项目那一下出错 → 503 try_later，并退回个人那一次（R-356；和 ai-classify 一致）', async () => {
    const g = fakeGate();
    const take = g.quota.take.bind(g.quota);
    g.quota.take = async (k, limit) => {
      if (k.startsWith('ai:global:')) throw new Error('db');
      return take(k, limit);
    };
    expect(await aiGate(g, UA, '')).toEqual({ stop: true, status: 503, body: { error: 'try_later' } });
    expect(g.counts.get(userQuotaKey(UA, g.now()))).toBe(0);
    expect(g.logs).toContain('store_failed');
  });
});

// quotaStore 只是把预扣、退回交给库里的原子函数（迁移 20261107100000）；跨窗口合计、并发、上限的行为由 pgTAP 42_my_ai_usage 测
function rpcAdmin(reply: (fn: string, a: Record<string, unknown>) => { data: unknown; error: unknown }) {
  const calls: [string, Record<string, unknown>][] = [];
  const priv = {
    from: () => { throw new Error('不该直接读写 counters'); },
    rpc: async (fn: string, a: Record<string, unknown>) => { calls.push([fn, a]); return reply(fn, a); },
  };
  const admin: StoreAdmin = { from: () => { throw new Error('public'); }, schema: () => priv };
  return { admin, calls };
}

describe('store.ts quotaStore（private.ai_quota_take / ai_quota_refund）', () => {
  it('take 调 ai_quota_take(p_key, p_limit)，回数字就是扣后的合计，null 就是到上限；refund 调 ai_quota_refund(p_key)', async () => {
    let n = 0;
    const { admin, calls } = rpcAdmin((fn) => (fn === 'ai_quota_take' ? { data: ++n <= 2 ? n : null, error: null } : { data: null, error: null }));
    const q = quotaStore(admin);
    const k = userQuotaKey(UA, NOW);
    expect([await q.take(k, 2), await q.take(k, 2), await q.take(k, 2)]).toEqual([1, 2, null]);
    await q.refund(k);
    expect(calls).toEqual([
      ['ai_quota_take', { p_key: k, p_limit: 2 }], ['ai_quota_take', { p_key: k, p_limit: 2 }], ['ai_quota_take', { p_key: k, p_limit: 2 }],
      ['ai_quota_refund', { p_key: k }],
    ]);
  });
  it('库报错一律抛错（调用方回 503 或记 settle_failed）', async () => {
    const { admin } = rpcAdmin(() => ({ data: null, error: { code: '55P03' } }));
    const q = quotaStore(admin);
    await expect(q.take(userQuotaKey(UA, NOW), 2)).rejects.toThrow('db:quota_take');
    await expect(q.refund(userQuotaKey(UA, NOW))).rejects.toThrow('db:quota_refund');
  });
});

// markExhausted（11-13 评审第 2 条：只许往后延）：用真的 supabase-js 拼请求，fetch 换成记账的桩，核对发给 PostgREST 的地址、请求头、正文
function restAdmin(status: (method: string) => number = (m) => (m === 'POST' ? 201 : 204)) {
  const sent: { method: string; path: string; query: [string, string][]; prefer: string | null; profile: string | null; body: unknown }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const text = await req.text();
    sent.push({
      method: req.method, path: u.pathname, query: [...u.searchParams.entries()],
      prefer: req.headers.get('prefer'), profile: req.headers.get('content-profile'), body: text ? JSON.parse(text) : null,
    });
    const code = status(req.method);
    return new Response(code >= 400 ? JSON.stringify({ code: 'XX000', message: 'x' }) : null, { status: code, headers: { 'content-type': 'application/json' } });
  };
  const admin = createClient('http://127.0.0.1:54321', 'service-role-test', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
  });
  return { admin: admin as unknown as StoreAdmin, sent };
}

describe('store.ts markExhausted（private.ai_state，只往后延）', () => {
  it('先 insert gemini 一行（已有就不动），再带条件 update：exhausted_until 为空或比新值早才写；时间串在 or=() 里加双引号', async () => {
    const { admin, sent } = restAdmin();
    const until = nextPacificMidnight(NOW);
    const iso = new Date(until).toISOString();
    await markExhausted(admin, until);
    expect(sent).toEqual([
      {
        method: 'POST', path: '/rest/v1/ai_state', query: [['on_conflict', 'provider']],
        prefer: expect.stringContaining('resolution=ignore-duplicates'), profile: 'private', body: { provider: 'gemini' },
      },
      {
        method: 'PATCH', path: '/rest/v1/ai_state',
        query: [['provider', 'eq.gemini'], ['or', `(exhausted_until.is.null,exhausted_until.lt."${iso}")`]],
        prefer: expect.not.stringContaining('resolution'), profile: 'private', body: { exhausted_until: iso },
      },
    ]);
    expect(iso).toBe('2026-10-28T07:00:00.000Z');
  });
  it('库报错一律抛 db:ai_state_write；第一步出错就不发第二步', async () => {
    const a = restAdmin((m) => (m === 'POST' ? 500 : 204));
    await expect(markExhausted(a.admin, NOW)).rejects.toThrow('db:ai_state_write');
    expect(a.sent.map((x) => x.method)).toEqual(['POST']);
    const b = restAdmin((m) => (m === 'POST' ? 201 : 500));
    await expect(markExhausted(b.admin, NOW)).rejects.toThrow('db:ai_state_write');
    expect(b.sent.map((x) => x.method)).toEqual(['POST', 'PATCH']);
  });
});
