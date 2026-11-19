// 下拉露出搜索框（R-437；同 iPhone 备忘录）：随手记、待办、日历三页共用这一个 hook，挂法见 kit/components/PullSlot.tsx，搜索框和结果在 smart-search 的 PullSearch
// • 手机（R-488 重写，负责人 11-20“在顶部的时候往下拉页面不动，只出搜索框”，弹窗选“跟手拉出”）：页面滚到顶（window.scrollY ≤ 0）时按下、
//   竖着往下拉（横向不超过竖向一半）：页面本身不动（platform/top-lock.ts 拦下回弹），标题下面一条占位框（PullSlot 的 ghost，ghostRef）
//   跟着手指长出来，长出 = 手指移动 × PULL_FOLLOW，最多 PULL_H；松手时长过一半就露出真的搜索框，不到一半缩回去。
//   原来靠 iOS 回弹、手指走够 200 才露出、拉的过程中看不见（R-437 / 11-17 三次调门槛），整段换掉。
//   用 touch 事件（passive；拦回弹的是 top-lock 那一份非被动监听）：pointer 事件会被 pointercancel 掉，touch 事件照常来
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
// • 手机松手展开那一下震一下、不响（R-471，platform/feedback.ts 的 fx('pull')）
// • 露出了、还没打字，页面往上滚，搜索框跟着页面往上走、按滚动量慢慢淡出（headRef），滚走 PULL_H、滚动停下以后卸掉（R-488 弹窗选“没打字就自动收”；
//   负责人 11-20“慢慢收进去，而不是一下子收进去”；输入框正聚焦着不收）
// • 运行日志：pull open <页> via=touch|wheel|key、pull close <页>（不记打的字）
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { queryTerms } from '../../../shared/logic/search.ts';
import { fx } from '../../platform/fx-api.ts';
import { rlog } from '../../platform/run-log-api.ts';
import { atTop, pullsDown, scrollsY } from '../../platform/top-lock.ts';

/** 占位框长满的高度（px）：和真的搜索框一样高（PullSearch.module.css 的 .bar：--pull-h 36 + 下边距 8） */
export const PULL_H = 44;
/** 占位框跟手的比例：手指走 1，框长 0.6（带一点阻力，轻轻一碰不会露出一大截） */
export const PULL_FOLLOW = 0.6;
/** 手指往下走多少（px）松手就展开：框长过一半 */
export const PULL_OPEN_PX = Math.ceil(PULL_H / 2 / PULL_FOLLOW);
/** 滚轮在顶上继续往上滚多少露出（px） */
export const WHEEL_OPEN_PX = 120;
/** 两次滚轮隔这么久算断开（惯性流结束），从头累计 */
export const WHEEL_GAP_MS = 250;
/** 松手过半：占位框先补满到 PULL_H（同 --dur-ui 的过渡）再换成真的搜索框，换的那一下不跳（整块评审第 2 条） */
export const SETTLE_MS = 220;
/** 露着的搜索框滚走以后，滚动停了多久（ms）才真的卸掉：惯性滚动途中不挪页面 */
export const STILL_MS = 160;
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
  /** 挂在跟手长出来的占位框上（PullSlot 画；hook 直接改它的 --pull-g，拉的过程不经 React 渲染） */
  ghostRef: RefObject<HTMLDivElement | null>;
  /** 挂在露出的搜索框那一层上（PullSlot 画；页面往上滚时 hook 直接改它的透明度、缩放，慢慢收） */
  headRef: RefObject<HTMLDivElement | null>;
}

