// 顶部“同步暂停”横幅（复审建议 10-30；UpdateBanner 的 sync_paused）：主 App 收到 account_disabled、探测说账号正常，
// 但 5 分钟内已重新载入过一次（sync-wiring 限次）→ main.tsx 往 ui-store 推 sync-paused；横幅“同步暂停，请稍后重新打开 · 重新打开”，不给关
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpgradeCenter } from '../../core/upgrade.ts';
import { uiStore } from '../../kit/state/ui-store.ts';
import { zh } from '../../../shared/i18n/zh.ts';
import { ko } from '../../../shared/i18n/ko.ts';
import { bannerKind, UpdateBanner } from '../UpdateBanner.tsx';

const center = () =>
  createUpgradeCenter({ appVersion: '4.0.0', reload: vi.fn(), swUpdate: vi.fn(async () => 'failed' as const), attempt: { get: () => null, set: () => undefined } });

afterEach(() => {
  cleanup();
  uiStore.getState().dismissBanner('sync-paused');
});

describe('同步暂停横幅', () => {
  it('先后：需要更新 > 本机库已关 > 同步暂停 > 有新版本', () => {
    const base = { syncBlocked: null, cache: 'ok', blocked: false, update: 'idle', busy: false, swReady: false, swDismissed: false } as const;
    expect(bannerKind({ ...base, syncBlocked: { min: '4.1.0', source: '426' } }, true)).toBe('required');
    expect(bannerKind({ ...base, cache: 'closed_for_upgrade' }, true)).toBe('closed');
    expect(bannerKind({ ...base, swReady: true }, true)).toBe('sync_paused');
    expect(bannerKind({ ...base, busy: true }, true)).toBeNull();
    expect(bannerKind({ ...base, swReady: true }, false)).toBe('new_version');
  });

  it('ui-store 里推了 sync-paused：出横幅，文案对，只有“重新打开”一个按钮，点了重新载入', () => {
    const onReload = vi.fn();
    render(<UpdateBanner upgrade={center()} outbox={null} onReload={onReload} />);
    expect(screen.queryByTestId('update-banner')).toBeNull();
    act(() => uiStore.getState().pushBanner({ id: 'sync-paused', kind: 'sync-paused' }));
    const banner = screen.getByTestId('update-banner');
    expect(banner.dataset['kind']).toBe('sync_paused');
    expect(banner.textContent).toContain(zh['update.syncPaused']);
    expect(document.documentElement.dataset['topBanner']).toBe('sync_paused');
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('录音、编辑进行中（upgrade.busy）先不出，busy 归零后出（第六轮审查建议 ④）', () => {
    const u = center();
    const done = u.holdBusy('record');
    render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
    act(() => uiStore.getState().pushBanner({ id: 'sync-paused', kind: 'sync-paused' }));
    expect(screen.queryByTestId('update-banner')).toBeNull();
    act(() => done());
    expect(screen.getByTestId('update-banner').dataset['kind']).toBe('sync_paused');
  });

  it('词条中韩都有', () => {
    expect(zh['update.syncPaused']).toBe('同步暂停，请稍后重新打开');
    expect(ko['update.syncPaused'].length).toBeGreaterThan(0);
  });
});
