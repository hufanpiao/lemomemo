// 年月选择器（B2 FA-3，架构 5.12 第 3 点、R-101；定稿线框 sYM、皮肤视觉稿 .ympop）：点页顶的标题胶囊从下面弹出（Radix Popover，kit/Popover）
// • 左列年（1900～2100，上下滚，打开时正在看的那一年滚到中间，只滚年列），右列 12 个月三列排；每格 44 px（不用滚轮、不用原生下拉）
// • 正在看的年月黑底（--ink），今天所在的年、月下面有小点；点一下月份就跳过去并收起；只点年份不收起，等选月份
// • 键盘：打开时焦点在正在看的那个月；月份格子里方向键移动（← → 一格，↑ ↓ 一行），回车 / 空格选中；年列里 ↑ ↓ 换年；
//   年列是一个 Tab 停靠点（roving tabindex：只有选中那一年 tabIndex 0，代码复审 N3），不用按 201 下 Tab 才出得去；
//   Esc、点外面、再点一次胶囊收起，焦点回到胶囊（Radix）
// • 底部“回到今天”：和分段控件右侧的“今天”一样，跳回今天并收起
// • 月视图选了跳到那个月；周视图跳到那个月 1 日所在的那一周（useCalendar 的 pick）
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MAX_YEAR, MIN_YEAR, type YearMonth } from '../../../../shared/logic/calendar/cal-nav.ts';
import { Popover } from '../../../kit/components/Popover.tsx';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import styles from './CalendarPage.module.css';

const YEARS = Array.from({ length: MAX_YEAR - MIN_YEAR + 1 }, (_, i) => MIN_YEAR + i);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

export interface MonthPickerProps {
  /** 正在看的年月 */
  value: YearMonth;
  /** 今天所在的年月（小点） */
  today: YearMonth;
  week: boolean;
  t: CalViewT;
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(ym: YearMonth): void;
  onToday(): void;
  trigger: ReactNode;
}

export function MonthPicker({ value, today, week, t, open, onOpenChange, onPick, onToday, trigger }: MonthPickerProps) {
  const [y, setY] = useState(value.y);
  const monthRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const yearList = useRef<HTMLDivElement | null>(null);

  // 每次打开从正在看的那一年开始
  useEffect(() => {
    if (open) setY(value.y);
  }, [open, value.y]);

  /** 把某一年滚到年列中间：只滚年列自己（不用 scrollIntoView，免得整页跟着滚） */
  const centerYear = (n: number): void => {
    const list = yearList.current;
    const el = list?.querySelector<HTMLElement>(`[data-year="${n}"]`);
    if (!list || !el) return;
    list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
  };

  // 换年（方向键、点年份）后保持在中间附近；打开那一下浮层内容还没挂上，在 onOpenAutoFocus 里滚
  useEffect(() => {
    if (open) centerYear(y);
  }, [open, y]);

  const focusMonth = (m: number): void => monthRefs.current[m - 1]?.focus();

  const onMonthKey = (e: KeyboardEvent<HTMLButtonElement>, m: number): void => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -3 : e.key === 'ArrowDown' ? 3 : 0;
    if (step === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const n = m + step;
    if (n >= 1 && n <= 12) focusMonth(n);
  };

  const onYearKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (step === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const n = Math.min(MAX_YEAR, Math.max(MIN_YEAR, y + step));
    setY(n);
    yearList.current?.querySelector<HTMLElement>(`[data-year="${n}"]`)?.focus();
  };

  return (
    <Popover
      trigger={trigger}
      label={t('cal.pick', {})}
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      className={styles.ympop}
      data-testid="cal-picker"
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        centerYear(value.y);
        focusMonth(value.m);
      }}
    >
      <div className={styles.ymCols}>
        <div>
          <div className={styles.ymHead} id="cal-pick-y">
            {t('cal.pickYear', {})}
          </div>
          <div className={styles.ymYears} ref={yearList} role="group" aria-labelledby="cal-pick-y">
            {YEARS.map((n) => (
              <button
                key={n}
                type="button"
                data-year={n}
                className={[styles.ymIt, n === y ? styles.ymOn : '', n === today.y ? styles.ymCur : ''].filter(Boolean).join(' ')}
                aria-pressed={n === y}
                tabIndex={n === y ? 0 : -1}
                onClick={() => setY(n)}
                onKeyDown={onYearKey}
              >
                {t('cal.pickYearItem', { y: n })}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className={styles.ymHead} id="cal-pick-m">
            {t('cal.pickMonth', {})}
          </div>
          <div className={styles.ymMonths} role="group" aria-labelledby="cal-pick-m">
            {MONTHS.map((m) => {
              const on = y === value.y && m === value.m;
              const cur = y === today.y && m === today.m;
              return (
                <button
                  key={m}
                  ref={(el) => {
                    monthRefs.current[m - 1] = el;
                  }}
                  type="button"
                  data-month={m}
                  className={[styles.ymIt, on ? styles.ymOn : '', cur ? styles.ymCur : ''].filter(Boolean).join(' ')}
                  aria-current={on ? 'date' : undefined}
                  onClick={() => {
                    onOpenChange(false);
                    onPick({ y, m });
                  }}
                  onKeyDown={(e) => onMonthKey(e, m)}
                >
                  {t('cal.pickMonthItem', { m })}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className={styles.ymFt}>
        <span className={styles.ymHint}>{t(week ? 'cal.pickHintWeek' : 'cal.pickHintMonth', {})}</span>
        <button
          type="button"
          className={styles.ymToday}
          onClick={() => {
            onOpenChange(false);
            onToday();
          }}
          data-testid="cal-picker-today"
        >
          {t('cal.backToday', {})}
        </button>
      </div>
    </Popover>
  );
}
