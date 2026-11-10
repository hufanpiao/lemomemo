// 提醒界面（B2 FA-4）：TC-B2-22（录音中、键盘弹起时横幅排队，放开后一条一条出）、按钮条、稍后提示、收起；
// 整页提醒（“已在其他设备上处理”、地址不合格）；未同步提示（TC-B2-69 中韩）；错过的提醒（TC-B2-26 界面）
// 本机集合、写入、时钟、键盘、桥接都用替身；时钟 now 由测试控制，subscribe 用来通知“分钟变了”
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { holdReminders, remindQueue, resetRemindQueue, setRemindArmed } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
// outbox 状态替身的空集合（UNSYNCED-retryRecs-required）：每次返回同一个对象，useSyncExternalStore 的快照才稳定
const EMPTY_RECS = vi.hoisted((): ReadonlySet<string> => new Set());

type Row = { id: string } & Record<string, unknown>;
const data: Record<string, Row[]> = { events: [], todos: [], settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => data[name] ?? [] }));
const savePatch = vi.fn(async (..._a: unknown[]) => 'saved' as const);
vi.mock('../../../core/edit-save.ts', () => ({ savePatch: (...a: unknown[]) => savePatch(...a) }));
vi.mock('../../../core/current-tz.ts', () => ({ currentTz: () => 'Asia/Seoul' }));

let nowMs = 0;
const subs = new Set<() => void>();
vi.mock('../../../platform/clock.ts', () => ({
  clock: {
    now: () => nowMs,
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    offset: () => 0,
    isClockWrong: () => false,
  },
}));
let kb: ((open: boolean) => void) | null = null;
vi.mock('../../../platform/viewport.ts', () => ({
  watchKeyboard: (fn: (open: boolean) => void) => {
    kb = fn;
    return () => {
      kb = null;
    };
  },
  isKeyboardOpen: () => false,
}));
const openReminder = vi.fn(async (..._a: unknown[]) => undefined);
const showLocalReminder = vi.fn(async (..._a: unknown[]) => undefined);
const closeLocalReminder = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../../../platform/native-bridge.ts', () => ({
  openReminder: (...a: unknown[]) => openReminder(...a),
  showLocalReminder: (...a: unknown[]) => showLocalReminder(...a),
  closeLocalReminder: (...a: unknown[]) => closeLocalReminder(...a),
  reminderHash: (kind: string, id: string, due: number) => `#/remind/${kind}/${id}?due=${due}`,
}));
const closeHandled = vi.fn(async (..._a: unknown[]) => 0);
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: (...a: unknown[]) => closeHandled(...a) }));
const navigate = vi.fn(async (..._a: unknown[]) => undefined);
// 整页提醒关闭退不了时原地换成今天（R-372），“回到今天”按层级回（backTo）
vi.mock('../../../app/router.ts', () => ({
  canGoBack: () => false,
  goBack: vi.fn(),
  navigate: (...a: unknown[]) => navigate(...a),
  replaceRoute: (...a: unknown[]) => navigate(...a),
  backTo: (...a: unknown[]) => void navigate(...a),
}));
let remindRecs: ReadonlySet<string> = new Set();
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({ outbox: { subscribe: () => () => undefined, getStatus: () => ({ retryRecs: EMPTY_RECS, remindRecs }) } }),
}));

// 动画实现首屏画完以后才由 main.tsx 下载（R-354）；这里没有 main.tsx，测退场和焦点前先等它到
await (await import('../../../motion/index.ts')).loadMotionFeatures();
const { default: RemindHost } = await import('../ui/RemindHost.tsx');
const { default: FullReminderPage } = await import('../ui/FullReminderPage.tsx');
const { default: UnsyncedRemindHint } = await import('../ui/UnsyncedRemind.tsx');
const { default: UnsyncedRemindMark } = await import('../ui/UnsyncedRemindMark.tsx');
const { default: MissedReminders } = await import('../ui/MissedReminders.tsx');

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (hm: string, date = DAY): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(date, (h ?? 0) * 60 + (m ?? 0), SEOUL);
};
const E1 = '00000000-0000-4000-8000-000000000001';
const E2 = '00000000-0000-4000-8000-000000000002';
const T1 = '00000000-0000-4000-8000-000000000101';
const ev = (id: string, title: string, time: string, over: Record<string, unknown> = {}): Row => ({
  id, title, date: DAY, time, tz: SEOUL, remind_min: 15, duration_min: 60, deleted_at: null, undone: false,
  notified_for: null, snooze_at: null, defer_until: null, ...over,
});
const tick = (hm: string): void => {
  nowMs = at(hm);
  act(() => {
    for (const f of [...subs]) f();
  });
};
const gone = (id: string) => waitFor(() => expect(screen.queryByTestId(id)).toBeNull());

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  data.events = [ev(E1, '和 Kim 开会', '15:30'), ev(E2, '牙医', '15:45')];
  data.todos = [];
  data.settings = [];
  nowMs = at('15:00');
  remindRecs = new Set();
  resetRemindQueue();
  remindQueue.setState({ holds: [] });
  for (const f of [savePatch, openReminder, showLocalReminder, closeLocalReminder, closeHandled, navigate]) f.mockClear();
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});

