// 整页提醒的地址、hash 和通知 tag（架构 5.3“提醒地址只留一份”，0.53）
// 只写在这一份：SW（src/sw/push.ts，A19 只准引 shared）和页面（src/platform/native-bridge.ts）都从这里引。
// 不 import 任何文件（不能把日期代码带进 SW 包；所以不放进 shared/logic/remind.ts）。纯字符串拼法，不碰 DOM（A2）
// 拼出来的地址必须匹配 ^/app/#/remind/(event|todo|anniv)/<uuid>\?due=[1-9][0-9]*$（B2 安全审查 FE-3，tests/build/native-bridge-url.test.ts）：
// 调用方传进来的 id 要已经校验过是 UUID、dueAt 是正的安全整数（SW 的 dataOf、页面的整页提醒路由各自校验）

/** 哪一类提醒（和推送负载的 kind 同一组值） */
export type ReminderKind = 'event' | 'todo' | 'anniv';

/** 整页提醒在 /app/ 里的 hash（不带 /app/）："#/remind/<kind>/<id>?due=<dueAt>" */
export function reminderHash(kind: ReminderKind, id: string, dueAt: number): string {
  return `#/remind/${kind}/${id}?due=${dueAt}`;
}

/** 整页提醒的完整路径："/app/#/remind/<kind>/<id>?due=<dueAt>" */
export function reminderUrl(kind: ReminderKind, id: string, dueAt: number): string {
  return `/app/${reminderHash(kind, id, dueAt)}`;
}

/** 通知的 tag（Web Push 和 exe 本机通知同一规则，5.3 第 4 步）："<kind>:<id>:<dueAt>" */
export function reminderTag(kind: ReminderKind, id: string, dueAt: number): string {
  return `${kind}:${id}:${dueAt}`;
}

/** occurrenceKey 要的几项（前端 reminder-model 的 Reminder、服务器 push-dispatch 的一行都按这个结构传；row 只读 date、time、remind_days） */
export interface OccurrenceRef {
  readonly kind: ReminderKind;
  readonly id: string;
  /** 这一次的 reminderTag（kind:id:dueAt，dueAt 是没按本机免打扰推迟的 due_at） */
  readonly tag: string;
  /** 这一次是按了“稍后”的那一次（snooze_at 等于 due_at、且不等于 remind_at） */
  readonly snoozed: boolean;
  readonly row: Readonly<Record<string, unknown>>;
}

/**
 * 是不是“全天日程提醒”：time 不是字符串（null、没有这一列）、date 是字符串、remind_days 是 0 或 1。
 * 和 shared/logic/remind.ts 的 allDayRemindDay 判“是不是全天日程”的条件必须一致（本文件不准 import，所以各写一份；
 * tests/shared/occurrence-key.test.ts 拿边界值逐个核对两边）
 */
export function isAllDayRemind(row: Readonly<Record<string, unknown>>): boolean {
  const d = row['remind_days'];
  return typeof row['time'] !== 'string' && typeof row['date'] === 'string' && (d === 0 || d === 1);
}

/**
 * “同一次提醒”的标识（R-336：只对全天日程起作用）：全天日程（没按稍后）是 event:<id>:allday:<日期>:<remind_days>——
 * 改默认时刻是同一次；日期变了、当天 / 前一天换了，是另一次（B2 前端增量审查 M1：11-05 当天提醒和 11-06 前一天提醒虽然都落在 11-05，也是两次）；
 * 其余（有时刻的日程、待办、按了稍后的、纪念日）就是 tag。纪念日的 occurrenceKey 等 B5 再定（现在照 reminderTag）。
 * 本机通知（local-notify 的 shownKey）、横幅、错过的提醒，和推送负载的 occurrenceKey（push-dispatch）都用这一份
 */
export function occurrenceKey(r: OccurrenceRef): string {
  if (r.kind !== 'event' || r.snoozed || !isAllDayRemind(r.row)) return r.tag;
  return `event:${r.id}:allday:${String(r.row['date'])}:${String(r.row['remind_days'])}`;
}
