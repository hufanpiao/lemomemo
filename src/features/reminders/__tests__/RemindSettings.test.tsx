// 设置 › 提醒（B2 FA-4）：TC-B2-71 界面部分（推送被占着的两种提示、“移除它”后自动再认领）、锁屏只显示“有 1 项日程”、免打扰、
// 测试推送（push-test）、未来 7 天入口；写经 core/write（替身），推送和权限经 data 层（替身）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { INSTALL_ID_KEY } from '../../../platform/device-info.ts';
import { setPushOutcome } from '../../../platform/push-status.ts';
import type * as PushSetup from '../data/push-setup.ts';
import type * as PushTest from '../data/push-test.ts';
import type * as NativeBridgeMod from '../../../platform/native-bridge.ts';

type Row = { id: string } & Record<string, unknown>;
type Res = { ok: boolean; item?: null };
const data: { settings: Row[] } = { settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => (name === 'settings' ? data.settings : []) }));
const insert = vi.fn(async (..._a: unknown[]): Promise<Res> => ({ ok: true, item: null }));
const patch = vi.fn(async (..._a: unknown[]): Promise<Res> => ({ ok: true, item: null }));
vi.mock('../../../core/write.ts', () => ({ write: { insert: (...a: unknown[]) => insert(...a), patch: (...a: unknown[]) => patch(...a) } }));

let perm = 'granted';
const removeHolder = vi.fn(async (..._a: unknown[]) => 'ok');
const enableNotifications = vi.fn(async () => 'granted');
const claimNow = vi.fn(async () => ({ result: 'claimed' }));
vi.mock('../data/push-setup.ts', async (orig) => ({
  ...(await orig<typeof PushSetup>()),
  permState: () => perm,
  removeHolder: (...a: unknown[]) => removeHolder(...a),
  enableNotifications: () => enableNotifications(),
  claimNow: () => claimNow(),
}));
const sendTestPush = vi.fn(async () => 'sent');
const showLocalTest = vi.fn(async (..._a: unknown[]) => 'shown');
vi.mock('../../../platform/native-bridge.ts', async (orig) => ({
  ...(await orig<typeof NativeBridgeMod>()),
  showLocalTestNotification: (...a: unknown[]) => showLocalTest(...a),
}));
vi.mock('../data/push-test.ts', async (orig) => ({ ...(await orig<typeof PushTest>()), sendTestPush: () => sendTestPush() }));

const { default: RemindSettings } = await import('../ui/RemindSettings.tsx');
const { default: RemindSettingsEntry } = await import('../ui/RemindSettingsEntry.tsx');

const holder = { id: 'd-old', label: 'Y 的 Edge', last_seen_at: '2026-10-30T01:00:00Z', install_id: 'inst-1' };

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  data.settings = [];
  perm = 'granted';
  setPushOutcome(null);
  localStorage.removeItem(INSTALL_ID_KEY);
  for (const f of [insert, patch, removeHolder, enableNotifications, claimNow, sendTestPush, showLocalTest]) f.mockClear();
});
afterEach(cleanup);

