// 长按拖动排序（kit；R-429 起，R-461 负责人 11-17 整块重写：动效 C“让位加倾斜”、6 个点摆法 1“拿起时‘⋯’换成 6 个点”）。
// 现在只有随手记页在用（隐私记页是同一个 NotesPage 组件；待办页 11-17 起不拖，R-442）。不用 dnd-kit（电脑版布局拖面板 DeskLayout 是 dnd-kit 的，两套不混用）。
// 一套流程：拖动中列表就按“预览顺序”画（拿着的那一条在落点处留一个看不见的占位），浮层只跟手；松手时页面已经是新顺序，浮层落到占位、撤掉。
// 不等列表重画、不量浮层、不画横线（11-16、11-17 五次修补里四次是“浮层追列表”的时序问题，这套做法把这件事整个拿掉了）。
// 用法（页面只多 preview 一行）：
//   const sd = useSortDrag({ tag: 'notes', axis: 'y', onDrop: useSortDropFlow({...}), log: rlog });
//   const items = sd.preview(list, (x) => x.id);
//   <SortBox sd={sd}>…<AppearItem key={id} className={sortRowClass} {...sd.attrs(id, off)}>…<SortEnd>{“⋯”}</SortEnd></AppearItem>…</SortBox>
// • 行：motion 的 AppearItem（让位靠它的 layout 动画；SortBox 拖动中包着 SortSpring，让位用弹簧）；sd.attrs 给 data-sort-id、
//   不能拖的 data-sort-off（只读、下拉搜索筛着）、拿着的那一条 data-sort-held（看不见、位置照占，就是占位）。退场中的旧元素（data-state="leaving"）一律不算
// • 行尾 SortEnd：“⋯”和 6 个点叠在同一格；只在浮层里、拿起时“⋯”淡出、6 个点淡入（--dur-ui --ease-out），放下换回来，不多占宽度
// • 拿起（顺序固定）：清掉已有选区 → 整页打 html[data-sort-dragging]（整页不选字、不出长按菜单）→ motion 的 liftFloat 复制这一行做浮层
//   （挂 body，放大 1.04、阴影淡入、跟手、倾斜、落下都在 motion/sort-float.ts）→ 预览顺序 = 此刻外框里各行的 DOM 顺序，原位那一条变占位
// • 换位：浮层中心落在哪一项上（瀑布流还要在那一项的横向范围里），同一列还要越过它的中线，就把占位挪到那里（overOrder，按排版位置算、不含 layout 动画的 transform）；
//   页面按新的预览顺序重画、其他项弹簧滑过去。列表还没按上一次换位画出来时不再算（不连跳）
// • 放下：预览顺序变了就交 onDrop({ id, beforeId, afterId })（放下后排在它前面、后面的那两条，排头、排尾为 null；页面按邻居 id 在此刻的列表里找下标，dropAt），
//   浮层落到占位的排版位置；取消（Esc、系统收走触摸、切后台、失焦）预览顺序还原、浮层落回原位，流程同放下
// • 收尾：浮层停稳（弹簧停、--dur-ui 过完）→ 预览顺序清空、占位显出来，同一次提交画到屏幕前撤浮层、去掉 html 标记（不出空帧）。卸载中途直接撤
// • 运行日志（只记数字和类型，不记文字）：sort <页> lift i= n= view=list|mason sel=（拿起前选区长度）us=（行上 computed 的 -webkit-user-select）、
//   over i=（每次换位一行）、drop i= to= n= / drop same / cancel why=、settle moved= ms=（松手到撤掉）same=（撤掉那一刻页面顺序和预览顺序一致没有，0 就是数据还没跟上、会跳一下）
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { SortSpring } from '../../motion/components.ts';
import { liftFloat, useLongPressDrag, type Point, type SortFloat } from '../../motion/gestures.ts';
import styles from './SortDrag.module.css';

/** 行上挂的类（长按不选字、不出 iPhone 的放大镜和菜单；占位看不见） */
export const sortRowClass = styles.row;

