// 一项 patch 换没换“哪一次提醒”的唯一认法（7h 合并两份：原来 core/outbox-new-item.ts 的 timingChanged、reminders 的 remind-write.ts hasTimingChange 各写一份，
//   都只认日程、待办的列，纪念日改日期认不出来）。用它的：outbox 合并两次没发出的 patch（mergePatch）、提醒“知道了”要不要只在本机了结（timingPending、occurrencePending）
// 算“换了一次”的：
// • date、remind_days 改了（日程、待办：服务器触发器会清 notified_for，客户端补丁里不一定带）；
// • time 写成 null（日程有时刻 → 全天）；
// • 补丁显式写了 notified_for: null：编辑页换了“哪一次”时同一次写入里清掉旧的“知道了”——日程全天 → 有时刻（calendar/data/event-edit.ts 的 patchOf）、
//   纪念日改阴阳历 / 月 / 日 / 闰月 / 年份（anniv/data/anniv-edit.ts 的 patchOf；服务器 remind_reset 不替纪念日清这一列，只能靠客户端带）。
//   “知道了”本身写的是非空的 notified_for，不会被认成换次
// 纯函数，不引任何东西（首屏、按需加载的块都能引）
export function occurrenceChanged(d: Readonly<Record<string, unknown>>): boolean {
  return 'date' in d || 'remind_days' in d || ('time' in d && d['time'] === null) || d['notified_for'] === null;
}
