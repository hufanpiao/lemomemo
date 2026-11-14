// 左右滑动翻页（B2 FA-3：月历、周视图上一页 / 下一页，架构 5.12 第 3 点、17.2）
// 锁方向、左边缘避让、跟手、抓指针、滑完吞点按都在 hdrag.ts（和 kit 左滑行共用，R-420 审查第 4 条）；这里只管松手以后：
// • 松手时横移超过 TRIGGER_PX（60 px，5.12）才翻；向左滑 = 下一页，向右滑 = 上一页
// • 翻成了（onPage 返回 true）：新的一页从被拖出的那一侧接着滑进来；翻不动（到了范围边上，onPage 返回 false）或不够 60：滑回原位（审查第 1 条）
// • 按钮翻页（slideIn）：页面换好新的一页后调，新的一页同样从那一侧滑进来；键盘、“今天”、年月选择不调（直接切换）
// • 过渡 --dur-ui、--ease-standard 写在页面 CSS 里（认 data-snap）；减少动态效果时不跟手、直接切换
// • 不认鼠标（hdrag 的 mouse: false）：电脑上用按钮和键盘翻页；元素要配 CSS touch-action: pan-y，竖向滚动仍是原生的
import { useRef } from 'react';
import { useHDrag, type HDrag } from './hdrag.ts';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

export const TRIGGER_PX = 60;

/** 松手时翻不翻：-1 上一页，1 下一页，0 不翻 */
export function swipeResult(dx: number): -1 | 0 | 1 {
  if (Math.abs(dx) < TRIGGER_PX) return 0;
  return dx < 0 ? 1 : -1;
}

/** 翻页后新的一页从哪儿接着滑进来：下一页（向左滑）从右边、上一页从左边，带上手指已经拖出的那段 */
export function enterOffset(dir: -1 | 1, dx: number, width: number): number {
  return dir === 1 ? width + dx : dx - width;
}

/** 挂到要能左右滑的那块上：{...bind}（ref 和指针事件）；slideIn 给按钮翻页用 */
export interface SwipePager {
  readonly bind: HDrag['bind'];
  /** 按钮翻页：已经换到新的一页后调，新的一页从那一侧滑进来（5.12：按钮翻页用同样的滑动）；减少动态效果时什么都不做 */
  slideIn(dir: -1 | 1): void;
}

/** onPage(-1) 上一页、onPage(1) 下一页；返回 false 表示翻不动（到了范围边上） */
export function useSwipePager(onPage: (dir: -1 | 1) => boolean, log?: (line: string) => void): SwipePager {
  const cb = useRef(onPage);
  cb.current = onPage;
  const reduced = useReducedMotionPref();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const width = useRef(0);
  const d = useHDrag({
    mouse: false,
    tag: 'cal swipe',
    log,
    start: (e) => {
      width.current = e.currentTarget.getBoundingClientRect().width;
      return 0;
    },
    follow: () => !reducedRef.current,
    end: ({ dx, axis, cancel, ms }) => {
      const r = axis === 'h' && !cancel ? swipeResult(dx) : 0;
      const turned = r !== 0 && cb.current(r);
      log?.(`cal swipe ${cancel ? 'cancel' : 'up'} axis=${axis} dx=${Math.round(dx)} turn=${turned ? r : 0} ms=${ms}`);
      if (turned && !reducedRef.current) d.slideFrom(enterOffset(r, dx, width.current));
      else d.place(0, !reducedRef.current);
    },
  });
  const slideIn = useRef((dir: -1 | 1): void => {
    const w = d.bind.ref.current?.getBoundingClientRect().width ?? 0;
    if (reducedRef.current || !(w > 0)) return;
    d.slideFrom(enterOffset(dir, 0, w));
  });
  return { bind: d.bind, slideIn: slideIn.current };
}
