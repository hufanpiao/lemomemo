// 提醒界面照线框排（B2 FA-4 设计审查 H1、M3、M4、M5、L1）：整页提醒、错过的提醒、未来 7 天的提醒
// 替身和 RemindHost.test.tsx 同一套（本机集合、写入、时钟、键盘、桥接、路由）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { collapseRinging, remindQueue, resetRemindQueue, setRemindArmed, setRemindDown } from '../../../kit/state/remind-queue.ts';
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
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({ outbox: { subscribe: () => () => undefined, getStatus: () => ({ retryRecs: EMPTY_RECS, remindRecs }) } }),
}));

const { default: RemindHost } = await import('../ui/RemindHost.tsx');
const { default: FullReminderPage } = await import('../ui/FullReminderPage.tsx');
const { default: MissedReminders } = await import('../ui/MissedReminders.tsx');
const { default: RemindUpcoming } = await import('../ui/RemindUpcoming.tsx');

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

describe('整页提醒照线框排（设计 H1）', () => {
  it('铃铛类型行、大时刻（开始时刻）、标题、“到 16:30 · 项目”、地点备注一张卡、下一条卡（时刻 · 类型 · 项目）、主按钮整行 + 其余两颗一排', async () => {
    data.events = [
      ev(E1, 'SignPlex 客户反馈会', '15:30', { project: 'SignPlex', location: 'Zoom', note: '带上问题清单' }),
      ev(E2, '牙医', '15:45'),
    ];
    render(<RemindHost route="remind" />);
    await armedNow();
    tick('15:31');
    window.location.hash = `#/remind/event/${E1}?due=${at('15:15')}`;
    render(<FullReminderPage />);
    const page = screen.getByTestId('remind-full');
    expect(page.querySelector('svg')).not.toBeNull();
    // 类型行写“还有多久”，不再写一遍时刻（设计复审 今天页待办 M3）
    expect(screen.getByTestId('remind-full-kind').textContent).toBe('日程 · 已经开始 1 分钟');
    expect(screen.getByTestId('remind-full-time').textContent).toBe('15:30');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('SignPlex 客户反馈会');
    // 返回按钮：“‹”只是样子，读屏名只读“返回”（代码复审 N2，同设置页）
    const back = screen.getByTestId('remind-full-back');
    expect(back.querySelector('[aria-hidden="true"]')?.textContent).toBe('‹');
    expect(screen.getByRole('button', { name: '返回' })).toBe(back);
    expect(screen.getByTestId('remind-full-sub').textContent).toBe('到 16:30 · SignPlex');
    expect(screen.getByTestId('remind-full-detail').textContent).toContain('带上问题清单');
    const next = screen.getByTestId('remind-full-next');
    expect(next.textContent).toContain('下一条：牙医');
    expect(next.textContent).toContain(`15:30 提醒 · 日程`); // 副行写明是提醒时刻（设计复审第二轮 R2-L3）
    const ack = screen.getByTestId('remind-act-ack');
    const rest = screen.getByTestId('remind-act-snooze10').parentElement;
    expect(ack.parentElement).not.toBe(rest);
    expect(rest?.children.length).toBe(1);
  });
  it('待办：完成圆圈在标题旁边（不在 h1 里），写失败时提示、不跳走（设计 L1）', async () => {
    data.events = [];
    data.todos = [{ id: T1, title: '交报告', due: DAY, due_time: '17:00', remind_before_min: 60, remind_at: at('16:00'), remind_days: null, remind_time: null, done: false, deleted_at: null, undone: false, notified_for: null, snooze_at: null, defer_until: null }];
    nowMs = at('16:00');
    window.location.hash = `#/remind/todo/${T1}?due=${at('16:00')}`;
    render(<FullReminderPage />);
    expect(screen.getByTestId('remind-full-kind').textContent).toBe('待办 · 1 小时后截止');
    expect(screen.getByTestId('remind-full-time').textContent).toBe('17:00');
    const circle = screen.getByTestId('remind-full-done');
    expect(circle.closest('h1')).toBeNull();
    expect(screen.getByTestId('remind-act-hour1').parentElement?.children.length).toBe(3);
    savePatch.mockResolvedValueOnce('failed' as never);
    await act(async () => {
      fireEvent.click(circle);
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('错过的提醒照线框（设计 M3、M4）', () => {
  // 引擎 armed 以后才画（REMIND-shown-persist 修订 1 P2）；since 取很大、不筛
  beforeEach(() => setRemindArmed(Number.MAX_SAFE_INTEGER));
  afterEach(() => setRemindArmed(null));
  it('首屏只画那一行；有错过的提醒才在首屏画完、空闲时预取弹层（首屏瘦身 H1 第三轮），没有的不预取', async () => {
    const idle = vi.fn();
    vi.stubGlobal('requestIdleCallback', idle);
    try {
      nowMs = at('16:10');
      const view = render(<MissedReminders />);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(idle).toHaveBeenCalledTimes(1);
      view.unmount();
      idle.mockClear();
      data.events = [];
      render(<MissedReminders />);
      expect(screen.queryByTestId('remind-missed-row')).toBeNull();
      expect(idle).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('那一行有铃铛和粗体；弹层标题带条数，“全部知道了”在弹层里；每条一张小卡，已经开始的日程只给“知道了”（弹层分包点开才下，等它出来）', async () => {
    nowMs = at('16:10');
    render(<MissedReminders />);
    const row = screen.getByTestId('remind-missed-row');
    expect(row.querySelector('svg')).not.toBeNull();
    expect(row.querySelector('b')?.textContent).toBe('错过 2 条提醒');
    fireEvent.click(row);
    expect((await screen.findByRole('dialog', {}, { timeout: 5000 })).textContent).toContain('错过的提醒 2');
    expect(screen.getByTestId('remind-missed-all').textContent).toBe('全部知道了');
    const cards = screen.getAllByTestId('remind-missed-item');
    expect(cards.length).toBe(2);
    expect(cards[0]?.textContent).toContain('（已经开始过了）');
    expect(cards[0]?.querySelectorAll('[data-testid^="remind-act-"]').length).toBe(1);
  });
  it('弹层开着时错过的都处理完了（那一行没了）：关上以后焦点回到所在页的标题 h1，不掉到 body（Dialog L-2）', async () => {
    nowMs = at('16:10');
    const page = (
      <main>
        <h1 tabIndex={-1}>11月3日</h1>
        <MissedReminders />
      </main>
    );
    const view = render(page);
    const row = screen.getByTestId('remind-missed-row');
    row.focus();
    fireEvent.click(row);
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    data.events = [];
    view.rerender(
      <main>
        <h1 tabIndex={-1}>11月3日</h1>
        <MissedReminders />
      </main>,
    );
    expect(screen.queryByTestId('remind-missed-row')).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement?.tagName).toBe('H1');
  });
  it('只有 1 条：弹层里不出“全部知道了”（和这一条的“知道了”重复；负责人 11-04 定，设计复审 L2）', async () => {
    nowMs = at('16:10');
    data.events = [ev(E2, '牙医', '15:00')];
    render(<MissedReminders />);
    fireEvent.click(screen.getByTestId('remind-missed-row'));
    expect(await screen.findAllByTestId('remind-missed-item')).toHaveLength(1);
    expect(screen.queryByTestId('remind-missed-all')).toBeNull();
    expect(screen.getByTestId('remind-act-ack')).toBeTruthy();
  });
});

describe('REMIND-missed-flash：错过的提醒只算 since 之前到点的和响过的', () => {
  // E2 14:45 到点（since 之前，打开前就到点）；E1 16:05 到点（since 16:00 之后，本次打开以后，该进横幅）
  const setup = (): void => {
    nowMs = at('16:10');
    data.events = [ev(E1, '和 Kim 开会', '16:20'), ev(E2, '牙医', '15:00')];
  };
  afterEach(() => {
    setRemindArmed(null);
    setRemindDown(false);
  });

  it('引擎出错（remindDown，代码审查 M1）：不按 since 筛，照旧都算', () => {
    setup();
    setRemindDown(true);
    render(<MissedReminders />);
    expect(screen.getByTestId('remind-missed-row').textContent).toContain('错过 2 条提醒');
  });

  it('引擎还没把 E1 排进队列的那一下：传了 since 只算 E2，不先算进“错过 2 条”再跳走', () => {
    setup();
    setRemindArmed(at('16:00'));
    render(<MissedReminders />);
    expect(screen.getByTestId('remind-missed-row').textContent).toContain('错过 1 条提醒');
  });

  it('没 armed、也没出错：不画（P2）；引擎出错（remindDown）、“响过”快照是空的：照旧都算、照样显示（方案复审 L9）', () => {
    setup();
    const view = render(<MissedReminders />);
    expect(screen.queryByTestId('remind-missed-row')).toBeNull();
    view.unmount();
    setRemindDown(true);
    render(<MissedReminders />);
    expect(screen.getByTestId('remind-missed-row').textContent).toContain('错过 2 条提醒');
  });

  it('引擎挂上：写 armedSince（就是传进来的 since），E1 进队列、不算错过；往上滑收起以后 E1 照样进“错过的提醒”；卸载时清成 null', async () => {
    setup();
    const host = render(<RemindHost since={at('16:00')} />);
    expect(remindQueue.getState().armedSince).toBeNull(); // 本机记录还没读完：还没 armed（REMIND-shown-persist）
    await armedNow();
    expect(remindQueue.getState().armedSince).toBe(at('16:00'));
    expect(remindQueue.getState().entries.map((e) => e.id)).toEqual([E1]);
    render(<MissedReminders />);
    expect(screen.getByTestId('remind-missed-row').textContent).toContain('错过 1 条提醒');
    const tag = remindQueue.getState().entries[0]?.tag ?? '';
    await act(async () => {
      collapseRinging(tag);
    });
    expect(screen.getByTestId('remind-missed-row').textContent).toContain('错过 2 条提醒');
    host.unmount();
    expect(remindQueue.getState().armedSince).toBeNull();
  });
});

describe('未来 7 天的总览（提醒接线设计复审 M1）', () => {
  it('连着的几天合并写，日期之间用“、”；每段日期包在不折行的 span 里', () => {
    nowMs = at('09:00');
    // 今天 11-03 有、11-05 有，其余 11-04、11-06～11-09 没有
    data.events = [ev(E1, '和 Kim 开会', '15:30'), ev(E2, '牙医', '10:00', { date: '2026-11-05' })];
    render(<RemindUpcoming />);
    const sum = screen.getByTestId('remind-upcoming-summary');
    expect(sum.textContent).toBe('现在 09:00 之后 · 共 2 条 · 11月4日、11月6～9日 没有提醒');
    const spans = [...sum.querySelectorAll('span')].filter((s) => s.className.includes('nowrap')).map((s) => s.textContent);
    expect(spans).toEqual(['现在 09:00 之后 · 共 2 条', '11月4日', '11月6～9日']);
  });
  it('跨月的一段写“10月31日～11月2日”；韩文同一套', async () => {
    const { noneRuns } = await import('../ui/RemindUpcoming.tsx');
    const { remindZh } = await import('../i18n/zh.ts');
    const { remindKo } = await import('../i18n/ko.ts');
    const fmt = (dict: Record<string, string>) => (k: string, p: Record<string, string | number>) =>
      Object.entries(p).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), dict[k] ?? k);
    const days = ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-04'] as never;
    expect(noneRuns(fmt(remindZh) as never, days)).toEqual(['10月31日～11月2日', '11月4日']);
    expect(noneRuns(fmt(remindKo) as never, ['2026-11-06', '2026-11-07'] as never)).toEqual(['11월 6~7일']);
  });
});

describe('未来 7 天：开始那天和组头不是同一天时写哪天（设计复审第二轮 N3）', () => {
  const subs = (): string[] => screen.getAllByTestId('remind-upcoming-item').map((li) => li.querySelector('small')?.textContent ?? '');
  it('跨午夜（今晚 23:30 提醒、明天 00:00 开始）写“明天 00:00 开始”；提前一天的写“11月6日 00:10 开始”；同一天的照旧', () => {
    nowMs = at('09:00');
    data.events = [
      ev(E1, '午夜发布', '00:00', { date: '2026-11-04', remind_min: 30 }),
      ev(E2, '早班机', '00:10', { date: '2026-11-06', remind_min: 1440 }),
      ev(T1, '和 Kim 开会', '15:30'),
    ];
    render(<RemindUpcoming />);
    const days = screen.getAllByTestId('remind-upcoming-day').map((d) => d.getAttribute('data-date'));
    expect(days).toEqual(['2026-11-03', '2026-11-05']);
    expect(subs()).toEqual(['15:30 开始 · 提前 15 分钟', '明天 00:00 开始 · 提前 30 分钟', '11月6日 00:10 开始 · 提前 1 天']);
  });
  it('韩文：“내일 00:00 시작”', () => {
    uiStore.getState().setLocale('ko-KR');
    nowMs = at('09:00');
    data.events = [ev(E1, '午夜发布', '00:00', { date: '2026-11-04', remind_min: 30 })];
    render(<RemindUpcoming />);
    expect(subs()[0]).toMatch(/^내일 00:00 시작 · /);
  });
});

describe('未来 7 天的提醒（设计 M5）', () => {
  it('总览“现在 HH:MM 之后 · 共 N 条”并写出没有提醒的日子；组头“今天 · 11月3日 周二”和条数；副行“开始 · 提前”；点一条进编辑页', () => {
    nowMs = at('09:00');
    data.events = [ev(E1, '和 Kim 开会', '15:30'), ev(E2, '牙医', '10:00', { date: '2026-11-05' })];
    render(<RemindUpcoming />);
    const sum = screen.getByTestId('remind-upcoming-summary').textContent ?? '';
    expect(sum).toContain('现在 09:00 之后 · 共 2 条');
    expect(sum).toContain('11月4日');
    expect(sum).toContain('没有提醒');
    const day = screen.getAllByTestId('remind-upcoming-day')[0];
    expect(day?.querySelector('h2')?.textContent).toBe('今天 · 11月3日 周二1 条');
    expect(day?.textContent).toContain('15:30 开始 · 提前 15 分钟');
    fireEvent.click(screen.getAllByTestId('remind-upcoming-open')[0] as HTMLElement);
    expect(navigate).toHaveBeenCalledWith('event', E1);
    expect(openReminder).not.toHaveBeenCalled();
  });
});
