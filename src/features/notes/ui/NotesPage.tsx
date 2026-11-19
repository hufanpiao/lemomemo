// 随手记页（B4 S1、S2；交互照定稿线框 s7（第 873～907 行）、R-78（第 528 行），视觉照皮肤视觉稿 notesHead / PH.mason / PH.notes / DK.mason / DK.notes）
// • 两种显示：列表（默认；负责人 11-18 首装默认改列表，原来是瀑布流）和瀑布流（手机两列、窗口 ≥ 900px 三列）；页面上没有切换按钮，
//   只在“设置 › 随手记显示方式”里改，按设备类型分开记（R-78，hooks/useNotesView.ts）。
//   两种显示同一套外层（R-463）：按时间排时按今天 / 昨天 / 日期分组（组名同一种样式、右边条数），每组里放列表或两列瀑布流；自己排时不分组、一整串
// • 顶部：大标题 + 右上角头像（设置入口，同今天页；电脑上设置在侧栏，这里藏掉）；下面分类胶囊：全部 N + 各分类条数，只筛这一页（不写 settings）
//   R-436 精致化照待办页（518f49a0）：大标题短粗下划线 + 下一行等宽小字（日期 · 共 N 条），胶囊用 kit Chip（条数等宽淡色），列表分组名挂 kit groupLabelClass、右边等宽条数，列表行时刻、卡片底行日期都用等宽字（R-463 起卡片只在自己排时写“11/13”这类短日期，分类名放不下照省略）
// • 卡片 / 行：没有标题时取正文第一行当标题；分类前有 6px 色点（categories.color）；AI 分过、还没看过的标“AI”
//   瀑布流卡片底行（R-463 瀑布流二）：“● 分类 AI …… ⋯”一行小字、不要胶囊底色；按天分组时卡片里不写日期，自己排时补“· 11/13”（今天、昨天写字）
//   （“⋯”看得见 24px，点按区用 ::after 透明扩到 44，不占排版宽度）
//   列表一行（R-463 列表一）：标题 …… 时间 | 缩略图 | “⋯”，第二行“● 摘要 · 分类 AI”；左边日期栏和纸片小图标去掉了。
//   时间：按天分组时只写时刻；自己排时写日期（“11月13日”，今天、昨天写“昨天 00:07”）；刚记下的写“刚记下”
// • 点开：手机进编辑器 #/note/<id>；电脑（≥ 900px，有侧栏，电脑版换上以后）从右边滑出详情抽屉（DK.mason），侧栏和列表留着，Esc 或“×”关；
//   开着哪一条由 kit 的 useDrawerSel（在 useListActions.ts）管（同今天页）：电脑版没换上、画出错退回手机排法时点开进编辑页
// • “⋯”打开菜单；鼠标右键也打开同一个菜单（触屏长按是拖动排序，R-429；只有不能拖的只读行、下拉搜索筛着时长按才出系统菜单）。
//   菜单：转成待办 / 转成日程 / 删除（S8，R-414）、移到隐私记（B5）；瀑布流里不能左滑（R-78），列表能左滑（见下面“隐私记”一条）
// • 转成待办 / 日程（R-414）：规则见 shared/logic/notes/note-convert.ts 文件头；转完在输入行上面出一句提示（同插图提示的位置）
// • 合并分类提示（S7，R-413；线框 MERGE）：分类胶囊下面一张浅底条“‘读书’和‘书单’两个分类很像，合成一个吗？ 合并 / 不用”，
//   哪几对由 hooks/useMergeHint.ts 给（AI 判的 + 本机规则），一次只出一对；点“合并”成了底部出 5 秒撤销条“已合并 · 撤销”（R-415 ③，和删除同一个 UndoBar），
//   撤销就当点了“不用”（这一对记进 notes.merge_dismissed），被合并的分类回到 merged_into: null（data 的 undoMerge）；写入期间提示条两个按钮禁用
// • 删除：软删，进“最近删除”，出 5 秒撤销条
// • 底部输入行（视觉稿 .inrow、线框 COMPOSER；ui/NotesInputRow.tsx）：右边是“图片”，打了字或挂了图才出“记下”；回车或点“记下”就存，新的一条出现在最上面、时间写“刚记下”。
//   选了图（R-416）：先挂在输入行上方成待记下的小图（可点“×”去掉、可再加），点“记下”时用输入框里的字（可以空）新建一条随手记，再把图依次插进去（S3，ui/NoteImages.tsx）。电脑上输入行铺满内容栏、左右各留 22px（DK.notes）
// • 插图（S3）：瀑布流卡片顶部放第一张（16:10、右上角“+N”）；插入、上传失败出提示条，空间满了的带“最近删除”入口
// • 底栏 / 侧栏的“＋”在这一页直接把光标放进输入行（R-380，线框“低 1”）：输入行挂着时往 kit/state/new-item.ts 的 notesInput 登记聚焦，app/App.tsx 调它
// • 输入行是贴底浮条（position: fixed），聚焦一律原地聚焦（台账 Q-8，platform/viewport.ts 文件头）：“＋”调 focusInPlace，输入框挂 inPlaceTouchStart / inPlaceTouchEnd；
//   form 挂 onMouseDown={keepFieldFocus}（台账 Q-25）：点“记下”“图片”不让输入框失焦，按钮第一下就点得动；记下（回车或点“记下”）之后主动失焦、收起键盘，
//   输入行回到底部（R-416，负责人 11-13：记下后输入框应该消失，不是继续记下一条）
// • 输入框有焦点时后面整页盖一层液态模糊玻璃（R-401，负责人 11-13“随手记点输入框背景也要模糊”；和打字条 R-399 同一个 kit Mist，16px）：
//   放在 .dock 旁边、层级用令牌 --z-notes-mist（在输入行下面，NotesPage.module.css .mist），输入行、底栏、提示条都在它上面；
//   点模糊处只让输入框失焦收键盘（输入行一直在，没有“收起”；同 R-399 打了字时的做法），字留着；运行日志 notes mist on/off
// • 插图补充：列表行有图时在“⋯”前放缩略图；输入行只有“图片”（拍照在编辑页）
// • 只读行（S12，R-148，TC-B4-09；照待办页）：带认不出的值的行（core 的 readonlyIds）标“要新版本”（单独一行：瀑布流在正文下、底行上，列表在摘要行下），菜单里的“删除”变淡；点开、删除统一拦下
//   （不进编辑器、不开抽屉、不写），出 kit 的“这条要新版本才能修改 · 更新”（删除撤销、只读拦截、出错条走 kit 的 useListActions，插图提示和输入行上移在 hooks/useNotesToast.ts）。
//   左滑、多选还没有入口，以后加时同样先判只读
// • 动效：AppearList（增删淡入淡出）、Pressable（按下反馈）、长按拖动 kit SortDrag（浮层 motion/sort-float，让位弹簧 motion/sort-spring，R-461）；抽屉只有最基本的滑入（R-376）
// • 隐私记（B5 S5、S7）：分类胶囊下面一行入口（vault 的 VaultParts lockrow）；“⋯”菜单、左滑（列表方式，kit 的 SwipeRow；一次只露一行、点别处或 Esc 收起由 kit 管）加“移到隐私记”，
//   移的流程（解锁、重试一次、带附件不能移）在 vault 的 VaultParts move；移好的先在本页藏起来，等同步把它改成隐私记行
// • 数据来源（B5 隐私记重写 11-15，hooks/note-source.ts）：隐私记页经 NotesSurface 用同一个列表，来源换成隐私记的内存仓库；
//   两边不一样的只按来源的 caps 分（入口行、合并提示、转成待办 / 日程、移到 / 移出隐私记），标题、空态、编辑页路由、电脑布局存的页名也由来源给；
//   head 给了就画它、不画本页的大标题和头像（隐私记页的“‹ 随手记 | 🔒 隐私记 | 立即锁上”）；head 是函数，参数是要放进顶栏的“最近删除”图标（电脑版传 null）
// • “最近删除”入口（R-441 负责人 11-16“代办页跟随手记页的删除按钮去掉，删除确认放在设置页”，取代 R-438）：随手记页手机版顶栏、电脑版分类栏标题右边都不放，
//   改从设置首页“最近删除”一组的“随手记”一行进 #/trash/notes；图片报错提示里的“去最近删除”行内链接照旧。
//   隐私记页不变：NotesBits 的 TrashLink 由 head(trash) 放进它自己顶栏右边（手机版），电脑版放在分类栏标题右边（隐私记要解锁后才能看，不挪到设置）
// • 下拉搜索（R-437）：滚到顶再往下拉，标题下面露出一条扁搜索框（kit 的 usePullReveal 管手势和打的字，smart-search 的 PullSearch 画搜索框、条数和“用 AI 按意思找”）；
//   R-447（负责人 11-17 选 S-B“原列表筛选”）：打了字瀑布流 / 列表照原样留着，只画命中的（按标题、正文、分类，kit 的 pull.shows），标题、摘要里命中的字加短下划线（kit PullHit），
//   没有命中的日期组不画；分类胶囊照样筛（手机版、电脑版同一处 listPart）。筛着的时候不能拖动排序（落点按整串算，筛掉的会被挤乱）。隐私记页不接（隐私记不搜）
// • 长按拖动排序（R-429；R-461 整块重写：C“让位加倾斜”、摆法 1；隐私记页同一份）：kit 的 useSortDrag，瀑布流（两列，横竖都跟）和列表都能拖；按住 0.4 秒没动才拿起，
//   动了交给左滑或滚动；拿起的那一张、那一行浮起来，行尾“⋯”那一格换成 6 个点（kit SortEnd），其他行让位。整页是一串：
//   拖动中按 sd.preview 的预览顺序画（按天分组时拿着的那一条算进前一条那一天），放下按页面上的顺序算排序值（data/note-sort.ts）。
//   按时间排时拖了一次就切到“自己排”（不按天分组、列表行的时间带日期；设置 › 随手记显示方式里可切回），提示条“已切到自己排，设置里可改回 · 撤销”；
//   之后每次放下出“已移动 · 撤销”（和删除、合并同一个 UndoBar）。只读行不能拖；运行日志 sort notes|vault lift / drop / cancel（kit 记，只记条数）
import { opensKeyboard } from '../../../platform/env.ts';
import { fx } from '../../../platform/fx-api.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { Suspense, useCallback, useRef, useState, type ReactNode } from 'react';
import { fmtDay, fmtTime } from '../../../../shared/i18n/fmt.ts';
import { navigate, useRoute } from '../../../app/router.ts';
import { todayOf } from '../../../../shared/core/date.ts';
import { groupLabelClass } from '../../../kit/components/Form.tsx';
import list from '../../../kit/components/List.module.css';
import refine from '../../../kit/components/Refine.module.css';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { SwipeRow } from '../../../kit/components/SwipeRow.tsx';
import { SortBox, SortEnd, sortRowClass, useSortDrag } from '../../../kit/components/SortDrag.tsx';
import { useSortDropFlow } from '../../../kit/hooks/useSortDropFlow.ts';
import { Mist } from '../../../kit/components/Mist.tsx';
import { useDrawerSel, useListActions } from '../../../kit/hooks/useListActions.ts';
import { usePullReveal } from '../../../kit/hooks/usePullReveal.ts';
import { PullHit, PullSlot } from '../../../kit/components/PullSlot.tsx';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { ReadonlyToast } from '../../../kit/components/ReadonlyRow.tsx';
import { useEditT } from '../../../kit/components/EditNotices.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { AppearItem, AppearList, useSwapWhenSafe } from '../../../motion/components.ts';
import { PullSearch } from '../../smart-search/index.ts';
import { VaultParts } from '../../vault/index.ts';
import { useNoteSource } from '../hooks/note-source.ts';
import { useMergeHint } from '../hooks/useMergeHint.ts';
import { useNoteList, type CategoryCount, type CategoryCtl, type NoteItem } from '../hooks/useNoteList.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import { isUndo, mergeUndo, moveUndo, undoTipOf, useNotesToast } from '../hooks/useNotesToast.ts';
import { useNotesViewValue } from '../hooks/useNotesView.ts';
import { NoteDrawer } from './NoteDrawer.tsx';
import NoteEditPage from './NoteEditPage.tsx';
import { CardCover, ListThumb, useAddImage } from './NoteImages.tsx';
import { ConvertAsk, MoveAsk, MergeBar, MoreMenu, needsAsk, swipeActs, useConvertFlow, type PageTip } from './NotesActions.tsx';
import { Dot } from './CatDot.tsx';
import { CatChips } from './CatChips.tsx';
import { useCategoryDialogs } from './CategoryDialogs.tsx';
import { ImportLoose } from './ImportLoose.tsx';
import { AiMark, ConvMark, DockTip, FilesMark, RoMark, RowText, SyncDropped, SyncMark, SyncStale, TrashLink, UndoBar } from './NotesBits.tsx';
import { InputRow, useInputDraft } from './NotesInputRow.tsx';
import row from '../../../kit/components/NoteRow.module.css';
import styles from './NotesPage.module.css';

