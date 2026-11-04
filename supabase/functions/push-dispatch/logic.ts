// push-dispatch 的共享 logic 接线（代码审查《全天日程提醒-服务器》L1，11-04）：把 shared 的函数接到 round-types.ts 的 RoundLogic 上。
// 分支（全天日程传 defaultTime、开始时刻用 startAtOf、待办和日程分开算）只在这里写一遍；
// index.ts 传 _shared/gen 下的函数，测试（tests/edge/push-dispatch-mem.ts）传 shared/ 下的同名函数，都只列名字、不写业务代码。
// 两边列的名字和来源模块由 tests/edge/push-dispatch-logic-wiring.test.ts 逐个核对。
// 本文件不 import shared 或 _shared/gen（两边路径不同），参数类型照 shared 的签名写成结构类型；行用 never 收（shared 的行类型更窄，由调用方保证）。
import type { Dnd, ItemRow, NotifyInputLike, NotifyTextLike, RoundLogic } from './round-types.ts';

export interface SharedFns {
  todoRemindAt(row: never, tz: string, now: number, prevRemindAt?: number | null): number | null;
  eventRemindAt(row: never, tz?: string, defaultTime?: unknown): number | null;
  allDayTimeOf(defaultTime: unknown): string;
  startAtOf(row: { date: string; time: string | null; tz: string | null }, tz: string, defaultTime?: string): number;
  msAt(date: string, min: number, tz: string): number;
  parseHm(hm: string): number;
  todayOf(ms: number, tz: string): string;
  isValidTz(tz: string): boolean;
  dndDeferUntil(ms: number, tz: string, dnd: Dnd): number | null;
  notifyText(i: NotifyInputLike): NotifyTextLike;
  t(key: never, params: never, locale: 'zh-CN' | 'ko-KR'): string;
}

export function makeLogic(s: SharedFns): RoundLogic {
  return {
    // 和 shared 的 remindAtOf 同一分派：待办 → todoRemindAt（带 prevRemindAt）；日程 → eventRemindAt（全天日程按 tz = current_tz、defaultTime）
    remindAtOf: (kind, row, tz, now, prev, defaultTime) =>
      kind === 'todo' ? s.todoRemindAt(row as never, tz, now, prev) : s.eventRemindAt(row as never, tz, defaultTime),
    isValidTz: s.isValidTz,
    dndDeferUntil: s.dndDeferUntil,
    // 有时刻的按日程自己的 tz（缺 tz 回 null，调用方退回 due_at）；全天日程用 startAtOf：当天的 remind.default_time，按 current_tz（0.29 续第 47、57 条）
    eventStartAt: (row: ItemRow, tz, defaultTime) => typeof row.date !== 'string' ? null
      : row.time === null || row.time === undefined ? s.startAtOf({ date: row.date, time: null, tz: null }, tz, s.allDayTimeOf(defaultTime))
        : typeof row.time === 'string' && typeof row.tz === 'string' ? s.msAt(row.date, s.parseHm(row.time), row.tz) : null,
    dayOf: (ms, tz) => s.todayOf(ms, tz),
    notify: (i) => s.notifyText(i),
    t: (key, params, locale) => s.t(key as never, params as never, locale === 'ko-KR' ? 'ko-KR' : 'zh-CN'),
    // B5 填实现（logic/anniv 的 nextDate + 提醒偏移）；现在回 null：第 0 步不改纪念日、第 6 步推过以后不写下一次
    annivNext: () => null,
  };
}
