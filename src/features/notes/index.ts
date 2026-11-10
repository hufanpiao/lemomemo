// 功能 notes：随手记、插图、分类（notes、note_images、categories）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

export const routes = [
  { name: 'notes', Page: lazy(() => import('./ui/NotesRoot.tsx')) },
  // 随手记编辑器（B4 S2）：#/note/<id>、#/note/new（不在底栏页签里，不显示底栏）
  // 两条路由都只指向很小的外壳 NotesRoot.tsx（B4 首屏额度，见那个文件），NotesPage.tsx 按路由名分给列表或编辑器
  { name: 'note', Page: lazy(() => import('./ui/NotesRoot.tsx')) },
] as const;
