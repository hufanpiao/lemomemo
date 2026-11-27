// 功能 onboarding：首次引导、告知与同意、添加到主屏幕教程
// 对外唯一入口：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
// • routes：#/onboarding 是告知与同意页（ui/ConsentRoute.tsx）
// • ConsentGate：启动时的告知页关口，main.tsx 在线时套在 App 外面（见 ui/ConsentGate.tsx）
import { lazy } from 'react';

export const routes = [{ name: 'onboarding', Page: lazy(() => import('./ui/ConsentRoute.tsx')) }] as const;

export const ConsentGate = lazy(() => import('./ui/ConsentGate.tsx'));
