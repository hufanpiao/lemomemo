// 随手记页（B4 S1、S2；交互照定稿线框 s7（第 873～907 行）、R-78（第 528 行），视觉照皮肤视觉稿 notesHead / PH.mason / PH.notes / DK.mason / DK.notes）
// • 两种显示：瀑布流（默认，手机两列、窗口 ≥ 900px 三列）和列表（按今天 / 昨天 / 日期分组）；页面上没有切换按钮，
//   只在“设置 › 随手记显示方式”里改，按设备类型分开记（R-78，hooks/useNotesView.ts）
// • 顶部：大标题 + 右上角头像（设置入口，同今天页；电脑上设置在侧栏，这里藏掉）；下面分类胶囊：全部 N + 各分类条数，只筛这一页（不写 settings）
// • 卡片 / 行：没有标题时取正文第一行当标题；分类前有 6px 色点（categories.color）；AI 分过、还没看过的标“AI”
//   瀑布流卡片底部：分类 · 时间 · “⋯”（看得见 24px，点按区用 ::after 透明扩到 44，不占排版宽度，视觉稿第 264～266 行）
//   列表一行：时刻 | 随手记小图标 | 标题和摘要 | “⋯”（视觉稿 PH.notes：44px 18px 1fr … 24px）
// • 点开：手机进编辑器 #/note/<id>；电脑（≥ 900px，有侧栏）从右边滑出详情抽屉（DK.mason），侧栏和列表留着，Esc 或“×”关
// • “⋯”打开菜单；右键（安卓长按）也打开同一个菜单。菜单：转成待办 / 转成日程 / 删除（S8，R-414；线框里的“移到隐私记”等 B5 隐私记做了再加）；
//   瀑布流里不能左滑（R-78），列表的左滑以后和别的页一起加
// • 转成待办 / 日程（R-414）：规则见 shared/logic/notes/note-convert.ts 文件头；转完在输入行上面出一句提示（同插图提示的位置）
// • 合并分类提示（S7，R-413；线框 MERGE）：分类胶囊下面一张浅底条“‘读书’和‘书单’两个分类很像，合成一个吗？ 合并 / 不用”，
//   哪几对由 hooks/useMergeHint.ts 给（AI 判的 + 本机规则），一次只出一对
// • 删除：软删，进“最近删除”，出 8 秒撤销条
// • 底部输入行（视觉稿 .inrow、线框 COMPOSER）：右边是“图片”“拍照”（主持人定 3），打了字才出“记下”；回车或点“记下”就存，新的一条出现在最上面、时间写“刚记下”。
//   选了图：先用输入框里的字（可以空）新建一条随手记，再把图插进去（S3，ui/NoteImages.tsx）。电脑上输入行铺满内容栏、左右各留 22px（DK.notes）
// • 插图（S3）：瀑布流卡片顶部放第一张（16:10、右上角“+N”）；插入、上传失败出提示条，空间满了的带“最近删除”入口
// • 底栏 / 侧栏的“＋”在这一页直接把光标放进输入行（R-380，线框“低 1”）：输入行挂着时往 kit/state/new-item.ts 的 notesInput 登记聚焦，app/App.tsx 调它
// • 输入行是贴底浮条（position: fixed），聚焦一律原地聚焦（台账 Q-8，platform/viewport.ts 文件头）：“＋”调 focusInPlace，输入框挂 inPlaceTouchStart / inPlaceTouchEnd；
//   form 挂 onMouseDown={keepFieldFocus}（台账 Q-25）：点“记下”“图片”不让输入框失焦，按钮第一下就点得动，记下后键盘不收、接着记（和回车一样）
// • 输入框有焦点时后面整页盖一层液态模糊玻璃（R-401，负责人 11-13“随手记点输入框背景也要模糊”；和打字条 R-399 同一个 kit Mist，16px）：
//   放在 .dock 旁边、层级用令牌 --z-notes-mist（在输入行下面，NotesPage.module.css .mist），输入行、底栏、提示条都在它上面；
//   点模糊处只让输入框失焦收键盘（输入行一直在，没有“收起”；同 R-399 打了字时的做法），字留着；运行日志 notes mist on/off
// • 这一批不做：隐私记那一行（B5）
// • 插图（S3）：卡片顶上放第一张图（多张标“+N”），列表行有图时在“⋯”前放缩略图；输入行只有“图片”（拍照在编辑页）
// • 只读行（S12，R-148，TC-B4-09；照待办页）：带认不出的值的行（core 的 readonlyIds）标“要新版本”（单独一行：瀑布流在正文下、底行上，列表在摘要行下），菜单里的“删除”变淡；点开、删除统一拦下
//   （不进编辑器、不开抽屉、不写），出 kit 的“这条要新版本才能修改 · 更新”（删除撤销、只读拦截、出错条走 kit 的 useListActions，插图提示和输入行上移在 hooks/useNotesToast.ts）。
//   左滑、多选还没有入口，以后加时同样先判只读
// • 动效只用现有的 AppearList（增删淡入淡出）和 Pressable（按下反馈）；抽屉只有最基本的滑入（R-376）
import { rlog } from '../../../platform/run-log-api.ts';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from 'react';
import { fmtDay, fmtTime } from '../../../../shared/i18n/fmt.ts';
import { hrefOf, navigate, plainClick, useRoute } from '../../../app/router.ts';
import list from '../../../kit/components/List.module.css';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { Mist } from '../../../kit/components/Mist.tsx';
import { useListActions } from '../../../kit/hooks/useListActions.ts';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { notesInput } from '../../../kit/state/new-item.ts';
import { focusInPlace, inPlaceTouchEnd, inPlaceTouchStart, keepFieldFocus } from '../../../platform/viewport.ts';
import { ReadonlyMark, ReadonlyToast } from '../../../kit/components/ReadonlyRow.tsx';
import { useEditT } from '../../../kit/components/EditNotices.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { AppearItem, AppearList, Pressable } from '../../../motion/components.ts';
import { useMergeHint } from '../hooks/useMergeHint.ts';
import { useNoteList, type NoteItem } from '../hooks/useNoteList.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import { useNotesToast } from '../hooks/useNotesToast.ts';
import { useNotesViewValue } from '../hooks/useNotesView.ts';
import { NoteDrawer } from './NoteDrawer.tsx';
import NoteEditPage from './NoteEditPage.tsx';
import { CardCover, ListThumb, PickButtons, useAddImage } from './NoteImages.tsx';
import { ConvertAsk, MergeBar, MoreMenu, useConvertFlow, type PageTip } from './NotesActions.tsx';
import styles from './NotesPage.module.css';

