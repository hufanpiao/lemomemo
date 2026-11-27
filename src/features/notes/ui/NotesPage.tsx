// 随手记页：列表和瀑布流（手机两列、窗口 ≥ 900px 三列）两种显示；页面上没有切换按钮，只在“设置 › 随手记显示方式”里改，按设备类型分开记（hooks/useNotesView.ts）
// • 两种显示同一套外层：按时间排时按今天 / 昨天 / 日期分组（右边等宽条数），每组里放列表或瀑布流；自己排时不分组、一整串
// • 顶部：大标题（短粗下划线 + 下一行等宽小字“日期 · 共 N 条”）+ 右上角头像（设置入口；电脑上设置在侧栏，这里藏掉）；下面分类胶囊（kit Chip）只筛这一页，不写 settings
// • 一行、一张卡的画法在 ./NoteItems.tsx；这一页给它们点开、菜单、左滑、拖动标记和时间文字。
//   时间：按天分组时只写时刻；自己排时写日期（卡片只写短日期，今天、昨天写“昨天 00:07”）；刚记下的写“刚记下”
// • 点开：手机进编辑器 #/note/<id>；网页版宽屏（MQ_DESK_WIDE）从右边滑出详情抽屉，Esc 或“×”关；开着哪一条由 kit 的 useDrawerSel 管
// • 网页版宽屏：kit DeskHead 页头（标题、“N 条 · 今天记了 N 条”、分类胶囊），下面整块是同一份列表，底下输入行；右边 AI 助手栏是 ai-chat 的 ChatHost 挂的
// • “⋯”和鼠标右键打开同一个菜单（触屏长按是拖动排序；只有不能拖的只读行、下拉搜索筛着时长按才出系统菜单）：
//   转成待办 / 转成日程 / 删除、移到隐私记；瀑布流里不能左滑，列表能左滑
// • 转成待办 / 日程：规则见 shared/logic/notes/note-convert.ts 文件头；转完在输入行上面出一句提示
// • 合并分类提示：分类胶囊下面一张浅底条，哪几对由 hooks/useMergeHint.ts 给，一次只出一对；合并成了底部出 5 秒撤销条（和删除同一个 UndoBar），
//   撤销就当点了“不用”（记进 notes.merge_dismissed），被合并的分类回到 merged_into: null（data 的 undoMerge）；写入期间提示条两个按钮禁用
// • 删除：软删，进“最近删除”，出 5 秒撤销条
// • 底部输入行（ui/NotesInputRow.tsx）：右边“图片”，打了字或挂了图才出“记下”；回车或点“记下”就存，新的一条出现在最上面。
//   选了图先挂在输入行上方成待记下的小图，点“记下”时用输入框里的字（可以空）新建一条，再把图依次插进去（ui/NoteImages.tsx）。电脑上输入行铺满内容栏、左右各留 22px
// • 插图：瀑布流卡片顶部放第一张（16:10、右上角“+N”）；插入、上传失败出提示条，空间满了的带“最近删除”入口
// • 底栏 / 侧栏的“＋”在这一页把光标放进输入行：输入行挂着时往 kit/state/new-item.ts 的 notesInput 登记聚焦，app/App.tsx 调它
// • 输入行是贴底浮条，原地聚焦（规则在 platform/in-place-focus.ts 文件头）：“＋”调 focusInPlace，输入框挂 inPlaceTouchStart / inPlaceTouchEnd，
//   form 挂 keepFieldFocus（点“记下”“图片”不让输入框失焦）；记下之后主动失焦、收起键盘，输入行回到底部（不是继续记下一条）
// • 输入框有焦点时整页盖一层模糊玻璃（kit Mist）：层级用令牌 --z-notes-mist（在输入行下面），输入行、底栏、提示条都在它上面；
//   点模糊处只让输入框失焦收键盘，字留着；运行日志 notes mist on/off
// • 只读行（带认不出的值，core 的 readonlyIds）：标“要新版本”，菜单里“删除”变淡；点开、删除统一拦下（不进编辑器、不开抽屉、不写），
//   出 kit 的“这条要新版本才能修改 · 更新”（删除撤销、只读拦截、出错条走 kit 的 useListActions，插图提示和输入行上移在 hooks/useNotesToast.ts）
// • 动效：AppearList（增删淡入淡出）、Pressable（按下反馈）、长按拖动 kit SortDrag；抽屉只有最基本的滑入
// • 隐私记：分类胶囊下面一行入口（vault 的 VaultParts lockrow）；“⋯”菜单、左滑（列表方式，kit 的 SwipeRow）加“移到隐私记”，
//   移的流程（解锁、重试一次、带附件不能移）在 vault 的 VaultParts move；移好的先在本页藏起来，等同步把它改成隐私记行
// • 数据来源（hooks/note-source.ts）：隐私记页经 NotesSurface 用同一个列表，来源换成隐私记的内存仓库；两边不同的只按来源的 caps 分，
//   标题、空态、编辑页路由、电脑布局存的页名也由来源给；head 给了就画它、不画本页大标题和头像；head 的参数是要放进顶栏的“最近删除”图标、正筛着的分类名
// • “最近删除”入口：随手记页不放，从设置首页进 #/trash/notes；图片报错提示里的“去最近删除”链接照旧。
//   隐私记页（caps.trashLink）的 TrashLink 由 head(trash) 放进它自己顶栏（隐私记要解锁后才能看，不挪到设置）
// • 下拉搜索：滚到顶再往下拉露出搜索框（kit usePullReveal 管手势和字，smart-search 的 PullSearch 画框）；打了字本页藏起来，
//   结果（日程、待办、随手记混在一起）在搜索框下面列，手机、电脑同一处 listPart；隐私记页不接
// • 长按拖动排序（kit useSortDrag，隐私记页同一份）：瀑布流（横竖都跟）和列表都能拖；按住 0.4 秒没动才拿起，动了交给左滑或滚动；
//   拿起的那一条浮起来，行尾“⋯”换成 6 个点（kit SortEnd），其他行让位。拖动中按 sd.preview 的预览顺序画（按天分组时拿着的那一条算进前一条那一天），
//   放下按页面上的顺序算排序值（data/note-sort.ts）。按时间排时拖了一次就切到“自己排”，出“已切到自己排，设置里可改回 · 撤销”；
//   之后每次放下出“已移动 · 撤销”。只读行不能拖；运行日志 sort notes|vault lift / drop / cancel（kit 记，只记条数）
import { fx } from '../../../platform/fx-api.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { Suspense, useRef, useState, type ReactNode } from 'react';
import { fmtDay, fmtTime } from '../../../../shared/i18n/fmt.ts';
import { navigate, useRoute } from '../../../app/router.ts';
import { dockOf } from '../../../app/router-levels.ts';
import { todayOf } from '../../../../shared/core/date.ts';
import { groupLabelClass } from '../../../kit/components/Form.tsx';
import list from '../../../kit/components/List.module.css';
import refine from '../../../kit/components/Refine.module.css';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { SortBox, useSortDrag } from '../../../kit/components/SortDrag.tsx';
import { useSortDropFlow } from '../../../kit/hooks/useSortDropFlow.ts';
import { Mist } from '../../../kit/components/Mist.tsx';
import { useDrawerSel, useListActions } from '../../../kit/hooks/useListActions.ts';
import { usePullReveal } from '../../../kit/hooks/usePullReveal.ts';
import { PullSlot } from '../../../kit/components/PullSlot.tsx';
import { MQ_DESK_WIDE, useMedia } from '../../../kit/hooks/useMedia.ts';
import { DeskHead, deskFrameOf, deskTitle } from '../../../kit/components/Desk.tsx';
import { ReadonlyToast } from '../../../kit/components/ReadonlyRow.tsx';
import { useEditT } from '../../../kit/components/EditNotices.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { AppearItem, AppearList } from '../../../motion/components.ts';
import { PullSearch } from '../../smart-search/index.ts';
import { VaultParts } from '../../vault/index.ts';
import { useNoteSource } from '../hooks/note-source.ts';
import { useMergeHint } from '../hooks/useMergeHint.ts';
import { useNoteList, type CategoryCtl, type NoteItem } from '../hooks/useNoteList.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import { isUndo, mergeUndo, moveUndo, noteBarUp, undoTipOf } from '../hooks/useNotesToast.ts';
import { useNotesViewValue } from '../hooks/useNotesView.ts';
import { NoteDrawer } from './NoteDrawer.tsx';
import NoteEditPage from './NoteEditPage.tsx';
import { useAddImage } from './NoteImages.tsx';
import { NoteCard, NoteListRow, type ItemCtx } from './NoteItems.tsx';
import { MergeBar, MoreMenu, swipeActs, useNoteActs, type PageTip } from './NotesActions.tsx';
import { CatChips } from './CatChips.tsx';
import { useCategoryDialogs } from './CategoryDialogs.tsx';
import { ImportLoose } from './ImportLoose.tsx';
import { DockTip, SyncAck, TrashLink, UndoBar } from './NotesBits.tsx';
import { InputRow, useInputDraft } from './NotesInputRow.tsx';
import { noteAtText, noteDayText } from './note-time.ts';
import row from '../../../kit/components/NoteRow.module.css';
import styles from './NotesPage.module.css';

