// 随手记编辑器
// 地址：#/note/<id>（编辑）、#/note/new（新建）。改了就自动保存，不弹窗：标题失焦、回车就存；正文停笔约 0.8 秒存一次，失焦、离开页面、切到后台时补存
// • 手机（整页）：顶栏“‹ 随手记 ｜ [● 分类 AI ▾] ｜ ⋯”，下面 24px 粗体标题和正文。不放“完成”：改了自动保存，“‹ 随手记”退回就行
// • 电脑（≥ 900px）：不换页，从随手记页右边滑出详情抽屉（NoteDrawer），侧栏和列表留着；顶栏“[● 分类 AI ▾] ｜ ⋯ ｜ ×”，Esc 也关
// • 分类：胶囊点了弹 kit 的 PickPopover 选“不分类 / 各分类”；改了写 category_source = 'manual'，之后 AI 不再动。
//   AI 分的、还没看过的胶囊里标“AI”，打开就算看过（category_seen 置为已看，hooks/useNoteEdit.ts）
// • “⋯”菜单：和列表页同一份 MoreMenu（NotesActions.tsx）：转成待办 / 转成日程 / 移到隐私记 / 删除（隐私记来源换成“移出隐私记”）。
//   转换、移进隐私记走同一个 useNoteActs（只读拦下、带图和附件先问、移进由 vault 的 VaultParts move 管）；转换结果出在提示行（同列表页那几句），
//   移进、移出成了就离开这一页（抽屉关上，整页退回列表）。删除是软删，页内出“已删除”和“撤销”（ADR-006，进“最近删除”）
// • 保存状态：常驻 role="status" 给读屏播报；平时看不见，没保存上、只读这些坏状态才显示出来
// • 手机整页的标题、细线、正文、图、附件装进一张撑到页底的纸张卡片；“图片”“拍照”和“文档请在电脑上加…”在底部浮动工具条；
//   “⋯”36 圆形浅底；隐私记返回带小锁（来源的 text.backMark 给）。电脑抽屉没有卡片和工具条，“图片”“拍照”在图下面
// • 插图：正文下面一张张 16:10 的图（ui/NoteImages.tsx）；插入、上传失败的提示出在保存状态下面，
//   空间满了的带“最近删除”入口。电脑抽屉里上传失败的提示由随手记页出（不出两遍）；只读行（off）时“图片”“拍照”和图上的按钮一起禁用
// • 只读行（照待办编辑页）：core 的只读 id 里有这一条（或写入被拒 readonly）时，标题、正文、分类全部禁用，“⋯”（删除）灰掉，
//   出“这条要新版本才能修改 · 更新”；电脑抽屉复用这个编辑器，列表页已在点开时拦下，这里兜住直接打开地址、打开后才变只读的情况
// • 附件：插图区下面挂 attachments 功能懒加载的附件区（加附件只在电脑布局，预览浮层再单独懒加载）
// • 动效：只有抽屉最基本的滑入，按钮用 Pressable 的按下反馈
// • 数据来源（hooks/note-source.ts）：隐私记页用同一个编辑器（#/vault/<id>、#/vault/new），左上角“‹ 隐私记”、
//   “⋯”里多一项“移出隐私记”；后台没保存上时状态行下面出“没保存上 · 重试”（NotesBits 的 SyncLine）
import { Suspense, useCallback, useRef, useState, type ReactNode } from 'react';
import { backOr, useEditRoute } from '../../../app/router-levels.ts';
import { BackLink } from '../../../kit/components/BackLink.tsx';
import { DrawerClose, useInDrawer } from '../../../kit/components/DetailDrawer.tsx';
import { DeletedNotice, ReadonlyNotice, useEditStatus } from '../../../kit/components/EditNotices.tsx';
import { TextArea } from '../../../kit/components/Form.tsx';
import { PickPopover } from '../../../kit/components/Pick/PickPopover.tsx';
import { useHoldBusy } from '../../../kit/hooks/useHoldBusy.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { useNoteSource } from '../hooks/note-source.ts';
import { BODY_MAX, TITLE_MAX, useNoteEdit, type CategoryOption } from '../hooks/useNoteEdit.ts';
import { useNoteConvert, type ActionResult } from '../hooks/useNoteList.ts';
import { useNotesT, type NotesMsgKey } from '../hooks/useNotesT.ts';
import chip from '../../../kit/components/Chip.module.css';
import { AttPhoneHint } from '../../attachments/index.ts';
import { Dot } from './CatDot.tsx';
import styles from './NoteEditPage.module.css';
import { EditorImageList, EditorPicks, useEditorImages, type EditorImgs } from './NoteImages.tsx';
import { MoreMenu, useNoteActs, type ConvTip } from './NotesActions.tsx';
import { AiMark, SyncLine } from './NotesBits.tsx';
import notes from './NotesPage.module.css';
import { noteAtText } from './note-time.ts';

