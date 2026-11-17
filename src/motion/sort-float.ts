// 长按拖动排序的浮层（R-461 整块重写，负责人 11-17 选 C“让位加倾斜”）：kit 的 useSortDrag 拿起时调 liftFloat，经 gestures.ts 出口引。
// 只管“手里拿着的那一张”怎么动，不管落在哪、不碰列表（列表按预览顺序画、占位就是落点，在 kit/components/SortDrag.tsx）：
// • 拿起：复制这一行挂到 body（外层 .float 管位置和倾斜，JS 写 transform；里层 .card 管放大和阴影，CSS 过渡），
//   先画出原样（scale 1、阴影透明）再给里层打 data-up，放大、阴影、“⋯”换 6 个点才有过渡（11-17 之前没有起点帧，所以“没有动效”）
// • 跟手：每次 follow 直接写位置、不加过渡；列表只跟竖向，横向跟手指的 25%、最多 12px；瀑布流横竖都跟；上下（瀑布流还有左右）限在外框里、多留 8px
// • 倾斜（C）：角度 = 手指速度换算，最多 2.5°，用 tokens 的弹簧（刚度 380、阻尼比 0.78）追；停手速度衰减就回正
// • 落下：land(目标) 后去掉 data-up（缩回、阴影收、6 个点换回“⋯”，--dur-ui），位置和倾斜用同一个弹簧追到目标；
//   目标每帧重读（列表还在重排、页面在滚都跟得上）；弹簧停稳且 --dur-ui 过完才回调 done
// • 减少动态效果（reduced.ts）：照样跟手（直接操作），不倾斜、横向不跟、落下直接到位；放大由 CSS（:root[data-rm="1"]）去掉
// • 拿起到撤掉期间不让列表换动画实现（swap-guard 的 holdBegin）：换实现会把整个列表子树重挂一次
// 帧循环用 ./frame-loop.ts（A25：requestAnimationFrame 只写在 src/motion）
import { eachFrame } from './frame-loop.ts';
import type { Point } from './long-press-drag.ts';
import { prefersReducedMotion } from './reduced.ts';
import { holdBegin } from './swap-guard.ts';
import { dur, SPRING_DAMPING_RATIO, SPRING_MASS, SPRING_STIFFNESS } from './tokens.ts';

export interface SortFloatOptions {
  /** 列表外框（跟手的上下限） */
  box: HTMLElement;
  /** y：列表（只跟竖向）；xy：瀑布流 */
  axis: 'y' | 'xy';
  /** 拿起时手指的视口位置 */
  at: Point;
  /** kit 的类名：外层（定位、倾斜）、里层（放大、阴影） */
  cls: { float: string; card: string };
}

export interface SortFloat {
  /** 手指移到 at（视口坐标）：浮层跟过去，回浮层中心的视口坐标（落点按它算） */
  follow(at: Point): Point;
  /** 松手、取消：落到 target() 给的视口位置（左上角；回 null 时停在原地），停稳回调 done */
  land(target: () => Point | null, done: () => void): void;
  /** 马上撤掉（收尾、卸载） */
  remove(): void;
}

/** 列表横向跟手指的比例、上限（C） */
const LIST_X_FOLLOW = 0.25;
const LIST_X_MAX = 12;
/** 倾斜上限（度）和速度换算（px/s → 度） */
const TILT_MAX = 2.5;
const TILT_VX = 0.004;
const TILT_VY = 0.0025;
const TILT_DX = 0.05;
/** 跟手的上下限多留多少 */
const EDGE = 8;

const K = SPRING_STIFFNESS / SPRING_MASS;
const C = (2 * SPRING_DAMPING_RATIO * Math.sqrt(SPRING_STIFFNESS * SPRING_MASS)) / SPRING_MASS;

