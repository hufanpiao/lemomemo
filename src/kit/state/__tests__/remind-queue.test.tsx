// 提醒横幅的队列（架构 5.9“提醒的排队规则”；TC-B2-22 的状态部分）：压着时不出、全部放开按顺序出、处理掉 / 收起出队、收起的不再进
import { readFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collapseRinging, HOLD_MAX_MS, holdReminders, pruneCollapsed, setRemindHoldLog, useHoldReminders, remindQueue, removeRinging, resetRemindQueue, setRinging, setSnoozeNote, visibleEntry, type RemindEntry } from '../remind-queue.ts';

const e = (n: number): RemindEntry => ({ kind: 'event', id: `id${n}`, dueAt: n, tag: `event:id${n}:${n}` });
const vis = () => visibleEntry(remindQueue.getState());

beforeEach(() => {
  resetRemindQueue();
  remindQueue.setState({ holds: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setRemindHoldLog(null);
});

function Holder({ on }: { on: boolean }) {
  useHoldReminders(on, 'recording');
  return null;
}

describe('提醒队列', () => {
  it('先到先出；新算出来的一批保留原顺序、新来的排后面', () => {
    setRinging([e(1)]);
    setRinging([e(2), e(1)]);
    expect(remindQueue.getState().entries.map((x) => x.id)).toEqual(['id1', 'id2']);
    expect(vis()?.id).toBe('id1');
  });
  it('录音、键盘压着时不出；全部放开才出；放开函数多调一次不出错', () => {
    setRinging([e(1), e(2)]);
    const r1 = holdReminders('recording');
    const r2 = holdReminders('keyboard');
    expect(vis()).toBeNull();
    r1();
    r1();
    expect(vis()).toBeNull();
    r2();
    expect(vis()?.id).toBe('id1');
  });
  it('处理掉的出队，下一条接着出', () => {
    setRinging([e(1), e(2)]);
    removeRinging(e(1).tag);
    expect(vis()?.id).toBe('id2');
  });
  it('收起的出队、记下，下一次算出来也不再进', () => {
    setRinging([e(1), e(2)]);
    collapseRinging(e(1).tag);
    setRinging([e(1), e(2)]);
    expect(remindQueue.getState().entries.map((x) => x.id)).toEqual(['id2']);
    expect(remindQueue.getState().collapsed.has(e(1).tag)).toBe(true);
  });
  it('稍后提示、清空', () => {
    setSnoozeNote(5);
    setRinging([e(1)]);
    resetRemindQueue();
    expect(remindQueue.getState()).toMatchObject({ entries: [], snoozeNote: null });
    expect(remindQueue.getState().collapsed.size).toBe(0);
  });
});

describe('压住不会永久卡住（代码审查中 4）', () => {
  it('useHoldReminders：active 时压住，变 false 放开；压住期间组件卸载自动放开', () => {
    setRinging([e(1)]);
    const { rerender, unmount } = render(<Holder on />);
    expect(vis()).toBeNull();
    rerender(<Holder on={false} />);
    expect(vis()?.id).toBe('id1');
    rerender(<Holder on />);
    expect(vis()).toBeNull();
    unmount();
    expect(vis()?.id).toBe('id1');
    expect(remindQueue.getState().holds).toEqual([]);
  });
  it('超过 10 分钟自动放开并记日志；按时放开的不记', () => {
    vi.useFakeTimers();
    const log = vi.fn();
    setRemindHoldLog(log);
    setRinging([e(1)]);
    const early = holdReminders('keyboard');
    early();
    holdReminders('recording');
    vi.advanceTimersByTime(HOLD_MAX_MS - 1);
    expect(vis()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(vis()?.id).toBe('id1');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('recording');
  });
});

describe('收起记录按 7 天修剪（代码审查低 8）', () => {
  it('dueAt 早于窗口的丢掉', () => {
    setRinging([e(1), e(100)]);
    collapseRinging(e(1).tag);
    collapseRinging(e(100).tag);
    pruneCollapsed(50);
    expect([...remindQueue.getState().collapsed]).toEqual([e(100).tag]);
  });
});

describe('压住超时的日志接线（代码审查 N1）', () => {
  it('main.tsx 在日志通道建好后接上 setRemindHoldLog，动作名 remind_hold_timeout、原因放 code', () => {
    const main = readFileSync('src/app/main.tsx', 'utf8');
    expect(main).toContain("import { setRemindHoldLog } from '../kit/state/remind-queue.ts';");
    const at = main.indexOf("setRemindHoldLog((reason) => logs.log('remind_hold_timeout', { code: reason }));");
    expect(at).toBeGreaterThan(main.indexOf('const logs = createLogChannel();'));
  });
});
