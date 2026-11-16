// 长按拖动排序（kit，R-429；R-433“拖动的时候前面有那 6 个小点”）：待办页、随手记页（列表、瀑布流）、隐私记页三处共用这一份，不用 dnd-kit
// （电脑版布局拖面板 DeskLayout 是 dnd-kit 的，两套不混用）。手势底层是 motion 的 useLongPressDrag（按住 0.4 秒没动才拿起，动了交给左滑或滚动）。
// 用法：
//   const sd = useSortDrag({ tag: 'todos', axis: 'y', canDrop, onDrop, log: rlog });
//   <div ref={sd.ref} className={sortBoxClass}>…<li data-sort-id={id} data-sort-group={g} className={sortRowClass}><SortGrip />…</li>…{sd.line}</div>
// • 行：data-sort-id（这一条的 id）、data-sort-group（它在哪一组，同一组里 DOM 顺序就是显示顺序）；不能拖的行再加 data-sort-off（已完成、只读……）。
//   行上挂 sortRowClass（定位、长按不出 iPhone 的放大镜和菜单、不选字），行里放一个 SortGrip（竖排 6 个点，平时透明，被拿起的那一行才显出来）
// • 拿起：记下每一行此刻的位置（相对外框，拖的过程中外框跟着滚，行之间不挪），被拿起的那一行打 data-sort-lifted（浮起、投影、6 个点），
//   跟着手指只写 transform（axis: 'y' 只竖着跟；'xy' 瀑布流两列横竖都跟）；运行日志 sort lift
// • 落点：手指离哪个“空隙”最近（每一行的上沿 = 放到它前面；每一列最后一行的下沿 = 放到它后面），横向不在那一列里的加罚分；
//   canDrop(from, to) 不让进的组不算。落点画一条强调色细横线（sd.line，只写 transform 和宽），落回原位不画
// • 放下：交给 onDrop({id, from, to, index})，index 是放下后它在那一组里排第几（从 0 起，按去掉它以后的那一组数）；落回原位、没落点只记日志。
//   运行日志 sort drop from= to= i= n=（组名只记冒号前那段，例如 day:2026-11-18 记 day；不记标题）、sort drop same、sort cancel why=
// • 动效只用 transform、opacity；减少动态效果时没有浮起的过渡（CSS 认 :root[data-rm="1"]）
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useLongPressDrag, type Point } from '../../motion/gestures.ts';
import styles from './SortDrag.module.css';

/** 行上挂的类（见文件头） */
export const sortRowClass = styles.row;
/** 列表外框（落点横线相对它定位） */
export const sortBoxClass = styles.box;

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
  id: string;
  group: string;
  /** 在自己那一组里的下标 */
  self: number;
  /** 每组几条（日志用） */
  sizes: Map<string, number>;
  gaps: Gap[];
  at0: Point;
  boxTop0: number;
  boxLeft0: number;
  target: { group: string; index: number } | null;
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

export function useSortDrag(opts: SortDragOptions): { ref: (el: HTMLElement | null) => void; line: ReactNode } {
  const o = useRef(opts);
  // 外框用回调 ref 存成状态：电脑版换挂、断点切换时外框换了，手势层跟着重挂
  const [boxEl, setBox] = useState<HTMLElement | null>(null);
  o.current = opts;
  const line = useRef<HTMLDivElement>(null);
  const cur = useRef<Lift | null>(null);

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
  const clear = (): void => {
    const l = cur.current;
    cur.current = null;
    if (l) {
      delete l.row.dataset['sortLifted'];
      l.row.style.transform = '';
    }
    const b = boxEl;
    if (b) delete b.dataset['sortDragging'];
    if (line.current) line.current.hidden = true;
  };

  useLongPressDrag(boxEl, {
    pick(target) {
      const row = target.closest<HTMLElement>('[data-sort-id]');
      if (!row || !boxEl?.contains(row) || 'sortOff' in row.dataset) return null;
      // 左滑露着按钮的那一行不拿（先收起左滑；kit SwipeRow 露着时外框打 data-swipe="open"）
      return row.querySelector('[data-swipe="open"]') || row.matches('[data-swipe="open"]') ? null : row;
    },
    lift(row, at) {
      const b = boxEl;
      const id = row.dataset['sortId'];
      const group = row.dataset['sortGroup'];
      if (!b || !id || group === undefined) return false;
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
      cur.current = { row, id, group, self, sizes, gaps, at0: at, boxTop0: br.top, boxLeft0: br.left, target: null };
      row.dataset['sortLifted'] = '';
      b.dataset['sortDragging'] = '';
      try {
        navigator.vibrate?.(8);
      } catch {
        // 不支持、不让震：不要紧
      }
      o.current.log(`sort ${o.current.tag} lift g=${groupKind(group)} n=${sizes.get(group) ?? 0}`);
      return true;
    },
    move(at) {
      const l = cur.current;
      const b = boxEl;
      if (!l || !b) return;
      const br = b.getBoundingClientRect();
      const dy = at.y - l.at0.y - (br.top - l.boxTop0);
      const dx = o.current.axis === 'xy' ? at.x - l.at0.x - (br.left - l.boxLeft0) : 0;
      l.row.style.transform = `translate3d(${Math.round(dx)}px, ${Math.round(dy)}px, 0) scale(1.02)`;
      const gap = nearestGap(l.gaps, at.x - br.left, at.y - br.top);
      const index = gap ? dropIndex(gap, l.group, l.self) : null;
      l.target = gap && index !== null ? { group: gap.group, index } : null;
      showLine(l.target ? gap : null);
    },
    drop() {
      const l = cur.current;
      clear();
      if (!l) return;
      const tag = o.current.tag;
      if (!l.target) {
        o.current.log(`sort ${tag} drop same g=${groupKind(l.group)}`);
        return;
      }
      const t = l.target;
      o.current.log(`sort ${tag} drop from=${groupKind(l.group)} to=${groupKind(t.group)} i=${t.index} n=${l.sizes.get(t.group) ?? 0}`);
      o.current.onDrop({ id: l.id, from: l.group, to: t.group, index: t.index });
    },
    cancel(why) {
      const l = cur.current;
      clear();
      if (l) o.current.log(`sort ${o.current.tag} cancel why=${why} g=${groupKind(l.group)}`);
    },
  });

  const node = useMemo(() => <div ref={line} className={styles.line} hidden aria-hidden="true" data-testid="sort-line" />, []);
  return { ref: setBox, line: node };
}

/** 竖排 6 个点（R-433）：平时透明，被拿起的那一行才显出来；读屏不念 */
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
