// 合并相近分类的本机部分（B4 S7，TC-B4-07 数据层部分）：notes.merge_dismissed 的读、追加、封顶；去掉点过“不合并”的提示对；
// 执行合并只写分类一笔 merged_into，条目在读的时候顺着 merged_into 归到留下的分类（删了再恢复的、晚到的也一样）
import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ServerRow } from '../../../core/cache.ts';
import { OutboxRejectError } from '../../../core/outbox.ts';
import { createSettingWriter, type SettingRow } from '../../../core/setting-write.ts';
import { collection } from '../../../core/store.ts';
import type { WriteResult } from '../../../core/write.ts';
import { idPairs, MERGE_DISMISSED_KEY, MERGE_SUGGEST_KEY, PAIRS_MAX, withPairs } from '../../../../shared/logic/notes/category-merge.ts';
import { dismissMerge, fixCategoryCycles, mergeCategories, openMergePairs, type MergeDeps } from '../data/category-merge-store.ts';
import { aiMarkKept, formOf, patchOf } from '../data/note-edit.ts';
import { isLiveCategory } from '../../../../shared/logic/live-row.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import { categoryCounts, cycleKeepers, noteItems, type Row } from '../data/note-list.ts';
import { boot, serverNote, setupImageTests, uid } from './note-images-kit.tsx';

