// 按在吉祥物上的手势（接入要点.md）：画布不接指针，全局事件按角色实际不透明像素判定
// • 角色上：短按互动、长按约 500ms 进 AI 助手；移动超过 10px 或页面滚动就取消（页面照常滚）
// • 这次手势从角色上开始：挡住下面的按下和随后的点击，日程不触发
// • 透明处：什么都不拦
// • 只认真实事件：跟手用的模拟指针事件不算；眼神跟手每帧最多更新一次
// • 有双击的角色（canDouble，Aldo）：短按等 DOUBLE_MS 没有第二下才算短按；DOUBLE_MS 内再短按一下算双击，只走双击、不走短按
import { TAP_SLOP_PX } from '../../../motion/components.ts';
import { swallowNextClick } from '../../../motion/index.ts';
import { perFrame } from '../../../motion/mascot-stage.ts';

export const LONG_MS = 500;
export const DOUBLE_MS = 250;
const SWALLOW_MS = 350;

export interface GestureDeps {
  /** 这个屏幕点是不是角色（已含裁切和“上面没有别的层”） */
  hit(x: number, y: number): boolean;
  look(x: number, y: number): void;
  tap(): void;
  long(): void;
  /** 现在的角色有没有双击；没有的短按立刻算 */
  canDouble?(): boolean;
  double?(): void;
}

export function watchGesture(d: GestureDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 等第二下的短按 */
  let single: ReturnType<typeof setTimeout> | null = null;
  let id: number | null = null;
  let x0 = 0;
  let y0 = 0;
  let unswallow: (() => void) | null = null;
  const follow = perFrame((x, y) => d.look(x, y));
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const down = (e: PointerEvent): void => {
    if (!e.isTrusted) return;
    d.look(e.clientX, e.clientY);
    cancel();
    id = null;
    if (!e.isPrimary || e.button !== 0 || !d.hit(e.clientX, e.clientY)) return;
    id = e.pointerId;
    x0 = e.clientX;
    y0 = e.clientY;
    timer = setTimeout(() => {
      timer = null;
      d.long();
    }, LONG_MS);
    e.stopPropagation();
  };
  const move = (e: PointerEvent): void => {
    if (!e.isTrusted) return;
    follow.call(e.clientX, e.clientY);
    if (e.pointerId === id && timer !== null && Math.hypot(e.clientX - x0, e.clientY - y0) > TAP_SLOP_PX) cancel();
  };
  const up = (e: PointerEvent): void => {
    if (!e.isTrusted || e.pointerId !== id) return;
    const tap = timer !== null;
    cancel();
    id = null;
    unswallow?.();
    unswallow = swallowNextClick({ ms: SWALLOW_MS });
    if (!tap) return;
    if (single !== null) {
      clearTimeout(single);
      single = null;
      d.double?.();
    } else if (d.canDouble?.() && d.double) {
      single = setTimeout(() => {
        single = null;
        d.tap();
      }, DOUBLE_MS);
    } else d.tap();
  };
  const pcancel = (e: PointerEvent): void => {
    if (!e.isTrusted || e.pointerId !== id) return;
    cancel();
    id = null;
  };
  const menu = (e: Event): void => {
    if (id !== null) e.preventDefault();
  };
  const scroll = (): void => cancel();
  const opt = { capture: true, passive: true } as const;
  document.addEventListener('pointerdown', down, opt);
  document.addEventListener('pointermove', move, opt);
  document.addEventListener('pointerup', up, opt);
  document.addEventListener('pointercancel', pcancel, opt);
  document.addEventListener('contextmenu', menu, true);
  window.addEventListener('scroll', scroll, opt);
  return () => {
    cancel();
    if (single !== null) clearTimeout(single);
    single = null;
    follow.cancel();
    unswallow?.();
    document.removeEventListener('pointerdown', down, opt);
    document.removeEventListener('pointermove', move, opt);
    document.removeEventListener('pointerup', up, opt);
    document.removeEventListener('pointercancel', pcancel, opt);
    document.removeEventListener('contextmenu', menu, true);
    window.removeEventListener('scroll', scroll, opt);
  };
}

/** 卡片的裁切：over（#19）右边和两个右圆角收在卡内，左和下放开；其余收在圆角卡内 */
export function inCardClip(x: number, y: number, c: { left: number; top: number; width: number; height: number }, r: number, over: boolean): boolean {
  const X = x - c.left;
  const Y = y - c.top;
  const W = c.width;
  const H = c.height;
  if (X >= W || Y < 0) return false;
  if (!over && (X < 0 || Y >= H)) return false;
  if (X > W - r) {
    if (Y > H) return false;
    if (Y < r) return Math.hypot(X - (W - r), Y - r) <= r;
    if (Y > H - r) return Math.hypot(X - (W - r), Y - (H - r)) <= r;
    return true;
  }
  if (!over && X < r) {
    if (Y < r) return Math.hypot(X - r, Y - r) <= r;
    if (Y > H - r) return Math.hypot(X - r, Y - (H - r)) <= r;
  }
  return true;
}

/** 卡片有一圈 1px 的白色描边（皮肤的 --b-tile-shadow 内描边）：吉祥物正好画到描边的内沿，不压在它上面、也不留缝 */
export const CARD_EDGE_PX = 1;

/** 出格角色（#19）：右边、上边和右侧两个圆角收在卡片描边里面，左边和下边放开 */
export const overClipPath = (W: number, H: number, r: number): string => {
  const e = CARD_EDGE_PX;
  const q = Math.max(0, r - e);
  return `path('M-240 ${e}H${W - r}A${q} ${q} 0 0 1 ${W - e} ${r}V${H - r}A${q} ${q} 0 0 1 ${W - r} ${H - e}V${H + 320}H-240Z')`;
};

/** 不出格的角色：四边都收在卡片描边里面 */
export const cardClipPath = (r: number): string => `inset(${CARD_EDGE_PX}px round ${Math.max(0, r - CARD_EDGE_PX)}px)`;
