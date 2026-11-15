// 随手记页（B4 S1、S2；交互照定稿线框 s7（第 873～907 行）、R-78（第 528 行），视觉照皮肤视觉稿 notesHead / PH.mason / PH.notes / DK.mason / DK.notes）
// • 两种显示：瀑布流（默认，手机两列、窗口 ≥ 900px 三列）和列表（按今天 / 昨天 / 日期分组）；页面上没有切换按钮，
//   只在“设置 › 随手记显示方式”里改，按设备类型分开记（R-78，hooks/useNotesView.ts）
// • 顶部：大标题 + 右上角头像（设置入口，同今天页；电脑上设置在侧栏，这里藏掉）；下面分类胶囊：全部 N + 各分类条数，只筛这一页（不写 settings）
// • 卡片 / 行：没有标题时取正文第一行当标题；分类前有 6px 色点（categories.color）；AI 分过、还没看过的标“AI”
//   瀑布流卡片底部：分类 · 时间 · “⋯”（看得见 24px，点按区用 ::after 透明扩到 44，不占排版宽度，视觉稿第 264～266 行）
//   列表一行：时刻 | 随手记小图标 | 标题和摘要 | “⋯”（视觉稿 PH.notes：44px 18px 1fr … 24px）
// • 点开：手机进编辑器 #/note/<id>；电脑（≥ 900px，有侧栏，电脑版换上以后）从右边滑出详情抽屉（DK.mason），侧栏和列表留着，Esc 或“×”关；
//   开着哪一条由 kit 的 useDrawerSel（在 useListActions.ts）管（同今天页）：电脑版没换上、画出错退回手机排法时点开进编辑页
// • “⋯”打开菜单；右键（安卓长按）也打开同一个菜单。菜单：转成待办 / 转成日程 / 删除（S8，R-414；线框里的“移到隐私记”等 B5 隐私记做了再加）；
//   瀑布流里不能左滑（R-78），列表的左滑以后和别的页一起加
// • 转成待办 / 日程（R-414）：规则见 shared/logic/notes/note-convert.ts 文件头；转完在输入行上面出一句提示（同插图提示的位置）
// • 合并分类提示（S7，R-413；线框 MERGE）：分类胶囊下面一张浅底条“‘读书’和‘书单’两个分类很像，合成一个吗？ 合并 / 不用”，
//   哪几对由 hooks/useMergeHint.ts 给（AI 判的 + 本机规则），一次只出一对；点“合并”成了底部出 8 秒撤销条“已合并 · 撤销”（R-415 ③，和删除同一个 UndoBar），
//   撤销就当点了“不用”（这一对记进 notes.merge_dismissed），被合并的分类回到 merged_into: null（data 的 undoMerge）；写入期间提示条两个按钮禁用
// • 删除：软删，进“最近删除”，出 8 秒撤销条
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
// • 这一批不做：隐私记那一行（B5）
// • 插图（S3）：卡片顶上放第一张图（多张标“+N”），列表行有图时在“⋯”前放缩略图；输入行只有“图片”（拍照在编辑页）
// • 只读行（S12，R-148，TC-B4-09；照待办页）：带认不出的值的行（core 的 readonlyIds）标“要新版本”（单独一行：瀑布流在正文下、底行上，列表在摘要行下），菜单里的“删除”变淡；点开、删除统一拦下
//   （不进编辑器、不开抽屉、不写），出 kit 的“这条要新版本才能修改 · 更新”（删除撤销、只读拦截、出错条走 kit 的 useListActions，插图提示和输入行上移在 hooks/useNotesToast.ts）。
//   左滑、多选还没有入口，以后加时同样先判只读
// • 动效只用现有的 AppearList（增删淡入淡出）和 Pressable（按下反馈）；抽屉只有最基本的滑入（R-376）
// • 隐私记（B5 S5、S7）：分类胶囊下面一行入口（vault 的 VaultParts lockrow）；“⋯”菜单、左滑（列表方式，kit 的 SwipeRow；一次只露一行、点别处或 Esc 收起由 kit 管）加“移到隐私记”，
//   移的流程（解锁、重试一次、带附件不能移）在 vault 的 VaultParts move；移好的先在本页藏起来，等同步把它改成隐私记行
// • 数据来源（B5 隐私记重写 11-15，hooks/note-source.ts）：隐私记页经 NotesSurface 用同一个列表，来源换成隐私记的内存仓库；
//   两边不一样的只按来源的 caps 分（入口行、合并提示、转成待办 / 日程、移到 / 移出隐私记），标题、空态、编辑页路由、电脑布局存的页名也由来源给；
//   head 给了就画它、不画本页的大标题和头像（隐私记页的“‹ 随手记 | 🔒 隐私记 | 立即锁上”）
import { opensKeyboard } from '../../../platform/env.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { Suspense, useRef, useState, type ReactNode } from 'react';
import { fmtDay, fmtTime } from '../../../../shared/i18n/fmt.ts';
import { navigate, useRoute } from '../../../app/router.ts';
import list from '../../../kit/components/List.module.css';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { SwipeRow } from '../../../kit/components/SwipeRow.tsx';
import { Mist } from '../../../kit/components/Mist.tsx';
import { useDrawerSel, useListActions } from '../../../kit/hooks/useListActions.ts';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { ReadonlyToast } from '../../../kit/components/ReadonlyRow.tsx';
import { useEditT } from '../../../kit/components/EditNotices.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { AppearItem, AppearList, useSwapWhenSafe } from '../../../motion/components.ts';
import { VaultParts } from '../../vault/index.ts';
import { useNoteSource } from '../hooks/note-source.ts';
import { useMergeHint } from '../hooks/useMergeHint.ts';
import { useNoteList, type NoteItem } from '../hooks/useNoteList.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import { isUndo, mergeUndo, undoTipOf, useNotesToast } from '../hooks/useNotesToast.ts';
import { useNotesViewValue } from '../hooks/useNotesView.ts';
import { NoteDrawer } from './NoteDrawer.tsx';
import NoteEditPage from './NoteEditPage.tsx';
import { CardCover, ListThumb, useAddImage } from './NoteImages.tsx';
import { ConvertAsk, MoveAsk, MergeBar, MoreMenu, needsAsk, swipeActs, useConvertFlow, type PageTip } from './NotesActions.tsx';
import { Dot } from './CatDot.tsx';
import { AiMark, Chip, ConvMark, DockTip, FilesMark, RoMark, RowText, SyncDropped, SyncMark, UndoBar } from './NotesBits.tsx';
import { InputRow, useInputDraft } from './NotesInputRow.tsx';
import row from '../../../kit/components/NoteRow.module.css';
import styles from './NotesPage.module.css';

