// 强制升级与新版本（架构 0.27 第 1 点）：挡同步不挡查看、以 426 的 min 为准、“更新”按钮三种结果、onversionchange 后自动重新载入
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SwUpdateResult } from '../../platform/sw-register.ts';
import { BUSY_MAX_MS, createUpgradeCenter, UPGRADE_LOG_DAILY_MAX, type BusyReason, type UpgradeDeps } from '../upgrade.ts';

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
    const endRec = u.holdBusy('recording');
    const endEdit = u.holdBusy('editing');
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

describe('接管超时和没查成分开（BANNER-sugg ⑤）', () => {
  it('takeover_timeout：不重新载入（swReady 时也不），显示 stalled，记 update_takeover_timeout；426 场景重启后不会误报 still_old', async () => {
    const d = deps({ swUpdate: () => Promise.resolve<SwUpdateResult>('takeover_timeout') });
    const u = createUpgradeCenter(d);
    u.reportUpgradeRequired('4.1.0');
    u.setSwReady();
    expect(await u.requestUpdate()).toBe('stalled');
    expect(u.getState().update).toBe('stalled');
    expect(d.reload).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith('update_takeover_timeout');
    // 没载入，也就不留“刚按过更新”的标记
    expect(d.stored.v).toBeNull();
  });

  it('没查成（failed）且 swReady：照旧重新载入（别的标签页已让新 SW 接管）', async () => {
    const d = deps({ swUpdate: () => Promise.resolve<SwUpdateResult>('failed') });
    const u = createUpgradeCenter(d);
    u.setSwReady();
    expect(await u.requestUpdate()).toBe('updating');
    expect(d.reload).toHaveBeenCalledTimes(1);
  });
});

describe('busy 兜底上限（PROBE-sugg2 ③、BANNER-sugg ⑥）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('单个令牌超过 30 分钟没释放：作废、busy 归零（required 横幅能出），记 upgrade_busy_expired + reason；之后再释放无害', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = deps();
    const u = createUpgradeCenter(d);
    const release = u.holdBusy('sign_out');
    u.reportUpgradeRequired('4.1.0');
    vi.advanceTimersByTime(BUSY_MAX_MS - 1);
    expect(u.getState().busy).toBe(true);
    vi.advanceTimersByTime(1);
    expect(u.getState().busy).toBe(false);
    expect(d.log).toHaveBeenCalledWith('upgrade_busy_expired', 'sign_out');
    release();
    expect(d.reload).not.toHaveBeenCalled();
    expect(u.getState().busy).toBe(false);
  });

  it('按时释放的令牌不会被作废、不记日志；只作废超时的那一个，别的令牌还在时 busy 不归零', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = deps();
    const u = createUpgradeCenter(d);
    u.holdBusy('recording');
    vi.advanceTimersByTime(BUSY_MAX_MS / 2);
    const fresh = u.holdBusy('editing');
    vi.advanceTimersByTime(BUSY_MAX_MS / 2);
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(u.getState().busy).toBe(true);
    fresh();
    expect(u.getState().busy).toBe(false);
    vi.advanceTimersByTime(BUSY_MAX_MS);
    expect(d.log).toHaveBeenCalledTimes(1);
  });

  it('按过更新、等 busy 归零才载入（reloadPending）：作废时不自动载入，“更新”回到 idle；再按一次直接载入、不再去查', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = deps();
    const u = createUpgradeCenter(d);
    u.holdBusy('recording');
    u.reportUpgradeRequired('4.1.0');
    await u.requestUpdate();
    expect(d.reload).not.toHaveBeenCalled();
    expect(u.getState().update).toBe('updating');
    vi.advanceTimersByTime(BUSY_MAX_MS);
    expect(d.reload).not.toHaveBeenCalled();
    expect(u.getState().update).toBe('idle');
    expect(await u.requestUpdate()).toBe('updating');
    expect(d.swUpdate).toHaveBeenCalledTimes(1);
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it('本机库已为升级关闭（closed_for_upgrade）时作废：不自动载入（横幅有“重新打开”）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = deps();
    const u = createUpgradeCenter(d);
    u.holdBusy('editing');
    u.onCacheVersionChange();
    vi.advanceTimersByTime(BUSY_MAX_MS);
    expect(u.getState().busy).toBe(false);
    expect(u.getState().cache).toBe('closed_for_upgrade');
    expect(d.reload).not.toHaveBeenCalled();
  });
});