/** 电脑版（B6）：有侧栏的宽度才下载；下好了、页里没有焦点和按住的指针时才换上（motion 的 useSwapWhenSafe）。随手记页不在首屏，马上就下 */
const loadNotesDesk = () => import('./NotesDesk.tsx');
const now = (fn: () => void) => fn();

/** 拖动中拿着的那一条算进它此刻前一条（排第一时后一条）那一天（按天分组时跟着预览顺序挪进别的组，R-461）；没拖原样 */
function withHeldDay(items: readonly NoteItem[], held: string | null): readonly NoteItem[] {
  const i = held === null ? -1 : items.findIndex((x) => x.id === held);
  const nb = items[i - 1] ?? items[i + 1];
  return i < 0 || !nb ? items : items.map((x, k) => (k === i ? { ...x, date: nb.date } : x));
}

/** #/notes 是列表，#/note/<id> 是编辑器：两条路由同一个分包（index.ts，B4 首屏额度），这里按路由名分 */
export default function NotesPage() {
  return useRoute().name === 'note' ? <NoteEditPage /> : <NotesList />;
}

/** 列表区换成“首页”时交给 home 的东西（隐私记首页宫格，负责人 11-19“解锁后用乙”）：分类计数、总条数、条目、日期文字、点开一条 */
export interface NotesHomeApi {
  counts: readonly CategoryCount[];
  total: number;
  /** 全部条目（只去掉移走的；“最近”按记下的时间由 home 自己挑，不受排序方式影响） */
  items: readonly NoteItem[];
  /** 今天 / 昨天 / 11月13日 */
  day: (it: NoteItem) => string;
  open: (id: string) => void;
  /** 行上的同步标记（隐私记“没保存上”，同列表行、卡片那一个） */
  mark: (it: NoteItem) => ReactNode;
  /** 一条都没有时那一句（来源给的，同列表空态） */
  empty: string;
  /** 打开“新分类”弹窗（隐私记“＋ 新分类”）：建好、同名已有都进那一类 */
  addCategory(): void;
  /** 打开改名、删除弹窗（隐私记长按分类格，负责人 11-19“长按分类格可以改名、删除”） */
  editCategory(c: CategoryCount): void;
  /** 拖进分类（“最近”拖到分类格）：认不认这一条、放下；同列表拖到胶囊那一份 */
  into: { ok(id: string): boolean; drop(id: string, target: string): void };
}

