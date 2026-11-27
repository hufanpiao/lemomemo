// 功能 mascot：今天页吉祥物、输入框小人、设置里的更换和署名、网页版 AI 栏标题前的小号吉祥物（MascotMini，放光球）
// 对外唯一入口：只放懒加载，Rive 运行库、wasm、.riv 都在显示时才下载，不进首屏
import { lazy } from 'react';

export const routes = [] as const;
/** 今天页吉祥物那一块（default 是组件，没有 props）。不给 lazy：plus 的 TypeBarPreload 下好直接画，避开 Suspense 的 300ms 显示节流 */
export const loadMascotHost = () => import('./ui/MascotHost.tsx');
export const MascotPeek = lazy(() => import('./ui/MascotPeek.tsx'));
export const MascotSettings = lazy(() => import('./ui/MascotSettings.tsx'));
export const MascotCredits = lazy(() => import('./ui/MascotCredits.tsx'));
export const MascotMini = lazy(() => import('./ui/MascotMini.tsx'));
