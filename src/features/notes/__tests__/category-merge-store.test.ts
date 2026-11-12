// 合并相近分类的本机部分（B4 S7，TC-B4-07 数据层部分）：notes.merge_dismissed 的读、追加、封顶；去掉点过“不合并”的提示对；
// 执行合并只写分类一笔 merged_into，条目在读的时候顺着 merged_into 归到留下的分类（删了再恢复的、晚到的也一样）
import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ServerRow } from '../../../core/cache.ts';
import { OutboxRejectError } from '../../../core/outbox.ts';
import { createSettingWriter, type SettingRow } from '../../../core/setting-write.ts';
import { collection } from '../../../core/store.ts';
import type { WriteResult } from '../../../core/write.ts';
import {
  dismissedPairs, dismissMerge, MERGE_DISMISSED_KEY, MERGE_DISMISSED_MAX, mergeCategories, openMergePairs, withDismissed, type MergeDeps,
} from '../data/category-merge-store.ts';
import { aiMarkKept, formOf, patchOf } from '../data/note-edit.ts';
import { categoryCounts, noteItems, type Row } from '../data/note-list.ts';
import { boot, serverNote, setupImageTests, uid } from './note-images-kit.tsx';

const TZ = 'Asia/Seoul';
const A = uid(101);
const B = uid(102);
const C = uid(103);
const cat = (id: string, name: string, over: Record<string, unknown> = {}): Row => ({ id, name, sort: 0, deleted_at: null, undone: false, merged_into: null, ...over });
const set = (value: unknown, over: Record<string, unknown> = {}): SettingRow => ({ id: 's1', key: MERGE_DISMISSED_KEY, value, deleted_at: null, undone: false, ...over });
const note = (id: string, category: string | null, over: Record<string, unknown> = {}): Row => ({
  id, title: null, body: id, is_private: false, category_id: category, deleted_at: null, undone: false, created_at: 1, ...over,
});
/** settings.value 存成 jsonb 后的文字形式（逗号后有空格）；jsonb 存储不会比它大，库约束 pg_column_size(value) <= 4096 拿它当上限量 */
const jsonbText = (v: readonly (readonly [string, string])[]): string => `[${v.map(([a, b]) => `["${a}", "${b}"]`).join(', ')}]`;
const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe('dismissedPairs / withDismissed', () => {
  it('没存、不是数组 → 空；坏项（不是两个字符串、两个一样、空串）丢掉，其余照留；反着存的读出来 id 小的在前', () => {
    expect(dismissedPairs(undefined)).toEqual([]);
    expect(dismissedPairs({ a: 1 })).toEqual([]);
    expect(dismissedPairs([['b', 'a'], ['x'], ['c', 'c'], ['', 'd'], [1, 2], 'ab', ['e', 'f', 'g'], ['f', 'e']])).toEqual([['a', 'b'], ['e', 'f']]);
  });
  it('(a,b) 和 (b,a) 结果相同，新的一对在最后；已有的再加 → 原样返回（同一个数组，不产生写入）', () => {
    const list: [string, string][] = [['m', 'n']];
    expect(withDismissed(list, 'b', 'a')).toEqual([['m', 'n'], ['a', 'b']]);
    expect(withDismissed(list, 'a', 'b')).toEqual(withDismissed(list, 'b', 'a'));
    expect(withDismissed(list, 'n', 'm')).toBe(list);
  });
  it(`已有 ${MERGE_DISMISSED_MAX} 对再加一对 → 仍 ${MERGE_DISMISSED_MAX} 对，原来第一对没了，新的在最后`, () => {
    const full = Array.from({ length: MERGE_DISMISSED_MAX }, (_, i): [string, string] => [uid(i * 2), uid(i * 2 + 1)]);
    const next = withDismissed(full, uid(999), uid(998));
    expect(next).toHaveLength(MERGE_DISMISSED_MAX);
    expect(next[0]).toEqual(full[1]);
    expect(next[MERGE_DISMISSED_MAX - 1]).toEqual([uid(998), uid(999)]);
  });
  it(`封顶后的值按 jsonb 文字量不超过 4096 字节（settings.value 的库约束）`, () => {
    const full = Array.from({ length: MERGE_DISMISSED_MAX + 5 }, (): [string, string] => [crypto.randomUUID(), crypto.randomUUID()])
      .reduce<readonly [string, string][]>((l, [a, b]) => withDismissed(l, a, b), []);
    expect(full).toHaveLength(MERGE_DISMISSED_MAX);
    expect(bytes(jsonbText(full))).toBeLessThan(4097);
  });
});

