// 电脑版布局的纯逻辑（架构 5.9b 第 2、4 点，R-126 方案 B）：读出来的值怎么修正、拖动 / 调栏宽 / 收起怎么改。纯 TS，不碰 React、不碰存储
// • 读（readLayout）：没存 → 默认；v 比现在大（新版 App 写的）→ 默认、不覆盖；v 比现在小 → layout-migrate.ts 逐版升；
//   JSON 坏了、过不了 zod → 默认（invalid，调用方记 logs layout_invalid、不自动写回）；
//   能过 zod 的逐项修正：不认识的块 id 丢掉、重复的只留第一个、缺的按默认位置补进去、空栏去掉、栏数不在 1～4 用默认的栏、
//   栏宽夹到 [最窄 240 px 对应的比例, 0.6] 再归一化成和为 1、drawer 不是 left / right 当 right
// • 今天页和随手记页共用（kit），各页只给自己的默认布局；放在 kit 而不是 features/today/data：随手记页也要用，功能之间不互相 import 内部文件（B6 代定）
import { LAYOUT_V, layoutSchema, type DeskCol, type DeskLayoutValue } from '../../../../shared/schema/layout.ts';
import { migrateLayout } from './layout-migrate.ts';

/** 每栏最窄 240 px（5.9b 第 1 点）；最宽占画布 0.6（第 4 点） */
export const COL_MIN_PX = 240;
export const COL_MAX = 0.6;
export const MAX_COLS = 4;

/** 读的结果：none 没存；ok 能用（可能逐项修正过）；invalid 坏值（用默认）；newer 新版本写的（用默认、不覆盖） */
export type ReadStatus = 'none' | 'ok' | 'invalid' | 'newer';

export const allPanels = (l: Pick<DeskLayoutValue, 'cols'>): string[] => l.cols.flatMap((c) => c.panels);

/** 最窄一栏的比例（画布宽不知道时按 1280 宽的画布算） */
export const minFracOf = (canvasPx: number): number => COL_MIN_PX / (canvasPx > 0 ? canvasPx : 1280);

/** 栏宽归一化到加起来是 1，每栏都在 [minFrac, COL_MAX] 里；一栏时就是 1；画布窄到放不下几个最窄栏时平分。
 *  做法：没钉住的栏按原比例分剩下的宽度；有超过 COL_MAX 的先把它们钉在 COL_MAX，没有再把不到 minFrac 的钉在 minFrac，再分一遍，直到没有越界的。
 *  一轮只钉一个方向：钉上限只会让别的栏变宽、钉下限只会让别的栏变窄，不会来回打架；两头一起钉会钉满了还凑不够 1。
 *  原来“夹一次再归一化”会在归一化以后又越界（[0.95, 0.01] 夹成 [0.6, 0.2] 再除以 0.8 得 0.75，独立评审第 3 条） */
export function fitWidths(ws: readonly number[], minFrac: number): number[] {
  const n = ws.length;
  if (n <= 1) return n ? [1] : [];
  if (minFrac * n >= 1) return ws.map(() => 1 / n);
  const w = ws.map((x) => (Number.isFinite(x) && x > 0 ? x : 1 / n));
  const pinned: (number | null)[] = w.map(() => null);
  const share = (): number[] => {
    const room = 1 - pinned.reduce<number>((s, p) => s + (p ?? 0), 0);
    const free = w.reduce((s, x, k) => s + (pinned[k] === null ? x : 0), 0);
    return w.map((x, k) => pinned[k] ?? (free > 0 ? (x * room) / free : room));
  };
  for (let round = 0; round < 2 * n; round++) {
    const v = share();
    const over = v.map((x, k) => pinned[k] === null && x > COL_MAX);
    const under = v.map((x, k) => pinned[k] === null && x < minFrac);
    const pin = over.some(Boolean) ? over : under;
    if (!pin.some(Boolean)) return v;
    pin.forEach((p, k) => {
      if (p) pinned[k] = pin === over ? COL_MAX : minFrac;
    });
  }
  return share();
}

const withWidths = (cols: readonly { w: number; panels: readonly string[] }[], minFrac: number): DeskCol[] => {
  const ws = fitWidths(cols.map((c) => c.w), minFrac);
  return cols.map((c, i) => ({ w: ws[i] ?? 1, panels: c.panels }));
};

