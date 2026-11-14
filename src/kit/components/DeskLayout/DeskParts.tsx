// 电脑版可拖动布局（5.9b）的小零件：块（标题栏 + 把手 + “–”）、栏间竖条、侧栏底部“⋯”菜单、抽屉换边把手。排法和状态在 DeskLayout.tsx
import { useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { DeskLayoutValue } from '../../../../shared/schema/layout.ts';
import { Popover } from '../Popover.tsx';
import { DndCol, useDeskSortable } from './DeskDnd.tsx';
import { useDeskT } from '../../hooks/useDeskT.ts';
import { resizeAt, resizeRange } from './layout-model.ts';
import styles from './DeskLayout.module.css';

export interface DeskPanel {
  title: string;
  body: ReactNode;
  /** 不能收起（不画“–”）：块里有页面离不开的东西时用，例如随手记的输入行（侧栏“＋”要聚焦它） */
  fixed?: boolean;
  /** 标题右边的跳转（线框 s1“日历 ›”“纪念日 ›”“随手记 ›”）：label 不带 ›，› 由这里画、读屏不读 */
  go?: { label: string; onClick(): void } | undefined;
  /** 大标题（线框 s7 随手记页：分类栏“随手记”22px、列表“全部 34”24px）；不给是 13px 灰字小标题 */
  big?: 22 | 24 | undefined;
}

/** 竖条键盘每次调多少（5.9b 第 5 点） */
const KEY_STEP = 0.05;

export const Dots = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    {[4, 8, 12].map((y) => [6, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" />))}
  </svg>
);

/** 一块：标题栏（标题、把手、“–”）+ 内容。把手只在能拖时画（锁定、一列时不画） */
export function Panel({ id, p, canDrag, held, hintId, onKey, onBlur, onCollapse }: { id: string; p: DeskPanel | undefined; canDrag: boolean; held: boolean; hintId: string; onKey(e: RKeyboardEvent<HTMLButtonElement>): void; onBlur(): void; onCollapse(): void }) {
  const t = useDeskT();
  const s = useDeskSortable(id, !canDrag);
  const titleId = `desk-${id}-t`;
  if (!p) return null;
  return (
    <section ref={s.ref} className={styles.panel} style={s.style} aria-labelledby={titleId} data-dragging={s.dragging ? '' : undefined} data-held={held ? '' : undefined} data-testid={`desk-panel-${id}`}>
      <header className={styles.head}>
        <h2 id={titleId} className={styles.title} data-big={p.big}>
          {p.title}
        </h2>
        {p.go ? (
          <button type="button" className={styles.go} onClick={p.go.onClick} data-testid={`desk-go-${id}`}>
            {p.go.label}
            <span aria-hidden="true"> ›</span>
          </button>
        ) : null}
        {canDrag ? (
          <button
            type="button"
            ref={s.handleRef}
            className={styles.handle}
            aria-label={t('desk.handle', { name: p.title })}
            aria-describedby={hintId}
            aria-pressed={held}
            onKeyDown={onKey}
            onBlur={onBlur}
            onPointerDown={s.onPointerDown}
            data-handle={id}
            data-testid={`desk-handle-${id}`}
          >
            <Dots />
          </button>
        ) : null}
        {p.fixed ? null : (
          <button type="button" className={styles.fold} aria-label={t('desk.collapse', { name: p.title })} onClick={onCollapse} data-testid={`desk-fold-${id}`}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 8h8" />
            </svg>
          </button>
        )}
      </header>
      <div className={styles.body}>{p.body}</div>
    </section>
  );
}

/** 一栏（dnd-kit 的可放区）+ 右边的竖条（最后一栏没有） */
export function ColWithSep({ i, ids, style, sep, children }: { i: number; ids: string[]; style: CSSProperties; sep: ReactNode; children: ReactNode }) {
  return (
    <>
      <DndCol index={i} ids={ids} className={styles.col} style={style} testId={`desk-col-${i}`}>
        {children}
      </DndCol>
      {sep}
    </>
  );
}

/**
 * 第 i 条竖条（第 i 栏和第 i+1 栏之间，5.9b 第 1、5 点）：按住左右拖（setPointerCapture），途中经 onDraft 画草稿，松手 onSave；
 * 键盘 ← → 每次 5%、Home / End 到最窄 / 最宽，同样先画草稿，松开键（或失焦）才保存一次，按住不放不会连写。
 * layout 是按实际画布宽夹过的栏宽（和画出来的一致）。可聚焦的分隔条按 WAI-ARIA 的“窗口分隔条”是可操作控件
 */
export function Sep({ i, layout, minFrac, canvasPx, onDraft, onSave }: { i: number; layout: DeskLayoutValue; minFrac: number; canvasPx: number; onDraft(l: DeskLayoutValue | null): void; onSave(l: DeskLayoutValue): void }) {
  const t = useDeskT();
  const start = useRef<{ x: number; w: number } | null>(null);
  const last = useRef<DeskLayoutValue | null>(null);
  const r = resizeRange(layout, i, minFrac);
  const w = layout.cols[i]?.w ?? 0;
  /** 拖完、按完：有草稿就保存一次 */
  const end = (): void => {
    start.current = null;
    if (last.current) onSave(last.current);
    last.current = null;
    onDraft(null);
  };
  // 只有调栏宽的键松开才保存（Tab、Shift 等别的键松开不算，免得按住方向键时别的键一松就提前存了）
  const SIZE_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  const onKey = (e: RKeyboardEvent<HTMLDivElement>): void => {
    const base = last.current ?? layout;
    const cur = base.cols[i]?.w ?? 0;
    const to = e.key === 'ArrowLeft' ? cur - KEY_STEP : e.key === 'ArrowRight' ? cur + KEY_STEP : e.key === 'Home' ? (r?.lo ?? cur) : e.key === 'End' ? (r?.hi ?? cur) : null;
    if (to === null || start.current) return;
    e.preventDefault();
    last.current = resizeAt(base, i, to, minFrac);
    onDraft(last.current);
  };
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 可聚焦的 separator 是可操作的窗口分隔条（WAI-ARIA window splitter），5.9b 第 5 点定的写法
    <div
      className={styles.sep}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('desk.resize', { n: i + 1, m: i + 2 })}
      aria-valuenow={Math.round(w * 100)}
      aria-valuemin={Math.round((r?.lo ?? 0) * 100)}
      aria-valuemax={Math.round((r?.hi ?? 1) * 100)}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 同上，分隔条要能用键盘调
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s || canvasPx <= 0) return;
        last.current = resizeAt(layout, i, s.w + (e.clientX - s.x) / canvasPx, minFrac);
        onDraft(last.current);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKey}
      onKeyUp={(e) => !start.current && SIZE_KEYS.includes(e.key) && end()}
      onBlur={() => !start.current && end()}
      data-testid={`desk-sep-${i}`}
    />
  );
}

