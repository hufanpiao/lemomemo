// 判成查找、总结以后列出哪些（data/assist-list.ts；架构 5.14 第 3、4 点；B4b-3）：时间类按日子排、kinds、done、截止到、exclude、内容类关键词、
// 按日子分组、过期、总结送哪几条
import { describe, expect, it } from 'vitest';
import type { PlusQuery } from '../../../../shared/schema/intent.ts';
import { SUMMARY_MAX_ITEMS } from '../../../../shared/schema/summarize.ts';
import { byDay, isOverdue, listQuery, refsOf } from '../data/assist-list.ts';
import type { FindItem } from '../data/find-local.ts';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const it0 = (over: Partial<FindItem> & Pick<FindItem, 'kind' | 'id'>): FindItem => ({
  title: '', fields: [over.title ?? ''], date: null, time: null, extra: '', noteId: null, done: false, hasThumb: false, ...over,
});
const q = (over: Partial<PlusQuery> = {}): PlusQuery => ({ text: '', range: null, kinds: [], done: 'any', ...over });

const EV_LATE = it0({ kind: 'event', id: uid(1), title: '看牙医', date: '2026-11-10', time: '15:00' });
const EV_EARLY = it0({ kind: 'event', id: uid(2), title: '早会', date: '2026-11-10', time: '09:00' });
const EV_ALLDAY = it0({ kind: 'event', id: uid(3), title: '出差', date: '2026-11-11' });
const TD_OPEN = it0({ kind: 'todo', id: uid(4), title: '交发票', date: '2026-11-09' });
const TD_DONE = it0({ kind: 'todo', id: uid(5), title: '交报告', date: '2026-11-10', done: true });
const TD_NODUE = it0({ kind: 'todo', id: uid(6), title: '买牛奶' });
const NOTE = it0({ kind: 'note', id: uid(7), title: '拉面店', fields: ['拉面店', '弘大那家拉面', ''], date: '2026-11-10' });
const IMG = it0({ kind: 'image', id: uid(8), title: '一碗拉面', date: '2026-11-10', noteId: uid(7) });
const FILE = it0({ kind: 'file', id: uid(9), title: '发票.pdf', date: '2026-11-10', noteId: uid(7) });
const ANNIV = it0({ kind: 'anniv', id: uid(10), title: '妈妈生日', date: '2026-11-10' });
const INDEX = [EV_LATE, EV_EARLY, EV_ALLDAY, TD_OPEN, TD_DONE, TD_NODUE, NOTE, IMG, FILE, ANNIV];
const ids = (xs: readonly FindItem[]) => xs.map((x) => x.id);
const WEEK = { from: '2026-11-09', to: '2026-11-15' };

describe('listQuery：时间类（range 不为空）', () => {
  it('按日子、时刻排：同一天时刻早的在前，全天（没时刻）排在同一天最后；没有日子的待办不进；纪念日不进', () => {
    const got = listQuery(INDEX, q({ range: WEEK }));
    expect(ids(got)).toEqual([uid(4), uid(2), uid(1), uid(5), uid(7), uid(8), uid(9), uid(3)]);
    expect(got.some((x) => x.kind === 'anniv' || x.id === TD_NODUE.id)).toBe(false);
  });
  it('query.text 不再过滤（只按 range、kinds、done 列）', () => {
    expect(ids(listQuery(INDEX, q({ range: WEEK, text: '牙医', kinds: ['event'] })))).toEqual([uid(2), uid(1), uid(3)]);
  });
  it('kinds：只要 event；note 连带这条随手记里的图片、文档；空 = 三种都要', () => {
    expect(ids(listQuery(INDEX, q({ range: WEEK, kinds: ['event'] })))).toEqual([uid(2), uid(1), uid(3)]);
    expect(listQuery(INDEX, q({ range: WEEK, kinds: ['note'] })).map((x) => x.kind)).toEqual(['note', 'image', 'file']);
    expect(listQuery(INDEX, q({ range: WEEK, kinds: [] }))).toHaveLength(8);
  });
  it('done：open 只要没做完的待办，done 只要做完的，any 都要；不影响日程、随手记', () => {
    const todos = (done: PlusQuery['done']) => ids(listQuery(INDEX, q({ range: WEEK, kinds: ['todo'], done })));
    expect(todos('open')).toEqual([uid(4)]);
    expect(todos('done')).toEqual([uid(5)]);
    expect(todos('any')).toEqual([uid(4), uid(5)]);
    expect(listQuery(INDEX, q({ range: WEEK, kinds: ['event'], done: 'done' }))).toHaveLength(3);
  });
  it('range.from 为 null = 截止到 to（含更早的）', () => {
    const old = it0({ kind: 'todo', id: uid(11), title: '旧的', date: '2025-01-01' });
    expect(ids(listQuery([...INDEX, old], q({ range: { from: null, to: '2026-11-09' }, kinds: ['todo'], done: 'open' })))).toEqual([uid(11), uid(4)]);
  });
  it('范围两头都算；范围外的不出', () => {
    expect(ids(listQuery(INDEX, q({ range: { from: '2026-11-11', to: '2026-11-11' } })))).toEqual([uid(3)]);
    expect(listQuery(INDEX, q({ range: { from: '2026-12-01', to: '2026-12-31' } }))).toEqual([]);
  });
  it('exclude：排除给的 id；排除的是随手记时它的图片、文档也排除', () => {
    expect(ids(listQuery(INDEX, q({ range: WEEK }), new Set([uid(1), uid(7)])))).toEqual([uid(4), uid(2), uid(5), uid(3)]);
  });
});

