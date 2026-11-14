// 左滑露出操作的列表行（kit，B5 视觉稿 anniv“左滑露出编辑 / 删除”；纪念日、随手记列表方式都用这一个，待办以后也用；
// 随手记原来自己有一份 NoteSwipe.tsx，审查“左滑行两套”删掉、并到这里）
// • 只用指针事件、只动 transform：按下记起点，横向先走过 8px 且比竖向多才算“滑”（抓住指针、自己跟手）；竖向先走过 8px 就放手不管，
//   行面写 touch-action: pan-y，竖着滚列表交给浏览器（浏览器接手滚动会发 pointercancel，这一行不动）
// • 松手：拉过操作区一半就停在“露出”，否则收回；滑过之后紧跟的那一下 click 吞掉（不进编辑；motion 的 swallowNextClick，
//   只吞落在行面上的、TAP_SWALLOW_MS.swipe 以内的，新的一次按下就作废）
// • 一次只露一行：露出时把上一条收起（模块里记着“现在露着的那一条”）；点别处（含这一行的行面）、按 Esc 收起；
//   点行面收起时那一下 click 也吞掉
// • 收回、停住的过渡写在 CSS（.face[data-snap]），减少动态效果（data-rm）时没有过渡、直接到位，不回弹
// • 读屏和键盘：操作按钮收着时 inert（不进 Tab 顺序、读屏读不到），这些用户照样点行进编辑层（或行里的“⋯”菜单，同一套动作），在那里删；
//   滑开以后按钮可 Tab、可读。按钮排在行面后面（Tab 顺序里行面的按钮在前）；行面 z-index 盖住按钮
// • 外观：按钮默认 .act / .danger；look="compact" 是随手记列表行的窄按钮（每个 64 宽、浅深两套底色，R-171、R-172；样式见 .compact）
// • 运行日志（log，调用方传 platform 的 rlog；kit 不直接引 platform，同 Mist）：按下、定方向、松手、取消各记一行，不记内容
// • 只渲染和手势，不碰数据：操作做什么由调用方给 onClick
import { useEffect, useRef, useState, type ElementType, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { swallowNextClick, TAP_SWALLOW_MS } from '../../motion/index.ts';
import styles from './SwipeRow.module.css';

export interface SwipeAction {
  key: string;
  label: string;
  onClick(): void;
  danger?: boolean;
  testId?: string;
}

export interface SwipeRowProps {
  actions: readonly SwipeAction[];
  children: ReactNode;
  /** 外框元素（列表里用 li） */
  as?: ElementType;
  className?: string | undefined;
  /** 只读行等：不能滑 */
  disabled?: boolean;
  /** 按钮外观：不给是默认（纪念日）；compact 是随手记列表行的窄按钮 */
  look?: 'compact' | undefined;
  /** 记一行运行日志（platform 的 rlog） */
  log?: ((line: string) => void) | undefined;
  'data-testid'?: string;
  [data: `data-${string}`]: unknown;
}

/** 起滑的距离（px）：先走过这么多才判断横竖 */
const SLOP = 8;

/** 现在露着的那一条的“收起” */
let openRow: (() => void) | null = null;

/** 收起现在露着的那一条（页面切走、列表重排时调用；测试用） */
export function closeSwipeRows(): void {
  openRow?.();
}

export function SwipeRow({ actions, children, as: Tag = 'div', className, disabled = false, look, log, ...rest }: SwipeRowProps) {
  const wrap = useRef<HTMLElement>(null);
  const face = useRef<HTMLDivElement>(null);
  const acts = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const drag = useRef<{ id: number; x0: number; y0: number; base: number; mode: 'wait' | 'x' | 'off'; x: number } | null>(null);
  // 点行面收起的那一下不再起滑
  const skipDrag = useRef(false);
  /** 滑过、或点行面收起之后补来的那一下 click 吞掉（滑完不一定有 click：有时限，新的一次按下也作废） */
  const swallow = (): void => {
    swallowNextClick({ within: face.current, ms: TAP_SWALLOW_MS.swipe });
  };

  const width = (): number => acts.current?.offsetWidth ?? 0;
  const place = (x: number, snap: boolean): void => {
    const el = face.current;
    if (!el) return;
    if (snap) el.dataset['snap'] = '';
    else delete el.dataset['snap'];
    el.style.transform = x === 0 ? '' : `translateX(${x}px)`;
  };
  const close = useRef(() => {});
  close.current = () => {
    place(0, true);
    setOpen(false);
  };

  // 露着的时候：记成“现在露着的那一条”，点别处、Esc 收起
  useEffect(() => {
    if (!open) return undefined;
    const me = (): void => close.current();
    if (openRow && openRow !== me) openRow();
    openRow = me;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (t && acts.current?.contains(t)) return;
      if (t && face.current?.contains(t)) {
        swallow();
        skipDrag.current = true;
      }
      close.current();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      if (openRow === me) openRow = null;
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const down = (e: RPointerEvent<HTMLDivElement>): void => {
    if (skipDrag.current) {
      skipDrag.current = false;
      log?.('swipe down skip=close');
      return;
    }
    if (disabled || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) {
      log?.(`swipe down skip=${disabled ? 'disabled' : 'button'}`);
      return;
    }
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, base: open ? -width() : 0, mode: 'wait', x: 0 };
    log?.(`swipe down type=${e.pointerType} open=${open ? 1 : 0}`);
  };
  const move = (e: RPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || d.mode === 'off') return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (d.mode === 'wait') {
      if (Math.abs(dy) >= SLOP && Math.abs(dy) >= Math.abs(dx)) {
        d.mode = 'off';
        log?.(`swipe axis=v mx=${Math.round(dx)} my=${Math.round(dy)}`);
        return;
      }
      if (Math.abs(dx) < SLOP || Math.abs(dx) <= Math.abs(dy)) return;
      d.mode = 'x';
      log?.(`swipe axis=h mx=${Math.round(dx)} my=${Math.round(dy)}`);
      face.current?.setPointerCapture?.(e.pointerId);
    }
    d.x = Math.min(0, Math.max(-width(), d.base + dx));
    place(d.x, false);
  };
  const up = (e: RPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const w = width();
    const keep = d.mode === 'x' && e.type === 'pointerup' && d.x < -w / 2;
    const axis = d.mode === 'x' ? 'h' : d.mode === 'off' ? 'v' : 'none';
    log?.(`swipe ${e.type === 'pointerup' ? 'up' : 'cancel'} started=1 axis=${axis} last=${d.mode === 'x' ? Math.round(d.x) : 'none'} w=${w} open=${d.mode === 'x' ? (keep ? 1 : 0) : 'keep'}`);
    if (d.mode !== 'x') return;
    swallow();
    place(keep ? -w : 0, true);
    setOpen(keep);
  };

  return (
    <Tag ref={wrap} className={[styles.wrap, className].filter(Boolean).join(' ')} data-swipe={open ? 'open' : undefined} {...rest}>
      <div ref={face} className={styles.face} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {children}
      </div>
      <div ref={acts} className={styles.acts} inert={!open || undefined} aria-hidden={!open || undefined}>
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            className={[styles.act, a.danger && styles.danger, look === 'compact' && styles.compact].filter(Boolean).join(' ')}
            onClick={() => {
              close.current();
              a.onClick();
            }}
            data-testid={a.testId}
          >
            {a.label}
          </button>
        ))}
      </div>
    </Tag>
  );
}
