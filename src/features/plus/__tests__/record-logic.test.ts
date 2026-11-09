// 录音面板和按住“＋”的纯逻辑（data/record-logic.ts；架构 5.1、5.11；任务单 Q3）
import { describe, expect, it } from 'vitest';
import {
  canAutoRetry, canKeep, fmtClock, HOLD_IDLE, holdStep, keptExpired, recCountdown, recShouldStop, uploadTimeoutMs,
  type HoldAction, type HoldEvent, type HoldState,
} from '../data/record-logic.ts';

describe('上传总超时：8 秒 + 每 100 KB 1 秒，最多 20 秒', () => {
  it.each([
    [0, 8_000],
    [1, 9_000],
    [100 * 1024, 9_000],
    [100 * 1024 + 1, 10_000],
    [200 * 1024, 10_000],
    [600 * 1024, 14_000],
    [5_000 * 1024, 20_000],
  ])('%i 字节 → %i ms', (bytes, ms) => expect(uploadTimeoutMs(bytes)).toBe(ms));
});

describe('计时：50 秒起倒数，60 秒自动结束', () => {
  it('倒数', () => {
    expect(recCountdown(49_999)).toBeNull();
    expect(recCountdown(50_000)).toBe(10);
    expect(recCountdown(59_001)).toBe(1);
    expect(recCountdown(61_000)).toBe(0);
  });
  it('自动结束', () => {
    expect(recShouldStop(59_999)).toBe(false);
    expect(recShouldStop(60_000)).toBe(true);
  });
  it('计时写法', () => {
    expect(fmtClock(7_400)).toBe('0:07');
    expect(fmtClock(60_000)).toBe('1:00');
  });
});

describe('重试和录音保留', () => {
  it('只在网络错误时自动重试，最多 1 次', () => {
    expect(canAutoRetry('network', 0)).toBe(true);
    expect(canAutoRetry('network', 1)).toBe(false);
    expect(canAutoRetry('timeout', 0)).toBe(false);
    expect(canAutoRetry('http', 0)).toBe(false);
  });
  it('600 KB 以内才留；留 2 分钟', () => {
    expect(canKeep(600 * 1024)).toBe(true);
    expect(canKeep(600 * 1024 + 1)).toBe(false);
    expect(canKeep(0)).toBe(false);
    const k = { blob: new Blob(['x']), mime: 'audio/mp4', keptAt: 1_000 };
    expect(keptExpired(k, 120_999)).toBe(false);
    expect(keptExpired(k, 121_000)).toBe(true);
  });
});

/** 依次喂事件，收集动作 */
function run(events: HoldEvent[]): { state: HoldState; actions: HoldAction[] } {
  let state = HOLD_IDLE;
  const actions: HoldAction[] = [];
  for (const e of events) {
    const r = holdStep(state, e);
    state = r.state;
    if (r.action !== 'none') actions.push(r.action);
  }
  return { state, actions };
}

describe('按住“＋”（Q3：350 ms 判定、上拖取消、锁定）', () => {
  const down: HoldEvent = { type: 'down', t: 0, x: 100, y: 500 };
  it('350 ms 前松开 = 点一下', () => {
    expect(run([down, { type: 'up', t: 349, zone: null }]).actions).toEqual(['tap']);
  });
  it('到 350 ms = 开录；松开 = 记下', () => {
    const r = run([down, { type: 'tick', t: 350 }, { type: 'up', t: 3_000, zone: null }]);
    expect(r.actions).toEqual(['start', 'finish']);
    expect(r.state.phase).toBe('idle');
  });
  it('按下后先挪远（在滑动）：既不点也不录', () => {
    expect(run([down, { type: 'move', t: 100, x: 100, y: 470, zone: null }, { type: 'tick', t: 400 }, { type: 'up', t: 500, zone: null }]).actions).toEqual([]);
  });
  it('小幅抖动不算挪开', () => {
    expect(run([down, { type: 'move', t: 100, x: 104, y: 496, zone: null }, { type: 'tick', t: 360 }]).actions).toEqual(['start']);
  });
  it('拖进取消区松开 = 丢弃；拖出来再松开 = 记下', () => {
    const base: HoldEvent[] = [down, { type: 'tick', t: 400 }, { type: 'move', t: 500, x: 100, y: 200, zone: 'cancel' }];
    expect(run([...base, { type: 'up', t: 600, zone: 'cancel' }]).actions).toEqual(['start', 'discard']);
    expect(run([...base, { type: 'move', t: 550, x: 100, y: 480, zone: null }, { type: 'up', t: 600, zone: null }]).actions).toEqual(['start', 'finish']);
  });
  it('拖进锁定区 = 锁定；松手也继续录，之后手指的动作都不管', () => {
    const r = run([down, { type: 'tick', t: 400 }, { type: 'move', t: 500, x: 40, y: 400, zone: 'lock' }, { type: 'up', t: 600, zone: null }]);
    expect(r.actions).toEqual(['start', 'lock']);
    expect(r.state.phase).toBe('locked');
  });
  it('系统取消（来电、切走）：录着的丢弃，没开录的什么都不做', () => {
    expect(run([down, { type: 'tick', t: 400 }, { type: 'cancel' }]).actions).toEqual(['start', 'discard']);
    expect(run([down, { type: 'cancel' }]).actions).toEqual([]);
  });
});