const TZ = 'Asia/Seoul';
const A = uid(101);
const B = uid(102);
const C = uid(103);
/** 合并测试用的一对（why 只进日志） */
const AB = { keep: A, merge: B, why: 'contains' } as const;
const cat = (id: string, name: string, over: Record<string, unknown> = {}): Row => ({ id, name, sort: 0, deleted_at: null, undone: false, merged_into: null, ...over });
const set = (value: unknown, over: Record<string, unknown> = {}): SettingRow => ({ id: 's1', key: MERGE_DISMISSED_KEY, value, deleted_at: null, undone: false, ...over });
const note = (id: string, category: string | null, over: Record<string, unknown> = {}): Row => ({
  id, title: null, body: id, is_private: false, category_id: category, deleted_at: null, undone: false, created_at: 1, ...over,
});
/** settings.value 存成 jsonb 后的文字形式（逗号后有空格）；jsonb 存储不会比它大，库约束 pg_column_size(value) <= 4096 拿它当上限量 */
const jsonbText = (v: readonly (readonly [string, string])[]): string => `[${v.map(([a, b]) => `["${a}", "${b}"]`).join(', ')}]`;
const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe('idPairs / withPairs', () => {
  it('没存、不是数组 → 空；坏项（不是两个字符串、两个一样、空串）丢掉，其余照留；反着存的读出来 id 小的在前', () => {
    expect(idPairs(undefined)).toEqual([]);
    expect(idPairs({ a: 1 })).toEqual([]);
    expect(idPairs([['b', 'a'], ['x'], ['c', 'c'], ['', 'd'], [1, 2], 'ab', ['e', 'f', 'g'], ['f', 'e']])).toEqual([['a', 'b'], ['e', 'f']]);
  });
  it('(a,b) 和 (b,a) 结果相同，新的一对在最后；已有的再加 → 原样返回（同一个数组，不产生写入）', () => {
    const list: [string, string][] = [['m', 'n']];
    expect(withPairs(list, [['b', 'a']])).toEqual([['m', 'n'], ['a', 'b']]);
    expect(withPairs(list, [['a', 'b']])).toEqual(withPairs(list, [['b', 'a']]));
    expect(withPairs(list, [['n', 'm']])).toBe(list);
  });
  it(`已有 ${PAIRS_MAX} 对再加一对 → 仍 ${PAIRS_MAX} 对，原来第一对没了，新的在最后`, () => {
    const full = Array.from({ length: PAIRS_MAX }, (_, i): [string, string] => [uid(i * 2), uid(i * 2 + 1)]);
    const next = withPairs(full, [[uid(999), uid(998)]]);
    expect(next).toHaveLength(PAIRS_MAX);
    expect(next[0]).toEqual(full[1]);
    expect(next[PAIRS_MAX - 1]).toEqual([uid(998), uid(999)]);
  });
  it(`封顶后的值按 jsonb 文字量不超过 4096 字节（settings.value 的库约束）`, () => {
    const full = Array.from({ length: PAIRS_MAX + 5 }, (): [string, string] => [crypto.randomUUID(), crypto.randomUUID()])
      .reduce<readonly [string, string][]>((l, [a, b]) => withPairs(l, [[a, b]]), []);
    expect(full).toHaveLength(PAIRS_MAX);
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
  it('R-413 AI 判的（notes.merge_suggest）：“读书”和“书单”本机规则不算像，存了这一对就出，why = ai、留 sort 小的；存反了方向也一样', () => {
    const books = [cat(A, '书单', { sort: 2 }), cat(B, '读书', { sort: 1 })];
    const ai = (v: unknown): SettingRow => ({ id: 's2', key: MERGE_SUGGEST_KEY, value: v, deleted_at: null, undone: false });
    expect(openMergePairs(books, [])).toEqual([]);
    expect(openMergePairs(books, [ai([[A, B]])])).toEqual([{ keep: B, merge: A, why: 'ai' }]);
    expect(openMergePairs(books, [ai([[B, A]])])).toEqual([{ keep: B, merge: A, why: 'ai' }]);
    // 点过“不用”的照样去掉；分类删了、合并掉的不出；存的是坏值当空
    expect(openMergePairs(books, [ai([[A, B]]), set([[B, A]])])).toEqual([]);
    expect(openMergePairs([books[0] as Row, cat(B, '读书', { merged_into: C })], [ai([[A, B]])])).toEqual([]);
    expect(openMergePairs(books, [ai('坏值')])).toEqual([]);
  });
  it('R-413 AI 判的和本机规则判的是同一对：只出一次（AI 的在前）；不同的两对都出，AI 的排前面', () => {
    const ai = (v: unknown): SettingRow => ({ id: 's2', key: MERGE_SUGGEST_KEY, value: v, deleted_at: null, undone: false });
    expect(openMergePairs(cats, [ai([[A, B]])])).toEqual([{ keep: A, merge: B, why: 'ai' }]);
    const four = [...cats, cat(C, '读书', { sort: 2 }), cat(uid(104), '书单', { sort: 3 })];
    expect(openMergePairs(four, [ai([[C, uid(104)]])])).toEqual([{ keep: C, merge: uid(104), why: 'ai' }, { keep: A, merge: B, why: 'contains' }]);
  });
  it('dismissMerge：writer.update 只调一次，键是 notes.merge_dismissed，值是原有各对加上新的一对；分类已经不活着（删了、合并掉、没了）的旧对顺带去掉', async () => {
    const saved: [string, unknown][] = [];
    const writer = { update: (k: string, next: (cur: unknown) => unknown) => Promise.resolve(saved.push([k, next([[A, C], [B, C], [A, uid(9)], [uid(7), uid(8)]])]) > 0) };
    const live = [cat(A, '甲'), cat(B, '乙', { sort: 1 }), cat(C, '丙', { sort: 2 }), cat(uid(9), '丁', { merged_into: A }), cat(uid(7), '戊', { deleted_at: 1 })];
    await dismissMerge(writer, { keep: B, merge: A }, live);
    expect(saved).toEqual([[MERGE_DISMISSED_KEY, [[A, C], [B, C], [A, B]]]]);
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
    expect(await mergeCategories(AB, { ...s.deps, categories: () => cats })).toEqual({ ok: true });
    expect(s.calls).toEqual([{ table: 'categories', id: B, data: { merged_into: A } }]);
    const after = applied(cats, s.calls);
    const items = noteItems(notes, after, TZ);
    expect(items.filter((i) => i.id.startsWith('b')).map((i) => [i.id, i.categoryId])).toEqual([['b1', A], ['b2', A], ['b3', A]]);
    expect(noteItems(notes, after, TZ, A)).toHaveLength(4);
    expect(categoryCounts(notes, after, 'zh-CN').map((c) => [c.id, c.count])).toEqual([[A, 4]]);
  });

  it('合并完再算提示：这一对不再出', async () => {
    const s = stub();
    await mergeCategories(AB, { ...s.deps, categories: () => cats });
    expect(openMergePairs(cats, [])).toHaveLength(1);
    expect(openMergePairs(applied(cats, s.calls), [])).toEqual([]);
  });

  it('编辑页读的分类（formOf）也归到 A，和列表一致；不动分类时保存不写分类列', async () => {
    const s = stub();
    await mergeCategories(AB, { ...s.deps, categories: () => cats });
    const after = applied(cats, s.calls);
    const row = note('b1', B);
    const f = formOf(row, after);
    expect(f.category_id).toBe(A);
    expect(patchOf(row, f, { ...f, title: '改了标题' }, 9)).toEqual({ title: '改了标题', updated_at: 9 });
    expect(formOf(note('x', B), [cat(A, '甲', { deleted_at: 3 }), cat(B, '乙', { merged_into: A })]).category_id).toBeNull();
  });

  it('编辑页分类旁的“AI”（aiMarkKept）按归并后的分类比：AI 分到 B、B 合并进 A 后照样标，和列表一致；改了分类、不是 AI 分的、归不到活着的分类都不标', async () => {
    const s = stub();
    await mergeCategories(AB, { ...s.deps, categories: () => cats });
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
    await mergeCategories(AB, { ...s.deps, categories: () => cats });
    const after = applied(cats, s.calls);
    const restored = notes.map((n) => (n.id === 'bd' ? { ...n, deleted_at: null } : n));
    expect(noteItems([...restored, note('late', B)], after, TZ).filter((i) => ['bd', 'late'].includes(i.id)).map((i) => i.categoryId)).toEqual([A, A]);
  });

  it('连环合并顺着走到活着的那个；终点被删的当没分类', () => {
    const chain = [cat(A, '甲', { merged_into: C }), cat(B, '乙', { merged_into: A }), cat(C, '丙')];
    expect(noteItems([note('x', B)], chain, TZ)[0]?.categoryId).toBe(C);
    const dead = [cat(A, '甲', { deleted_at: 3 }), cat(B, '乙', { merged_into: A })];
    expect(noteItems([note('x', B)], dead, TZ)[0]?.categoryId).toBeNull();
  });

  it('两台设备各合并一次绕成圈（A → B、B → A）：圈里留 sort 小的（一样按 id 小的），两个分类下的条目都归到它、胶囊和名字照常；圈外指进来的也归到它', () => {
    const loop = [cat(A, '甲', { sort: 2, merged_into: B }), cat(B, '乙', { sort: 1, merged_into: A }), cat(C, '丙', { merged_into: A })];
    const rows = [note('a', A), note('b', B), note('c', C)];
    expect(noteItems(rows, loop, TZ).map((i) => [i.id, i.categoryId, i.categoryName])).toEqual([['a', B, '乙'], ['b', B, '乙'], ['c', B, '乙']]);
    expect(categoryCounts(rows, loop, 'zh-CN').map((c) => [c.id, c.name, c.count])).toEqual([[B, '乙', 3]]);
    expect(formOf(note('a', A), loop).category_id).toBe(B);
    const tie = [cat(B, '乙', { merged_into: A }), cat(A, '甲', { merged_into: B })];
    expect(noteItems([note('b', B)], tie, TZ)[0]?.categoryId).toBe(A);
    // 圈里有一个被删：走到它就当没分类（同终点被删）
    expect(noteItems([note('a', A)], [cat(A, '甲', { merged_into: B }), cat(B, '乙', { merged_into: A, deleted_at: 1 })], TZ)[0]?.categoryId).toBeNull();
  });

  it('keep 或 merge 不存在、已删、已撤销、已合并掉（keep 合掉了再合会绕成圈），或两个是同一个 → gone，一笔不写', async () => {
    const bad: [Row[], { keep: string; merge: string }][] = [
      [[cats[0] as Row], { keep: A, merge: B }],
      [[cat(A, '购物', { deleted_at: 1 }), cats[1] as Row], { keep: A, merge: B }],
      [[cats[0] as Row, cat(B, '购物清单', { undone: true })], { keep: A, merge: B }],
      [[cats[0] as Row, cat(B, '购物清单', { merged_into: uid(7) })], { keep: A, merge: B }],
      // keep 已经合进别处（这里合进 B 自己，再写就绕成圈）：不合
      [[cat(A, '购物', { merged_into: B }), cats[1] as Row], { keep: A, merge: B }],
      [cats, { keep: A, merge: A }],
    ];
    for (const [c, pair] of bad) {
      const s = stub();
      expect(await mergeCategories({ ...pair, why: 'same' }, { ...s.deps, categories: () => c })).toEqual({ ok: false, reason: 'gone' });
      expect(s.calls).toHaveLength(0);
    }
  });

  it('B 这个分类行只读 → readonly，一笔不写', async () => {
    const s = stub(undefined, [B]);
    expect(await mergeCategories(AB, { ...s.deps, categories: () => cats })).toEqual({ ok: false, reason: 'readonly' });
    expect(s.calls).toHaveLength(0);
  });

  it('没写进去 → 原因原样返回；抛 OutboxRejectError → rejected', async () => {
    expect(await mergeCategories(AB, { ...stub(() => ({ ok: false, reason: 'closing' })).deps, categories: () => cats })).toEqual({ ok: false, reason: 'closing' });
    const s = stub(() => {
      throw new OutboxRejectError('invalid_row');
    });
    expect(await mergeCategories(AB, { ...s.deps, categories: () => cats })).toEqual({ ok: false, reason: 'rejected' });
  });
});

describe('fixCategoryCycles（合并绕成圈的写回）', () => {
  it('圈里留下的那个写一笔 {merged_into: null}、只写一次；写完 isLiveCategory 认得它、合并提示和条目都按它；日志只记 id 和结果', async () => {
    const P = uid(301);
    const Q = uid(302);
    const loop = [cat(P, '工作', { sort: 2, merged_into: Q }), cat(Q, '工作', { sort: 1, merged_into: P }), cat(C, '工作室', { sort: 3 })];
    expect(cycleKeepers(loop)).toEqual([Q]);
    expect(openMergePairs(loop, [])).toEqual([]);
    const lines: string[] = [];
    (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
    const s = stub();
    await fixCategoryCycles(loop, s.deps);
    await fixCategoryCycles(loop, s.deps);
    delete (globalThis as Record<string, unknown>)[RL_SLOT];
    expect(s.calls).toEqual([{ table: 'categories', id: Q, data: { merged_into: null } }]);
    expect(lines).toEqual([`notes category cycle fix id=${Q} ok`]);
    const after = applied(loop, s.calls);
    expect(isLiveCategory(after.find((c) => c.id === Q) ?? {})).toBe(true);
    expect(cycleKeepers(after)).toEqual([]);
    expect(noteItems([note('p', P), note('q', Q)], after, TZ).map((i) => i.categoryId)).toEqual([Q, Q]);
    expect(openMergePairs(after, []).map((p) => [p.keep, p.merge])).toEqual([[Q, C]]);
  });

  it('写不进去记 fail，下次分类集合变化再试（写成后不再写）；抛异常只记错误名；只读行不写；没有圈不写', async () => {
    const P = uid(311);
    const Q = uid(312);
    const lines: string[] = [];
    (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
    const bad = stub(() => ({ ok: false, reason: 'closing' }));
    const loop = [cat(P, '甲', { merged_into: Q }), cat(Q, '乙', { merged_into: P })];
    await fixCategoryCycles(loop, bad.deps);
    await fixCategoryCycles(loop, bad.deps);
    expect([bad.calls.length, lines]).toEqual([2, [`notes category cycle fix id=${P} fail`, `notes category cycle fix id=${P} fail`]]);
    lines.length = 0;
    const boom = { deps: { ...bad.deps, w: { patch: () => { throw new TypeError('x'); } } } as unknown as MergeDeps };
    await fixCategoryCycles(loop, boom.deps);
    const good = stub();
    await fixCategoryCycles(loop, good.deps);
    await fixCategoryCycles(loop, good.deps);
    expect([good.calls.length, lines]).toEqual([1, [`notes category cycle fix id=${P} threw TypeError`, `notes category cycle fix id=${P} ok`]]);
    const ro = stub(undefined, [uid(321)]);
    await fixCategoryCycles([cat(uid(321), '甲', { merged_into: uid(322) }), cat(uid(322), '乙', { merged_into: uid(321) })], ro.deps);
    const none = stub();
    await fixCategoryCycles([cat(A, '甲'), cat(B, '乙', { merged_into: A })], none.deps);
    delete (globalThis as Record<string, unknown>)[RL_SLOT];
    expect([ro.calls, none.calls]).toEqual([[], []]);
  });
});

describe('fixCategoryCycles：圈解开以后又绕成圈', () => {
  it('写成了的 id 在圈解开（不再是 cycleKeepers）后拿掉，之后同一个分类又绕成圈还会再写回一次', async () => {
    const P = uid(331);
    const Q = uid(332);
    const loop = [cat(P, '甲', { sort: 2, merged_into: Q }), cat(Q, '乙', { sort: 1, merged_into: P })];
    const s = stub();
    await fixCategoryCycles(loop, s.deps);
    await fixCategoryCycles(loop, s.deps);
    expect(s.calls.map((c) => c.id)).toEqual([Q]);
    await fixCategoryCycles(applied(loop, s.calls), s.deps);
    await fixCategoryCycles(loop, s.deps);
    expect(s.calls.map((c) => c.id)).toEqual([Q, Q]);
  });
});

describe('mergeCategories：日志和异常', () => {
  const cats = [cat(A, '购物'), cat(B, '购物清单', { sort: 1 })];
  it('日志带 merge= keep= why=（ai 或 rule），不记分类名；写入口抛异常接住回 threw、只记错误名', async () => {
    const lines: string[] = [];
    (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
    await mergeCategories(AB, { ...stub().deps, categories: () => cats });
    await mergeCategories({ ...AB, why: 'ai' }, { ...stub(undefined, [B]).deps, categories: () => cats });
    const boom = { ...stub().deps, w: { patch: () => Promise.reject(new RangeError('x')) }, categories: () => cats } as MergeDeps;
    expect(await mergeCategories(AB, boom)).toEqual({ ok: false, reason: 'threw' });
    delete (globalThis as Record<string, unknown>)[RL_SLOT];
    expect(lines).toEqual([
      `notes merge category ok merge=${B} keep=${A} why=rule`,
      `notes merge category readonly merge=${B} keep=${A} why=ai`,
      `notes merge category threw RangeError merge=${B} keep=${A} why=rule`,
    ]);
    expect(lines.join(' ')).not.toMatch(/购物/);
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
    // 不传分类：调用时现读本机集合
    expect(await mergeCategories(AB)).toEqual({ ok: true });
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
      const live = [cat(A, '甲'), cat(B, '乙'), cat(C, '丙')];
      await Promise.all([dismissMerge(writer, { keep: A, merge: B }, live), dismissMerge(writer, { keep: A, merge: C }, live)]);
    });
    const row = collection<SettingRow>('settings').getSnapshot().find((r) => r.key === MERGE_DISMISSED_KEY);
    expect(row?.value).toEqual([[A, B], [A, C]]);
  });
});