/** 外框里算数的行：退场中的旧元素不算 */
const LIVE = '[data-sort-id]:not([data-state="leaving"])';

export interface SortDrop {
  id: string;
  /** 放下后排在它前面的那一条；排第一为 null */
  beforeId: string | null;
  /** 放下后排在它后面的那一条；排最后为 null */
  afterId: string | null;
}

export interface SortDragOptions {
  /** 运行日志前缀里的页名：notes、vault */
  tag: string;
  /** y：列表；xy：瀑布流 */
  axis: 'y' | 'xy';
  onDrop(d: SortDrop): void;
  /** 记一行运行日志（platform 的 rlog；必传） */
  log(line: string): void;
}

export interface SortDrag {
  /** SortBox 用：外框元素 */
  ref(el: HTMLElement | null): void;
  /** 拖动中（含松手后落下） */
  active: boolean;
  /** 拿着的那一条（没拖为 null） */
  held: string | null;
  /** 页面要画的顺序：拖动中按预览顺序，平时原样 */
  preview<T>(items: readonly T[], idOf: (it: T) => string): readonly T[];
  /** 行上的拖动标记 */
  attrs(id: string, off: boolean): Record<`data-${string}`, string | undefined>;
}

/**
 * 页面按邻居 id 找放下后的下标（order：此刻的 id 顺序，含不含拖的这一条都行）：
 * 排在 beforeId 后面、afterId 前面；两个邻居此刻不挨着、不在了（拖动中列表变了）回 null，当取消
 */
export function dropAt(order: readonly string[], d: Pick<SortDrop, 'id' | 'beforeId' | 'afterId'>): number | null {
  const rest = order.filter((x) => x !== d.id);
  const i = d.beforeId === null ? 0 : rest.indexOf(d.beforeId) + 1;
  if (i === 0 && d.beforeId !== null) return null;
  return (rest[i] ?? null) === d.afterId ? i : null;
}

/** 一项的排版位置和大小（相对外框，不含 transform） */
export interface SortRect {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

/** 换位（见文件头）：手里那一张的中心 c（外框坐标）→ 新的预览顺序；不换回 null */
export function overOrder(order: readonly string[], held: string, rows: readonly SortRect[], c: Point, axis: 'y' | 'xy'): string[] | null {
  const cur = order.indexOf(held);
  const me = rows.find((r) => r.id === held);
  for (const r of rows) {
    if (r.id === held || c.y < r.top || c.y > r.top + r.height) continue;
    if (axis === 'xy' && (c.x < r.left || c.x > r.left + r.width)) continue;
    const hit = order.indexOf(r.id);
    if (hit < 0 || cur < 0) return null;
    const mid = r.top + r.height / 2;
    const sameCol = !me || Math.abs(r.left - me.left) < 2;
    if (sameCol && ((hit > cur && c.y < mid) || (hit < cur && c.y > mid))) return null;
    const next = order.filter((x) => x !== held);
    next.splice(next.indexOf(r.id) + (hit > cur ? 1 : 0), 0, held);
    return next;
  }
  return null;
}

/** 拖动中的预览顺序套到页面的条目上：认得的按预览顺序填回它们原来占的那几格，不认得的（拖动中同步回来的）留在原处 */
export function applyOrder<T>(items: readonly T[], idOf: (it: T) => string, order: readonly string[]): readonly T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const known = items.filter((x) => rank.has(idOf(x))).sort((a, b) => (rank.get(idOf(a)) ?? 0) - (rank.get(idOf(b)) ?? 0));
  let k = 0;
  return items.map((x) => (rank.has(idOf(x)) ? (known[k++] ?? x) : x));
}

/** 行的排版位置（相对外框）：offsetTop / offsetLeft 一路加到外框，不含任何 transform（layout 动画、浮层都不影响） */
function layoutPos(el: HTMLElement, box: HTMLElement): { top: number; left: number } {
  let top = 0;
  let left = 0;
  for (let e: Element | null = el; e instanceof HTMLElement && e !== box; e = e.offsetParent) {
    top += e.offsetTop;
    left += e.offsetLeft;
  }
  return { top, left };
}

