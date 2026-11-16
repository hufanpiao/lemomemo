// 长按拖动排序（kit，R-429；R-433“拖动的时候前面有那 6 个小点”）：待办页、随手记页（列表、瀑布流）、隐私记页三处共用这一份，不用 dnd-kit
// （电脑版布局拖面板 DeskLayout 是 dnd-kit 的，两套不混用）。手势底层是 motion 的 useLongPressDrag（按住 0.4 秒没动才拿起，动了交给左滑或滚动）。
// 用法：
//   const sd = useSortDrag({ tag: 'todos', axis: 'y', canDrop, onDrop, log: rlog });
//   <div ref={sd.ref} className={sortBoxClass}>…<li data-sort-id={id} data-sort-group={g} className={sortRowClass}><SortGrip />…</li>…{sd.line}</div>
// • 行：data-sort-id（这一条的 id）、data-sort-group（它在哪一组，同一组里 DOM 顺序就是显示顺序）；不能拖的行再加 data-sort-off（已完成、只读……）。
//   行上挂 sortRowClass（定位、长按不出 iPhone 的放大镜和菜单、不选字），行里放一个 SortGrip（竖排 6 个点，只在浮层里显出来）
// • 拿起（主持人 11-16 返工第 1、2 条）：记下每一行此刻的位置（相对外框），原来那一行打 data-sort-lifted（看不见、高度照占，就是空位）；
//   复制一份做浮层挂到 body（不在列表的 isolation 里，压得住所有行）：同列表卡片的圆角 --r-lg、抬起阴影 --shadow-2、放大 1.02、不透明底；
//   复制出来的那份去掉 data-testid、id，整份 inert、读屏不念；运行日志 sort lift
// • 落点：手指离哪个“空隙”最近（每一行的上沿 = 放到它前面；每一列最后一行的下沿 = 放到它后面），横向不在那一列里的加罚分；
//   canDrop(from, to) 不让进的组不算。落点画一条强调色细横线（sd.line），画在那条缝上（相邻两行的分隔线处）；
//   浮层不跟着手指盖住缝，而是停在“落下去会在的地方”：上沿在缝下面 FLOAT_GAP，横线露在浮层和上一行之间，不和任何一行的字重叠；
//   还在原位（没落点）时浮层盖在空位上；换落点时浮层滑过去（只动 transform；减少动态效果时直接到）
// • 放下：交给 onDrop({id, from, to, index})，index 是放下后它在那一组里排第几（从 0 起，按去掉它以后的那一组数）；落回原位、没落点只记日志。
//   浮层不马上撤（返工第 5 条“先跳回原位再滑过去”：列表项是 Motion 的 layout 动画，重排后这一行会从旧位置用 transform 滑到新位置）：
//   等列表按新顺序画出来（这一行换了组、组里排第几变了、换了元素，或最多 SETTLE_WAIT_MS），期间这一条在列表里一直看不见；
//   浮层滑到它的最终位置（量到的位置减掉 layout 动画正在加的平移）、等它淡入完（跨组时新挂上的那一行要淡入），撤掉浮层，行才显出来。
//   退场中的旧元素（list-impl 的 popStyle：内联 position: absolute）不算。运行日志 sort settle moved= wait= dy=（等了多久、最后滑了多远）
//   运行日志 sort drop from= to= i= n=（组名只记冒号前那段，例如 day:2026-11-18 记 day；不记标题）、sort drop same、sort cancel why=
// • 动效只用 transform、opacity；减少动态效果时浮层不过渡（CSS 认 :root[data-rm="1"] 和系统设置）
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { eachFrame, useLongPressDrag, type Point } from '../../motion/gestures.ts';
import styles from './SortDrag.module.css';

/** 行上挂的类（见文件头） */
export const sortRowClass = styles.row;
/** 列表外框（落点横线相对它定位） */
export const sortBoxClass = styles.box;

/** 浮层上沿离落点缝多远（横线 2px 露在中间） */
const FLOAT_GAP = 6;
/** 放下后最多等列表按新顺序画出来多久 */
const SETTLE_WAIT_MS = 600;

export interface SortDrop {
  id: string;
  from: string;
  to: string;
  index: number;
}

export interface SortDragOptions {
  /** 运行日志前缀里的页名：todos、notes、vault */
  tag: string;
  axis: 'y' | 'xy';
  canDrop(from: string, to: string): boolean;
  onDrop(d: SortDrop): void;
  /** 记一行运行日志（platform 的 rlog；必传，同 SwipeRow） */
  log(line: string): void;
}

/** 一个空隙：放进 group 排第 index（含被拿起那一条时的下标）；y、x、w 相对外框 */
interface Gap {
  group: string;
  index: number;
  y: number;
  x: number;
  w: number;
}