/** 引擎读完本机“响过”记录、算好第一份快照才 armed（REMIND-shown-persist）：两步都是异步的，冲几拍 */
const armedNow = () =>
  act(async () => {
    for (let k = 0; k < 6; k++) await Promise.resolve();
  });

describe('TC-B2-22：横幅排队', () => {
  it('到点出横幅和按钮条；打开 App 之前就到点的不出（进错过的提醒）', async () => {
    nowMs = at('15:20');   // 打开时 15:15 那条已经过了
    render(<RemindHost route="todos" />);
    expect(screen.queryByTestId('remind-banner')).toBeNull();
    tick('15:31');   // 15:30 那条（牙医）在打开以后到点
    expect((await screen.findByTestId('remind-banner')).textContent).toContain('牙医');
    expect(screen.getByTestId('remind-bar')).toBeTruthy();
  });

  it('键盘弹起时先排队，收起键盘后一条一条出；按“知道了”写 notified_for 并出下一条', async () => {
    render(<RemindHost route="todos" />);
    await armedNow();
    act(() => kb?.(true));
    tick('15:31');   // 两条都到点
    expect(remindQueue.getState().entries.length).toBe(2);
    expect(screen.queryByTestId('remind-banner')).toBeNull();
    expect(screen.queryByTestId('remind-bar')).toBeNull();
    act(() => kb?.(false));
    const banner = await screen.findByTestId('remind-banner');
    expect(banner.textContent).toContain('和 Kim 开会');
    expect(banner.textContent).toContain('还有 1 条');
    expect(screen.getByTestId('remind-act-ack').textContent).toContain('知道了');
    expect(screen.getByTestId('remind-act-snooze10').textContent).toContain('10 分钟后');
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-act-ack'));
    });
    expect(savePatch).toHaveBeenCalledWith('events', E1, { notified_for: at('15:15'), updated_at: at('15:31') }, true);
    await waitFor(() => expect(screen.getByTestId('remind-banner').textContent).toContain('牙医'));
    expect(screen.getByTestId('remind-banner').textContent).not.toContain('还有');
  });

  it('正在录音时（“＋”面板 holdReminders）先排队，放开后出', async () => {
    render(<RemindHost route="notes" />);
    let release: () => void = () => undefined;
    act(() => {
      release = holdReminders('recording');
    });
    tick('15:16');
    expect(screen.queryByTestId('remind-banner')).toBeNull();
    act(() => release());
    expect((await screen.findByTestId('remind-banner')).textContent).toContain('和 Kim 开会');
  });

  it('键盘和录音同时压着：两个都放开才出', async () => {
    render(<RemindHost route="todos" />);
    let release: () => void = () => undefined;
    act(() => {
      release = holdReminders('recording');
      kb?.(true);
    });
    tick('15:16');
    act(() => kb?.(false));
    expect(screen.queryByTestId('remind-banner')).toBeNull();
    act(() => release());
    expect(await screen.findByTestId('remind-banner')).toBeTruthy();
  });

  it('今天页不出顶部横幅、只出按钮条；整页提醒那一页两个都不出', async () => {
    const { rerender } = render(<RemindHost route="today" />);
    tick('15:16');
    expect(await screen.findByTestId('remind-bar')).toBeTruthy();
    expect(screen.queryByTestId('remind-banner')).toBeNull();
    rerender(<RemindHost route="remind" />);
    await gone('remind-bar');
    expect(screen.queryByTestId('remind-banner')).toBeNull();
  });

  it('按“10 分钟后”：写 snooze_at，弹“15:26 再提醒你”', async () => {
    render(<RemindHost route="todos" />);
    tick('15:16');
    await screen.findByTestId('remind-bar');
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-act-snooze10'));
    });
    expect(savePatch).toHaveBeenCalledWith('events', E1, { snooze_at: at('15:26'), updated_at: at('15:16') }, true);
    expect((await screen.findByTestId('remind-snooze-note')).textContent).toContain('15:26 再提醒你');
  });

  it('点“先收起”：横幅不在了，记进收起（进错过的提醒），不写服务器', async () => {
    render(<RemindHost route="todos" />);
    tick('15:16');
    fireEvent.click(await screen.findByTestId('remind-banner-collapse'));
    await gone('remind-banner');
    expect(remindQueue.getState().collapsed.size).toBe(1);
    expect(savePatch).not.toHaveBeenCalled();
  });

  it('点横幅主体打开整页提醒（带原到点时刻）', async () => {
    render(<RemindHost route="todos" />);
    tick('15:16');
    fireEvent.click(await screen.findByTestId('remind-banner-open'));
    expect(openReminder).toHaveBeenCalledWith('event', E1, at('15:15'));
  });

  it('待办横幅有完成圆圈：点了写 done', async () => {
    data.events = [];
    data.todos = [{ id: T1, title: '交报告', due: DAY, due_time: '17:00', remind_before_min: 60, remind_at: at('16:00'), remind_days: null, remind_time: null, done: false, deleted_at: null, undone: false, notified_for: null, snooze_at: null, defer_until: null }];
    render(<RemindHost route="calendar" />);
    tick('16:00');
    await act(async () => {
      fireEvent.click(await screen.findByTestId('remind-banner-done'));
    });
    expect(savePatch).toHaveBeenCalledWith('todos', T1, { done: true, done_at: at('16:00'), updated_at: at('16:00') }, true);
    expect(screen.getByTestId('remind-act-hour1')).toBeTruthy();
  });

  it('韩文界面按钮', async () => {
    uiStore.getState().setLocale('ko-KR');
    render(<RemindHost route="todos" />);
    tick('15:16');
    expect((await screen.findByTestId('remind-act-ack')).textContent).toContain('확인');
  });

  it('打开 App 时收回已处理的系统通知（本机数据有了才跑）', () => {
    render(<RemindHost route="today" />);
    expect(closeHandled).toHaveBeenCalledTimes(1);
  });
});

