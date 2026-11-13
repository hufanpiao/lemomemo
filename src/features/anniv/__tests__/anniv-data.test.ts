// 纪念日页面的数据层（B5 S14、S15、S16）：列表排序筛选、只读行、编辑表单收拾、patch、头像裁剪的数学
import { describe, expect, it } from 'vitest';
import { loadAnnivLib } from '../../../core/anniv-lib.ts';
import { annivList, itemOf, nextFew } from '../data/anniv-model.ts';
import { dateValid, emptyForm, formOf, newRow, normalize, offsetsKey, offsetsList, patchOf } from '../data/anniv-edit.ts';
import { clampView, cropOf, scaleOf, zoomTo } from '../ui/AvatarPicker.tsx';

await loadAnnivLib();
const TZ = 'Asia/Seoul';
const TODAY = '2026-11-13';
const row = (id: string, x: Record<string, unknown>) => ({
  id, kind: 'birthday', name: id, calendar: 'solar', lunar_variant: 'cn', month: 1, day: 1, is_leap: false, year: null,
  after_due: 'archive', remind_offsets: null, remind_time: null, created_at: Date.UTC(2026, 0, 1), deleted_at: null, undone: false, ...x,
});

describe('纪念日列表（anniv-model）', () => {
  it('按还有几天排序，同一天按名字；只读行排最后；已过去的倒数日单独一组', () => {
    const rows = [
      row('b', { month: 11, day: 20 }),
      row('a', { month: 11, day: 20 }),
      row('c', { month: 11, day: 14, kind: 'anniversary' }),
      row('kr', { calendar: 'lunar', lunar_variant: 'kr', month: 3, day: 1 }),
      row('bad', { kind: 'nope' }),
      row('cd', { kind: 'countdown', year: 2026, month: 11, day: 1 }),
      row('del', { deleted_at: 1 }),
    ];
    const l = annivList(rows, TODAY, TZ, 'all');
    expect(l.items.map((x) => x.id)).toEqual(['c', 'a', 'b', 'bad', 'kr']);
    expect(l.items.filter((x) => x.ro).map((x) => x.id)).toEqual(['bad', 'kr']);
    expect(l.past.map((x) => x.id)).toEqual(['cd']);
    expect(l.nearest?.id).toBe('c');
    expect(l.counts).toEqual({ all: 5, birthday: 3, anniversary: 1, countdown: 0 });
  });

  it('筛选生日只留生日；筛选纪念日不带已过去的倒数日', () => {
    const rows = [row('b', { month: 12, day: 1 }), row('c', { kind: 'anniversary', month: 12, day: 2 }), row('cd', { kind: 'countdown', year: 2026, month: 11, day: 1 })];
    expect(annivList(rows, TODAY, TZ, 'birthday').items.map((x) => x.id)).toEqual(['b']);
    expect(annivList(rows, TODAY, TZ, 'anniversary').past).toEqual([]);
    expect(annivList(rows, TODAY, TZ, 'countdown').past.map((x) => x.id)).toEqual(['cd']);
  });

  it('同步层标了只读的也按只读；只读行没有接下来几次', () => {
    const x = itemOf(row('r', { month: 12, day: 1 }), TODAY, TZ, new Set(['r']));
    expect(x.ro).toBe(true);
    expect(x.rec).toBeNull();
    expect(nextFew(x, TODAY, TZ)).toEqual([]);
  });

  it('接下来 3 次：阳历每年同一天', () => {
    expect(nextFew(itemOf(row('n', { month: 12, day: 1 }), TODAY, TZ), TODAY, TZ)).toEqual(['2026-12-01', '2027-12-01', '2028-12-01']);
  });
});

describe('纪念日编辑表单（anniv-edit）', () => {
  it('提前天数存成从大到小、去重、最多 4 个的字符串（编辑记录按值比较）', () => {
    expect(offsetsKey([1, 7, 7, 0, 3, 14])).toBe('14,7,3,1');
    expect(offsetsKey([61, -1])).toBeNull();
    expect(offsetsKey(null)).toBeNull();
    expect(offsetsList('7,1')).toEqual([7, 1]);
  });

  it('换成没有闰月的年份改平月；日子超出这个月收到最后一天；阳历不带闰月', () => {
    // 2023 年农历闰二月；2024 年没有闰月
    const f = { ...emptyForm(TODAY), calendar: 'lunar' as const, year: 2024, month: 2, day: 30, is_leap: true };
    const n = normalize(f);
    expect(n.is_leap).toBe(false);
    expect(dateValid(n)).toBe(true);
    expect(normalize({ ...emptyForm(TODAY), year: 2025, month: 2, day: 31 }).day).toBe(28);
    expect(normalize({ ...emptyForm(TODAY), is_leap: true }).is_leap).toBe(false);
  });

  it('不存在的月日不合格（R-403）', () => {
    expect(dateValid({ ...emptyForm(TODAY), month: 4, day: 31 })).toBe(false);
    expect(dateValid({ ...emptyForm(TODAY), year: 2025, month: 2, day: 29 })).toBe(false);
    expect(dateValid({ ...emptyForm(TODAY), year: null, month: 2, day: 29 })).toBe(true);
  });

  it('patch 只带改了的列和 updated_at；没改回 null；新建整行带 lunar_variant cn', () => {
    const a = formOf(row('x', { name: '妈妈', remind_offsets: [1, 7] }));
    expect(a.offsets).toBe('7,1');
    expect(patchOf({}, a, a, 5)).toBeNull();
    expect(patchOf({}, a, { ...a, name: ' 妈妈生日 ', offsets: null }, 5)).toEqual({ name: '妈妈生日', remind_offsets: null, updated_at: 5 });
    const r = newRow('id1', a, 9);
    expect(r).toMatchObject({ id: 'id1', lunar_variant: 'cn', created_at: 9, updated_at: 9, remind_offsets: [7, 1], name: '妈妈' });
  });
});

describe('头像裁剪的数学（AvatarPicker）', () => {
  it('短边铺满取景框；拖出边界会被拉回；放大以取景框中心为准；裁剪框落在原图里', () => {
    const s = scaleOf(1000, 500, 1);
    expect(s).toBeCloseTo(260 / 500);
    const v = clampView({ x: 9999, y: 9999, z: 1 }, 1000, 500);
    const c = cropOf(v, 1000, 500);
    expect(c.x).toBeCloseTo(0);
    expect(c.y).toBeCloseTo(0);
    expect(cropOf(clampView({ x: -9999, y: -9999, z: 1 }, 1000, 500), 1000, 500).x + c.size).toBeCloseTo(1000);
    expect(c.size).toBeCloseTo(500);
    const z = zoomTo({ x: 0, y: 0, z: 1 }, 2, 1000, 500);
    expect(cropOf(z, 1000, 500).size).toBeCloseTo(250);
  });
});
