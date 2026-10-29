// 设置页组件测试共用的假数据和假依赖（SettingsPage.test.tsx、exit.test.tsx）
// 接口、清本机和跳转都用假的；order 记下各步的先后
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import type { DeviceRow } from '../data/devices.ts';
import { failWith, type Failure, type LocalSignOut, type SettingsApi, type SettingsErr } from '../data/settings-api.ts';
import type { ExitDeps } from '../hooks/useSessionExit.ts';
import { zh } from '../i18n/zh.ts';
import SettingsPage from '../ui/SettingsPage.tsx';

/** 元素的文字（没有 jest-dom，用 textContent） */
export const text = (el: Element | null | undefined): string => el?.textContent ?? '';

export const NOW = Date.parse('2026-10-29T03:00:00Z');
export const now = () => NOW;
export const DAY = 86_400_000;

export const ROWS: DeviceRow[] = [
  { id: 'y', label: null, platform: 'windows', last_seen_at: new Date(NOW - DAY).toISOString(), created_at: null, session_id: 's-me' },
  { id: 'x', label: 'A 的 iPhone', platform: 'ios', last_seen_at: new Date(NOW - 2 * DAY).toISOString(), created_at: null, session_id: 's-x' },
  { id: 'n', label: null, platform: 'web', last_seen_at: null, created_at: new Date(NOW - 160 * DAY).toISOString(), session_id: null },
  { id: 'z', label: '旧电脑', platform: 'windows', last_seen_at: new Date(NOW - 3 * DAY).toISOString(), created_at: null, session_id: 's-gone' },
];
export const SESSIONS = [{ orphan_count: 2, orphan_last_at: new Date(NOW - DAY).toISOString(), signed_out_device_ids: ['n', 'z'] }];

export type Fake = SettingsApi & { [K in keyof SettingsApi]: ReturnType<typeof vi.fn> };
/** 失败结果；revoked、signed_out 带上被拒那次请求的会话（默认 s-me，同 fakeExit 的 readSessionId） */
export const fail = (error: SettingsErr, sid: string | null = 's-me'): Failure => failWith(error, sid);

/** order 记下各步的先后：row = 删本机那一行，signout = signOut local（fakeExit 里：session = 删本机会话） */
export function fakeApi(over: Partial<SettingsApi> = {}, order: string[] = []): Fake {
  const ok = { ok: true as const, value: undefined };
  const done: LocalSignOut = { serverDone: true };
  return {
    loadDevices: vi.fn(async () => ({ ok: true as const, value: { rows: ROWS, sessions: SESSIONS, session: 's-me' } })),
    removeDevice: vi.fn(async () => ok),
    signOutOthers: vi.fn(async () => ok),
    deleteOwnDevice: vi.fn(async () => void order.push('row')),
    dropLocalSession: vi.fn(async () => {
      order.push('signout');
      return done;
    }),
    saveLocale: vi.fn(async () => ok),
    ...over,
  } as Fake;
}

export function fakeExit(pending: number | null = 0) {
  const order: string[] = [];
  const exit = {
    wipe: vi.fn(async () => {
      order.push('wipe');
      return true;
    }),
    deleteDb: vi.fn(async () => void order.push('deleteDb')),
    clearCacheStorage: vi.fn(async () => void order.push('caches')),
    clearLocalSessionIf: vi.fn((_sid: string | null): void => void order.push('session')),
    readSessionId: vi.fn((): string | null => 's-me'),
    readUserId: vi.fn((): string | null => 'u1'),
    pendingCount: vi.fn(async () => pending),
    goToAuth: vi.fn(() => void order.push('auth')),
    releaseHold: vi.fn(),
  } satisfies ExitDeps;
  return { exit, order };
}

/** 手动放行的 Promise */
export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export async function renderPage(api: SettingsApi = fakeApi(), exit: ExitDeps = fakeExit().exit, redirectMs = 5000) {
  render(<SettingsPage deps={{ api, exit, now, redirectMs }} />);
  await waitFor(() => expect(screen.getAllByTestId('settings-device').length).toBeGreaterThan(0));
}

export const rowAt = (i: number): HTMLElement => screen.getAllByTestId('settings-device')[i] as HTMLElement;

export async function confirmWith(label: string) {
  const dlg = await screen.findByRole('dialog');
  await act(async () => {
    fireEvent.click(within(dlg).getByRole('button', { name: label }));
  });
}

export async function clickSignOut() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: zh['settings.account.signOut'] }));
  });
}
