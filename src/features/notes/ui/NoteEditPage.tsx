// 随手记编辑器（B4 S2；交互照定稿线框 s8（第 910～913 行），视觉照皮肤视觉稿 NOTE_ED / DK.mason）
// 地址：#/note/<id>（编辑）、#/note/new（新建）。改了就自动保存，不弹窗：标题失焦、回车就存；正文停笔约 0.8 秒存一次，失焦、离开页面、切到后台时补存
// • 手机（整页）：顶栏“‹ 随手记 ｜ [● 分类 AI ▾] ｜ ⋯”，下面 24px 粗体标题和正文（s8）。不放“完成”：改了自动保存，“‹ 随手记”退回就行（R-393，负责人 11-11“完成按钮可以去掉，目前都是修改完退出自动保存”）
// • 电脑（≥ 900px）：不换页，从随手记页右边滑出详情抽屉（NoteDrawer，DK.mason），侧栏和列表留着；顶栏“[● 分类 AI ▾] ｜ ⋯ ｜ ×”，Esc 也关
// • 分类：胶囊里是原生下拉（透明盖在胶囊上，读屏和键盘照常用）“不分类 / 各分类”；改了写 category_source = 'manual'，之后 AI 不再动（S2）。
//   AI 分的、还没看过的胶囊里标“AI”，打开就算看过（category_seen 置为已看，hooks/useNoteEdit.ts）
// • “⋯”菜单：现在只有“删除”（软删，页内出“已删除”和“撤销”，ADR-006，进“最近删除”）；“移到隐私记 / 转成…”是 B5、S8 的活
// • 保存状态：常驻 role="status" 给读屏播报；平时看不见（稿子上没有），没保存上、只读这些坏状态才显示出来
// • 插图（S3，NOTE_ED）：正文下面一张张 16:10 的图，再下面“图片”“拍照”（ui/NoteImages.tsx）；插入、上传失败的提示出在保存状态下面，
//   空间满了的带“最近删除”入口。电脑抽屉里上传失败的提示由随手记页出（不出两遍）；只读行（off）时“图片”“拍照”和图上的按钮一起禁用
// • 只读行（S12，R-148，TC-B4-09；照待办编辑页）：core 的只读 id 里有这一条（或写入被拒 readonly）时，标题、正文、分类全部禁用，“⋯”（删除）灰掉，
//   出“这条要新版本才能修改 · 更新”；电脑抽屉复用这个编辑器，列表页已在点开时拦下，这里兜住直接打开地址、打开后才变只读的情况
// • 附件（B4b-1）：插图区下面挂 attachments 功能懒加载的附件区（加附件只在电脑布局，预览浮层再单独懒加载）
// • 动效：只有抽屉最基本的滑入（R-376），按钮用 Pressable 的按下反馈
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { backOr, useEditRoute } from '../../../app/router-levels.ts';
import { DrawerClose } from '../../../kit/components/DetailDrawer.tsx';
import { DeletedNotice, ReadonlyNotice, useEditStatus, useEditT } from '../../../kit/components/EditNotices.tsx';
import { enterCommits } from '../../../kit/components/Form.tsx';
import { Popover } from '../../../kit/components/Popover.tsx';
import { useHoldBusy } from '../../../kit/hooks/useHoldBusy.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { Pressable } from '../../../motion/components.ts';
import { NoteAttachments } from '../../attachments/index.ts';
import { BODY_MAX, TITLE_MAX, useNoteEdit, type CategoryOption } from '../hooks/useNoteEdit.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import styles from './NoteEditPage.module.css';
import { EditorImageBlock } from './NoteImages.tsx';

const NONE = '';
/** 正文停笔多久存一次 */
export const BODY_IDLE_MS = 800;

/** 直接打开的（书签、刷新）没有上一页：退回随手记页 */
const back = (): void => backOr('notes');

/** 手机整页编辑器（#/note/<id>、#/note/new） */
export default function NoteEditPage() {
  // 新建保存后地址换成这一条的 id，编辑器不重挂（同待办编辑页）
  const { id, key, onCreated } = useEditRoute('note');
  return <NoteEditor key={key} id={id} onCreated={onCreated} onClose={back} drawer={false} />;
}

