// 强制升级与新版本（架构 0.27 第 1 点）：挡同步不挡查看、以 426 的 min 为准、“更新”按钮三种结果、onversionchange 后自动重新载入
import { describe, expect, it, vi } from 'vitest';
import type { SwUpdateResult } from '../../platform/sw-register.ts';
import { createUpgradeCenter, type UpgradeDeps } from '../upgrade.ts';

function deps(over: Partial<UpgradeDeps> = {}): UpgradeDeps & { stored: { v: string | null } } {
  const stored = { v: null as string | null };
  return {
    appVersion: '4.0.0',
    reload: vi.fn(),
    swUpdate: vi.fn(() => Promise.resolve<SwUpdateResult>('reloading')),
    attempt: { get: () => stored.v, set: (m) => void (stored.v = m) },
    log: vi.fn(),
    stored,
    ...over,
  };
}

describe('挡同步（TC-B1-43）', () => {
  it('启动时按缓存的 min_client_version 比较；版本够了解除', () => {
    const u = createUpgradeCenter(deps());
    u.checkMinVersion('4.1.0');
    expect(u.getState().syncBlocked).toEqual({ min: '4.1.0', source: 'config' });
    u.checkMinVersion('4.0.0');
    expect(u.getState().syncBlocked).toBeNull();
    u.checkMinVersion(undefined);
    expect(u.getState().syncBlocked).toBeNull();
  });

  it('收到 426 用响应体里的 min，不用缓存的值；之后按缓存比较也不解除', () => {
    const u = createUpgradeCenter(deps());
    u.checkMinVersion('3.9.0');
    u.reportUpgradeRequired('4.2.0');
    expect(u.getState().syncBlocked).toEqual({ min: '4.2.0', source: '426' });
    u.checkMinVersion('3.9.0');
    expect(u.getState().syncBlocked).toEqual({ min: '4.2.0', source: '426' });
  });

  it('预览版号不被当成更低的版本', () => {
    const u = createUpgradeCenter(deps({ appVersion: '4.1.0-preview.3' }));
    u.checkMinVersion('4.1.0');
    expect(u.getState().syncBlocked).toBeNull();
  });

  it('状态不变时引用不变（useSyncExternalStore）', () => {
    const u = createUpgradeCenter(deps());
    const l = vi.fn();
    u.subscribe(l);
    const s0 = u.getState();
    u.checkMinVersion('3.0.0');
    expect(u.getState()).toBe(s0);
    expect(l).not.toHaveBeenCalled();
  });
});

describe('按“更新”（TC-B1-44）', () => {
  it('① 新 SW 装好：显示“正在更新…”，然后重新载入', async () => {
    const d = deps();
    const u = createUpgradeCenter(d);
    u.reportUpgradeRequired('4.1.0');
    const p = u.requestUpdate();
    expect(u.getState().update).toBe('updating');
    await p;
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(d.stored.v).toBe('4.1.0');
  });

  it('② registration.update() 失败：“更新失败 · 联网后再试”', async () => {
    const d = deps({ swUpdate: () => Promise.resolve<SwUpdateResult>('failed') });
    const u = createUpgradeCenter(d);
    u.reportUpgradeRequired('4.1.0');
    expect(await u.requestUpdate()).toBe('failed');
    expect(u.getState().update).toBe('failed');
    expect(d.reload).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith('update_failed');
  });

  it('③ 更新后版本仍不够：新页面启动时只提示“已是最新版本，请稍后再试”，不再自动重新载入，记错误码', async () => {
    const d = deps();
    const u1 = createUpgradeCenter(d);
    u1.reportUpgradeRequired('4.1.0');
    await u1.requestUpdate();
    // 重新载入以后（同一份 sessionStorage），版本还是 4.0.0
    const reload2 = vi.fn();
    const u2 = createUpgradeCenter({ ...d, reload: reload2 });
    u2.checkMinVersion('4.1.0');
    u2.afterReloadCheck();
    expect(u2.getState().update).toBe('still_old');
    expect(reload2).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith('update_still_old');
    expect(d.stored.v).toBeNull();
  });

  it('③ 没有新 SW（CDN 还没刷新）：直接 still_old，不重新载入', async () => {
    const d = deps({ swUpdate: () => Promise.resolve<SwUpdateResult>('no_update') });
    const u = createUpgradeCenter(d);
    u.reportUpgradeRequired('4.1.0');
    expect(await u.requestUpdate()).toBe('still_old');
    expect(d.reload).not.toHaveBeenCalled();
  });
});

describe('本机库被新版本要求关闭（TC-B1-48 的提示部分）', () => {
  it('空闲：自动重新载入', () => {
    const d = deps();
    const u = createUpgradeCenter(d);
    u.onCacheVersionChange();
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it('正在录音或编辑：先出“有新版本 · 重新打开”，结束时自动重新载入', () => {
    const d = deps();
    const u = createUpgradeCenter(d);
    const endRec = u.holdBusy('capture');
    const endEdit = u.holdBusy('note-edit');
    expect(u.getState().busy).toBe(true);
    u.onCacheVersionChange();
    expect(u.getState().cache).toBe('closed_for_upgrade');
    expect(d.reload).not.toHaveBeenCalled();
    endRec();
    expect(d.reload).not.toHaveBeenCalled();
    endEdit();
    endEdit();   // 重复调用无害
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it('被挡住、库来自更新的版本：状态给界面', () => {
    const u = createUpgradeCenter(deps());
    u.setBlocked(true);
    expect(u.getState().blocked).toBe(true);
    u.setCacheTooNew();
    expect(u.getState().cache).toBe('too_new');
  });

  it('库来自更新的版本：按过“去更新”重新载入后库仍比 App 新 → still_old，并清掉标记（复审 S3）', () => {
    const d = deps();
    d.stored.v = '';
    const u = createUpgradeCenter(d);
    u.setCacheTooNew();
    u.afterReloadCheck();
    expect(u.getState().update).toBe('still_old');
    expect(d.stored.v).toBeNull();
  });

  it('库来自更新的版本时按“更新”而没有新版本：still_old（整屏提示上不能点了没反应，K6-ver-new）', async () => {
    const u = createUpgradeCenter(deps({ swUpdate: vi.fn(() => Promise.resolve<SwUpdateResult>('no_update')) }));
    u.setCacheTooNew();
    expect(await u.requestUpdate()).toBe('still_old');
    expect(u.getState().update).toBe('still_old');
  });
});
