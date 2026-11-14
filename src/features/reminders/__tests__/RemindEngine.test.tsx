// 横幅手势和提醒引擎（B2 FA-4 代码审查补漏测、设计 M1 / M2）：上滑收起吞掉 click、回前台关通知、跨分钟 / 跨午夜刷新、免打扰跨午夜、按点按时刻重算、卸载撤回本机通知
// 替身和 RemindHost.test.tsx 同一套
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindQueue, resetRemindQueue } from '../../../kit/state/remind-queue.ts';
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
vi.mock('../../../platform/viewport.ts', () => ({ watchKeyboard: () => () => undefined, isKeyboardOpen: () => false }));
const openReminder = vi.fn(async (..._a: unknown[]) => undefined);
const showLocalReminder = vi.fn(async (..._a: unknown[]) => undefined);
const closeLocalReminder = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../../../platform/native-bridge.ts', () => ({
  openReminder: (...a: unknown[]) => openReminder(...a),
  showLocalReminder: (...a: unknown[]) => showLocalReminder(...a),
  closeLocalReminder: (...a: unknown[]) => closeLocalReminder(...a),
}));
const closeHandled = vi.fn(async (..._a: unknown[]) => 0);
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: (...a: unknown[]) => closeHandled(...a) }));
const navigate = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../../../app/router.ts', () => ({ canGoBack: () => false, goBack: vi.fn(), navigate: (...a: unknown[]) => navigate(...a) }));
let remindRecs: ReadonlySet<string> = new Set();
type ObItem = { rec: string; op: 'insert' | 'patch'; state: 'pending' | 'inflight' | 'failed'; sent?: boolean; data: Record<string, unknown> };
let outboxList: ObItem[] = [];
const outboxSubs = new Set<() => void>();
const pendingPatch = (data: Record<string, unknown>): ObItem => ({ rec: `events:${E1}`, op: 'patch', state: 'pending', data });
/** 发一次 outbox 通知，再等补写链跑完：排两轮宏任务（setTimeout 0）。纯微任务链在下一个宏任务之前一定跑完，不再靠“等 N 次微任务”数次数（接线审查范围外发现） */
const fireOutbox = () => act(async () => {
  for (const f of [...outboxSubs]) f();
  for (let i = 0; i < 2; i++) await new Promise<void>((r) => setTimeout(r, 0));
});
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({
    outbox: {
      subscribe: (fn: () => void) => {
        outboxSubs.add(fn);
        return () => outboxSubs.delete(fn);
      },
      getStatus: () => ({ retryRecs: EMPTY_RECS, remindRecs }),
      list: async () => outboxList,
    },
  }),
}));

const { default: RemindHost } = await import('../ui/RemindHost.tsx');

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (hm: string, date = DAY): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(date, (h ?? 0) * 60 + (m ?? 0), SEOUL);
};
const E1 = '00000000-0000-4000-8000-000000000001';
const E2 = '00000000-0000-4000-8000-000000000002';
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
  outboxList = [];
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