describe('openMergePairs（TC-B4-07 出提示）', () => {
  const cats = [cat(A, '购物'), cat(B, '购物清单', { sort: 1 })];
  it('“购物”和“购物清单” → 给出这一对', () => {
    expect(openMergePairs(cats, [])).toEqual([{ keep: A, merge: B, why: 'contains' }]);
  });
  it('记过这一对（不分方向）→ 不出；那一行设置被软删、撤销 → 又出', () => {
    expect(openMergePairs(cats, [set([[B, A]])])).toEqual([]);
    expect(openMergePairs(cats, [set([[A, B]])])).toEqual([]);
    expect(openMergePairs(cats, [set([[A, B]], { deleted_at: 9 })])).toHaveLength(1);
    expect(openMergePairs(cats, [set([[A, B]], { undone: true })])).toHaveLength(1);
  });
  it('只去掉点过的那一对：购物 / 购物清单 / 购物车 只记过 (购物, 购物车) → (购物, 购物清单) 照常出；记的是不相干的一对 → 两对都出', () => {
    const three = [cat(A, '购物'), cat(B, '购物清单', { sort: 1 }), cat(C, '购物车', { sort: 2 })];
    expect(openMergePairs(three, [])).toEqual([{ keep: A, merge: B, why: 'contains' }, { keep: A, merge: C, why: 'contains' }]);
    expect(openMergePairs(three, [set([[C, A]])])).toEqual([{ keep: A, merge: B, why: 'contains' }]);
    expect(openMergePairs(three, [set([[A, B]])])).toEqual([{ keep: A, merge: C, why: 'contains' }]);
    expect(openMergePairs(three, [set([[uid(7), uid(8)]])])).toHaveLength(2);
  });
  it('三个彼此相近的分类（读书笔记 / 读书笔迹 / 读书笔录）记过其中一对 → 另外两对还在', () => {
    const three = [cat(A, '读书笔记'), cat(B, '读书笔迹', { sort: 1 }), cat(C, '读书笔录', { sort: 2 })];
    expect(openMergePairs(three, []).map((p) => [p.keep, p.merge])).toEqual([[A, B], [A, C], [B, C]]);
    expect(openMergePairs(three, [set([[C, B]])]).map((p) => [p.keep, p.merge])).toEqual([[A, B], [A, C]]);
  });
  it('undone、删了的分类不参加', () => {
    expect(openMergePairs([cats[0] as Row, cat(B, '购物清单', { undone: true })], [])).toEqual([]);
    expect(openMergePairs([cats[0] as Row, cat(B, '购物清单', { sort: 1, deleted_at: 5 })], [])).toEqual([]);
    expect(openMergePairs([cat(A, '购物', { deleted_at: 5 }), cats[1] as Row], [])).toEqual([]);
  });
  it('留哪个按分类的 sort：sort 小的名字反而长，也留 sort 小的', () => {
    expect(openMergePairs([cat(A, '购物清单', { sort: 0 }), cat(B, '购物', { sort: 1 })], [])).toEqual([{ keep: A, merge: B, why: 'contains' }]);
    expect(openMergePairs([cat(A, '购物清单', { sort: 2 }), cat(B, '购物', { sort: 1 })], [])).toEqual([{ keep: B, merge: A, why: 'contains' }]);
  });
  it('dismissMerge：writer.update 只调一次，键是 notes.merge_dismissed，值是原有各对加上新的一对', async () => {
    const saved: [string, unknown][] = [];
    const writer = { update: (k: string, next: (cur: unknown) => unknown) => Promise.resolve(void saved.push([k, next([['m', 'n']])])) };
    await dismissMerge(writer, { keep: B, merge: A });
    expect(saved).toEqual([[MERGE_DISMISSED_KEY, [['m', 'n'], [A, B]]]]);
  });
});

type Call = { table: string; id: string; data: Record<string, unknown> };
function stub(result: () => WriteResult = () => ({ ok: true, item: null }), ro: string[] = []) {
  const calls: Call[] = [];
  const w: NonNullable<MergeDeps['w']> = {
    patch: (table, id, data) => {
      calls.push({ table, id, data });
      return Promise.resolve(result());
    },
  };
  return { calls, deps: { w, isReadonly: (id: string) => ro.includes(id) } satisfies MergeDeps };
}
/** 把 patch 套回行（模拟本机 view） */
const applied = (rows: readonly Row[], calls: readonly Call[]): Row[] =>
  rows.map((r) => calls.filter((c) => c.id === r.id).reduce<Row>((x, c) => ({ ...x, ...c.data }), r));

