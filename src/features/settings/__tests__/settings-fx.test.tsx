// 设置首页“声音和触感”（R-471）：默认开；关掉写 settings ui.fx = false，再打开写回 true；关着时 fx 不响不震（platform/feedback.ts 读同一个集合）
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { resetFxForTest, startFx } from '../../../platform/feedback.ts';
import { fx } from '../../../platform/fx-api.ts';
import { renderPage } from './fakes.tsx';

type Row = { id: string; key?: unknown; value?: unknown };
// 写设置要本机库（同 settings-todo-autodel.test.tsx）
async function boot() {
  const { factory } = fakeIndexedDB();
  return coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
}
const values = () => collection<Row>('settings').getSnapshot().map((r) => [r.key, r.value]);
const nav = navigator as unknown as { vibrate?: unknown };

beforeEach(() => {
  clearAllCollections();
  window.history.replaceState(null, '', '#/settings');
  nav.vibrate = vi.fn(() => true);
  startFx(collection<Row>('settings'));
});
afterEach(() => {
  cleanup();
  getBoot()?.cache?.close();
  resetBootForTest();
  resetFxForTest();
  delete nav.vibrate;
  uiStore.getState().setLocale('zh-CN');
});

describe('声音和触感（R-471）', () => {
  it('默认开；关掉写 ui.fx = false、之后拖起不震；再打开写 true', async () => {
    await boot();
    await renderPage();
    const sw = (await screen.findByTestId('settings-fx')) as HTMLInputElement;
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.checked).toBe(true);
    expect(sw.closest('li')?.textContent).toContain('声音和触感');
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() => expect(values()).toEqual([['ui.fx', false]]));
    expect(sw.checked).toBe(false);
    fx('lift');
    expect(nav.vibrate).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() => expect(values()).toEqual([['ui.fx', true]]));
    fx('lift');
    expect(nav.vibrate).toHaveBeenCalledTimes(1);
  });

  it('韩文', async () => {
    uiStore.getState().setLocale('ko-KR');
    await renderPage();
    const sw = await screen.findByTestId('settings-fx');
    expect(sw.closest('li')?.textContent).toContain('소리 및 햅틱');
  });
});
