// 可拖动的半屏抽屉（离顶约 27%、上面两角大圆角、玻璃底、往上的阴影、顶上一根 36×5 把手）
// • 两个停靠点：half（离顶 27%，同参考的 top 250 / 932）和 full（离顶 安全区 + 12px）；full 由调用方强制时（键盘弹着）一直拉满，键盘收起回到原来的停靠点
// • 拖把手（pointer 事件，只改 transform）：往上拖过阈值 → full；在 full 往下拖过阈值 → half；在 half 往下拖过阈值 → 关；没过阈值弹回原处；
//   被调用方强制拉满时（键盘弹着）往下拖一律弹回原处（换不了停靠点，也不关）
//   换停靠点时整块先平移、再换 top（往上：先换 top 再从原位置滑上去；往下：先滑下去再换 top），任何时候底下不露出空隙
// • 出现从底边滑上来（--dur-sheet、--ease-drawer，同 Dialog 的 sheet）。时长读 motion 的同一个令牌（dur.sheet），减少动态效果读同一个判断
//   （useReducedMotionPref，同 Appear）：开着时 CSS 里 transition: none，这里收尾的定时器也不等，直接到位
// • 关只有一条路 close()：先滑下去再调 onClose。后面整页是输入时那层液态模糊（kit Mist），点它、Esc（层栈，模态：后面 inert、锁滚动、关了还焦点）、
//   往下拖、调用方自己的“关闭”按钮都走它——children 可以是函数，拿到 close 自己接到按钮上
// • 打开时焦点给抽屉本身（不弹键盘：半屏时一弹键盘就被拉满）；Portal 到 body，模糊层和抽屉同一个根，层栈 inert 不会盖到模糊层
// kit 不引 platform：运行日志、键盘状态都由调用方传进来
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dur, useReducedMotionPref } from '../../motion/components.ts';
import { useLayer } from '../hooks/useLayer.ts';
import { Mist } from './Mist.tsx';
import styles from './HalfSheet.module.css';

export type SheetStop = 'half' | 'full';

/** 拖过多少算数（px）；甩得快（px/ms）也算 */
export const SHEET_DRAG_PX = 64;
export const SHEET_FLICK = 0.5;
/** 平移收尾的时长（motion 的 dur.sheet，即 --dur-sheet）；减少动态效果时不等 */
export const SHEET_MS = Math.round(dur.sheet * 1000);
/** 半屏离顶的比例（HalfSheet.module.css 的 top: 27% 同一个数） */
const HALF_TOP = 0.27;

/** 松手以后去哪：dy 往下为正，v 为松手前的速度（px/ms，往下为正） */
export function sheetTarget(stop: SheetStop, dy: number, v: number): SheetStop | 'close' {
  const down = dy > SHEET_DRAG_PX || v > SHEET_FLICK;
  const up = dy < -SHEET_DRAG_PX || v < -SHEET_FLICK;
  if (stop === 'half') return down ? 'close' : up ? 'full' : 'half';
  return down ? 'half' : 'full';
}

export interface HalfSheetProps {
  /** 读屏名字 */
  label: string;
  onClose(): void;
  /** 强制拉满（键盘弹着） */
  full?: boolean;
  /** 停靠点变了（日志、调用方按停靠点改内容：半屏只列前几条） */
  onStop?: ((stop: SheetStop) => void) | undefined;
  /** 运行日志（调用方传 platform 的 rlog） */
  log(line: string): void;
  /** 日志前缀、data-testid 前缀 */
  tag: string;
  /** 内容；写成函数时拿到 close（带退场动画的关），调用方的“关闭”按钮接它 */
  children: ReactNode | ((close: () => void) => ReactNode);
}

