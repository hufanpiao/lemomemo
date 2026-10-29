// 功能登记表（架构 2.1、2.2）：每个功能一行，只 import 它的 index.ts
// 路由、设置页分区、今天页卡片、“＋”结果行渲染器都从这里汇总；加功能加一行，删功能删一行
// 是否挂上由功能开关决定（featureOn，0.27 第 4 点）：main.tsx 渲染前按 coldStart() 返回的 flags 调 mountFeatures()；
// flags 为 null（本机还没缓存 config）时全挂
import type { ComponentType, LazyExoticComponent } from 'react';
import * as anniv from '../features/anniv/index.ts';
import * as attachments from '../features/attachments/index.ts';
import * as calendar from '../features/calendar/index.ts';
import * as notes from '../features/notes/index.ts';
import * as onboarding from '../features/onboarding/index.ts';
import * as plus from '../features/plus/index.ts';
import * as reminders from '../features/reminders/index.ts';
import * as settings from '../features/settings/index.ts';
import * as smartSearch from '../features/smart-search/index.ts';
import * as today from '../features/today/index.ts';
import * as todos from '../features/todos/index.ts';
import * as vault from '../features/vault/index.ts';
import type { RouteName } from './router.ts';

// 功能 auth 不在这里登记（K4 安全审查 7）：登录页是单独的入口 /app/auth/（src/auth/main.tsx），
// 主 App 的依赖图里不能出现它的任何运行时代码（AuthPage 块、Turnstile、supabase 的登录调用）

export interface FeatureRoute {
  name: RouteName;
  Page: LazyExoticComponent<ComponentType>;
}

interface FeatureEntry {
  routes: readonly FeatureRoute[];
  /** 归哪个功能开关管（app_config.features 的键，0.27 第 2、4 点）；不填 = 不受开关管（今天、设置、＋、隐私记等） */
  flag?: string;
}

// 附件跟着随手记开关（recordKinds 里 image、file 的 flag 都是 note）
const all: readonly FeatureEntry[] = [
  today,
  { routes: calendar.routes, flag: 'event' },
  { routes: todos.routes, flag: 'todo' },
  { routes: notes.routes, flag: 'note' },
  { routes: attachments.routes, flag: 'note' },
  smartSearch,
  plus,
  vault,
  { routes: anniv.routes, flag: 'anniv' },
  reminders,
  settings,
  onboarding,
];

/** 按开关挑出要挂的路由；flags 为 null 时全挂 */
export function routesFor(flags: ReadonlySet<string> | null): readonly FeatureRoute[] {
  return all.filter((f) => f.flag === undefined || flags === null || flags.has(f.flag)).flatMap((f) => f.routes);
}

/** 开关关着、没挂上的路由名（App.tsx 对这些显示“此功能未开启”，不显示出错页，K6 审查 L11） */
export function offRoutesFor(flags: ReadonlySet<string> | null): ReadonlySet<RouteName> {
  return new Set(all.filter((f) => f.flag !== undefined && flags !== null && !flags.has(f.flag)).flatMap((f) => f.routes.map((r) => r.name)));
}

/** 当前挂上的路由（App.tsx 读它）；mountFeatures 之前是全挂 */
export let featureRoutes: readonly FeatureRoute[] = routesFor(null);
/** 当前因开关关着没挂的路由名 */
export let offRoutes: ReadonlySet<RouteName> = new Set();

/** 渲染前调一次（离线也按上次缓存的 config、profile 挂，TC-B1-50）；联网刷新开关以后重新载入时再算 */
export function mountFeatures(flags: ReadonlySet<string> | null): void {
  featureRoutes = routesFor(flags);
  offRoutes = offRoutesFor(flags);
}
