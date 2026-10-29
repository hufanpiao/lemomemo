// 顶部版本横幅（UpdateBanner）：TC-B1-42 / 43 的界面部分（收到 426：同步停住、横幅出现、本机没上传的不丢），
// 8.1 的“有新版本 · 重新打开”（SW 后台装好新版本），TC-B1-48 的“柠檬记有新版本 · 重新打开”；录音、编辑进行中先不出
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllCollections } from '../../core/store.ts';
import { clock, setup, todo, uid } from '../../core/__tests__/outbox-fixtures.ts';
import { sendAll } from '../../core/sync/send.ts';
import { fakeTransport } from '../../core/sync/__tests__/fake-server.ts';
import { createUpgradeCenter, type UpgradeCenter } from '../../core/upgrade.ts';
import type { SwUpdateResult } from '../../platform/sw-register.ts';
import { bannerKind, UpdateBanner } from '../UpdateBanner.tsx';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});
afterEach(cleanup);

function center(result: SwUpdateResult = 'failed') {
  let resolve: (r: SwUpdateResult) => void = () => undefined;
  const swUpdate = vi.fn(() => new Promise<SwUpdateResult>((r) => (resolve = r)));
  const reload = vi.fn();
  const u = createUpgradeCenter({ appVersion: '4.0.0', reload, swUpdate, attempt: { get: () => null, set: () => undefined } });
  return { u, swUpdate, reload, finish: () => act(async () => resolve(result)) };
}

function sendDeps(u: UpgradeCenter, outbox: Awaited<ReturnType<typeof setup>>['outbox'], t: ReturnType<typeof fakeTransport>) {
  return {
    outbox, transport: t, gated: () => outbox.isSuspended(), blocked: () => u.getState().syncBlocked !== null,
    emit: () => undefined, removed: () => undefined, touched: () => undefined,
  };
}

describe('收到 426（TC-B1-42、43）', () => {
  it('同步停住、不再发；顶部出“需要更新”横幅和“有 3 条等更新后同步”；本机 3 条一条不丢', async () => {
    const { outbox } = await setup();
    const { u } = center();
    // 同 boot.ts：outbox 的 upgrade_required 事件交给升级中心
    outbox.onEvent((e) => {
      if (e.type === 'upgrade_required') u.reportUpgradeRequired(e.min);
    });
    const t = fakeTransport();
    for (let n = 1; n <= 3; n++) await outbox.enqueue({ table: 'todos', id: uid(n), op: 'insert', data: todo(n) });
    render(<UpdateBanner upgrade={u} outbox={outbox} onReload={vi.fn()} />);
    expect(screen.queryByTestId('update-banner')).toBeNull();

    t.failNext.push({ status: 426, code: 'upgrade_required', min: '4.1.0' });
    await act(async () => {
      expect(await sendAll(sendDeps(u, outbox, t))).toBe('paused');
    });
    expect(u.getState().syncBlocked).toEqual({ min: '4.1.0', source: '426' });

    const banner = screen.getByTestId('update-banner');
    expect(banner.dataset['kind']).toBe('required');
    expect(banner.textContent).toContain('需要更新才能继续同步 · 你记下的内容都还在本机');
    expect(banner.textContent).toContain('有 3 条等更新后同步 · 内容还在本机');
    expect(screen.getByRole('button', { name: '更新' })).toBeTruthy();
    // 关不掉：只有“更新”一个按钮
    expect(screen.getAllByRole('button')).toHaveLength(1);

    // 同步停住：再触发发送，一个请求也不发
    const calls = t.calls.length;
    expect(await sendAll(sendDeps(u, outbox, t))).toBe('paused');
    expect(await sendAll(sendDeps(u, outbox, t))).toBe('paused');
    expect(t.calls.length).toBe(calls);
    // 不丢：3 条都还在、没回滚、没进“发送失败”
    const items = await outbox.list();
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.tries === 0 && i.state === 'pending')).toBe(true);
    expect(outbox.getStatus()).toMatchObject({ pending: 3, failed: 0 });
    // 挡同步不挡记录：还能接着记，横幅里的条数跟着变
    await act(async () => {
      await outbox.enqueue({ table: 'todos', id: uid(4), op: 'insert', data: todo(4) });
    });
    expect(screen.getByTestId('update-banner').textContent).toContain('有 4 条等更新后同步');
  });

  it('按“更新”：走 requestUpdate，进度和失败用 role=status 播报；更新中再按不重复调', async () => {
    const { u, swUpdate, finish } = center('failed');
    u.reportUpgradeRequired('4.1.0');
    render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
    const go = screen.getByRole('button', { name: '更新' });
    fireEvent.click(go);
    expect(screen.getByRole('status').textContent).toBe('正在更新…');
    fireEvent.click(go);
    expect(swUpdate).toHaveBeenCalledTimes(1);
    await finish();
    expect(screen.getByRole('status').textContent).toBe('更新失败 · 联网后再试');
  });

  it('录音、编辑在进行：横幅先不出，结束后再出', () => {
    const { u } = center();
    const release = u.holdBusy('edit');
    render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
    act(() => u.reportUpgradeRequired('4.1.0'));
    expect(screen.queryByTestId('update-banner')).toBeNull();
    act(() => release());
    expect(screen.getByTestId('update-banner').dataset['kind']).toBe('required');
  });
});

