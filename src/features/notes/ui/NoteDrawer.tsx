// 随手记电脑详情抽屉（B4 视觉验收 A1；皮肤视觉稿 DK.mason / NOTE_ED：右边浮起、盖在面板上面）
// • 随手记编辑器的抽屉外壳只有这一份：随手记页直接用，电脑版今天页“今天记的”经 TodayNotes part="drawer" 懒加载同一个（B6 整合）
// • 外壳（Esc、焦点、哪一边、换边把手）是 kit 的 DetailDrawer（今天页的日程、待办抽屉用同一个）；这里只给随手记编辑器
// • 打开时焦点落在正文框；关上时原来的元素不在了，DetailDrawer 找这一条行或卡片上带 data-open 的按钮
// • 读屏：aside 名字“随手记详情”；testid note-drawer（两页一样）
import type { ReactNode } from 'react';
import { DetailDrawer } from '../../../kit/components/DetailDrawer.tsx';
import { useNotesT } from '../hooks/useNotesT.ts';
import { NoteEditor } from './NoteEditPage.tsx';

export interface NoteDrawerProps {
  id: string;
  onClose(): void;
  side: 'left' | 'right';
  handle: ReactNode;
}

export function NoteDrawer({ id, onClose, side, handle }: NoteDrawerProps) {
  const t = useNotesT();
  return (
    <DetailDrawer id={id} label={t('note.edit.drawer', {})} onClose={onClose} side={side} handle={handle} initial='[data-testid="note-edit-body"]' data-testid="note-drawer">
      <NoteEditor key={id} id={id} />
    </DetailDrawer>
  );
}
