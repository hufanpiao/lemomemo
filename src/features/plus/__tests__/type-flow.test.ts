// 打字流程（data/type-flow.ts；B3 任务单 S2、FA-2、Q2；架构 5.1、5.11；R-54、R-353）。不调真 Gemini，AI 一律用桩
import { describe, expect, it, vi } from 'vitest';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { aiReqCtx, applyConfirm, askAi, type CallAi, fillDay, keepAsked, mergeItems, needsConfirm, planLocal, planTyped, SendError, splitConfirm, type TypeCtx } from '../data/type-flow.ts';

/** 2026-11-02（周一）10:00 首尔 */
const NOW = Date.UTC(2026, 10, 2, 1, 0);
const CTX: TypeCtx = { now: NOW, tz: 'Asia/Seoul', locale: 'zh', projects: [], day: null };
const ON = { online: true, aiOn: true, quotaOut: false };

const item = (over: Partial<AiItem> = {}): AiItem => ({
  kind: 'todo', title: 'AI title', date: null, time: null, duration_min: null, due: '2026-11-05', important: false,
  project: null, body: null, short: 'AI', date_basis: 'rel', anniv: null, confirm: null, ...over,
});
const record = (items: AiItem[], left = 7) => ({ intent: 'record', confidence: 1, items, quota_left: left });
const stub = (ret: unknown): CallAi & ReturnType<typeof vi.fn> => vi.fn(async () => ret);

describe('有把握就不调 AI（R-54）', () => {
  it('“明天下午3点去银行办理业务”：直接用本机结果，不花次数', async () => {
    const call = stub(record([item()]));
    const p = await planTyped('明天下午3点去银行办理业务', CTX, ON, call);
    expect(call).not.toHaveBeenCalled();
    expect(p).toMatchObject({ status: 'saved', origin: 'rule' });
    expect(p.items[0]).toMatchObject({ kind: 'event', date: '2026-11-03', time: '15:00' });
  });
});

describe('aiReqCtx：打字、录音共用的请求上下文（项目名、选中的日子只在这里整理）', () => {
  it('项目名规整（去空白、去重、最多 30 个）；没选日子不带 default_day', () => {
    const many = Array.from({ length: 35 }, (_v, i) => `P${i}`);
    expect(aiReqCtx({ ...CTX, projects: [' NEOX ', 'NEOX', '', ...many] })).toEqual({
      now: NOW, tz: 'Asia/Seoul', locale: 'zh', projects: ['NEOX', ...many.slice(0, 29)], scope: 'main',
    });
  });
  it('选中的日子在范围里带上；超出后端认的范围返回 bad_default_day', () => {
    expect(aiReqCtx({ ...CTX, day: '2026-11-20' })).toMatchObject({ default_day: '2026-11-20' });
    expect(aiReqCtx({ ...CTX, day: '2020-01-01' })).toBe('bad_default_day');
  });
});

