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
  reminderTag(kind: 'event' | 'todo' | 'anniv', id: string, dueAt: number): string;
  occurrenceKey(r: { kind: 'event' | 'todo' | 'anniv'; id: string; tag: string; snoozed: boolean; row: Readonly<Record<string, unknown>> }): string;
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
    // tag = reminderTag(kind, id, due_at)。snoozed：推送时和前端 reminder-model 的 reminderOf 同一口径（snooze_at 等于 due_at 且不等于 remind_at）；
    // 撤回时（due = pushed_for）按当初推的那一次判断：既不是 remind_at、也不是 defer_until，就是稍后那一次（代码审查 M1、L1，见 round-types.ts）。
    // 纪念日的 occurrenceKey 等 B5 再定（现在 shared 照 tag）
    occurrenceKey: (kind, row, due, at) => s.occurrenceKey({
      kind, id: row.id, tag: s.reminderTag(kind, row.id, due),
      snoozed: at === 'resolve' ? due !== row.remind_at && due !== row.defer_until
        : row.snooze_at !== null && row.snooze_at === due && due !== row.remind_at,
      row: row as unknown as Readonly<Record<string, unknown>>,
    }),
  };
}
