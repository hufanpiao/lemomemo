// 拖动排序的排序值（shared/logic/sort-key.ts，R-429）：键的格式、时间键、两键之间插一个、松手后要写哪些键
import { describe, expect, it } from 'vitest';
import { effKey, isSortKey, midKey, planMove, SORT_KEY_MAX, sortKeyOf, timeKey, type Keyed } from '../../shared/logic/sort-key.ts';

const NOW = 1_763_000_000_000;

/** 按写入结果更新一组，再按键降序排出 id 顺序（页面上的显示顺序） */
function after(list: Keyed[], id: string, index: number, now = NOW): string[] {
  const keys = new Map(list.map((x) => [x.id, x.key]));
  for (const w of planMove(list, id, index, now)) keys.set(w.id, w.key);
  return [...keys.entries()].sort((a, b) => ((a[1] ?? '') > (b[1] ?? '') ? -1 : 1)).map((x) => x[0]);
}

describe('键的格式', () => {
  it('数字串、末位不是 0、不超过 128 位；sortKeyOf 不合格的当没有', () => {
    expect(isSortKey('15')).toBe(true);
    expect(isSortKey('150')).toBe(false);
    expect(isSortKey('')).toBe(false);
    expect(isSortKey('1a')).toBe(false);
    expect(isSortKey('1'.repeat(SORT_KEY_MAX))).toBe(true);
    expect(isSortKey('1'.repeat(SORT_KEY_MAX + 1))).toBe(false);
    expect(sortKeyOf({ sort_key: '35' })).toBe('35');
    expect(sortKeyOf({ sort_key: '30' })).toBeNull();
    expect(sortKeyOf({ sort_key: null })).toBeNull();
    expect(sortKeyOf({})).toBeNull();
  });

  it('时间键：补到 13 位、去掉末尾 0，字典序 = 时刻先后；0、负数没有键', () => {
    expect(timeKey(1_731_000_000_000)).toBe('1731');
    expect(timeKey(5)).toBe('0000000000005');
    expect(timeKey(0)).toBeNull();
    expect(timeKey(-3)).toBeNull();
    const ts = [5, 999, 1_000, 1_731_000_000_001, NOW, NOW + 1];
    const ks = ts.map((t) => timeKey(t) ?? '');
    expect([...ks].sort()).toEqual(ks);
    expect(effKey(null, NOW)).toBe(timeKey(NOW));
    expect(effKey('9', NOW)).toBe('9');
  });
});

describe('midKey', () => {
  it('总在两键之间、格式合格', () => {
    const pairs: [string, string | null][] = [['', null], ['', '5'], ['1', '2'], ['19', '2'], ['12', '13'], ['1', '12'], ['1731', '1732'], ['', '0001'], ['99', null]];
    for (const [lo, hi] of pairs) {
      const k = midKey(lo, hi);
      expect(isSortKey(k)).toBe(true);
      expect(k > lo).toBe(true);
      if (hi !== null) expect(k < hi).toBe(true);
    }
  });

  it('同一个空隙连着插 60 次，每次都还在两键之间', () => {
    let lo = '1';
    const hi = '2';
    for (let i = 0; i < 60; i++) {
      const k = midKey(lo, hi);
      expect(k > lo && k < hi && isSortKey(k)).toBe(true);
      lo = k;
    }
  });
});

describe('planMove', () => {
  const list: Keyed[] = [{ id: 'a', key: '15' }, { id: 'b', key: '14' }, { id: 'c', key: '13' }, { id: 'd', key: '12' }];

  it('邻居都有键：只写拖的这一条，落到横线那一处', () => {
    const w = planMove(list, 'd', 1, NOW);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ id: 'd', prev: '12' });
    expect(after(list, 'd', 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(after(list, 'a', 3)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('拖到最上面：比原第一条大，但不超过此刻的时间键（新记的仍在它上面）', () => {
    const w = planMove(list, 'c', 0, NOW);
    expect(w).toHaveLength(1);
    expect(w[0]!.key > '15').toBe(true);
    expect(w[0]!.key <= (timeKey(NOW) ?? '')).toBe(true);
    expect(after(list, 'c', 0)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('邻居没键（待办没拖过的）：整组从此刻的时间键往下重排，顺序照放下后的', () => {
    const raw: Keyed[] = [{ id: 'a', key: null }, { id: 'b', key: null }, { id: 'c', key: null }];
    const w = planMove(raw, 'c', 0, NOW);
    expect(w.map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(w.map((x) => x.prev)).toEqual([null, null, null]);
    expect(w.every((x) => isSortKey(x.key) && x.key <= (timeKey(NOW) ?? ''))).toBe(true);
    expect(after(raw, 'c', 0)).toEqual(['c', 'a', 'b']);
  });

  it('两个邻居一样大：整组重排', () => {
    const same: Keyed[] = [{ id: 'a', key: '5' }, { id: 'b', key: '5' }, { id: 'c', key: '3' }];
    expect(planMove(same, 'c', 1, NOW).length).toBeGreaterThan(1);
    expect(after(same, 'c', 1)).toEqual(['a', 'c', 'b']);
  });

  it('跨组拖进来（不在 list 里）：带上原来的键当 prev', () => {
    const w = planMove(list, 'x', 2, NOW, '77');
    // deno 的 expect 垫片没有 expect.any：键单独比
    expect(w.map((x) => ({ ...x, key: typeof x.key }))).toEqual([{ id: 'x', key: 'string', prev: '77' }]);
    expect(w[0]!.key < '14' && w[0]!.key > '13').toBe(true);
  });

  it('键太长：整组重排，不写超长的键', () => {
    const long = '1'.repeat(SORT_KEY_MAX);
    const tight: Keyed[] = [{ id: 'a', key: `${long.slice(0, -1)}2` }, { id: 'b', key: long }, { id: 'c', key: '1' }];
    const w = planMove(tight, 'c', 1, NOW);
    expect(w.every((x) => x.key.length <= SORT_KEY_MAX)).toBe(true);
    expect(after(tight, 'c', 1)).toEqual(['a', 'c', 'b']);
  });
});
