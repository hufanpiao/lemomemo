// 电脑版今天页（B6；架构 5.9b，R-126 方案 B；定稿线框 s1 电脑画面、电脑版布局-对比“共用拖动规则”）：有侧栏的宽度才由 TodayPage 懒加载，手机宽度不下载
// • 五块（块 id 存进布局；改名、合并时旧 id 在读布局时丢掉、新 id 按默认位置补上，layout-model 的 fix）：
//   river（时间河：提示、“现在”卡、没赶上、今天的安排，一整块；B6 返工 11-14 把原来的 now 合进来）、week（本周每天几件）、
//   soon（30 天内的纪念日，最多 3 个）、notes-today（今天记的随手记，notes 功能给的块）、keys（快捷键提示）
// • 默认两栏（线框 s1：左边时间河、右边“本周、快到了、今天记的、快捷键提示”；B6 代定，5.9b 第 2 点的例子写 3 栏，以线框为准）
// • 本周、快到了、今天记的三块标题右边有跳转（日历 ›、纪念日 ›、随手记 ›）；“今天记的”标题后带条数（线框 ANNB、NOTESTODAY）
// • 页顶日期行固定不动（对比稿“固定不动”）：日期后面的农历（Lunar，中文界面才有，同月历）由 TodayPage 挂在 h1 里，纪念日胶囊复用手机今天页的 AnnivLine
// • 选中一条：详情抽屉从右边盖上来（线框 s1 第二张；× / Esc 关，能换到左边）。外壳是 kit 的 DetailDrawer（和随手记同一个），
//   里面是待办、日程编辑器（todos、calendar 的 index.ts 懒加载）；“今天记的”里的随手记用 notes 给的 TodayNotes part="drawer"，就是随手记页那个 NoteDrawer
//   （外壳、读屏名字、testid 两页同一份，B6 整合）；选中的是哪一条由 TodayPage 管（kit useDrawerSel）
// • 排法、拖动、收起、保存都在 kit 的 DeskLayout；这里只给块的标题和内容
// • 键盘（线框 s1“J / K 上下 · E 完成 · Enter 编辑”）：J / K 在今天页各行之间移焦点，E 勾选焦点所在的待办，Enter 是按钮自带的打开
//   （焦点在输入框里时单字母键不生效，kit 的 useKeys）
import { Suspense, useState, type CSSProperties, type ReactNode } from 'react';
import { fmtDay, weekdayName } from '../../../../shared/i18n/fmt.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import { LAYOUT_V, type DeskLayoutValue } from '../../../../shared/schema/layout.ts';
import { navigate } from '../../../app/router.ts';
import DeskLayout from '../../../kit/components/DeskLayout/DeskLayout.tsx';
import { DetailDrawer } from '../../../kit/components/DetailDrawer.tsx';
import { AnnivAvatarSlot } from '../../../kit/components/AnnivAvatar.tsx';
import list from '../../../kit/components/List.module.css';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { useKeys } from '../../../kit/hooks/useKeys.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { isTauri } from '../../../platform/env.ts';
import { AnnivFace } from '../../anniv/index.ts';
import { EventDrawerEditor } from '../../calendar/index.ts';
import { TodayNotes } from '../../notes/index.ts';
import { TodoDrawerEditor } from '../../todos/index.ts';
import { annivLabel, annivWhen, nameOf, useAnnivUpcoming } from '../hooks/useAnnivUpcoming.ts';
import { useLunarToday, useWeekBusy } from '../hooks/useTodayDesk.ts';
import { useLocale, useTodayT } from '../hooks/useTodayT.ts';
import { todayDeskKo } from '../i18n/desk-ko.ts';
import { todayDeskZh } from '../i18n/desk-zh.ts';
import styles from './TodayDesk.module.css';

const useTodayDeskT = makeUseT({ zh: todayDeskZh, ko: todayDeskKo });

/** 默认布局（写在代码里；没存过布局时用它，“恢复默认布局”把它写回 settings） */
export const TODAY_DEFAULT: DeskLayoutValue = {
  v: LAYOUT_V,
  cols: [
    { w: 0.56, panels: ['river'] },
    { w: 0.44, panels: ['week', 'soon', 'notes-today', 'keys'] },
  ],
  collapsed: [],
  drawer: 'right',
  locked: false,
};

/** “快到了”看多少天、最多几个 */
const SOON_DAYS = 30;
const SOON_MAX = 3;

/** 抽屉里开着的是哪一条 */
export interface TodaySel {
  kind: 'event' | 'todo' | 'note';
  id: string;
}

export interface TodayDeskProps {
  today: DateStr;
  /** 时间河块：提示、“现在”卡、没赶上、今天的安排（TodayPage 画好的） */
  river: ReactNode;
  sel: TodaySel | null;
  /** “今天记的”里点了一条随手记（日程、待办的行在 river 里）：TodayPage 的 open，先判只读再开抽屉 */
  onOpen(sel: TodaySel): void;
  onClose(): void;
}

const noop = (): void => undefined;

