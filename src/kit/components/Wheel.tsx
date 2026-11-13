// 滚轮（kit，B5 视觉稿 annnew 的年月日三列、annedit 的“08 09 : 00 10”提醒时刻；以后待办、日程选时刻也用这一个）
// • 一列选项，靠浏览器自己的滚动和 scroll-snap 停在某一项；停稳 120ms 以后读出停在第几项、回调 onChange（只在变了时）
// • axis 'y'：竖着三行，中间一行是选中项（外面 WheelPanel 画选中框）；axis 'x'：横着两格，
//   align 'end' 选中项贴右、左边露上一个，align 'start' 选中项贴左、右边露下一个（两列拼成“08 09 : 00 10”）
// • 首尾用占位格撑开，第 i 项停稳的位置正好是 i × 每格大小（不用 padding：横向滚动的尾部 padding 各浏览器算法不一）
// • 值从外面变（或刚挂上）：不带动画对齐到选中项
// • 点某一项直接选它；读屏和键盘：整列是 spinbutton，读出当前项，↑↓（横向也认 ←→）、Home、End、PageUp、PageDown 换项；选项本身对读屏隐藏
// • 只渲染和手势，不碰数据；减少动态效果下没有动画可关（对齐一律瞬间到位）
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from './Wheel.module.css';

export interface WheelOption {
  readonly value: string;
  readonly label: string;
}

export interface WheelProps {
  options: readonly WheelOption[];
  value: string;
  onChange(value: string): void;
  /** 读屏读的这一列叫什么（年、月、日、时、分） */
  label: string;
  axis?: 'y' | 'x';
  /** 只对 axis 'x'：选中项贴右（左边露上一个）还是贴左（右边露下一个） */
  align?: 'end' | 'start';
  disabled?: boolean;
  className?: string | undefined;
  'data-testid'?: string;
}

/** 停稳多久才算选定（ms）：手指甩出去以后浏览器还在惯性滚，一直有 scroll 事件 */
const SETTLE_MS = 120;

function stepOf(box: HTMLElement | null, axis: 'y' | 'x'): number {
  const el = box?.querySelector<HTMLElement>('[data-wheel-item]');
  if (!el) return 0;
  return axis === 'y' ? el.offsetHeight : el.offsetWidth;
}

function scrollToItem(box: HTMLElement | null, axis: 'y' | 'x', i: number): void {
  const s = stepOf(box, axis);
  if (!box || !s) return;
  if (axis === 'y') box.scrollTop = i * s;
  else box.scrollLeft = i * s;
}

export function Wheel({ options, value, onChange, label, axis = 'y', align = 'end', disabled = false, className, 'data-testid': testId }: WheelProps) {
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const found = options.findIndex((o) => o.value === value);
  const idx = found < 0 ? 0 : found;
  const latest = useRef({ options, value, onChange });
  latest.current = { options, value, onChange };

  const step = (): number => stepOf(box.current, axis);
  const goTo = (i: number): void => scrollToItem(box.current, axis, i);

  // 值从外面变、选项条数变：对齐到选中项（不带动画）；别的重绘不动它（用户正滚着不拉回去）
  const n = options.length;
  useLayoutEffect(() => {
    scrollToItem(box.current, axis, idx);
  }, [axis, idx, n]);

  useLayoutEffect(() => () => clearTimeout(timer.current), []);

  const onScroll = (): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = box.current;
      const s = step();
      if (!el || !s) return;
      const pos = axis === 'y' ? el.scrollTop : el.scrollLeft;
      const { options: o, value: v, onChange: c } = latest.current;
      const i = Math.min(o.length - 1, Math.max(0, Math.round(pos / s)));
      const opt = o[i];
      if (opt && opt.value !== v) c(opt.value);
      else if (Math.abs(pos - i * s) > 1) goTo(i);
    }, SETTLE_MS);
  };

  const pick = (i: number): void => {
    const opt = options[Math.min(options.length - 1, Math.max(0, i))];
    if (opt && opt.value !== value) onChange(opt.value);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const moves: Record<string, number> = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1, PageUp: -5, PageDown: 5 };
    if (e.key in moves) pick(idx + (moves[e.key] ?? 0));
    else if (e.key === 'Home') pick(0);
    else if (e.key === 'End') pick(options.length - 1);
    else return;
    e.preventDefault();
  };

  const spacer = (key: string): ReactNode => <div key={key} className={styles.item} aria-hidden="true" />;
  const head = axis === 'y' || align === 'end' ? spacer('head') : null;
  const tail = axis === 'y' || align === 'start' ? spacer('tail') : null;
  const cls = [styles.wheel, axis === 'y' ? styles.y : styles.x, axis === 'x' && align === 'start' ? styles.start : null, className].filter(Boolean).join(' ');

  return (
    <div
      ref={box}
      className={cls}
      role="spinbutton"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuenow={idx}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, options.length - 1)}
      aria-valuetext={options[idx]?.label ?? ''}
      aria-disabled={disabled || undefined}
      onScroll={onScroll}
      onKeyDown={disabled ? undefined : onKey}
      data-testid={testId}
      data-value={value}
    >
      {head}
      {options.map((o, i) => (
        <div
          key={o.value}
          className={styles.item}
          data-wheel-item=""
          data-on={i === idx || undefined}
          data-value={o.value}
          aria-hidden="true"
          onClick={disabled ? undefined : () => pick(i)}
        >
          {o.label}
        </div>
      ))}
      {tail}
    </div>
  );
}

/** 几列滚轮拼成一块（年月日）：浅底圆角，中间一行画选中框（视觉稿 annnew） */
export function WheelPanel({ label, children, className }: { label: string; children: ReactNode; className?: string | undefined }) {
  return (
    <div className={[styles.panel, className].filter(Boolean).join(' ')} role="group" aria-label={label}>
      {children}
    </div>
  );
}
