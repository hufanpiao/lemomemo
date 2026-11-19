// 把几条记录归进某个分类（负责人 11-19“也可以在分类里倒入没分类的记录”，勾选多条一次导入）：
// 逐条写 category_id + 手动归类标记；写成几条、没写成几条照实回，日志不带标题和分类名
import { describe, expect, it, vi } from 'vitest';
import type { SaveOutcome } from '../../../core/edit-save.ts';

const logs = vi.hoisted(() => [] as string[]);
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: (s: string) => logs.push(s) }));

import { moveIntoCategory } from '../data/note-category.ts';

describe('moveIntoCategory', () => {
  it('每条写分类、手动归类、已看过、更新时间；全写成回 ok=2', async () => {
    const wrote: { id: string; data: Record<string, unknown> }[] = [];
    const io = {
      patch: vi.fn(async (_t: string, id: string, data: Record<string, unknown>, _remind: boolean) => {
        wrote.push({ id, data });
        return 'saved' as const;
      }),
    };
    const r = await moveIntoCategory(io, ['a', 'b'], 'c1', () => 99);
    expect(r).toEqual({ ok: 2, failed: 0 });
    expect(wrote).toEqual([
      { id: 'a', data: { category_id: 'c1', category_source: 'manual', category_seen: true, updated_at: 99 } },
      { id: 'b', data: { category_id: 'c1', category_source: 'manual', category_seen: true, updated_at: 99 } },
    ]);
    expect(io.patch.mock.calls.every((c) => c[0] === 'notes' && c[3] === false)).toBe(true);
    expect(logs.at(-1)).toBe('notes category into n=2 ok=2 fail=0');
  });

  it('有一条没写成：照实回 failed=1，其余照写', async () => {
    const io = { patch: vi.fn(async (_t: string, id: string): Promise<SaveOutcome> => (id === 'b' ? 'rejected' : 'saved')) };
    const r = await moveIntoCategory(io, ['a', 'b', 'c'], 'c1', () => 1);
    expect(r).toEqual({ ok: 2, failed: 1 });
    expect(io.patch).toHaveBeenCalledTimes(3);
    expect(logs.at(-1)).toBe('notes category into n=3 ok=2 fail=1');
  });
});