describe('整页提醒', () => {
  it('还在响：标题、按钮；按“知道了”后回今天', async () => {
    nowMs = at('15:16');
    window.location.hash = `#/remind/event/${E1}?due=${at('15:15')}`;
    render(<FullReminderPage />);
    expect(screen.getByTestId('remind-full').textContent).toContain('和 Kim 开会');
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-act-ack'));
    });
    expect(savePatch).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('today');
    expect(screen.queryByTestId('remind-full-handled')).toBeNull();
  });
  it('别处已经处理（notified_for = 这次的时刻）：显示“已在其他设备上处理”（R-328），没有按钮', () => {
    nowMs = at('15:20');
    data.events = [ev(E1, '和 Kim 开会', '15:30', { notified_for: at('15:15') })];
    window.location.hash = `#/remind/event/${E1}?due=${at('15:15')}`;
    render(<FullReminderPage />);
    expect(screen.getByTestId('remind-full-handled').textContent).toContain('已在其他设备上处理');
    expect(screen.queryByTestId('remind-act-ack')).toBeNull();
  });
  it('时间改了（地址里的时刻不是现在的）：也算已处理', () => {
    nowMs = at('15:20');
    window.location.hash = `#/remind/event/${E1}?due=${at('15:00')}`;
    render(<FullReminderPage />);
    expect(screen.getByTestId('remind-full-handled')).toBeTruthy();
  });
  it('地址不合格、条目不存在：“这条提醒找不到了”', () => {
    window.location.hash = `#/remind/event/${E1}?due=1&next=x`;
    const { unmount } = render(<FullReminderPage />);
    expect(screen.getByTestId('remind-full-gone')).toBeTruthy();
    unmount();
    window.location.hash = `#/remind/todo/${T1}?due=5`;
    render(<FullReminderPage />);
    expect(screen.getByTestId('remind-full-gone')).toBeTruthy();
  });
});

describe('TC-B2-69：离线新建带提醒的记录', () => {
  it('还没同步上：页面提示“未同步，提醒可能不响”，列表行尾标记；同步后消失', () => {
    remindRecs = new Set([`todos:${T1}`]);
    const { rerender } = render(
      <>
        <UnsyncedRemindHint />
        <UnsyncedRemindMark table="todos" id={T1} />
        <UnsyncedRemindMark table="events" id={E1} />
      </>,
    );
    expect(screen.getByTestId('remind-unsynced-hint').textContent).toContain('未同步，提醒可能不响');
    expect(screen.getAllByTestId('remind-unsynced-mark').length).toBe(1);
    remindRecs = new Set();
    rerender(
      <>
        <UnsyncedRemindHint key="2" />
        <UnsyncedRemindMark key="3" table="todos" id={T1} />
      </>,
    );
    expect(screen.queryByTestId('remind-unsynced-hint')).toBeNull();
    expect(screen.queryByTestId('remind-unsynced-mark')).toBeNull();
  });
  it('韩文', () => {
    uiStore.getState().setLocale('ko-KR');
    remindRecs = new Set([`events:${E1}`]);
    render(<UnsyncedRemindHint />);
    const text = screen.getByTestId('remind-unsynced-hint').textContent ?? '';
    expect(text).not.toBe('');
    expect(/[一-鿿]/.test(text)).toBe(false);
  });
});

describe('TC-B2-26：错过的提醒（今天页那一行）', () => {
  afterEach(() => setRemindArmed(null));
  it('打开前已经到点的：出“错过 N 条提醒”，没有就不出（引擎 armed 以后才画，修订 1 P2）', () => {
    nowMs = at('16:10');
    setRemindArmed(at('16:00'));
    render(<MissedReminders />);
    expect(screen.getByText('错过 2 条提醒')).toBeTruthy();
    cleanup();
    data.events = [];
    render(<MissedReminders />);
    expect(screen.queryByText(/错过/)).toBeNull();
  });
});
