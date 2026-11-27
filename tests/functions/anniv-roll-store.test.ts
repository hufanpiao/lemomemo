// anniv-roll/store.ts 的查询写法（B5 整块评审第 8、9 条）：supabase-js 换成记调用的假客户端（fake-admin.ts），核对
// 挑行只要没撤销的、next_date 为空的排在最后（永远算不出的行不每天占名额）；写回带 rev 和 remind_at 两个乐观条件、带 user_id。
// store.ts 顶上有 `import type … from 'npm:…'`：路径放在变量里动态加载（写法同 push-dispatch-store.test.ts）
import { describe, expect, it } from 'vitest';
import { fakeAdmin } from './fake-admin.ts';

const STORE_PATH = '../../supabase/functions/anniv-roll/store.ts';
const { makeStore, ROLL_COLS } = (await import(/* @vite-ignore */ STORE_PATH)) as {
  makeStore: (a: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>>;
  ROLL_COLS: string;
};

describe('anniv-roll store.ts', () => {
  it('挑行：没删、没撤销；next_date 为空的排最后', async () => {
    const { admin, chains } = fakeAdmin();
    await makeStore(admin).candidates?.('2026-11-30', '2026-12-03', 1000);
    const c = chains[0] ?? [];
    expect(c).toContainEqual(['is', 'deleted_at', null]);
    expect(c).toContainEqual(['eq', 'undone', false]);
    expect(c).toContainEqual(['order', 'next_date', { ascending: true, nullsFirst: false }]);
  });
  it('写回：带 user_id、rev、remind_at 条件；读的列里有 rev、snooze_at、defer_until', async () => {
    const { admin, chains } = fakeAdmin({ data: [{ id: 'x' }], error: null });
    const row = { id: 'x', user_id: 'u', rev: 7, remind_at: 5, next_date: null, archived_at: null, kind: 'birthday', after_due: 'archive' };
    expect(await makeStore(admin).write?.(row, { next_date: '2027-01-01', remind_at: 6, archived_at: null })).toBe(true);
    const c = chains[0] ?? [];
    expect(c).toContainEqual(['eq', 'user_id', 'u']);
    expect(c).toContainEqual(['eq', 'rev', 7]);
    expect(c).toContainEqual(['eq', 'remind_at', 5]);
    for (const col of ['rev', 'snooze_at', 'defer_until', 'undone']) expect(ROLL_COLS.split(', ')).toContain(col);
  });
});
