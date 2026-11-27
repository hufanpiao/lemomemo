// 打字条的签（data/type-fields.ts，方案丙 11-21）：识别填签、手选优先、手选日期不拆条、提醒默认，以及写库时提醒开关落到哪几列（shared/logic/capture-map.ts）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { captureRow, type CaptureCtx } from '../../../../shared/logic/capture-map.ts';
import { remindAsked } from '../../../../shared/logic/parse/index.ts';
import { remindAtOf } from '../../../../shared/logic/remind.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { applyPicks, dayChoices, fieldsOf, type Picks } from '../data/type-fields.ts';
import { planLocal, type TypeCtx } from '../data/type-flow.ts';

// UTC 中午：首尔 21:00 还是 11-21（周六）
const NOW = msAt('2026-11-21', 12 * 60, 'UTC');
const CTX: TypeCtx = { now: NOW, tz: 'Asia/Seoul', locale: 'zh', projects: ['工作', '生活'], day: null };
const local = (text: string): AiItem[] => planLocal(text, CTX).result.items;
const fields = (text: string, picks: Picks = {}, fallback: 'todo' | 'event' = 'todo') => fieldsOf(local(text), picks, { fallback, remindWord: remindAsked(text) });

const base = (over: Partial<AiItem>): AiItem => ({
  kind: 'todo', title: '买牛奶', date: null, time: null, duration_min: null, due: null, important: false, project: null, body: null, short: null,
  date_basis: null, anniv: null, confirm: null, ...over,
});
const cctx: CaptureCtx = { id: 'i1', batchId: 'b1', now: NOW, today: '2026-11-21', tz: 'Asia/Seoul', source: 'page', rawText: 'x', origin: 'rule' };

describe('识别填签', () => {
  it('“明天下午3点 工作 开会 提醒我”：分类、日期时刻、提醒都认出来（浅黄）', () => {
    const f = fields('明天下午3点 工作 开会 提醒我');
    expect(f).toMatchObject({ kind: 'event', project: '工作', date: '2026-11-22', time: '15:00', remind: true });
    expect(f.auto).toEqual({ project: true, date: true, remind: true });
  });

  it('没说的不填：“买牛奶”分类、日期空着，没时刻提醒不亮；没认出类型按 fallback', () => {
    expect(fields('买牛奶')).toMatchObject({ kind: 'todo', project: null, date: null, time: null, remind: false, auto: { project: false, date: false, remind: false } });
    expect(fieldsOf([], {}, { fallback: 'event', remindWord: false }).kind).toBe('event');
  });

  it('提醒默认：有时刻就亮（不是认出来的，画柠檬黄）；话里说了“提醒我”才算认出来', () => {
    const f = fields('明天下午3点开会');
    expect(f.remind).toBe(true);
    expect(f.auto.remind).toBe(false);
    expect(remindAsked('알림 설정해 줘')).toBe(true);
    expect(remindAsked('提醒小王交材料')).toBe(false);
  });
});