/** 分类色点（只在有颜色时画） */
const Dot = ({ color, big }: { color: string | null; big?: boolean }) =>
  color === null ? null : <i className={big ? styles.dotBig : styles.dot} style={{ '--dot': color } as CSSProperties} aria-hidden="true" />;

/** #/notes 是列表，#/note/<id> 是编辑器：两条路由同一个分包（index.ts，B4 首屏额度），这里按路由名分 */
export default function NotesPage() {
  return useRoute().name === 'note' ? <NoteEditPage /> : <NotesList />;
}

function NotesList() {
  const t = useNotesT();
  const tEdit = useEditT();
  const locale = useUi((s) => s.locale);
  const view = useNotesViewValue();
  // 有侧栏的宽窗口（和 GlassBar 侧栏同一个断点）：点开随手记用右边抽屉，不换页
  const wide = useMedia(MQ_SIDEBAR);
  const l = useNoteList();
  const a = useListActions<PageTip>('notes', { remove: l.remove });
  const merge = useMergeHint();
  const { g: guard, isRo, report } = a;
  const up = useNotesToast(guard);
  // 输入框有焦点时画模糊层（R-401）；点模糊层让输入框失焦
  const field = useRef<HTMLInputElement>(null);
  const [typing, setTyping] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [just, setJust] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);

  // 窗口缩到没有侧栏：抽屉收起（窄窗口点开走编辑页）
  useEffect(() => {
    if (!wide) setDrawer(null);
  }, [wide]);

  const open = (id: string) => {
    if (isRo(id)) guard.block();
    else if (wide) setDrawer(id);
    else void navigate('note', id);
  };
  const del = (id: string) => {
    setMenu(null);
    void a.del(id);
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
      ro={isRo(it.id)}
      open={menu === it.id}
      onOpenChange={(o) => setMenu(o ? it.id : null)}
      onDelete={() => del(it.id)}
      long={menu === it.id && l.tooLong(it.id)}
      onConvert={(kind) => {
        setMenu(null);
        conv.start(it, kind);
      }}
    />
  );
  const aiMark = (it: NoteItem) => (it.ai ? <AiMark id={it.id} /> : null);
  const onMenuKey = (id: string) => (e: { preventDefault(): void }) => {
    e.preventDefault();
    setMenu(id);
  };

  return (
    <main className={styles.page} data-feature="notes" data-testid="notes" data-view={view}>
      <header className={styles.top}>
        <h1 className={styles.h1}>{t('notes.title', {})}</h1>
        <MeLink testId="notes-settings" />
      </header>

      {l.counts.length ? (
        <div className={styles.filter} role="group" aria-label={t('notes.filter', {})} data-testid="notes-filter">
          <Chip on={l.category === null} onClick={() => l.setCategory(null)} label={t('notes.all', { n: l.total })} color={null} testId="notes-filter-all" />
          {l.counts.map((c) => (
            <Chip key={c.id} on={l.category === c.id} onClick={() => l.setCategory(c.id)} label={`${c.name} ${c.count}`} color={c.color} testId={`notes-filter-${c.id}`} />
          ))}
        </div>
      ) : null}

      {merge ? <MergeBar hint={merge} onResult={report} /> : null}

      {l.items.length === 0 ? (
        <p className={list.empty} data-testid="notes-empty">
          {t('notes.empty', {})}
        </p>
      ) : null}

      {view === 'masonry' ? (
        <AppearList as="ul" className={styles.mason} data-testid="notes-mason">
          {l.items.map((it) => (
            <AppearItem key={it.id} className={styles.card} data-testid={`notes-card-${it.id}`}>
              <div onContextMenu={onMenuKey(it.id)}>
                <button type="button" className={styles.cardMain} onClick={() => open(it.id)} aria-current={drawer === it.id ? 'true' : undefined}>
                  {it.cover ? (
                    <span className={styles.cardCover}>
                      <CardCover img={it.cover} count={it.images} />
                    </span>
                  ) : null}
                  <span className={styles.cardTitle}>{it.title}</span>
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
                  <span className={styles.time}>{timeOf(it, true)}</span>
                  {more(it)}
                </div>
              </div>
            </AppearItem>
          ))}
        </AppearList>
      ) : (
        <AppearList as="div" data-testid="notes-list">
          {l.groups.map((g) => (
            <AppearItem as="section" key={g.date} className={styles.group} data-testid={`notes-g-${g.date}`}>
              <h2 className={styles.h2}>{g.key === 'today' ? t('notes.g.today', {}) : g.key === 'yesterday' ? t('notes.g.yesterday', {}) : fmtDay(g.date, locale, 'monthDay')}</h2>
              <AppearList as="ul" className={styles.lst}>
                {g.items.map((it) => (
                  <AppearItem key={it.id} className={drawer === it.id ? `${styles.lrow} ${styles.sel}` : styles.lrow} data-testid={`notes-row-${it.id}`}>
                    <button type="button" className={styles.lmain} onClick={() => open(it.id)} onContextMenu={onMenuKey(it.id)} aria-current={drawer === it.id ? 'true' : undefined}>
                      <span className={styles.rowTime}>{timeOf(it, false)}</span>
                      <span className={styles.mn} aria-hidden="true" />
                      <RowText it={it} ai={aiMark(it)} ro={<RoMark ro={isRo(it.id)} id={it.id} cls={styles.roRow} />} />
                      {it.cover ? <ListThumb img={it.cover} /> : null}
                    </button>
                    {more(it)}
                  </AppearItem>
                ))}
              </AppearList>
            </AppearItem>
          ))}
        </AppearList>
      )}

      {typing ? <Mist onTap={() => field.current?.blur()} tag="notes" log={rlog} testId="notes-mist" className={styles.mist} /> : null}
      <div className={up ? `${styles.dock} ${styles.dockUp}` : styles.dock}>
        <InputRow field={field} onTyping={setTyping} onAdd={add} onImage={addImage} />
        {guard.toast !== null && guard.toast.kind !== 'undo' ? <DockTip toast={guard.toast} /> : null}
      </div>

      {drawer !== null ? <NoteDrawer id={drawer} onClose={() => setDrawer(null)} /> : null}
      {conv.ask ? <ConvertAsk ask={conv.ask} onOk={conv.confirm} onCancel={conv.cancel} /> : null}

      {guard.toast?.kind === 'undo' ? <UndoBar key={guard.toast.id} toast={guard.toast} onUndo={a.undo} onClose={guard.dismiss} /> : null}
      <ReadonlyToast guard={guard} message={tEdit('edit.st.readonly', {})} testId="notes-ro-toast" />
    </main>
  );
}

