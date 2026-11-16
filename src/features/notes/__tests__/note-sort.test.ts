// 随手记、隐私记长按拖动排序（data/note-list.ts 的自己排、data/note-sort.ts；R-429）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { orderOf } from '../../../../shared/logic/sort-key.ts';
import { noteItems, type Row } from '../data/note-list.ts';
import { applyNoteSort, planNoteDrop } from '../data/note-sort.ts';

const TZ = 'Asia/Seoul';
const at = (h: number) => msAt('2026-11-10', h * 60, TZ);
const note = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, title: null, body: id, is_private: false, category_id: null, category_source: 'none', category_seen: true, deleted_at: null, undone: false, sort_key: null, created_at: at(9), ...over,
});
const NOW = at(20);

describe('排序方式', () => {
  it('只认 manual，别的都是按时间', () => {
    expect(orderOf('manual')).toBe('manual');
    expect(orderOf('time')).toBe('time');
    expect(orderOf(undefined)).toBe('time');
    expect(orderOf(3)).toBe('time');
  });

  it('自己排：拖过的按排序值，没拖过的按记的时刻，新记的仍在最上面；按时间排不看排序值', () => {
    const rows = [note('old', { created_at: at(8) }), note('mid', { created_at: at(10) }), note('dragged', { created_at: at(7), sort_key: '17' }), note('new', { created_at: at(19) })];
    // '17' 读成 0.17、比 2026 年的时间键（0.17xx…）小还是大取决于数，这里拿时间键换算：给 dragged 一个夹在 mid 和 old 之间的键
    const mid = noteItems(rows, [], TZ, null, [], [], 'manual');
    expect(mid[0]?.id).toBe('new');
    const kOld = mid.find((x) => x.id === 'old')?.key ?? '';
    const kMid = mid.find((x) => x.id === 'mid')?.key ?? '';
    const rows2 = rows.map((r) => (r.id === 'dragged' ? { ...r, sort_key: planNoteDrop([{ id: 'mid', key: kMid, sortKey: null }, { id: 'dragged', key: '1', sortKey: null }, { id: 'old', key: kOld, sortKey: null }], 'dragged', 1, NOW)[0]?.key } : r));
    expect(noteItems(rows2, [], TZ, null, [], [], 'manual').map((x) => x.id)).toEqual(['new', 'mid', 'dragged', 'old']);
    expect(noteItems(rows2, [], TZ, null, [], [], 'time').map((x) => x.id)).toEqual(['new', 'mid', 'old', 'dragged']);
  });
});

describe('planNoteDrop', () => {
  it('按页面上这一串算，一般只写拖的这一条；撤销写回真正的 sort_key（没拖过是 null，不是时间键）', () => {
    const shown = noteItems([note('a', { created_at: at(12) }), note('b', { created_at: at(11) }), note('c', { created_at: at(10) })], [], TZ);
    const w = planNoteDrop(shown, 'c', 0, NOW);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ id: 'c', prev: null });
    expect((w[0]?.key ?? '') > shown[0]!.key).toBe(true);
  });

  it('R-429 评审第 2 条：按时间排时拖动要切到自己排，这一串里以前拖过的旧排序值一起清掉，切过去顺序就是松手时页面上的顺序；撤销写回原值', () => {
    const rows = [note('a', { created_at: at(12) }), note('b', { created_at: at(11), sort_key: '9' }), note('c', { created_at: at(10) })];
    const shown = noteItems(rows, [], TZ, null, [], [], 'time');
    expect(shown.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    const w = planNoteDrop(shown, 'c', 0, NOW, true);
    const after = rows.map((r) => {
      const x = w.find((y) => y.id === r.id);
      return x ? { ...r, sort_key: x.key } : r;
    });
    expect(noteItems(after, [], TZ, null, [], [], 'manual').map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(w.find((x) => x.id === 'b')).toEqual({ id: 'b', key: null, prev: '9' });
    // 本来就是自己排：不动别的条
    expect(planNoteDrop(noteItems(rows, [], TZ, null, [], [], 'manual'), 'c', 0, NOW, false).map((x) => x.id)).toEqual(['c']);
  });

  it('applyNoteSort：每一笔经 patch 写 sort_key（不带 remind）；撤销写 prev；一笔没成回那一笔的结果', async () => {
    const calls: unknown[][] = [];
    const io = { patch: async (...a: [string, string, Record<string, unknown>, boolean]) => { calls.push(a); return a[1] === 'bad' ? ('readonly' as const) : ('saved' as const); } };
    const writes = [{ id: 'a', key: '5', prev: null }, { id: 'b', key: '4', prev: '9' }];
    expect(await applyNoteSort(io, writes, false)).toBe('ok');
    expect(calls).toEqual([['notes', 'a', { sort_key: '5' }, false], ['notes', 'b', { sort_key: '4' }, false]]);
    calls.length = 0;
    await applyNoteSort(io, writes, true);
    expect(calls.map((c) => c[2])).toEqual([{ sort_key: null }, { sort_key: '9' }]);
    expect(await applyNoteSort(io, [{ id: 'bad', key: '5', prev: null }], false)).not.toBe('ok');
  });
});
