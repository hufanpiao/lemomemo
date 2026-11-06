// 功能 today：今天页（汇总各功能 index.ts 给的小卡片）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

export const routes = [
  { name: 'today', Page: lazy(() => import('./ui/TodayPage.tsx')) },
  // “最近删除”（日程、待办；ADR-006）
  { name: 'trash', Page: lazy(() => import('./ui/RecentlyDeletedPage.tsx')) },
] as const;

/**
 * 今天页按需下载的只读行部件和页底提示条（ui/TodayToasts.tsx，按 part 画哪一块；只给 ui/TodayPage.tsx 用，不是对外接口）。
 * 懒加载写在这里而不写在 TodayPage：这个文件在主包里，Vite 给 import() 生成的预载文件名单和主包已有的那份共用，
 * 写在 TodayPage 里要在今天页的块里另带一份二十来个带哈希的文件名（首屏预算 150 KB，FA-2 返工 11-06 量过）
 */
export const TodayRo = lazy(() => import('./ui/TodayToasts.tsx'));