describe('手选优先', () => {
  it('点过的格子盖过识别结果，签不再是浅黄；没点的照旧', () => {
    const f = fields('明天下午3点 工作 开会', { project: '生活', remind: false });
    expect(f).toMatchObject({ project: '生活', date: '2026-11-22', time: '15:00', remind: false });
    expect(f.auto).toEqual({ project: false, date: true, remind: false });
    expect(fields('明天 工作 开会', { project: null }).project, '点了“不分类”').toBeNull();
    expect(fields('明天下午3点开会', { time: null }).time, '点了“全天”').toBeNull();
  });

  it('记下时（本机或 AI 的结果）只改点过的格子：AI 给的标题、类型、别的格子不动', () => {
    const ai = [base({ kind: 'event', title: '开会', date: '2026-11-23', time: '10:00', duration_min: 30, project: '工作', date_basis: 'rel' })];
    const [out] = applyPicks(ai, { time: '14:00' }, '后天上午10点开会', false);
    expect(out).toMatchObject({ kind: 'event', title: '开会', date: '2026-11-23', time: '14:00', duration_min: 30, project: '工作' });
    expect(out && 'remind' in out, '没点提醒、没说提醒我：不带开关，照默认').toBe(false);
  });

  it('手选了日期：一句话不再拆成多条，标题是整句原话；日子换成手选的、不再问过去的月日', () => {
    const items = local('买牛奶，交周报');
    expect(items).toHaveLength(2);
    const out = applyPicks(items, { date: '2026-11-25' }, '买牛奶，交周报', false);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: '买牛奶，交周报', due: '2026-11-25', date_basis: 'ymd', confirm: null });
    expect(applyPicks(items, { project: '工作' }, '买牛奶，交周报', false), '没点日期照旧拆').toHaveLength(2);
  });

  it('日程：全天点了跨天 → 时长按天记；原来全天、点了时刻 → 时长回到默认 1 小时（不带成 2 天）', () => {
    const allDay = [base({ kind: 'event', title: '出差', date: '2026-11-23', date_basis: 'rel', duration_min: 1440 })];
    expect(applyPicks(allDay, { span: 3 }, '后天出差', false)[0]?.duration_min).toBe(3 * 1440);
    const two = [base({ kind: 'event', title: '出差', date: '2026-11-23', date_basis: 'rel', duration_min: 2880 })];
    expect(applyPicks(two, { time: '09:00' }, '后天出差', false)[0]).toMatchObject({ time: '09:00', duration_min: 60 });
    expect(applyPicks(two, { time: '09:00', dur: 120 }, '后天出差', false)[0]?.duration_min).toBe(120);
  });

  it('日期签的几个选项：今天、明天、后天、下周一（今天周六 → 下周一是 2 天后；今天周一 → 7 天后）', () => {
    expect(dayChoices('2026-11-21').map((c) => c.date)).toEqual(['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-23']);
    expect(dayChoices('2026-11-23').at(-1)?.date).toBe('2026-11-30');
  });
});

describe('写库的提醒列（capture-map 的 remind）', () => {
  const row = (it: AiItem & { remind?: boolean }) => captureRow(it, cctx)?.row as Record<string, unknown>;

  it('待办：有时刻默认提前 60、点掉 null；没时刻点亮且有截止日 → remind_days 0，没截止日不提醒', () => {
    const timed = base({ due: '2026-11-22', time: '15:00', date_basis: 'rel' });
    expect(row(timed)).toMatchObject({ due_time: '15:00', remind_before_min: 60, remind_days: null });
    expect(row({ ...timed, remind: false })).toMatchObject({ remind_before_min: null, remind_days: null });
    expect(row({ ...base({ due: '2026-11-22', date_basis: 'rel' }), remind: true })).toMatchObject({ due_time: null, remind_before_min: null, remind_days: 0, remind_time: '09:00' });
    expect(row({ ...base({}), remind: true })).toMatchObject({ due: null, remind_days: null });
  });

  it('日程：有时刻默认 15、点掉 null；全天点亮 → remind_days 0（当天 remind.default_time），没点 null（不提醒）', () => {
    const timed = base({ kind: 'event', title: '开会', date: '2026-11-22', time: '15:00', date_basis: 'rel' });
    expect(row(timed)).toMatchObject({ remind_min: 15, remind_days: null });
    expect(row({ ...timed, remind: false })).toMatchObject({ remind_min: null, remind_days: null });
    const allDay = base({ kind: 'event', title: '出差', date: '2026-11-22', date_basis: 'rel' });
    const on = row({ ...allDay, remind: true });
    expect(on).toMatchObject({ time: null, remind_min: null, remind_days: 0 });
    expect(row(allDay)).toMatchObject({ remind_days: null });
    // 0 真会响（当天 09:00），null 不响
    const ev = { date: '2026-11-22', time: null, tz: null, remind_min: null, deleted_at: null };
    expect(remindAtOf('event', { ...ev, remind_days: 0 }, 'Asia/Seoul', NOW)).toBe(msAt('2026-11-22', 9 * 60, 'Asia/Seoul'));
    expect(remindAtOf('event', { ...ev, remind_days: null }, 'Asia/Seoul', NOW)).toBeNull();
  });
});
