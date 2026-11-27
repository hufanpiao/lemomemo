// 功能 invite：设置 › 邀请朋友（只有管理员看得到，R-83；架构 5.6 发码 → 服务器函数 invite-admin）
// 对外唯一入口：只导出一个懒加载组件；别的功能只能 import 这个文件
// 没有自己的页面（routes 空），不在 app/features.ts 登记：只有设置页（本身懒加载）引这个文件，这里的东西都不进首屏
import { lazy } from 'react';

export const routes = [] as const;

/** “邀请朋友”二级页正文：备注、生成邀请码、刚生成的码（复制）、发过的还没过期的码 */
export const InviteSettings = lazy(() => import('./ui/InviteSettings.tsx'));
