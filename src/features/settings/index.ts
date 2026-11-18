// 功能 settings：设置页框架（各功能的分区由各自 index.ts 提供）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

// preload：冷启动首屏画完后 App 在后台先下载（负责人 11-18“后台缓存的时候把设置页也一起缓存一下，第一次进去的时候有白屏”，app/features.ts 的 preloadPages）
export const routes = [{ name: 'settings', Page: lazy(() => import('./ui/SettingsPage.tsx')), preload: () => import('./ui/SettingsPage.tsx') }] as const;
