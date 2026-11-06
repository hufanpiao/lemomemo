// 设置 › 提醒 排版和入口（从 RemindSettings.test.tsx 拆出）：设计复审 M2、M3、L5，排版 M5、M6、L6，R-347 点进去的入口行，第二轮 N8 通知单独一张卡
// 替身和 RemindSettings.test.tsx 相同：写经 core/write，推送和权限经 data 层
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
const { default: RemindSettingsValue } = await import('../ui/RemindSettingsValue.tsx');
// 免打扰是设置 › 提醒 下面点进去的页（R-347，线框 sR7）
const { default: RemindDnd } = await import('../ui/RemindDnd.tsx');

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  data.settings = [];
  perm = 'granted';
  setPushOutcome(null);
  localStorage.removeItem(INSTALL_ID_KEY);
  for (const f of [insert, patch, removeHolder, enableNotifications, claimNow, sendTestPush, showLocalTest]) f.mockClear();
});
afterEach(cleanup);

describe('提醒接线设计复审（11-04）M2、M3、L5', () => {
  it('M2：通知没开时首页写“通知没开，提醒不会响”，二级页写“没开”（同一个说法）', () => {
    perm = 'denied';
    render(<RemindSettingsValue />);
    expect(document.body.textContent).toBe('通知没开，提醒不会响');
    cleanup();
    render(<RemindSettings />);
    expect(screen.getByTestId('remind-perm').textContent).toBe('没开');
  });
  it('M3：“测试提醒能不能收到 … 发一条试试 ›”整行是一个按钮，点左边的字也发', async () => {
    render(<RemindSettings />);
    const btn = screen.getByTestId('remind-test');
    expect(btn.textContent).toBe('测试提醒能不能收到发一条试试›');
    expect(btn.closest('li')?.querySelectorAll('button')).toHaveLength(1);
    await act(async () => {
      fireEvent.click(within(btn).getByText('测试提醒能不能收到'));
    });
    expect(sendTestPush).toHaveBeenCalledTimes(1);
  });
  it('L5：免打扰整行是开关的 label：点“免打扰”几个字也能切换', async () => {
    render(<RemindDnd />);
    const sw = screen.getByRole('switch');
    expect(sw.closest('label')?.closest('li')).toBe(sw.closest('li'));
    expect(sw.closest('label')?.textContent).toBe('免打扰');
    await act(async () => {
      fireEvent.click(within(sw.closest('li') as HTMLElement).getByText('免打扰'));
    });
    expect(insert).toHaveBeenCalledWith('settings', expect.objectContaining({ key: 'remind.dnd' }));
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
    render(<RemindDnd />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('data-testid')).toBe('remind-dnd-on');
    expect(screen.getAllByText('免打扰').length).toBe(2);   // 读屏用的组标题 + 行里的标签；组标题 srOnly
  });
  it('开始和结束选成同一时刻：提示，不写', () => {
    data.settings = [{ id: 's1', key: 'remind.dnd', value: { start: '22:00', end: '07:00' }, deleted_at: null, undone: false }];
    render(<RemindDnd />);
    fireEvent.change(screen.getByTestId('remind-dnd-start'), { target: { value: '07:00' } });
    expect(screen.getByTestId('remind-dnd-same').textContent).toContain('不能是同一个时刻');
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('R-347：“提醒里写什么”、免打扰是点进去的页（线框 sR7）', () => {
  it('二级页只留入口行：右边写当前值，点了调 onOpenShowTitle / onOpenDnd；这一页不再有单选和开关', () => {
    const onShow = vi.fn();
    const onDnd = vi.fn();
    render(<RemindSettings onOpenShowTitle={onShow} onOpenDnd={onDnd} />);
    expect(screen.queryByTestId('remind-show-title-on')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByTestId('remind-show-title-value').textContent).toBe('直接写标题和名字');
    expect(screen.getByTestId('remind-dnd-value').textContent).toBe('没开');
    fireEvent.click(screen.getByTestId('remind-open-show-title'));
    fireEvent.click(screen.getByTestId('remind-open-dnd'));
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onDnd).toHaveBeenCalledTimes(1);
  });
  it('值跟着设置变：锁屏只显示、免打扰开着写时段', () => {
    data.settings = [
      { id: 's1', key: 'remind.dnd', value: { start: '22:00', end: '07:00' }, deleted_at: null, undone: false },
      { id: 's2', key: 'remind.show_title', value: false, deleted_at: null, undone: false },
    ];
    render(<RemindSettings />);
    expect(screen.getByTestId('remind-dnd-value').textContent).toBe('22:00 – 07:00');
    expect(screen.getByTestId('remind-show-title-value').textContent).not.toBe('直接写标题和名字');
  });
  it('免打扰关着（enabled:false 保留时段）：写“没开”', () => {
    data.settings = [{ id: 's1', key: 'remind.dnd', value: { start: '22:00', end: '07:00', enabled: false }, deleted_at: null, undone: false }];
    render(<RemindSettings />);
    expect(screen.getByTestId('remind-dnd-value').textContent).toBe('没开');
  });
});

describe('设计复审第二轮 N8：通知被关掉的说明紧跟在“通知”那一行下面', () => {
  it('“通知”单独一张卡，说明紧跟在后面，下面三行在另一张卡里', () => {
    perm = 'denied';
    render(<RemindSettings />);
    const note = screen.getByTestId('remind-denied-note');
    const notifyCard = screen.getByTestId('remind-perm').closest('ul') as HTMLElement;
    expect(notifyCard.querySelectorAll('li')).toHaveLength(1);
    expect(notifyCard.nextElementSibling).toBe(note);
    const rest = screen.getByTestId('remind-open-show-title').closest('ul') as HTMLElement;
    expect(rest).not.toBe(notifyCard);
    expect(note.nextElementSibling).toBe(rest);
    expect(rest.contains(screen.getByTestId('remind-test'))).toBe(true);
  });
  it('通知开着：不出说明，两张卡挨着', () => {
    render(<RemindSettings />);
    expect(screen.queryByTestId('remind-denied-note')).toBeNull();
    const notifyCard = screen.getByTestId('remind-perm').closest('ul') as HTMLElement;
    expect(notifyCard.nextElementSibling).toBe(screen.getByTestId('remind-open-show-title').closest('ul'));
  });
});
