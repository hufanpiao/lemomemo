// shared/logic/notes/category-merge.ts（TC-B4-07 的判定一侧；B4 任务单 S7；架构 5.2 末条；R-413 AI 判的相似对 openPairs、addSuggested）
import { describe, expect, it } from 'vitest';
import type { CategoryRow } from '../../../shared/logic/live-row.ts';
import { addSuggested, openPairs, PAIRS_MAX, similarCategoryPairs } from '../../../shared/logic/notes/category-merge.ts';

const c = (id: string, name: string, o: Partial<CategoryRow> = {}): CategoryRow => ({ id, name, sort: 0, deleted_at: null, merged_into: null, ...o });

describe('similarCategoryPairs', () => {
  it('归一后一样：空白、全角、大小写不同', () => {
    expect(similarCategoryPairs([c('a', 'Work', { sort: 0 }), c('b', 'ｗｏｒｋ ', { sort: 1 })])).toEqual([{ keep: 'a', merge: 'b', why: 'same' }]);
  });
  it('一个包含另一个（短的至少 2 个字）；单字不算', () => {
    expect(similarCategoryPairs([c('a', '购物', { sort: 0 }), c('b', '购物清单', { sort: 1 })])).toEqual([{ keep: 'a', merge: 'b', why: 'contains' }]);
    expect(similarCategoryPairs([c('a', '书'), c('b', '书单')])).toEqual([]);
  });
  it('都至少 3 个字、只差一个字（换、增、删）；2 个字差一个不算', () => {
    expect(similarCategoryPairs([c('a', '读书笔记'), c('b', '读书笔迹')]).map((p) => p.why)).toEqual(['one_char']);
    expect(similarCategoryPairs([c('a', '여행계획'), c('b', '여행계획표')]).map((p) => p.why)).toEqual(['contains']);
    expect(similarCategoryPairs([c('a', '工作'), c('b', '工资')])).toEqual([]);
    expect(similarCategoryPairs([c('a', '健身计划'), c('b', '理财计划')])).toEqual([]);
  });
  it('留下 sort 小的；sort 一样留名字短的', () => {
    expect(similarCategoryPairs([c('b', '购物清单', { sort: 0 }), c('a', '购物', { sort: 5 })])[0]).toEqual({ keep: 'b', merge: 'a', why: 'contains' });
    expect(similarCategoryPairs([c('b', '购物清单'), c('a', '购物')])[0]?.keep).toBe('a');
  });
  it('删掉的、撤销的、已经合并掉的不参加；不像的不出', () => {
    expect(similarCategoryPairs([c('a', '购物'), c('b', '购物清单', { deleted_at: 1 }), c('d', '购物单', { merged_into: 'a' }), c('u', '购物车', { undone: true })])).toEqual([]);
    expect(similarCategoryPairs([c('a', '工作'), c('b', '旅行'), c('e', '여행')])).toEqual([]);
  });
});

describe('openPairs（R-413）', () => {
  it('AI 判的在前、本机规则的接后面；同一对只出一次（不分方向）；点过“不用”的去掉；留哪个照 sort', () => {
    const cats = [c('r', '读书', { sort: 2 }), c('l', '书单', { sort: 1 }), c('g', '购物', { sort: 3 }), c('q', '购物清单', { sort: 4 })];
    expect(openPairs(cats, [['r', 'l']], [])).toEqual([{ keep: 'l', merge: 'r', why: 'ai' }, { keep: 'g', merge: 'q', why: 'contains' }]);
    expect(openPairs(cats, [['q', 'g']], [])).toEqual([{ keep: 'g', merge: 'q', why: 'ai' }]);
    expect(openPairs(cats, [['r', 'l']], [['l', 'r'], ['g', 'q']])).toEqual([]);
  });
  it('AI 的对里有分类删了、合并掉、名字是空白、id 不认识：不出', () => {
    const cats = [c('r', '读书'), c('l', '书单', { merged_into: 'r' }), c('x', '  '), c('d', '书目', { deleted_at: 1 })];
    expect(openPairs(cats, [['r', 'l'], ['r', 'x'], ['r', 'd'], ['r', 'zz']], [])).toEqual([]);
  });
});

describe('addSuggested（R-413，ai-classify 用）', () => {
  const live = new Set(['a', 'b', 'c']);
  it('空 → 加上；已有同一对（反方向也算）→ null 不写；坏值当空', () => {
    expect(addSuggested(undefined, [['b', 'a']], live)).toEqual([['a', 'b']]);
    expect(addSuggested([['a', 'b']], [['b', 'a']], live)).toBeNull();
    expect(addSuggested('x', [['a', 'c']], live)).toEqual([['a', 'c']]);
    expect(addSuggested([['a', 'b']], [], live)).toBeNull();
  });
  it('存的对里有分类不在 live 里的去掉（即使这次没加新的也写）；这次给的对里有不在 live 的不加', () => {
    expect(addSuggested([['a', 'z'], ['a', 'b']], [], live)).toEqual([['a', 'b']]);
    expect(addSuggested([], [['a', 'z']], live)).toBeNull();
  });
  it(`封顶 ${PAIRS_MAX} 对，满了去最旧的`, () => {
    const ids = Array.from({ length: PAIRS_MAX + 2 }, (_, i) => `id${String(i).padStart(3, '0')}`);
    const all = new Set(ids);
    const full = ids.slice(0, PAIRS_MAX).map((x, i) => [x, ids[i + 1] ?? ''] as [string, string]).slice(0, PAIRS_MAX);
    const next = addSuggested(full, [[ids[PAIRS_MAX] ?? '', ids[PAIRS_MAX + 1] ?? '']], all);
    expect(next).toHaveLength(PAIRS_MAX);
    expect(next?.[0]).toEqual(full[1]);
  });
});
