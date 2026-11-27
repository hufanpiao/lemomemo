// push-dispatch：round.ts 拆分后的转发名单（b13882b 复审 L2）。外部一律从 round.ts 导入，
// 这里钉住 round.ts 转出的值和 round-types.ts、round-util.ts 里的是同一个；类型名由 tsc 兜底。
import { describe, expect, it } from 'vitest';
import * as R from '../../supabase/functions/push-dispatch/round.ts';
import * as T from '../../supabase/functions/push-dispatch/round-types.ts';
import * as U from '../../supabase/functions/push-dispatch/round-util.ts';

const UTIL = ['dueAtOf', 'filterUsable', 'isDue', 'isHandledAfterPush', 'parseDnd', 'pool', 'renderText', 'showTitleOf'] as const;

describe('round.ts 转发导出', () => {
  it('round-types.ts 的值导出全部原样转出', () => {
    const names = Object.keys(T);
    expect(names).toEqual(expect.arrayContaining(['TABLES', 'kindOf', 'MIN_MS', 'SNOOZE_MIN', 'AHEAD_MS', 'BEHIND_MS', 'LOG_SRC', 'SETTING_KEYS']));
    for (const n of names) expect(R[n as keyof typeof R], n).toBe(T[n as keyof typeof T]);
  });

  it('round-util.ts 点名转出的 8 个函数一个不少', () => {
    for (const n of UTIL) {
      expect(typeof U[n], n).toBe('function');
      expect(R[n], n).toBe(U[n]);
    }
  });

  it('runRound 留在 round.ts', () => {
    expect(typeof R.runRound).toBe('function');
  });
});