describe('SW 有新版本（8.1）', () => {
  it('后台装好新版本：出“有新版本 · 重新打开”，不自动刷新；按了才走 requestUpdate', async () => {
    const { u, swUpdate, reload, finish } = center('reloading');
    render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
    expect(screen.queryByTestId('update-banner')).toBeNull();
    act(() => u.setSwReady());
    const banner = screen.getByTestId('update-banner');
    expect(banner.dataset['kind']).toBe('new_version');
    expect(banner.textContent).toContain('有新版本');
    expect(swUpdate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }));
    expect(swUpdate).toHaveBeenCalledTimes(1);
    await finish();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('正在编辑时不出、不打断；编辑结束后再出', () => {
    const { u } = center();
    const release = u.holdBusy('edit');
    render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
    act(() => u.setSwReady());
    expect(screen.queryByTestId('update-banner')).toBeNull();
    act(() => release());
    expect(screen.getByTestId('update-banner').dataset['kind']).toBe('new_version');
  });
});

describe('关闭、根节点标记、多标签页（架构师 10-30 第 4、7 点，审查必改 2）', () => {
  it('“有新版本”能关：关掉只记在内存里（升级中心的 swReady 变回 false）；“需要更新”“本机库已关”没有关闭按钮', () => {
    const { u } = center();
    u.setSwReady();
    const { unmount } = render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByTestId('update-banner')).toBeNull();
    expect(u.getState()).toMatchObject({ swDismissed: true, swReady: true });   // 只关横幅，新版本照样已就绪（复审建议 2）
    unmount();

    const r = center();
    r.u.reportUpgradeRequired('4.1.0');
    render(<UpdateBanner upgrade={r.u} outbox={null} onReload={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
    cleanup();
    const c = center();
    c.u.holdBusy('edit');
    c.u.onCacheVersionChange();
    render(<UpdateBanner upgrade={c.u} outbox={null} onReload={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
  });

  it('横幅出现时 <html> 带 data-top-banner（页面的 var(--safe-top) 变 0），横幅没了就去掉', () => {
    const { u } = center();
    render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
    expect(document.documentElement.dataset['topBanner']).toBeUndefined();
    act(() => u.setSwReady());
    expect(document.documentElement.dataset['topBanner']).toBe('new_version');
    act(() => u.dismissSwReady());
    expect(document.documentElement.dataset['topBanner']).toBeUndefined();
  });

  it('别的标签页已按过、新 SW 已接管：这一页再按，update() 查不到新的（no_update）也直接重新载入，不挂着、不报“已是最新”', async () => {
    const { u, reload, finish } = center('no_update');
    u.setSwReady();
    render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }));
    await finish();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(u.getState().update).not.toBe('still_old');
  });

  it('“需要更新”横幅同理：swReady 时 no_update 也重新载入', async () => {
    const { u, reload, finish } = center('no_update');
    u.reportUpgradeRequired('4.1.0');
    u.setSwReady();
    render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    await finish();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).not.toBe('已是最新版本，请稍后再试');
  });
});

describe('先后（bannerKind）', () => {
  const base = { syncBlocked: null, cache: 'ok', blocked: false, update: 'idle', busy: false, swReady: false, swDismissed: false } as const;
  it('需要更新 > 本机库已关 > 有新版本；本机库来自更新的版本时归整屏提示，不出横幅', () => {
    expect(bannerKind({ ...base, syncBlocked: { min: '4.1.0', source: '426' }, cache: 'closed_for_upgrade', swReady: true })).toBe('required');
    expect(bannerKind({ ...base, cache: 'closed_for_upgrade', swReady: true })).toBe('closed');
    expect(bannerKind({ ...base, swReady: true })).toBe('new_version');
    expect(bannerKind({ ...base, swReady: true, swDismissed: true })).toBeNull();
    expect(bannerKind({ ...base, cache: 'too_new', swReady: true })).toBeNull();
    expect(bannerKind(base)).toBeNull();
  });

  it('本机库被新版本的标签页关了（TC-B1-48，编辑中）：编辑中也出“柠檬记有新版本 · 重新打开”，按钮直接重新载入', () => {
    const { u, swUpdate } = center();
    u.holdBusy('edit');
    u.onCacheVersionChange();
    const onReload = vi.fn();
    render(<UpdateBanner upgrade={u} outbox={null} onReload={onReload} />);
    expect(screen.getByTestId('update-banner').textContent).toContain('柠檬记有新版本');
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(swUpdate).not.toHaveBeenCalled();
  });
});

describe('复审：断网、录音中、关过横幅（复审必改、建议 1、建议 2）', () => {
  it('断网时按“重新打开”：swUpdate 回 failed，但新版本已就绪（swReady）→ 直接重新载入，不报“更新失败”', async () => {
    const { u, reload, finish } = center('failed');
    u.setSwReady();
    render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }));
    await finish();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(u.getState().update).not.toBe('failed');
  });

  it('没有就绪的新版本时断网：照旧报“更新失败”', async () => {
    const { u, reload, finish } = center('failed');
    u.reportUpgradeRequired('4.1.0');
    render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    await finish();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('更新失败 · 联网后再试');
  });

  it('按下以后、真正载入之前开始录音：等录音结束再重新载入，不打断', async () => {
    for (const result of ['reloading', 'no_update'] as const) {
      const { u, reload, finish } = center(result);
      u.setSwReady();
      const p = u.requestUpdate();
      const release = u.holdBusy('record');
      await finish();
      await p;
      expect(reload).not.toHaveBeenCalled();
      release();
      expect(reload).toHaveBeenCalledTimes(1);
    }
  });

  it('关掉“有新版本”横幅以后来了 426，按“更新”回 no_update：照样重新载入，不误报“已是最新版本”', async () => {
    const { u, reload, finish } = center('no_update');
    u.setSwReady();
    u.dismissSwReady();
    u.reportUpgradeRequired('4.1.0');
    render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    await finish();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(u.getState().update).not.toBe('still_old');
  });
});
