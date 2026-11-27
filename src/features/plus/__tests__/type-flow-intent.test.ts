// 打字流程的意图分流（data/type-flow.ts 的 planTyped；B4b-3，架构 5.14 第 2 点）：本机有把握不调 AI；本机有迹象没把握交给 AI，AI ≥ 0.6 才算数；
// 模糊先按记下存、alt 给“改成搜索”。AI 一律用桩（AI 返回的 query.kinds 至少一个，schema 要求）
import { describe, expect, it, vi } from 'vitest';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import type * as quotaModule from '../data/quota.ts';
import { planTyped, type CallAi, type TypeCtx } from '../data/type-flow.ts';

vi.mock('../data/quota.ts', async (orig) => ({
  ...(await orig<typeof quotaModule>()),
  quotaOutToday: vi.fn(async () => false),
  rememberQuotaLeft: vi.fn(async () => {}),
}));

/** 2026-11-02（周一）10:00 首尔 */
const NOW = Date.UTC(2026, 10, 2, 1, 0);
const CTX: TypeCtx = { now: NOW, tz: 'Asia/Seoul', locale: 'zh', projects: [], day: null };
const ON = { online: true, aiOn: true, quotaOut: false };
const item = (over: Partial<AiItem> = {}): AiItem => ({
  kind: 'todo', title: 'AI title', date: null, time: null, duration_min: null, due: '2026-11-05', important: false,
  project: null, body: null, short: 'AI', date_basis: 'rel', anniv: null, confirm: null, ...over,
});
const record = (items: AiItem[], confidence = 1) => ({ intent: 'record', confidence, items, quota_left: 7 });
const stub = (ret: unknown): CallAi & ReturnType<typeof vi.fn> => vi.fn(async () => ret);

/** 本机有把握的总结 */
const SURE_SUM = '总结一下这周的随手记';
/** 本机看出是查找、但没把握（批量词） */
const UNSURE = '帮我找所有发票';
const aiQuery = { text: '发票', range: null, kinds: ['note'], done: 'any' };
const aiSearch = (confidence: number) => ({ intent: 'search', confidence, query: aiQuery, quota_left: 3 });

