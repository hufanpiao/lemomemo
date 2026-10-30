// 导出、注销界面测试共用的假依赖（account.test.tsx、delete-account.test.tsx）
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { AccountApi, AccountResult, ExportFile, ExportPart } from '../data/account-api.ts';
import type { RecentExportResult } from '../data/recent-exports.ts';
import type { SettingsDeps } from '../hooks/useSettingsPage.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { fakeApi, fakeExit, now } from './fakes.tsx';

export const EXPORT_ID = '9b2e4c6a-0000-4000-8000-0000000000aa';
/** 像一个 gzip 成员的假片（开头 1f 8b、至少 18 字节，过得了 export-run.ts 的 K3 核对）；n 是总字节数 */
export function gzLike(n = 18): Blob {
  const b = new Uint8Array(Math.max(18, n));
  b[0] = 0x1f;
  b[1] = 0x8b;
  return new Blob([b]);
}

export const FILE: ExportFile = { blob: new Blob(['gz']), name: 'lemomemo-export-2026-10-29.json.gz', vaultOmitted: true };

export function fakeAccount(over: Partial<AccountApi> = {}) {
  return {
    // 分片导出（0.47）：start 给一个任务；默认一片就写完，内容 'gz'，文件名取 content-disposition
    startExport: vi.fn(async (_id: string | null) => ({ ok: true as const, value: { exportId: EXPORT_ID, exportedAt: '2026-10-29T03:00:00.000Z', sid: 's-me' } })),
    takePart: vi.fn(async (_e: string, _c: string | null, _s: string | null): Promise<AccountResult<ExportPart>> => ({
      ok: true as const,
      value: { blob: gzLike(), next: null, disposition: `attachment; filename=${FILE.name}`, contentLength: null, contentEncoding: null },
    })),
    requestDeletion: vi.fn(async (_c: string) => ({ ok: true as const, value: { purgeAfter: '2026-11-05T03:00:00Z', sid: 's-me' } })),
    ...over,
  };
}

export function setup(o: { account?: ReturnType<typeof fakeAccount>; resolveDisabled?: SettingsDeps['resolveDisabled']; pending?: number | null; save?: () => Promise<'shared' | 'downloaded' | 'cancelled' | 'needs_tap'>; recent?: () => Promise<RecentExportResult>; hash?: string } = {}) {
  // 注销页有自己的地址（#/settings/delete）：每次从设置首页开始，上一条用例留下的地址不带过来
  window.history.replaceState(null, '', o.hash ?? '#/settings');
  const api = fakeApi();
  const { exit, order } = fakeExit('pending' in o ? (o.pending ?? null) : 0);
  const account = o.account ?? fakeAccount();
  const leave = vi.fn(async (_n: 'pending_deletion' | 'disabled' | 'disabled_unsure', _sid: string | null) => void order.push('leave'));
  const save = vi.fn(o.save ?? (async () => 'downloaded' as const));
  const readDeviceId = vi.fn(async () => 'dev-1');
  const recentExports = { list: vi.fn(o.recent ?? (async (): Promise<RecentExportResult> => ({ kind: 'none' }))) };
  const probe = o.resolveDisabled ? { resolveDisabled: o.resolveDisabled } : {};
  render(<SettingsPage deps={{ api, exit, now, account, leaveAccount: leave, saveExport: save, readDeviceId, recentExports, ...probe }} />);
  return { api, exit, order, account, leave, save, readDeviceId, recentExports };
}

export function setOnline(v: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v });
  window.dispatchEvent(new Event(v ? 'online' : 'offline'));
}

export const exportBtn = (): HTMLButtonElement => screen.getByTestId('settings-export') as HTMLButtonElement;