/** 修正一份过了 zod 的值（def 是这一页的默认布局） */
function fix(raw: { cols: readonly { w: number; panels: readonly string[] }[]; collapsed?: readonly string[] | undefined; drawer?: string | undefined; locked?: boolean | undefined }, def: DeskLayoutValue, minFrac: number): DeskLayoutValue {
  const known = new Set(allPanels(def));
  const src = raw.cols.length >= 1 && raw.cols.length <= MAX_COLS ? raw.cols : def.cols;
  const seen = new Set<string>();
  const cols = src.map((c) => {
    const panels: string[] = [];
    for (const id of c.panels) {
      if (!known.has(id) || seen.has(id)) continue;
      seen.add(id);
      panels.push(id);
    }
    return { w: c.w, panels };
  });
  // 缺的块（新版本多出来的、旧值里没有的）按默认位置补：默认在第几栏（超出就放最后一栏）、第几个
  def.cols.forEach((dc, ci) =>
    dc.panels.forEach((id, pi) => {
      if (seen.has(id)) return;
      const col = cols[Math.min(ci, cols.length - 1)];
      col?.panels.splice(Math.min(pi, col.panels.length), 0, id);
      seen.add(id);
    }),
  );
  const kept = cols.filter((c) => c.panels.length > 0);
  return {
    v: LAYOUT_V,
    cols: withWidths(kept.length ? kept : def.cols, minFrac),
    collapsed: [...new Set((raw.collapsed ?? []).filter((id) => known.has(id)))],
    drawer: raw.drawer === 'left' ? 'left' : 'right',
    locked: raw.locked === true,
  };
}

/** 读出来的值 → 界面用的布局。栏宽默认不按画布夹（minFrac 0：读的时候不知道画布多宽，大屏上拖窄的栏按 1280 宽夹会变宽、本页的 local 也永远对不上），
 *  只夹最宽、归一化；最窄只在显示时按实际画布夹（DeskLayout 的 fitWidths） */
export function readLayout(raw: unknown, def: DeskLayoutValue, minFrac = 0): { layout: DeskLayoutValue; status: ReadStatus } {
  if (raw === undefined || raw === null) return { layout: def, status: 'none' };
  let val: unknown = raw;
  if (typeof val === 'string') {
    try {
      val = JSON.parse(val) as unknown;
    } catch {
      return { layout: def, status: 'invalid' };
    }
  }
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return { layout: def, status: 'invalid' };
  const v = (val as Record<string, unknown>)['v'];
  if (typeof v !== 'number') return { layout: def, status: 'invalid' };
  if (v > LAYOUT_V) return { layout: def, status: 'newer' };
  const up = v < LAYOUT_V ? migrateLayout(val as Record<string, unknown>) : val;
  const parsed = layoutSchema.safeParse(up);
  if (!parsed.success) return { layout: def, status: 'invalid' };
  return { layout: fix(parsed.data, def, minFrac), status: 'ok' };
}

/** 存进 settings 的值（只有 id、顺序、比例；比例留 3 位小数，一份不到 300 字节） */
export function toStored(l: DeskLayoutValue): DeskLayoutValue {
  return { ...l, cols: l.cols.map((c) => ({ w: Math.round(c.w * 1000) / 1000, panels: c.panels })) };
}

/** 去掉空栏、重新分配栏宽（放下时做；拖动途中不去，免得栏一下子没了、宽度乱跳） */
export function dropEmpty(l: DeskLayoutValue, minFrac = minFracOf(0)): DeskLayoutValue {
  const kept = l.cols.filter((c) => c.panels.length > 0);
  return kept.length === l.cols.length ? l : { ...l, cols: withWidths(kept, minFrac) };
}

/** 把一块放到第 col 栏的第 idx 个（按整栏数组的下标，收起的块也算）；拖动途中 keepEmpty 留着空栏 */
export function moveTo(l: DeskLayoutValue, id: string, col: number, idx: number, minFrac = minFracOf(0), keepEmpty = false): DeskLayoutValue {
  if (col < 0 || col >= l.cols.length) return l;
  const cols = l.cols.map((c) => ({ w: c.w, panels: c.panels.filter((p) => p !== id) }));
  const target = cols[col];
  if (!target) return l;
  target.panels.splice(Math.max(0, Math.min(idx, target.panels.length)), 0, id);
  const moved = { ...l, cols };
  return keepEmpty ? moved : dropEmpty(moved, minFrac);
}

