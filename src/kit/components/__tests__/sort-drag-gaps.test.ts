// kit 长按拖动的落点算法（SortDrag.tsx 的 gapsOf、nearestGap、dropIndex；R-429）：空隙、离手指最近的那一个、放下后的下标
import { describe, expect, it } from 'vitest';
import { dropIndex, gapsOf, nearestGap } from '../SortDrag.tsx';

const row = (group: string, top: number, left = 0, width = 300) => ({ group, top, bottom: top + 50, left, width });

describe('空隙', () => {
  it('每行上沿一个空隙，每组（每列）最后一行下沿再一个', () => {
    const g = gapsOf([row('a', 0), row('a', 50), row('b', 120)]);
    expect(g.map((x) => [x.group, x.index, x.y])).toEqual([['a', 0, 0], ['a', 1, 50], ['b', 0, 120], ['a', 2, 100], ['b', 1, 170]]);
  });

  it('瀑布流两列：每列底下各一个空隙', () => {
    const g = gapsOf([row('all', 0, 0, 150), row('all', 60, 0, 150), row('all', 0, 160, 150)]);
    expect(g.filter((x) => x.index === 3 || x.y === 110 || x.y === 50).length).toBeGreaterThanOrEqual(2);
  });
});

describe('最近的空隙', () => {
  it('看竖直距离；不在那一列的横向偏差罚 3 倍', () => {
    const g = gapsOf([row('all', 0, 0, 150), row('all', 100, 0, 150), row('all', 0, 160, 150), row('all', 90, 160, 150)]);
    expect(nearestGap(g, 50, 95)).toMatchObject({ x: 0, y: 100 });
    expect(nearestGap(g, 200, 95)).toMatchObject({ x: 160, y: 90 });
    expect(nearestGap([], 0, 0)).toBeNull();
  });
});

describe('放下后的下标', () => {
  it('同组按去掉自己以后数；落回原位（自己上沿、下沿）回 null；跨组照空隙的下标', () => {
    const gap = (group: string, index: number) => ({ group, index, y: 0, x: 0, w: 1 });
    expect(dropIndex(gap('a', 0), 'a', 2)).toBe(0);
    expect(dropIndex(gap('a', 4), 'a', 1)).toBe(3);
    expect(dropIndex(gap('a', 2), 'a', 2)).toBeNull();
    expect(dropIndex(gap('a', 3), 'a', 2)).toBeNull();
    expect(dropIndex(gap('b', 1), 'a', 2)).toBe(1);
  });
});