const NONE = '';
/** 编辑页提示行里菜单动作的结果：转换结果（列表页同几句）或出错 */
type EditTip = ConvTip | { kind: 'err'; key: Extract<NotesMsgKey, 'notes.err.moveOut' | 'notes.err.save' | 'notes.img.err.readonly'> };
/** 正文停笔多久存一次 */
export const BODY_IDLE_MS = 800;

/** 手机整页编辑器（#/note/<id>、#/note/new；隐私记 #/vault/<id>、#/vault/new） */
export default function NoteEditPage() {
  // 新建保存后地址换成这一条的 id，编辑器不重挂（同待办编辑页）
  const { id, key, onCreated } = useEditRoute(useNoteSource().route.edit);
  return <NoteEditor key={key} id={id} onCreated={onCreated} />;
}

/** 整页和电脑详情抽屉共用；在不在抽屉里看 kit 的 useInDrawer（抽屉给的是关抽屉的函数，“×”用） */
export function NoteEditor({ id, onCreated }: { id: string; onCreated?(id: string): void }) {
  const close = useInDrawer();
  const drawer = close !== null;
  // 编辑器挂着期间占住升级中心的 busy：不出版本横幅、不自动重新载入（同 kit EditShell）；抽屉里由 DetailDrawer 按焦点占
  useHoldBusy('editing', !drawer);
  const t = useNotesT();
  const { Attachments, caps, route, text, moveOut } = useNoteSource();
  // 直接打开的（书签、刷新）没有上一页：退回列表页
  const back = (): void => backOr(route.list);
  /** 这一条离开随手记了（移出、移进隐私记）：抽屉关上，整页退回列表 */
  const leave = (): void => (close ?? back)();
  const ed = useNoteEdit(id, onCreated);
  const { form, change, readonly, off } = ed;
  const { tip, setTip, acts, tooLong, sizes } = useEditMenu(readonly, leave);
  const st = useEditStatus(ed.status, { empty: t('note.edit.st.empty', {}), rejected: t('note.edit.st.rejected', {}) });
  const [menu, setMenu] = useState(false);
  const locale = useUi((s) => s.locale);
  const noteId = ed.row ? String(ed.row['id']) : null;
  // 附件区拖进来、粘贴进来的图片照插图处理：交给插图区（EditorImageBlock 的 dropRef，走 useNoteImages 的 insert，隐私记、只读行照样先拦，
  // 插不进去时插图区出提示）
  const dropImg = useRef<((f: File) => void) | null>(null);
  const onImages = useCallback((fs: readonly File[]) => fs.forEach((f) => dropImg.current?.(f)), []);
  const img = useEditorImages(noteId, drawer, dropImg);
  const backText = text?.back ?? t('note.edit.back', {});

  // 电脑抽屉顶行“随手记 · 分类 · 时间”（如“随手记 · 韩国生活 · 今天 11:40”）
  const w = drawer ? ed.when : null;
  const when = !w ? '' : noteAtText(t, locale, w);
  const meta = w ? [t('note.edit.kind', {}), ed.categories.find((c) => c.id === form.category_id)?.name, when].filter(Boolean).join(' · ') : null;

  const head: ReactNode = (
    <>
      <div className={styles.top}>
        {drawer ? null : <BackLink label={backText} mark={text?.backMark} onBack={back} testId="edit-back" />}
        <CatChip
          value={form.category_id}
          options={ed.categories}
          ai={ed.ai}
          disabled={off}
          muted={off}
          drawer={drawer}
          onChange={(v) => change({ category_id: v })}
        />
        {/* “⋯”：和列表页同一份 MoreMenu、同一套转换 / 移进隐私记流程；按来源的 caps 出项 */}
        <MoreMenu
          id={noteId ?? ''}
          caps={caps}
          ro={readonly}
          open={menu}
          onOpenChange={setMenu}
          long={menu && noteId !== null && tooLong(noteId)}
          onDelete={() => {
            setMenu(false);
            void ed.setDeleted(true);
          }}
          onConvert={(kind) => {
            setMenu(false);
            setTip(null);
            if (noteId) acts.convert({ id: noteId, ...sizes(noteId) }, kind);
          }}
          onMove={() => {
            setMenu(false);
            if (noteId) acts.toVault({ id: noteId, ...sizes(noteId) });
          }}
          onMoveOut={() => {
            setMenu(false);
            setTip(null);
            if (noteId) void moveOut(noteId).then((r) => (r === 'ok' ? leave() : r === 'failed' ? setTip({ kind: 'err', key: 'notes.err.moveOut' }) : undefined));
          }}
          tid={(p) => `note-edit-${p}`}
          triggerClass={styles.more}
          disabled={!ed.row || ed.deleted || readonly}
        />
        {close ? <DrawerClose label={t('note.edit.close', {})} onClick={close} testId="note-edit-close" /> : null}
      </div>
      {meta ? <p className={styles.meta} data-testid="note-edit-meta">{meta}</p> : null}
      <p className={st.bad ? styles.statusBad : styles.status} role="status" data-testid="edit-status">
        {readonly ? '' : st.text}
      </p>
      <SyncLine id={noteId} className={styles.notice} />
      {/* 菜单动作的结果：转换的“已转成…”（同列表页那几句）、移出隐私记没成、没保存上 */}
      {tip ? (
        <p className={styles.notice} role={tip.kind === 'err' ? 'alert' : 'status'} data-testid={tip.kind === 'err' ? 'note-edit-act-err' : 'note-edit-conv'}>
          {t(tip.key, {})}
        </p>
      ) : null}
      {/* 只读：和“已删除 · 撤销”同一种提示行，一句话加“更新”（同待办编辑页） */}
      {readonly ? <ReadonlyNotice plain role="status" testId="note-edit-ro" updateTestId="note-edit-update" className={styles.roNotice} /> : null}
      {ed.deleted ? (
        <p className={styles.notice} role="alert" data-testid="edit-notice">
          <DeletedNotice onUndo={() => void ed.setDeleted(false)} testId="note-edit-undo" />
        </p>
      ) : null}
    </>
  );
  const paper: ReactNode = (
    <>
      {/* 标题、正文：kit 的 TextArea（草稿、停笔 BODY_IDLE_MS 存一次、失焦和离开补存都在 useCommitDraft）；跟着内容长高，
          标题单行（长了换行显示，回车当作写完，粘贴的换行变空格）；正文的最小高度在样式里，有图时降到两行 */}
      <TextArea
        single
        autoGrow
        idleMs={BODY_IDLE_MS}
        className={styles.title}
        value={form.title}
        maxLength={TITLE_MAX}
        disabled={off}
        aria-label={t('note.edit.titleLabel', {})}
        placeholder={t('note.edit.titlePh', {})}
        onCommit={(v) => change({ title: v })}
        data-testid="note-edit-title"
      />
      {drawer ? null : <hr className={styles.hr} />}
      <TextArea
        autoGrow
        idleMs={BODY_IDLE_MS}
        className={img.im.items.length ? `${styles.body} ${styles.bodyShort}` : styles.body}
        value={form.body}
        maxLength={BODY_MAX}
        disabled={off}
        aria-label={t('note.edit.bodyLabel', {})}
        placeholder={t('note.edit.bodyPh', {})}
        onCommit={(v) => change({ body: v })}
        data-testid="note-edit-body"
      />
      <EditorImageList ed={img} disabled={off} msgClass={styles.notice} picks={drawer} />
      {/* 附件：懒加载，插图区下面；拖进来、粘贴进来的图片照插图插进这一条。手机整页时贴卡片底部，正文写长了跟着往下推 */}
      <div className={styles.files} data-testid="note-edit-files">
        <Suspense fallback={null}>
          <Attachments noteId={noteId} disabled={off} onImages={onImages} />
        </Suspense>
      </div>
    </>
  );
  return drawer ? (
    <section className={styles.inDrawer} data-testid="note-edit">
      {head}
      {paper}
      {acts.dialogs}
    </section>
  ) : (
    <main className={styles.page} data-feature="notes" data-testid="note-edit">
      {head}
      {/* 标题、细线、正文、图、附件装进一张卡片，撑到页底；“图片”“拍照”和文档提示在底部浮动工具条 */}
      <div className={styles.sheet} data-testid="note-edit-sheet">
        {paper}
      </div>
      <EditDock img={img} disabled={off} />
      {acts.dialogs}
    </main>
  );
}