describe('listQuery：内容类（range 为空）', () => {
  it('按关键词找，再按 kinds、done 筛；关键词为空返回空', () => {
    expect(ids(listQuery(INDEX, q({ text: '拉面' }))).sort()).toEqual([uid(7), uid(8)].sort());
    expect(ids(listQuery(INDEX, q({ text: '拉面', kinds: ['event'] })))).toEqual([]);
    expect(ids(listQuery(INDEX, q({ text: '交', kinds: ['todo'], done: 'open' })))).toEqual([uid(4)]);
    expect(listQuery(INDEX, q({ text: '  ' }))).toEqual([]);
    expect(listQuery(INDEX, q({ text: '妈妈' }))).toEqual([]);
  });
  it('exclude 同样生效', () => {
    expect(listQuery(INDEX, q({ text: '拉面' }), new Set([uid(7)]))).toEqual([]);
  });
});

describe('byDay、isOverdue', () => {
  it('按日子分组（已排好序），没有日子的跳过', () => {
    const g = byDay([TD_OPEN, EV_EARLY, EV_LATE, TD_NODUE, EV_ALLDAY]);
    expect(g.map((d) => [d.date, ids(d.items)])).toEqual([
      ['2026-11-09', [uid(4)]], ['2026-11-10', [uid(2), uid(1)]], ['2026-11-11', [uid(3)]],
    ]);
    expect(byDay([])).toEqual([]);
  });
  it('过期：待办、没做完、截止日早于今天；今天的、做完的、日程、没截止日的不算', () => {
    expect(isOverdue(TD_OPEN, '2026-11-10')).toBe(true);
    expect(isOverdue(TD_OPEN, '2026-11-09')).toBe(false);
    expect(isOverdue({ ...TD_OPEN, done: true }, '2026-11-10')).toBe(false);
    expect(isOverdue(EV_LATE, '2026-11-20')).toBe(false);
    expect(isOverdue(TD_NODUE, '2026-11-20')).toBe(false);
  });
});

describe('refsOf：总结送哪几条', () => {
  it('图片、文档换成所在随手记；去重；纪念日不送', () => {
    expect(refsOf([EV_LATE, IMG, NOTE, FILE, TD_OPEN, ANNIV])).toEqual({
      refs: [{ kind: 'event', id: uid(1) }, { kind: 'note', id: uid(7) }, { kind: 'todo', id: uid(4) }], more: 0,
    });
  });
  it('没有所在随手记的图片跳过', () => {
    expect(refsOf([{ ...IMG, noteId: null }])).toEqual({ refs: [], more: 0 });
  });
  it(`超过 ${SUMMARY_MAX_ITEMS} 条：只送前 ${SUMMARY_MAX_ITEMS} 条，more 记多出的`, () => {
    const many = Array.from({ length: SUMMARY_MAX_ITEMS + 3 }, (_v, i) => it0({ kind: 'todo', id: uid(100 + i), date: '2026-11-10' }));
    const r = refsOf(many);
    expect(r.refs).toHaveLength(SUMMARY_MAX_ITEMS);
    expect(r.refs[0]).toEqual({ kind: 'todo', id: uid(100) });
    expect(r.more).toBe(3);
  });
});
