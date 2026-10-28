// 功能 anniv：纪念日、头像
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

export const routes = [{ name: 'anniv', Page: lazy(() => import('./ui/AnnivPage.tsx')) }] as const;
