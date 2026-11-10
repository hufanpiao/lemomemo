// 随手记两条路由（#/notes 列表、#/note/<id> 编辑器）共用的外壳（B4 首屏额度）：index.ts 的两条路由都只懒加载这个很小的分包，
// 首屏入口里每条路由只带它的一两个依赖；真正的页面（NotesPage.tsx 和它二十多个依赖分包）在这里再懒加载一次，
// 依赖表写在这个分包里、不进首屏。代价是第一次打开随手记多等一次分包（有 SW 缓存后基本感觉不到）；没到之前由 App 外层的 Suspense 接着
import { lazy } from 'react';

const Page = lazy(() => import('./NotesPage.tsx'));

export default function NotesRoot() {
  return <Page />;
}
