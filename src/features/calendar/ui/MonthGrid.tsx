// 月格（B2 FA-3，架构 5.12 第 2 点、R-98、R-100、R-104、R-105；定稿线框 s3、皮肤视觉稿 .mv-c）：6×7 格，格子由前端 B 的 buildMonth 算好，这里只画
// • 每格三层：日期数字（今天：简洁·浅色是墨色细圈、其余皮肤是柠檬黄底，令牌 --today-bg/--today-ring，R-132）；
//   一行文字（节假日 > 节气 > 农历），纪念日在这行后面加菱形（柠檬黄填充 + 正文色边，深色模式自动浅色边，R-105）；
//   “两国都显示”时另一国的节日名小一号写在第二行（R-97，放不下省略）；
//   下面是事项标签：底色是项目块色 --pN，左侧 2 px 深色竖线 --pNs，字 --on-p，9.5 px（R-104 有意例外，不要改）；多出来写“+N”
// • 放假只用灰底（--hol-bg），周末、节日名都不另上颜色（设计审查 M4）
// • 读屏：每格是一个按钮，名字是“日期、星期几、今天、节假日、节气、农历（完整写法）、共几件、按项目汇总的件数、另有几件未显示、有纪念日”
// • 点一格：选中那一天（aria-pressed），下面的清单列出当天全部日程和待办（线框 s3）
// • 上拖收起（线框 s3、R-326）：fold 给出锚点那一行、进度 p 和要上移的像素；只动 transform、opacity（17.2 第 6 点），布局不变。
//   别的行跟着淡出；收起后别的行 inert（点不到、读屏和 Tab 都跳过）
import type { CSSProperties, Ref } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { WeekStart } from '../../../../shared/logic/calendar/cal-nav.ts';
import type { MonthCell } from '../../../../shared/logic/calendar/month-grid.ts';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import styles from './CalendarPage.module.css';
import { colorClass, holText, workdayA11y, weekdayKey } from './cal-ui.ts';

/** 一格的读屏名字 */
export function cellLabel(c: MonthCell, t: CalViewT, lunarSay?: (date: DateStr) => string | undefined): string {
  const [, m = '1', d = '1'] = c.date.split('-');
  const parts = [t('cal.a11y.date', { m: Number(m), d: Number(d) }), t('cal.wdFull', { wd: t(weekdayKey(c.weekday), {}) })];
  if (c.isToday) parts.push(t('cal.a11y.todayMark', {}));
  for (const h of c.holidays) parts.push(h.kind === 'work' ? workdayA11y(h.name, (name) => t('cal.a11y.workday', { name })) : h.name);
  if (c.solarTerm) parts.push(c.solarTerm);
  if (c.lunar) parts.push(t('cal.a11y.lunar', { text: lunarSay?.(c.date) ?? c.lunar }));
  const total = c.a11y.reduce((n, p) => n + p.count, 0);
  if (total === 0) parts.push(t('cal.a11y.none', {}));
  else parts.push(t('cal.a11y.total', { n: total }));
  for (const p of c.a11y) {
    parts.push(p.project === '' ? t('cal.a11y.noProject', { n: p.count }) : t('cal.a11y.project', { project: p.project, n: p.count }));
  }
  if (c.more > 0) parts.push(t('cal.a11y.hidden', { n: c.more }));
  if (c.anniv) parts.push(t('cal.a11y.anniv', {}));
  return parts.join(t('cal.a11y.sep', {}));
}