/** “⋯”菜单的转换、移进隐私记：和列表页同一套（NotesActions 的 useNoteActs）；结果出在编辑页的提示行（tip），不出页底提示条 */
function useEditMenu(readonly: boolean, leave: () => void) {
  const [tip, setTip] = useState<EditTip | null>(null);
  const { convert, tooLong, sizes } = useNoteConvert();
  const report = (r: ActionResult): void => setTip(r === 'failed' ? { kind: 'err', key: 'notes.err.save' } : r === 'readonly' ? { kind: 'err', key: 'notes.img.err.readonly' } : null);
  const acts = useNoteActs(convert, { isRo: () => readonly, report, g: { show: setTip, block: () => undefined } }, leave);
  return { tip, setTip, acts, tooLong, sizes };
}

/** 手机整页底部浮动工具条：“图片”“拍照”+ 右侧文档提示（attachments 懒加载，电脑布局不出） */
function EditDock({ img, disabled }: { img: EditorImgs; disabled: boolean }) {
  return (
    <div className={styles.dock} data-testid="note-edit-dock">
      <EditorPicks ed={img} disabled={disabled} className={styles.tb} />
      <Suspense fallback={null}>
        <AttPhoneHint hint className={styles.dockHint} />
      </Suspense>
    </div>
  );
}