describe('日志限次（B 组审查建议 1）', () => {
  function store() {
    const box = { v: null as string | null };
    return { box, logCounts: { get: () => box.v, set: (v: string) => void (box.v = v) } };
  }

  it('断网连点“更新”20 次：update_failed 当天只记 5 条；第二天又能记', async () => {
    const clock = { t: new Date(2026, 9, 30, 12).getTime() };
    const { logCounts } = store();
    const d = deps({ swUpdate: () => Promise.resolve<SwUpdateResult>('failed'), logCounts, now: () => clock.t });
    const u = createUpgradeCenter(d);
    for (let i = 0; i < 20; i++) await u.requestUpdate();
    expect(d.log).toHaveBeenCalledTimes(UPGRADE_LOG_DAILY_MAX);
    clock.t += 24 * 60 * 60 * 1000;
    await u.requestUpdate();
    expect(d.log).toHaveBeenCalledTimes(UPGRADE_LOG_DAILY_MAX + 1);
  });

  it('按 act 分开计：update_unsupported、update_still_old 各自 5 条，互不占额度', async () => {
    let r: SwUpdateResult = 'unsupported';
    const d = deps({ swUpdate: () => Promise.resolve(r), logCounts: store().logCounts });
    const u = createUpgradeCenter(d);
    for (let i = 0; i < 8; i++) await u.requestUpdate();
    r = 'no_update';
    u.reportUpgradeRequired('4.1.0');
    for (let i = 0; i < 8; i++) await u.requestUpdate();
    const acts = vi.mocked(d.log ?? vi.fn()).mock.calls.map((c) => c[0]);
    expect(acts.filter((a) => a === 'update_unsupported')).toHaveLength(5);
    expect(acts.filter((a) => a === 'update_still_old')).toHaveLength(5);
  });

  it('计数跨重新载入：同一个存储里已记满 5 条，新页面当天不再记', async () => {
    const s = store();
    const now = (): number => new Date(2026, 9, 30, 12).getTime();
    const d1 = deps({ swUpdate: () => Promise.resolve<SwUpdateResult>('failed'), logCounts: s.logCounts, now });
    const u1 = createUpgradeCenter(d1);
    for (let i = 0; i < 5; i++) await u1.requestUpdate();
    const d2 = deps({ swUpdate: () => Promise.resolve<SwUpdateResult>('failed'), logCounts: s.logCounts, now });
    await createUpgradeCenter(d2).requestUpdate();
    expect(d2.log).not.toHaveBeenCalled();
  });

  it('存储读写都抛：退回内存计数，照样限 5 条，不挡“更新”', async () => {
    const logCounts = {
      get: (): string | null => {
        throw new Error('x');
      },
      set: (): void => {
        throw new Error('quota');
      },
    };
    const d = deps({ swUpdate: () => Promise.resolve<SwUpdateResult>('failed'), logCounts });
    const u = createUpgradeCenter(d);
    for (let i = 0; i < 9; i++) expect(await u.requestUpdate()).toBe('failed');
    expect(d.log).toHaveBeenCalledTimes(5);
  });
});

describe('holdBusy 的 reason 只准是固定的词（B 组审查建议 2）', () => {
  it('类型上只收 sign_out | recording | editing', () => {
    const u = createUpgradeCenter(deps());
    const ok: BusyReason[] = ['sign_out', 'recording', 'editing'];
    for (const r of ok) u.holdBusy(r)();
    // @ts-expect-error 带内容的文字不能当 reason（会写进日志的 code 列）
    u.holdBusy('用户的笔记标题');
    expect(u.getState().busy).toBe(true);
  });
});