/**
 * head：顶上替换大标题的一块；home：给了就在手机排法里用它替换分类胶囊和列表区（顶部提示、输入行、撤销条照旧），电脑版不管；
 * cat：外面管的分类筛选（隐私记 #/vault/c/<id>，见 useNoteList）
 */
export function NotesList({ head, home, cat }: { head?: ((trash: ReactNode, catName: string | null) => ReactNode) | undefined; home?: ((api: NotesHomeApi) => ReactNode) | undefined; cat?: CategoryCtl | undefined }) {
  const t = useNotesT();
  const src = useNoteSource();
  const { caps } = src;
  // 隐私记“没保存上”的条目：列表层订一次，传给每张卡片、每一行
  const { failed } = src.useSync();
  const tEdit = useEditT();
  const locale = useUi((s) => s.locale);
  const view = useNotesViewValue();
  // 有侧栏的宽窗口（和 GlassBar 侧栏同一个断点）电脑版换上以后：点开随手记用右边抽屉，不换页（kit useListActions.ts 的 useDrawerSel，同今天页）；
  // 电脑版那一块画出错退回手机排法以后按没换上算，点开进编辑页
  const page = useRef<HTMLElement>(null);
  const loaded = useSwapWhenSafe(useMedia(MQ_SIDEBAR), page, loadNotesDesk, now, opensKeyboard);
  const ds = useDrawerSel<{ id: string }>(!!loaded);
  const Desk = ds.on ? loaded : null;
  const l = useNoteList(undefined, cat);
  // 分类弹窗（新建、改名删除）挂一份：分类那一排、隐私记首页宫格都经它开
  const cd = useCategoryDialogs(l);
  const a = useListActions<PageTip>('notes', { remove: l.remove, useRo: src.useReadonly });
  const { g: guard, g: { toast }, isRo, report } = a;
  // 撤销条还在的那一对，提示条先不出（R-415 复查 B4）
  const merge = useMergeHint(toast?.kind === 'mergeUndo' ? toast.pair : null, caps.merge);
  const up = useNotesToast(guard);
  const bar = isUndo(toast) ? { tip: undoTipOf(toast, a.undo), close: () => guard.dismiss(toast) } : null;
  // 输入框有焦点时画模糊层（R-401）；点模糊层让输入框失焦
  const field = useRef<HTMLInputElement>(null);
  // 输入行的字和小图放在页面这一层：电脑版、手机排法互换时输入行会重挂（B6）
  const draft = useInputDraft();
  const [typing, setTyping] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [just, setJust] = useState<string | null>(null);
  // 移到隐私记（B5 S7）：正在移的那一条（vault 的 VaultParts move 管解锁和出错提示）；移好的先在本页藏起来，等同步把它改成隐私记行
  const [moving, setMoving] = useState<string | null>(null);
  /** 带附件、插图的先问一次再移（B4b-1，线框 sAtt 最后一张“这条随手记和它的 N 个附件、M 张图会一起加密放进隐私记”） */
  const [askMove, setAskMove] = useState<NoteItem | null>(null);
  const [moved, setMoved] = useState<ReadonlySet<string>>(() => new Set());

  const selId = ds.sel?.id;
  const open = (id: string) => (isRo(id) ? guard.block() : ds.open({ id }, () => void navigate(src.route.edit, id)));
  const pull = usePullReveal('notes', src.kind !== 'vault');
  const pullRef = pull.ref;
  // main 同时给电脑版换挂（useSwapWhenSafe 读 page）和下拉搜索（pull.ref）
  const mainRef = useCallback((el: HTMLElement | null) => {
    page.current = el;
    pullRef(el);
  }, [pullRef]);
  const del = (id: string) => {
    setMenu(null);
    ds.forget(id);
    void a.del(id);
  };
  const toVault = (id: string) => {
    setMenu(null);
    const it = l.items.find((x) => x.id === id);
    if (isRo(id)) guard.block();
    else if (it && needsAsk(it)) setAskMove(it);
    else setMoving(id);
  };
  const shown = (it: NoteItem) => !moved.has(it.id);
  // 画不画：移走的不画；下拉搜索就地筛时只画命中的（R-447）。拖动排序的整串仍按 shown 算（筛着时不能拖）
  const vis = (it: NoteItem) => shown(it) && pull.shows(it.id);
  const mark = (text: string) => <PullHit pull={pull} text={text} />;
  /** 移出隐私记（隐私记来源）：没移成出提示 */
  const moveOut = (id: string) => {
    setMenu(null);
    ds.forget(id);
    void src.moveOut(id).then((r) => (r === 'failed' ? guard.show({ kind: 'moveOut' }) : report(r)));
  };
  const addImage = useAddImage(l, setJust, report, (m) => guard.show({ kind: 'img', ...m }));
  const conv = useConvertFlow(l.convert, a);
  const add = async (text: string): Promise<boolean> => {
    const { result, id } = await l.add(text);
    if (result === 'ok') setJust(id);
    else report(result);
    return result === 'ok';
  };

  // 时间怎么写（见文件头）：按天分组时组名已有日期；自己排时没有组名，行、卡片自己带日期
  const manual = l.order === 'manual';
  /** 组名、卡片日期共用：今天 / 昨天写字，再早按 style 写日期（组名“11月13日”，卡片“11/13”） */
  const dayWord = (kind: string, date: string, style: 'monthDay' | 'num'): string =>
    kind === 'today' ? t('notes.g.today', {}) : kind === 'yesterday' ? t('notes.g.yesterday', {}) : fmtDay(date, locale, style);
  /** 一条记录的日期文字（今天 / 昨天 / 11月13日）：导入弹窗、隐私记首页“最近”共用 */
  /** 正筛着的分类名（没筛为 null）：交给 head，隐私记分类列表顶栏写它（第三方实测 11-19 问题 6；按这一套分类算的，不串到另一套，独立评审 11-19 中 4） */
  const catName = l.counts.find((c) => c.id === l.category)?.name ?? null;
  const dayText = (it: NoteItem): string => dayWord(l.dayOf(it.createdAt), it.date, 'monthDay');
  /** 列表行标题右边：刚记下 / 时刻（分组时）/ 今天 11:40、昨天 21:15、10月21日（自己排时） */
  const rowTime = (it: NoteItem): string => {
    if (it.id === just) return t('notes.just', {});
    const hm = fmtTime(it.createdAt, l.tz);
    if (!manual) return hm;
    const g = l.dayOf(it.createdAt);
    return g === 'today' ? t('notes.at.today', { t: hm }) : g === 'yesterday' ? t('notes.at.yesterday', { t: hm }) : fmtDay(it.date, locale, 'monthDay');
  };
  /** 卡片底行的日期：刚记下 / 分组时不写（null）/ 今天、昨天、11/13（自己排时，窄卡只写短的） */
  const cardDay = (it: NoteItem): string | null => (it.id === just ? t('notes.just', {}) : manual ? dayWord(l.dayOf(it.createdAt), it.date, 'num') : null);

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
        conv.start(it, kind);
      }}
      onMove={() => toVault(it.id)}
      onMoveOut={() => moveOut(it.id)}
    />
  );
  const aiMark = (it: NoteItem) => (it.ai ? <AiMark id={it.id} /> : null);
  // 长按拖动（R-429）：放下按页面上这一串（和 DOM 顺序一致）算；只读行行上已 data-sort-off，kit 的流程里再兜一道；
  // 没写成整批撤回（切过的排序方式也切回）
  const dropped = useSortDropFlow({
    tag: src.kind,
    log: rlog,
    ro: isRo,
    block: () => guard.block(),
    order: () => l.items.filter(shown).map((x) => x.id),
    move: (m) => l.move(l.items.filter(shown), m.id, m.index),
    undo: l.undoMove,
    report,
    moved: (m) => guard.show(moveUndo(m.switched, () => void l.undoMove(m).then(report))),
  });
  // 拖进分类（负责人 11-19“里面的记录可以拖进分类里面”“只能拖没分类的”）：列表拖到分类胶囊；隐私记首页“最近”拖到分类格经 home 的 into 用同一份
  const into = {
    // 没筛分类时（首页“最近”、全部）这一条在 items 里；筛着某一类时没分类的不在 items、在 loose 里（导入弹窗列的就是它们）
    ok: (id: string) => !isRo(id) && (l.items.find((x) => x.id === id) ?? l.loose.find((x) => x.id === id))?.categoryId === null,
    drop: (id: string, cid: string) => void l.moveInto([id], cid).then((r) => (r.failed ? report('failed') : undefined)),
  };
  const sd = useSortDrag({ tag: src.kind, axis: view === 'masonry' ? 'xy' : 'y', onDrop: dropped, log: rlog, fx, into });
  /** 能拖的行、卡片上的标记（整页一串；只读、下拉搜索筛着时不能拖） */
  const sortAttrs = (it: NoteItem) => sd.attrs(it.id, isRo(it.id) || pull.searching);
  // 页面上画的这一串：移走的、下拉搜索没命中的不画；拖动中按预览顺序（拿着的那一条在落点处占位）
  const visible = l.items.filter(vis);
  const shownItems = sd.preview(visible, (x) => x.id);
  // 按时间排时按天分组：拖动中拿着的那一条算进它此刻前一条（排第一时后一条）那一天，跟着预览顺序挪进别的组
  const days = manual ? null : l.byDay(withHeldDay(shownItems, sd.held));
  /** 列表方式的一行 */
  const listRow = (it: NoteItem) => (
    <AppearItem key={it.id} className={`${selId === it.id ? `${row.lrow} ${styles.sel}` : row.lrow} ${sortRowClass}`} {...sortAttrs(it)} data-testid={`notes-row-${it.id}`}>
      {/* 左滑（B5 S7，线框 s7 NOTEROW_SW）：转成待办 / 移到隐私记 / 删除，和“⋯”菜单同一套动作 */}
      <SwipeRow
        data-testid={`notes-swipe-${it.id}`}
        look="compact"
        log={rlog}
        actions={swipeActs(t, caps, it.id, { todo: () => conv.start(it, 'todo'), vault: () => toVault(it.id), out: () => moveOut(it.id), del: () => del(it.id) })}
      >
        <div className={styles.swRow}>
        <button type="button" className={row.lmain} onClick={() => open(it.id)} onContextMenu={onMenuKey(it.id)} data-open={it.id} aria-current={selId === it.id ? 'true' : undefined}>
          <RowText
            it={it}
            time={rowTime(it)}
            ai={aiMark(it)}
            ro={<RoMark ro={isRo(it.id)} id={it.id} cls={styles.roRow} />}
            failed={failed.has(it.id)}
            mark={mark}
            thumb={it.cover ? <ListThumb img={it.cover} /> : null}
          />
        </button>
        <SortEnd>{more(it)}</SortEnd>
        </div>
      </SwipeRow>
    </AppearItem>
  );
  const onMenuKey = (id: string) => (e: { preventDefault(): void }) => {
    e.preventDefault();
    setMenu(id);
  };
  /** 瀑布流的一张卡 */
  const card = (it: NoteItem) => {
    const day = cardDay(it);
    return (
      <AppearItem key={it.id} className={`${styles.card} ${sortRowClass}`} {...sortAttrs(it)} data-testid={`notes-card-${it.id}`}>
        <div onContextMenu={onMenuKey(it.id)}>
          <button type="button" className={styles.cardMain} onClick={() => open(it.id)} data-open={it.id} aria-current={selId === it.id ? 'true' : undefined}>
            {it.cover ? (
              <span className={styles.cardCover}>
                <CardCover img={it.cover} count={it.images} />
              </span>
            ) : null}
            <span className={styles.cardTitle}>{it.converted ? <ConvMark id={it.id} /> : null}{mark(it.title)}</span>
            {it.summary ? <span className={styles.cardSum}>{mark(it.summary)}</span> : null}
          </button>
          <RoMark ro={isRo(it.id)} id={it.id} cls={styles.roCard} />
          <div className={styles.cardFoot}>
            <Dot color={it.categoryColor} />
            {it.categoryName ? <span className={styles.catName}>{it.categoryName}</span> : null}
            {aiMark(it)}
            {day !== null && (it.categoryName || it.ai) ? <span aria-hidden="true">·</span> : null}
            {day !== null ? <span className={styles.time}>{day}</span> : null}
            <FilesMark n={it.files} />
            <SyncMark id={it.id} failed={failed.has(it.id)} />
            <span className={styles.grow} />
            <SortEnd>{more(it)}</SortEnd>
          </div>
        </div>
      </AppearItem>
    );
  };
  /** 一组里（或自己排时整串）的条目：列表一块白面板，瀑布流两列 */
  const block = (items: readonly NoteItem[]) =>
    view === 'masonry' ? (
      <AppearList as="ul" className={styles.mason}>
        {items.map(card)}
      </AppearList>
    ) : (
      <AppearList as="ul" className={days === null ? `${row.lst} ${styles.flat}` : row.lst}>
        {items.map(listRow)}
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
      {/* 隐私记入口行（B5 S5，线框 s7 LOCKROW：分类胶囊下面、合并提示上面；两种显示方式都有）；隐私记页里不出 */}
      {caps.lockrow ? (
        <QuietBoundary name="vault-lockrow">
          <Suspense fallback={null}>
            <VaultParts part="lockrow" />
          </Suspense>
        </QuietBoundary>
      ) : null}
      <SyncDropped />
      <SyncStale />

      {merge ? <MergeBar hint={merge} onResult={report} onMerged={(h) => guard.show(mergeUndo(h.key, () => void h.undo().then(report)))} /> : null}
    </>
  );
  const body = (
    <>
      {tips}
      {l.items.length === 0 && !pull.searching ? (
        <p className={list.empty} data-testid="notes-empty">
          {src.text?.empty ?? t('notes.empty', {})}
        </p>
      ) : null}

      <SortBox sd={sd}>
      {days === null ? (
        // 自己排（R-429）：不按天分组，一整串
        <div data-testid={listTestId}>{block(shownItems)}</div>
      ) : (
        <AppearList as="div" data-testid={listTestId}>
          {days.map(({ items, ...g }) => (
            <AppearItem as="section" key={g.date} className={styles.group} data-testid={`notes-g-${g.date}`}>
              {/* 分组名小字、加字距，右边等宽条数（R-436，同待办页分组：kit groupLabelClass；R-463 起瀑布流也分组） */}
              <h2 className={`${groupLabelClass} ${styles.h2}`}>
                <span>{dayWord(g.key, g.date, 'monthDay')}</span>
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
  // 手机版、电脑版列表栏同一处（电脑版的分类在左栏，不画胶囊）：搜索本页、搜索框和条数在列表上面，打了字列表就地筛、下面一行“用 AI 按意思找”
  const found = visible.length;
  const listPart = (top: ReactNode) => (
    <PullSlot pull={pull} keyLabel={t('notes.pullKey', {})} search={(part) => <PullSearch part={part} pull={pull} scope="note" found={found} />}>
      {top}
      {body}
    </PullSlot>
  );
  const phone = (
    <>
      {head ? (
        head(<TrashLink />, catName)
      ) : (
        <>
          {/* 大标题 + 短粗下划线、标题下一行等宽小字（今天的日期 · 共几条），同待办页（R-436，kit Refine.module.css） */}
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
      {home ? (
        <>
          {tips}
          {home({
            addCategory: cd.add,
            into,
            editCategory: cd.edit,
            counts: l.counts,
            total: l.total,
            items: l.items.filter(shown),
            day: dayText,
            open,
            mark: (it) => <SyncMark id={it.id} failed={failed.has(it.id)} />,
            empty: src.text?.empty ?? t('notes.empty', {}),
          })}
        </>
      ) : (
        listPart(filterChips)
      )}
      {mist}
      {dock}
    </>
  );

  return (
    <main ref={mainRef} className={styles.page} data-feature={src.kind === 'vault' ? 'vault' : 'notes'} data-testid={src.kind === 'vault' ? 'vault-notes' : 'notes'} data-view={view}>
      {/* 电脑版（B6，ui/NotesDesk.tsx）：分类一栏 + 列表一栏；电脑版没换上或画出错时照手机的排法画 */}
      {Desk ? (
        <QuietBoundary name="notes-desk" fallback={phone} onFail={ds.fail}>
          {mist}
          <Desk.default
            page={src.desk}
            title={src.text?.title}
            srH1={!head}
            titleEnd={src.kind === 'vault' ? <TrashLink /> : undefined}
            cats={{ total: l.total, counts: l.counts, category: l.category, set: l.setCategory, add: cd.add, edit: cd.edit }}
            list={
              <>
                {head?.(null, catName)}
                {listPart(importRow)}
                {dock}
              </>
            }
            drawer={selId ? (side, handle) => <NoteDrawer id={selId} side={side} handle={handle} onClose={ds.close} /> : undefined}
          />
        </QuietBoundary>
      ) : (
        phone
      )}
      {cd.dialogs}
      {moving !== null ? (
        <QuietBoundary name="vault-move">
          <Suspense fallback={null}>
            <VaultParts
              part="move"
              noteId={moving}
              onDone={(ok) => {
                if (ok) setMoved((s) => new Set(s).add(moving));
                setMoving(null);
              }}
            />
          </Suspense>
        </QuietBoundary>
      ) : null}
      {conv.ask ? <ConvertAsk ask={conv.ask} onOk={conv.confirm} onCancel={conv.cancel} /> : null}
      {askMove ? (
        <MoveAsk
          files={askMove.files}
          images={askMove.images}
          onOk={() => {
            setMoving(askMove.id);
            setAskMove(null);
          }}
          onCancel={() => setAskMove(null)}
        />
      ) : null}

      {bar ? <UndoBar key={bar.tip.key} tip={bar.tip} onClose={bar.close} /> : null}
      <ReadonlyToast guard={guard} message={tEdit('edit.st.readonly', {})} testId="notes-ro-toast" />
    </main>
  );
}

