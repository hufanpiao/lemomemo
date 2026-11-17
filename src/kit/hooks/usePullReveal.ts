// 下拉露出搜索框（R-437；同 iPhone 备忘录）：随手记、待办、日历三页共用这一个 hook，挂法见 kit/components/PullSlot.tsx，搜索框和结果在 smart-search 的 PullSearch
// • 手机：页面滚到顶（window.scrollY ≤ 0）时按下，再往下拉过 PULL_OPEN_PX、竖着拉为主（横向不超过竖向一半）就露出。
//   用 touch 事件（passive）：滚到顶以后往下拉，浏览器自己接手回弹，pointer 事件会被 pointercancel 掉，touch 事件照常来
// • 电脑：滚到顶以后滚轮继续往上滚，累计过 WHEEL_OPEN_PX 就露出。防误触（R-437 评审第 2 条）：
//   按着 Ctrl（触控板双指缩放）、横向为主的不算；滚到顶以后要先断开一段（两次滚轮隔 WHEEL_GAP_MS 以上，惯性流结束）才开始累计，
//   所以从下面一路滚上来、惯性冲到顶的那一串不会打开
// • 只认按在本页（ref 挂在页面 main 上）、而且是“页面本身”的地方（R-437 评审第 1 条，pullable）：从按下的元素往上找到页面，途中有
//   – 真能滚的（overflow-y 是 auto / scroll，内容比框高）：电脑版随手记的详情抽屉、抽屉里的正文框，在里面滚是滚它自己；
//   – position: fixed 的：抽屉内容短、不能滚时同样不算；随手记贴底的输入行也是；
//   – [data-nopull]：日历日清单的拖动柄（往下拖是展开月历，它本身既不能滚也不是 fixed，只能这样标）
//   都不算；弹层挂在 body 上，本来就不在页面里
// • 键盘、读屏（R-437 评审第 3 条）：标题行下面一个平时看不见、Tab 到才出现的“搜索本页”（PullSlot 画，keyRef 挂在它上面），
//   点了 reveal('key')，搜索框自己聚焦；收起（“取消”、输入框里按 Esc）以后焦点还给它
// • 露出以后一直留着，直到 close()（清空并收起）；q 放在这里
// • 就地筛（R-447，负责人 11-17 选 S-B“原列表筛选”）：搜索框那一块（smart-search 的 PullSearch）按本页记录算出命中的 id，setFound 交回这里；
//   页面照原来的分组和行画，只画 shows(id) 为真的，标题用 PullSlot 的 PullHit 给命中的字加短下划线（markQ 是算出这一批命中用的那个查询）。
//   还没算出来（那一块还在下载）时 found 为 null，什么都不藏
// • 运行日志：pull open <页> via=touch|wheel|key、pull close <页>（不记打的字）
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { queryTerms } from '../../../shared/logic/search.ts';
import { rlog } from '../../platform/run-log-api.ts';

/** 往下拉多少露出（px）。原来 64，负责人 11-17“现在往下轻微一拉就出现，改成要往下多拉一下才会出现”：改 110（约原来的 1.7 倍，iPhone 上要明显拉一下） */
export const PULL_OPEN_PX = 110;
/** 滚轮在顶上继续往上滚多少露出（px） */
export const WHEEL_OPEN_PX = 120;
/** 两次滚轮隔这么久算断开（惯性流结束），从头累计 */
export const WHEEL_GAP_MS = 250;
/** 滚轮按行滚时一行算多少 px */
const LINE_PX = 16;

export type PullVia = 'touch' | 'wheel' | 'key';

export interface PullFound {
  q: string;
  ids: ReadonlySet<string>;
}

export interface PullReveal {
  /** 这一页接不接（隐私记页不接：不画“搜索本页”、不接手势） */
  enabled: boolean;
  open: boolean;
  /** 怎么打开的（key：搜索框挂上就聚焦）；收着为 null */
  via: PullVia | null;
  q: string;
  setQ(q: string): void;
  /** 打了字（去掉空白不为空）：本页就地筛（日历页没有整串列表，藏起来换成结果，PullSlot 的 inPlace） */
  searching: boolean;
  /** 搜索框那一块算出的命中（id 集合 + 算它用的查询）；没打字、还没算出来时为 null */
  found: PullFound | null;
  setFound(f: PullFound | null): void;
  /** 这一条在就地筛时画不画（没在筛、还没算出来时都画） */
  shows(id: string): boolean;
  /** 给命中的字加下划线用的查询（没在筛时为空串） */
  markQ: string;
  reveal(via: PullVia): void;
  /** 清空并收起，焦点还给“搜索本页” */
  close(): void;
  /** 挂在页面 main 上（回调 ref） */
  ref(el: HTMLElement | null): void;
  /** 挂在“搜索本页”按钮上 */
  keyRef: RefObject<HTMLButtonElement | null>;
}

