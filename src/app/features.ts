// 功能登记表：每个功能一行，只 import 它的 index.ts；加功能加一行，删功能删一行
// 是否挂上由功能开关决定：main.tsx 渲染前按 coldStart() 返回的 flags 调 mountFeatures()；flags 为 null（还没缓存 config）时全挂
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

// 不在这里登记的：attachments、smart-search 没有页面，登记了会把懒加载表拉进首屏；
// auth 是单独入口 /app/auth/，主 App 的依赖图里不能出现它的任何运行时代码

export interface FeatureRoute {
  name: RouteName;
  Page: LazyExoticComponent<ComponentType>;
  /** 和另一条路由是同一个页面（如 'cal' → 'calendar'）：互相跳不重新挂载 */
  samePageAs?: RouteName;
  /** 冷启动首屏画完后在后台先下载这一页 */
  preload?: () => Promise<unknown>;
  /** “＋”打开打字条时先下载这一页（warmRoute） */
  warm?: () => Promise<unknown>;
}

interface FeatureEntry {
  routes: readonly FeatureRoute[];
  /** 归哪个功能开关管（app_config.features 的键）；不填 = 不受开关管 */
  flag?: string;
}

const all: readonly FeatureEntry[] = [
  today,
  { routes: calendar.routes, flag: 'event' },
  { routes: todos.routes, flag: 'todo' },
  { routes: notes.routes, flag: 'note' },
  plus,
  // 只取路由：VaultParts 不经这里进首屏
  { routes: vault.routes },
  { routes: anniv.routes, flag: 'anniv' },
  reminders,
  settings,
  onboarding,
];

/**
 * 这个功能开关开着吗：不归开关管、flags 为 null 都算开。挂路由、算没挂的路由、main.tsx 的待办自动删除都用这一份
 */
export const flagOn = (flags: ReadonlySet<string> | null, flag: string | undefined): boolean => flag === undefined || flags === null || flags.has(flag);

/** 按开关挑出要挂的路由；flags 为 null 时全挂 */
export function routesFor(flags: ReadonlySet<string> | null): readonly FeatureRoute[] {
  return all.filter((f) => flagOn(flags, f.flag)).flatMap((f) => f.routes);
}

/** 开关关着、没挂上的路由名（App.tsx 对这些显示“此功能未开启”，不显示出错页） */
export function offRoutesFor(flags: ReadonlySet<string> | null): ReadonlySet<RouteName> {
  return new Set(all.filter((f) => !flagOn(flags, f.flag)).flatMap((f) => f.routes.map((r) => r.name)));
}

/** 当前挂上的路由（App.tsx 读它）；mountFeatures 之前是全挂 */
export let featureRoutes: readonly FeatureRoute[] = routesFor(null);
/** 当前因开关关着没挂的路由名 */
export let offRoutes: ReadonlySet<RouteName> = new Set();

/**
 * 后台先下载写了 preload 的页（首屏画完、空闲后调一次）：一页一页来，每页之前 await gap()；失败不要紧（点进去时照常下载）
 */
export async function preloadPages(log: (line: string) => void, now: () => number, gap: () => Promise<void> = () => Promise.resolve()): Promise<void> {
  for (const r of featureRoutes) {
    if (!r.preload) continue;
    // 每页之前让出主线程（连着下载解析会让首屏后头一两秒点不动）：gap 等空闲、手指按着就等抬起
    await gap();
    const t0 = now();
    const ok = await r.preload().then(() => 1, () => 0);
    log(`preload ${r.name} ms=${Math.round(now() - t0)} ok=${ok}`);
  }
}

/**
 * “＋”打开打字条时先下载“展开编辑”要进的新建页（分包没到时第一次展开会卡一下）。失败不要紧（展开时照常下载）
 */
export async function warmRoute(name: RouteName, log: (line: string) => void, now: () => number): Promise<void> {
  const warm = featureRoutes.find((r) => r.name === name)?.warm;
  if (!warm) return;
  const t0 = now();
  const ok = await warm().then(() => 1, () => 0);
  log(`warm ${name} ms=${Math.round(now() - t0)} ok=${ok}`);
}

/** 渲染前调一次（离线也按上次缓存的 config 挂）；刷新开关以后重新载入时再算 */
export function mountFeatures(flags: ReadonlySet<string> | null): void {
  featureRoutes = routesFor(flags);
  offRoutes = offRoutesFor(flags);
}