/** 列表行中间的字：标题；摘要 · 分类（+ AI 小标）；只读行再在下面单独一行标“要新版本” */
function RowText({ it, ai, ro }: { it: NoteItem; ai: ReactNode; ro: ReactNode }) {
  return (
    <span className={styles.ltext}>
      <span className={styles.t1}>{it.title}</span>
      <span className={styles.t2}>
        <span className={styles.t2txt}>{[it.summary, it.categoryName ?? ''].filter(Boolean).join(' · ')}</span>
        {ai}
      </span>
      {ro}
    </span>
  );
}

/** 页底的撤销条（换一条删除就换一个 key，重新计时） */
function UndoBar({ toast, onUndo, onClose }: { toast: { kind: 'undo'; id: string }; onUndo(id: string): void; onClose(x: { kind: 'undo'; id: string }): void }) {
  const t = useNotesT();
  return (
    <UndoToast message={t('notes.deleted', {})} undoLabel={t('notes.undo', {})} onUndo={() => onUndo(toast.id)} onClose={() => onClose(toast)} data-testid="notes-toast" />
  );
}

/** 输入行上面的提示条：没保存上、插图提示（空间满了的带“最近删除”入口）、转换结果 */
function DockTip({ toast }: { toast: { kind: 'error' } | PageTip }) {
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

function Chip({ on, onClick, label, color, testId }: { on: boolean; onClick(): void; label: string; color: string | null; testId: string }) {
  return (
    <Pressable className={on ? styles.chipOn : styles.chip} aria-pressed={on} onClick={onClick} data-testid={testId}>
      <Dot color={color} big />
      {label}
    </Pressable>
  );
}

/** 只读行的“要新版本”（S12，kit 的 ReadonlyMark） */
// 只读标记单独一行：瀑布流放在正文下、底行上，列表放在摘要行下（视觉验收 11-11：挤在底行、摘要行会把时间、分类、“⋯”挤坏）
const RoMark = ({ ro, id, cls }: { ro: boolean; id: string; cls: string | undefined }) =>
  ro ? (
    <span className={cls}>
      <ReadonlyMark testId={`notes-ro-${id}`} />
    </span>
  ) : null;

function AiMark({ id }: { id: string }) {
  const t = useNotesT();
  return (
    <span className={styles.ai} aria-label={t('notes.aiLabel', {})} data-testid={`notes-ai-${id}`}>
      {t('notes.ai', {})}
    </span>
  );
}

/**
 * 底部输入行（视觉稿 .inrow、线框 COMPOSER）：右边是“图片”“拍照”，打了字才出“记下”；回车或点“记下”就存；没存上把这句放回输入框。
 * 选了图：输入框里的字和图一起记成新的一条（onImage），没记上同样放回。有撤销条、只读提示时连同上面的提示条整块往上让一格（外框 .dockUp，NotesPage.module.css）
 */
function InputRow({
  field: input,
  onTyping,
  onAdd,
  onImage,
}: {
  /** 页面拿着，点模糊层时让它失焦（R-401） */
  field: RefObject<HTMLInputElement | null>;
  /** 输入框得到 / 失去焦点（页面据此画不画模糊层） */
  onTyping(on: boolean): void;
  onAdd(text: string): Promise<boolean>;
  onImage(text: string, file: File): Promise<boolean>;
}) {
  const t = useNotesT();
  const [draft, setDraft] = useState('');
  const has = draft.trim() !== '';
  useLayoutEffect(() => {
    notesInput.focus = () => focusInPlace(input.current, 'open');
    return () => {
      notesInput.focus = undefined;
    };
  }, [input]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft;
    rlog(`notes submit len=${text.length} trim=${text.trim().length}`);
    if (text.trim() === '') return;
    setDraft('');
    const ok = await onAdd(text);
    rlog(`notes add ${ok ? 'ok' : 'failed'}`);
    if (!ok) setDraft(text);
  };
  const image = async (file: File) => {
    const text = draft;
    setDraft('');
    if (!(await onImage(text, file))) setDraft(text);
  };
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- mousedown 只拦失焦（台账 Q-25，platform/viewport.ts 的 keepFieldFocus），不是交互，键盘操作不受影响
    <form className={styles.inrow} onSubmit={(e) => void submit(e)} onMouseDown={keepFieldFocus} data-testid="notes-input-row">
      <input
        ref={input}
        className={styles.input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('notes.input', {})}
        aria-label={t('notes.inputLabel', {})}
        enterKeyHint="done"
        onTouchStart={inPlaceTouchStart}
        onTouchEnd={inPlaceTouchEnd}
        onFocus={() => onTyping(true)}
        onBlur={() => onTyping(false)}
        data-testid="notes-input"
      />
      <PickButtons onFile={(f) => void image(f)} className={styles.img} idPrefix="notes" camera={false} />
      {has ? (
        <Pressable type="submit" className={styles.add} data-testid="notes-add">
          {t('notes.add', {})}
        </Pressable>
      ) : null}
    </form>
  );
}
