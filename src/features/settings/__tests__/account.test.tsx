// 设置 › 数据 › 导出全部、设置 › 账号 › 最近的导出的界面（R-256 ②；TC-B1-76 的客户端部分）
// 接口、离开本机、存文件都用假的（account-fakes.tsx）；注销页在 delete-account.test.tsx
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { AccountResult, ExportPart, ExportStarted } from '../data/account-api.ts';
import type { RecentExportResult } from '../data/recent-exports.ts';
import { zh } from '../i18n/zh.ts';
import { fmtWhen } from '../ui/DevicesSection.tsx';
import { EXPORT_ID, exportBtn, FILE, fakeAccount, gzLike, setOnline, setup } from './account-fakes.tsx';
import { deferred, text } from './fakes.tsx';

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  setOnline(true);
});
afterEach(() => {
  cleanup();
  setOnline(true);
});

describe('最近的导出（设置 › 账号）', () => {
  const T = Date.parse('2026-10-29T03:00:00Z');
  const H = 3_600_000;
  const rows = (): HTMLElement[] => screen.getAllByTestId('settings-recent-export-row');
  /** 设备列表（fakes.tsx 的 ROWS：y 本机 Windows 电脑、x “A 的 iPhone”）和导出记录都读完 */
  async function ready(): Promise<void> {
    await waitFor(() => expect(screen.getAllByTestId('settings-device').length).toBeGreaterThan(0));
    await screen.findByTestId('settings-recent-export');
  }

  it('多条：在账号组里按时间倒序列出，每行写日期时刻和设备名；本机加“本机”标签；邮件都发出去时不标、不提示', async () => {
    setup({
      recent: async () => ({
        kind: 'ready',
        list: [
          { at: T, device: 'y', mailFailed: false, incomplete: false },
          { at: T - H, device: 'x', mailFailed: false, incomplete: false },
        ],
      }),
    });
    await ready();
    const box = screen.getByTestId('settings-recent-export');
    expect(box.closest('section[data-section="account"]')).toBeTruthy();
    expect(text(box)).toContain(zh['settings.recentExport.title']);
    const [a, b] = rows();
    expect(text(a)).toContain(fmtWhen(T, 'zh-CN'));
    expect(text(a)).toContain(zh['settings.platform.windows']);
    expect(text(a)).toContain(zh['settings.devices.thisDevice']);
    expect(text(b)).toContain(fmtWhen(T - H, 'zh-CN'));
    expect(text(b)).toContain('A 的 iPhone');
    expect(text(b)).not.toContain(zh['settings.devices.thisDevice']);
    expect(screen.queryByTestId('settings-recent-export-mark')).toBeNull();
    expect(screen.queryByTestId('settings-recent-export-mail')).toBeNull();
  });

  it('设备对不上：设备列表里没有的写“已移除的设备”，没带设备号的写“未知设备”', async () => {
    setup({
      recent: async () => ({
        kind: 'ready',
        list: [
          { at: T, device: 'gone-device', mailFailed: false, incomplete: false },
          { at: T - H, device: null, mailFailed: false, incomplete: false },
        ],
      }),
    });
    await ready();
    expect(text(rows()[0])).toContain(zh['settings.recentExport.removedDevice']);
    expect(text(rows()[1])).toContain(zh['settings.recentExport.unknownDevice']);
  });

  it('邮件失败的：那一行标“通知邮件没发出去”，列表下方只放一句提示（不每行重复）', async () => {
    setup({
      recent: async () => ({
        kind: 'ready',
        list: [
          { at: T, device: 'y', mailFailed: true, incomplete: false },
          { at: T - H, device: 'y', mailFailed: false, incomplete: false },
          { at: T - 2 * H, device: 'x', mailFailed: true, incomplete: false },
        ],
      }),
    });
    await ready();
    const marks = screen.getAllByTestId('settings-recent-export-mark');
    expect(marks).toHaveLength(2);
    expect(rows()[0]?.contains(marks[0] as HTMLElement)).toBe(true);
    expect(rows()[1]?.querySelector('[data-testid="settings-recent-export-mark"]')).toBeNull();
    expect(screen.getAllByTestId('settings-recent-export-mail')).toHaveLength(1);
    expect(text(screen.getByTestId('settings-recent-export-mail'))).toBe(zh['settings.recentExport.mailFailed']);
  });

  it('超过默认条数：先显示最近 5 条，给“显示全部（共 N 条）”；点了列出全部、按钮消失', async () => {
    const list = Array.from({ length: 8 }, (_v, i) => ({ at: T - i * H, device: 'y', mailFailed: false, incomplete: false }));
    setup({ recent: async () => ({ kind: 'ready', list }) });
    await ready();
    expect(rows()).toHaveLength(5);
    expect(text(rows()[0])).toContain(fmtWhen(T, 'zh-CN'));
    const all = screen.getByTestId('settings-recent-export-all');
    expect(text(all)).toBe('显示全部（共 8 条）');
    await act(async () => {
      fireEvent.click(all);
    });
    expect(rows()).toHaveLength(8);
    expect(text(rows()[7])).toContain(fmtWhen(T - 7 * H, 'zh-CN'));
    expect(screen.queryByTestId('settings-recent-export-all')).toBeNull();
  });

  it('5 条以内不给“显示全部”', async () => {
    setup({ recent: async () => ({ kind: 'ready', list: [{ at: T, device: 'y', mailFailed: false, incomplete: false }] }) });
    await ready();
    expect(rows()).toHaveLength(1);
    expect(screen.queryByTestId('settings-recent-export-all')).toBeNull();
  });

  it('没有记录的：写“最近 90 天没有导出过”，没有列表', async () => {
    setup({ recent: async () => ({ kind: 'none' }) });
    expect(text(await screen.findByTestId('settings-recent-export'))).toContain(zh['settings.recentExport.none']);
    expect(screen.queryAllByTestId('settings-recent-export-row')).toHaveLength(0);
  });

  it('读失败的（hidden）、接口抛错：整块不显示，也不出提示', async () => {
    const cases: Array<() => Promise<RecentExportResult>> = [
      async () => ({ kind: 'hidden' }),
      async () => Promise.reject(new Error('x')),
    ];
    for (const recent of cases) {
      const { recentExports } = setup({ recent });
      await waitFor(() => expect(recentExports.list).toHaveBeenCalled());
      await act(async () => undefined);
      expect(screen.queryByTestId('settings-recent-export')).toBeNull();
      expect(screen.queryByTestId('settings-recent-export-mail')).toBeNull();
      cleanup();
    }
  });

  it('本页导出：服务器记下（start 成功）后重读一次，文件取完后再读一次（0.47：没取完的那条先标“未完成”）', async () => {
    const part = deferred<AccountResult<ExportPart>>();
    const account = fakeAccount({ takePart: vi.fn(() => part.promise) });
    const { recentExports } = setup({ account });
    await waitFor(() => expect(recentExports.list).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    await waitFor(() => expect(recentExports.list).toHaveBeenCalledTimes(2));
    await act(async () => part.resolve({ ok: true, value: { blob: gzLike(), next: null, disposition: null, contentLength: null, contentEncoding: null } }));
    await waitFor(() => expect(recentExports.list).toHaveBeenCalledTimes(3));
  });
});

describe('导出全部（设置 › 数据）', () => {
  it('断网时按钮不可点，右边写“联网后才能导出”；联网后恢复', async () => {
    setup();
    act(() => setOnline(false));
    expect(exportBtn().disabled).toBe(true);
    expect(text(exportBtn())).toContain(zh['settings.export.offline']);
    act(() => setOnline(true));
    expect(exportBtn().disabled).toBe(false);
    expect(text(exportBtn())).toContain(zh['settings.export.hint']);
  });

  it('导出中按钮忙；成功后存文件，提示“通知邮件已发到你的邮箱”和“隐私记没有导出（没解锁）”；device_id 取本机 meta', async () => {
    const gate = deferred<{ ok: true; value: ExportStarted }>();
    const account = fakeAccount({ startExport: vi.fn(() => gate.promise) });
    const { save, readDeviceId } = setup({ account });
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    expect(readDeviceId).toHaveBeenCalled();
    expect(account.startExport).toHaveBeenCalledWith('dev-1');
    expect(exportBtn().disabled).toBe(true);
    expect(exportBtn().getAttribute('aria-busy')).toBe('true');
    expect(text(screen.getByTestId('settings-export-status'))).toContain(zh['settings.export.busy']);
    // 忙的时候再点不会再导一次
    fireEvent.click(exportBtn());
    await act(async () => gate.resolve({ ok: true, value: { exportId: EXPORT_ID, exportedAt: '2026-10-29T03:00:00.000Z', sid: 's-me' } }));
    expect(account.takePart).toHaveBeenCalledWith(EXPORT_ID, null, 's-me');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: FILE.name, vaultOmitted: true }));
    const status = text(screen.getByTestId('settings-export-status'));
    expect(status).toContain(zh['settings.export.done']);
    expect(status).toContain(zh['settings.export.vaultOmitted']);
    expect(account.startExport).toHaveBeenCalledTimes(1);
    expect(exportBtn().disabled).toBe(false);
  });

  it('分享面板取消：写“还没存下来”，点“再存一次”只再存、不再调服务器', async () => {
    const save = vi.fn().mockResolvedValueOnce('cancelled').mockResolvedValue('shared');
    const { account } = setup({ save });
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    expect(text(screen.getByTestId('settings-export-status'))).toContain(zh['settings.export.notSaved']);
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-export-again'));
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(account.startExport).toHaveBeenCalledTimes(1);
    expect(text(screen.getByTestId('settings-export-status'))).toContain(zh['settings.export.done']);
  });

  it('主屏幕版分享被拒（needs_tap）：不显示“已导出，通知邮件已发到你的邮箱”，写“还没存下来”；点“再存一次”（新的点击）存好后才显示', async () => {
    const save = vi.fn().mockResolvedValueOnce('needs_tap').mockResolvedValue('shared');
    const { account } = setup({ save });
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    const status = text(screen.getByTestId('settings-export-status'));
    expect(status).toContain(zh['settings.export.notSaved']);
    expect(status).not.toContain(zh['settings.export.done']);
    expect(screen.getByTestId('settings-export-again')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-export-again'));
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(account.startExport).toHaveBeenCalledTimes(1);
    expect(text(screen.getByTestId('settings-export-status'))).toContain(zh['settings.export.done']);
  });

  it('“再存一次”存的过程中按钮禁用，连点只存一次', async () => {
    const gate = deferred<'shared'>();
    const save = vi.fn().mockResolvedValueOnce('cancelled').mockImplementation(() => gate.promise);
    setup({ save });
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    const again = screen.getByTestId('settings-export-again') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(again);
    });
    expect(again.disabled).toBe(true);
    expect(again.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(again);
    fireEvent.click(again);
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => gate.resolve('shared'));
    expect((screen.getByTestId('settings-export-again') as HTMLButtonElement).disabled).toBe(false);
    expect(text(screen.getByTestId('settings-export-status'))).toContain(zh['settings.export.done']);
  });

  it('rate_limited 提示今天合计 3 次用完；try_later 提示稍后再试；unknown（含 B5 的 vault_locked）给通用一句；都不清本机', async () => {
    for (const [error, want] of [
      ['rate_limited', zh['settings.account.rateLimited']],
      ['try_later', zh['settings.err.tryLater']],
      ['unknown', zh['settings.err.unknown']],
    ] as const) {
      const account = fakeAccount({ startExport: vi.fn(async () => ({ ok: false as const, error, sid: 's-me' })) });
      const { exit, leave } = setup({ account });
      await act(async () => {
        fireEvent.click(exportBtn());
      });
      expect(text(await screen.findByRole('alert'))).toBe(want);
      expect(exit.wipe).not.toHaveBeenCalled();
      expect(leave).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('session_revoked：走现有的“被移除”流程（清本机、提示、去登录）；停用、冷静期：清本机回登录页带原因', async () => {
    const revoked = fakeAccount({ startExport: vi.fn(async () => ({ ok: false as const, error: 'revoked' as const, sid: 's-me' })) });
    const a = setup({ account: revoked });
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    const dlg = await screen.findByRole('dialog');
    expect(text(dlg)).toContain(zh['settings.revoked.title']);
    await waitFor(() => expect(a.exit.wipe).toHaveBeenCalled());
    expect(a.exit.clearLocalSessionIf).toHaveBeenCalledWith('s-me');
    cleanup();

    for (const [error, notice] of [['pending_deletion', 'pending_deletion'], ['account_disabled', 'disabled']] as const) {
      const account = fakeAccount({ startExport: vi.fn(async () => ({ ok: false as const, error, sid: 's-me' })) });
      const { leave } = setup({ account });
      await act(async () => {
        fireEvent.click(exportBtn());
      });
      expect(leave).toHaveBeenCalledWith(notice, 's-me');
      expect(screen.queryByRole('alert')).toBeNull();
      cleanup();
    }
  });
});