const liveRows = (box: HTMLElement): HTMLElement[] => [...box.querySelectorAll<HTMLElement>(LIVE)];
const idOfRow = (el: HTMLElement): string => el.dataset['sortId'] ?? '';
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const html = (): DOMStringMap => document.documentElement.dataset;

/** 拿起的这一次 */
interface Lift {
  id: string;
  box: HTMLElement;
  float: SortFloat;
  /** 拿起那一刻的顺序（取消时还原、判断动没动） */
  start: readonly string[];
  /** 此刻的预览顺序 */
  order: readonly string[];
  /** 已经松手（在落下） */
  landing: boolean;
  /** 松手那一刻（performance.now） */
  t0: number;
  /** 浮层中心最近一次的视口位置（还没跟过手时为 null） */
  c: Point | null;
}

/** 撤掉这一次：浮层、整页标记 */
function teardown(l: Lift): void {
  l.float.remove();
  delete html()['sortDragging'];
}

/** 上一次还没收完又拿起、卸载：直接撤 */
function drainAll(...refs: { current: Lift | null }[]): void {
  for (const r of refs) {
    if (r.current) teardown(r.current);
    r.current = null;
  }
}

export function useSortDrag(opts: SortDragOptions): SortDrag {
  const o = useRef(opts);
  o.current = opts;
  // 外框用回调 ref 存成状态：电脑版换挂、断点切换时外框换了，手势层跟着重挂
  const [boxEl, setBox] = useState<HTMLElement | null>(null);
  const [view, setView] = useState<{ held: string; order: readonly string[] } | null>(null);
  const cur = useRef<Lift | null>(null);
  /** 落完、等这一次提交画出来再撤浮层的那一次 */
  const gone = useRef<Lift | null>(null);

  const log = (s: string): void => o.current.log(`sort ${o.current.tag} ${s}`);
  /** 浮层落到哪：占位的排版位置（每帧重读，列表还在重排、页面在滚都跟得上） */
  const spot = (l: Lift) => (): Point | null => {
    const row = liveRows(l.box).find((e) => idOfRow(e) === l.id);
    if (!row) return null;
    const b = l.box.getBoundingClientRect();
    const p = layoutPos(row, l.box);
    return { x: b.left + p.left, y: b.top + p.top };
  };
  const land = (l: Lift): void => {
    l.landing = true;
    l.t0 = performance.now();
    l.float.land(spot(l), () => {
      if (cur.current !== l) return;
      cur.current = null;
      gone.current = l;
      setView(null);
    });
  };
  const drain = (): void => drainAll(cur, gone);
  /** 按浮层中心此刻在哪换预览顺序。列表还没按上一次换位画出来就先不算：等那一次提交后由下面的 layout effect 再算（手指停住也不丢最后一步） */
  const reorder = (l: Lift): void => {
    if (!l.c || l.landing) return;
    const els = liveRows(l.box);
    const ids = els.map(idOfRow);
    if (!same(ids, l.order)) {
      // 条目没变只是没画出来：等；条目变了（拖动中同步回来一条）：照此刻的算
      if (ids.length === l.order.length && ids.every((x) => l.order.includes(x))) return;
      l.order = ids;
    }
    const b = l.box.getBoundingClientRect();
    const rows = els.map((e) => ({ id: idOfRow(e), ...layoutPos(e, l.box), width: e.offsetWidth, height: e.offsetHeight }));
    const next = overOrder(l.order, l.id, rows, { x: l.c.x - b.left, y: l.c.y - b.top }, o.current.axis);
    if (!next) return;
    l.order = next;
    setView({ held: l.id, order: next });
    log(`over i=${next.indexOf(l.id)}`);
  };

  // 预览顺序每画出来一次：照最近的手指位置再算一次（见 reorder）
  useLayoutEffect(() => {
    const l = cur.current;
    if (l && view) reorder(l);
  });
  // 预览顺序清空、占位显出来的这一次提交：画到屏幕前撤浮层（见文件头“收尾”）
  useLayoutEffect(() => {
    const l = gone.current;
    if (!l || view) return;
    gone.current = null;
    const now = liveRows(l.box).map(idOfRow);
    log(`settle moved=${same(l.order, l.start) ? 0 : 1} ms=${Math.round(performance.now() - l.t0)} same=${same(now, l.order) ? 1 : 0}`);
    teardown(l);
  });
  useEffect(() => () => drainAll(cur, gone), []);

  useLongPressDrag(boxEl, {
    pick(target) {
      const row = target.closest<HTMLElement>('[data-sort-id]');
      if (!row || !boxEl?.contains(row) || 'sortOff' in row.dataset || row.dataset['state'] === 'leaving') return null;
      // 左滑露着按钮的那一行不拿（先收起左滑；kit SwipeRow 露着时外框打 data-swipe="open"）
      return row.querySelector('[data-swipe="open"]') || row.matches('[data-swipe="open"]') ? null : row;
    },
    lift(row, at) {
      const box = boxEl;
      const id = row.dataset['sortId'];
      if (!box || !id) return false;
      drain();
      const order = liveRows(box).map(idOfRow);
      // 选字防护（见 SortDrag.module.css 文件头）：先清掉已有选区，再整页打标记
      const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
      const selLen = sel?.toString().length ?? 0;
      sel?.removeAllRanges();
      html()['sortDragging'] = '';
      const float = liftFloat(row, { box, axis: o.current.axis, at, cls: { float: styles.float ?? '', card: styles.card ?? '' } });
      cur.current = { id, box, float, start: order, order, landing: false, t0: 0, c: null };
      setView({ held: id, order });
      try {
        navigator.vibrate?.(8);
      } catch {
        // 不支持、不让震：不要紧（iOS 网页本来就不震）
      }
      const rs = getComputedStyle(row);
      log(`lift i=${order.indexOf(id)} n=${order.length} view=${o.current.axis === 'y' ? 'list' : 'mason'} sel=${selLen} us=${rs.getPropertyValue('-webkit-user-select') || rs.userSelect || '-'}`);
      return true;
    },
    move(at) {
      const l = cur.current;
      if (!l || l.landing) return;
      l.c = l.float.follow(at);
      reorder(l);
    },
    drop() {
      const l = cur.current;
      if (!l || l.landing) return;
      if (same(l.order, l.start)) log('drop same');
      else {
        const i = l.order.indexOf(l.id);
        log(`drop i=${l.start.indexOf(l.id)} to=${i} n=${l.order.length}`);
        o.current.onDrop({ id: l.id, beforeId: l.order[i - 1] ?? null, afterId: l.order[i + 1] ?? null });
      }
      land(l);
    },
    cancel(why) {
      const l = cur.current;
      if (!l) return;
      log(`cancel why=${why}`);
      if (why === 'unmount') return drain();
      l.order = l.start;
      setView({ held: l.id, order: l.start });
      land(l);
    },
  });

  return {
    ref: setBox,
    active: view !== null,
    held: view?.held ?? null,
    preview: (items, idOf) => (view ? applyOrder(items, idOf, view.order) : items),
    attrs: (id, off) => ({ 'data-sort-id': id, 'data-sort-off': off ? '' : undefined, 'data-sort-held': view?.held === id ? '' : undefined }),
  };
}

/** 列表外框：定位容器（排版位置量到它为止）；拖动中让位用弹簧 */
export function SortBox({ sd, children }: { sd: SortDrag; children: ReactNode }) {
  return (
    <div ref={sd.ref} className={styles.box}>
      <SortSpring on={sd.active}>{children}</SortSpring>
    </div>
  );
}

/** 行尾一格：“⋯”和竖排 6 个点叠在一起，只在浮层里拿起时换成 6 个点（摆法 1）；6 个点读屏不念 */
export function SortEnd({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <div className={className ? `${styles.end} ${className}` : styles.end}>
      {children}
      <span className={styles.grip} aria-hidden="true" data-testid="sort-grip">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
