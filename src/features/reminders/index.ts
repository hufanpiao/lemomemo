// 功能 reminders：提醒数据、提醒横幅、整页提醒、错过的提醒、设置 › 提醒与通知（B2 FA-4）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
// 别的功能、App 怎么接这些组件见 B2 FA-4 交付说明的接线清单
import { lazy } from 'react';

// 整页提醒 #/remind/<kind>/<id>?due=<dueAt>：router.ts 的 ROUTE_NAMES 加 'remind' 以后，这里改成
//   export const routes = [{ name: 'remind', Page: lazy(() => import('./ui/FullReminderPage.tsx')) }] as const;
export const routes = [] as const;

/** 整页提醒页面（路由接上前先单独导出；接上后挂在 routes 里） */
export const FullReminderPage = lazy(() => import('./ui/FullReminderPage.tsx'));
/** 提醒横幅、按钮条、“15:25 再提醒你”，并跑提醒引擎：App 上挂一份；props: { route?: 当前路由名 }（'today' 不画顶部横幅，'remind' 都不画） */
export const RemindHost = lazy(() => import('./ui/RemindHost.tsx'));
/** 今天页顶部“错过 N 条提醒 ›”和底部弹层；没有错过的不画 */
export const MissedReminders = lazy(() => import('./ui/MissedReminders.tsx'));
/** 设置 › 提醒与通知 二级页正文；props: { onOpenUpcoming?() }（顶栏和返回由设置页画） */
export const RemindSettings = lazy(() => import('./ui/RemindSettings.tsx'));
/** 设置首页“提醒与通知”一行；props: { onOpen() } */
export const RemindSettingsEntry = lazy(() => import('./ui/RemindSettingsEntry.tsx'));
/** 设置 › 提醒 › 未来 7 天的提醒（正文） */
export const RemindUpcoming = lazy(() => import('./ui/RemindUpcoming.tsx'));
/** “未同步，提醒可能不响”一行（有带提醒、没同步上的记录才出） */
export const UnsyncedRemindHint = lazy(() => import('./ui/UnsyncedRemind.tsx'));
/** 列表行尾的“未同步”小标记；props: { table: 'events' | 'todos', id } */
export const UnsyncedRemindMark = lazy(() => import('./ui/UnsyncedRemindMark.tsx'));
/** 设置 › 关于 的“手机时间不准”（K8-clock）；偏差正常时不画 */
export const ClockWrongNote = lazy(() => import('./ui/ClockWrongNote.tsx'));