/** 侧栏底部“⋯”：锁定布局 / 收起的块 / 恢复默认布局（kit 的 Popover；Esc、点外面收起，焦点回按钮。B6 代定：不另引 Radix DropdownMenu） */
export function MoreMenu({ btn, layout, names, onLock, onRestore, onReset }: { btn: RefObject<HTMLButtonElement | null>; layout: DeskLayoutValue; names(id: string): string; onLock(on: boolean): void; onRestore(id: string): void; onReset(): void }) {
  const t = useDeskT();
  const [open, setOpen] = useState(false);
  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t('desk.more', {})}
      align="start"
      className={styles.menu}
      data-testid="desk-menu"
      trigger={
        <button ref={btn} type="button" className={styles.more} aria-label={t('desk.more', {})} data-testid="desk-more">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {[3.5, 8, 12.5].map((x) => (
              <circle key={x} cx={x} cy="8" r="1.4" />
            ))}
          </svg>
        </button>
      }
    >
      <button type="button" className={styles.item} aria-pressed={layout.locked} onClick={act(() => onLock(!layout.locked))} data-testid="desk-lock">
        <span className={styles.check} aria-hidden="true">
          {layout.locked ? '✓' : ''}
        </span>
        {t('desk.lock', {})}
      </button>
      <p className={styles.group}>{t('desk.collapsed', {})}</p>
      {layout.collapsed.length === 0 ? <p className={styles.none}>{t('desk.collapsedNone', {})}</p> : null}
      {layout.collapsed.map((id) => (
        <button key={id} type="button" className={styles.item} aria-label={t('desk.restore', { name: names(id) })} onClick={act(() => onRestore(id))} data-testid={`desk-restore-${id}`}>
          <span className={styles.check} aria-hidden="true" />
          {names(id)}
        </button>
      ))}
      <div className={styles.rule} role="separator" />
      <button type="button" className={styles.item} onClick={act(onReset)} data-testid="desk-reset">
        <span className={styles.check} aria-hidden="true" />
        {t('desk.reset', {})}
      </button>
    </Popover>
  );
}

/** 抽屉顶上的换边把手（5.9b 第 1 点“抽屉的标题栏可以拖到左边或右边”）：按住拖到窗口另一半松手就换边；点一下（含键盘）也换边 */
export function DrawerHandle({ side, onSide }: { side: 'left' | 'right'; onSide(s: 'left' | 'right'): void }) {
  const t = useDeskT();
  const start = useRef<number | null>(null);
  const moved = useRef(false);
  return (
    <button
      type="button"
      className={styles.dhandle}
      aria-label={t(side === 'right' ? 'desk.toLeft' : 'desk.toRight', {})}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        start.current = e.clientX;
        moved.current = false;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (start.current !== null && Math.abs(e.clientX - start.current) > 4) moved.current = true;
      }}
      onPointerUp={(e) => {
        if (start.current === null) return;
        start.current = null;
        if (!moved.current) return;
        const half = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
        if (half !== side) onSide(half);
      }}
      onPointerCancel={() => {
        start.current = null;
        moved.current = false;
      }}
      onClick={() => {
        if (moved.current) {
          moved.current = false;
          return;
        }
        onSide(side === 'right' ? 'left' : 'right');
      }}
      data-testid="desk-drawer-side"
    >
      <Dots />
    </button>
  );
}
