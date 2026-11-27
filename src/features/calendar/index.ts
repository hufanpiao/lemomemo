// 功能 calendar：日程、月历和周视图（events）
// 对外唯一入口：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

export const routes = [
  // preload：冷启动首屏画完后 App 在后台先下载（app/features.ts 的 preloadPages）
  { name: 'calendar', Page: lazy(() => import('./ui/CalendarPage.tsx')), preload: () => import('./ui/CalendarPage.tsx') },
  // 月历、周视图：#/cal/month/<年-月>、#/cal/week/<日期>，和 #/calendar 同一个页面。
  // samePageAs：App 挂 'calendar' 那条的组件、错误边界用同一个 key，两者互相跳时不重新挂载、焦点不丢；
  // 这里的 Page 只是占位，不会被渲染（不许 index.ts 导出变量引用，所以不能两条共用一个 lazy 变量）
  { name: 'cal', Page: lazy(() => import('./ui/CalendarPage.tsx')), samePageAs: 'calendar' },
  // 日程编辑页：#/event/<id>、#/event/new
  // warm：“＋”打开打字条时先下载（“展开编辑”要进的新建页，免得第一次展开卡一下；app/features.ts 的 warmRoute）
  // 编辑页也在冷启动后后台先下载（同待办编辑页，从日历点开一条日程不用等这一包）
  { name: 'event', Page: lazy(() => import('./ui/EventEditPage.tsx')), preload: () => import('./ui/EventEditPage.tsx'), warm: () => import('./ui/EventEditPage.tsx') },
] as const;

/** 设置 › 日历（二级页 #/settings/calendar）：节假日三选一、每周第一天；设置页懒加载它（顶栏和返回由设置页画） */
export const CalendarSettings = lazy(() => import('./ui/CalendarSettings.tsx'));
/** 设置首页“日历”一行右边的值：只给值的文字，整行和点进二级页由设置页画；没有 props */
export const CalendarSettingsValue = lazy(() => import('./ui/CalendarSettingsValue.tsx'));
/** 电脑今天页的详情抽屉里的日程编辑器：props 是 id、onCreated（在不在抽屉里由 kit EditShell 的 useInDrawer 看）；在日程编辑页那一包里 */
export const EventDrawerEditor = lazy(() => import('./ui/event-drawer.ts'));
/** 今天页没日程时组合区的“今日小运”小方块：和日历日清单的今日运势卡同一个生日、算法、详情弹层（ui/FortuneTile.tsx）；
 *  props 是 today、className（外框由今天页给）；跟着今天页按需下载的组合区一起下，不进首屏 */
export const FortuneTile = lazy(() => import('./ui/FortuneTile.tsx'));
