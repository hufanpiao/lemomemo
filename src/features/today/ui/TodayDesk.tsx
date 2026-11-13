// 电脑版今天页（B6；架构 5.9b，R-126 方案 B；定稿线框 s1 电脑画面）：有侧栏的宽度才由 TodayPage 懒加载，手机宽度不下载
// • 五块（块 id 存进布局，改名要写迁移）：now（“现在”卡、错过的提醒、没赶上）、river（今天的安排）、week（本周每天几件）、
//   soon（30 天内的纪念日，最多 3 个）、notes-today（今天记的随手记，notes 功能给的块）
// • 默认两栏（线框 s1：左边时间河一栏、右边“本周、快到了、今天记的”一栏；B6 代定，5.9b 第 2 点的例子写 3 栏，以线框为准）
// • 排法、拖动、收起、保存都在 kit 的 DeskLayout；这里只给块的标题和内容
// • 键盘（线框 s1“J / K 上下 · E 完成 · Enter 编辑”）：J / K 在今天页各行之间移焦点，E 勾选焦点所在的待办，Enter 是按钮自带的打开
//   （焦点在输入框里时单字母键不生效，kit 的 useKeys）
import { lazy, Suspense, type CSSProperties, type ReactNode } from 'react';
import { fmtDay, weekdayName } from '../../../../shared/i18n/fmt.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import { LAYOUT_V, type DeskLayoutValue } from '../../../../shared/schema/layout.ts';
import { navigate } from '../../../app/router.ts';
import { AnnivAvatarSlot } from '../../../kit/components/AnnivAvatar.tsx';
import list from '../../../kit/components/List.module.css';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { useKeys } from '../../../kit/hooks/useKeys.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { AnnivFace } from '../../anniv/index.ts';
import { TodayNotes } from '../../notes/index.ts';
import { useAnnivUpcoming, useWeekBusy } from '../hooks/useTodayDesk.ts';
import { useLocale, useTodayT } from '../hooks/useTodayT.ts';
import { deskKo } from '../i18n/desk-ko.ts';
import { deskZh } from '../i18n/desk-zh.ts';
import styles from './TodayDesk.module.css';

const DeskLayout = lazy(() => import('../../../kit/components/DeskLayout/DeskLayout.tsx'));
const useDeskT = makeUseT({ zh: deskZh, ko: deskKo });

/** 默认布局（写在代码里，不进 settings；“恢复默认布局”= 删掉那一行设置） */
export const TODAY_DEFAULT: DeskLayoutValue = {
  v: LAYOUT_V,
  cols: [
    { w: 0.56, panels: ['now', 'river'] },
    { w: 0.44, panels: ['week', 'soon', 'notes-today'] },
  ],
  collapsed: [],
  drawer: 'right',
  locked: false,
};

/** “快到了”看多少天、最多几个 */
const SOON_DAYS = 30;
const SOON_MAX = 3;

export interface TodayDeskProps {
  today: DateStr;
  /** “现在”块：错过的提醒、未同步提示、“现在”卡、没赶上（TodayPage 画好的） */
  nowBlock: ReactNode;
  /** 时间河块：今天的安排（TodayPage 画好的） */
  river: ReactNode;
}

export default function TodayDesk({ today, nowBlock, river }: TodayDeskProps) {
  const t = useDeskT();
  useJk();
  const panels = {
    now: { title: t('desk.now', {}), body: nowBlock },
    river: { title: t('desk.river', {}), body: river },
    week: { title: t('desk.week', {}), body: <Week today={today} /> },
    soon: { title: t('desk.soon', {}), body: <Soon today={today} /> },
    'notes-today': {
      title: t('desk.notes', {}),
      body: (
        <QuietBoundary name="today-notes">
          <Suspense fallback={null}>
            <TodayNotes />
          </Suspense>
        </QuietBoundary>
      ),
    },
  };
  return (
    <>
      <p className={styles.keys} aria-hidden="true">
        {t('desk.keys', {})}
      </p>
      <Suspense fallback={null}>
        <DeskLayout page="today" def={TODAY_DEFAULT} panels={panels} />
      </Suspense>
    </>
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
  const t = useDeskT();
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

/** 快到了：30 天内的纪念日，最多 3 个；点了进纪念日页的这一条 */
function Soon({ today }: { today: DateStr }) {
  const t = useDeskT();
  const tt = useTodayT();
  const soon = useAnnivUpcoming(today, SOON_DAYS, SOON_MAX);
  if (!soon.length) return <p className={list.empty}>{t('desk.soonNone', {})}</p>;
  return (
    <ul className={list.list} data-testid="today-soon">
      {soon.map(({ row, days }) => {
        const name = typeof row['name'] === 'string' ? row['name'] : '';
        return (
          <li key={row.id} className={list.row}>
            <button type="button" className={list.main} onClick={() => void navigate('anniv', row.id)}>
              <AnnivAvatarSlot Face={AnnivFace} id={row.id} avatarId={row['avatar_id']} name={name} kind={row['kind']} size="xs" />
              <span className={list.text}>
                <span className={list.title}>{name}</span>
                <span className={list.meta}>{days === 0 ? tt('today.anniv.today', {}) : days === 1 ? tt('today.anniv.tomorrow', {}) : tt('today.anniv.in', { n: days })}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
