// 日志上传队列（架构 0.38 第 68 条、4.1“logs 不进缓存，只放在上传队列里”；数据字典 4.6；接手清单 K8-logs、K6-log）
// • 不走 outbox：outbox 按 id 合并、和撤销抵消，logs 的 id 是服务器的 bigserial，客户端不生成
// • 存放：localStorage 的 lemo.logq.<user_id>（platform/log-store.ts），最多 LOG_QUEUE_MAX 条；满了丢最旧的并记下丢了几条，
//   下次上传时在这一批前面附一条 act = log_dropped、code = 条数。读写失败退回只放内存（这一页关掉就没了）
// • 几个标签页共用一个键：每次改都“读 → 改 → 写”，不拿内存里的旧副本覆盖别的页刚写进去的；每条带一个本机随机 k，只用来删掉传上去的那几条，不上传
// • 上传：只在持有同步锁的那一页（setLeader(true)）、在线时；每批最多 LOG_BATCH 条；
//   时机：攒够 LOG_FLUSH_AT 条、距上次上传满 LOG_FLUSH_MS（每 30 秒看一次）、恢复网络
//   结果（归类见 platform/supabase/log-upload.ts）：ok 删掉这一批；drop（quota、42501）也删掉、不重试；bad（数据错误）把这一批二分重传，
//   只丢真正出错的那一条；retry（断网、5xx、401、408、426、429 等）留着下次再传，但每条记重试次数 n，
//   连续 retry 超过 LOG_MAX_RETRIES 次就丢掉、算进 log_dropped。丢了的在控制台留一句（英文，A20 不许代码字符串里有汉字）
// • 二分重传每发一个小请求前先看还是不是主页、有没有 close，不是了就停下，剩下的留到下次；close 以后在途那一批传完也不再写存储
// • 一行只写 t（客户端时间，离现在超过 ±1 天的改成现在）、act、coll、code、item_id（只有 ITEM_ID_ACTS 里的 act 才带、且是 uuid）、
//   fields（元素 ≤ 20、拼起来 ≤ 640 字）；截断后去掉落单的代理字符；不放内容（0.38 第 62、67 条）
// • 交接主页：setLeader(false) 返回正在进行的那次上传，app/sync-wiring.ts 放锁前等它传完，新主页不会把同一批再传一遍
// • 上传前核对会话主人（guardOwner，main.tsx 包在 upload 外面）：别的标签页已经换成 B 账号时，A 页拿到的是 B 的令牌，这时不传、留着
// • 两件可以接受的事：① 几个标签页“同时” add 时 localStorage 的读改写不是原子的，极少数情况会丢一条（日志丢几条不影响功能）；
//   ② 退出登录清掉队列（platform/sign-out.ts）以后，这一页还没关时又记的日志可能把同一账号的键重新建出来；
//   下次换账号启动时由 clearOtherLogQueues 清掉，或同一账号再登录时照常传上去
// 纯 TS：不准 import React 和任何功能（A1）；网络、localStorage 经注入（A12、A13）；行和结果的类型在 shared
import type { LogRow, LogUploadResult } from '../../../shared/core/log-row.ts';

export type { LogRow, LogUploadResult };

