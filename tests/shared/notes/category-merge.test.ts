// shared/logic/notes/category-merge.ts（TC-B4-07 的判定一侧；B4 任务单 S7；架构 5.2 末条）
import { describe, expect, it } from 'vitest';
import { similarCategoryPairs, type MergeCategory } from '../../../shared/logic/notes/category-merge.ts';

const c = (id: string, name: string, o: Partial<MergeCategory> = {}): MergeCategory => ({ id, name, sort: 0, deleted_at: null, merged_into: null, ...o });

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
  it('删掉的、已经合并掉的不参加；不像的不出', () => {
    expect(similarCategoryPairs([c('a', '购物'), c('b', '购物清单', { deleted_at: 1 }), c('d', '购物单', { merged_into: 'a' })])).toEqual([]);
    expect(similarCategoryPairs([c('a', '工作'), c('b', '旅行'), c('e', '여행')])).toEqual([]);
  });
});