/** 拖动中拿着的那一条算进它此刻前一条（排第一时后一条）那一天（按天分组时跟着预览顺序挪进别的组）；没拖原样 */
function withHeldDay(items: readonly NoteItem[], held: string | null): readonly NoteItem[] {
  const i = held === null ? -1 : items.findIndex((x) => x.id === held);
  const nb = items[i - 1] ?? items[i + 1];
  return i < 0 || !nb ? items : items.map((x, k) => (k === i ? { ...x, date: nb.date } : x));
}

/** #/notes 是列表，#/note/<id> 是编辑器：两条路由同一个分包（index.ts，守首屏额度），这里按路由名分 */
export default function NotesPage() {
  return useRoute().name === 'note' ? <NoteEditPage /> : <NotesList />;
}

/**
 * head：顶上替换大标题的一块；
 * cat：外面管的分类筛选（隐私记 #/vault/c/<id>，见 useNoteList）
 */
export function NotesList({ head, cat }: { head?: ((trash: ReactNode, catName: string | null) => ReactNode) | undefined; cat?: CategoryCtl | undefined }) {
  const t = useNotesT();
  const src = useNoteSource();
  const { caps } = src;
  // 隐私记“没保存上”的条目：列表层订一次，传给每张卡片、每一行
  const { failed } = src.useSync();
  const tEdit = useEditT();
  const locale = useUi((s) => s.locale);
  const view = useNotesViewValue();
  // 网页版宽屏：点开随手记用右边抽屉，不换页（kit useListActions.ts 的 useDrawerSel，同今天页）
  const ds = useDrawerSel<{ id: string }>(useMedia(MQ_DESK_WIDE));
  const desk = ds.on;
  const l = useNoteList(undefined, cat);
  // 分类弹窗（新建、改名删除）挂一份：分类那一排经它开
  const cd = useCategoryDialogs(l);
  const a = useListActions<PageTip>('notes', { remove: l.remove, useRo: src.useReadonly });
  const { g: guard, g: { toast }, isRo, report } = a;
  // 撤销条还在的那一对，提示条先不出
  const merge = useMergeHint(toast?.kind === 'mergeUndo' ? toast.pair : null, caps.merge);
  const up = noteBarUp(guard);
  const bar = isUndo(toast) ? { tip: undoTipOf(toast, a.undo), close: () => guard.dismiss(toast) } : null;
  // 输入框有焦点时画模糊层；点模糊层让输入框失焦
  const field = useRef<HTMLInputElement>(null);
  // 输入行的字和小图放在页面这一层：电脑版、手机排法互换时输入行会重挂
  const draft = useInputDraft();
  const [typing, setTyping] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [just, setJust] = useState<string | null>(null);
  // 移到隐私记、转成待办 / 日程：NotesActions 的 useNoteActs（编辑页“⋯”同一套）；移好的先在本页藏起来，等同步把它改成隐私记行
  const [moved, setMoved] = useState<ReadonlySet<string>>(() => new Set());
  const acts = useNoteActs(l.convert, a, (id) => setMoved((s) => new Set(s).add(id)));

  const selId = ds.sel?.id;
  const open = (id: string) => (isRo(id) ? guard.block() : ds.open({ id }, () => void navigate(src.route.edit, id)));
  const pull = usePullReveal('notes', src.caps.search);
  const pullRef = pull.ref;
  const del = (id: string) => {
    setMenu(null);
    ds.forget(id);
    void a.del(id);
  };
  const toVault = (id: string) => {
    setMenu(null);
    acts.toVault(l.items.find((x) => x.id === id) ?? { id, images: 0, files: 0 });
  };
  const shown = (it: NoteItem) => !moved.has(it.id);
  /** 移出隐私记（隐私记来源）：没移成出提示 */
  const moveOut = (id: string) => {
    setMenu(null);
    ds.forget(id);
    void src.moveOut(id).then((r) => (r === 'failed' ? guard.show({ kind: 'moveOut' }) : report(r)));
  };
  const addImage = useAddImage(l, setJust, report, (m) => guard.show({ kind: 'img', ...m }));
  const add = async (text: string): Promise<boolean> => {
    const { result, id } = await l.add(text);
    if (result === 'ok') setJust(id);
    else report(result);
    return result === 'ok';
  };

  // 时间怎么写（见文件头）：按天分组时组名已有日期；自己排时没有组名，行、卡片自己带日期
  const manual = l.order === 'manual';
  /** 正筛着的分类名（没筛为 null）：交给 head，隐私记分类列表顶栏写它（按这一套分类算的，不串到另一套） */
  const catName = l.counts.find((c) => c.id === l.category)?.name ?? null;
  /** 宽屏页头小字“今天记了 N 条”（当前筛选下） */
  const todayN = l.items.filter((x) => l.dayOf(x.createdAt) === 'today').length;
  /** 一条记录的日期文字（今天 / 昨天 / 11月13日）：导入弹窗用 */
  const dayText = (it: NoteItem): string => noteDayText(t, locale, l.dayOf(it.createdAt), it.date, 'monthDay');
  /** 列表行标题右边：刚记下 / 时刻（分组时）/ 今天 11:40、昨天 21:15、10月21日（自己排时） */
  const rowTime = (it: NoteItem): string => {
    if (it.id === just) return t('notes.just', {});
    const hm = fmtTime(it.createdAt, l.tz);
    if (!manual) return hm;
    return noteAtText(t, locale, { kind: l.dayOf(it.createdAt), hm, date: it.date });
  };
  /** 卡片底行的日期：刚记下 / 分组时不写（null）/ 今天、昨天、11/13（自己排时，窄卡只写短的） */
  const cardDay = (it: NoteItem): string | null => (it.id === just ? t('notes.just', {}) : manual ? noteDayText(t, locale, l.dayOf(it.createdAt), it.date, 'num') : null);

  const more = (it: NoteItem) => (
    <MoreMenu
      id={it.id}
      caps={caps}
      ro={isRo(it.id)}
      open={menu === it.id}
      onOpenChange={(o) => setMenu(o ? it.id : null)}
      onDelete={() => del(it.id)}
      long={menu === it.id && l.tooLong(it.id)}
      onConvert={(kind) => {
        setMenu(null);
        acts.convert(it, kind);
      }}
      onMove={() => toVault(it.id)}
      onMoveOut={() => moveOut(it.id)}
    />
  );
  // 页面上这一串：移走的不画（下拉搜索打了字整页藏起来，不在这里筛）；放下时按它算（和 DOM 顺序一致）
  const visible = l.items.filter(shown);
  // 长按拖动：只读行行上已 data-sort-off，kit 的流程里再兜一道；没写成整批撤回（切过的排序方式也切回）
  const dropped = useSortDropFlow({
    tag: src.kind,
    log: rlog,
    ro: isRo,
    block: () => guard.block(),
    order: () => visible.map((x) => x.id),
    move: (m) => l.move(visible, m.id, m.index),
    undo: l.undoMove,
    report,
    moved: (m) => guard.show(moveUndo(m.switched, () => void l.undoMove(m).then(report)), null),
  });
  // 拖进分类：列表拖到分类胶囊，只能拖没分类的
  const into = {
    // 没筛分类时（全部）这一条在 items 里；筛着某一类时没分类的不在 items、在 loose 里（导入弹窗列的就是它们）
    ok: (id: string) => !isRo(id) && (l.items.find((x) => x.id === id) ?? l.loose.find((x) => x.id === id))?.categoryId === null,
    drop: (id: string, cid: string) => void l.moveInto([id], cid).then((r) => (r.failed ? report('failed') : undefined)),
  };
  const sd = useSortDrag({ tag: src.kind, axis: view === 'masonry' ? 'xy' : 'y', onDrop: dropped, log: rlog, fx, into });
  // 拖动中按预览顺序画（拿着的那一条在落点处占位）
  const shownItems = sd.preview(visible, (x) => x.id);
  // 按时间排时按天分组：拖动中拿着的那一条算进它此刻前一条（排第一时后一条）那一天，跟着预览顺序挪进别的组
  const days = manual ? null : l.byDay(withHeldDay(shownItems, sd.held));
  /** 每一行、每一张卡要的（ui/NoteItems.tsx） */
  const ctx: ItemCtx = {
    selId,
    failed,
    isRo,
    open,
    menuKey: (id) => (e) => {
      e.preventDefault();
      setMenu(id);
    },
    more,
    // 能拖的行、卡片上的标记（整页一串；只读、下拉搜索筛着时不能拖）
    sortAttrs: (it) => sd.attrs(it.id, isRo(it.id)),
    swipe: (it) => swipeActs(t, caps, it.id, { todo: () => acts.convert(it, 'todo'), vault: () => toVault(it.id), out: () => moveOut(it.id), del: () => del(it.id) }),
    rowTime,
    cardDay,
  };
  /** 一组里（或自己排时整串）的条目：列表一块白面板，瀑布流两列 */
  const block = (items: readonly NoteItem[]) =>
    view === 'masonry' ? (
      <AppearList as="ul" className={styles.mason}>
        {items.map((it) => <NoteCard key={it.id} it={it} c={ctx} />)}
      </AppearList>
    ) : (
      <AppearList as="ul" className={days === null ? `${row.lst} ${styles.flat}` : row.lst}>
        {items.map((it) => <NoteListRow key={it.id} it={it} c={ctx} />)}
      </AppearList>
    );
  const listTestId = view === 'masonry' ? 'notes-mason' : 'notes-list';

  // 筛着某一类时“导入没分类的 N 条”：手机在分类胶囊下面，电脑在列表块顶上
  const importRow = <ImportLoose key={l.category ?? ''} l={l} day={dayText} can={into.ok} />;
  const filterChips = (
    <>
      <CatChips l={l} cd={cd} className={styles.filter} />
      {importRow}
    </>
  );
  // 顶部提示（隐私记入口行、同步提示、合并提示）和列表区（空态、瀑布流或列表）：手机直接画在页上，电脑放进 list 块；首页只换列表区
  const tips = (
    <>
      {/* 隐私记入口行（分类胶囊下面、合并提示上面；两种显示方式都有）；隐私记页里不出 */}
      {caps.lockrow ? (
        <QuietBoundary name="vault-lockrow">
          <Suspense fallback={null}>
            <VaultParts part="lockrow" />
          </Suspense>
        </QuietBoundary>
      ) : null}
      <SyncAck />

      {merge ? <MergeBar hint={merge} onResult={report} onMerged={(h) => guard.show(mergeUndo(h.key, () => void h.undo().then(report)), null)} /> : null}
    </>
  );
  const body = (
    <>
      {tips}
      {l.items.length === 0 ? (
        <p className={list.empty} data-testid="notes-empty">
          {src.text?.empty ?? t('notes.empty', {})}
        </p>
      ) : null}

      <SortBox sd={sd}>
      {days === null ? (
        // 自己排：不按天分组，一整串
        <div data-testid={listTestId}>{block(shownItems)}</div>
      ) : (
        <AppearList as="div" data-testid={listTestId}>
          {days.map(({ items, ...g }) => (
            <AppearItem as="section" key={g.date} className={styles.group} data-testid={`notes-g-${g.date}`}>
              {/* 分组名小字、加字距，右边等宽条数（同待办页分组：kit groupLabelClass；瀑布流也分组） */}
              <h2 className={`${groupLabelClass} ${styles.h2}`}>
                <span>{noteDayText(t, locale, g.key, g.date, 'monthDay')}</span>
                <span className={styles.cnt}>{items.length}</span>
              </h2>
              {block(items)}
            </AppearItem>
          ))}
        </AppearList>
      )}
      </SortBox>

    </>
  );
  const dock = (
      <div className={up ? `${styles.dock} ${styles.dockUp}` : styles.dock}>
        <InputRow field={field} state={draft} onTyping={setTyping} onAdd={add} onImages={addImage} tip={toast !== null && !isUndo(toast) ? <DockTip toast={toast} /> : null} />
      </div>
  );
  const mist = typing ? <Mist onTap={() => field.current?.blur()} tag="notes" log={rlog} testId="notes-mist" className={styles.mist} /> : null;
  // 手机版、宽屏同一处（宽屏的分类胶囊在页头，这里只放“导入没分类的”）：“搜索”、搜索框在列表上面，打了字本页藏起来、换成日程待办随手记三类的结果
  const listPart = (top: ReactNode) => (
    <PullSlot pull={pull} keyLabel={t('notes.pullKey', {})} search={<PullSearch pull={pull} own={{ kind: 'note', open }} />}>
      {top}
      {body}
    </PullSlot>
  );
  const phone = (
    <>
      {head ? (
        head(src.caps.trashLink ? <TrashLink /> : null, catName)
      ) : (
        <>
          {/* 大标题 + 短粗下划线、标题下一行等宽小字（今天的日期 · 共几条），同待办页（kit Refine.module.css） */}
          <header className={styles.top}>
            <h1 className={refine.title}>{t('notes.title', {})}</h1>
            <span className={styles.topEnd}>
              <MeLink testId="notes-settings" />
            </span>
          </header>
          <p className={refine.sub} data-testid="notes-sub">
            {t('notes.sub', { date: fmtDay(todayOf(l.now, l.tz), locale, 'monthDayWeek'), n: l.total })}
          </p>
        </>
      )}
      {listPart(filterChips)}
      {mist}
      {dock}
    </>
  );

  // 网页版宽屏：页头“随手记 / 12 条 · 今天记了 1 条”，右边分类胶囊；下面整块是列表（瀑布流三列），
  // 底下照旧是输入行（侧栏“＋”聚焦它）；点开一条在右边详情抽屉里编辑。隐私记页（来源自带顶栏 head）顶栏照旧，分类胶囊放回列表上面
  const deskHead = head ? (
    head(src.caps.trashLink ? <TrashLink /> : null, catName)
  ) : (
    <DeskHead
      title={<h1 className={deskTitle}>{src.text?.title ?? t('notes.title', {})}</h1>}
      sub={<span data-testid="notes-sub">{t('notes.dkSub', { n: l.total, d: todayN })}</span>}
      tools={<CatChips l={l} cd={cd} className={`${styles.filter} ${styles.dkFilter}`} />}
    />
  );

  return (
    <main ref={pullRef} className={desk ? `${styles.page} ${deskFrameOf(dockOf(src.kind))}` : styles.page} data-feature={src.kind} data-testid={src.kind === 'vault' ? 'vault-notes' : 'notes'} data-view={view}>
      {desk ? (
        <>
          {deskHead}
          <div className={styles.dkBody}>{listPart(head ? filterChips : importRow)}</div>
          {mist}
          {dock}
          {selId ? <NoteDrawer id={selId} side="right" handle={null} onClose={ds.close} /> : null}
        </>
      ) : (
        phone
      )}
      {cd.dialogs}
      {acts.dialogs}

      {bar ? <UndoBar key={bar.tip.key} tip={bar.tip} onClose={bar.close} /> : null}
      <ReadonlyToast guard={guard} message={tEdit('edit.st.readonly', {})} testId="notes-ro-toast" />
    </main>
  );
}

