// “最近删除”加随手记（B4 S2；ADR-006）：删了的普通随手记出现在“最近删除”，标题没有时取正文第一行，写“随手记 · N 天后清理”；点恢复改回 deleted_at = null。
// 隐私记不在这里（R-193，B5）。永久删除、全部清空是 S9，这里不做
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { TRASH_KEEP_MS, trashOf } from '../data/trash.ts';
import RecentlyDeletedPage from '../ui/RecentlyDeletedPage.tsx';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const note = (n: number, over: Record<string, unknown> = {}) =>
  ({
    id: uid(n), title: null, body: `正文第一行${n}\n第二行`, is_private: false, category_id: null, category_source: 'none', category_seen: true, ai_status: 'done',
    tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null, deleted_at: NOW - DAY, undone: false, created_at: 1, updated_at: 1, rev: 2, ...over,
  }) as ServerRow;

beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('trashOf 加随手记', () => {
  it('删了不到 30 天的普通随手记进列表；隐私记、撤销了的、超过 30 天的不进；标题没有取正文第一行', () => {
    const rows = [note(1), note(2, { title: '有标题' }), note(3, { is_private: true, body: null }), note(4, { undone: true }), note(5, { deleted_at: NOW - TRASH_KEEP_MS - 1 })];
    expect(trashOf([], [], NOW, rows).map((i) => [i.table, i.title, i.daysLeft])).toEqual([
      ['notes', '有标题', 29],
      ['notes', '正文第一行1', 29],
    ]);
  });
});

describe('“最近删除”页', () => {
  it('随手记一行写“随手记 · 29 天后清理”；点恢复改回 deleted_at = null、出“已恢复”', async () => {
    const { factory } = fakeIndexedDB();
    const b = await coldStart({
      userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
      upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
    });
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: note(1) }]);
    });
    window.history.replaceState(null, '', '/app/#/trash');
    render(<RecentlyDeletedPage />);
    const row = screen.getByTestId(`trash-row-${uid(1)}`);
    expect(row.textContent).toContain('正文第一行1');
    expect(row.textContent).toContain('随手记 · 29 天后清理');
    expect(screen.getByText('删除的日程、待办和随手记在这里留 30 天，之后自动清理')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`trash-restore-${uid(1)}`));
    });
    await waitFor(() => expect(collection<{ id: string; deleted_at?: unknown }>('notes').get(uid(1))?.deleted_at).toBeNull());
    expect((await screen.findByTestId('trash-msg')).textContent).toBe('已恢复');
  });
});
