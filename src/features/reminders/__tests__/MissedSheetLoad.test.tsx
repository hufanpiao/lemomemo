// 错过的提醒：弹层分包的下载（今天页代码复审第三轮 M2、L1）
// • 预取：有错过的提醒时首屏画完、空闲时真的去下载弹层分包；没有的不下载
// • 第一次下载失败（点开时、或预取时）以后，再点“查看”要能重新下载并打开（React.lazy 会记住失败，M2）
// 弹层本身换成一个替身，只看分包被下载了几次、弹层有没有出来；工厂函数每次被调用就是一次下载
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { resetRemindQueue } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

type Row = { id: string } & Record<string, unknown>;
const data: Record<string, Row[]> = { events: [], todos: [], settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => data[name] ?? [] }));
vi.mock('../../../core/current-tz.ts', () => ({ currentTz: () => 'Asia/Seoul' }));
let nowMs = 0;
vi.mock('../../../platform/clock.ts', () => ({
  clock: { now: () => nowMs, subscribe: () => () => undefined, offset: () => 0, isClockWrong: () => false },
}));

// 分包下载：loads 记次数，failNext 让下一次下载失败
const sheetDl = vi.hoisted(() => ({ loads: 0, failNext: 0 }));
// 每条用例重新登记一次（vi.doMock），上一条的下载结果不串
function mockSheet(): void {
  vi.doMock('../ui/MissedSheet.tsx', () => {
    sheetDl.loads += 1;
    if (sheetDl.failNext > 0) {
      sheetDl.failNext -= 1;
      throw new Error('Failed to fetch dynamically imported module');
    }
    return {
      default: ({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) =>
        open ? (
          <div role="dialog">
            弹层
            <button type="button" onClick={() => onOpenChange(false)}>
              关闭
            </button>
          </div>
        ) : null,
    };
  });
}

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(DAY, (h ?? 0) * 60 + (m ?? 0), SEOUL);
};
const ev = (n: number, title: string, time: string): Row => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, title, date: DAY, time, tz: SEOUL, remind_min: 15, duration_min: 60,
  deleted_at: null, undone: false, notified_for: null, snooze_at: null, defer_until: null,
});
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

beforeEach(() => {
  vi.resetModules();
  mockSheet();
  sheetDl.loads = 0;
  sheetDl.failNext = 0;
  uiStore.getState().setLocale('zh-CN');
  data.events = [ev(1, '和 Kim 开会', '15:30'), ev(2, '牙医', '15:45')];
  nowMs = at('16:10');
  resetRemindQueue();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// 每条用例重新载入组件，模块里的下载记录（成功、失败）不串
// 引擎 armed 以后才画（REMIND-shown-persist 修订 1 P2）：同一份重新载入的 kit 状态里先记成 armed，since 取很大、不筛
const load = async () => {
  (await import('../../../kit/state/remind-queue.ts')).setRemindArmed(Number.MAX_SAFE_INTEGER);
  return (await import('../ui/MissedReminders.tsx')).default;
};

describe('错过的提醒：弹层分包', () => {
  it('有错过的提醒：空闲回调里真的下载了弹层分包（L1）；没有错过的不下载', async () => {
    const idle = vi.fn((cb: () => void) => cb());
    vi.stubGlobal('requestIdleCallback', idle);
    const MissedReminders = await load();
    const view = render(<MissedReminders />);
    await vi.waitFor(() => expect(sheetDl.loads).toBe(1), { timeout: 5000 });
    expect(idle).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    view.unmount();

    vi.resetModules();
    mockSheet();
    sheetDl.loads = 0;
    idle.mockClear();
    data.events = [];
    const Again = await load();
    render(<Again />);
    await flush();
    expect(idle).not.toHaveBeenCalled();
    expect(sheetDl.loads).toBe(0);
  });

  it('点开时第一次下载失败：这一下没有弹层、那一行还在；再点能重新下载并打开（M2）', async () => {
    vi.stubGlobal('requestIdleCallback', vi.fn()); // 不预取，只看点开
    sheetDl.failNext = 1;
    const MissedReminders = await load();
    render(<MissedReminders />);
    fireEvent.click(screen.getByTestId('remind-missed-row'));
    await vi.waitFor(() => expect(sheetDl.loads).toBe(1), { timeout: 5000 });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('remind-missed-row'));
    expect(await screen.findByRole('dialog', {}, { timeout: 5000 })).toBeTruthy();
    expect(sheetDl.loads).toBe(2);
  });

  it('预取失败（离线）以后点开：重新下载并打开（M2）', async () => {
    vi.stubGlobal('requestIdleCallback', vi.fn((cb: () => void) => cb()));
    sheetDl.failNext = 1;
    const MissedReminders = await load();
    render(<MissedReminders />);
    await vi.waitFor(() => expect(sheetDl.loads).toBe(1), { timeout: 5000 });
    await flush();
    fireEvent.click(screen.getByTestId('remind-missed-row'));
    expect(await screen.findByRole('dialog', {}, { timeout: 5000 })).toBeTruthy();
    expect(sheetDl.loads).toBe(2);
  });

  it('下载成功过：关了再点开不再下载', async () => {
    vi.stubGlobal('requestIdleCallback', vi.fn());
    const MissedReminders = await load();
    render(<MissedReminders />);
    fireEvent.click(screen.getByTestId('remind-missed-row'));
    const first = await screen.findByRole('dialog', {}, { timeout: 5000 });
    // 真的关上（第四轮复查 L8）：替身里点“关闭”（就是 onOpenChange(false)），等弹层从文档里没了
    fireEvent.click(within(first).getByRole('button', { name: '关闭' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5000 });
    fireEvent.click(screen.getByTestId('remind-missed-row'));
    expect(await screen.findByRole('dialog', {}, { timeout: 5000 })).toBeTruthy();
    expect(sheetDl.loads).toBe(1);
  }, 15000);
});
