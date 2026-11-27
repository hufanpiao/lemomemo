// 普通随手记的附件区：随手记编辑器、电脑抽屉在插图区下面挂（index.ts 懒加载）
// 列表来自 note_files 集合 + 上传器的待传状态（useNoteFiles），动作是 noteSource；界面整块在 AttPanel.tsx
// • 同一个懒加载块也出手机上的“文档请在电脑上加。/ 手机上可以看、预览、下载。”（index.ts 的 AttPhoneHint 指向本文件，带 hint 时只画这两行）：
//   挂在随手记、隐私记手机编辑页底部工具条右侧；新建还没存的也出；电脑布局不出（附件区自己出“加附件”）。不另占一个分包
import { AttPanel } from './AttPanel.tsx';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { noteSource, useAttT, useNoteFiles } from '../hooks/useNoteFiles.ts';

export interface NoteAttachmentsProps {
  noteId: string | null;
  /** 只读行、已删除：不能加、不能删 */
  disabled: boolean;
  /** 拖进来、粘贴进来的图片（照插图处理） */
  onImages?(files: File[]): void;
}

/** 只画手机提示：外观由挂它的地方给 className */
export interface PhoneHintProps {
  hint: true;
  className: string | undefined;
}

export default function NoteAttachments(p: NoteAttachmentsProps | PhoneHintProps) {
  return 'hint' in p ? <PhoneHint className={p.className} /> : <NotePanel {...p} />;
}

function NotePanel({ noteId, disabled, onImages }: NoteAttachmentsProps) {
  const items = useNoteFiles(noteId);
  return <AttPanel src={noteSource} items={items} noteId={noteId} disabled={disabled} {...(onImages ? { onImages } : {})} />;
}

/** 两句分两行（两个文案键，不靠断句）；电脑布局不出 */
function PhoneHint({ className }: { className: string | undefined }) {
  const t = useAttT();
  const desk = useMedia(MQ_SIDEBAR);
  if (desk) return null;
  return (
    <span className={className} data-testid="note-files-phone">
      {t('att.phoneOnly1', {})}
      <br />
      {t('att.phoneOnly2', {})}
    </span>
  );
}