interface Lift {
  row: HTMLElement;
  float: HTMLElement;
  /** 拿起那一刻行的视口位置（浮层的原点） */
  rect: DOMRect;
  id: string;
  group: string;
  /** 在自己那一组里的下标 */
  self: number;
  /** 每组几条（日志用） */
  sizes: Map<string, number>;
  gaps: Gap[];
  target: { group: string; index: number } | null;
  /** 撤掉藏行（见 hold） */
  release: () => void;
}

const groupKind = (g: string): string => g.split(':')[0] ?? g;

/** 外框里能放的空隙（拿起那一刻量一次；见文件头“落点”） */
export function gapsOf(rows: readonly { group: string; top: number; bottom: number; left: number; width: number }[]): Gap[] {
  const out: Gap[] = [];
  const idx = new Map<string, number>();
  const lastInCol = new Map<string, Gap>();
  for (const r of rows) {
    const i = idx.get(r.group) ?? 0;
    idx.set(r.group, i + 1);
    out.push({ group: r.group, index: i, y: r.top, x: r.left, w: r.width });
    lastInCol.set(`${r.group}|${Math.round(r.left)}`, { group: r.group, index: i + 1, y: r.bottom, x: r.left, w: r.width });
  }
  return [...out, ...lastInCol.values()];
}

/** 手指离哪个空隙最近（横向不在那一列里的按 3 倍罚） */
export function nearestGap(gaps: readonly Gap[], x: number, y: number): Gap | null {
  let best: Gap | null = null;
  let score = Infinity;
  for (const g of gaps) {
    const off = x < g.x ? g.x - x : x > g.x + g.w ? x - g.x - g.w : 0;
    const s = Math.abs(y - g.y) + off * 3;
    if (s < score) {
      score = s;
      best = g;
    }
  }
  return best;
}

/** 空隙 → 放下后在那一组里的下标（同组按去掉自己以后数）；落回原位回 null */
export function dropIndex(gap: Gap, fromGroup: string, self: number): number | null {
  if (gap.group !== fromGroup) return gap.index;
  const i = gap.index > self ? gap.index - 1 : gap.index;
  return i === self ? null : i;
}

/** 浮层左右比行宽出多少：列表的左右内边距（--sort-float-pad，从列表继承；kit List 的 .list 12px、.roomy 16px），这样浮层像一小张卡片、6 个点落在左边那段里 */
function floatPad(row: HTMLElement): number {
  return parseFloat(getComputedStyle(row).getPropertyValue('--sort-float-pad')) || 0;
}

/** 浮层：复制这一行挂到 body，盖在它原来的位置上（见文件头“拿起”）；r 是已经左右加宽过的 */
function makeFloat(row: HTMLElement, r: DOMRect, pad: number): HTMLElement {
  const f = row.cloneNode(true) as HTMLElement;
  for (const el of [f, ...f.querySelectorAll<HTMLElement>('[data-testid], [id]')]) {
    el.removeAttribute('data-testid');
    el.removeAttribute('id');
  }
  delete f.dataset['sortId'];
  delete f.dataset['sortGroup'];
  delete f.dataset['sortLifted'];
  if (styles.float) f.classList.add(styles.float);
  f.dataset['testid'] = 'sort-float';
  f.setAttribute('aria-hidden', 'true');
  f.inert = true;
  Object.assign(f.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, paddingLeft: `${pad}px`, paddingRight: `${pad}px`, transform: 'scale(1.02)' });
  document.body.appendChild(f);
  return f;
}

/** 浮层这次挪动有没有过渡（减少动态效果时没有）：有就等它放完（最多多给 80ms），没有马上回 */
function afterSlide(f: HTMLElement): Promise<void> {
  const s = getComputedStyle(f);
  const ms = Math.max(...s.transitionDuration.split(',').map((x) => parseFloat(x) * (x.trim().endsWith('ms') ? 1 : 1000)));
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      f.removeEventListener('transitionend', done);
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(done, ms + 80);
    f.addEventListener('transitionend', done);
  });
}