describe('TC-B2-71：推送被同账号另一条设备记录占着', () => {
  it('install_id 和本机一样：提示“这是这台设备以前的登录记录”；不自动移除', () => {
    localStorage.setItem(INSTALL_ID_KEY, 'inst-1');
    setPushOutcome({ result: 'endpoint_in_use', holder });
    render(<RemindSettings />);
    expect(screen.getByTestId('remind-notice-in_use').textContent).toContain('这是这台设备以前的登录记录');
    expect(removeHolder).not.toHaveBeenCalled();
  });
  it('不一样：写出 label 和最近使用日期；点“移除它”先确认（写清哪台、移除后收不到提醒），确认后调 remove_device 并自动再认领（data 层）', async () => {
    localStorage.setItem(INSTALL_ID_KEY, 'inst-2');
    setPushOutcome({ result: 'endpoint_in_use', holder });
    render(<RemindSettings />);
    const n = screen.getByTestId('remind-notice-in_use').textContent ?? '';
    expect(n).toContain('“Y 的 Edge”');
    expect(n).toContain('多半是之前没联网时退出留下的');
    expect(n).toMatch(/10/);
    fireEvent.click(screen.getByTestId('remind-remove-holder'));
    expect(removeHolder).not.toHaveBeenCalled();
    const dlg = screen.getByRole('dialog');
    expect(dlg.textContent).toContain('“Y 的 Edge”');
    expect(dlg.textContent).toContain('收不到提醒');
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-remove-confirm'));
    });
    expect(removeHolder).toHaveBeenCalledWith('d-old');
    expect(screen.getByTestId('remind-remove-result').textContent).toContain('已移除');
  });
  it('确认框点“取消”：不移除', () => {
    setPushOutcome({ result: 'endpoint_in_use', holder });
    render(<RemindSettings />);
    fireEvent.click(screen.getByTestId('remind-remove-holder'));
    fireEvent.click(screen.getByTestId('remind-remove-cancel'));
    expect(removeHolder).not.toHaveBeenCalled();
  });
  it('移除了但再认领没成功：提示并换成“重新接上”，只再认领、不再调 remove_device（代码审查中 3）', async () => {
    removeHolder.mockResolvedValueOnce('reclaim_failed');
    claimNow.mockResolvedValueOnce({ result: 'claim_failed' }).mockResolvedValueOnce({ result: 'claimed' });
    setPushOutcome({ result: 'endpoint_in_use', holder });
    render(<RemindSettings />);
    fireEvent.click(screen.getByTestId('remind-remove-holder'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-remove-confirm'));
    });
    const msg = screen.getByTestId('remind-remove-result').textContent ?? '';
    expect(msg).toContain('推送还没接上');
    expect(msg).not.toContain('稍后再打开这一页');
    expect(screen.queryByTestId('remind-remove-holder')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-reconnect'));
    });
    expect(claimNow).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('remind-remove-result').textContent).toContain('推送还没接上');
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-reconnect'));
    });
    expect(claimNow).toHaveBeenCalledTimes(2);
    expect(removeHolder).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('remind-remove-result').textContent).toContain('已移除');
  });
  it('韩文提示（按词典，不混中文）', () => {
    uiStore.getState().setLocale('ko-KR');
    setPushOutcome({ result: 'endpoint_in_use', holder });
    render(<RemindSettings />);
    const n = screen.getByTestId('remind-notice-in_use').textContent ?? '';
    expect(n).toContain('Y 的 Edge');
    expect(/[一-鿿]/.test(n.replace('Y 的 Edge', ''))).toBe(false);
  });
});

