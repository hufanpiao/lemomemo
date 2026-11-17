// kit 长按拖动的预览顺序（SortDrag.tsx 的 overOrder、applyOrder、dropAt；R-461 整块重写）：越过哪一项、越没越过中线就换位；预览顺序套回页面条目；放下按邻居 id 找下标
import { describe, expect, it } from 'vitest';
import { applyOrder, dropAt, overOrder, type SortRect } from '../SortDrag.tsx';

const r = (id: string, top: number, left = 0, width = 300, height = 50): SortRect => ({ id, top, left, width, height });

describe('换位（列表）', () => {
  const rows = [r('a', 0), r('b', 50), r('c', 100)];
  it('往上拖过上一项的中线才换，没过不换', () => {
    expect(overOrder(['a', 'b', 'c'], 'c', rows, { x: 10, y: 80 }, 'y')).toBeNull();
    expect(overOrder(['a', 'b', 'c'], 'c', rows, { x: 10, y: 70 }, 'y')).toEqual(['a', 'c', 'b']);
  });
  it('往下拖过下一项的中线才换；列表不看横向', () => {
    expect(overOrder(['a', 'b', 'c'], 'a', rows, { x: 999, y: 60 }, 'y')).toBeNull();
    expect(overOrder(['a', 'b', 'c'], 'a', rows, { x: 999, y: 80 }, 'y')).toEqual(['b', 'a', 'c']);
  });
  it('一下子越过好几项：直接挪到压着的那一项的位置', () => {
    expect(overOrder(['a', 'b', 'c'], 'c', rows, { x: 10, y: 10 }, 'y')).toEqual(['c', 'a', 'b']);
  });
  it('压着自己、压在空白处不换', () => {
    expect(overOrder(['a', 'b', 'c'], 'b', rows, { x: 10, y: 75 }, 'y')).toBeNull();
    expect(overOrder(['a', 'b', 'c'], 'b', rows, { x: 10, y: 400 }, 'y')).toBeNull();
  });
});

describe('换位（瀑布流两列）', () => {
  // 左列 a、b，右列 c、d（DOM 顺序 a b c d）
  const rows = [r('a', 0, 0, 150, 80), r('b', 90, 0, 150, 60), r('c', 0, 160, 150, 40), r('d', 50, 160, 150, 90)];
  it('横向不在那一列不算；跨列压上就换，不看中线', () => {
    expect(overOrder(['a', 'b', 'c', 'd'], 'a', rows, { x: 155, y: 20 }, 'xy')).toBeNull();
    expect(overOrder(['a', 'b', 'c', 'd'], 'a', rows, { x: 200, y: 60 }, 'xy')).toEqual(['b', 'c', 'd', 'a']);
    expect(overOrder(['a', 'b', 'c', 'd'], 'd', rows, { x: 40, y: 10 }, 'xy')).toEqual(['d', 'a', 'b', 'c']);
  });
  it('同一列还要越过中线', () => {
    expect(overOrder(['a', 'b', 'c', 'd'], 'b', rows, { x: 40, y: 50 }, 'xy')).toBeNull();
    expect(overOrder(['a', 'b', 'c', 'd'], 'b', rows, { x: 40, y: 30 }, 'xy')).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('预览顺序套回条目', () => {
  it('认得的按预览顺序填回原来那几格；不认得的（拖动中同步回来的）留在原处', () => {
    const items = [{ id: 'a' }, { id: 'n' }, { id: 'b' }, { id: 'c' }];
    expect(applyOrder(items, (x) => x.id, ['c', 'a', 'b']).map((x) => x.id)).toEqual(['c', 'n', 'a', 'b']);
    expect(applyOrder(items, (x) => x.id, []).map((x) => x.id)).toEqual(['a', 'n', 'b', 'c']);
  });
});

describe('按邻居 id 找下标（R-429 评审第 5 条）', () => {
  it('排在 beforeId 后面、afterId 前面；拖的这一条在不在列表里都一样', () => {
    expect(dropAt(['a', 'b', 'c'], { id: 'c', beforeId: 'a', afterId: 'b' })).toBe(1);
    expect(dropAt(['a', 'b'], { id: 'c', beforeId: 'a', afterId: 'b' })).toBe(1);
    expect(dropAt(['a', 'b', 'c'], { id: 'a', beforeId: null, afterId: 'b' })).toBe(0);
    expect(dropAt(['a', 'b', 'c'], { id: 'c', beforeId: null, afterId: 'a' })).toBe(0);
    expect(dropAt(['a', 'b', 'c'], { id: 'a', beforeId: 'c', afterId: null })).toBe(2);
    expect(dropAt([], { id: 'x', beforeId: null, afterId: null })).toBe(0);
  });

  it('拖动中列表变了：邻居不在了、中间插进来一条，回 null（当取消），不按旧下标落到别处', () => {
    expect(dropAt(['b', 'c'], { id: 'c', beforeId: 'a', afterId: 'b' })).toBeNull();
    expect(dropAt(['a', 'n', 'b', 'c'], { id: 'c', beforeId: 'a', afterId: 'b' })).toBeNull();
    expect(dropAt(['a', 'b', 'c', 'n'], { id: 'a', beforeId: 'c', afterId: null })).toBeNull();
  });
});
