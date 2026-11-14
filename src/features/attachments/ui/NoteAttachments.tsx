// 普通随手记的附件区（B4b-1，线框 sAtt）：随手记编辑器、电脑抽屉在插图区下面挂（index.ts 懒加载）
// 列表来自 note_files 集合 + 上传器的待传状态（useNoteFiles），动作是 noteSource；界面整块在 AttPanel.tsx
import { AttPanel } from './AttPanel.tsx';
import { noteSource, useNoteFiles } from '../hooks/useNoteFiles.ts';

export interface NoteAttachmentsProps {
  noteId: string | null;
  /** 只读行、已删除：不能加、不能删 */
  disabled: boolean;
  /** 拖进来、粘贴进来的图片（照插图处理） */
  onImages?(files: File[]): void;
}

export default function NoteAttachments({ noteId, disabled, onImages }: NoteAttachmentsProps) {
  const items = useNoteFiles(noteId);
  return <AttPanel src={noteSource} items={items} noteId={noteId} disabled={disabled} {...(onImages ? { onImages } : {})} />;
}
