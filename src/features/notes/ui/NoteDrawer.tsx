// 随手记电脑详情抽屉（B4 视觉验收 A1；皮肤视觉稿 DK.mason / NOTE_ED：右边浮起、盖在面板上面）
// • 外壳（Esc、焦点、哪一边、换边把手）是 kit 的 DetailDrawer（B6 返工：今天页的日程、待办抽屉用同一个）；这里只给随手记编辑器
// • 打开时焦点落在正文框；关上时原来的元素不在了就找这一条的卡片或行上的按钮
// • 读屏：aside 名字“随手记详情”
import type { ReactNode } from 'react';
import { DetailDrawer } from '../../../kit/components/DetailDrawer.tsx';
import { useNotesT } from '../hooks/useNotesT.ts';
import { NoteEditor } from './NoteEditPage.tsx';

const refocus = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="notes-card-${id}"] button, [data-testid="notes-row-${id}"] button`);

export function NoteDrawer({ id, onClose, side, handle }: { id: string; onClose(): void; side?: 'left' | 'right' | undefined; handle?: ReactNode }) {
  const t = useNotesT();
  return (
    <DetailDrawer id={id} label={t('note.edit.drawer', {})} onClose={onClose} side={side} handle={handle} initial='[data-testid="note-edit-body"]' refocus={refocus} data-testid="note-drawer">
      <NoteEditor key={id} id={id} onClose={onClose} drawer />
    </DetailDrawer>
  );
}
