// 随手记页的小部件（11-15 隐私记重写时从 NotesPage.tsx 拆出来，页面不超行数上限）：“附件 N”、列表行的字、撤销条、输入行上面的提示条、
// 分类胶囊、只读、已转过、AI 小标；隐私记的后台同步状态（行上“没保存上”、编辑页“没保存上 · 重试”、解锁后“有 N 处改动没来得及保存”）
// • 同步状态都从 hooks/note-source.ts 来源的 useSync 读：普通随手记一直是空的，什么都不画
import type { ReactNode } from 'react';
import { hrefOf, navigate, plainClick } from '../../../app/router.ts';
import row from '../../../kit/components/NoteRow.module.css';
import { ReadonlyMark } from '../../../kit/components/ReadonlyRow.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { Pressable } from '../../../motion/components.ts';
import { useNoteSource } from '../hooks/note-source.ts';
import type { NoteItem } from '../hooks/useNoteList.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import type { MergeUndo, UndoTip } from '../hooks/useNotesToast.ts';
import { Dot } from './CatDot.tsx';
import type { PageTip } from './NotesActions.tsx';
import styles from './NotesPage.module.css';

/** 列表行、卡片上的“没保存上”（隐私记的条目发了 3 次都没成） */
export function SyncMark({ id }: { id: string }) {
  const t = useNotesT();
  const { failed } = useNoteSource().useSync();
  return failed.has(id) ? (
    <span className={styles.atb} data-testid={`notes-sync-failed-${id}`}>
      {t('notes.sync.failed', {})}
    </span>
  ) : null;
}

/** 编辑页状态行下面的“没保存上 · 重试”（隐私记）；className 用编辑页出错提示的那一档 */
export function SyncLine({ id, className }: { id: string | null; className: string | undefined }) {
  const t = useNotesT();
  const sync = useNoteSource().useSync();
  if (id === null || !sync.failed.has(id)) return null;
  return (
    <p className={className} role="alert" data-testid="note-edit-sync">
      {`${t('notes.sync.failed', {})} · `}
      <Pressable type="button" className={styles.tipLink} onClick={() => sync.retry(id)} data-testid="note-edit-sync-retry">
        {t('notes.sync.retry', {})}
      </Pressable>
    </p>
  );
}

/** 解锁后页面上一句“有 N 处改动没来得及保存”（上一段解锁期没发完就上锁丢掉的，只报个数、不带内容）；点“知道了”收起 */
export function SyncDropped() {
  const t = useNotesT();
  const sync = useNoteSource().useSync();
  if (sync.dropped === 0) return null;
  return (
    <p className={styles.error} role="alert" data-testid="notes-sync-dropped">
      {t('notes.sync.dropped', { n: sync.dropped })}
      <Pressable type="button" className={styles.tipLink} onClick={sync.ack} data-testid="notes-sync-dropped-ok">
        {t('notes.sync.ok', {})}
      </Pressable>
    </p>
  );
}

/** “附件 N”（B4b-1，线框 sAtt 第三张 ATB：列表行尾、瀑布流卡片底部）；没附件不画 */
export function FilesMark({ n }: { n: number }) {
  const t = useNotesT();
  return n > 0 ? (
    <span className={styles.atb} data-testid="notes-files-mark">
      {t('notes.files', { n })}
    </span>
  ) : null;
}

/** 列表行中间的字：标题；摘要 · 分类（+ AI 小标、没保存上）；只读行再在下面单独一行标“要新版本” */
export function RowText({ it, ai, ro }: { it: NoteItem; ai: ReactNode; ro: ReactNode }) {
  return (
    <span className={row.ltext}>
      <span className={row.t1}>
        {it.converted ? <ConvMark id={it.id} /> : null}
        {it.title}
      </span>
      <span className={row.t2}>
        <span className={row.t2txt}>{[it.summary, it.categoryName ?? ''].filter(Boolean).join(' · ')}</span>
        {ai}
        <FilesMark n={it.files} />
        <SyncMark id={it.id} />
      </span>
      {ro}
    </span>
  );
}

/** 页底的撤销条：删除的“已删除”、合并分类的“已合并”（R-415 ③），同一个 kit UndoToast、8 秒；画什么、点了做什么都在 tip 里（换一条就换一个 key，重新计时） */
export function UndoBar({ tip, onClose }: { tip: UndoTip; onClose(): void }) {
  const t = useNotesT();
  return <UndoToast message={t(tip.msgKey, {})} undoLabel={t('notes.undo', {})} onUndo={tip.undo} onClose={onClose} solo="keep" data-testid={tip.testId} />;
}

/** 输入行上面的提示条：没保存上、插图提示（空间满了的带“最近删除”入口）、转换结果 */
export function DockTip({ toast }: { toast: { kind: 'error' } | Exclude<PageTip, MergeUndo> }) {
  const t = useNotesT();
  return (
    <p className={styles.error} role="alert" data-testid={toast.kind === 'error' ? 'notes-error' : toast.kind === 'img' ? 'notes-img-tip' : 'notes-conv-tip'}>
      {t(toast.kind === 'error' ? 'notes.err.save' : toast.key, {})}
      {toast.kind === 'img' && toast.trash ? (
        <a className={styles.tipLink} href={hrefOf('trash')} onClick={(e) => plainClick(e) && void navigate('trash')} data-testid="notes-img-trash">
          {t('notes.img.trash', {})}
        </a>
      ) : null}
    </p>
  );
}

export function Chip({ on, onClick, label, color, testId }: { on: boolean; onClick(): void; label: string; color: string | null; testId: string }) {
  return (
    <Pressable className={on ? styles.chipOn : styles.chip} aria-pressed={on} onClick={onClick} data-testid={testId}>
      <Dot color={color} big />
      {label}
    </Pressable>
  );
}

/** 只读行的“要新版本”（S12，kit 的 ReadonlyMark） */
// 只读标记单独一行：瀑布流放在正文下、底行上，列表放在摘要行下（视觉验收 11-11：挤在底行、摘要行会把时间、分类、“⋯”挤坏）
export const RoMark = ({ ro, id, cls }: { ro: boolean; id: string; cls: string | undefined }) =>
  ro ? (
    <span className={cls}>
      <ReadonlyMark testId={`notes-ro-${id}`} />
    </span>
  ) : null;

/** “已转过”描边小标（R-415 ③，负责人定方案丙）：卡片、列表行的标题前；后面一个视觉隐藏的“，”，读屏读成“已转过，标题”不连在一起 */
export function ConvMark({ id }: { id: string }) {
  const t = useNotesT();
  return (
    <span className={styles.conv} data-testid={`notes-conv-${id}`}>
      {t('notes.converted', {})}
      <span className={styles.convSep}>，</span>
    </span>
  );
}

export function AiMark({ id }: { id: string }) {
  const t = useNotesT();
  return (
    <span className={styles.ai} aria-label={t('notes.aiLabel', {})} data-testid={`notes-ai-${id}`}>
      {t('notes.ai', {})}
    </span>
  );
}
