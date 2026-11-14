// 横向拖动的底层（R-420 审查第 4 条“横滑手势两套”合成这一套）：月历翻页（swipe-pager.ts）和 kit 左滑行（SwipeRow）共用，
// 两处只留“松手以后怎么办”。这里管：
// • 锁方向：先走过 SLOP_PX，横向比竖向多才锁成横滑（抓住指针、自己跟手）；先竖着走就整段交给页面滚动（元素要配 CSS touch-action: pan-y）
// • 左边缘避让：从屏幕左边缘 EDGE_PX（20 px，架构 5.12）以内起手的不管，让给 iPhone 侧滑返回（两处一律避让）
// • 鼠标：mouse 参数区分。列表行（SwipeRow）传 true：电脑上也能拿鼠标拖开（行里同样有“⋯”菜单，留着不碍事）；
//   月历翻页传 false：电脑上用 ‹ › 按钮和键盘 ← → 翻，鼠标在格子上拖来拖去多半是想选字、点格子，不当翻页
// • 跟手只直接写 DOM 的 transform（place），不经 React state：跟手的每个 pointermove 都不让用它的页面重画（审查第 3 条）
// • 滑过以后补来的那一下 click 吞掉（swallow-click.ts），免得滑完的同时点中格子、进了编辑
// • 松手（或浏览器收走：pointercancel）交给 end：横移多少、最后画到哪、锁成了哪个方向、按下到松手多少毫秒
// 过渡写在调用方的 CSS 里，认 data-snap：place(x, true) 打上 data-snap（带过渡滑到 x），place(x, false) 摘掉（直接到 x）
// 纯 TS + React 的 useRef，不带 motion/react；经 gestures.ts 出口用，不进首屏的 main 块
import { useRef, type PointerEvent as RPointerEvent, type RefObject } from 'react';
import { swallowNextClick } from './swallow-click.ts';

/** 左边缘的系统返回手势区（px，架构 5.12） */
export const EDGE_PX = 20;
/** 起滑距离（px）：先走过这么多才判断横竖；翻页、左滑行同一个值（审查第 4 条，原来 10 和 8） */
export const SLOP_PX = 10;

export type Axis = 'none' | 'h' | 'v';

/** 按目前的位移判断锁成哪个方向（纯函数）：没走够 SLOP_PX 不锁；横向大于竖向是横滑，否则竖滑 */
export function lockOf(dx: number, dy: number): Axis {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < SLOP_PX) return 'none';
  return ax > ay ? 'h' : 'v';
}

/** 起手点在不在屏幕左边缘的系统手势区里 */
export function inEdge(x: number): boolean {
  return x < EDGE_PX;
}

export interface HDragEnd {
  /** 横移（松手点减按下点） */
  dx: number;
  /** 最后画到的位移（起点加横移、夹过范围）；没锁成横滑就是起点 */
  x: number;
  axis: Axis;
  /** true：pointercancel（浏览器收走了这次触摸） */
  cancel: boolean;
  /** 按下到松手的毫秒数（运行日志用） */
  ms: number;
}

type Ptr = RPointerEvent<HTMLElement>;

export interface HDragOptions {
  /** 认不认鼠标（见文件头） */
  mouse: boolean;
  /** 按下：返回这次拖动的起点位移（px）；返回 null 不管这一下 */
  start(e: Ptr): number | null;
  /** 跟手时把位移夹到范围里；不给不夹 */
  clamp?: ((x: number) => number) | undefined;
  /** 跟不跟手；不给是跟（翻页减少动态效果时不跟，只在松手时判） */
  follow?: (() => boolean) | undefined;
  end(r: HDragEnd): void;
  /** 记一行运行日志（调用方传 platform 的 rlog）：跳过的原因、锁成哪个方向；只记手势，不记内容 */
  log?: ((line: string) => void) | undefined;
  /** 运行日志的前缀 */
  tag?: string | undefined;
}