export function useSortDrag(opts: SortDragOptions): { ref: (el: HTMLElement | null) => void; line: ReactNode } {
  const o = useRef(opts);
  // 外框用回调 ref 存成状态：电脑版换挂、断点切换时外框换了，手势层跟着重挂
  const [boxEl, setBox] = useState<HTMLElement | null>(null);
  o.current = opts;
  const line = useRef<HTMLDivElement>(null);
  const cur = useRef<Lift | null>(null);
  /** 正在收尾（放下、取消后浮层还没撤）的那一次：卸载、再拿起时直接收掉 */
  const settling = useRef<(() => void) | null>(null);

  /** 横线就在外框里、外框是定位容器：空隙的外框坐标直接用（不量 offsetParent，线隐藏时量不到） */
  const showLine = (gap: Gap | null): void => {
    const el = line.current;
    if (!el) return;
    if (!gap) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.style.width = `${Math.round(gap.w)}px`;
    el.style.transform = `translate3d(${Math.round(gap.x)}px, ${Math.round(gap.y - 1)}px, 0)`;
  };

  /** 这一条在列表里的那几个元素（换组时退场中的旧元素和新挂上的那个会同时在） */
  const rowsOf = (id: string): HTMLElement[] => (boxEl ? [...boxEl.querySelectorAll<HTMLElement>(`[data-sort-id="${CSS.escape(id)}"]`)] : []);
  /** 这一条现在的那一行（不算退场中的旧元素：list-impl 的 popStyle 给它内联 position: absolute） */
  const rowOf = (id: string): HTMLElement | null => rowsOf(id).find((el) => el.style.position !== 'absolute') ?? null;
  /** 在自己那一组里排第几（DOM 顺序） */
  const indexOf = (r: HTMLElement): number =>
    boxEl ? [...boxEl.querySelectorAll<HTMLElement>('[data-sort-id]')].filter((el) => el.dataset['sortGroup'] === r.dataset['sortGroup'] && el.style.position !== 'absolute').indexOf(r) : -1;

  /**
   * 藏行：从拿起到收尾，这一条的元素都打 data-sort-lifted（CSS 规则：看不见、高度照占）。
   * 不写内联 visibility：Motion 的 layout 动画每帧把内联 visibility 清成 ""（motion-dom create-projection-node 的 targetStyle.visibility）。
   * 列表在拖动中、放下后可能把这一行换成新元素（运行中实测拖着时整行被重新挂上；换组时也会），MutationObserver 在画出来之前给新元素补上
   */
  const hold = (id: string): (() => void) => {
    const mark = (): void => {
      for (const el of rowsOf(id)) el.dataset['sortLifted'] = '';
    };
    mark();
    const mo = new MutationObserver(mark);
    if (boxEl) mo.observe(boxEl, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      for (const el of rowsOf(id)) delete el.dataset['sortLifted'];
    };
  };

  /**
   * 收尾：等列表画出新位置（moved 为 false 时不等，例如取消、落回原位），浮层滑过去、撤掉，行显出来。
   * 期间这一条的行（新挂上的也算）一直看不见
   */
  const settle = (l: Lift, moved: boolean): void => {
    const t0 = performance.now();
    let over = false;
    let stop: () => void = () => undefined;
    const finish = (): void => {
      if (over) return;
      over = true;
      stop();
      settling.current = null;
      l.float.remove();
      l.release();
      if (boxEl) delete boxEl.dataset['sortDragging'];
    };
    settling.current = finish;
    const land = (r: HTMLElement | null, changed: boolean): void => {
      const el = r ?? l.row;
      // 最终位置：量到的位置减掉 layout 动画此刻加的平移
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform);
      const to = el.getBoundingClientRect();
      const top = to.top - m.m42;
      const left = to.left - m.m41 - (l.rect.width - to.width) / 2;
      const now = l.float.getBoundingClientRect();
      o.current.log(`sort ${o.current.tag} settle moved=${changed ? 1 : 0} wait=${Math.round(performance.now() - t0)} dy=${Math.round(top - now.top)}`);
      l.float.style.transform = `translate3d(${Math.round(left - l.rect.left)}px, ${Math.round(top - l.rect.top)}px, 0)`;
      void afterSlide(l.float).then(() => {
        // 这一行还在动（跨组新挂上的在淡入、layout 平移还没走完）：等它停稳了再撤浮层（最多 SETTLE_WAIT_MS）
        const t1 = performance.now();
        stop = eachFrame(() => {
          if (over) return true;
          const n = rowOf(l.id);
          const cs = n ? getComputedStyle(n) : null;
          const tm = cs && cs.transform !== 'none' ? new DOMMatrixReadOnly(cs.transform) : null;
          const settled = !cs || (parseFloat(cs.opacity) >= 0.99 && (!tm || (Math.abs(tm.m41) < 0.5 && Math.abs(tm.m42) < 0.5)));
          if (!settled && performance.now() - t1 <= SETTLE_WAIT_MS) return false;
          finish();
          return true;
        });
      });
    };
    if (!moved) {
      land(l.row, false);
      return;
    }
    stop = eachFrame(() => {
      if (over) return true;
      const r = rowOf(l.id);
      const changed = r !== null && (r !== l.row || r.dataset['sortGroup'] !== l.group || indexOf(r) !== l.self);
      if (!changed && performance.now() - t0 <= SETTLE_WAIT_MS) return false;
      land(r, changed);
      return true;
    });
  };

  useEffect(() => () => settling.current?.(), []);

  useLongPressDrag(boxEl, {
    pick(target) {
      const row = target.closest<HTMLElement>('[data-sort-id]');
      if (!row || !boxEl?.contains(row) || 'sortOff' in row.dataset) return null;
      // 左滑露着按钮的那一行不拿（先收起左滑；kit SwipeRow 露着时外框打 data-swipe="open"）
      return row.querySelector('[data-swipe="open"]') || row.matches('[data-swipe="open"]') ? null : row;
    },
    lift(row) {
      const b = boxEl;
      const id = row.dataset['sortId'];
      const group = row.dataset['sortGroup'];
      if (!b || !id || group === undefined) return false;
      settling.current?.();
      const br = b.getBoundingClientRect();
      const all = [...b.querySelectorAll<HTMLElement>('[data-sort-id]')];
      const sizes = new Map<string, number>();
      let self = -1;
      const rects = all.map((el) => {
        const g = el.dataset['sortGroup'] ?? '';
        const n = sizes.get(g) ?? 0;
        if (el === row) self = n;
        sizes.set(g, n + 1);
        const r = el.getBoundingClientRect();
        return { group: g, top: r.top - br.top, bottom: r.bottom - br.top, left: r.left - br.left, width: r.width };
      });
      const gaps = gapsOf(rects).filter((g) => g.group === group || o.current.canDrop(group, g.group));
      const pad = floatPad(row);
      const rr = row.getBoundingClientRect();
      const rect = new DOMRect(rr.left - pad, rr.top, rr.width + pad * 2, rr.height);
      const float = makeFloat(row, rect, pad);
      cur.current = { row, float, rect, id, group, self, sizes, gaps, target: null, release: hold(id) };
      b.dataset['sortDragging'] = '';
      try {
        navigator.vibrate?.(8);
      } catch {
        // 不支持、不让震：不要紧
      }
      o.current.log(`sort ${o.current.tag} lift g=${groupKind(group)} n=${sizes.get(group) ?? 0}`);
      return true;
    },
    move(at: Point) {
      const l = cur.current;
      const b = boxEl;
      if (!l || !b) return;
      const br = b.getBoundingClientRect();
      const gap = nearestGap(l.gaps, at.x - br.left, at.y - br.top);
      const index = gap ? dropIndex(gap, l.group, l.self) : null;
      l.target = gap && index !== null ? { group: gap.group, index } : null;
      showLine(l.target ? gap : null);
      // 浮层：有落点停在缝下面（见文件头），没有就盖在空位上（空位跟着列表滚）
      const home = (rowOf(l.id) ?? l.row).getBoundingClientRect();
      const pad = (l.rect.width - home.width) / 2;
      const x = (l.target && gap && o.current.axis === 'xy' ? br.left + gap.x : home.left) - pad;
      const y = l.target && gap ? br.top + gap.y + FLOAT_GAP : home.top;
      l.float.style.transform = `translate3d(${Math.round(x - l.rect.left)}px, ${Math.round(y - l.rect.top)}px, 0) scale(1.02)`;
    },
    drop() {
      const l = cur.current;
      cur.current = null;
      showLine(null);
      if (!l) return;
      const tag = o.current.tag;
      if (!l.target) {
        o.current.log(`sort ${tag} drop same g=${groupKind(l.group)}`);
        settle(l, false);
        return;
      }
      const t = l.target;
      o.current.log(`sort ${tag} drop from=${groupKind(l.group)} to=${groupKind(t.group)} i=${t.index} n=${l.sizes.get(t.group) ?? 0}`);
      settle(l, true);
      o.current.onDrop({ id: l.id, from: l.group, to: t.group, index: t.index });
    },
    cancel(why) {
      const l = cur.current;
      cur.current = null;
      showLine(null);
      if (!l) return;
      o.current.log(`sort ${o.current.tag} cancel why=${why} g=${groupKind(l.group)}`);
      if (why === 'unmount') {
        l.float.remove();
        l.release();
        return;
      }
      settle(l, false);
    },
  });

  const node = useMemo(() => <div ref={line} className={styles.line} hidden aria-hidden="true" data-testid="sort-line" />, []);
  return { ref: setBox, line: node };
}

/** 竖排 6 个点（R-433）：只在浮层里显出来；读屏不念 */
export function SortGrip() {
  return (
    <span className={styles.grip} aria-hidden="true" data-testid="sort-grip">
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