describe('mergeCategories（TC-B4-07 合并后条目归到新分类）', () => {
  const cats = [cat(A, '购物'), cat(B, '购物清单', { sort: 1 })];
  const notes = [
    note('b1', B), note('b2', B), note('b3', B), note('bd', B, { deleted_at: 5 }), note('bp', B, { is_private: true }), note('a1', A),
  ];

  it('只写分类 B 一笔 {merged_into: A}；B 下活着的 3 条读出来归到 A，分类胶囊里没有 B、A 是 4 条', async () => {
    const s = stub();
    expect(await mergeCategories({ keep: A, merge: B }, cats, s.deps)).toEqual({ ok: true });
    expect(s.calls).toEqual([{ table: 'categories', id: B, data: { merged_into: A } }]);
    const after = applied(cats, s.calls);
    const items = noteItems(notes, after, TZ);
    expect(items.filter((i) => i.id.startsWith('b')).map((i) => [i.id, i.categoryId])).toEqual([['b1', A], ['b2', A], ['b3', A]]);
    expect(noteItems(notes, after, TZ, A)).toHaveLength(4);
    expect(categoryCounts(notes, after, 'zh-CN').map((c) => [c.id, c.count])).toEqual([[A, 4]]);
  });

  it('合并完再算提示：这一对不再出', async () => {
    const s = stub();
    await mergeCategories({ keep: A, merge: B }, cats, s.deps);
    expect(openMergePairs(cats, [])).toHaveLength(1);
    expect(openMergePairs(applied(cats, s.calls), [])).toEqual([]);
  });

  it('编辑页读的分类（formOf）也归到 A，和列表一致；不动分类时保存不写分类列', async () => {
    const s = stub();
    await mergeCategories({ keep: A, merge: B }, cats, s.deps);
    const after = applied(cats, s.calls);
    const row = note('b1', B);
    const f = formOf(row, after);
    expect(f.category_id).toBe(A);
    expect(patchOf(row, f, { ...f, title: '改了标题' }, 9)).toEqual({ title: '改了标题', updated_at: 9 });
    expect(formOf(note('x', B), [cat(A, '甲', { deleted_at: 3 }), cat(B, '乙', { merged_into: A })]).category_id).toBeNull();
  });

  it('编辑页分类旁的“AI”（aiMarkKept）按归并后的分类比：AI 分到 B、B 合并进 A 后照样标，和列表一致；改了分类、不是 AI 分的、归不到活着的分类都不标', async () => {
    const s = stub();
    await mergeCategories({ keep: A, merge: B }, cats, s.deps);
    const after = applied(cats, s.calls);
    const row = note('b1', B, { category_source: 'ai', category_seen: false });
    const f = formOf(row, after);
    expect(noteItems([row], after, TZ)[0]?.ai).toBe(true);
    expect(aiMarkKept(row, f, after)).toBe(true);
    expect(aiMarkKept(row, { ...f, category_id: null }, after)).toBe(false);
    expect(aiMarkKept({ ...row, category_source: 'rule' }, f, after)).toBe(false);
    const dead = [cat(A, '甲', { deleted_at: 3 }), cat(B, '乙', { merged_into: A })];
    expect(aiMarkKept(row, formOf(row, dead), dead)).toBe(false);
  });

  it('删除 → 合并 → 恢复：恢复的那条归到 A；合并后才写进来指向 B 的（别的设备、AI）也归到 A', async () => {
    const s = stub();
    await mergeCategories({ keep: A, merge: B }, cats, s.deps);
    const after = applied(cats, s.calls);
    const restored = notes.map((n) => (n.id === 'bd' ? { ...n, deleted_at: null } : n));
    expect(noteItems([...restored, note('late', B)], after, TZ).filter((i) => ['bd', 'late'].includes(i.id)).map((i) => i.categoryId)).toEqual([A, A]);
  });

  it('连环合并顺着走到活着的那个；绕成圈、终点被删的当没分类', () => {
    const chain = [cat(A, '甲', { merged_into: C }), cat(B, '乙', { merged_into: A }), cat(C, '丙')];
    expect(noteItems([note('x', B)], chain, TZ)[0]?.categoryId).toBe(C);
    const loop = [cat(A, '甲', { merged_into: B }), cat(B, '乙', { merged_into: A })];
    expect(noteItems([note('x', B)], loop, TZ)[0]?.categoryId).toBeNull();
    const dead = [cat(A, '甲', { deleted_at: 3 }), cat(B, '乙', { merged_into: A })];
    expect(noteItems([note('x', B)], dead, TZ)[0]?.categoryId).toBeNull();
  });

  it('keep 或 merge 不存在、已删、已撤销、已合并掉，或两个是同一个 → gone，一笔不写', async () => {
    const bad: [Row[], { keep: string; merge: string }][] = [
      [[cats[0] as Row], { keep: A, merge: B }],
      [[cat(A, '购物', { deleted_at: 1 }), cats[1] as Row], { keep: A, merge: B }],
      [[cats[0] as Row, cat(B, '购物清单', { undone: true })], { keep: A, merge: B }],
      [[cats[0] as Row, cat(B, '购物清单', { merged_into: uid(7) })], { keep: A, merge: B }],
      [cats, { keep: A, merge: A }],
    ];
    for (const [c, pair] of bad) {
      const s = stub();
      expect(await mergeCategories(pair, c, s.deps)).toEqual({ ok: false, reason: 'gone' });
      expect(s.calls).toHaveLength(0);
    }
  });

  it('B 这个分类行只读 → readonly，一笔不写', async () => {
    const s = stub(undefined, [B]);
    expect(await mergeCategories({ keep: A, merge: B }, cats, s.deps)).toEqual({ ok: false, reason: 'readonly' });
    expect(s.calls).toHaveLength(0);
  });

  it('没写进去 → 原因原样返回；抛 OutboxRejectError → rejected', async () => {
    expect(await mergeCategories({ keep: A, merge: B }, cats, stub(() => ({ ok: false, reason: 'closing' })).deps)).toEqual({ ok: false, reason: 'closing' });
    const s = stub(() => {
      throw new OutboxRejectError('invalid_row');
    });
    expect(await mergeCategories({ keep: A, merge: B }, cats, s.deps)).toEqual({ ok: false, reason: 'rejected' });
  });
});