/** 这一块在哪：第几栏、本栏看得见的块里第几个（都从 0 起）；不在返回 null */
export function whereIs(l: DeskLayoutValue, id: string): { col: number; at: number } | null {
  for (let col = 0; col < l.cols.length; col++) {
    const vis = visible(l, col);
    const at = vis.indexOf(id);
    if (at >= 0) return { col, at };
  }
  return null;
}

/** 某一栏看得见的块（去掉收起的） */
export const visible = (l: DeskLayoutValue, col: number): string[] => (l.cols[col]?.panels ?? []).filter((p) => !l.collapsed.includes(p));

/** 键盘移动（5.9b 第 5 点）：↑↓ 在本栏里挪一格，← → 移到相邻栏同一高度附近；到头了原样返回 */
export function moveBy(l: DeskLayoutValue, id: string, dir: 'up' | 'down' | 'left' | 'right', minFrac = minFracOf(0), keepEmpty = false): DeskLayoutValue {
  const pos = whereIs(l, id);
  if (!pos) return l;
  const { col, at } = pos;
  const full = l.cols[col]?.panels ?? [];
  if (dir === 'up' || dir === 'down') {
    const vis = visible(l, col);
    const other = vis[dir === 'up' ? at - 1 : at + 1];
    if (other === undefined) return l;
    const rest = full.filter((p) => p !== id);
    const oi = rest.indexOf(other);
    return moveTo(l, id, col, dir === 'up' ? oi : oi + 1, minFrac, keepEmpty);
  }
  const to = dir === 'left' ? col - 1 : col + 1;
  const tcol = l.cols[to];
  if (!tcol) return l;
  const tvis = visible(l, to);
  const anchor = tvis[at];
  return moveTo(l, id, to, anchor === undefined ? tcol.panels.length : tcol.panels.indexOf(anchor), minFrac, keepEmpty);
}

/** 拖第 i 条竖条（第 i 栏和第 i+1 栏之间）：第 i 栏的新比例 w，两栏合计不变，各自夹在 [最窄, 0.6] */
export function resizeAt(l: DeskLayoutValue, i: number, w: number, minFrac = minFracOf(0)): DeskLayoutValue {
  const a = l.cols[i];
  const b = l.cols[i + 1];
  const r = resizeRange(l, i, minFrac);
  if (!a || !b || !r || r.lo > r.hi) return l;
  const pair = a.w + b.w;
  const nw = Math.min(r.hi, Math.max(r.lo, w));
  if (Math.abs(nw - a.w) < 1e-6) return l;
  return { ...l, cols: l.cols.map((c, k) => (k === i ? { ...c, w: nw } : k === i + 1 ? { ...c, w: pair - nw } : c)) };
}

/** 第 i 条竖条能调的范围（aria-valuemin / max 和 Home / End 用） */
export function resizeRange(l: DeskLayoutValue, i: number, minFrac = minFracOf(0)): { lo: number; hi: number } | null {
  const a = l.cols[i];
  const b = l.cols[i + 1];
  if (!a || !b) return null;
  const pair = a.w + b.w;
  return { lo: Math.max(minFrac, pair - COL_MAX), hi: Math.min(COL_MAX, pair - minFrac) };
}

/** 收起或放回一块（放回就是回原栏原位置：收起时块一直留在 cols 里） */
export function setCollapsed(l: DeskLayoutValue, id: string, on: boolean): DeskLayoutValue {
  const has = l.collapsed.includes(id);
  if (has === on) return l;
  return { ...l, collapsed: on ? [...l.collapsed, id] : l.collapsed.filter((p) => p !== id) };
}

/** 两份布局一样（存不存、要不要出“已保存”看它） */
export const sameLayout = (a: DeskLayoutValue, b: DeskLayoutValue): boolean => JSON.stringify(toStored(a)) === JSON.stringify(toStored(b));
