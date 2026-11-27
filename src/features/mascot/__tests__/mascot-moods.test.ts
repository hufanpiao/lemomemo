// 表情驱动（#23 Aldo，配置直接用目录里的 MASCOTS['23'].moods）：素材里有直达通道，要哪个表情就设一次输入、一步到；
// 事件到了停一会儿回平时、持续状态优先、空闲随机；Mail、Sleep 只在有这个状态时出现：提醒处理完、睡醒都直达回 Idle，
// 随机只在前后 2 个里换、从不随到 Mail 和 Sleep（负责人 11-26）；睡着时来的事件醒来不补播、太久没轮到的丢掉；舞台暂停时不排随机
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoodDef } from '../../../../shared/schema/mascot.ts';
import { createMoodRing, MOOD_EVENT_TTL_MS, MOOD_HOLD_MS, MOOD_RANDOM_MS, MOOD_RANDOM_REACH } from '../../../motion/mascot-stage.ts';
import { MASCOTS } from '../data/catalog.ts';

const DEF: MoodDef = MASCOTS['23'].moods!;
const RING = DEF.ring;
/** 假状态机的转场时长：设了输入以后过这么久回报到了 */
const T = DEF.ms;

/** 假状态机：输入设成 n（≥1）就经任意状态转到 RING[n-1]，T 毫秒后回报 */
function rig(opts: { random?: () => number; def?: MoodDef; t?: number } = {}) {
  const sets: number[] = [];
  const seen: string[] = [];
  let pending: ReturnType<typeof setTimeout> | undefined;
  const ring = createMoodRing(opts.def ?? DEF, {
    set(n) {
      sets.push(n);
      clearTimeout(pending);
      pending = setTimeout(() => {
        const s = RING[n - 1]!;
        seen.push(s);
        ring.report(['Click', s]);
      }, opts.t ?? T);
    },
    later: (fn, ms) => setTimeout(fn, ms),
    cancel: (t) => clearTimeout(t),
    random: opts.random ?? (() => 0.99),
  });
  /** 状态机此刻在 s，并回报（回报时会把输入设成当前要的那个，记录从这以后算） */
  const start = (s: string): void => {
    ring.report([s]);
    sets.length = 0;
  };
  return { ring, sets, seen, start };
}
const no = (s: string): number => RING.indexOf(s) + 1;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('表情驱动（直达）', () => {
  it('目录配置：事件和持续状态对上负责人定的表情', () => {
    expect(DEF.rest).toBe('Idle');
    expect(DEF.on).toEqual({ done: 'Happy', del: 'No', mail: 'Mail', sleep: 'Sleep' });
    expect(DEF.random).not.toContain('Mail');
    expect(DEF.random).not.toContain('Sleep');
    // 负责人 11-26：难过、不高兴“再也不出现”——随机不用，事件也不用
    for (const s of ['Sad', 'Upset']) {
      expect(DEF.random).not.toContain(s);
      expect(Object.values(DEF.on)).not.toContain(s);
    }
  });

  it('双击（shuffle）：随机换一个和现在不同的，不受相邻限制；从不换到 Sad、Upset、Mail、Sleep', () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const { ring, seen, start } = rig({ random });
    start('Idle');
    const got = new Set<string>();
    for (let k = 0; k < 300; k++) {
      const before = ring.goal;
      ring.shuffle();
      expect(ring.goal).not.toBe(before);
      got.add(ring.goal);
      vi.advanceTimersByTime(T);
    }
    expect(got).toEqual(new Set(DEF.random));
    expect(seen.filter((s) => ['Sad', 'Upset', 'Mail', 'Sleep'].includes(s))).toEqual([]);
  });

  it('双击：盖过还在停的事件表情；换完空闲随机重新计时，不会马上被换走', () => {
    const { ring, sets, start } = rig({ random: () => 0 });
    start('Idle');
    ring.cue('done');
    vi.advanceTimersByTime(T);
    sets.length = 0;
    ring.shuffle();
    // 正在停的是 Happy：换成 random 里第一个不是 Happy 的（random 固定 0）
    expect(sets).toEqual([no(DEF.random.filter((s) => s !== 'Happy')[0]!)]);
    sets.length = 0;
    // 换完空闲随机从头计时：最短间隔之前不会被换走（原来那次事件的停留计时也一起作废）
    vi.advanceTimersByTime(Math.max(MOOD_HOLD_MS, MOOD_RANDOM_MS[0]) - 1);
    expect(sets).toEqual([]);
  });

  it('提醒在响、睡着时双击不换', () => {
    const { ring, sets, start } = rig();
    start('Idle');
    ring.flag('mail', true);
    vi.advanceTimersByTime(T);
    sets.length = 0;
    ring.shuffle();
    expect(sets).toEqual([]);
    ring.flag('mail', false);
    ring.flag('sleep', true);
    vi.advanceTimersByTime(T);
    sets.length = 0;
    ring.shuffle();
    expect(sets).toEqual([]);
  });

  it('载入时在 Sleep：回报后设成 Idle，一次到', () => {
    const { ring, sets, seen } = rig();
    ring.report(['Sleep', 'Blink']);
    expect(sets).toEqual([no('Idle')]);
    vi.advanceTimersByTime(T);
    expect(ring.now).toBe('Idle');
    expect(seen).toEqual(['Idle']);
  });

  it('删除 → No：直接设 No，中间不经过别的表情', () => {
    const { ring, sets, seen, start } = rig();
    start('Idle');
    ring.cue('del');
    expect(sets).toEqual([no('No')]);
    vi.advanceTimersByTime(T);
    expect(ring.now).toBe('No');
    expect(seen).toEqual(['No']);
  });

  it('勾完 → Happy，到了停 HOLD_MS 再直接回 Idle', () => {
    const { ring, seen, start } = rig();
    start('Upset');
    ring.cue('done');
    vi.advanceTimersByTime(T);
    expect(ring.now).toBe('Happy');
    vi.advanceTimersByTime(MOOD_HOLD_MS - 1);
    expect(ring.now).toBe('Happy');
    vi.advanceTimersByTime(1 + T);
    expect(ring.now).toBe('Idle');
    expect(seen).toEqual(['Happy', 'Idle']);
  });

  it('新增没配表情：不动', () => {
    const { ring, sets, start } = rig();
    start('Idle');
    ring.cue('add');
    expect(sets).toEqual([]);
  });

  it('醒着来提醒 → Mail 一次到；处理完（稍后、完成、关掉）直达回 Idle，不经过 Upset', () => {
    const { ring, sets, seen, start } = rig();
    start('Wink');
    ring.flag('mail', true);
    vi.advanceTimersByTime(T);
    expect(seen).toEqual(['Mail']);
    ring.flag('mail', false);
    expect(ring.goal).toBe('Idle');
    vi.advanceTimersByTime(T * 6);
    expect(seen).toEqual(['Mail', 'Idle']);
    expect(sets).toEqual([no('Mail'), no('Idle')]);
  });

  it('随机换到别的表情以后来提醒：处理完也回 Idle，不回提醒前那个', () => {
    const { ring, seen, start } = rig({ random: () => 0.99 });
    start('Idle');
    vi.advanceTimersByTime(MOOD_RANDOM_MS[1] + T);
    expect(ring.now).not.toBe('Idle');
    ring.flag('mail', true);
    vi.advanceTimersByTime(T);
    ring.flag('mail', false);
    vi.advanceTimersByTime(T);
    expect(seen.slice(-2)).toEqual(['Mail', 'Idle']);
  });

  it('睡着时来提醒：Sleep → Mail，提醒解除回 Sleep；睡着时勾完的不补播，醒了直接回 Idle', () => {
    const { ring, seen, start } = rig();
    start('Idle');
    ring.flag('sleep', true);
    vi.advanceTimersByTime(T);
    ring.flag('mail', true);
    ring.cue('done');
    expect(ring.goal).toBe('Mail');
    vi.advanceTimersByTime(T);
    ring.flag('mail', false);
    vi.advanceTimersByTime(T);
    ring.flag('sleep', false);
    vi.advanceTimersByTime(T * 2 + MOOD_HOLD_MS + T);
    expect(seen).toEqual(['Sleep', 'Mail', 'Sleep', 'Idle']);
  });

  it('提醒一直在响时来的事件：MOOD_EVENT_TTL_MS 内没轮到就丢掉，提醒解除后回 Idle、不补播', () => {
    const { ring, seen, start } = rig();
    start('Idle');
    ring.flag('mail', true);
    ring.cue('del');
    expect(ring.goal).toBe('Mail');
    vi.advanceTimersByTime(MOOD_EVENT_TTL_MS + 1);
    ring.flag('mail', false);
    vi.advanceTimersByTime(T * 2);
    expect(seen).toEqual(['Mail', 'Idle']);
  });

  it('提醒响着时来的事件，过期前提醒解除：照样演', () => {
    const { ring, seen, start } = rig();
    start('Idle');
    ring.flag('mail', true);
    ring.cue('done');
    vi.advanceTimersByTime(T);
    ring.flag('mail', false);
    vi.advanceTimersByTime(T);
    expect(seen).toEqual(['Mail', 'Happy']);
  });

  it('久不操作 → Sleep 一次到；醒了回 Idle', () => {
    const { ring, seen, start } = rig();
    start('Wink');
    ring.flag('sleep', true);
    vi.advanceTimersByTime(T);
    ring.flag('sleep', false);
    vi.advanceTimersByTime(T);
    expect(seen).toEqual(['Sleep', 'Idle']);
  });

  it('空闲时到点随机换一个（不是当前这个、前后 2 个以内）；有持续状态时不随机', () => {
    const { ring, start } = rig({ random: () => 0 });
    start('Idle');
    vi.advanceTimersByTime(MOOD_RANDOM_MS[0]);
    expect(ring.goal).toBe('Happy');
    vi.advanceTimersByTime(T);
    expect(ring.now).toBe('Happy');
    ring.flag('sleep', true);
    vi.advanceTimersByTime(MOOD_RANDOM_MS[1] * 2);
    expect(ring.goal).toBe('Sleep');
  });

  it('空闲随机和事件同一刻到（随机的计时先触发）：最后是事件表情，停满 HOLD_MS 才回 Idle，中间不被随机换走', () => {
    const { ring, sets, seen, start } = rig({ random: () => 0 });
    start('Idle');
    // 随机的计时在 MOOD_RANDOM_MS[0] 到点；删除事件在同一毫秒到（排在随机后面执行）
    setTimeout(() => ring.cue('del'), MOOD_RANDOM_MS[0]);
    vi.advanceTimersByTime(MOOD_RANDOM_MS[0]);
    expect(sets).toEqual([no('Happy'), no('No')]);
    expect(ring.goal).toBe('No');
    vi.advanceTimersByTime(T);
    expect(ring.now).toBe('No');
    vi.advanceTimersByTime(MOOD_HOLD_MS - 1);
    expect(ring.goal).toBe('No');
    // 开头那个 Idle 是 start 时回报的；随机设的 Happy 还没回报就被 No 盖掉，从没到过
    expect(seen).toEqual(['Idle', 'No']);
    vi.advanceTimersByTime(1 + T);
    expect(seen).toEqual(['Idle', 'No', 'Idle']);
  });

  it('事件先到、表情还在路上时随机到点：不换走事件表情（随机让着事件）', () => {
    // 假状态机这次转得慢：设了输入 9 秒才回报到了，随机（8 秒）在这中间到点
    const slow = MOOD_RANDOM_MS[0] + 1000;
    const { ring, sets, seen, start } = rig({ random: () => 0, t: slow });
    start('Idle');
    ring.cue('del');
    vi.advanceTimersByTime(MOOD_RANDOM_MS[0]);
    expect(sets).toEqual([no('No')]);
    expect(ring.goal).toBe('No');
    vi.advanceTimersByTime(slow - MOOD_RANDOM_MS[0]);
    expect(seen).toEqual(['No']);
    vi.advanceTimersByTime(MOOD_HOLD_MS);
    expect(sets).toEqual([no('No'), no('Idle')]);
  });

  it('舞台暂停（active false）时不排随机，恢复再排', () => {
    const { ring, sets, start } = rig({ random: () => 0 });
    start('Idle');
    ring.active(false);
    vi.advanceTimersByTime(MOOD_RANDOM_MS[1] * 4);
    expect(sets).toEqual([]);
    ring.active(true);
    vi.advanceTimersByTime(MOOD_RANDOM_MS[0]);
    expect(sets).toEqual([no('Happy')]);
  });

  it('空闲随机 1000 次：每次只换到前后 1～2 个，从不设成 Mail、Sleep', () => {
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const { ring, sets, seen, start } = rig({ random });
    start('Idle');
    const goals: string[] = [];
    let last = ring.goal;
    for (let k = 0; goals.length < 1000 && k < 100_000; k++) {
      const from = ring.now!;
      vi.advanceTimersByTime(500);
      if (ring.goal !== last) {
        last = ring.goal;
        goals.push(last);
        const d = Math.abs(RING.indexOf(last) - RING.indexOf(from));
        expect(d >= 1 && d <= MOOD_RANDOM_REACH, `${from} → ${last}`).toBe(true);
      }
    }
    expect(goals).toHaveLength(1000);
    expect(new Set(goals)).toEqual(new Set(DEF.random));
    expect(sets.filter((n) => n === no('Mail') || n === no('Sleep'))).toEqual([]);
    expect(seen.filter((s) => s === 'Mail' || s === 'Sleep')).toEqual([]);
  });

  it('kick（载入好了、接回舞台）：把要的表情再设一次', () => {
    const { ring, sets, start } = rig();
    start('Idle');
    ring.cue('del');
    ring.kick();
    expect(sets).toEqual([no('No'), no('No')]);
  });

  it('配置里写错的名字直接抛错，不悄悄忽略', () => {
    expect(() => rig({ def: { ...DEF, rest: 'Idel' } })).toThrow(/Idel/);
    expect(() => rig({ def: { ...DEF, on: { ...DEF.on, done: 'Hapy' } } })).toThrow(/Hapy/);
    expect(() => rig({ def: { ...DEF, random: [...DEF.random, 'Sleepy'] } })).toThrow(/Sleepy/);
  });
});
