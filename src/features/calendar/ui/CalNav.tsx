// 月历页的两个小部件（B2 FA-3；从 CalendarPage.tsx 拆出来）
// • CalNav：页顶第二行，左边“周 / 月 / 纪念日”分段，右边“‹ 今天 ›”（视觉 32 px、点按区各 44 px、间距 12 px 刚好相接，设计复审 N6）。
//   “今天”在本月 / 本周时灰（aria-disabled，焦点不丢）；到头时 ‹ › 也 aria-disabled（代码审查 L1、L3）；
//   byWeek 时 ‹ › 的名字是“上一周 / 下一周”（周视图，或月视图收起成一周时）
// • FoldHandle：月视图日清单顶上的拖动柄（上拖收起，线框 s3、R-326）。本身是按钮：aria-expanded 说明月历展没展开，
//   键盘、读屏、点一下切换；按住上下拖跟手（手势在 motion 的 useDragCollapse），拖过以后的那一下点击被吞掉
import { navigate } from '../../../app/router.ts';
import type { DragCollapse } from '../../../motion/index.ts';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import styles from './CalendarPage.module.css';

export function CalNav({
  t,
  month,
  byWeek,
  canPrev,
  canNext,
  isCurrent,
  onMode,
  onPrev,
  onNext,
  onToday,
}: {
  t: CalViewT;
  month: boolean;
  /** ‹ › 按周翻（周视图，或月视图收起成一周时） */
  byWeek: boolean;
  canPrev: boolean;
  canNext: boolean;
  isCurrent: boolean;
  onMode: (m: 'week' | 'month') => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  return (
    <div className={styles.calnav}>
      <div className={styles.seg} role="group" aria-label={t('cal.modeLabel', {})}>
        <button type="button" className={styles.segBtn} aria-pressed={!month} onClick={() => onMode('week')} data-testid="cal-mode-week">
          {t('cal.week', {})}
        </button>
        <button type="button" className={styles.segBtn} aria-pressed={month} onClick={() => onMode('month')} data-testid="cal-mode-month">
          {t('cal.month', {})}
        </button>
        <button type="button" className={styles.segBtn} aria-pressed={false} onClick={() => void navigate('anniv')} data-testid="cal-mode-anniv">
          {t('cal.anniv', {})}
        </button>
      </div>
      <div className={styles.navBtns}>
        <button
          type="button"
          className={styles.nb}
          aria-label={t(byWeek ? 'cal.prevWeek' : 'cal.prevMonth', {})}
          aria-disabled={!canPrev || undefined}
          onClick={() => canPrev && onPrev()}
          data-testid="cal-prev"
        >
          ‹
        </button>
        <button type="button" className={styles.tdy} aria-disabled={isCurrent || undefined} onClick={() => !isCurrent && onToday()} data-testid="cal-today">
          {t('cal.today', {})}
        </button>
        <button
          type="button"
          className={styles.nb}
          aria-label={t(byWeek ? 'cal.nextWeek' : 'cal.nextMonth', {})}
          aria-disabled={!canNext || undefined}
          onClick={() => canNext && onNext()}
          data-testid="cal-next"
        >
          ›
        </button>
      </div>
    </div>
  );
}

export function FoldHandle({ t, collapsed, controls, drag }: { t: CalViewT; collapsed: boolean; controls: string; drag: DragCollapse }) {
  return (
    <button
      type="button"
      className={styles.fold}
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={t(collapsed ? 'cal.fold.expand' : 'cal.fold.collapse', {})}
      onPointerDown={(e) => {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // 测试环境（jsdom）没有指针捕获，不影响
        }
        drag.onPointerDown(e);
      }}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerCancel}
      onClickCapture={drag.onClickCapture}
      onClick={drag.toggle}
      data-testid="cal-fold"
    >
      <span className={styles.grab} aria-hidden="true" />
    </button>
  );
}
