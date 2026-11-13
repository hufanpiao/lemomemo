// 功能 anniv：纪念日、头像
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

export const routes = [{ name: 'anniv', Page: lazy(() => import('./ui/AnnivPage.tsx')) }] as const;
/** 设置 › 提醒与通知 里“纪念日提醒”一行（B5 S16，reminders 的 RemindSettings 挂 <AnnivDefaults part="remind-defaults" />）：
 *  和纪念日页同一个分包、同一个默认导出（页面带 part 就只画这一行），首屏不多一张依赖表 */
export const AnnivDefaults = lazy(() => import('./ui/AnnivPage.tsx'));
/** 纪念日头像（取图 + 画圆；今天页的纪念日一行用，没加载好时先画首字圆） */
export const AnnivFace = lazy(() => import('./ui/AnnivFace.tsx'));
