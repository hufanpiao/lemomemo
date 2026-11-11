// 随手记页（B4 S1、S2；交互照定稿线框 s7（第 873～907 行）、R-78（第 528 行），视觉照皮肤视觉稿 notesHead / PH.mason / PH.notes / DK.mason / DK.notes）
// • 两种显示：瀑布流（默认，手机两列、窗口 ≥ 900px 三列）和列表（按今天 / 昨天 / 日期分组）；页面上没有切换按钮，
//   只在“设置 › 随手记显示方式”里改，按设备类型分开记（R-78，hooks/useNotesView.ts）
// • 顶部：大标题 + 右上角头像（设置入口，同今天页；电脑上设置在侧栏，这里藏掉）；下面分类胶囊：全部 N + 各分类条数，只筛这一页（不写 settings）
// • 卡片 / 行：没有标题时取正文第一行当标题；分类前有 6px 色点（categories.color）；AI 分过、还没看过的标“AI”
//   瀑布流卡片底部：分类 · 时间 · “⋯”（看得见 24px，点按区用 ::after 透明扩到 44，不占排版宽度，视觉稿第 264～266 行）
//   列表一行：时刻 | 随手记小图标 | 标题和摘要 | “⋯”（视觉稿 PH.notes：44px 18px 1fr … 24px）
// • 点开：手机进编辑器 #/note/<id>；电脑（≥ 900px，有侧栏）从右边滑出详情抽屉（DK.mason），侧栏和列表留着，Esc 或“×”关
// • “⋯”打开菜单；右键（安卓长按）也打开同一个菜单。菜单现在只有“删除”（转成待办 / 日程 S8、移到隐私记 B5 以后加）；
//   瀑布流里不能左滑（R-78），列表的左滑以后和别的页一起加
// • 删除：软删，进“最近删除”，出 8 秒撤销条
// • 底部输入行（视觉稿 .inrow、线框 COMPOSER）：右边是“图片”“拍照”（主持人定 3），打了字才出“记下”；回车或点“记下”就存，新的一条出现在最上面、时间写“刚记下”。
//   选了图：先用输入框里的字（可以空）新建一条随手记，再把图插进去（S3，ui/NoteImages.tsx）。电脑上输入行铺满内容栏、左右各留 22px（DK.notes）
// • 插图（S3）：瀑布流卡片顶部放第一张（16:10、右上角“+N”）；插入、上传失败出提示条，空间满了的带“最近删除”入口
// • 底栏 / 侧栏的“＋”在这一页直接把光标放进输入行（R-380，线框“低 1”；app/App.tsx 按 tab-of.ts 的 NOTES_INPUT_ID 找）
// • 这一批不做：隐私记那一行（B5）、合并分类提示（S7）
// • 插图（S3）：卡片顶上放第一张图（多张标“+N”），列表行有图时在“⋯”前放缩略图；输入行只有“图片”（拍照在编辑页）
// • 只读行（S12，R-148，TC-B4-09；照待办页）：带认不出的值的行（core 的 readonlyIds）标“要新版本”（单独一行：瀑布流在正文下、底行上，列表在摘要行下），菜单里的“删除”变淡；点开、删除统一拦下
//   （不进编辑器、不开抽屉、不写），出 kit 的“这条要新版本才能修改 · 更新”（状态在 hooks/useNotesToast.ts）。左滑、多选还没有入口，以后加时同样先判只读
// • 动效只用现有的 AppearList（增删淡入淡出）和 Pressable（按下反馈）；抽屉只有最基本的滑入（R-376）
import { useEffect, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { fmtDay, fmtTime } from '../../../../shared/i18n/fmt.ts';
import { hrefOf, navigate, navigateTab, plainClick, useRoute } from '../../../app/router.ts';
import list from '../../../kit/components/List.module.css';
import { MeAvatar } from '../../../kit/components/MeAvatar.tsx';
import { ReadonlyMark, ReadonlyToast } from '../../../kit/components/ReadonlyRow.tsx';
import { Popover } from '../../../kit/components/Popover.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { useT } from '../../../kit/hooks/useT.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { AppearItem, AppearList, Pressable } from '../../../motion/components.ts';
import { useNoteList, type NoteItem } from '../hooks/useNoteList.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import { useNotesToast } from '../hooks/useNotesToast.ts';
import { useNotesViewValue } from '../hooks/useNotesView.ts';
import { NoteDrawer } from './NoteDrawer.tsx';
import NoteEditPage from './NoteEditPage.tsx';
import { CardCover, ListThumb, PickButtons, useAddImage, type ImgMsgKey } from './NoteImages.tsx';
import styles from './NotesPage.module.css';

/** 底部输入框的 id：底栏 / 侧栏的“＋”按它聚焦（R-380）。和 app/tab-of.ts 的 NOTES_INPUT_ID 同一个值（功能不能引 app 的这个文件，测试对着两边核） */
const NOTES_INPUT_ID = 'notes-input';

type Toast = { kind: 'undo'; id: string } | { kind: 'error' } | { kind: 'img'; key: ImgMsgKey; trash: boolean };

/** 有侧栏的宽窗口（和 GlassBar 侧栏同一个断点）：点开随手记用右边抽屉，不换页 */
const WIDE = '(width >= 900px)';
const wideNow = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches;
const onWide = (fn: () => void): (() => void) => {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const m = window.matchMedia(WIDE);
  m.addEventListener('change', fn);
  return () => m.removeEventListener('change', fn);
};
const useWide = (): boolean => useSyncExternalStore(onWide, wideNow, () => false);

/** 分类色点（只在有颜色时画） */
const Dot = ({ color, big }: { color: string | null; big?: boolean }) =>
  color === null ? null : <i className={big ? styles.dotBig : styles.dot} style={{ '--dot': color } as CSSProperties} aria-hidden="true" />;

/** #/notes 是列表，#/note/<id> 是编辑器：两条路由同一个分包（index.ts，B4 首屏额度），这里按路由名分 */
export default function NotesPage() {
  return useRoute().name === 'note' ? <NoteEditPage /> : <NotesList />;
}

function NotesList() {
  const t = useNotesT();
  const tApp = useT();
  const locale = useUi((s) => s.locale);
  const view = useNotesViewValue();
  const wide = useWide();
  const l = useNoteList();
  const { toast, setToast, guard, isRo, block, show, report, up } = useNotesToast<Toast>({ kind: 'error' }, (x) => x.kind === 'undo');
  const [menu, setMenu] = useState<string | null>(null);
  const [just, setJust] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);

  // 出错条、插图提示 4 秒后自己收起（带“最近删除”入口的留 8 秒，来得及点）
  useEffect(() => {
    if (toast === null || toast.kind === 'undo') return undefined;
    const id = setTimeout(() => setToast((x) => (x === toast ? null : x)), toast.kind === 'img' && toast.trash ? 8000 : 4000);
    return () => clearTimeout(id);
  }, [toast, setToast]);
  // 窗口缩到没有侧栏：抽屉收起（窄窗口点开走编辑页）
  useEffect(() => {
    if (!wide) setDrawer(null);
  }, [wide]);

  const open = (id: string) => {
    if (isRo(id)) block();
    else if (wide) setDrawer(id);
    else void navigate('note', id);
  };
  const del = async (id: string) => {
    setMenu(null);
    if (isRo(id)) return block();
    const r = await l.remove(id, true);
    if (r === 'ok') show({ kind: 'undo', id });
    else report(r);
  };
  const addImage = useAddImage(l, setJust, report, (m) => show({ kind: 'img', ...m }));
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

  const more = (it: NoteItem) => <MoreMenu id={it.id} ro={isRo(it.id)} open={menu === it.id} onOpenChange={(o) => setMenu(o ? it.id : null)} onDelete={() => void del(it.id)} />;
  const aiMark = (it: NoteItem) => (it.ai ? <AiMark id={it.id} /> : null);
  const onMenuKey = (id: string) => (e: { preventDefault(): void }) => {
    e.preventDefault();
    setMenu(id);
  };

  return (
    <main className={styles.page} data-feature="notes" data-testid="notes" data-view={view}>
      <header className={styles.top}>
        <h1 className={styles.h1}>{t('notes.title', {})}</h1>
        <a className={styles.me} href={hrefOf('settings')} onClick={(e) => plainClick(e) && navigateTab('settings')} aria-label={tApp('app.settings', {})} data-testid="notes-settings">
          <MeAvatar />
        </a>
      </header>

      {l.counts.length ? (
        <div className={styles.filter} role="group" aria-label={t('notes.filter', {})} data-testid="notes-filter">
          <Chip on={l.category === null} onClick={() => l.setCategory(null)} label={t('notes.all', { n: l.total })} color={null} testId="notes-filter-all" />
          {l.counts.map((c) => (
            <Chip key={c.id} on={l.category === c.id} onClick={() => l.setCategory(c.id)} label={`${c.name} ${c.count}`} color={c.color} testId={`notes-filter-${c.id}`} />
          ))}
        </div>
      ) : null}

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

      <div className={up ? `${styles.dock} ${styles.dockUp}` : styles.dock}>
        <InputRow up={up} onAdd={add} onImage={addImage} />
        {toast !== null && toast.kind !== 'undo' ? <DockTip toast={toast} /> : null}
      </div>

      {drawer !== null ? <NoteDrawer id={drawer} onClose={() => setDrawer(null)} /> : null}

      {toast?.kind === 'undo' ? (
        <UndoToast
          key={toast.id}
          message={t('notes.deleted', {})}
          undoLabel={t('notes.undo', {})}
          onUndo={() => void l.remove(toast.id, false).then(report)}
          onClose={() => setToast((x) => (x === toast ? null : x))}
          data-testid="notes-toast"
        />
      ) : null}
      <ReadonlyToast guard={guard} message={t('note.edit.st.readonly', {})} testId="notes-ro-toast" />
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

/** 输入行上面的提示条：没保存上，或插图提示（空间满了的带“最近删除”入口） */
function DockTip({ toast }: { toast: Exclude<Toast, { kind: 'undo' }> }) {
  const t = useNotesT();
  return (
    <p className={styles.error} role="alert" data-testid={toast.kind === 'error' ? 'notes-error' : 'notes-img-tip'}>
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

/** “⋯”菜单：看得见 24px，点按区 ::after 扩到 44；现在只有“删除”；转成待办 / 日程（S8）、移到隐私记（B5）以后加在这里 */
function MoreMenu({ id, ro, open, onOpenChange, onDelete }: { id: string; ro: boolean; open: boolean; onOpenChange(o: boolean): void; onDelete(): void }) {
  const t = useNotesT();
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={t('notes.menu', {})}
      align="end"
      className={styles.menu}
      trigger={
        <button type="button" className={styles.more} aria-label={t('notes.more', {})} data-testid={`notes-more-${id}`}>
          ⋯
        </button>
      }
    >
      {/* 只读行的“删除”变淡、aria-disabled，点了照样由 del 拦下出提示条（同待办页的 ×） */}
      <Pressable className={styles.menuItem} aria-disabled={ro || undefined} onClick={onDelete} data-testid={`notes-del-${id}`} data-no-proxy="">
        {t('notes.delete', {})}
      </Pressable>
    </Popover>
  );
}

/**
 * 底部输入行（视觉稿 .inrow、线框 COMPOSER）：右边是“图片”“拍照”，打了字才出“记下”；回车或点“记下”就存；没存上把这句放回输入框。
 * 选了图：输入框里的字和图一起记成新的一条（onImage），没记上同样放回。有撤销条、提示条时往上让一格（up）
 */
function InputRow({ up, onAdd, onImage }: { up: boolean; onAdd(text: string): Promise<boolean>; onImage(text: string, file: File): Promise<boolean> }) {
  const t = useNotesT();
  const [draft, setDraft] = useState('');
  const has = draft.trim() !== '';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft;
    if (text.trim() === '') return;
    setDraft('');
    if (!(await onAdd(text))) setDraft(text);
  };
  const image = async (file: File) => {
    const text = draft;
    setDraft('');
    if (!(await onImage(text, file))) setDraft(text);
  };
  return (
    <form className={up ? `${styles.inrow} ${styles.inrowUp}` : styles.inrow} onSubmit={(e) => void submit(e)} data-testid="notes-input-row">
      <input
        id={NOTES_INPUT_ID}
        className={styles.input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('notes.input', {})}
        aria-label={t('notes.inputLabel', {})}
        enterKeyHint="done"
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