/** 按在页面本身（见文件头）：在 region 里，往上到 region 之前没有能滚的、fixed 的、[data-nopull] 的 */
export function pullable(region: HTMLElement | null, t: EventTarget | null): boolean {
  if (region === null || !(t instanceof Element) || !region.contains(t)) return false;
  for (let el: Element | null = t; el !== null && el !== region; el = el.parentElement) {
    if (el.hasAttribute('data-nopull')) return false;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || scrollsY(el, cs)) return false;
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
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
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
    let maxDy = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onStart = (e: TouchEvent): void => {
      maxDy = 0;
      const p = e.touches[0];
      start = e.touches.length === 1 && p && atTop() && pullable(region.current, e.target) ? { x: p.clientX, y: p.clientY } : null;
    };
    /** 占位框长出多少（px）；drag 时跟手不过渡，松手缩回时过渡 */
    const grow = (h: number, drag: boolean): void => {
      const g = ghostRef.current;
      if (!g) return;
      g.style.setProperty('--pull-g', `${h}px`);
      g.style.setProperty('--pull-o', String(h / PULL_H));
      g.toggleAttribute('data-drag', drag);
    };
    let h = 0;
    const onMove = (e: TouchEvent): void => {
      const p = e.touches[0];
      if (!start || !p) return;
      const dy = p.clientY - start.y;
      // 不在顶上了、横着拉为主：这一下不是下拉搜索，占位框收回
      if (!atTop() || (dy > 0 && !pullsDown(p.clientX - start.x, dy))) {
        start = null;
        h = 0;
        grow(0, false);
        return;
      }
      if (dy > maxDy) maxDy = dy;
      h = Math.min(PULL_H, Math.max(0, dy) * PULL_FOLLOW);
      grow(h, true);
    };
    const onEnd = (): void => {
      const ok = start !== null && h >= PULL_H / 2;
      // 没拉到一半就松手：记下最远拉了多少，下次调门槛按日志里的数，不靠估
      if (start && !ok && maxDy >= 24) rlog(`pull short ${tag} dy=${Math.round(maxDy)}`);
      start = null;
      maxDy = 0;
      if (!ok) {
        h = 0;
        grow(0, false);
        return;
      }
      // 松手展开：只震不响（R-471）。滚轮、键盘打开不震。先补满再换（减少动态效果时高度不过渡，直接换）
      fx('pull');
      const full = h >= PULL_H || document.documentElement.dataset.rm === '1';
      h = 0;
      grow(PULL_H, false);
      if (full) reveal('touch');
      else settle = setTimeout(() => reveal('touch'), SETTLE_MS);
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
      clearTimeout(settle);
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      window.removeEventListener('wheel', onWheel);
    };
  }, [enabled, open, reveal, tag]);

  // 和查找同一个判断（queryTerms）：只打了标点、空白时没有可查的词，不算在搜，页面照常显示（R-447 评审第 3 条）
  const searching = queryTerms(q).length > 0;

  // 没打字就自动收（R-488；负责人 11-20 要慢慢收）：见 useAutoCollapse。焦点不还给“搜索本页”（不是用户点的收起）
  const drop = useCallback(() => {
    close();
    refocus.current = false;
  }, [close]);
  useAutoCollapse(open, searching, region, headRef, drop);
  const live = searching ? found : null;
  const shows = useCallback((id: string) => live === null || live.ids.has(id), [live]);
  return { enabled, open, via, q, setQ, searching, found: live, setFound, shows, markQ: live?.q ?? '', reveal, close, ref, keyRef, ghostRef, headRef };
}

/** 露着、没打字时页面往上滚：搜索框跟着慢慢收，滚走停下以后 drop() 卸掉，同一帧把页面往回挪（见下面两段） */
function useAutoCollapse(open: boolean, searching: boolean, region: RefObject<HTMLElement | null>, headRef: RefObject<HTMLDivElement | null>, drop: () => void): void {
  // 自动收起抽走了列表上面 PULL_H 高的一块：同一帧把页面往回挪同样多，手指下的内容不跳（iOS Safari 没有滚动锚定，整块评审第 3 条）
  const shift = useRef(false);
  useLayoutEffect(() => {
    if (open || !shift.current) return;
    shift.current = false;
    window.scrollBy(0, -PULL_H);
  }, [open]);

  // 没打字就自动收（R-488）：露着、没在搜、输入框没聚焦时，页面往上滚，搜索框跟着滚动量慢慢收（负责人 11-20
  // “拉出来的搜索框页面往下拉的过程中慢慢收进去，而不是一下子收进去”）：滚 0～PULL_H，headRef 那一层跟着页面往上走、透明度 1→0，
  // 滚过 PULL_H 时已经收完看不见；等滚动停了（STILL_MS 没有新的 scroll）才真的卸掉、把页面往回挪 PULL_H。
  // 原来滚过 PULL_H 当场卸掉 + scrollBy：iOS 惯性滚动途中挪页面，看着就是“一下子没了”还顿一下。
  // 焦点不还给“搜索本页”（不是用户点的收起）
  useEffect(() => {
    if (!open || searching) return undefined;
    const box = region.current;
    const head = headRef.current;
    // 直接写在搜索框那一层自己身上（不经页面根节点上的变量，免得滚一下整页的子元素都重算样式）
    const set = (k: number): void => {
      if (head) head.style.opacity = k > 0 ? String(1 - k) : '';
    };
    let still: ReturnType<typeof setTimeout> | undefined;
    const focused = (): boolean => {
      const a = document.activeElement;
      return a instanceof HTMLInputElement && box?.contains(a) === true;
    };
    const settle = (): void => {
      if (window.scrollY <= PULL_H || focused()) return;
      shift.current = true;
      drop();
    };
    const onScroll = (): void => {
      set(focused() ? 0 : Math.min(1, Math.max(0, window.scrollY / PULL_H)));
      clearTimeout(still);
      still = setTimeout(settle, STILL_MS);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(still);
      window.removeEventListener('scroll', onScroll);
      set(0);
    };
  }, [open, searching, drop, region, headRef]);
}
