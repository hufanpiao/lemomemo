// 拖动排序的排序值（R-429，主持人 11-15 定：字符串键 todos.sort_key、notes.sort_key；隐私记的放加密载荷，不进明文列）。
// 待办页、随手记页、隐私记页和 vault 函数共用这一份；纯函数，不读时钟（now 由调用方给）。
// • 键的样子：一串十进制数字，最后一位不是 0（SORT_KEY_RE），按“0.数字串”读成一个小数。不带末尾 0，字符串的字典序就等于小数的大小，
//   比较直接用 < >，不用解析；任意两个键之间总能再插一个（midKey），不用整组重排
// • 时间键 timeKey：毫秒时刻补到 13 位、去掉末尾 0（1731000000000 → "1731"），和拖出来的键在同一个数轴上。
//   随手记、隐私记没拖过的条目按 created_at 的时间键当排序值（effKey），所以“新记的仍排最上面”不用另写规则：新的一条时刻最大
// • 显示顺序一律是键大的在上（降序）；planMove 按松手后的顺序给出要写的键：
//   – 上下两个邻居都有键、上面的比下面的大：只给拖的这一条一个夹在中间的新键（一笔写入）
//   – 拖到最上面：比原来的第一条大一点，但不超过此刻的时间键（新记的仍在它上面）
//   – 邻居里有没键的（待办没拖过的那组）、两个邻居一样大、新键太长：这一组从此刻的时间键起往下一条一个键重排（写这一组每一条）
/** 随手记、隐私记的排序方式（R-429）：按时间（列表方式按天分组）/ 自己排；各记各的设置键。随手记页、设置页共用这一份 */
export type ListOrder = 'time' | 'manual';
export const ORDER_KEYS = ['notes.order', 'vault.order'] as const;
export type OrderKey = (typeof ORDER_KEYS)[number];
export const orderOf = (v: unknown): ListOrder => (v === 'manual' ? 'manual' : 'time');

/** 键的格式（和迁移 20261116090000_sort_key.sql 的 todos_sort_key_fmt、notes_sort_key_fmt 一致） */
export const SORT_KEY_RE = /^[0-9]*[1-9]$/;
/** 键最长多少位（同一个空隙里连着插一百多次才会到；到了就整组重排） */
export const SORT_KEY_MAX = 128;

export const isSortKey = (v: unknown): v is string => typeof v === 'string' && v.length <= SORT_KEY_MAX && SORT_KEY_RE.test(v);

/** 读一行的排序值：不是合格的键当没有 */
export const sortKeyOf = (r: Readonly<Record<string, unknown>>): string | null => (isSortKey(r['sort_key']) ? r['sort_key'] : null);

/** 毫秒时刻的时间键（见文件头）；0 和负数没有键 */
export function timeKey(ms: number): string | null {
  const n = Math.trunc(ms);
  if (!(n > 0) || n >= 1e13) return null;
  return String(n).padStart(13, '0').replace(/0+$/, '');
}

/** 随手记、隐私记的排序值：拖过的用自己的键，没拖过的用 created_at 的时间键 */
export const effKey = (sortKey: string | null, createdAt: number): string => sortKey ?? timeKey(createdAt) ?? '1';

/** 两个键之间的键：lo < 结果 < hi；lo 为 '' 当 0，hi 为 null 当 1（rocicorp fractional-indexing 的十进制写法） */
export function midKey(lo: string, hi: string | null): string {
  if (hi !== null) {
    // 共同前缀（lo 短的那截按 0 补）；用 charAt 不用方括号（后端 F7）
    let n = 0;
    while (n < hi.length && (lo.charAt(n) || '0') === hi.charAt(n)) n++;
    if (n > 0) return hi.slice(0, n) + midKey(lo.slice(n), hi.slice(n));
  }
  const a = lo === '' ? 0 : Number(lo.charAt(0));
  const b = hi === null ? 10 : Number(hi.charAt(0));
  if (b - a > 1) return String(Math.round((a + b) / 2));
  if (hi !== null && hi.length > 1) return hi.slice(0, 1);
  return String(a) + midKey(lo.slice(1), null);
}

/** 一条和它现在的键（没有为 null） */
export interface Keyed {
  id: string;
  key: string | null;
}

/** 要写的一笔：这一条的新键、原来的键（撤销用） */
export interface KeyWrite {
  id: string;
  key: string;
  prev: string | null;
}

/**
 * 松手后要写哪些键（规则见文件头）。list：拖的那一组松手前的显示顺序（从上到下，含拖的这一条；跨组拖进来的那一条不在里面）；
 * id：拖的那一条；index：放下后它在这一组里排第几（从 0 起，按去掉它以后的列表数）；prevKey：拖的这一条原来的键（跨组时给）
 */
export function planMove(list: readonly Keyed[], id: string, index: number, now: number, prevKey: string | null = null): KeyWrite[] {
  const mine = list.find((x) => x.id === id);
  const rest = list.filter((x) => x.id !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  const order: Keyed[] = [...rest.slice(0, at), mine ?? { id, key: prevKey }, ...rest.slice(at)];
  const above = at > 0 ? rest.at(at - 1) : undefined;
  const below = rest.at(at);
  const top = timeKey(now) ?? '1';
  const fits = (k: string): boolean => k.length <= SORT_KEY_MAX;
  const hi = above ? above.key : null;
  const lo = below ? below.key : null;
  const one = (k: string): KeyWrite[] => [{ id, key: k, prev: mine?.key ?? prevKey }];
  if ((!above || hi !== null) && (!below || lo !== null) && (hi === null || lo === null || lo < hi)) {
    let k: string | null;
    if (hi === null && lo === null) k = top;
    else if (hi === null) k = lo !== null && lo < top ? midKey(lo, top) : `${lo ?? ''}5`;
    else k = midKey(lo ?? '', hi);
    if (fits(k) && isSortKey(k)) return one(k);
  }
  // 整组重排：此刻的时间键起，往下一条一毫秒（都比 now 小或等于，新记的照样在上面）
  const out: KeyWrite[] = [];
  order.forEach((x, i) => {
    const k = timeKey(now - i) ?? '1';
    if (k !== x.key) out.push({ id: x.id, key: k, prev: x.id === id ? (mine?.key ?? prevKey) : x.key });
  });
  return out;
}
