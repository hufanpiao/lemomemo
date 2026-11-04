// busy 令牌作废后（BUSY-wire，B2 FA-5；接手清单第 184 行）：作废只解除横幅压制，不当成已释放——
// 持有方可能还在编辑、录音，自动重新载入的路（onCacheVersionChange、别的令牌释放）要等它真的释放
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SwUpdateResult } from '../../platform/sw-register.ts';
import { BUSY_MAX_MS, createUpgradeCenter, type UpgradeDeps } from '../upgrade.ts';

function deps(): UpgradeDeps {
  return {
    appVersion: '4.0.0',
    reload: vi.fn(),
    swUpdate: vi.fn(() => Promise.resolve<SwUpdateResult>('reloading')),
    attempt: { get: () => null, set: () => undefined },
    log: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('busy 令牌作废不当成已释放', () => {
  it('作废后别的标签页升级本机库（onCacheVersionChange）：不重新载入；持有方真的释放了才载入', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = deps();
    const u = createUpgradeCenter(d);
    const release = u.holdBusy('editing');
    vi.advanceTimersByTime(BUSY_MAX_MS);
    expect(u.getState().busy).toBe(false);
    u.onCacheVersionChange();
    expect(d.reload).not.toHaveBeenCalled();
    release();
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it('一个作废、一个按时，按过“更新”在等：按时的那个一释放就载入（U1：用户的决定，作废的不挡），作废的之后再放也不再载入', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = deps();
    // 载入那一刻横幅压制已经解除（FA-5 复审 N4）
    const busyAtReload: boolean[] = [];
    d.reload = vi.fn(() => {
      busyAtReload.push(u.getState().busy);
    });
    const u = createUpgradeCenter(d);
    const stale = u.holdBusy('recording');
    vi.advanceTimersByTime(BUSY_MAX_MS / 2);
    const edit = u.holdBusy('editing');
    u.reportUpgradeRequired('4.1.0');
    await u.requestUpdate();
    vi.advanceTimersByTime(BUSY_MAX_MS / 2);
    expect(u.getState().busy).toBe(true);
    expect(d.reload).not.toHaveBeenCalled();
    edit();
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(busyAtReload).toEqual([false]);
    stale();
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it('U1 对照：只剩作废令牌时按“更新”，当场载入——和上一条“等正常令牌释放后载入”是同一条规则', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = deps();
    const u = createUpgradeCenter(d);
    const stale = u.holdBusy('recording');
    vi.advanceTimersByTime(BUSY_MAX_MS);
    u.reportUpgradeRequired('4.1.0');
    await u.requestUpdate();
    expect(d.reload).toHaveBeenCalledTimes(1);
    stale();
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it('按过“更新”在等、正常令牌不是被释放而是到点作废：不载入，等着的“更新”回到 idle；下次按直接载入', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = deps();
    const u = createUpgradeCenter(d);
    u.holdBusy('editing');
    u.reportUpgradeRequired('4.1.0');
    await u.requestUpdate();
    expect(u.getState().update).toBe('updating');
    vi.advanceTimersByTime(BUSY_MAX_MS);
    expect(d.reload).not.toHaveBeenCalled();
    expect(u.getState().update).toBe('idle');
    expect(u.getState().busy).toBe(false);
    await u.requestUpdate();
    expect(d.reload).toHaveBeenCalledTimes(1);
  });
});