export default function TodayDesk({ today, river, sel, onOpen, onClose }: TodayDeskProps) {
  const t = useTodayDeskT();
  const [notesN, setNotesN] = useState(0);
  useJk();
  const panels = {
    river: { title: t('desk.river', {}), body: river },
    week: { title: t('desk.week', {}), go: { label: t('desk.goCal', {}), onClick: () => void navigate('calendar') }, body: <Week today={today} /> },
    soon: { title: t('desk.soon', {}), go: { label: t('desk.goAnniv', {}), onClick: () => void navigate('anniv') }, body: <Soon today={today} /> },
    'notes-today': {
      title: t('desk.notesN', { n: notesN }),
      go: { label: t('desk.goNotes', {}), onClick: () => void navigate('notes') },
      body: (
        <QuietBoundary name="today-notes">
          <Suspense fallback={null}>
            <TodayNotes part="list" onCount={setNotesN} onOpen={(id) => onOpen({ kind: 'note', id })} selected={sel?.kind === 'note' ? sel.id : null} />
          </Suspense>
        </QuietBoundary>
      ),
    },
    keys: { title: t('desk.keysTitle', {}), body: <p className={styles.tip}>{t(isTauri() ? 'desk.tipExe' : 'desk.tipWeb', {})}</p> },
  };
  const drawer = sel ? (side: 'left' | 'right', handle: ReactNode) => <TodayDrawer sel={sel} side={side} handle={handle} onClose={onClose} /> : undefined;
  return (
    <>
      <p className={styles.keys} aria-hidden="true">
        {t('desk.keys', {})}
      </p>
      <DeskLayout page="today" def={TODAY_DEFAULT} panels={panels} drawer={drawer} />
    </>
  );
}

/** 日期后面的农历（线框 TODAY_TOP“10月24日 周六 农历九月十五”）：中文界面才有（同月历，韩文界面不加载农历）；农历表按需加载，没好、失败时不画 */
export function Lunar({ today }: { today: DateStr }) {
  const t = useTodayDeskT();
  const d = useLunarToday(today);
  return d ? <small className={styles.lunar}>{t('desk.lunar', { d })}</small> : null;
}

/** 详情抽屉（kit 的 DetailDrawer：Esc、×、焦点还回去，关上时按行按钮的 data-open 找回这一行）：待办、日程编辑器的外壳在这里；
 *  随手记用 notes 给的同一个 NoteDrawer（TodayNotes part="drawer"，外壳只有那一份），按需下载时挂起在这一层 */
function TodayDrawer({ sel, side, handle, onClose }: { sel: TodaySel; side: 'left' | 'right'; handle: ReactNode; onClose(): void }) {
  const t = useTodayDeskT();
  const Editor = sel.kind === 'todo' ? TodoDrawerEditor : EventDrawerEditor;
  const body = (x: ReactNode) => (
    <QuietBoundary name="today-drawer">
      <Suspense fallback={null}>{x}</Suspense>
    </QuietBoundary>
  );
  return sel.kind === 'note' ? (
    body(<TodayNotes part="drawer" id={sel.id} side={side} handle={handle} onClose={onClose} />)
  ) : (
    <DetailDrawer id={sel.id} label={t('desk.drawer', {})} onClose={onClose} side={side} handle={handle} data-testid="today-drawer">
      {body(<Editor key={sel.id} id={sel.id} onCreated={noop} />)}
    </DetailDrawer>
  );
}

/** J / K / E（线框 s1）：今天页里可点的行（kit List 的 .main 按钮）之间移焦点；E 勾选焦点那一行的待办 */
function useJk(): void {
  const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`main[data-feature="today"] li .${list.main}`)];
  const step = (d: 1 | -1) => (): boolean => {
    const all = rows();
    if (!all.length) return false;
    const cur = all.findIndex((el) => el === document.activeElement || el.parentElement?.contains(document.activeElement));
    all[cur < 0 ? (d > 0 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, cur + d))]?.focus();
    return true;
  };
  useKeys({
    j: step(1),
    k: step(-1),
    e: () => {
      const li = (document.activeElement as HTMLElement | null)?.closest('main[data-feature="today"] li');
      const box = li?.querySelector<HTMLElement>('[data-testid^="today-done-"]');
      if (!box) return false;
      box.click();
      return true;
    },
  });
}

/** 本周：每天一根柱子（高度按这周最多的那天比例），下面星期几、日期；今天那根柠檬黄 */
function Week({ today }: { today: DateStr }) {
  const t = useTodayDeskT();
  const locale = useLocale();
  const days = useWeekBusy(today);
  const max = Math.max(1, ...days.map((x) => x.n));
  return (
    <ol className={styles.week} data-testid="today-week">
      {days.map((x, i) => (
        <li key={x.date} className={styles.wd} data-today={x.date === today ? '' : undefined} aria-label={t('desk.weekDay', { w: fmtDay(x.date, locale, 'monthDayWeek'), n: x.n })}>
          <span className={styles.wbarBox} aria-hidden="true">
            <span className={styles.wbar} style={{ '--h': x.n / max } as CSSProperties} />
          </span>
          <span className={styles.wname} aria-hidden="true">
            {weekdayName((i + 1) % 7, locale)}
          </span>
          <span className={styles.wnum} aria-hidden="true">
            {Number(x.date.slice(8))}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** 快到了：30 天内的纪念日，最多 3 个；名字、“3 天后”和手机纪念日一行同一份（生日加“生日”）；点了进纪念日页的这一条 */
function Soon({ today }: { today: DateStr }) {
  const t = useTodayDeskT();
  const tt = useTodayT();
  const soon = useAnnivUpcoming(today, SOON_DAYS, SOON_MAX);
  if (!soon.length) return <p className={list.empty}>{t('desk.soonNone', { n: SOON_DAYS })}</p>;
  return (
    <ul className={list.list} data-testid="today-soon">
      {soon.map(({ row, days }) => (
        <li key={row.id} className={list.row}>
          <button type="button" className={list.main} onClick={() => void navigate('anniv', row.id)}>
            <AnnivAvatarSlot Face={AnnivFace} id={row.id} avatarId={row['avatar_id']} name={nameOf(row)} kind={row['kind']} size="xs" />
            <span className={list.text}>
              <span className={list.title}>{annivLabel(row, tt)}</span>
              <span className={list.meta}>{annivWhen(days, tt)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
