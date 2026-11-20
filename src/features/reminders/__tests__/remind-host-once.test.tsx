// RemindHost 里提醒列表只算一遍（11-20 全 app 改善报告第四节）：原来引擎（useRemindEngine）算一份、RemindHost 自己又算一份，
// 每分钟 allReminders 全量重算两次（含纪念日推算）。现在引擎把算好的 list、tz、prefs 交给 RemindHost。
// 量：每过一分钟，allReminders 调几次；横幅、按钮条画出来的文字和各块和原来一样（同 RemindHost.test.tsx 的替身）
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindQueue, resetRemindQueue } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type * as ReminderModel from '../data/reminder-model.ts';
const EMPTY_RECS = vi.hoisted((): ReadonlySet<string> => new Set());
const count = vi.hoisted(() => ({ all: 0 }));

type Row = { id: string } & Record<string, unknown>;
const data: Record<string, Row[]> = { events: [], todos: [], settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => data[name] ?? [] }));
vi.mock('../../../core/edit-save.ts', () => ({ savePatch: vi.fn(async () => 'saved' as const) }));
vi.mock('../../../core/current-tz.ts', () => ({ currentTz: () => 'Asia/Seoul' }));
vi.mock('../data/reminder-model.ts', async (orig) => {
  const m = await orig<typeof ReminderModel>();
  return {
    ...m,
    allReminders: (...a: Parameters<typeof m.allReminders>) => {
      count.all += 1;
      return m.allReminders(...a);
    },
  };
});

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
vi.mock('../../../platform/native-bridge.ts', () => ({
  openReminder: vi.fn(async () => undefined),
  showLocalReminder: vi.fn(async () => undefined),
  closeLocalReminder: vi.fn(async () => undefined),
  reminderHash: (kind: string, id: string, due: number) => `#/remind/${kind}/${id}?due=${due}`,
}));
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: vi.fn(async () => 0) }));
vi.mock('../../../app/router.ts', () => ({
  canGoBack: () => false,
  goBack: vi.fn(),
  navigate: vi.fn(),
  replaceRoute: vi.fn(),
  backTo: vi.fn(),
  upTo: vi.fn(),
}));
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({ outbox: { subscribe: () => () => undefined, getStatus: () => ({ retryRecs: EMPTY_RECS, remindRecs: EMPTY_RECS }) } }),
}));

await (await import('../../../motion/index.ts')).loadMotionFeatures();
const { default: RemindHost } = await import('../ui/RemindHost.tsx');

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(DAY, (h ?? 0) * 60 + (m ?? 0), SEOUL);
};
const ev = (id: string, title: string, time: string): Row => ({
  id, title, date: DAY, time, tz: SEOUL, remind_min: 15, duration_min: 60, deleted_at: null, undone: false,
  notified_for: null, snooze_at: null, defer_until: null,
});
const tick = (hm: string): void => {
  nowMs = at(hm);
  act(() => {
    for (const f of [...subs]) f();
  });
};

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  data.events = [ev('00000000-0000-4000-8000-000000000001', '和 Kim 开会', '15:30'), ev('00000000-0000-4000-8000-000000000002', '牙医', '15:45')];
  data.todos = [];
  data.settings = [];
  nowMs = at('15:00');
  resetRemindQueue();
  remindQueue.setState({ holds: [] });
});
afterEach(() => cleanup());

describe('RemindHost 提醒列表只算一遍', () => {
  it('每过一分钟 allReminders 只调一次（原来两次）；到点的横幅、按钮条照旧', async () => {
    const { container } = render(<RemindHost route="todos" />);
    await act(async () => {
      for (let k = 0; k < 6; k++) await Promise.resolve();
    });
    const per: number[] = [];
    for (const hm of ['15:01', '15:02', '15:31', '15:32']) {
      count.all = 0;
      tick(hm);
      await act(async () => {
        for (let k = 0; k < 6; k++) await Promise.resolve();
      });
      per.push(count.all);
    }
    expect((await screen.findByTestId('remind-banner')).textContent).toContain('和 Kim 开会还有 1 条');
    expect(screen.getByTestId('remind-bar')).toBeTruthy();
    // 画出来的和改前一样（11-20 改前改后各导出整段 HTML 逐字比过，入场动画层的 style 按真实时间走到一半不比）：这里钉文字和各块
    expect(container.textContent).toBe('日程 · 已经开始和 Kim 开会还有 1 条详情 ›先收起知道了10 分钟后');
    expect([...container.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))).toEqual([
      'remind-banner', 'remind-banner-open', 'remind-banner-collapse', 'remind-bar', 'remind-act-ack', 'remind-act-snooze10',
    ]);
    expect(per).toEqual([1, 1, 1, 1]);
  });
});
