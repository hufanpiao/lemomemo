// 纪念日对外的小外壳（B5；照随手记 NotesRoot 的做法，主持人 11-13 首屏额度）：index.ts 的路由和设置里“纪念日提醒”一行都只懒加载这个很小的分包，
// 首屏入口里只带它一两个依赖；真正的页面（AnnivPage 和它几十个依赖分包）、设置那一行（AnnivDefaults）在这里再懒加载，依赖表写在这个分包里、不进首屏。
// 代价是第一次打开多等一次分包（有 SW 缓存后基本感觉不到）；没到之前由外层的 Suspense 接着
import { lazy } from 'react';

const Page = lazy(() => import('./AnnivPage.tsx'));
const Defaults = lazy(() => import('./AnnivDefaults.tsx'));

/** part = 'remind-defaults'：设置 › 提醒与通知 里“纪念日提醒”一行（reminders 的 RemindSettings 挂）；不带是纪念日页 */
export default function AnnivRoot({ part }: { part?: 'remind-defaults' }) {
  return part === 'remind-defaults' ? <Defaults /> : <Page />;
}