describe('没把握', () => {
  it('在线、开着 AI、有次数 → ai-parse；请求体照接口第 2 条', async () => {
    const call = stub(record([item()], 12));
    const p = await planTyped('买牛奶', { ...CTX, projects: ['SignPlex', ''] }, ON, call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toEqual({ text: '买牛奶', now: NOW, tz: 'Asia/Seoul', locale: 'zh', projects: ['SignPlex'], scope: 'main' });
    expect(p).toMatchObject({ status: 'saved', origin: 'ai', quotaLeft: 12 });
    expect(p.items[0]?.title).toBe('AI title');
  });

  it('离线 → 本机结果，offline_saved，不调 AI', async () => {
    const call = stub(record([item()]));
    const p = await planTyped('买牛奶', CTX, { ...ON, online: false }, call);
    expect(call).not.toHaveBeenCalled();
    expect(p).toMatchObject({ status: 'offline_saved', origin: 'rule' });
    expect(p.items[0]?.title).toBe('买牛奶');
  });

  it('本机记着用完了 → 本机结果 + quota_out，不调 AI', async () => {
    const call = stub(record([item()]));
    expect(await planTyped('买牛奶', CTX, { ...ON, quotaOut: true }, call)).toMatchObject({ status: 'quota_out', origin: 'rule' });
    expect(call).not.toHaveBeenCalled();
  });

  it('关了 AI → 本机结果，不出“AI 没回应”', async () => {
    expect(await planTyped('买牛奶', CTX, { ...ON, aiOn: false }, stub(null))).toMatchObject({ status: 'saved', origin: 'rule' });
  });

  it('Q2 ②：不认识的 intent → 退回本机规则，原话不丢', async () => {
    const p = await planTyped('买牛奶', CTX, ON, stub({ intent: 'search', confidence: 1, items: [item()], quota_left: 3 }));
    expect(p).toMatchObject({ status: 'saved_rule', origin: 'rule', aiReason: 'unknown_intent' });
    expect(p.items.map((i) => i.title)).toEqual(['买牛奶']);
  });

  it.each([
    [{ ai_failed: true, reason: 'timeout' }, 'saved_rule'],
    [{ fallback: true, reason: 'error' }, 'saved_rule'],
    [{ fallback: true, reason: 'feature_off' }, 'saved'],
    [{ fallback: true, reason: 'quota' }, 'quota_out'],
    [{ quota_out: true, quota_left: 0 }, 'quota_out'],
    [{ consent_required: true }, 'saved'],
    ['garbage', 'saved_rule'],
    [record([]), 'saved_rule'],
  ])('返回 %j → %s，用本机结果', async (ret, status) => {
    const p = await planTyped('买牛奶', CTX, ON, stub(ret));
    expect(p).toMatchObject({ status, origin: 'rule' });
    expect(p.items[0]?.title).toBe('买牛奶');
  });

  it('额度用完时 quotaLeft 记成 0', async () => {
    expect((await planTyped('买牛奶', CTX, ON, stub({ quota_out: true, quota_left: 0 }))).quotaLeft).toBe(0);
  });

  it('hints：AI 结果也带“重复”“自己排时间”的附加句', async () => {
    const p = await planTyped('排一下时间和客户开会', CTX, ON, stub(record([item()])));
    expect(p.hints).toEqual({ recur: false, arrange: true, bad_day: null });
  });
});

describe('askAi：6 秒超时，只在网络错误时自动重试 1 次', () => {
  const REQ = { text: 'x', now: NOW, tz: 'Asia/Seoul', locale: 'zh' as const, projects: [], scope: 'main' as const };

  it('网络错误：重试 1 次，第二次成了就用', async () => {
    const call = vi.fn<CallAi>().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(record([item()]));
    expect((await askAi(REQ, call)).kind).toBe('record');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('网络错误两次：ai_failed(network)，一共只发 2 次', async () => {
    const call = vi.fn<CallAi>().mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await askAi(REQ, call)).toEqual({ kind: 'ai_failed', reason: 'network' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('HTTP 错误不重试', async () => {
    const call = vi.fn<CallAi>().mockRejectedValue(new SendError('http'));
    expect(await askAi(REQ, call)).toEqual({ kind: 'ai_failed', reason: 'http' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('超时：中止请求，不重试', async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | null = null;
      const call = vi.fn<CallAi>((_r, signal) => {
        seen = signal;
        return new Promise((_ok, bad) => signal.addEventListener('abort', () => bad(signal.reason)));
      });
      const p = askAi(REQ, call);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await p).toEqual({ kind: 'ai_failed', reason: 'timeout' });
      expect(call).toHaveBeenCalledTimes(1);
      expect(seen).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('R-353、R-359：日历页没说日子记到选中的那天（default_day，任务单 R6、R9）', () => {
  const CAL: TypeCtx = { ...CTX, day: '2026-11-20' };
  it('fillDay（AI 漏补时兜底）：没日子的日程、没截止日的待办（有没有时刻都算）补选中的日子（basis rel）；说了日子的不动', () => {
    const out = fillDay([item({ kind: 'event', date: null, due: null }), item({ due: null, time: '15:00' }), item({ due: null }), item({ due: '2026-11-03' })], '2026-11-20');
    expect(out[0]).toMatchObject({ date: '2026-11-20', date_basis: 'rel' });
    expect(out[1]).toMatchObject({ due: '2026-11-20', date_basis: 'rel' });
    expect(out[2]).toMatchObject({ due: '2026-11-20', date_basis: 'rel' });
    expect(out[3]).toMatchObject({ due: '2026-11-03' });
  });
  it('不在日历页（day 为 null）不动', () => {
    expect(fillDay([item({ kind: 'event', date: null })], null)[0]?.date).toBeNull();
  });
  it('本机规则：“下午三点开会”记 11-20；“明天开会”记真实的明天；“买牛奶”记 11-20 的待办', () => {
    expect(planLocal('下午三点开会', CAL).result.items[0]).toMatchObject({ kind: 'event', date: '2026-11-20', time: '15:00' });
    expect(planLocal('明天下午3点去银行办理业务', CAL).result.items[0]?.date).toBe('2026-11-03');
    expect(planLocal('买牛奶', CAL).result.items[0]).toMatchObject({ kind: 'todo', due: '2026-11-20' });
  });
  it('R9：补出来的日子不算认出了日子：“买牛奶”传不传选中的日子都没把握；“明天买牛奶”都有把握', () => {
    for (const ctx of [CTX, CAL]) {
      expect(planLocal('买牛奶', ctx).sure).toBe(false);
      expect(planLocal('明天买牛奶', ctx).sure).toBe(true);
    }
  });
  it('没把握、在线：ai-parse 请求体带 default_day；今天页（day 为 null）不带', async () => {
    const call = stub(record([item({ title: '买牛奶', due: '2026-11-20' })]));
    await planTyped('买牛奶', CAL, ON, call);
    expect(call.mock.calls[0]?.[0]).toMatchObject({ default_day: '2026-11-20' });
    const call2 = stub(record([item()]));
    await planTyped('买牛奶', CTX, ON, call2);
    expect(call2.mock.calls[0]?.[0]).not.toHaveProperty('default_day');
  });
  it('AI 漏补日子：兜底记到选中那天', async () => {
    const p = await planTyped('买牛奶', CAL, ON, stub(record([item({ title: '买牛奶', due: null })])));
    expect(p).toMatchObject({ origin: 'ai', status: 'saved' });
    expect(p.items[0]).toMatchObject({ due: '2026-11-20' });
  });
  it('选中的日子超出前 1 年到后 5 年（后端会回 400）：不调 AI、不花次数，用本机结果（日子由本机规则按同一范围定，不越过它补），不出“AI 没回应”', async () => {
    for (const day of ['2024-11-01', '2032-01-01'] as const) {
      const call = stub(record([item()]));
      const p = await planTyped('买牛奶', { ...CTX, day }, ON, call);
      expect(call).not.toHaveBeenCalled();
      expect(p).toMatchObject({ status: 'saved', origin: 'rule', aiReason: 'bad_default_day' });
      expect(p.items).toEqual(planLocal('买牛奶', { ...CTX, day }).result.items);
    }
  });
  it('后端仍回 400（http）：退回本机结果，记到选中那天', async () => {
    const call: CallAi = vi.fn(async () => {
      throw new SendError('http');
    });
    const p = await planTyped('买牛奶', CAL, ON, call);
    expect(p).toMatchObject({ status: 'saved_rule', origin: 'rule', aiReason: 'http' });
    expect(p.items[0]).toMatchObject({ due: '2026-11-20' });
  });
  it('AI 回空列表（empty_items，R7）：退回本机结果，记到选中那天', async () => {
    const p = await planTyped('买牛奶', CAL, ON, stub(record([])));
    expect(p.origin).toBe('rule');
    expect(p.items[0]).toMatchObject({ due: '2026-11-20' });
  });
});

describe('过去的月日先问（R-166）', () => {
  it('“10月30号下午两点和客户开会”：带 confirm，没选之前不能存', async () => {
    const p = await planTyped('10月30号下午两点和客户开会', CTX, { ...ON, aiOn: false }, stub(null));
    expect(needsConfirm(p.items)).toBe(true);
    const it0 = p.items[0];
    if (!it0) throw new Error('没有结果');
    expect(applyConfirm(it0, 'next')).toMatchObject({ date: '2027-10-30', confirm: null });
    expect(applyConfirm(it0, 'past')).toMatchObject({ date: '2026-10-30', confirm: null });
  });
  it('待办改的是 due', () => {
    const it0 = item({ due: '2026-10-01', confirm: { past: '2026-10-01', next: '2027-10-01' } });
    expect(applyConfirm(it0, 'next')).toMatchObject({ due: '2027-10-01', confirm: null });
  });
});

describe('同一批里先存的和要问的（R-166）、合并成一条', () => {
  it('splitConfirm：没 confirm 的先存，有 confirm 的等用户选', () => {
    const a = item({ title: 'a' });
    const b = item({ title: 'b', confirm: { past: '2026-10-01', next: '2027-10-01' } });
    expect(splitConfirm([a, b])).toEqual({ ready: [a], ask: [b] });
  });
  it('mergeItems：整句原话当标题，类型和日子取第一条，不带简称', () => {
    const m = mergeItems([item({ kind: 'event', date: '2026-11-03', time: '10:00', short: 'x' }), item()], '  明天十点开会，下午三点去银行  ');
    expect(m).toMatchObject({ kind: 'event', title: '明天十点开会，下午三点去银行', date: '2026-11-03', time: '10:00', short: null, confirm: null });
    expect(mergeItems([], 'x')).toBeNull();
    expect(mergeItems([item()], '   ')).toBeNull();
  });
});

describe('确认行没选就关掉：原话去掉已经存了的几条（keepAsked；R-166，主持人 11-07 定）', () => {
  const parse = (t: string) => planLocal(t, CTX).result.items;
  const run = (raw: string): string | null => {
    const { ready, ask } = splitConfirm(parse(raw));
    return keepAsked(raw, ready, ask, parse);
  };
  it('只留等确认那条的原文；前面只说了日子的一段一起留下，原来的逗号照留', () => {
    expect(run('明天下午3点去银行办理业务，10月30号下午两点和客户开会')).toBe('10月30号下午两点和客户开会');
    expect(run('10月30号，下午两点和客户开会，明天买牛奶')).toBe('10月30号，下午两点和客户开会');
    expect(run('买牛奶然后10月30号交报告')).toBe('10月30号交报告');
    expect(run('우유 사기, 10월 30일 오후 2시 회의')).toBe('10월 30일 오후 2시 회의');
  });
  it('一条都没存（全是要问的）：原话整句留着', () => {
    expect(run('10月30号开会，交报告')).toBe('10月30号开会，交报告');
  });
  it('去不干净返回 null：顿号列举在同一段、标题被 AI 改过、同一个标题出现两次', () => {
    expect(run('买牛奶、10月30号交报告和明天开会')).toBeNull();
    const asked = item({ kind: 'event', title: '客户会议', date: '2026-10-30', confirm: { past: '2026-10-30', next: '2027-10-30' } });
    expect(keepAsked('明天买牛奶，10月30号和客户开会', [item({ title: '买牛奶' })], [asked], parse)).toBeNull();
    const twice = splitConfirm(parse('开会，10月30号开会'));
    expect(keepAsked('开会，10月30号开会', twice.ready, twice.ask, parse)).toBeNull();
  });
});