/** 一维弹簧（按 1/240 秒细分积分，够近就停） */
class Spring {
  x = 0;
  v = 0;
  t = 0;
  step(dt: number): void {
    const n = Math.max(1, Math.ceil(dt * 240));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -K * (this.x - this.t) - C * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    if (Math.abs(this.x - this.t) < 0.2 && Math.abs(this.v) < 4) this.jump(this.t);
  }
  jump(x: number): void {
    this.x = x;
    this.t = x;
    this.v = 0;
  }
  done(): boolean {
    return this.x === this.t && this.v === 0;
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** 复制这一行：去掉 id、data-testid、拖动标记，整份 inert、读屏不念 */
function cloneRow(row: HTMLElement): HTMLElement {
  const c = row.cloneNode(true) as HTMLElement;
  for (const el of [c, ...c.querySelectorAll<HTMLElement>('[data-testid], [id]')]) {
    el.removeAttribute('data-testid');
    el.removeAttribute('id');
  }
  for (const k of Object.keys(c.dataset)) if (k.startsWith('sort')) delete c.dataset[k];
  c.style.margin = '0';
  return c;
}

export function liftFloat(row: HTMLElement, o: SortFloatOptions): SortFloat {
  const r = row.getBoundingClientRect();
  const outer = document.createElement('div');
  outer.className = o.cls.float;
  outer.dataset['testid'] = 'sort-float';
  outer.setAttribute('aria-hidden', 'true');
  outer.inert = true;
  Object.assign(outer.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  const card = document.createElement('div');
  card.className = o.cls.card;
  // 圆角跟这一行自己的（瀑布流卡片 22、列表行没有就用 CSS 默认的 --r-lg）
  const radius = getComputedStyle(row).borderRadius;
  if (radius && radius !== '0px') card.style.borderRadius = radius;
  card.appendChild(cloneRow(row));
  outer.appendChild(card);
  document.body.appendChild(outer);
  // 先画出原样，再打“拿起”：放大、阴影、6 个点才有过渡（见文件头）
  void outer.offsetWidth;
  card.dataset['up'] = '';

  const release = holdBegin();
  const px = new Spring();
  const py = new Spring();
  const rot = new Spring();
  let vx = 0;
  let vy = 0;
  let dx = 0;
  let last = { ...o.at, t: performance.now() };
  let landing: { target: () => Point | null; done: () => void; at: number } | null = null;
  let prev = 0;
  let stop: (() => void) | null = null;

  const paint = (): void => {
    const a = rot.x;
    outer.style.transform = `translate3d(${px.x.toFixed(2)}px, ${py.x.toFixed(2)}px, 0)${a ? ` rotate(${a.toFixed(3)}deg)` : ''}`;
  };

  const frame = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, prev ? (now - prev) / 1000 : 1 / 60);
    prev = now;
    const rm = prefersReducedMotion();
    if (landing) {
      const p = landing.target();
      if (p) {
        px.t = p.x - r.left;
        py.t = p.y - r.top;
      }
      rot.t = 0;
      if (rm) {
        px.jump(px.t);
        py.jump(py.t);
        rot.jump(0);
      }
    } else {
      // 停手速度衰减，倾斜回正
      const decay = Math.pow(0.0001, dt);
      vx *= decay;
      vy *= decay;
      rot.t = rm ? 0 : clamp(vx * TILT_VX + vy * TILT_VY + (o.axis === 'y' ? dx * TILT_DX : 0), -TILT_MAX, TILT_MAX);
      if (rm) rot.jump(0);
    }
    px.step(dt);
    py.step(dt);
    rot.step(dt);
    paint();
    if (landing && px.done() && py.done() && rot.done() && (rm || now - landing.at >= dur.ui * 1000)) {
      const done = landing.done;
      landing = null;
      stop?.();
      stop = null;
      done();
    }
  };
  stop = eachFrame(frame);

  return {
    follow(at) {
      const now = performance.now();
      const ms = Math.max(8, now - last.t);
      vx = vx * 0.6 + ((at.x - last.x) / ms) * 1000 * 0.4;
      vy = vy * 0.6 + ((at.y - last.y) / ms) * 1000 * 0.4;
      last = { ...at, t: now };
      const b = o.box.getBoundingClientRect();
      const rawX = at.x - o.at.x;
      dx = o.axis === 'y' ? (prefersReducedMotion() ? 0 : clamp(rawX * LIST_X_FOLLOW, -LIST_X_MAX, LIST_X_MAX)) : rawX;
      const top = clamp(r.top + at.y - o.at.y, b.top - EDGE, b.bottom - r.height + EDGE);
      const left = o.axis === 'y' ? r.left + dx : clamp(r.left + dx, b.left - EDGE, b.right - r.width + EDGE);
      px.jump(left - r.left);
      py.jump(top - r.top);
      paint();
      return { x: left + r.width / 2, y: top + r.height / 2 };
    },
    land(target, done) {
      delete card.dataset['up'];
      landing = { target, done, at: performance.now() };
      if (!stop) stop = eachFrame(frame);
    },
    remove() {
      stop?.();
      stop = null;
      landing = null;
      outer.remove();
      release();
    },
  };
}
