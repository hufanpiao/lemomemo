// 功能登记表（架构 2.1、2.2）：每个功能一行，只 import 它的 index.ts
// 路由、设置页分区、今天页卡片、“＋”结果行渲染器都从这里汇总；加功能加一行，删功能删一行
// 是否挂上由功能开关决定（featureOn，0.27 第 4 点）；B1 有了本机缓存的 config 以后接上，B0 全部挂
import type { ComponentType, LazyExoticComponent } from 'react';
import * as anniv from '../features/anniv/index.ts';
import * as attachments from '../features/attachments/index.ts';
import * as auth from '../features/auth/index.ts';
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

export interface FeatureRoute {
  name: RouteName;
  Page: LazyExoticComponent<ComponentType>;
}

const all: readonly { routes: readonly FeatureRoute[] }[] = [
  today,
  calendar,
  todos,
  notes,
  attachments,
  smartSearch,
  plus,
  vault,
  anniv,
  reminders,
  settings,
  auth,
  onboarding,
];

/** 所有功能登记的路由 */
export const featureRoutes: readonly FeatureRoute[] = all.flatMap((f) => f.routes);
