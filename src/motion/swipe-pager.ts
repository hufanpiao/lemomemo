// 左右滑动翻页（B2 FA-3：月历、周视图上一页 / 下一页，架构 5.12 第 3 点、17.2；R-457 负责人 11-17 选“C 原地淡换”，原话“放慢4倍的C原地淡换”）
// 锁方向、左边缘避让、抓指针、滑完吞点按都在 hdrag.ts（和 kit 左滑行共用，R-420 审查第 4 条）；这里管：
// • 跟手只走一小段：手指横移的 FOLLOW_RATE 倍、最多 FOLLOW_MAX_PX（原地换，不是整页拖走；方案页 C 的写法）
// • 松手时手指横移超过 TRIGGER_PX（60 px，5.12）才翻；向左滑 = 下一页，向右滑 = 上一页。翻不动（到了范围边上）或不够 60：带过渡回原位
// • 翻页（滑动、‹ › 按钮共用 flip）：换页前把这一块拍一份静态副本（ghost，去掉 id、测试和数据标记，aria-hidden + inert，不接点按）叠在原位，
//   页面换成新的一页；副本从手指停下的位置回到原位、带一点模糊淡出（前 2/3 就淡没），新的一页从模糊到清晰淡入。
//   时长 = --dur-ui × CAL_FLIP_SLOW_RATIO（tokens.ts，880 ms），曲线 --ease-out。连着翻：上一次没放完的直接收掉、从这一次重来
// • 减少动态效果：不跟手；翻页只留 --dur-ui 的淡出淡入，不模糊、不位移
// • 键盘 ← →、“今天”、年月选择不经这里（页面直接切换，不加动效）
// • 不认鼠标（hdrag 的 mouse: false）：电脑上用按钮和键盘翻页；元素要配 CSS touch-action: pan-y，竖向滚动仍是原生的
import { useRef } from 'react';
import { useHDrag, type HDrag } from './hdrag.ts';
import { bezierCss, CAL_FLIP_SLOW_RATIO, dur, ease } from './tokens.ts';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

export const TRIGGER_PX = 60;
/** 跟手：手指横移的几倍、最多几像素（方案页 C：0.15、16） */
export const FOLLOW_RATE = 0.15;
export const FOLLOW_MAX_PX = 16;
/** 旧的一页淡出时模糊到几像素（方案页 C） */
export const FLIP_BLUR_PX = 4;

/** 松手时翻不翻：-1 上一页，1 下一页，0 不翻 */
export function swipeResult(dx: number): -1 | 0 | 1 {
  if (Math.abs(dx) < TRIGGER_PX) return 0;
  return dx < 0 ? 1 : -1;
}

/** 跟手画到哪：手指横移 x 的 FOLLOW_RATE 倍，夹在 ±FOLLOW_MAX_PX */
export function followX(x: number): number {
  return Math.max(-FOLLOW_MAX_PX, Math.min(FOLLOW_MAX_PX, x * FOLLOW_RATE));
}

/** 翻页时长（ms）：减少动态效果时只留 --dur-ui 的淡入淡出 */
export function flipMs(reduced: boolean): number {
  return dur.ui * 1000 * (reduced ? 1 : CAL_FLIP_SLOW_RATIO);
}

export type FlipVia = 'swipe' | 'btn';

/** 挂到要能左右滑的那块上：{...bind}（ref 和指针事件）；flip 给按钮翻页用 */
export interface SwipePager {
  readonly bind: HDrag['bind'];
  /** 按钮翻页：拍副本、调 onPage、淡换；翻不动返回 false（副本收掉，画面不动） */
  flip(dir: -1 | 1, via: FlipVia): boolean;
}

/** 副本里要去掉的属性：id 不重复，测试、读屏、点按、抽屉找回焦点都只认新的一页 */
const STRIP = ['id', 'data-testid', 'data-date', 'data-item', 'data-todo', 'data-open'];

/** 把 el 拍一份静态副本，绝对定位叠在它原来的位置上（同一个 offsetParent），从 x 处起 */
function snapshot(el: HTMLElement, x: number): HTMLElement {
  const g = el.cloneNode(true) as HTMLElement;
  for (const n of [g, ...g.querySelectorAll<HTMLElement>(STRIP.map((a) => `[${a}]`).join(','))]) for (const a of STRIP) n.removeAttribute(a);
  g.setAttribute('aria-hidden', 'true');
  g.inert = true;
  delete g.dataset['snap'];
  Object.assign(g.style, {
    position: 'absolute',
    left: `${el.offsetLeft}px`,
    top: `${el.offsetTop}px`,
    width: `${el.offsetWidth}px`,
    margin: '0',
    pointerEvents: 'none',
    transform: x === 0 ? '' : `translateX(${x}px)`,
  });
  el.before(g);
  return g;
}

/** onPage(-1) 上一页、onPage(1) 下一页（via 给运行日志）；返回 false 表示翻不动（到了范围边上） */
export function useSwipePager(onPage: (dir: -1 | 1, via: FlipVia) => boolean, log?: (line: string) => void): SwipePager {
  const cb = useRef(onPage);
  cb.current = onPage;
  const reduced = useReducedMotionPref();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  /** 正在放的那一次：副本和两段动画 */
  const live = useRef<{ ghost: HTMLElement; anims: Animation[] } | null>(null);
  const d = useHDrag({
    mouse: false,
    tag: 'cal swipe',
    log,
    start: () => 0,
    clamp: followX,
    follow: () => !reducedRef.current,
    end: ({ dx, x, axis, cancel, ms }) => {
      const r = axis === 'h' && !cancel ? swipeResult(dx) : 0;
      const turned = r !== 0 && flipRef.current(r, 'swipe', x);
      log?.(`cal swipe ${cancel ? 'cancel' : 'up'} axis=${axis} dx=${Math.round(dx)} turn=${turned ? r : 0} ms=${ms}`);
      if (!turned) d.place(0, !reducedRef.current);
    },
  });
  const flipRef = useRef((dir: -1 | 1, via: FlipVia, x = 0): boolean => {
    const el = d.bind.ref.current;
    const prev = live.current;
    live.current = null;
    if (prev) {
      for (const a of prev.anims) a.cancel();
      prev.ghost.remove();
    }
    const canAnimate = el !== null && typeof el.animate === 'function';
    const ghost = canAnimate ? snapshot(el, x) : null;
    if (!cb.current(dir, via)) {
      ghost?.remove();
      return false;
    }
    d.place(0, false);
    if (!el || !ghost) return true;
    const rm = reducedRef.current;
    const timing: KeyframeAnimationOptions = { duration: flipMs(rm), easing: bezierCss(ease.out) };
    const blur = (px: number): string => `blur(${px}px)`;
    const out = ghost.animate(
      rm
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { opacity: 1, filter: blur(0), transform: `translateX(${x}px)` },
            { opacity: 0, filter: blur((FLIP_BLUR_PX * 2) / 3), transform: `translateX(${x / 3}px)`, offset: 2 / 3 },
            { opacity: 0, filter: blur(FLIP_BLUR_PX), transform: 'translateX(0px)' },
          ],
      { ...timing, fill: 'forwards' },
    );
    const inn = el.animate(rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, filter: blur(FLIP_BLUR_PX) }, { opacity: 1, filter: blur(0) }], timing);
    const mine = { ghost, anims: [out, inn] };
    live.current = mine;
    const done = (): void => {
      if (live.current !== mine) return;
      live.current = null;
      ghost.remove();
    };
    out.finished.then(done, done);
    return true;
  });
  return { bind: d.bind, flip: (dir, via) => flipRef.current(dir, via) };
}