describe('planTyped 的意图分流', () => {
  it('本机有把握的总结：不调 AI，ask 交给结果层（aiUsed 0、items 空、alt 空）', async () => {
    const call = stub(record([item()]));
    const p = await planTyped(SURE_SUM, CTX, ON, call);
    expect(call).not.toHaveBeenCalled();
    expect(p).toMatchObject({ status: 'saved', items: [], alt: null, ask: { aiUsed: 0, ask: { intent: 'summarize', query: { kinds: ['note'], range: { from: '2026-11-02', to: '2026-11-08' } } } } });
  });
  it('本机有把握的查找：离线也不调 AI，照样交给结果层', async () => {
    const call = stub(record([item()]));
    const p = await planTyped('帮我找发票', CTX, { ...ON, online: false }, call);
    expect(call).not.toHaveBeenCalled();
    expect(p.ask).toMatchObject({ aiUsed: 0, ask: { intent: 'search', query: { text: '发票' } } });
  });
  it('本机有迹象没把握 + AI 判 search、confidence 0.9 → ask（aiUsed 1，用 AI 的条件），不保存', async () => {
    const call = stub(aiSearch(0.9));
    const p = await planTyped(UNSURE, CTX, ON, call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(p).toMatchObject({ items: [], alt: null, quotaLeft: 3, ask: { aiUsed: 1, ask: { intent: 'search', query: aiQuery } } });
  });
  it('同样但 AI 只有 0.4：先按记下存（不丢），alt 带 AI 的判断、found true', async () => {
    const p = await planTyped(UNSURE, CTX, ON, stub(aiSearch(0.4)));
    expect(p).toMatchObject({ status: 'saved', origin: 'rule', ask: null, aiReason: 'intent_search', alt: { ask: { intent: 'search', query: aiQuery }, found: true } });
    expect(p.items.length).toBeGreaterThan(0);
  });
  it('AI 判 record 而本机有迹象：按 AI 的条目存，alt 是本机的判断，found = confidence < 0.6', async () => {
    const low = await planTyped(UNSURE, CTX, ON, stub(record([item()], 0.5)));
    expect(low).toMatchObject({ status: 'saved', origin: 'ai', ask: null, alt: { ask: { intent: 'search' }, found: true } });
    const high = await planTyped(UNSURE, CTX, ON, stub(record([item()], 0.9)));
    expect(high.alt).toMatchObject({ ask: { intent: 'search' }, found: false });
  });
  it('AI 判 record 而本机没迹象：alt 为 null', async () => {
    expect((await planTyped('买牛奶', CTX, ON, stub(record([item()], 0.3)))).alt).toBeNull();
  });
  it('离线时本机有迹象：offline_saved，按记下存，alt 带本机的判断（found true）', async () => {
    const call = stub(aiSearch(0.9));
    const p = await planTyped(UNSURE, CTX, { ...ON, online: false }, call);
    expect(call).not.toHaveBeenCalled();
    expect(p).toMatchObject({ status: 'offline_saved', origin: 'rule', ask: null, alt: { ask: { intent: 'search' }, found: true } });
    expect(p.items.length).toBeGreaterThan(0);
  });
});

// 负责人 11-27：“直接记下 ai 再识别”，选“像提问的照旧等 AI”（R-496）。env.later：要调 AI 的句子里，够条件的不调 AI、交回本机结果带 later
describe('planTyped 带 later：哪些句子先存、AI 后台再换', () => {
  const LATER = { ...ON, later: true };
  const later = async (text: string, ctx: TypeCtx = CTX, env: typeof LATER = LATER) => {
    const call = stub(aiSearch(0.99));
    const p = await planTyped(text, ctx, env, call);
    return { p, called: call.mock.calls.length };
  };
  it('本机没把握、看不出是提问、拆得出：不调 AI，交回本机结果、later 置上', async () => {
    for (const text of ['买牛奶', '跟小王那个会']) {
      const { p, called } = await later(text);
      expect(called, text).toBe(0);
      expect(p, text).toMatchObject({ later: true, origin: 'rule', status: 'saved', ask: null });
      expect(p.items.length, text).toBeGreaterThan(0);
    }
  });
  it('像提问的、有要问的过去月日的：照旧调 AI（不先存）', async () => {
    for (const text of [UNSURE, '10月30号交报告']) {
      const { p, called } = await later(text);
      expect(called, text).toBe(1);
      expect(p.later, text).toBeUndefined();
    }
  });
  it('本来就不调 AI 的（本机有把握的意图、离线、没开 AI、用完、日子越界）：和不带 later 一样，later 不置上', async () => {
    const cases: [string, TypeCtx, typeof LATER][] = [
      [SURE_SUM, CTX, LATER],
      ['买牛奶', CTX, { ...LATER, online: false }],
      ['买牛奶', CTX, { ...LATER, aiOn: false }],
      ['买牛奶', CTX, { ...LATER, quotaOut: true }],
      ['买牛奶', { ...CTX, day: '2019-01-01' }, LATER],
    ];
    for (const [text, ctx, env] of cases) {
      const { p, called } = await later(text, ctx, env);
      const plain = await planTyped(text, ctx, { ...env, later: false }, stub(aiSearch(0.99)));
      expect(called, text).toBe(0);
      expect(p, text).toEqual(plain);
    }
  });
  it('先存的句子不带 later 再跑（后台那一次）：调 AI，AI 判成查找也不交结果层（本机没迹象，AI 的不算数）', async () => {
    const call = stub(aiSearch(0.99));
    const p = await planTyped('跟小王那个会', CTX, ON, call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(p).toMatchObject({ origin: 'rule', ask: null });
  });
});
