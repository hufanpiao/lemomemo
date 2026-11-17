// 功能 today：今天页（汇总各功能 index.ts 给的小卡片）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

export const routes = [
  { name: 'today', Page: lazy(() => import('./ui/TodayPage.tsx')) },
  // “最近删除”（日程、待办；ADR-006）
  { name: 'trash', Page: lazy(() => import('./ui/RecentlyDeletedPage.tsx')) },
] as const;

/** 设置首页“最近删除”一组（R-441）两行右边的条数（ui/TrashCount.tsx，和“最近删除”页同一个数法）；设置页自己画行，值晚到也不挡点 */
export const TrashCount = lazy(() => import('./ui/TrashCount.tsx'));

/** 今天页待办行的左滑删除（ui/TodaySwipe.tsx 包着 kit 的 SwipeRow，R-428）：首屏画完以后才下载（连着 useHDrag、层栈约 5 KB，放进首屏会超 150 KB 预算，
 *  e2e b2-first-screen-budget），经 motion 的 useSwapWhenSafe 等页里没焦点、没按住的指针才换上（换上时行内容重挂，焦点在行里会丢，R-354 同理）；
 *  A27 受控例外，同 loadTodayDesk */
export const loadTodaySwipe = () => import('./ui/TodaySwipe.tsx');

/** 电脑版（有侧栏的宽度）今天页的可拖动面板（5.9b；ui/TodayDesk.tsx，只给 ui/TodayPage.tsx 经 motion 的 useSwapWhenSafe 用）：首屏画完才下载、手机宽度不下载，
 *  按需下载写在功能入口（主包发起，预加载表只列 CSS、JS 按静态 import 一层层下，首屏画完以后才换上，晚一点无妨）；下好了直接用模块里的组件（不经 lazy，换上时不先挂起一拍；A27 受控例外，同 plus 的 loadTypeBar） */
export const loadTodayDesk = () => import('./ui/TodayDesk.tsx');
