// ai-parse、ai-voice、claude-intake 共用的门（supabase/functions/_shared/ai/gate.ts）和计数（store.ts 的 quotaStore）。
// B3 任务单 BE-4、S12；TC-B3-25（未同意 Gemini 调用 0 次、不扣次数）、TC-B3-58（太平洋时间换日）、TC-B3-06（额度用完写 exhausted_until）。
import { describe, expect, it } from 'vitest';
import { aiGate, globalQuotaKey, minuteKey, nextPacificMidnight, pacificDate, PER_MINUTE_LIMIT, settleFailure, userQuotaKey, type GateGo } from '../../supabase/functions/_shared/ai/gate.ts';
import { quotaStore, type StoreAdmin } from '../../supabase/functions/_shared/ai/store.ts';
import { COUNTER_KEY, fakeGate, UA, used } from './ai-fakes.ts';

const NOW = Date.UTC(2026, 9, 28, 3, 0);   // 太平洋 10-27 20:00

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
    const g = fakeGate({ exhaustedUntil: NOW + 1 });
    expect(await aiGate(g, UA, '')).toEqual({ stop: true, status: 200, body: { fallback: true, reason: 'quota' } });
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
    const go2 = (await aiGate(g, UA, '')) as GateGo;
    await settleFailure(g, go2, UA, 'ai-parse', { reason: 'invalid', invalid_reasons: ['missing_date_basis'] });
    expect(g.invalid).toEqual([{ userId: UA, src: 'ai-parse', reasons: ['missing_date_basis'] }]);
    await settleFailure({ ...g, markExhausted: async () => { throw new Error('db'); } }, go2, UA, 'x', { reason: 'quota' });
    expect(g.logs).toContain('settle_failed');
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
