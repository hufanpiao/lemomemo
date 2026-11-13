// 功能 calendar：日程、月历和周视图（events）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

export const routes = [
  { name: 'calendar', Page: lazy(() => import('./ui/CalendarPage.tsx')) },
  // 月历、周视图（B2 FA-3）：#/cal/month/<年-月>、#/cal/week/<日期>，和 #/calendar 同一个页面。
  // samePageAs：App 挂 'calendar' 那条的组件、错误边界用同一个 key，两者互相跳时不重新挂载、焦点不丢（代码审查 M7）；
  // 这里的 Page 只是占位，不会被渲染（A27 不许 index.ts 导出变量引用，所以不能两条共用一个 lazy 变量）
  { name: 'cal', Page: lazy(() => import('./ui/CalendarPage.tsx')), samePageAs: 'calendar' },
  // 日程编辑页（B2 FA-2）：#/event/<id>、#/event/new
  { name: 'event', Page: lazy(() => import('./ui/EventEditPage.tsx')) },
] as const;

/** 设置 › 日历（B2 FA-3 第二段；R-320 二级页 #/settings/calendar）：节假日三选一、每周第一天；设置页懒加载它（顶栏和返回由设置页画） */
export const CalendarSettings = lazy(() => import('./ui/CalendarSettings.tsx'));
/** 设置首页“日历”一行右边的值（R-320、SETTINGS-merge-cards M4）：只给值的文字，整行和点进二级页由设置页画；没有 props */
export const CalendarSettingsValue = lazy(() => import('./ui/CalendarSettingsValue.tsx'));
/** 电脑今天页的详情抽屉里的日程编辑器（B6 返工）：props 是 id、onCreated、onClose；在日程编辑页那一包里 */
export const EventDrawerEditor = lazy(() => import('./ui/event-drawer.ts'));
