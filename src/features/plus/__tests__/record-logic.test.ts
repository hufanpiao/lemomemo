// 录音面板和按住“＋”的纯逻辑（data/record-logic.ts；架构 5.1、5.11；任务单 Q3）
import { describe, expect, it } from 'vitest';
import { AI_AUDIO_MAX_BYTES } from '../../../../shared/schema/ai.ts';
import {
  canAutoRetry, fmtClock, HOLD_IDLE, holdStep, keptExpired, REC_BITS_PER_SECOND, REC_MAX_MS, recCountdown, uploadTimeoutMs,
  type HoldAction, type HoldEvent, type HoldState,
} from '../data/record-logic.ts';

describe('上传总超时：下限 17 秒、每 100 KB 加 1 秒、上限 22 秒（5.11 第 1 点定论：比服务器等 Gemini 的 15 秒长）', () => {
  it.each([
    [0, 17_000],
    [1, 18_000],
    [100 * 1024, 18_000],
    [100 * 1024 + 1, 19_000],
    [150 * 1024, 19_000],
    [400 * 1024, 21_000],
    [500 * 1024, 22_000],
    [600 * 1024, 22_000],
    [5_000 * 1024, 22_000],
  ])('%i 字节 → %i ms', (bytes, ms) => expect(uploadTimeoutMs(bytes)).toBe(ms));
});

describe('码率：录满 60 秒也在 600 KB 以内（架构 5.11：直传按 AAC 32–64 kbps 算）', () => {
  it('字节上限就是 600 KB（架构 5.11 第 2 点“客户端硬上限 600 KB”）', () => {
    expect(AI_AUDIO_MAX_BYTES).toBe(600 * 1024);
  });
  it('码率在 32–64 kbps 里', () => {
    expect(REC_BITS_PER_SECOND).toBeGreaterThanOrEqual(32_000);
    expect(REC_BITS_PER_SECOND).toBeLessThanOrEqual(64_000);
  });
  it('按这个码率录满上限时长，加两成容器和码率浮动的余量，仍不超过字节上限', () => {
    const bytes = (REC_BITS_PER_SECOND / 8) * (REC_MAX_MS / 1000);
    expect(bytes * 1.2).toBeLessThanOrEqual(AI_AUDIO_MAX_BYTES);
  });
});

describe('计时：50 秒起倒数', () => {
  it('倒数', () => {
    expect(recCountdown(49_999)).toBeNull();
    expect(recCountdown(50_000)).toBe(10);
    expect(recCountdown(59_001)).toBe(1);
    expect(recCountdown(61_000)).toBe(0);
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
  it('留着的录音 2 分钟过期', () => {
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
