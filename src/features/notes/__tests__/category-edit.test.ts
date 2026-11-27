// 改分类名、删分类（负责人 11-19“长按分类格可以改名、删除，删分类时里面的记录不删，变回没分类”“其他可以自己编辑分类”）：
// 改名只在同一套（随手记 / 隐私记）里查重名；删除只写 deleted_at，记录一条不改，归类时当没分类
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { categoryResolver } from '../../../core/categories.ts';

const st = vi.hoisted(() => ({ cats: [] as Record<string, unknown>[], wrote: [] as { id: string; data: Record<string, unknown> }[], ok: true }));
vi.mock('../../../core/store.ts', () => ({ collection: () => ({ getSnapshot: () => st.cats }) }));
vi.mock('../../../core/write.ts', () => ({
  write: {
    patch: vi.fn(async (_t: string, id: string, data: Record<string, unknown>) => {
      st.wrote.push({ id, data });
      return st.ok ? { ok: true, item: null } : { ok: false, reason: 'quota' };
    }),
  },
}));
vi.mock('../../../core/edit-save.ts', () => ({ saveOutcome: async (f: () => Promise<{ ok: boolean }>) => ((await f()).ok ? 'saved' : 'failed') }));

import { deleteCategory, renameCategory } from '../data/category-edit.ts';

describe('renameCategory / deleteCategory', () => {
  beforeEach(() => {
    st.cats = [
      { id: 'n1', name: '证件' },
      { id: 'n2', name: '旅行' },
      { id: 'v1', name: '密码', vault: true },
      { id: 'd', name: '旧的', deleted_at: 5 },
    ];
    st.wrote = [];
    st.ok = true;
  });
  it('改名：去空白、写 name；和原名一样不写；空白回 empty；删了的回 gone', async () => {
    expect(await renameCategory('n1', ' 证件照 ')).toBe('ok');
    expect(st.wrote).toEqual([{ id: 'n1', data: { name: '证件照' } }]);
    expect(await renameCategory('n2', '旅行')).toBe('ok');
    expect(await renameCategory('n2', '  ')).toBe('empty');
    expect(await renameCategory('d', '新')).toBe('gone');
    expect(st.wrote).toHaveLength(1);
  });
  it('同一套里重名回 dup；另一套里有同名照改（隐私记自己一套）', async () => {
    expect(await renameCategory('n2', '证件')).toBe('dup');
    expect(await renameCategory('v1', '证件')).toBe('ok');
    expect(st.wrote).toEqual([{ id: 'v1', data: { name: '证件' } }]);
  });
  it('删除只写 deleted_at；里面的记录不改，归类时当没分类', async () => {
    expect(await deleteCategory('v1', () => 99)).toBe('ok');
    expect(st.wrote).toEqual([{ id: 'v1', data: { deleted_at: 99 } }]);
    const after = st.cats.map((c) => (c['id'] === 'v1' ? { ...c, deleted_at: 99 } : c)) as { id: string }[];
    expect(categoryResolver(after)('v1')).toBeNull();
    expect(await deleteCategory('d')).toBe('gone');
  });
  it('写不进去回 failed', async () => {
    st.ok = false;
    expect(await renameCategory('n1', '新名')).toBe('failed');
    expect(await deleteCategory('n1')).toBe('failed');
  });
});
