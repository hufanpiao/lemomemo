// 电脑版布局的纯逻辑（layout-model.ts、layout-migrate.ts；架构 5.9b 第 2、4、5 点）：读出来的值怎么修正、拖动 / 键盘移动 / 调栏宽 / 收起怎么改
import { describe, expect, it } from 'vitest';
import { LAYOUT_V, type DeskLayoutValue } from '../../../../../shared/schema/layout.ts';
import { migrateLayout } from '../layout-migrate.ts';
import { COL_MAX, dropEmpty, fitWidths, minFracOf, moveBy, moveTo, readLayout, resizeAt, resizeRange, sameLayout, setCollapsed, toStored, whereIs } from '../layout-model.ts';

const DEF: DeskLayoutValue = {
  v: LAYOUT_V,
  cols: [
    { w: 0.56, panels: ['now', 'river'] },
    { w: 0.44, panels: ['week', 'soon', 'notes'] },
  ],
  collapsed: [],
  drawer: 'right',
  locked: false,
};
const MIN = minFracOf(1200); // 0.2
const panelsOf = (l: DeskLayoutValue) => l.cols.map((c) => c.panels);
const sum = (ws: readonly number[]) => ws.reduce((a, b) => a + b, 0);

describe('readLayout：读出来的值', () => {
  it('没存 → 默认（none）；JSON 字符串也认', () => {
    expect(readLayout(undefined, DEF)).toEqual({ layout: DEF, status: 'none' });
    expect(readLayout(null, DEF).status).toBe('none');
    const r = readLayout(JSON.stringify({ ...DEF, cols: [DEF.cols[1], DEF.cols[0]] }), DEF, MIN);
    expect(r.status).toBe('ok');
    expect(panelsOf(r.layout)).toEqual([['week', 'soon', 'notes'], ['now', 'river']]);
  });

  it('默认读的时候不按 1280 宽夹最窄：大屏上拖到 0.15 的栏读回来还是 0.15，和存的值 sameLayout', () => {
    const saved = { ...DEF, cols: [{ w: 0.15, panels: ['now'] }, { w: 0.45, panels: ['river'] }, { w: 0.4, panels: ['week', 'soon', 'notes'] }] };
    const { layout } = readLayout(JSON.stringify(toStored(saved)), DEF);
    expect(layout.cols.map((c) => Math.round(c.w * 1000) / 1000)).toEqual([0.15, 0.45, 0.4]);
    expect(sameLayout(layout, saved)).toBe(true);
  });

  it('坏 JSON、不是对象、没有 v、过不了 zod → 默认（invalid）', () => {
    for (const bad of ['{坏', 3, [], { cols: [] }, { v: 1, cols: 'x' }, { v: 1, cols: [{ w: 'a', panels: [] }] }]) {
      expect(readLayout(bad, DEF)).toEqual({ layout: DEF, status: 'invalid' });
    }
  });

  it('v 比现在大（新版本写的）→ 默认、标 newer（调用方不覆盖）', () => {
    expect(readLayout({ ...DEF, v: LAYOUT_V + 1 }, DEF)).toEqual({ layout: DEF, status: 'newer' });
  });

  it('不认识的块丢掉、重复的只留第一个、缺的按默认位置补、空栏去掉', () => {
    const raw = { v: 1, cols: [{ w: 0.5, panels: ['zzz', 'river', 'river'] }, { w: 0.5, panels: ['old'] }, { w: 0.3, panels: ['week', 'now'] }] };
    const { layout, status } = readLayout(raw, DEF, MIN);
    expect(status).toBe('ok');
    // 存下的位置保留（now 在第 3 栏）；缺的 soon、notes 按默认位置补进第 2 栏（那一栏的块都不认识、本来是空的，补完就不空了）
    expect(panelsOf(layout)).toEqual([['river'], ['soon', 'notes'], ['week', 'now']]);
  });

  it('栏数不在 1～4 用默认的栏；drawer 不认识当 right；collapsed 去掉不认识的和重复的', () => {
    const five = { v: 1, cols: Array.from({ length: 5 }, () => ({ w: 0.2, panels: ['now'] })), drawer: 'up', collapsed: ['soon', 'soon', 'x'] };
    const { layout } = readLayout(five, DEF, MIN);
    expect(panelsOf(layout)).toEqual(panelsOf(DEF));
    expect(layout.drawer).toBe('right');
    expect(layout.collapsed).toEqual(['soon']);
  });

  it('栏宽越界：归一化以后每栏仍在 [最窄, 0.6]，加起来是 1', () => {
    const { layout } = readLayout({ v: 1, cols: [{ w: 0.95, panels: ['now', 'river'] }, { w: 0.01, panels: ['week', 'soon', 'notes'] }] }, DEF, MIN);
    const ws = layout.cols.map((c) => c.w);
    expect(sum(ws)).toBeCloseTo(1);
    expect(ws[0]).toBe(COL_MAX);
    expect(ws[1]).toBeCloseTo(1 - COL_MAX);
  });
});

describe('layout-migrate：逐版升', () => {
  it('v 等于现在：原样；中间缺一步：null；步骤没把 v 往上加：null', () => {
    expect(migrateLayout({ v: LAYOUT_V, a: 1 })).toEqual({ v: LAYOUT_V, a: 1 });
    expect(migrateLayout({ v: 0 }, {})).toBeNull();
    expect(migrateLayout({ v: 0 }, { 0: (r) => r })).toBeNull();
  });

  it('有步骤时逐版升到现在的版本', () => {
    expect(migrateLayout({ v: 0, x: 1 }, { 0: (r) => ({ ...r, v: 1, y: 2 }) })).toEqual({ v: 1, x: 1, y: 2 });
  });
});