/** 电脑版（B6）：有侧栏的宽度才下载；下好了、页里没有焦点和按住的指针时才换上（motion 的 useSwapWhenSafe）。随手记页不在首屏，马上就下 */
const loadNotesDesk = () => import('./NotesDesk.tsx');
const now = (fn: () => void) => fn();

/** #/notes 是列表，#/note/<id> 是编辑器：两条路由同一个分包（index.ts，B4 首屏额度），这里按路由名分 */
export default function NotesPage() {
  return useRoute().name === 'note' ? <NoteEditPage /> : <NotesList />;
}

export function NotesList({ head }: { head?: ReactNode }) {
  const t = useNotesT();
  const src = useNoteSource();
  const { caps } = src;
  const tEdit = useEditT();
  const locale = useUi((s) => s.locale);
  const view = useNotesViewValue();
  // 有侧栏的宽窗口（和 GlassBar 侧栏同一个断点）电脑版换上以后：点开随手记用右边抽屉，不换页（kit useListActions.ts 的 useDrawerSel，同今天页）；
  // 电脑版那一块画出错退回手机排法以后按没换上算，点开进编辑页
  const page = useRef<HTMLElement>(null);
  const loaded = useSwapWhenSafe(useMedia(MQ_SIDEBAR), page, loadNotesDesk, now, opensKeyboard);
  const ds = useDrawerSel<{ id: string }>(!!loaded);
  const Desk = ds.on ? loaded : null;
  const l = useNoteList();
  const a = useListActions<PageTip>('notes', { remove: l.remove, ro: src.useReadonly() });
  const { g: guard, g: { toast }, isRo, report } = a;
  // 撤销条还在的那一对，提示条先不出（R-415 复查 B4）
  const merge = useMergeHint(toast?.kind === 'mergeUndo' ? toast.pair : null);
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
  /** 移出隐私记（隐私记来源）：没移成出提示 */
  const moveOut = (id: string) => {
    setMenu(null);
    ds.forget(id);
    void src.moveOut(id).then((r) => (r === 'failed' ? guard.show({ kind: 'conv', key: 'notes.err.moveOut' }) : report(r)));
  };
  const addImage = useAddImage(l, setJust, report, (m) => guard.show({ kind: 'img', ...m }));
  const conv = useConvertFlow(l.convert, a);
  const add = async (text: string): Promise<boolean> => {
    const { result, id } = await l.add(text);
    if (result === 'ok') setJust(id);
    else report(result);
    return result === 'ok';
  };

  /** 卡片、行上的时间：刚记下的写“刚记下”；列表里只写时刻（组标题已有日期），瀑布流写“今天 11:40 / 昨天 21:15 / 10月21日” */
  const timeOf = (it: NoteItem, withDay: boolean): string => {
    if (it.id === just) return t('notes.just', {});
    const hm = fmtTime(it.createdAt, l.tz);
    if (!withDay) return hm;
    const g = l.groups.find((x) => x.date === it.date)?.key;
    return g === 'today' ? t('notes.at.today', { t: hm }) : g === 'yesterday' ? t('notes.at.yesterday', { t: hm }) : fmtDay(it.date, locale, 'monthDay');
  };

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
  const onMenuKey = (id: string) => (e: { preventDefault(): void }) => {
    e.preventDefault();
    setMenu(id);
  };

  const filterChips = (
    <>
      {l.counts.length ? (
        <div className={styles.filter} role="group" aria-label={t('notes.filter', {})} data-testid="notes-filter">
          <Chip on={l.category === null} onClick={() => l.setCategory(null)} label={t('notes.all', { n: l.total })} color={null} testId="notes-filter-all" />
          {l.counts.map((c) => (
            <Chip key={c.id} on={l.category === c.id} onClick={() => l.setCategory(c.id)} label={`${c.name} ${c.count}`} color={c.color} testId={`notes-filter-${c.id}`} />
          ))}
        </div>
      ) : null}

    </>
  );
  // 隐私记入口行、合并提示、空态、瀑布流或列表：手机直接画在页上，电脑放进 list 块
  const body = (
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

      {merge && caps.merge ? <MergeBar hint={merge} onResult={report} onMerged={(h) => guard.show(mergeUndo(h.key, () => void h.undo().then(report)))} /> : null}

      {l.items.length === 0 ? (
        <p className={list.empty} data-testid="notes-empty">
          {src.text?.empty ?? t('notes.empty', {})}
        </p>
      ) : null}

      {view === 'masonry' ? (
        <AppearList as="ul" className={styles.mason} data-testid="notes-mason">
          {l.items.filter(shown).map((it) => (
            <AppearItem key={it.id} className={styles.card} data-testid={`notes-card-${it.id}`}>
              <div onContextMenu={onMenuKey(it.id)}>
                <button type="button" className={styles.cardMain} onClick={() => open(it.id)} data-open={it.id} aria-current={selId === it.id ? 'true' : undefined}>
                  {it.cover ? (
                    <span className={styles.cardCover}>
                      <CardCover img={it.cover} count={it.images} />
                    </span>
                  ) : null}
                  <span className={styles.cardTitle}>{it.converted ? <ConvMark id={it.id} /> : null}{it.title}</span>
                  {it.summary ? <span className={styles.cardSum}>{it.summary}</span> : null}
                </button>
                <RoMark ro={isRo(it.id)} id={it.id} cls={styles.roCard} />
                <div className={styles.cardFoot}>
                  {/* 定稿 PH.mason 底行只有“分类 · 时间 · ⋯”：AI 小标并进分类胶囊（“● 工作灵感 AI”，同 PH.notes），没分类时单独出 */}
                  {it.categoryName ? (
                    <span className={styles.cat}>
                      <Dot color={it.categoryColor} />
                      <span className={styles.catName}>{it.categoryName}</span>
                      {aiMark(it)}
                    </span>
                  ) : (
                    aiMark(it)
                  )}
                  <FilesMark n={it.files} />
                  <SyncMark id={it.id} />
                  <span className={styles.time}>{timeOf(it, true)}</span>
                  {more(it)}
                </div>
              </div>
            </AppearItem>
          ))}
        </AppearList>
      ) : (
        <AppearList as="div" data-testid="notes-list">
          {l.groups.filter((g) => g.items.some(shown)).map((g) => (
            <AppearItem as="section" key={g.date} className={styles.group} data-testid={`notes-g-${g.date}`}>
              <h2 className={styles.h2}>{g.key === 'today' ? t('notes.g.today', {}) : g.key === 'yesterday' ? t('notes.g.yesterday', {}) : fmtDay(g.date, locale, 'monthDay')}</h2>
              <AppearList as="ul" className={row.lst}>
                {g.items.filter(shown).map((it) => (
                  <AppearItem key={it.id} className={selId === it.id ? `${row.lrow} ${styles.sel}` : row.lrow} data-testid={`notes-row-${it.id}`}>
                    {/* 左滑（B5 S7，线框 s7 NOTEROW_SW）：转成待办 / 移到隐私记 / 删除，和“⋯”菜单同一套动作 */}
                    <SwipeRow
                      className={styles.swp}
                      data-testid={`notes-swipe-${it.id}`}
                      look="compact"
                      log={rlog}
                      actions={swipeActs(t, caps, it.id, { todo: () => conv.start(it, 'todo'), vault: () => toVault(it.id), out: () => moveOut(it.id), del: () => del(it.id) })}
                    >
                      <div className={styles.swRow}>
                      <button type="button" className={row.lmain} onClick={() => open(it.id)} onContextMenu={onMenuKey(it.id)} data-open={it.id} aria-current={selId === it.id ? 'true' : undefined}>
                        <span className={row.rowTime}>{timeOf(it, false)}</span>
                        <span className={row.mn} aria-hidden="true" />
                        <RowText it={it} ai={aiMark(it)} ro={<RoMark ro={isRo(it.id)} id={it.id} cls={styles.roRow} />} />
                        {it.cover ? <ListThumb img={it.cover} /> : null}
                      </button>
                      {more(it)}
                      </div>
                    </SwipeRow>
                  </AppearItem>
                ))}
              </AppearList>
            </AppearItem>
          ))}
        </AppearList>
      )}

    </>
  );
  const dock = (
      <div className={up ? `${styles.dock} ${styles.dockUp}` : styles.dock}>
        <InputRow field={field} state={draft} onTyping={setTyping} onAdd={add} onImages={addImage} tip={toast !== null && !isUndo(toast) ? <DockTip toast={toast} /> : null} />
      </div>
  );
  const mist = typing ? <Mist onTap={() => field.current?.blur()} tag="notes" log={rlog} testId="notes-mist" className={styles.mist} /> : null;
  const phone = (
    <>
      {head ?? (
        <header className={styles.top}>
          <h1 className={styles.h1}>{t('notes.title', {})}</h1>
          <MeLink testId="notes-settings" />
        </header>
      )}
      {filterChips}
      {body}
      {mist}
      {dock}
    </>
  );

  return (
    <main ref={page} className={styles.page} data-feature={src.kind === 'vault' ? 'vault' : 'notes'} data-testid={src.kind === 'vault' ? 'vault-notes' : 'notes'} data-view={view}>
      {/* 电脑版（B6，ui/NotesDesk.tsx）：分类一栏 + 列表一栏；电脑版没换上或画出错时照手机的排法画 */}
      {Desk ? (
        <QuietBoundary name="notes-desk" fallback={phone} onFail={ds.fail}>
          {mist}
          <Desk.default
            page={src.desk}
            title={src.text?.title}
            cats={{ total: l.total, counts: l.counts, category: l.category, set: l.setCategory }}
            list={
              <>
                {head}
                {body}
                {dock}
              </>
            }
            drawer={selId ? (side, handle) => <NoteDrawer id={selId} side={side} handle={handle} onClose={ds.close} /> : undefined}
          />
        </QuietBoundary>
      ) : (
        phone
      )}
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

