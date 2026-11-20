// 随手记的整套界面，换一个数据来源用（B5 隐私记重写，主持人 11-15 定稿“隐私记页面按照随手记的样子全部重写”）：经 notes/index.ts 懒加载给 vault 功能
// • source：数据来源（hooks/note-source.ts 的 NoteSource；隐私记的在 vault/hooks/vault-note-source.ts），整棵子树经 context 拿
// • editing：画编辑器（路由参数由编辑器按来源的 route.edit 自己读）还是列表；head：列表页顶上替换大标题的那一块（隐私记页的顶栏、提示）
// • cat：外面管的分类筛选（隐私记 #/vault/c/<id>，地址就是筛选）
// • 列表、编辑器、电脑分栏、详情抽屉、插图、看图页、输入行都是随手记那一份，没有隐私记专用的副本
import type { ReactNode } from 'react';
import { NoteSourceProvider, type NoteSource } from '../hooks/note-source.ts';
import NoteEditPage from './NoteEditPage.tsx';
import { NotesList } from './NotesPage.tsx';
import type { CategoryCtl } from '../hooks/useNoteList.ts';

export type { CategoryCtl };

export interface NotesSurfaceProps {
  source: NoteSource;
  editing: boolean;
  head?: ((trash: ReactNode, catName: string | null) => ReactNode) | undefined;
  cat?: CategoryCtl | undefined;
}

export default function NotesSurface({ source, editing, head, cat }: NotesSurfaceProps) {
  return <NoteSourceProvider value={source}>{editing ? <NoteEditPage /> : <NotesList head={head} cat={cat} />}</NoteSourceProvider>;
}