describe('拖动、键盘移动、收起', () => {
  it('moveTo：跨栏插到指定位置；拖空一栏放下时去掉、宽度重分；途中 keepEmpty 留着', () => {
    expect(panelsOf(moveTo(DEF, 'week', 0, 1, MIN))).toEqual([['now', 'week', 'river'], ['soon', 'notes']]);
    const one = { ...DEF, cols: [{ w: 0.3, panels: ['now'] }, { w: 0.7, panels: ['river', 'week', 'soon', 'notes'] }] };
    expect(moveTo(one, 'now', 1, 0, MIN, true).cols).toHaveLength(2);
    const dropped = moveTo(one, 'now', 1, 0, MIN);
    expect(dropped.cols).toHaveLength(1);
    expect(dropped.cols[0]?.w).toBe(1);
    expect(moveTo(DEF, 'week', 5, 0, MIN)).toBe(DEF);
  });

  it('moveBy：↑↓ 本栏挪一格（跳过收起的），← → 相邻栏同一高度，到头原样', () => {
    expect(panelsOf(moveBy(DEF, 'soon', 'up', MIN))).toEqual([['now', 'river'], ['soon', 'week', 'notes']]);
    expect(moveBy(DEF, 'week', 'up', MIN)).toBe(DEF);
    expect(panelsOf(moveBy(DEF, 'soon', 'left', MIN))).toEqual([['now', 'soon', 'river'], ['week', 'notes']]);
    expect(panelsOf(moveBy(DEF, 'notes', 'left', MIN))).toEqual([['now', 'river', 'notes'], ['week', 'soon']]);
    expect(moveBy(DEF, 'now', 'left', MIN)).toBe(DEF);
    const folded = setCollapsed(DEF, 'soon', true);
    expect(panelsOf(moveBy(folded, 'notes', 'up', MIN))).toEqual([['now', 'river'], ['notes', 'week', 'soon']]);
  });

  it('whereIs 按看得见的块数；收起再放回回原位', () => {
    const folded = setCollapsed(DEF, 'week', true);
    expect(whereIs(folded, 'soon')).toEqual({ col: 1, at: 0 });
    expect(whereIs(folded, 'week')).toBeNull();
    expect(setCollapsed(folded, 'week', false)).toEqual(DEF);
    expect(setCollapsed(DEF, 'week', false)).toBe(DEF);
  });
});

describe('栏宽', () => {
  it('resizeAt：两栏合计不变，各自夹在 [最窄, 0.6]；越界不动', () => {
    const r = resizeAt(DEF, 0, 0.9, MIN);
    expect(r.cols[0]?.w).toBeCloseTo(0.6);
    expect(r.cols[1]?.w).toBeCloseTo(0.4);
    expect(resizeAt(DEF, 0, 0.05, MIN).cols[0]?.w).toBeCloseTo(0.4);
    expect(resizeAt(DEF, 1, 0.5, MIN)).toBe(DEF);
    expect(resizeRange(DEF, 0, MIN)).toEqual({ lo: 0.4, hi: 0.6 });
    expect(resizeRange(DEF, 1, MIN)).toBeNull();
  });

  it('fitWidths：一栏是 1；放不下几个最窄栏时平分；非数按平分算', () => {
    expect(fitWidths([0.3], MIN)).toEqual([1]);
    expect(fitWidths([0.1, 0.9, 0.5], 0.4)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(sum(fitWidths([Number.NaN, 0.5], MIN))).toBeCloseTo(1);
  });

  it('fitWidths：归一化以后也不越界（夹一次再除会把 [0.6, 0.2] 撑到 0.75）；在范围里的按原比例分剩下的', () => {
    for (const ws of [[0.9, 0.05], [0.9, 0.05, 0.05], [0.01, 0.01, 0.98], [0.7, 0.7], [0.3, 0.3, 0.3]]) {
      const f = fitWidths(ws, MIN);
      expect(sum(f)).toBeCloseTo(1);
      for (const w of f) {
        expect(w).toBeLessThanOrEqual(COL_MAX + 1e-9);
        expect(w).toBeGreaterThanOrEqual(MIN - 1e-9);
      }
    }
    const two = fitWidths([0.9, 0.05], MIN);
    expect(two[0]).toBe(COL_MAX);
    expect(two[1]).toBeCloseTo(1 - COL_MAX);
    const f = fitWidths([0.98, 0.01, 0.01], MIN);
    expect(f[0]).toBeCloseTo(COL_MAX);
    expect(f[1]).toBeCloseTo((1 - COL_MAX) / 2);
  });

  it('toStored 留 3 位小数；sameLayout 按存的值比；dropEmpty 没空栏原样返回', () => {
    const l = { ...DEF, cols: [{ w: 0.123456, panels: ['now'] }, { w: 0.876544, panels: ['river'] }] };
    expect(toStored(l).cols.map((c) => c.w)).toEqual([0.123, 0.877]);
    expect(sameLayout(l, { ...l, cols: [{ w: 0.1231, panels: ['now'] }, { w: 0.8769, panels: ['river'] }] })).toBe(true);
    expect(dropEmpty(DEF)).toBe(DEF);
  });
});