export const LOG_QUEUE_MAX = 200;
export const LOG_BATCH = 50;
export const LOG_FLUSH_AT = 20;
export const LOG_FLUSH_MS = 30_000;
/** t 离现在超过这么久就改成现在（客户端时钟乱了、或存进来的值坏了） */
export const LOG_T_SKEW_MS = 86_400_000;
/** 一条日志最多连续 retry 几次，再多就丢掉（算进 log_dropped） */
export const LOG_MAX_RETRIES = 5;
/** 带 item_id 的 act（数据字典 4.6：outbox_vault_shell_drop、row_unknown 记记录 id，只是 uuid、不含内容；别的 act 一律不带） */
export const ITEM_ID_ACTS: ReadonlySet<string> = new Set(['outbox_vault_shell_drop', 'row_unknown']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 通道交来的一条日志 */
export interface LogRecord {
  act: string;
  /** 记下的时刻（毫秒，客户端时间） */
  t: number;
  coll?: string;
  code?: string;
  itemId?: string;
  fields?: readonly string[];
}

interface Queued extends LogRecord {
  /** 本机随机键：只用来删掉传上去的那几条 */
  k: string;
  /** 已经连续 retry 了几次（没有就是 0） */
  n?: number;
}

interface QueueState {
  items: Queued[];
  dropped: number;
}

export type LogUpload = (rows: readonly LogRow[]) => Promise<LogUploadResult>;

export interface LogQueueDeps {
  /** localStorage 里这个账号的键（platform/log-store.ts 的 logQueueStore）；读失败 undefined、写失败 false */
  store: { read(): string | null | undefined; write(text: string): boolean };
  upload: LogUpload;
  isOnline(): boolean;
  /** 恢复网络；返回取消函数 */
  onOnline(fn: () => void): () => void;
  now?: () => number;
  newKey?: () => string;
  warn?: (msg: string) => void;
  /** 测试用：换掉定时器 */
  every?: (fn: () => void, ms: number) => () => void;
}

export interface LogQueue {
  add(r: LogRecord): void;
  /** 拿到 / 放开同步锁：拿到时开始按时上传；放开时返回正在进行的那次上传（放锁前等它） */
  setLeader(on: boolean): Promise<void>;
  /** 立刻传一批（不是主页、离线、正在传、已关时什么也不做） */
  flush(): Promise<void>;
  /** 被移除、退出：停止上传，之后 add 什么也不做；返回正在进行的那次上传 */
  close(): Promise<void>;
  /** 测试用：队列现在的样子 */
  peek(): { items: readonly LogRecord[]; dropped: number };
}

/** 上传前核对会话主人：现在的会话不是这个账号（别的标签页换了账号、或已退出）就不传，按 retry 留着 */
export function guardOwner(userId: string, currentUserId: () => string | null, upload: LogUpload): LogUpload {
  return (rows) => (currentUserId() === userId ? upload(rows) : Promise.resolve<LogUploadResult>('retry'));
}

/** 截到 n 个 UTF-16 单元；截断处落单的高位代理去掉（不然发出去的是半个字符） */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const out = s.slice(0, n);
  const last = out.charCodeAt(out.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out;
}
const cutOpt = (s: string | undefined, n: number): string | undefined => (s === undefined ? undefined : cut(s, n));

/** fields：最多 20 个，拼起来（逗号分隔）≤ 640 字，超了从后面截 */
export function clampFields(fields: readonly string[] | undefined): string[] | undefined {
  if (!fields || fields.length === 0) return undefined;
  const out: string[] = [];
  let len = 0;
  for (const f of fields.slice(0, 20)) {
    const add = (out.length > 0 ? 1 : 0) + f.length;
    if (len + add > 640) {
      const room = 640 - len - (out.length > 0 ? 1 : 0);
      const part = room > 0 ? cut(f, room) : '';
      if (part) out.push(part);
      break;
    }
    out.push(f);
    len += add;
  }
  return out;
}

/** 一条记录 → logs 的一行（按列的长度上限截断；t 离 now 超过 ±1 天改成 now） */
export function toLogRow(r: LogRecord, now: number): LogRow {
  const t = Number.isFinite(r.t) && Math.abs(r.t - now) <= LOG_T_SKEW_MS ? Math.trunc(r.t) : Math.trunc(now);
  const row: LogRow = { t, act: cut(r.act, 32) };
  const coll = cutOpt(r.coll, 32);
  const code = cutOpt(r.code, 64);
  const fields = clampFields(r.fields);
  if (coll) row.coll = coll;
  if (code) row.code = code;
  if (r.itemId && ITEM_ID_ACTS.has(r.act) && UUID_RE.test(r.itemId)) row.item_id = r.itemId;
  if (fields) row.fields = fields;
  return row;
}

function parse(text: string | null): QueueState {
  if (!text) return { items: [], dropped: 0 };
  try {
    const o = JSON.parse(text) as Partial<QueueState> | null;
    const items = Array.isArray(o?.items)
      ? o.items.filter((x): x is Queued => typeof x === 'object' && x !== null && typeof x.act === 'string' && typeof x.t === 'number' && typeof x.k === 'string')
      : [];
    const dropped = typeof o?.dropped === 'number' && o.dropped > 0 ? Math.floor(o.dropped) : 0;
    return { items, dropped };
  } catch {
    return { items: [], dropped: 0 };
  }
}

const defaultEvery = (fn: () => void, ms: number): (() => void) => {
  const h = setInterval(fn, ms);
  return () => clearInterval(h);
};

/** 一批里的一行；k 为 null 的是附上的 log_dropped */
interface Part {
  row: LogRow;
  k: string | null;
}

interface SendOutcome {
  /** 已处理（传上去或丢掉）的本机键 */
  done: Set<string>;
  /** log_dropped 那一行处理掉了 */
  markerDone: boolean;
  /** 丢掉了几行 */
  lost: number;
  /** 上传回了 retry 的那几行的本机键（记重试次数；停下没发的不算） */
  retried: Set<string>;
}

/** 传一批：bad 时二分重传，只丢真正出错的那一行；遇到 retry、drop（quota 等）不再传剩下的；
 *  每发一个请求前 active() 为假（放了锁、已关）就停下，剩下的留到下次 */
async function sendBatch(parts: readonly Part[], upload: LogUpload, active: () => boolean): Promise<SendOutcome> {
  const out: SendOutcome = { done: new Set(), markerDone: false, lost: 0, retried: new Set() };
  const settle = (ps: readonly Part[], lost: boolean): void => {
    for (const p of ps) {
      if (p.k === null) out.markerDone = true;
      else out.done.add(p.k);
    }
    if (lost) out.lost += ps.length;
  };
  const go = async (ps: readonly Part[]): Promise<boolean> => {
    if (!active()) return false;
    const r = await upload(ps.map((p) => p.row));
    if (r === 'retry') {
      for (const p of ps) if (p.k !== null) out.retried.add(p.k);
      return false;
    }
    if (r === 'ok') {
      settle(ps, false);
      return true;
    }
    if (r === 'drop' || ps.length === 1) {
      settle(ps, true);
      return r !== 'drop';
    }
    const mid = Math.ceil(ps.length / 2);
    return (await go(ps.slice(0, mid))) && go(ps.slice(mid));
  };
  await go(parts);
  return out;
}

export function createLogQueue(deps: LogQueueDeps): LogQueue {
  const now = deps.now ?? (() => Date.now());
  const newKey = deps.newKey ?? (() => crypto.randomUUID());
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const every = deps.every ?? defaultEvery;
  /** 存储读写失败时的内存副本 */
  let mem: QueueState = { items: [], dropped: 0 };
  let leader = false;
  let closed = false;
  let inflight: Promise<void> | null = null;
  let lastUpload = now();
  let offTimer: (() => void) | null = null;
  let offOnline: (() => void) | null = null;

  const load = (): QueueState => {
    const text = deps.store.read();
    if (text === undefined) return { items: [...mem.items], dropped: mem.dropped };
    return parse(text);
  };
  const save = (st: QueueState): void => {
    mem = st;
    deps.store.write(JSON.stringify(st));   // 写不进去：mem 就是这一页的队列
  };

  async function run(): Promise<void> {
    const st = load();
    if (st.items.length === 0 && st.dropped === 0) return;
    const t = now();
    const parts: Part[] = st.items.slice(0, LOG_BATCH).map((x) => ({ row: toLogRow(x, t), k: x.k }));
    if (st.dropped > 0) parts.unshift({ row: toLogRow({ act: 'log_dropped', code: String(st.dropped), t }, t), k: null });
    const o = await sendBatch(parts, deps.upload, () => leader && !closed);
    lastUpload = now();
    if (o.lost > 0) warn(`[logs] upload rejected, dropped ${o.lost}`);
    if (closed) return;   // 被移除、退出：队列已经（或马上）清掉，不再写回
    if (o.done.size === 0 && !o.markerDone && o.retried.size === 0) return;
    const cur = load();
    let dropped = o.markerDone ? Math.max(cur.dropped - st.dropped, 0) : cur.dropped;
    const items: Queued[] = [];
    for (const x of cur.items) {
      if (o.done.has(x.k)) continue;
      if (!o.retried.has(x.k)) {
        items.push(x);
        continue;
      }
      const n = (x.n ?? 0) + 1;
      if (n > LOG_MAX_RETRIES) dropped++;
      else items.push({ ...x, n });
    }
    save({ items, dropped });
  }

  function flush(): Promise<void> {
    if (!leader || closed || inflight || !deps.isOnline()) return Promise.resolve();
    const p = run().finally(() => {
      inflight = null;
    });
    inflight = p;
    return p;
  }

  const stopTimers = (): void => {
    offTimer?.();
    offOnline?.();
    offTimer = offOnline = null;
  };
  const pending = (): Promise<void> => inflight ?? Promise.resolve();

  return {
    add(r) {
      if (closed) return;
      const st = load();
      st.items.push({ ...r, k: newKey() });
      while (st.items.length > LOG_QUEUE_MAX) {
        st.items.shift();
        st.dropped++;
      }
      save(st);
      if (leader && st.items.length >= LOG_FLUSH_AT) void flush();
    },
    setLeader(on) {
      if (on === leader || closed) return pending();
      leader = on;
      stopTimers();
      if (!on) return pending();
      offTimer = every(() => {
        if (now() - lastUpload >= LOG_FLUSH_MS) void flush();
      }, LOG_FLUSH_MS);
      offOnline = deps.onOnline(() => void flush());
      if (load().items.length >= LOG_FLUSH_AT) void flush();
      return Promise.resolve();
    },
    flush,
    close() {
      closed = true;
      leader = false;
      stopTimers();
      return pending();
    },
    peek() {
      const st = load();
      return { items: st.items.map(({ k: _k, ...x }) => x), dropped: st.dropped };
    },
  };
}
