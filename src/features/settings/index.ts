// 功能 settings：设置页框架（各功能的分区由各自 index.ts 提供）
// 对外唯一入口：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

// preload：冷启动首屏画完后 App 在后台先下载（不然第一次进设置页会白屏；app/features.ts 的 preloadPages）
export const routes = [{ name: 'settings', Page: lazy(() => import('./ui/SettingsPage.tsx')), preload: () => import('./ui/SettingsPage.tsx') }] as const;
