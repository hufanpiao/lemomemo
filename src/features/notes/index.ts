// 功能 notes：随手记、插图、分类（notes、note_images、categories）
// 对外唯一入口：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

export const routes = [
  // preload：冷启动首屏画完后 App 在后台先下载真页面 NotesPage（外壳 NotesRoot 很小；app/features.ts 的 preloadPages）
  { name: 'notes', Page: lazy(() => import('./ui/NotesRoot.tsx')), preload: () => import('./ui/NotesPage.tsx') },
  // 随手记编辑器：#/note/<id>、#/note/new（不在底栏页签里，不显示底栏）
  // 两条路由都只指向很小的外壳 NotesRoot.tsx（守首屏额度，见那个文件），NotesPage.tsx 按路由名分给列表或编辑器
  { name: 'note', Page: lazy(() => import('./ui/NotesRoot.tsx')) },
] as const;

/** 查找面板“最相关”里一张插图的缩略图（ui/note-thumb.tsx）。props: { noteId; imageId } */
export const NoteThumb = lazy(() => import('./ui/note-thumb.tsx'));

/** 随手记的整套界面（列表、编辑器、电脑分栏、插图、看图页），数据来源由调用方给（隐私记页用它）。
 *  props: { source: NoteSource; editing: boolean（画编辑器还是列表）; head?: 列表页顶上替换大标题的一块; cat?: 外面管的分类筛选 } */
export const NotesSurface = lazy(() => import('./ui/NotesSurface.tsx'));

export type {
  ImageSrc, ImgNotice, InsertResult, NoteAttachmentsProps, NoteImage, NoteImagesApi, NoteRows, NoteSource, NoteSourceText, NoteSync, PendingImage,
} from './hooks/note-source.ts';
export type { CategoryCtl } from './ui/NotesSurface.tsx';
