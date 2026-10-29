// 功能 auth：登录、邀请、告知与同意（登录页是单独的入口 /app/auth/，B1）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
// 登录页不挂在主 App 的路由里（routes 为空）：它是 Vite 的第二个入口 src/auth/index.html，只有那一页的 CSP 放行 Turnstile（15.6 第 4b 条）
import { lazy } from 'react';

export const routes = [] as const;

/** 登录页（src/auth/main.tsx 挂它） */
export const AuthPage = lazy(() => import('./ui/AuthPage.tsx'));
