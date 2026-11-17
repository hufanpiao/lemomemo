// 月格（B2 FA-3，架构 5.12 第 2 点、R-98、R-100、R-104、R-105；R-445 负责人 11-17 逐项选定的样式，定稿图 柠檬记APP-本机资料\设计方案6-11-17_日历月周\定稿）：
// 6×7 格，格子由前端 B 的 buildMonth 算好，这里只画
// • 圆角小格块、格与格之间 4pt 缝（令牌 --cal-gap、--cal-cell-r）；周六周日淡底加灰字（--cal-wkend、--cal-wkend-fg）；补位格半透明、字淡（--cal-out）
// • 每格三层：日期数字（今天：淡黄色小框 --today-*，R-445 改 R-132；选中那天：数字深色小方块 --cal-sel-*，取代原来整格的框）；
//   一行文字（节假日 > 节气 > 农历），纪念日在这行后面加菱形（柠檬黄填充 + 正文色边，深色模式自动浅色边，R-105）；
//   “两国都显示”时另一国的节日名小一号写在第二行（R-97，放不下省略）；
//   下面是事项标签：底色是项目块色 --pN，左侧 2 px 深色竖线 --pNs，字 --on-p，9.5 px（R-104 有意例外，不要改）；按排（slot）画，多出来写“+N”
// • 跨天日程（R-444，R-445 选“一整条色块”）：同一周里画成一整条（段头那一格的标签按 --cols 加宽，伸进右边几格；pointer-events 不接点按），
//   跨到下一周另起一段、开头再写一次名字、字淡一档（--on-p-2），不画左侧深色竖线
// • 放假格子画柠檬黄细斜虚线（--hol-stripe），节日名用柠檬黄系（--hol-name）；调休补班格子画小圆点阵（--work-stripe，R-445 选“② 小圆点阵”），
//   右上角“班”小圆标（韩文“근무”放得下的胶囊），那一行只写节日名（“班”已在圆标里）。斜纹类和手机泳道、电脑周视图共用（cal-ui.ts dayKind / dayKindClass）
// • 连续放假只在第一天写节日名，后面几天照常写节气或农历（cal-ui.ts namedHolidays）；读屏名字照旧念出这天属于哪个节假日
// • 读屏：每格是一个按钮，名字先按显示顺序念格子里看得见的字（日期数字、那一行、第二个节日名、事项简称、“+N”，WCAG 2.5.3），
//   再接“日期、星期几、今天、节假日、节气、农历（完整写法）、共几件、按项目汇总的件数、另有几件未显示、有纪念日”（cal-ui.ts labelInName）
// • 点一格：选中那一天（aria-pressed），下面的清单列出当天全部日程和待办（线框 s3）
// • 上拖收起（线框 s3、R-326）：fold 给出锚点那一行、进度 p 和要上移的像素；只动 transform、opacity（17.2 第 6 点），布局不变。
//   别的行跟着淡出；收起后别的行 inert（点不到、读屏和 Tab 都跳过）
import { Fragment, type CSSProperties, type Ref } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { WeekStart } from '../../../../shared/logic/calendar/cal-nav.ts';
import type { HolidayMark } from '../../../../shared/logic/calendar/holidays.ts';
import type { MonthCell, MonthMark } from '../../../../shared/logic/calendar/month-grid.ts';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import styles from './CalendarPage.module.css';
import { colorClass, dayKind, dayKindClass, dayLines, holA11y, labelInName, namedHolidays, weekdayKey, weekendClass, type DayLines } from './cal-ui.ts';

/** 这一格里画出来的标签：单日的、跨天色块的段头（段里别的格子只空出那一排） */
const drawn = (mk: MonthMark): boolean => mk.bar === undefined || mk.bar.head;

/** 一条标签：跨天的段头按格数加宽（--cols），续条（头是从前面接过来的）字淡一档、不画左侧深色竖线 */
function Mark({ mk }: { mk: MonthMark }) {
  const bar = mk.bar;
  const cls = [styles.mark, colorClass(mk.colorIndex), bar ? styles.bar : '', bar?.before ? styles.barCont : ''].filter(Boolean).join(' ');
  return (
    <span className={cls} style={bar ? ({ '--cols': bar.cols } as CSSProperties) : undefined} aria-hidden="true" data-item={mk.itemId}>
      {mk.short}
    </span>
  );
}

/** 按排画：前面空着的排（被左边的跨天色块占着、或这一排没东西）垫一格同高的空位，后面的标签才对得上同一排 */
function Marks({ marks }: { marks: readonly MonthMark[] }) {
  let next = 0;
  return marks.map((mk) => {
    const gap = mk.slot - next;
    next = mk.slot + 1;
    const pad = Array.from({ length: Math.max(0, gap) }, (_, i) => <span key={`gap-${mk.slot}-${i}`} className={styles.markGap} aria-hidden="true" />);
    return (
      <Fragment key={mk.itemId}>
        {pad}{' '}
        {drawn(mk) ? <Mark mk={mk} /> : <span className={styles.markGap} aria-hidden="true" />}
      </Fragment>
    );
  });
}