export function NoteEditor({ id, onCreated, onClose, drawer }: { id: string; onCreated?(id: string): void; onClose(): void; drawer: boolean }) {
  // 编辑器挂着期间占住升级中心的 busy：不出版本横幅、不自动重新载入（同 kit EditShell）；抽屉里由 DetailDrawer 按焦点占（B6 独立评审第 12 条）
  useHoldBusy('editing', !drawer);
  const t = useNotesT();
  const ed = useNoteEdit(id, onCreated);
  const tEdit = useEditT();
  const { form, change, readonly, off } = ed;
  const st = useEditStatus(ed.status, { empty: t('note.edit.st.empty', {}), rejected: t('note.edit.st.rejected', {}) });
  const [menu, setMenu] = useState(false);
  const locale = useUi((s) => s.locale);
  const noteId = ed.row ? String(ed.row['id']) : null;
  // 附件区拖进来、粘贴进来的图片照插图处理：交给插图区（EditorImageBlock 的 dropRef，走 useNoteImages 的 insert，隐私记、只读行照样先拦，
  // 插不进去时插图区出提示，D6）
  const dropImg = useRef<((f: File) => void) | null>(null);
  const onImages = useCallback((fs: readonly File[]) => fs.forEach((f) => dropImg.current?.(f)), []);

  // 电脑抽屉顶行“随手记 · 分类 · 时间”（视觉稿 NOTE_ED：“随手记 · 韩国生活 · 今天 11:40”）
  const w = drawer ? ed.when : null;
  const when = !w ? '' : w.kind === 'day' ? fmtDay(w.date, locale, 'monthDay') : t(w.kind === 'today' ? 'notes.at.today' : 'notes.at.yesterday', { t: w.hm });
  const meta = w ? [t('note.edit.kind', {}), ed.categories.find((c) => c.id === form.category_id)?.name, when].filter(Boolean).join(' · ') : null;

  const inner: ReactNode = (
    <>
      <div className={styles.top}>
        {drawer ? null : (
          <Pressable className={styles.back} onClick={onClose} data-testid="edit-back">
            {`‹ ${t('note.edit.back', {})}`}
          </Pressable>
        )}
        <CatChip
          value={form.category_id}
          options={ed.categories}
          ai={ed.ai}
          disabled={off}
          muted={readonly}
          drawer={drawer}
          onChange={(v) => change({ category_id: v })}
        />
        <Popover
          open={menu}
          onOpenChange={setMenu}
          label={t('notes.menu', {})}
          align="end"
          className={styles.menu}
          trigger={
            <button type="button" className={styles.more} aria-label={t('notes.more', {})} disabled={!ed.row || ed.deleted || readonly} data-testid="note-edit-more">
              ⋯
            </button>
          }
        >
          <Pressable
            className={styles.menuItem}
            onClick={() => {
              setMenu(false);
              void ed.setDeleted(true);
            }}
            data-testid="note-edit-delete"
            data-no-proxy=""
          >
            {tEdit('edit.delete', {})}
          </Pressable>
        </Popover>
        {drawer ? (
          <DrawerClose label={t('note.edit.close', {})} onClick={onClose} testId="note-edit-close" />
        ) : null}
      </div>
      {meta ? <p className={styles.meta} data-testid="note-edit-meta">{meta}</p> : null}
      <p className={st.bad ? styles.statusBad : styles.status} role="status" data-testid="edit-status">
        {readonly ? '' : st.text}
      </p>
      {/* 只读：和“已删除 · 撤销”同一种提示行，一句话加“更新”（同待办编辑页） */}
      {readonly ? <ReadonlyNotice plain role="status" testId="note-edit-ro" updateTestId="note-edit-update" className={styles.roNotice} /> : null}
      {ed.deleted ? (
        <p className={styles.notice} role="alert" data-testid="edit-notice">
          <DeletedNotice onUndo={() => void ed.setDeleted(false)} testId="note-edit-undo" />
        </p>
      ) : null}
      <DraftArea
        single
        value={form.title}
        maxLength={TITLE_MAX}
        disabled={off}
        label={t('note.edit.titleLabel', {})}
        placeholder={t('note.edit.titlePh', {})}
        onCommit={(v) => change({ title: v })}
        testId="note-edit-title"
      />
      <DraftArea
        value={form.body}
        maxLength={BODY_MAX}
        disabled={off}
        label={t('note.edit.bodyLabel', {})}
        placeholder={t('note.edit.bodyPh', {})}
        onCommit={(v) => change({ body: v })}
        testId="note-edit-body"
      />
      <EditorImageBlock noteId={noteId} drawer={drawer} disabled={off} msgClass={styles.notice} dropRef={dropImg} />
      {/* 附件（B4b-1，线框 sAtt）：懒加载，插图区下面；拖进来、粘贴进来的图片照插图插进这一条 */}
      <Suspense fallback={null}>
        <NoteAttachments noteId={noteId} disabled={off || ed.deleted} onImages={onImages} />
      </Suspense>
    </>
  );
  return drawer ? (
    <section className={styles.inDrawer} data-testid="note-edit">
      {inner}
    </section>
  ) : (
    <main className={styles.page} data-feature="notes" data-testid="note-edit">
      {inner}
    </main>
  );
}