describe('mergeCategories：真 outbox（假 IndexedDB 冷启动）', () => {
  setupImageTests();
  const serverCat = (id: string, name: string, sort: number): ServerRow =>
    ({ id, name, color: null, sort, created_by: 'user', merged_into: null, deleted_at: null, undone: false, rev: 1 }) as ServerRow;

  it('队列只有分类一项 patch {merged_into: A}、没有依赖；本机集合读出来 B 下的条目归到 A', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('categories', [{ row: serverCat(A, '购物', 0) }, { row: serverCat(B, '购物清单', 1) }]);
      await b.outbox?.applyServer('notes', [{ row: { ...serverNote(1), category_id: B } as ServerRow }, { row: { ...serverNote(2), category_id: A } as ServerRow }]);
    });
    const cats = collection<Row>('categories').getSnapshot();
    expect(await mergeCategories({ keep: A, merge: B }, cats)).toEqual({ ok: true });
    const q = (await b.outbox?.list()) ?? [];
    expect(q.map((i) => [i.op, i.table, i.id, i.data, i.deps])).toEqual([['patch', 'categories', B, { merged_into: A }, []]]);
    const items = noteItems(collection<Row>('notes').getSnapshot(), collection<Row>('categories').getSnapshot(), TZ);
    expect(items.map((i) => i.categoryId)).toEqual([A, A]);
    // 编辑页不传分类时读本机集合，同样归到 A
    expect(formOf({ ...serverNote(1), category_id: B }).category_id).toBe(A);
  });

  it('连点两对“不合并”：页面还没重新渲染（rows 停在点之前），两对都记下，后一下不盖掉前一下', async () => {
    await boot();
    const stale: SettingRow[] = [];
    let n = 0;
    const writer = createSettingWriter({ rows: () => stale, newId: () => uid(900 + ++n), onResult: () => undefined });
    await act(async () => {
      await Promise.all([dismissMerge(writer, { keep: A, merge: B }), dismissMerge(writer, { keep: A, merge: C })]);
    });
    const row = collection<SettingRow>('settings').getSnapshot().find((r) => r.key === MERGE_DISMISSED_KEY);
    expect(row?.value).toEqual([[A, B], [A, C]]);
  });
});