const atTop = (): boolean => window.scrollY <= 0;

const scrolls = (el: Element, cs: CSSStyleDeclaration): boolean =>
  (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;

/** 按在页面本身（见文件头）：在 region 里，往上到 region 之前没有能滚的、fixed 的、[data-nopull] 的 */
export function pullable(region: HTMLElement | null, t: EventTarget | null): boolean {
  if (region === null || !(t instanceof Element) || !region.contains(t)) return false;
  for (let el: Element | null = t; el !== null && el !== region; el = el.parentElement) {
    if (el.hasAttribute('data-nopull')) return false;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || scrolls(el, cs)) return false;
  }
  return true;
}

/** tag：页名，只进运行日志；enabled 为 false（隐私记页）时不接手势 */
export function usePullReveal(tag: string, enabled = true): PullReveal {
  const [via, setVia] = useState<PullVia | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<PullFound | null>(null);
  const region = useRef<HTMLElement | null>(null);
  const keyRef = useRef<HTMLButtonElement | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    region.current = el;
  }, []);
  // 开没开只经 reveal、close 改，这一份跟着它们改（不在渲染时写 ref）
  const openRef = useRef(false);
  const refocus = useRef(false);
  const open = via !== null;

  const reveal = useCallback((how: PullVia) => {
    if (openRef.current) return;
    openRef.current = true;
    setVia(how);
    rlog(`pull open ${tag} via=${how}`);
  }, [tag]);
  const close = useCallback(() => {
    setQ('');
    setFound(null);
    if (!openRef.current) return;
    openRef.current = false;
    setVia(null);
    rlog(`pull close ${tag}`);
    refocus.current = true;
  }, [tag]);
  // 焦点还给“搜索本页”：它在搜索框露着时不画，收起这一次画完、它挂回来以后再聚焦
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    keyRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!enabled || open) return undefined;
    let start: { x: number; y: number } | null = null;
    let acc = 0;
    let last = -Infinity;
    let armed = false;
    const onStart = (e: TouchEvent): void => {
      const p = e.touches[0];
      start = e.touches.length === 1 && p && atTop() && pullable(region.current, e.target) ? { x: p.clientX, y: p.clientY } : null;
    };
    const onMove = (e: TouchEvent): void => {
      const p = e.touches[0];
      if (!start || !p) return;
      if (!atTop()) {
        start = null;
        return;
      }
      const dy = p.clientY - start.y;
      if (dy >= PULL_OPEN_PX && Math.abs(p.clientX - start.x) * 2 < dy) {
        start = null;
        reveal('touch');
      }
    };
    const onEnd = (): void => {
      start = null;
    };
    const onWheel = (e: WheelEvent): void => {
      const now = performance.now();
      const gap = now - last;
      last = now;
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (!atTop()) {
        armed = false;
        acc = 0;
        return;
      }
      if (e.deltaY >= 0) {
        acc = 0;
        return;
      }
      // 到顶以后断开过一次才开始累计；断开以后的每一串都从头累计
      if (gap > WHEEL_GAP_MS) {
        armed = true;
        acc = 0;
      }
      if (!armed || !pullable(region.current, e.target)) return;
      acc += -e.deltaY * (e.deltaMode === 1 ? LINE_PX : 1);
      if (acc >= WHEEL_OPEN_PX) {
        acc = 0;
        reveal('wheel');
      }
    };
    const o = { passive: true } as const;
    window.addEventListener('touchstart', onStart, o);
    window.addEventListener('touchmove', onMove, o);
    window.addEventListener('touchend', onEnd, o);
    window.addEventListener('touchcancel', onEnd, o);
    window.addEventListener('wheel', onWheel, o);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      window.removeEventListener('wheel', onWheel);
    };
  }, [enabled, open, reveal]);

  // 和查找同一个判断（queryTerms）：只打了标点、空白时没有可查的词，不算在搜，页面照常显示（R-447 评审第 3 条）
  const searching = queryTerms(q).length > 0;
  const live = searching ? found : null;
  const shows = useCallback((id: string) => live === null || live.ids.has(id), [live]);
  return { enabled, open, via, q, setQ, searching, found: live, setFound, shows, markQ: live?.q ?? '', reveal, close, ref, keyRef };
}