export function HalfSheet({ label, onClose, full = false, onStop, log, tag, children }: HalfSheetProps) {
  const [stop, setStop] = useState<SheetStop>('half');
  const shown: SheetStop = full ? 'full' : stop;
  const root = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closing = useRef(false);
  const reduced = useReducedMotionPref();
  useLayer(true, { name: tag, modal: true, el: () => root.current, onEsc: () => close() });

  /** 改 transform：anim 为真时带过渡，done 在 SHEET_MS 后调 */
  const move = (y: string, anim: boolean, done?: () => void): void => {
    const el = sheet.current;
    if (!el) return;
    el.dataset['anim'] = anim ? '1' : '0';
    el.style.transform = y === '0' ? '' : `translateY(${y})`;
    clearTimeout(timer.current);
    if (done) timer.current = setTimeout(done, anim && !reduced ? SHEET_MS : 0);
  };
  const close = (): void => {
    if (closing.current) return;
    closing.current = true;
    log(`${tag} sheet close`);
    move('100%', true, onClose);
  };

  /** 从 from 平移过渡到原位：先不带过渡放到 from，读一次布局让浏览器记下起点（kit 里不写 requestAnimationFrame），再带过渡回到 0 */
  const slideFrom = (from: string): void => {
    move(from, false);
    void sheet.current?.offsetHeight;
    move('0', true);
  };

  // 出现：从底边滑上来；焦点给抽屉本身
  useLayoutEffect(() => {
    sheet.current?.focus({ preventScroll: true });
    slideFrom('100%');
    log(`${tag} sheet open`);
    return () => clearTimeout(timer.current);
    // 只在挂上时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 停靠点（含强制拉满）变了：往上换的，先换 top、再从原位置（连同松手时拖出去的那一段）平移上去（FLIP）；往下换的由松手那一支先滑下去再换。
  // offsetTop 不含 transform
  const lastTop = useRef<number | null>(null);
  const heldDy = useRef(0);
  useLayoutEffect(() => {
    const el = sheet.current;
    if (!el) return;
    const top = el.offsetTop;
    const was = lastTop.current;
    lastTop.current = top;
    if (was !== null && was > top + 1 && !closing.current) slideFrom(`${was - top + heldDy.current}px`);
    heldDy.current = 0;
    onStop?.(shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // 拖把手
  const drag = useRef<{ y0: number; y: number; t: number; v: number; id: number } | null>(null);
  const down = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (closing.current) return;
    // 手指拖出把手也接着收事件；拿不到（指针已经抬起等）就算了，照样跟手
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 没拿到捕获不影响拖动 */
    }
    drag.current = { y0: e.clientY, y: e.clientY, t: e.timeStamp, v: 0, id: e.pointerId };
  };
  const drift = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dt = Math.max(1, e.timeStamp - d.t);
    d.v = (e.clientY - d.y) / dt;
    d.y = e.clientY;
    d.t = e.timeStamp;
    const dy = e.clientY - d.y0;
    // 往上拉过了拉满的位置不再跟手（只给一点阻尼）
    move(`${shown === 'full' && dy < 0 ? dy / 4 : dy}px`, false);
  };
  const up = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const dy = e.clientY - d.y0;
    // 强制拉满（键盘弹着）：换不了停靠点，往下拖只弹回原处（不走“滑到半屏”，也不关）
    const to = full ? 'full' : sheetTarget(shown, dy, d.v);
    log(`${tag} sheet drag from=${shown} to=${to} dy=${Math.round(dy)}`);
    if (to === 'close') close();
    else if (to === shown) move('0', true);
    else if (to === 'full') {
      heldDy.current = dy;
      setStop('full');
    }
    else {
      // 往下换到半屏：先整块滑到半屏的位置，再换 top、去掉平移（底下不露空）
      const el = sheet.current;
      // offsetTop 不含 transform：半屏的 top（27%）减去现在的 top 就是要滑的距离
      const dist = Math.max(0, window.innerHeight * HALF_TOP - (el ? el.offsetTop : 0));
      move(`${dist}px`, true, () => {
        lastTop.current = null;
        setStop('half');
        move('0', false);
      });
    }
  };
  const cancel = (): void => {
    drag.current = null;
    move('0', true);
  };

  return createPortal(
    <div ref={root} className={styles.root} data-testid={`${tag}-root`}>
      <Mist onTap={close} tag={tag} log={log} testId={`${tag}-mist`} className={styles.mistZ} />
      <div
        ref={sheet}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-stop={shown}
        data-anim="0"
        data-testid={`${tag}-sheet`}
      >
        <div
          className={styles.grab}
          onPointerDown={down}
          onPointerMove={drift}
          onPointerUp={up}
          onPointerCancel={cancel}
          aria-hidden="true"
          data-testid={`${tag}-grab`}
        >
          <span className={styles.bar} />
        </div>
        {typeof children === 'function' ? children(close) : children}
      </div>
    </div>,
    document.body,
  );
}
