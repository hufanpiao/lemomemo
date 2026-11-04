// 提醒横幅、按钮条退场途中不接点按（REMIND-banner-exit-click，接线第一段代码审查 R4）：
// 按了“知道了”以后横幅和按钮条播退场动画，Appear 外层打 data-state="leaving"；Remind.module.css 让这一层的子元素 pointer-events: none，
// 这段时间里再点“稍后”“详情 ›”“先收起”都不触发。动效减弱（data-rm="1"）时退场只淡出，同样有 leaving、同样不接点按。
// jsdom 默认不加载 CSS：这里把 Remind.module.css 原文注进页面（单测里 CSS Modules 类名不加哈希，选择器照样对得上），
// 用 user-event 点：它按计算样式查 pointer-events，是 none 就报错、不派发点按。替身和 remind-late-mount.test.tsx 同一套
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindQueue, resetRemindQueue } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { loadMotionFeatures } from '../../../motion/index.ts';

// 动效功能包异步加载（B2 FA-6 ②）：这里测的是退场动画途中的点按，先等功能包到（真实页面里首屏画完后提醒才挂，那时早已到齐）
await loadMotionFeatures();

type Row = { id: string } & Record<string, unknown>;
const data: Record<string, Row[]> = { events: [], todos: [], settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => data[name] ?? [] }));
const savePatch = vi.fn(async (..._a: unknown[]): Promise<string> => 'saved');
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
vi.mock('../../../platform/native-bridge.ts', () => ({
  openReminder: (...a: unknown[]) => openReminder(...a),
  showLocalReminder: async () => undefined,
  closeLocalReminder: async () => undefined,
}));
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: async () => 0 }));
vi.mock('../../../app/router.ts', () => ({ canGoBack: () => false, goBack: vi.fn(), navigate: async () => undefined }));
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({ outbox: { subscribe: () => () => undefined, getStatus: () => ({ remindRecs: new Set() }), list: async () => [] } }),
}));

const { default: RemindHost } = await import('../ui/RemindHost.tsx');

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(DAY, (h ?? 0) * 60 + (m ?? 0), SEOUL);
};
const ev: Row = {
  id: '00000000-0000-4000-8000-000000000001', title: '和 Kim 开会', date: DAY, time: '15:30', tz: SEOUL, remind_min: 15, duration_min: 60,
  deleted_at: null, undone: false, notified_for: null, snooze_at: null, defer_until: null,
};
const html = document.documentElement;
let sheet: HTMLStyleElement | null = null;
beforeAll(() => {
  sheet = document.createElement('style');
  // 按测试文件的位置找（不依赖运行目录，审查 L2）；用 node:url 的 URL——jsdom 把全局 URL 换成了自己的，readFileSync 不认
  sheet.textContent = readFileSync(new NodeURL('../ui/Remind.module.css', import.meta.url), 'utf8');
  document.head.append(sheet);
});
afterAll(() => sheet?.remove());

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  data.events = [ev];
  nowMs = at('15:14');
  subs.clear();
  resetRemindQueue();
  remindQueue.setState({ holds: [] });
  savePatch.mockClear();
  openReminder.mockClear();
});
afterEach(() => {
  cleanup();
  delete html.dataset['rm'];
});

/** 挂上、到点出横幅和按钮条 */
async function ring() {
  render(<RemindHost route="todos" since={at('15:14')} />);
  nowMs = at('15:16');
  act(() => {
    for (const f of [...subs]) f();
  });
  await screen.findByTestId('remind-banner');
  await screen.findByTestId('remind-bar');
}
/** Appear 那一层（.layer）的 data-state */
const layerState = (testId: string): string | undefined => screen.getByTestId(testId).parentElement?.dataset['state'];

/** 按“知道了”，横幅、按钮条开始退场；退场途中再点三处，都不触发 */
async function ackThenTapWhileLeaving() {
  const user = userEvent.setup();
  await ring();
  fireEvent.click(screen.getByTestId('remind-act-ack'));
  await waitFor(() => expect(savePatch).toHaveBeenCalledTimes(1));
  // 还在页面上（播退场），外层打了 leaving
  await waitFor(() => expect(layerState('remind-banner')).toBe('leaving'));
  expect(layerState('remind-bar')).toBe('leaving');
  await expect(user.click(screen.getByTestId('remind-act-snooze10'))).rejects.toThrow(/pointer-events/);
  await expect(user.click(screen.getByTestId('remind-banner-open'))).rejects.toThrow(/pointer-events/);
  await expect(user.click(screen.getByTestId('remind-banner-collapse'))).rejects.toThrow(/pointer-events/);
  expect(savePatch).toHaveBeenCalledTimes(1);
  expect(openReminder).not.toHaveBeenCalled();
  expect(remindQueue.getState().collapsed.size).toBe(0);
  // 退场播完卸载
  await waitFor(() => expect(screen.queryByTestId('remind-banner')).toBeNull());
  expect(screen.queryByTestId('remind-bar')).toBeNull();
}

describe('提醒横幅、按钮条退场途中不接点按（REMIND-banner-exit-click）', () => {
  it('对照：没退场时照常能点（注进来的样式生效，横幅、按钮可以点）', async () => {
    const user = userEvent.setup();
    await ring();
    expect(layerState('remind-banner')).toBeUndefined();
    await user.click(screen.getByTestId('remind-banner-open'));
    expect(openReminder).toHaveBeenCalledTimes(1);
  });

  it('按了“知道了”退场途中：“稍后”“详情 ›”“先收起”都不触发', async () => {
    await ackThenTapWhileLeaving();
  });

  it('动效减弱（data-rm="1"，只淡出）：退场途中同样不接点按', async () => {
    html.dataset['rm'] = '1';
    await ackThenTapWhileLeaving();
  });
});