describe('横幅手势与引擎（代码审查补漏测）', () => {
  afterEach(() => vi.useRealTimers());

  it('往上滑收起：不写服务器、进收起；滑动成立后随后的 click 被吞掉，不打开整页提醒（设计 M1）', async () => {
    render(<RemindHost route="todos" />);
    tick('15:16');
    const main = await screen.findByTestId('remind-banner-open');
    fireEvent.pointerDown(main, { clientY: 100 });
    fireEvent.pointerMove(main, { clientY: 60 });
    fireEvent.pointerUp(main, { clientY: 40 });
    fireEvent.click(main);
    expect(openReminder).not.toHaveBeenCalled();
    expect(remindQueue.getState().collapsed.size).toBe(1);
    expect(savePatch).not.toHaveBeenCalled();
    await gone('remind-banner');
  });

  it('拖了一点没到收起距离：横幅留着，那次 click 也吞掉；之后正常点按照常打开', async () => {
    render(<RemindHost route="todos" />);
    tick('15:16');
    const main = await screen.findByTestId('remind-banner-open');
    fireEvent.pointerDown(main, { clientY: 100 });
    fireEvent.pointerMove(main, { clientY: 85 });
    fireEvent.pointerUp(main, { clientY: 85 });
    fireEvent.click(main);
    expect(openReminder).not.toHaveBeenCalled();
    expect(remindQueue.getState().collapsed.size).toBe(0);
    fireEvent.pointerDown(main, { clientY: 100 });
    fireEvent.pointerUp(main, { clientY: 100 });
    fireEvent.click(main);
    expect(openReminder).toHaveBeenCalledTimes(1);
  });

  it('点“详情 ›”打开整页提醒、不会变成收起；“先收起”在抓手条左边，点按区只往下扩（设计 N1）', async () => {
    render(<RemindHost route="todos" />);
    tick('15:16');
    const b = await screen.findByTestId('remind-banner');
    const detail = [...b.querySelectorAll('span')].find((s) => s.textContent === '详情 ›');
    if (!detail) throw new Error('没找到“详情 ›”');
    fireEvent.pointerDown(detail, { clientY: 100 });
    fireEvent.pointerUp(detail, { clientY: 100 });
    fireEvent.click(detail);
    expect(openReminder).toHaveBeenCalledTimes(1);
    expect(remindQueue.getState().collapsed.size).toBe(0);
    // 收起按钮排在抓手条前面（左边），不在“详情 ›”正下方
    const collapse = screen.getByTestId('remind-banner-collapse');
    expect(collapse.nextElementSibling?.getAttribute('aria-hidden')).toBe('true');
    const css = readFileSync('src/features/reminders/ui/Remind.module.css', 'utf8');
    const after = /\.collapse::after \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(after).toMatch(/top: 0;/);
    expect(after).not.toContain('translate');
    expect(/\.collapse \{([^}]*)\}/.exec(css)?.[1]).toMatch(/left: -6px;/);
  });

  it('往上拖没到 30px 松手：跟手时不加过渡，松手回位走 --dur-ui；减少动态效果时直接回位（设计 N2）', async () => {
    render(<RemindHost route="todos" />);
    tick('15:16');
    const b = await screen.findByTestId('remind-banner');
    const main = screen.getByTestId('remind-banner-open');
    const settling = () => b.className.split(' ').length > 1;
    expect(settling()).toBe(true);
    fireEvent.pointerDown(main, { clientY: 100 });
    fireEvent.pointerMove(main, { clientY: 85 });
    expect(settling()).toBe(false);
    expect(b.style.transform).toBe('translateY(-15px)');
    fireEvent.pointerUp(main, { clientY: 85 });
    expect(settling()).toBe(true);
    expect(b.style.transform).toBe('');
    const css = readFileSync('src/features/reminders/ui/Remind.module.css', 'utf8');
    expect(css).toMatch(/\.settling \{\s*transition: transform var\(--dur-ui\) var\(--ease-standard\);/);
    expect(css).toMatch(/:global\(:root\[data-rm="1"\]\) \.settling \{\s*transition: none;/);
  });

  it('横幅右边有“详情 ›”，读屏用 aria-live 播报（设计 M2、代码审查低 3）', async () => {
    render(<RemindHost route="todos" />);
    tick('15:16');
    const b = await screen.findByTestId('remind-banner');
    expect(b.textContent).toContain('详情 ›');
    expect(b.getAttribute('aria-live')).toBe('polite');
  });

  it('回到前台（visibilitychange）时再关一次已处理的系统通知', () => {
    render(<RemindHost route="today" />);
    expect(closeHandled).toHaveBeenCalledTimes(1);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(closeHandled).toHaveBeenCalledTimes(2);
  });

  it('审查第 16 条（两段 effect 合成一段）：本机还没拉到行时不关、回前台也不关；拉到行先关一次，之后回前台再关', () => {
    const rows = data.events ?? [];
    data.events = [];
    const { rerender } = render(<RemindHost route="today" />);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(closeHandled).toHaveBeenCalledTimes(0);
    data.events = [...rows];
    rerender(<RemindHost route="today" />);
    expect(closeHandled).toHaveBeenCalledTimes(1);
    data.events = [...rows];
    rerender(<RemindHost route="today" />);
    expect(closeHandled).toHaveBeenCalledTimes(1);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(closeHandled).toHaveBeenCalledTimes(2);
  });

  it('跨分钟：不靠外部通知，整分钟计时器到了自己刷新', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    nowMs = at('15:14') + 30_000;
    render(<RemindHost route="todos" />);
    await armedNow();
    expect(screen.queryByTestId('remind-banner')).toBeNull();
    nowMs = at('15:15') + 60;
    act(() => {
      vi.advanceTimersByTime(30_100);
    });
    expect(screen.getByTestId('remind-banner').textContent).toContain('和 Kim 开会');
  });

  it('跨午夜：23:59 打开，第二天 00:00 的提醒到点照常出', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    data.events = [ev(E1, '午夜航班', '00:15', { date: '2026-11-04' })];
    nowMs = at('23:59') + 30_000;
    render(<RemindHost route="todos" />);
    await armedNow();
    expect(screen.queryByTestId('remind-banner')).toBeNull();
    nowMs = at('00:00', '2026-11-04') + 60;
    act(() => {
      vi.advanceTimersByTime(30_100);
    });
    expect(screen.getByTestId('remind-banner').textContent).toContain('午夜航班');
  });

  it('免打扰跨午夜（23:00–07:00）：23:30 的提醒本机推迟到第二天 07:00 才出', async () => {
    data.settings = [{ id: 's1', key: 'remind.dnd', value: { start: '23:00', end: '07:00' }, deleted_at: null, undone: false }];
    data.events = [ev(E1, '夜里的日程', '23:30', { remind_min: 0 })];
    nowMs = at('23:20');
    render(<RemindHost route="todos" />);
    tick('23:31');
    expect(screen.queryByTestId('remind-banner')).toBeNull();
    nowMs = at('06:59', '2026-11-04');
    act(() => {
      for (const f of [...subs]) f();
    });
    expect(screen.queryByTestId('remind-banner')).toBeNull();
    nowMs = at('07:00', '2026-11-04');
    act(() => {
      for (const f of [...subs]) f();
    });
    expect((await screen.findByTestId('remind-banner')).textContent).toContain('夜里的日程');
  });

  it('“10 分钟后”按点按那一刻算（渲染后过了 4 分钟才点，写 15:30 不是 15:26；代码审查低 1）', async () => {
    render(<RemindHost route="todos" />);
    tick('15:16');
    await screen.findByTestId('remind-bar');
    nowMs = at('15:20');
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-act-snooze10'));
    });
    expect(savePatch).toHaveBeenCalledWith('events', E1, { snooze_at: at('15:30'), updated_at: at('15:20') }, true);
  });

  it('卸载（退出登录、换账号）时撤回本次弹出的本机通知（代码审查低 5）', async () => {
    const { unmount } = render(<RemindHost route="todos" />);
    await armedNow();
    tick('15:16');
    expect(showLocalReminder).toHaveBeenCalledTimes(1);
    unmount();
    expect(closeLocalReminder).toHaveBeenCalledWith(`event:${E1}:${at('15:15')}`);
  });

  it('R4-L1：outbox 里还有没发出去的改日期，按“知道了”不写 notified_for，只关横幅、撤本机通知；之后不再弹；换账号（卸载）后清空', async () => {
    const { unmount } = render(<RemindHost route="todos" />);
    tick('15:16');
    await screen.findByTestId('remind-bar');
    outboxList = [pendingPatch({ date: '2026-11-04', notified_for: null, snooze_at: null, updated_at: 1 })];
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-act-ack'));
    });
    expect(savePatch).not.toHaveBeenCalled();
    expect(closeLocalReminder).toHaveBeenCalledWith(`event:${E1}:${at('15:15')}`);
    await waitFor(() => expect(screen.queryByText('和 Kim 开会')).toBeNull());
    tick('15:17');
    expect(screen.queryByText('和 Kim 开会')).toBeNull();
    unmount();
    // 换账号重挂：本次会话的已处理集合已清空，这一条（同一个 tag）照常响
    outboxList = [];
    nowMs = at('15:10');   // 重挂时还没到点：到点进横幅（打开前就到点的进“错过的提醒”）
    render(<RemindHost route="todos" />);
    tick('15:16');
    expect(await screen.findByText('和 Kim 开会')).toBeTruthy();
  });
  it('R4-L1：没有这种改动时照常写 notified_for', async () => {
    render(<RemindHost route="todos" />);
    tick('15:16');
    await screen.findByTestId('remind-bar');
    outboxList = [pendingPatch({ title: '改了标题', updated_at: 1 })];
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-act-ack'));
    });
    expect(savePatch).toHaveBeenCalledWith('events', E1, { notified_for: at('15:15'), updated_at: at('15:16') }, true);
  });

  it('R4-L1 第三轮 L10：那条改动发出去以后，提醒时刻没变的补写一次“知道了”；变了的不写', async () => {
    render(<RemindHost route="todos" />);
    tick('15:16');
    await screen.findByTestId('remind-bar');
    outboxList = [pendingPatch({ date: DAY, remind_days: null, updated_at: 1 })];
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-act-ack'));
    });
    expect(savePatch).not.toHaveBeenCalled();
    // 还没发出去：outbox 变了也不补写
    await fireOutbox();
    expect(savePatch).not.toHaveBeenCalled();
    // 发出去了（不在待发里了），提醒时刻还是 15:15：补写一次
    outboxList = [];
    await fireOutbox();
    await waitFor(() => expect(savePatch).toHaveBeenCalledWith('events', E1, { notified_for: at('15:15'), updated_at: at('15:16') }, true));
    savePatch.mockClear();
    await fireOutbox();
    expect(savePatch).not.toHaveBeenCalled();
  });
  it('R4-L1 第三轮 L10：发出去以后提醒时刻变了（另一次提醒），不补写', async () => {
    render(<RemindHost route="todos" />);
    tick('15:16');
    await screen.findByTestId('remind-bar');
    outboxList = [pendingPatch({ date: '2026-11-04', notified_for: null, snooze_at: null, updated_at: 1 })];
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-act-ack'));
    });
    data.events = [ev(E1, '和 Kim 开会', '15:30', { date: '2026-11-04' }), ev(E2, '牙医', '15:45')];
    tick('15:17');
    outboxList = [];
    await fireOutbox();
    expect(savePatch).not.toHaveBeenCalled();
  });
});