/** 一格的读屏名字（lines 是 cal-ui.ts dayLines 的结果，和画出来的同一份） */
function labelOf(c: MonthCell, t: CalViewT, lines: DayLines, lunarSay?: (date: DateStr) => string | undefined): string {
  const [, m = '1', d = '1'] = c.date.split('-');
  const { badge, line, hol2 } = lines;
  // 看得见的字，和下面画的顺序一致
  const shown = [String(Number(d)), badge, line, hol2, ...c.marks.filter(drawn).map((mk) => mk.short), c.more > 0 ? t('cal.more', { n: c.more }) : ''];
  const parts = [t('cal.a11y.date', { m: Number(m), d: Number(d) }), t('cal.wdFull', { wd: t(weekdayKey(c.weekday), {}) })];
  if (c.isToday) parts.push(t('cal.a11y.todayMark', {}));
  // 连休后几天格子里不写节日名，读屏照旧念出这天属于哪个节假日
  for (const h of c.holidays) parts.push(holA11y(h, t));
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
  return labelInName(shown, parts, t('cal.a11y.sep', {}));
}

function Cell({
  c,
  weekStart,
  holidays,
  t,
  selected,
  onSelect,
  lunarSay,
  fade,
  hidden,
}: {
  c: MonthCell;
  weekStart: WeekStart;
  /** 全部节假日（看前一天是不是同一个假期，namedHolidays） */
  holidays: ReadonlyMap<DateStr, readonly HolidayMark[]>;
  t: CalViewT;
  selected: boolean;
  onSelect: (date: DateStr) => void;
  lunarSay?: ((date: DateStr) => string | undefined) | undefined;
  /** 收起途中的不透明度（1 不淡出） */
  fade: number;
  /** 收起了、这一格不在锚点那一行 */
  hidden: boolean;
}) {
  const kind = dayKind(c.holidays);
  const lines = dayLines(kind, namedHolidays(c.date, c.holidays, holidays), c.solarTerm ?? c.lunar ?? '', t);
  const { badge, line, hol2 } = lines;
  const cls = [styles.cell, weekendClass(c.weekday), c.inMonth ? '' : styles.out, c.isToday ? styles.today : '', dayKindClass(kind), selected ? styles.sel : '']
    .filter(Boolean)
    .join(' ');
  // 有跨天色块的段头：这一格压在右边几格上面（色块伸进右边的格子里）；越靠左的越在上（色块只往右伸）
  const col = (c.weekday + 7 - weekStart) % 7;
  const style: CSSProperties = {
    ...(c.marks.some((mk) => mk.bar?.head === true && mk.bar.cols > 1) ? { zIndex: 8 - col } : {}),
    ...(fade < 1 ? { opacity: fade } : {}),
  };
  return (
    <button
      type="button"
      className={cls}
      aria-label={labelOf(c, t, lines, lunarSay)}
      aria-pressed={selected}
      onClick={() => onSelect(c.date)}
      data-date={c.date}
      inert={hidden}
      style={Object.keys(style).length > 0 ? style : undefined}
    >
      {/* 第一行：日期数字 + 补班标（标靠右；格子窄、放不下时折到下一行靠右，不压“今天”圆底） */}
      <span className={styles.cellTop} aria-hidden="true">
        <span className={styles.dayNum}>{Number(c.date.slice(8))}</span>
        {badge !== '' ? (
          <>
            {' '}
            <span className={styles.ban} data-testid="cal-ban">
              {badge}
            </span>
          </>
        ) : null}
      </span>{' '}
      {/* 几段字之间的 {' '}：格子是 flex，空格不画出来；给 axe 和读屏分词用（cal-ui.ts labelInName） */}
      {/* 这一行一直占着高度：农历按需加载，加载前后格子不跳动 */}
      <span className={lines.offName ? `${styles.line} ${styles.holName}` : styles.line} aria-hidden="true">
        <span className={styles.lineTx}>{line}</span>
        {c.anniv ? <span className={styles.dia} data-testid="cal-anniv" /> : null}
      </span>
      {hol2 !== '' ? (
        <>
          {' '}
          <span className={styles.hol2} aria-hidden="true">
            {hol2}
          </span>
        </>
      ) : null}
      {c.marks.length > 0 ? ' ' : null}
      <Marks marks={c.marks} />
      {c.more > 0 ? (
        <>
          {' '}
          <span className={styles.more} aria-hidden="true">
            {t('cal.more', { n: c.more })}
          </span>
        </>
      ) : null}
    </button>
  );
}

export function MonthGrid({
  cells,
  holidays,
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
  /** 全部节假日（和 buildMonth 用的同一份）：看前一天是不是同一个假期，连休只在第一天写节日名 */
  holidays: ReadonlyMap<DateStr, readonly HolidayMark[]>;
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
      {/* 收起时格子整片上移、从星期行底下穿过：星期行不垫底色（定稿图是透明的），由这一层把移出去的部分裁掉 */}
      <div className={styles.gridClip}>
      <div className={styles.grid} ref={gridRef} id={gridId} style={gridStyle}>
        {cells.map((c, i) => {
          const other = fold !== undefined && Math.floor(i / 7) !== fold.row;
          return (
            <Cell
              key={c.date}
              c={c}
              weekStart={weekStart}
              holidays={holidays}
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
      </div>
    </section>
  );
}
