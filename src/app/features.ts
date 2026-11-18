// 功能登记表（架构 2.1、2.2）：每个功能一行，只 import 它的 index.ts
// 路由、设置页分区、今天页卡片、“＋”结果行渲染器都从这里汇总；加功能加一行，删功能删一行
// 是否挂上由功能开关决定（featureOn，0.27 第 4 点）：main.tsx 渲染前按 coldStart() 返回的 flags 调 mountFeatures()；
// flags 为 null（本机还没缓存 config）时全挂
import type { ComponentType, LazyExoticComponent } from 'react';
import * as anniv from '../features/anniv/index.ts';
import * as calendar from '../features/calendar/index.ts';
import * as notes from '../features/notes/index.ts';
import * as onboarding from '../features/onboarding/index.ts';
import * as plus from '../features/plus/index.ts';
import * as reminders from '../features/reminders/index.ts';
import * as settings from '../features/settings/index.ts';
import * as today from '../features/today/index.ts';
import * as todos from '../features/todos/index.ts';
import * as vault from '../features/vault/index.ts';
import type { RouteName } from './router.ts';

// 功能 attachments 也不在这里登记（B4b-1）：没有页面（routes 空），只挂在随手记编辑器里；登记了会把它的懒加载表拉进首屏
// 功能 smart-search 同理（B4b-2）：没有页面，查找面板和 Ctrl+K 挂在 plus 首屏画完才下载的那一块（TypeBarPreload）里
// 功能 auth 不在这里登记（K4 安全审查 7）：登录页是单独的入口 /app/auth/（src/auth/main.tsx），
// 主 App 的依赖图里不能出现它的任何运行时代码（AuthPage 块、Turnstile、supabase 的登录调用）

export interface FeatureRoute {
  name: RouteName;
  Page: LazyExoticComponent<ComponentType>;
  /** 和另一条路由是同一个页面（如 'cal' → 'calendar'）：App 挂那一条的 Page、错误边界用那一条的名字做 key，互相跳不重新挂载 */
  samePageAs?: RouteName;
  /** 冷启动首屏画完后在后台先下载这一页（日历、待办、随手记三个页签页，负责人 11-18“冷启动后马上后台自动加载这3个页面…减少等待”；设置页，负责人 11-18“把设置页也一起缓存一下”） */
  preload?: () => Promise<unknown>;
  /** “＋”打开打字条时先下载这一页（“展开编辑”要进的日程、待办新建页；warmRoute） */
  warm?: () => Promise<unknown>;
}

interface FeatureEntry {
  routes: readonly FeatureRoute[];
  /** 归哪个功能开关管（app_config.features 的键，0.27 第 2、4 点）；不填 = 不受开关管（今天、设置、＋、隐私记等） */
  flag?: string;
}

const all: readonly FeatureEntry[] = [
  today,
  { routes: calendar.routes, flag: 'event' },
  { routes: todos.routes, flag: 'todo' },
  { routes: notes.routes, flag: 'note' },
  plus,
  // 只取路由：VaultParts（给随手记、设置用的懒加载块）不经这里进首屏的登记表
  { routes: vault.routes },
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

/**
 * 后台先下载挂上的、写了 preload 的页（App 在首屏画完、浏览器空闲以后调一次）：一页一页来，不和别的下载抢；失败不要紧（点进去时照常下载）。
 * 运行日志 preload <页> ms=<用时> ok=1|0
 */
export async function preloadPages(log: (line: string) => void, now: () => number): Promise<void> {
  for (const r of featureRoutes) {
    if (!r.preload) continue;
    const t0 = now();
    const ok = await r.preload().then(() => 1, () => 0);
    log(`preload ${r.name} ms=${Math.round(now() - t0)} ok=${ok}`);
  }
}

/**
 * “＋”打开打字条时先下载“展开编辑”要进的新建页（负责人 11-18 录屏：第一次点“展开编辑”卡约 0.4 秒——新建页分包还没到，
 * 这段时间画面停在打字条和模糊层上，分包到了才开始长成）。已经下载过的当场就好；失败不要紧（展开时照常下载）。
 * 运行日志 warm <页> ms=<用时> ok=1|0
 */
export async function warmRoute(name: RouteName, log: (line: string) => void, now: () => number): Promise<void> {
  const warm = featureRoutes.find((r) => r.name === name)?.warm;
  if (!warm) return;
  const t0 = now();
  const ok = await warm().then(() => 1, () => 0);
  log(`warm ${name} ms=${Math.round(now() - t0)} ok=${ok}`);
}

/** 渲染前调一次（离线也按上次缓存的 config、profile 挂，TC-B1-50）；联网刷新开关以后重新载入时再算 */
export function mountFeatures(flags: ReadonlySet<string> | null): void {
  featureRoutes = routesFor(flags);
  offRoutes = offRoutesFor(flags);
}