/** 顶栏的分类胶囊（如“工作灵感 AI ▾”）：色点 + 名字 + AI + ▾。
 *  外观是 kit 的 Chip.module.css（高 30、无描边浅底），本页只补省略和下拉；色点、AI 小标用列表页那一份 */
function CatChip(p: { value: string | null; options: CategoryOption[]; ai: boolean; disabled: boolean; muted: boolean; drawer: boolean; onChange(v: string | null): void }) {
  const t = useNotesT();
  const cur = p.options.find((c) => c.id === p.value) ?? null;
  const name = cur ? cur.name : t('note.edit.noCategory', {});
  const label = t('note.edit.category', {});
  // 不用原生 select（iOS 系统菜单）：胶囊本身是按钮，点了弹 kit 的 PickPopover（同一套小胶囊单选，点一下选中就收起）
  const trigger = (
    <button
      type="button"
      className={`${chip.chip} ${notes.catChip} ${styles.cat}${p.drawer ? ` ${styles.chipStart}` : ''}`}
      data-muted={p.muted || undefined}
      disabled={p.disabled}
      aria-label={`${label} ${name}`}
      data-testid="note-edit-category"
    >
      {/* 色点、AI 小标和列表页同一份；胶囊上的间距、AI 底色调整在 NotesPage.module.css 的 .catChip */}
      <Dot color={cur?.color ?? null} />
      <span className={styles.chipName}>{name}</span>
      {p.ai ? <AiMark testId="note-edit-ai" /> : null}
      <span className={styles.caret} aria-hidden="true">
        ▾
      </span>
    </button>
  );
  return (
    <PickPopover
      trigger={trigger}
      label={label}
      value={p.value ?? NONE}
      options={[{ value: NONE, label: t('note.edit.noCategory', {}) }, ...p.options.map((c) => ({ value: c.id, label: c.name }))]}
      onPick={(v) => p.onChange(v === NONE ? null : v)}
      testId="note-edit-category-opts"
      align="start"
    />
  );
}
