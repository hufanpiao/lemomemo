// 新建分类（负责人 11-19 隐私记首页“＋ 新分类”）：去首尾空白、最多 12 个字、同名（不分大小写、活着的）回已有那个、写进 outbox 的那一行
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ cats: [] as Record<string, unknown>[], wrote: [] as { table: string; data: Record<string, unknown> }[], ok: true }));
vi.mock('../../../core/store.ts', () => ({ collection: () => ({ getSnapshot: () => st.cats }) }));
vi.mock('../../../core/write.ts', () => ({
  write: {
    insert: vi.fn(async (table: string, data: Record<string, unknown>) => {
      st.wrote.push({ table, data });
      return st.ok ? { ok: true, item: null } : { ok: false, reason: 'quota' };
    }),
  },
}));
vi.mock('../../../core/edit-save.ts', () => ({ saveOutcome: async (f: () => Promise<{ ok: boolean }>) => ((await f()).ok ? 'saved' : 'failed') }));

import { CATEGORY_NAME_MAX, createCategory } from '../data/category-new.ts';

describe('createCategory', () => {
  beforeEach(() => {
    st.cats = [];
    st.wrote = [];
    st.ok = true;
  });
  it('去首尾空白、写一行 categories（created_by user、sort 0）', async () => {
    expect(await createCategory('  旅行 ', false, () => 'c1')).toEqual({ result: 'ok', id: 'c1', existed: false });
    expect(st.wrote).toEqual([{ table: 'categories', data: { id: 'c1', name: '旅行', sort: 0, created_by: 'user', vault: false } }]);
  });
  it(`超过 ${CATEGORY_NAME_MAX} 个字截掉（按字，不按 UTF-16）；空白不建`, async () => {
    await createCategory('一二三四五六七八九十甲乙丙丁', false, () => 'c2');
    expect(st.wrote[0]?.data['name']).toBe('一二三四五六七八九十甲乙');
    expect(await createCategory('   ', false)).toEqual({ result: 'empty' });
    expect(st.wrote).toHaveLength(1);
  });
  it('同名（不分大小写）活着的分类：不再建，回那一个；删了的不算；合并掉、撤销但没删的占着名字，回 dup 不建（口径同唯一索引）', async () => {
    st.cats = [
      { id: 'a', name: 'Work' },
      { id: 'b', name: '健康', deleted_at: 1 },
      { id: 'c', name: '证件', merged_into: 'a' },
      { id: 'd', name: '旅行', undone: true },
    ];
    expect(await createCategory('work', false)).toEqual({ result: 'ok', id: 'a', existed: true });
    expect(await createCategory('健康', false, () => 'n1')).toEqual({ result: 'ok', id: 'n1', existed: false });
    expect(await createCategory('证件', false, () => 'n2')).toEqual({ result: 'dup' });
    expect(await createCategory('旅行', false, () => 'n3')).toEqual({ result: 'dup' });
    expect(st.wrote).toHaveLength(1);
  });
  it('截到 12 个字以后尾巴的空白也去掉', async () => {
    await createCategory('一二三四五六七八九十甲 乙', false, () => 'c3');
    expect(st.wrote[0]?.data['name']).toBe('一二三四五六七八九十甲');
  });
  it('隐私记、随手记各一套（负责人 11-19“隐私记自己一套”）：只在同一套里查重名，新建隐私记分类写 vault: true', async () => {
    st.cats = [
      { id: 'n', name: '证件' },
      { id: 'v', name: '密码', vault: true },
    ];
    expect(await createCategory('证件', true, () => 'v2')).toEqual({ result: 'ok', id: 'v2', existed: false });
    expect(st.wrote[0]?.data).toEqual({ id: 'v2', name: '证件', sort: 0, created_by: 'user', vault: true });
    expect(await createCategory('密码', true)).toEqual({ result: 'ok', id: 'v', existed: true });
    expect(await createCategory('密码', false, () => 'n2')).toEqual({ result: 'ok', id: 'n2', existed: false });
  });
  it('写不进去回 failed', async () => {
    st.ok = false;
    expect(await createCategory('旅行', false, () => 'x')).toEqual({ result: 'failed' });
  });
});
