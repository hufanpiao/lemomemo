// 功能 anniv：纪念日、头像
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

/** 页面和设置那一行都经 ui/AnnivRoot.tsx 这个小外壳再懒加载（依赖表不进首屏） */
// samePageAs 写自己：#/anniv ↔ #/anniv/<id> 是同一页（列表和盖在上面的编辑层），浏览器前进后退时不起整页过渡（router-levels 的 pushInPage）
export const routes = [{ name: 'anniv', Page: lazy(() => import('./ui/AnnivRoot.tsx')), samePageAs: 'anniv' }] as const;
/** 设置 › 提醒与通知 里“纪念日提醒”一行（B5 S16，reminders 的 RemindSettings 挂 <AnnivDefaults part="remind-defaults" />）：和路由同一个外壳 */
export const AnnivDefaults = lazy(() => import('./ui/AnnivRoot.tsx'));
/** 纪念日头像（取图 + 画圆；今天页的纪念日一行用，没加载好时先画首字圆） */
export const AnnivFace = lazy(() => import('./ui/AnnivFace.tsx'));
