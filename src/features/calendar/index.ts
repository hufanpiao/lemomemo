// 功能 calendar：日程、月历和周视图（events）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

export const routes = [{ name: 'calendar', Page: lazy(() => import('./ui/CalendarPage.tsx')) }] as const;