export interface HDrag {
  /** 挂到要跟手的那块上：ref 和四个指针事件 */
  readonly bind: {
    ref: RefObject<HTMLDivElement | null>;
    onPointerDown(e: Ptr): void;
    onPointerMove(e: Ptr): void;
    onPointerUp(e: Ptr): void;
    onPointerCancel(e: Ptr): void;
  };
  /** 画到 x（0 是原位）；snap 为 true 时带过渡（CSS 认 data-snap） */
  place(x: number, snap: boolean): void;
  /** 先直接放到 x、再带过渡滑回 0（翻页的新一页从那一侧滑进来）：中间强制算一次样式，过渡从 x 起播，不等下一帧 */
  slideFrom(x: number): void;
  /** 吞掉随后落在这块上的那一下 click */
  swallow(): void;
}

interface Track {
  id: number;
  x0: number;
  y0: number;
  t0: number;
  base: number;
  axis: Axis;
  x: number;
}

export function useHDrag(opts: HDragOptions): HDrag {
  const o = useRef(opts);
  o.current = opts;
  const api = useRef<HDrag | null>(null);
  if (api.current === null) {
    const ref: RefObject<HTMLDivElement | null> = { current: null };
    let t: Track | null = null;
    const log = (line: string): void => o.current.log?.(`${o.current.tag ?? 'hdrag'} ${line}`);
    const place = (x: number, snap: boolean): void => {
      const el = ref.current;
      if (!el) return;
      if (snap) el.dataset['snap'] = '';
      else delete el.dataset['snap'];
      el.style.transform = x === 0 ? '' : `translateX(${x}px)`;
    };
    const swallow = (): void => void swallowNextClick({ within: ref.current });
    const finish = (e: Ptr, cancel: boolean): void => {
      const d = t;
      if (!d || d.id !== e.pointerId || (e.pointerType === 'mouse' && !o.current.mouse)) return;
      t = null;
      const dx = e.clientX - d.x0;
      if (d.axis === 'none' && !cancel) d.axis = lockOf(dx, e.clientY - d.y0);
      if (d.axis === 'h' && !cancel) swallow();
      o.current.end({ dx, x: d.x, axis: d.axis, cancel, ms: Math.round(performance.now() - d.t0) });
    };
    api.current = {
      bind: {
        ref,
        onPointerDown(e) {
          if (!e.isPrimary) return;
          if (e.pointerType === 'mouse' && (!o.current.mouse || e.button !== 0)) {
            if (o.current.mouse) log('down skip=button');
            return;
          }
          if (inEdge(e.clientX)) {
            t = null;
            log('down skip=edge');
            return;
          }
          const base = o.current.start(e);
          if (base === null) return;
          t = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), base, axis: 'none', x: base };
        },
        onPointerMove(e) {
          const d = t;
          if (!d || d.id !== e.pointerId || d.axis === 'v') return;
          const dx = e.clientX - d.x0;
          if (d.axis === 'none') {
            const dy = e.clientY - d.y0;
            d.axis = lockOf(dx, dy);
            if (d.axis === 'none') return;
            log(`axis=${d.axis} mx=${Math.round(dx)} my=${Math.round(dy)}`);
            if (d.axis === 'v') return;
            try {
              ref.current?.setPointerCapture(e.pointerId);
            } catch {
              // 指针已经没了（极少见）：照样跟手
            }
          }
          if (o.current.follow && !o.current.follow()) return;
          const x = d.base + dx;
          d.x = o.current.clamp ? o.current.clamp(x) : x;
          place(d.x, false);
        },
        onPointerUp: (e) => finish(e, false),
        onPointerCancel: (e) => finish(e, true),
      },
      place,
      slideFrom(x) {
        const el = ref.current;
        if (!el) return;
        place(x, false);
        // 强制算一次样式：浏览器记下“现在在 x”，下面改成 0 时过渡才从 x 起播（审查第 2 条，原来隔一帧再改，起播前停一帧）
        void getComputedStyle(el).transform;
        place(0, true);
      },
      swallow,
    };
  }
  return api.current;
}