describe('设置 › 提醒', () => {
  it('锁屏只显示“有 1 项日程”：默认选“直接写标题”，改了写 remind.show_title = false', async () => {
    render(<RemindSettings />);
    expect((screen.getByTestId('remind-show-title-on') as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-show-title-off'));
    });
    expect(insert).toHaveBeenCalledWith('settings', expect.objectContaining({ key: 'remind.show_title', value: false }));
  });
  it('免打扰：打开写 {start, end}（默认 23:00–08:00），关掉写 enabled:false 保留时段', async () => {
    const { rerender } = render(<RemindSettings />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-dnd-on'));
    });
    expect(insert).toHaveBeenCalledWith('settings', expect.objectContaining({ key: 'remind.dnd', value: { start: '23:00', end: '08:00' } }));
    data.settings = [{ id: 's1', key: 'remind.dnd', value: { start: '22:00', end: '07:00' }, deleted_at: null, undone: false }];
    rerender(<RemindSettings key="2" />);
    expect((screen.getByTestId('remind-dnd-start') as HTMLInputElement).value).toBe('22:00');
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-dnd-on'));
    });
    expect(patch).toHaveBeenCalledWith('settings', 's1', { value: { start: '22:00', end: '07:00', enabled: false } });
  });
  it('“发一条测试通知”：调 push-test，显示结果', async () => {
    render(<RemindSettings />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-test'));
    });
    expect(sendTestPush).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('remind-test-result').getAttribute('data-result')).toBe('sent');
  });
  it('通知没开：点“打开通知”在点按里请求权限', async () => {
    perm = 'default';
    render(<RemindSettings />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-enable'));
    });
    expect(enableNotifications).toHaveBeenCalledTimes(1);
  });
  it('“未来 7 天的提醒 ›”入口', () => {
    const onOpen = vi.fn();
    render(<RemindSettings onOpenUpcoming={onOpen} />);
    fireEvent.click(screen.getByTestId('remind-open-upcoming'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it('设置首页的入口行', () => {
    const onOpen = vi.fn();
    render(<RemindSettingsEntry onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('exe 里“发一条测试通知”弹本机测试通知（R-330）', () => {
  const click = async (): Promise<HTMLElement> => {
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-test'));
    });
    return screen.getByTestId('remind-test-result');
  };
  it('exe 显示这一行；点了走本机通知（按界面语言的文案），不调 push-test；已弹出', async () => {
    perm = 'tauri';
    render(<RemindSettings />);
    const r = await click();
    expect(showLocalTest).toHaveBeenCalledWith({ title: '柠檬记测试通知', body: '看到这条，说明这台电脑能弹出提醒。' });
    expect(sendTestPush).not.toHaveBeenCalled();
    expect(r.getAttribute('data-result')).toBe('local_shown');
    expect(r.textContent).toContain('已弹出');
  });
  it('系统通知权限没开、失败：各自提示', async () => {
    perm = 'tauri';
    showLocalTest.mockResolvedValueOnce('denied').mockResolvedValueOnce('failed');
    render(<RemindSettings />);
    expect((await click()).textContent).toContain('Windows 的通知没开');
    expect((await click()).textContent).toContain('没弹出来');
  });
  it('韩文文案', async () => {
    perm = 'tauri';
    uiStore.getState().setLocale('ko-KR');
    render(<RemindSettings />);
    const r = await click();
    expect(showLocalTest).toHaveBeenCalledWith({ title: '레모 테스트 알림', body: expect.any(String) });
    expect(/[一-鿿]/.test(r.textContent ?? '')).toBe(false);
  });
  it('网页版照旧调 push-test，不弹本机通知', async () => {
    render(<RemindSettings />);
    await click();
    expect(sendTestPush).toHaveBeenCalledTimes(1);
    expect(showLocalTest).not.toHaveBeenCalled();
  });
});

describe('设置页排版（设计 M5、M6、L6）', () => {
  it('“未来 7 天的提醒  N 条 ›”在最上面，下面一句说明', () => {
    render(<RemindSettings />);
    const root = screen.getByTestId('settings-reminders');
    const entry = screen.getByTestId('remind-open-upcoming');
    expect(root.querySelector('button')).toBe(entry);
    expect(screen.getByTestId('remind-upcoming-count').textContent).toBe('0 条');
    expect(root.textContent).toContain('看看接下来一周会响哪些提醒，点一条可以改。');
  });
  it('免打扰是拨动开关（role=switch），组标题不重复显示', () => {
    render(<RemindSettings />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('data-testid')).toBe('remind-dnd-on');
    expect(screen.getAllByText('免打扰').length).toBe(2);   // 读屏用的组标题 + 行里的标签；组标题 srOnly
  });
  it('开始和结束选成同一时刻：提示，不写', () => {
    data.settings = [{ id: 's1', key: 'remind.dnd', value: { start: '22:00', end: '07:00' }, deleted_at: null, undone: false }];
    render(<RemindSettings />);
    fireEvent.change(screen.getByTestId('remind-dnd-start'), { target: { value: '07:00' } });
    expect(screen.getByTestId('remind-dnd-same').textContent).toContain('不能是同一个时刻');
    expect(patch).not.toHaveBeenCalled();
  });
});
