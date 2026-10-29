// 导出、注销界面测试共用的假依赖（account.test.tsx、delete-account.test.tsx）
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { AccountApi, ExportFile } from '../data/account-api.ts';
import type { RecentExportResult } from '../data/recent-exports.ts';
import type { SettingsDeps } from '../hooks/useSettingsPage.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { fakeApi, fakeExit, now } from './fakes.tsx';

export const FILE: ExportFile = { blob: new Blob(['gz']), name: 'lemomemo-export-2026-10-29.json.gz', vaultOmitted: true };

export function fakeAccount(over: Partial<AccountApi> = {}) {
  return {
    exportAll: vi.fn(async (_id: string | null) => ({ ok: true as const, value: FILE })),
    requestDeletion: vi.fn(async (_c: string) => ({ ok: true as const, value: { purgeAfter: '2026-11-05T03:00:00Z', sid: 's-me' } })),
    ...over,
  };
}

export function setup(o: { account?: ReturnType<typeof fakeAccount>; resolveDisabled?: SettingsDeps['resolveDisabled']; pending?: number | null; save?: () => Promise<'shared' | 'downloaded' | 'cancelled' | 'needs_tap'>; recent?: () => Promise<RecentExportResult> } = {}) {
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
