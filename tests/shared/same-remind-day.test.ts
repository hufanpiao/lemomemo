// R-336 的“同一天”sameRemindDay（shared/logic/remind.ts；REMIND-shown-persist S2，11-05）：
// push-dispatch 第 0 步原来内联写 typeof x === 'number' && dayOf(x, tz) === dayOf(remindAt, tz)，搬进 shared 后前端同一份。
// 这里逐条核对搬家前后一样（旧写法照抄成 legacy 对照），再钉几个边界：跨午夜、按 tz 而不是 UTC、非数字一律不算。
// Node（vitest）和 Deno（deno task test）各跑一遍：只用 toBe、toEqual
import { describe, expect, it } from 'vitest';
import { todayOf } from '../../shared/core/date.ts';
import { sameRemindDay } from '../../shared/logic/remind.ts';

const SEOUL = 'Asia/Seoul';
const LA = 'America/Los_Angeles';
/** 2026-11-05 00:00 Asia/Seoul（= 2026-11-04 15:00 UTC） */
const D0 = Date.UTC(2026, 10, 4, 15, 0, 0);
const H = 3_600_000;

/** 搬家前 round-step0.ts 第 134～135 行的写法 */
const legacy = (x: unknown, remindAt: number, tz: string): boolean => typeof x === 'number' && todayOf(x, tz) === todayOf(remindAt, tz);

describe('sameRemindDay：和第 0 步原来的内联写法一样', () => {
  it('一批时刻 × 两个时区，结果逐条相同', () => {
    const marks: unknown[] = [D0, D0 - 1, D0 + 7 * H, D0 + 24 * H - 1, D0 + 24 * H, D0 - 4 * H, null, undefined, '1793000000000'];
    const remindAts = [D0 + 7 * H, D0 + 20 * H, D0 - 4 * H];
    for (const tz of [SEOUL, LA]) for (const r of remindAts) for (const x of marks) {
      expect(sameRemindDay(x, r, tz)).toBe(legacy(x, r, tz));
    }
  });
});

describe('sameRemindDay：边界', () => {
  it('同一天的 07:00 和 07:20（改了 remind.default_time）算同一天', () => {
    expect(sameRemindDay(D0 + 7 * H, D0 + 7 * H + 20 * 60_000, SEOUL)).toBe(true);
  });
  it('按 tz 的午夜分界：首尔 23:59:59.999 和次日 00:00 不是同一天', () => {
    expect(sameRemindDay(D0 - 1, D0, SEOUL)).toBe(false);
    expect(sameRemindDay(D0, D0 + 24 * H - 1, SEOUL)).toBe(true);
  });
  it('按 tz 而不是 UTC：首尔 00:30、08:00、10:00 同一天，10:00 在 UTC 下已跨日期', () => {
    const a = D0 + 30 * 60_000;      // UTC 11-04 15:30
    const b = D0 + 8 * H;            // UTC 11-04 23:00
    const c = D0 + 10 * H;           // UTC 11-05 01:00
    expect(sameRemindDay(a, b, SEOUL)).toBe(true);
    expect(sameRemindDay(a, c, SEOUL)).toBe(true);
    expect(todayOf(a, 'UTC') === todayOf(c, 'UTC')).toBe(false);
  });
  it('非数字（null、没有、字符串、布尔、对象）一律不算', () => {
    for (const x of [null, undefined, '2026-11-05', true, {}]) expect(sameRemindDay(x, D0, SEOUL)).toBe(false);
  });
});
