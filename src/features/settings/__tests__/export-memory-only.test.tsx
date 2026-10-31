// QA 第四版核对补的断言（只补测试）：
// • TC-B1-123 ⑥ / 136 ⑤：导出任务（export_id、游标）只放内存——导出中、中断时 localStorage、sessionStorage、IndexedDB、Cache Storage、
//   地址里都没有；页面刷新（整页卸载再装）后没有“继续”，只能重新导出（会再 start 一次）
// • TC-B1-126 ⑤ / 137 ①：start 回 546（归成 try_later）或别的失败都不自动重发 start（重发会再算一次），提示“服务器忙，稍后再试”；
//   account-api 一层“546 → try_later、只发一次请求”在 account-api.test.ts 的 startExport 一组
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { AccountErr, AccountResult, ExportPart } from '../data/account-api.ts';
import { EXPORT_RETRY_DELAYS_MS } from '../data/export-run.ts';
import { zh } from '../i18n/zh.ts';
import { EXPORT_ID, exportBtn, fakeAccount, gzLike, setOnline, setup } from './account-fakes.tsx';
import { text } from './fakes.tsx';

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  setOnline(true);
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setOnline(true);
});

const CURSOR = 'cursor-after-part-1';
const part = (next: string | null): AccountResult<ExportPart> => ({
  ok: true,
  value: { blob: gzLike(64), next, disposition: null, contentLength: 64, contentEncoding: null },
});
const bad = (error: AccountErr): AccountResult<ExportPart> => ({ ok: false, error, sid: 's-me' });
const click = async (el: Element): Promise<void> => {
  await act(async () => {
    fireEvent.click(el);
  });
};

/** 本页能看到的各种存储和地址里，有没有出现导出任务的 id 或游标 */
function persisted(): string[] {
  const hits: string[] = [];
  const scan = (where: string, s: Storage): void => {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i) ?? '';
      const v = s.getItem(k) ?? '';
      if ([EXPORT_ID, CURSOR].some((x) => k.includes(x) || v.includes(x))) hits.push(`${where}:${k}`);
    }
  };
  scan('localStorage', localStorage);
  scan('sessionStorage', sessionStorage);
  if ([EXPORT_ID, CURSOR].some((x) => decodeURIComponent(window.location.href).includes(x))) hits.push(`url:${window.location.href}`);
  return hits;
}

describe('导出任务只放内存（TC-B1-123 ⑥、136 ⑤）', () => {
  it('导出中、中断时：localStorage、sessionStorage、地址里都没有 export_id 和游标；不开 IndexedDB、不碰 Cache Storage', async () => {
    // 盲区：这里靠 stubGlobal 换掉全局 indexedDB 来看有没有开库。将来若改用在 import 时就缓存 indexedDB 引用的库（Dexie、idb 等），
    // 替身拦不到它们，届时要改断言方式（例如在用例结束时列出 indexedDB.databases()，或直接查那个库的实例）
    const idbOpen = vi.fn();
    vi.stubGlobal('indexedDB', { open: idbOpen, deleteDatabase: vi.fn(), databases: vi.fn(async () => []) });
    const cacheOpen = vi.fn();
    vi.stubGlobal('caches', { open: cacheOpen, keys: vi.fn(async () => []), match: cacheOpen, delete: vi.fn(), has: vi.fn() });
    let release: (r: AccountResult<ExportPart>) => void = () => undefined;
    const takePart = vi.fn((_e: string, c: string | null) =>
      c === null ? Promise.resolve(part(CURSOR)) : new Promise<AccountResult<ExportPart>>((r) => { release = r; }));
    setup({ account: fakeAccount({ takePart }) });
    const hrefBefore = window.location.href;   // setup 把地址定到 #/settings
    await click(exportBtn());
    // 导出中：第二片还没回
    await waitFor(() => expect(takePart).toHaveBeenCalledTimes(2));
    expect(persisted()).toEqual([]);
    // 中断（bad_response 不自动重试、直接停下给“继续”）
    await act(async () => release(bad('bad_response')));
    await screen.findByTestId('settings-export-resume');
    expect(persisted()).toEqual([]);
    expect(window.location.href).toBe(hrefBefore);
    expect(idbOpen).not.toHaveBeenCalled();
    expect(cacheOpen).not.toHaveBeenCalled();
  });

  it('中断后刷新（整页卸载再装）：没有“继续”，只能重新导出，再点会重新 start（会算一次）', async () => {
    const first = fakeAccount({ takePart: vi.fn(async (_e: string, c: string | null) => (c === null ? part(CURSOR) : bad('bad_response'))) });
    setup({ account: first });
    await click(exportBtn());
    await screen.findByTestId('settings-export-resume');
    cleanup();   // 刷新：内存里的任务随页面一起没了
    const takeAgain = vi.fn(async (_e: string, _c: string | null) => part(null));
    const again = fakeAccount({ takePart: takeAgain });
    setup({ account: again });
    expect(screen.queryByTestId('settings-export-resume')).toBeNull();
    expect(screen.queryByTestId('settings-export-cancel')).toBeNull();
    expect(screen.queryByTestId('settings-export-progress')).toBeNull();
    expect(exportBtn().disabled).toBe(false);
    await click(exportBtn());
    await waitFor(() => expect(again.startExport).toHaveBeenCalledTimes(1));
    expect(takeAgain.mock.calls[0]?.[1]).toBeNull();   // 从第一片重新取，不带旧游标
  });
});

describe('start 失败不自动重发（TC-B1-126 ⑤、137 ①）', () => {
  it('start 回 try_later（546、5xx 都归成它）：提示“服务器忙，稍后再试”，过了自动重试的间隔也只调过一次 start，不取片', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const startExport = vi.fn(async () => ({ ok: false as const, error: 'try_later' as const, sid: 's-me' }));
    const account = fakeAccount({ startExport });
    setup({ account });
    await click(exportBtn());
    expect(text(await screen.findByRole('alert'))).toBe(zh['settings.err.tryLater']);
    const wait = EXPORT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 1000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(wait);
    });
    expect(startExport).toHaveBeenCalledTimes(1);
    expect(account.takePart).not.toHaveBeenCalled();
    expect(screen.queryByTestId('settings-export-resume')).toBeNull();
    // 用户自己再点一次才再 start（这一次也算一次，TC-B1-137 ①）
    await click(exportBtn());
    await waitFor(() => expect(startExport).toHaveBeenCalledTimes(2));
  });

  it('start 断网、出错同样不自动重发', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const error of ['offline', 'unknown'] as const) {
      const startExport = vi.fn(async () => ({ ok: false as const, error, sid: 's-me' }));
      setup({ account: fakeAccount({ startExport }) });
      await click(exportBtn());
      await screen.findByRole('alert');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(startExport, error).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });
});
