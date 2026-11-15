// 设置首页“完成 7 天后自动删除”（负责人 11-15 方案）：在主卡里“随手记显示方式”和“日历”之间；默认开；关掉写 settings todo.autodel = false，再打开写回 true
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { SETTINGS_CARDS } from '../data/sections.ts';
import { renderPage } from './fakes.tsx';

type Row = { id: string; key?: unknown; value?: unknown };
// 写设置要本机库（同 settings-notes-view.test.tsx）
async function boot() {
  const { factory } = fakeIndexedDB();
  return coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
}
const values = () => collection<Row>('settings').getSnapshot().map((r) => [r.key, r.value]);

beforeEach(() => {
  clearAllCollections();
  window.history.replaceState(null, '', '#/settings');
});
afterEach(() => {
  cleanup();
  getBoot()?.cache?.close();
  resetBootForTest();
  uiStore.getState().setLocale('zh-CN');
});

describe('完成 7 天后自动删除', () => {
  it('排在主卡“随手记显示方式”后面', () => {
    const main: readonly string[] = SETTINGS_CARDS[1].ids;
    expect(main.indexOf('todos')).toBe(main.indexOf('notesView') + 1);
  });

  it('默认开，不带说明（负责人 11-16 去掉）；关掉写 todo.autodel = false，再打开写 true', async () => {
    uiStore.getState().setLocale('zh-CN');
    await boot();
    await renderPage();
    const sw = (await screen.findByTestId('settings-todo-autodel')) as HTMLInputElement;
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.checked).toBe(true);
    expect(sw.closest('li')?.textContent).toContain('完成 7 天后自动删除');
    expect(sw.closest('li')?.textContent).not.toContain('最近删除');
    expect(screen.queryByTestId('settings-todo-trash')).toBeNull();
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() => expect(values()).toEqual([['todo.autodel', false]]));
    expect(sw.checked).toBe(false);
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() => expect(values()).toEqual([['todo.autodel', true]]));
  });

  it('韩文', async () => {
    uiStore.getState().setLocale('ko-KR');
    await renderPage();
    const sw = await screen.findByTestId('settings-todo-autodel');
    expect(sw.closest('li')?.textContent).toContain('완료 7일 후 자동 삭제');
  });
});