/** 顶栏的分类胶囊（s8“工作灵感 AI ▾”）：色点 + 名字 + AI + ▾；原生下拉透明盖在上面 */
function CatChip(p: { value: string | null; options: CategoryOption[]; ai: boolean; disabled: boolean; muted: boolean; drawer: boolean; onChange(v: string | null): void }) {
  const t = useNotesT();
  const cur = p.options.find((c) => c.id === p.value) ?? null;
  return (
    <span className={p.drawer ? `${styles.chip} ${styles.chipStart}` : styles.chip} data-muted={p.muted || undefined} data-testid="note-edit-chip">
      {cur?.color ? <i className={styles.dot} style={{ '--dot': cur.color } as CSSProperties} aria-hidden="true" /> : null}
      <span className={styles.chipName}>{cur ? cur.name : t('note.edit.noCategory', {})}</span>
      {p.ai ? (
        <span className={styles.ai} aria-label={t('notes.aiLabel', {})} data-testid="note-edit-ai">
          {t('notes.ai', {})}
        </span>
      ) : null}
      <span className={styles.caret} aria-hidden="true">
        ▾
      </span>
      <select
        className={styles.select}
        aria-label={t('note.edit.category', {})}
        value={p.value ?? NONE}
        disabled={p.disabled}
        onChange={(e) => p.onChange(e.target.value === NONE ? null : e.target.value)}
        data-testid="note-edit-category"
      >
        <option value={NONE}>{t('note.edit.noCategory', {})}</option>
        {p.options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * 标题、正文框：本地草稿，停笔 BODY_IDLE_MS 存一次；失焦、卸载、pagehide、切到后台时把没存的补存一次（同 kit Form 的 useCommitDraft 的补交时机）。
 * 编辑中外面的值变了（别的设备改了）不打断；不在编辑时跟着外面的值走。
 * single（标题）：长标题照线框 s8 换行显示、跟着内容长高；回车不换行，当作写完（失焦就存），粘贴进来的换行变空格
 */
interface DraftAreaProps {
  value: string;
  disabled: boolean;
  label: string;
  placeholder: string;
  maxLength: number;
  single?: boolean;
  testId: string;
  onCommit(v: string): void;
}

function DraftArea({ value, disabled, label, placeholder, maxLength, single = false, testId, onCommit }: DraftAreaProps) {
  const [draft, setDraftState] = useState(value);
  const [editing, setEditing] = useState(false);
  const el = useRef<HTMLTextAreaElement>(null);
  const live = useRef({ draft: value, value, onCommit, dirty: false, timer: null as ReturnType<typeof setTimeout> | null });
  live.current.value = value;
  live.current.onCommit = onCommit;
  useEffect(() => {
    if (!editing && !live.current.dirty) {
      setDraftState(value);
      live.current.draft = value;
    }
  }, [value, editing]);
  // 标题、正文都跟着内容长高（标题一行起；正文的最小高度在样式里，有图时降到两行，图紧跟在正文后面，NOTE_ED）
  useLayoutEffect(() => {
    const ta = el.current;
    if (ta === null) return;
    // 量内容本身的高度（先去掉样式里的最小高度）；写回去的 height 再被样式的 min-height 托底（没图 40vh、有图两行）
    ta.style.height = 'auto';
    ta.style.minHeight = '0px';
    const h = ta.scrollHeight;
    ta.style.minHeight = '';
    ta.style.height = `${h}px`;
  }, [draft]);

  const flush = useCallback((): void => {
    const l = live.current;
    if (l.timer !== null) clearTimeout(l.timer);
    l.timer = null;
    if (!l.dirty) return;
    l.dirty = false;
    if (l.draft !== l.value) l.onCommit(l.draft);
  }, []);

  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [flush]);

  return (
    <textarea
      ref={el}
      className={single ? styles.title : styles.body}
      aria-label={label}
      placeholder={disabled ? undefined : placeholder}
      maxLength={maxLength}
      disabled={disabled}
      rows={single ? 1 : undefined}
      value={draft}
      data-testid={testId}
      onFocus={() => setEditing(true)}
      onKeyDown={(e) => {
        if (single && enterCommits(e)) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      onChange={(e) => {
        const v = single ? e.target.value.replace(/[\r\n]+/g, ' ') : e.target.value;
        setDraftState(v);
        const l = live.current;
        l.draft = v;
        l.dirty = true;
        if (l.timer !== null) clearTimeout(l.timer);
        l.timer = setTimeout(flush, BODY_IDLE_MS);
      }}
      onBlur={() => {
        setEditing(false);
        flush();
      }}
    />
  );
}
