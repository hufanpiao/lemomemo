// 随手记页的小部件（11-15 隐私记重写时整理）：
// • 8 个从 NotesPage.tsx 原样搬来（页面不超行数上限）：“附件 N”、列表行的字、撤销条、输入行上面的提示条、分类胶囊、只读、已转过、AI 小标
// • 3 个新增（隐私记的后台同步状态）：SyncMark 行上“没保存上”、SyncLine 编辑页“没保存上 · 重试”、SyncDropped 解锁后“有 N 处改动没来得及保存”
// • 11-15 加 TrashLink：列表上方居中的“最近删除”入口（原来在 vault 的 VaultPage，挪来两种来源共用）；链接本身是 kit 的 TrashLink（审查 11-15 第 2 条），这里只按来源给去哪、文案和条数
// • 同步状态都从 hooks/note-source.ts 来源的 useSync 读（普通随手记一直是空的，什么都不画）；列表上的 failed 由列表层读一次传进来，每行不各订一份
import type { ReactNode } from 'react';
import chip from '../../../kit/components/Chip.module.css';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import row from '../../../kit/components/NoteRow.module.css';
import { ReadonlyMark } from '../../../kit/components/ReadonlyRow.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { TrashLink as KitTrashLink } from '../../../kit/components/TrashLink.tsx';
import { Pressable } from '../../../motion/components.ts';
import { useNoteSource } from '../hooks/note-source.ts';
import type { NoteItem } from '../hooks/useNoteList.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import type { MergeUndo, MoveUndo, UndoTip } from '../hooks/useNotesToast.ts';
import { Dot } from './CatDot.tsx';
import type { PageTip } from './NotesActions.tsx';
import styles from './NotesPage.module.css';

/** 列表行、卡片上的“没保存上”（隐私记的条目发了 3 次都没成）；failed 由列表层读 useSync 一次传进来 */
export function SyncMark({ id, failed }: { id: string; failed: boolean }) {
  const t = useNotesT();
  return failed ? (
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

/** 隐私记拖动后服务器回 stale（R-429）：“这条刚在别处改过，没有移动”；点“知道了”收起 */
export function SyncStale() {
  const t = useNotesT();
  const sync = useNoteSource().useSync();
  if (sync.stale === 0) return null;
  return (
    <p className={styles.error} role="alert" data-testid="notes-sync-stale">
      {t('notes.sync.stale', {})}
      <Pressable type="button" className={styles.tipLink} onClick={sync.ackStale} data-testid="notes-sync-stale-ok">
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
/** mark：标题、摘要的字怎么画（下拉搜索就地筛时给命中的字加短下划线，kit PullHit；不给原样） */
const same = (text: string): ReactNode => text;

export function RowText({ it, ai, ro, failed, mark = same }: { it: NoteItem; ai: ReactNode; ro: ReactNode; failed: boolean; mark?: (text: string) => ReactNode }) {
  return (
    <span className={row.ltext}>
      <span className={row.t1}>
        {it.converted ? <ConvMark id={it.id} /> : null}
        {mark(it.title)}
      </span>
      <span className={row.t2}>
        <span className={row.t2txt}>{mark([it.summary, it.categoryName ?? ''].filter(Boolean).join(' · '))}</span>
        {ai}
        <FilesMark n={it.files} />
        <SyncMark id={it.id} failed={failed} />
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

const DOCK_TEST_ID = { error: 'notes-error', img: 'notes-img-tip', conv: 'notes-conv-tip', moveOut: 'notes-moveout-tip' } as const;

/** 输入行上面的提示条：没保存上、插图提示（空间满了的带“最近删除”入口）、转换结果、移出隐私记没成 */
export function DockTip({ toast }: { toast: { kind: 'error' } | Exclude<PageTip, MergeUndo | MoveUndo> }) {
  const t = useNotesT();
  return (
    <p className={styles.error} role="alert" data-testid={DOCK_TEST_ID[toast.kind]}>
      {t(toast.kind === 'error' ? 'notes.err.save' : toast.kind === 'moveOut' ? 'notes.err.moveOut' : toast.key, {})}
      {toast.kind === 'img' && toast.trash ? (
        <KitTrashLink look="inline" to={['trash', 'notes']} label={t('notes.img.trash', {})} testId="notes-img-trash" />
      ) : null}
    </p>
  );
}

/** 分类筛选胶囊（R-436，照待办页 518f49a0）：kit 的 Chip.module.css（高 30、无描边浅底，负责人 11-16“胶囊太大了！参考现在的待办页”）；
 *  色点 8px（视觉稿 .chip .d）；条数只给数字等宽淡色（kit .chipN），词条照旧整句（“全部 {n}”） */
export function Chip({ on, onClick, label, n, color, testId }: { on: boolean; onClick(): void; label: string; n: number; color: string | null; testId: string }) {
  return (
    <Pressable className={on ? chip.chipOn : chip.chip} aria-pressed={on} onClick={onClick} data-testid={testId}>
      <Dot color={color} big />
      <NumIn text={label} num={String(n)} className={chip.chipN} />
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

/** “最近删除”入口（负责人 11-15 随手记页也要常驻一个；原来只在隐私记页有，挪到这里两种来源共用一份）：去哪、带不带条数看来源。
 *  垃圾桶图标（R-438）：手机版在顶栏头像左边，电脑版在分类栏标题右边（负责人 11-16 第 2 组选丙） */
export function TrashLink() {
  const t = useNotesT();
  const src = useNoteSource();
  const n = src.useTrashCount();
  return <KitTrashLink to={src.trash} label={`${src.text?.trash ?? t('notes.img.trash', {})}${n ? ` ${n}` : ''}`} testId={`${src.kind}-open-trash`} look="icon" />;
}
