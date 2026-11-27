// AI 助手确认卡片的拆和存（hooks/chat-recorder.ts；11-24 负责人“在 AI 里输入也可以记录日程跟待办”）：
// • 拆：打字条同一套本机规则；“明天、周五、下午三点”按用户所在时区（首尔）这一刻算；一句里几件事拆成几条；只出日程、待办；
//   整份结果交回：过去的月日带 confirm，不存在的日子、重复说法在 doubts、hints 里
// • 选“补记今年 / 明年”：打字条确认行同一个 applyConfirm
// • 存：打字条同一个保存口（saveCapture → captureRow → 写入口），source page、origin rule，raw_text 是交进来的原话；没存上回 null
import { describe, expect, it, vi } from 'vitest';
import type { Writer } from '../data/capture-save.ts';
import type { TypeCtx } from '../data/type-flow.ts';
import { chatRecorderOf } from '../hooks/chat-recorder.ts';

// 2026-11-24（周二）10:00 首尔
const NOW = Date.UTC(2026, 10, 24, 1, 0);
const ctx = (over: Partial<TypeCtx> = {}) => (): TypeCtx => ({ now: NOW, tz: 'Asia/Seoul', locale: 'zh', projects: ['工作'], day: null, ...over });

describe('chatRecorderOf.plan：本机规则拆', () => {
  const rec = chatRecorderOf(ctx());

  it('“明天下午三点和客户开会” → 明天 15:00 的日程', () => {
    expect(rec.plan('明天下午三点和客户开会').items).toMatchObject([{ kind: 'event', title: '和客户开会', date: '2026-11-25', time: '15:00', confirm: null }]);
  });

  it('“记一下周五前交报告” → 本周五截止的待办（“记一下”不进标题）', () => {
    expect(rec.plan('记一下周五前交报告').items).toMatchObject([{ kind: 'todo', title: '交报告', due: '2026-11-27' }]);
  });

  it('一句里两件事拆成两条：后一件沿用自己的日子', () => {
    const { items } = rec.plan('明天下午三点和客户开会，周五前交报告');
    expect(items.map((i) => [i.kind, i.title])).toEqual([['event', '和客户开会'], ['todo', '交报告']]);
  });

  it('按用户所在时区算“明天”：首尔已经过了午夜（UTC 还是前一天）', () => {
    // 2026-11-24 23:30 UTC = 首尔 11-25 08:30 → 明天是 11-26
    const late = chatRecorderOf(ctx({ now: Date.UTC(2026, 10, 24, 23, 30) }));
    expect(late.plan('明天下午三点开会').items[0]).toMatchObject({ date: '2026-11-26', time: '15:00' });
  });

  it('R-497 照以前怎么分的配了项目名（learned）：本机规则猜的固定类别、没给的换成它；原话说到的项目名（自建的、固定类别）照旧', () => {
    const fixed = rec.plan('明天早上游泳').items[0]?.project;
    expect(rec.plan('明天早上游泳', '健身').items[0]).toMatchObject({ project: '健身' });
    expect(rec.plan('明天早上游泳').items[0]?.project).toBe(fixed);
    // “工作”本身是固定类别，这里用自建项目名
    expect(chatRecorderOf(ctx({ projects: ['NEOX'] })).plan('明天上午十点NEOX周会', '健身').items[0]).toMatchObject({ project: 'NEOX' });
    // 原话里亲口说的固定类别（“工作”）也照旧，不被以前怎么分的换掉
    expect(rec.plan('明天上午十点工作周会', '健身').items[0]).toMatchObject({ project: '工作' });
  });

  it('认本机已有的项目名；像纪念日的说法也只出日程、待办（卡片只记这两类）', () => {
    expect(rec.plan('明天上午十点工作周会').items[0]).toMatchObject({ kind: 'event', project: '工作', time: '10:00' });
    expect(rec.plan('12月3日是结婚纪念日').items.every((i) => i.kind === 'event' || i.kind === 'todo')).toBe(true);
  });

  it('11 月说“1月5日下午三点开会”：带 confirm（今年 / 明年），选“明年”用打字条同一个 applyConfirm 改成 2027-01-05；待办改截止日', () => {
    const r = rec.plan('1月5日下午三点开会');
    expect(r.doubts).toContain('confirm');
    const [item] = r.items;
    expect(item).toMatchObject({ kind: 'event', confirm: { past: '2026-01-05', next: '2027-01-05' } });
    expect(rec.confirm(item!, 'next')).toMatchObject({ date: '2027-01-05', confirm: null });
    expect(rec.confirm(item!, 'past')).toMatchObject({ date: '2026-01-05', confirm: null });
    const [todo] = rec.plan('1月5日交报告').items;
    expect(rec.confirm(todo!, 'next')).toMatchObject({ kind: 'todo', due: '2027-01-05', confirm: null });
  });

  it('“2月30日交房租”：日子留空、doubts 有 bad_day、hints 记下是哪个月日（卡片据此提示，不悄悄记成不设截止）', () => {
    const r = rec.plan('2月30日交房租');
    expect(r.items[0]).toMatchObject({ kind: 'todo', due: null });
    expect(r.doubts).toContain('bad_day');
    expect(r.hints.bad_day).toEqual({ month: 2, day: 30 });
  });
});

describe('chatRecorderOf.save：打字条同一个保存口', () => {
  const writer = (ok = true) => {
    const insert = vi.fn<Writer['insert']>().mockResolvedValue(ok ? { ok: true, item: null } : { ok: false, reason: 'local_unavailable' });
    const patch = vi.fn<Writer['patch']>().mockResolvedValue({ ok: true, item: null });
    return { w: { insert, patch } as Writer, insert };
  };

  it('日程 → events 一行（source page、raw_text 是交进来的原话、有时刻带提醒）；回表和 id', async () => {
    const { w, insert } = writer();
    const rec = chatRecorderOf(ctx(), w);
    const [item] = rec.plan('明天下午三点和客户开会').items;
    const r = await rec.save(item!, '帮我记一下明天下午三点和客户开会');
    expect(r?.table).toBe('events');
    const [table, row, opts] = insert.mock.calls[0]!;
    expect(table).toBe('events');
    expect(row).toMatchObject({ id: r?.id, title: '和客户开会', date: '2026-11-25', time: '15:00', tz: 'Asia/Seoul', source: 'page', raw_text: '帮我记一下明天下午三点和客户开会' });
    expect(opts).toEqual({ remind: true });
  });

  it('待办 → todos 一行；写不进去回 null', async () => {
    const ok = writer();
    const rec = chatRecorderOf(ctx(), ok.w);
    const [item] = rec.plan('周五前交报告').items;
    expect((await rec.save(item!, '周五前交报告'))?.table).toBe('todos');
    expect(ok.insert.mock.calls[0]?.[1]).toMatchObject({ title: '交报告', due: '2026-11-27', source: 'page' });
    const bad = writer(false);
    expect(await chatRecorderOf(ctx(), bad.w).save(item!, '周五前交报告')).toBeNull();
  });
});