function Cell({
  c,
  t,
  selected,
  onSelect,
  lunarSay,
  fade,
  hidden,
}: {
  c: MonthCell;
  t: CalViewT;
  selected: boolean;
  onSelect: (date: DateStr) => void;
  lunarSay?: ((date: DateStr) => string | undefined) | undefined;
  /** 收起途中的不透明度（1 不淡出） */
  fade: number;
  /** 收起了、这一格不在锚点那一行 */
  hidden: boolean;
}) {
  const off = c.holidays.some((h) => h.kind === 'off');
  const cls = [styles.cell, c.inMonth ? '' : styles.out, c.isToday ? styles.today : '', off ? styles.holiday : '', selected ? styles.sel : ''].filter(Boolean).join(' ');
  const [first, second] = c.holidays;
  const line = first ? holText(first, t('cal.workday', {}), { full: t('cal.subHolFull', {}), short: t('cal.subHolShort', {}) }) : (c.solarTerm ?? c.lunar ?? '');
  return (
    <button
      type="button"
      className={cls}
      aria-label={cellLabel(c, t, lunarSay)}
      aria-pressed={selected}
      onClick={() => onSelect(c.date)}
      data-date={c.date}
      inert={hidden}
      style={fade < 1 ? { opacity: fade } : undefined}
    >
      <span className={styles.dayNum} aria-hidden="true">
        {Number(c.date.slice(8))}
      </span>
      {/* 这一行一直占着高度：农历按需加载，加载前后格子不跳动 */}
      <span className={[styles.line, first ? styles.holName : styles.lunar, first?.kind === 'work' ? styles.work : ''].filter(Boolean).join(' ')} aria-hidden="true">
        <span className={styles.lineTx}>{line}</span>
        {c.anniv ? <span className={styles.dia} data-testid="cal-anniv" /> : null}
      </span>
      {second ? (
        <span className={styles.hol2} aria-hidden="true">
          {holText(second, t('cal.workday', {}), { full: t('cal.subHolFull', {}), short: t('cal.subHolShort', {}) })}
        </span>
      ) : null}
      {c.marks.map((mk) => (
        <span key={mk.itemId} className={`${styles.mark} ${colorClass(mk.colorIndex)}`} aria-hidden="true">
          {mk.short}
        </span>
      ))}
      {c.more > 0 ? (
        <span className={styles.more} aria-hidden="true">
          {t('cal.more', { n: c.more })}
        </span>
      ) : null}
    </button>
  );
}

export function MonthGrid({
  cells,
  weekStart,
  t,
  label,
  selected,
  onSelect,
  lunarSay,
  fold,
  gridRef,
  gridId,
}: {
  cells: readonly MonthCell[];
  weekStart: WeekStart;
  t: CalViewT;
  label: string;
  selected: DateStr | null;
  onSelect: (date: DateStr) => void;
  /** 农历的完整写法（读屏用）；农历没加载时不给 */
  lunarSay?: ((date: DateStr) => string | undefined) | undefined;
  /** 上拖收起：row 锚点那一行（0–5），p 进度（0 展开、1 收起），shiftY 收起时整片格子上移多少 px，collapsed 已定为收起 */
  fold?: { row: number; p: number; shiftY: number; collapsed: boolean } | undefined;
  gridRef?: Ref<HTMLDivElement> | undefined;
  gridId?: string | undefined;
}) {
  const p = fold?.p ?? 0;
  const gridStyle: CSSProperties | undefined = p > 0 && fold ? { transform: `translateY(${-fold.shiftY * p}px)` } : undefined;
  const heads = Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
  return (
    <section aria-label={label} data-testid="cal-month" className={`${styles.card} ${styles.monthCard}`}>
      <div className={styles.weekdays} aria-hidden="true">
        {heads.map((wd) => (
          <span key={wd} className={styles.wd}>
            {t(weekdayKey(wd), {})}
          </span>
        ))}
      </div>
      <div className={styles.grid} ref={gridRef} id={gridId} style={gridStyle}>
        {cells.map((c, i) => {
          const other = fold !== undefined && Math.floor(i / 7) !== fold.row;
          return (
            <Cell
              key={c.date}
              c={c}
              t={t}
              selected={c.date === selected}
              onSelect={onSelect}
              lunarSay={lunarSay}
              fade={other ? 1 - p : 1}
              hidden={other && fold?.collapsed === true}
            />
          );
        })}
      </div>
    </section>
  );
}

/** 月历底部常驻图例（线框 s3、视觉稿 .legend）：节假日在哪里改、标签是什么、+N、纪念日菱形 */
export function MonthLegend({ t, country, fade = 1 }: { t: CalViewT; country: string; /** 上拖收起途中跟着淡出，0 时读屏也跳过 */ fade?: number }) {
  return (
    <div className={styles.legend} data-testid="cal-legend" style={fade < 1 ? { opacity: fade } : undefined} aria-hidden={fade === 0 || undefined}>
      <span>
        <i className={styles.legHol} aria-hidden="true" />
        {t('cal.leg.hol', { country })}
      </span>
      <span>
        <i className={`${styles.mark} ${styles.legTag} ${styles.c2}`} aria-hidden="true">
          {t('cal.leg.tagSample', {})}
        </i>
        {t('cal.leg.tag', {})}
      </span>
      <span>{t('cal.leg.more', {})}</span>
      <span>
        <i className={styles.dia} aria-hidden="true" />
        {t('cal.leg.anniv', {})}
      </span>
    </div>
  );
}
