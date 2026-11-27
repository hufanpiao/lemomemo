// 待办行的 memo 守着（流畅度实测 11-25 第 1 条，独立评审 11-25 第 3 条补单测）：待办页 80 行，勾一条，从点下、保存回来、停一拍、收起到归进“已完成”，
// 只有被勾的那一行重画，别的 79 行一次都不重画（原来页面每次传内联回调、todoOf 给新对象，memo 从不命中，勾一次 80 行各重画约 7 次）。
// 怎么数：kit CheckCircle 换成一层不带 memo 的外壳，TodoRowView 每画一次它就跟着画一次，按 testId（todos-done-<id>）记次数
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { loadMotionFeatures } from '../../../motion/index.ts';
import type * as CheckCircleMod from '../../../kit/components/CheckCircle.tsx';

await loadMotionFeatures();

const renders = new Map<string, number>();
vi.mock('../../../kit/components/CheckCircle.tsx', async (orig) => {
  const m = await orig<typeof CheckCircleMod>();
  const Real = m.CheckCircle;
  return {
    ...m,
    CheckCircle: (p: ComponentProps<typeof Real>) => {
      renders.set(p.testId, (renders.get(p.testId) ?? 0) + 1);
      return <Real {...p} />;
    },
  };
});

type Row = { id: string } & Record<string, unknown>;
const db = { rows: [] as Row[], subs: new Set<() => void>() };
const put = (rows: Row[]) => {
  db.rows = rows;
  for (const f of db.subs) f();
};
vi.mock('../../../kit/hooks/useCollection.ts', () => ({
  useCollection: () =>
    useSyncExternalStore(
      (f: () => void) => {
        db.subs.add(f);
        return () => db.subs.delete(f);
      },
      () => db.rows,
    ),
}));
// 保存马上回来：整张表换成新数组、每一行都是新对象（和真的集合一样：一变全新），memo 要按值比才命中
vi.mock('../../../core/todo-done.ts', () => ({
  doneToggler: () => async (r: Row, done: boolean) => {
    put(db.rows.map((x) => ({ ...x, ...(x.id === r.id ? { done, done_at: done ? 1 : null } : {}) })));
    return 'saved';
  },
}));

const { default: TodosPage } = await import('../ui/TodosPage.tsx');
await import('../../../core/todo-writes.ts');
const { HOLD_MS, OUT_MS } = await import('../../../kit/components/useDoneFlow.ts');

const N = 80;
const ids = Array.from({ length: N }, (_, i) => `t${String(i).padStart(2, '0')}`);

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(Date.UTC(2026, 10, 25, 0));
  put(ids.map((id, i) => ({ id, title: `待办 ${i}`, done: false })));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

describe('待办行 memo', () => {
  it(`待办页 ${N} 行勾一条：从点下到收进“已完成”，只有那一行重画`, async () => {
    render(<TodosPage />);
    expect(screen.getAllByTestId(/^todos-done-t\d\d$/)).toHaveLength(N);
    renders.clear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hit = 'todos-done-t40';
    await act(async () => {
      fireEvent.click(screen.getByTestId(hit));
      for (let i = 0; i < 50; i++) await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS + OUT_MS + 500);
    });
    // 真勾上了、也真重画了（不是什么都没发生）
    expect(db.rows.find((r) => r.id === 't40')?.['done']).toBe(true);
    expect(renders.get(hit) ?? 0).toBeGreaterThan(0);
    const others = [...renders].filter(([k]) => k !== hit && /^todos-done-t\d\d$/.test(k));
    expect(others, '别的行重画了').toEqual([]);
  });
});
