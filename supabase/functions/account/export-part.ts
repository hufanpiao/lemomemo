// account 的 export action 的 part 一步：取一片（架构 0.47 续 ①“取一片”“游标”“响应”，0.47 第 18、19 条；安全审查 M2、M3、S1、S2、Q5）。
// 顺序固定：扣每天分片数 → 校验 export_id 和游标 → 定模式 → export_job_take → 查 logs 有发起记录（0.47 第 22 条 T2，没有 410）
//   → 从游标处按主键翻页读、每写一行查一次本片预算。store 调用超时（store-timeout.ts）一律 try_later，已占的分片数不退。
// 每片是一个单独的 gzip 成员（不带 Content-Encoding），下一个游标放响应头 x-lemo-export-next（取完是 done）。对外经 core.ts 转出。
// 和 core.ts 同样的约束：不 import npm 包、不碰 Deno 全局，Vitest 直接测。

import {
  type ActiveUser, DAY_S, type Deps, err, type ExportLimits, type ExportTable, exportLimits, keys, NO_STORE, type VaultMode,
} from './common.ts';
import { ExportError, exportRows, UUID, vaultMode } from './export.ts';
import { envKind } from '../_shared/env-kind.ts';

export const EXPORT_NEXT_HEADER = 'x-lemo-export-next';
/** 游标里 b（已回的 gzip 字节合计）、r（这张表上一页的平均行宽）的上限 */
export const CURSOR_MAX_B = 2 ** 40;
export const CURSOR_MAX_R = 2 ** 20;
const TEXT_KEY = /^[a-z0-9._-]{1,64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const FLUSH_BYTES = 1024 * 1024;
const ENC = new TextEncoder();

/**
 * 游标（对客户端不透明）：t 表序号；after 这张表上一行的主键（null = 从头）；n 这张表已读行数；w 这张表是否已写过行（补逗号）；
 * b 已回的 gzip 字节合计；r 这张表上一页的平均行宽（字节，换表清空，没有时第一页只取 firstPage 行）。
 * 约定：游标指向的状态里，第 t 张表的开头 "名字":[ 已经写过了。
 */
export interface ExportCursor { t: number; after: string | number | null; n: number; w: boolean; b: number; r?: number | undefined }

export function encodeCursor(c: ExportCursor): string {
  // 游标里只有数字、布尔、uuid 和 TEXT_KEY 允许的字符，JSON 一定是 ASCII，btoa 直接用
  const o = c.r === undefined ? { t: c.t, after: c.after, n: c.n, w: c.w, b: c.b } : { t: c.t, after: c.after, n: c.n, w: c.w, b: c.b, r: c.r };
  return btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isCount = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;

/** 主键值按这张表主键的类型收窄（S1）：uuid 只收 uuid，整数只收安全整数，文本只收 TEXT_KEY，profiles 只能是本人 */
export function keyOk(t: ExportTable, v: unknown, userId: string): v is string | number {
  switch (t.keyType) {
    case 'uuid': return typeof v === 'string' && UUID.test(v);
    case 'int': return typeof v === 'number' && Number.isSafeInteger(v);
    // 以后启用 text 键的表，主键列必须用 C 排序规则（collate "C"）：游标按 JS 字符串比大小，库里按别的排序规则排会漏行或重复
    case 'text': return typeof v === 'string' && TEXT_KEY.test(v);
    case 'self': return v === userId;
  }
}

/** 请求里带来的游标：null = 第一片；undefined = 不对（回 bad_request）。逐项校验，多一个字段也不收 */
export function decodeCursor(raw: unknown, tables: readonly ExportTable[], userId: string, maxBytes: number): ExportCursor | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxBytes || !B64URL.test(raw)) return undefined;
  let v: unknown;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    v = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const ks = Object.keys(o);
  if (ks.some((k) => !['t', 'after', 'n', 'w', 'b', 'r'].includes(k))) return undefined;
  if (!isCount(o.t, tables.length - 1)) return undefined;
  const tbl = tables.at(o.t);
  if (!tbl) return undefined;
  const after = o.after;
  if (after !== null && !keyOk(tbl, after, userId)) return undefined;
  if (!isCount(o.n, tbl.maxRows) || typeof o.w !== 'boolean' || !isCount(o.b, CURSOR_MAX_B)) return undefined;
  if (o.r !== undefined && !isCount(o.r, CURSOR_MAX_R)) return undefined;
  return { t: o.t, after: typeof after === 'string' ? after.toLowerCase() : after, n: o.n, w: o.w, b: o.b, r: o.r };
}

/** 这一页取几行（Q5）：没有平均行宽 → firstPage；平均每行超过 wideRowBytes → max(minPage, pageRawBytes ÷ 平均行宽)；否则 page */
export function pageSize(r: number | undefined, lim: ExportLimits): number {
  if (r === undefined) return lim.firstPage;
  if (r <= lim.wideRowBytes) return lim.page;
  return Math.min(lim.page, Math.max(lim.minPage, Math.floor(lim.pageRawBytes / r)));
}

/** 内存探针读到的一次值（字节）：heap = heapUsed；total = heapUsed + external（这个 isolate 自己的堆和 ArrayBuffer，不用 rss） */
export interface MemSample { heap: number; total: number }

/** 开着的探针：读数函数 + 这个 worker 的随机标识 w（模块加载时生成一次；按 w 分段验收，0.47 第 21 条） */
export interface MemProbe { read: () => MemSample; w: string }

/**
 * worker 标识（安全审查）：12 位十六进制，取 crypto.randomUUID() 去掉横线的前 12 位（v4 的这 12 位全是随机数，版本位在第 13 位）。
 * 不由 pid、主机名、环境变量、时间戳、user_id 推出；只在探针打开时生成，只出现在 export_mem_* 两行日志里
 */
export function newWorkerId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

/**
 * 内存探针开不开（架构 0.47 第 21 条；安全审查 K1）：EXPORT_MEM_PROBE=1 且 envKind 判定为本机，两个条件都满足才开；
 * 线上（预览、正式、拿不准）误设了只记一次 mem_probe_ignored（index.ts 在模块加载时调一次）。read 由 index.ts 传 Deno.memoryUsage 的包装。
 * 开的时候才生成 worker 标识（newId 只给测试换）；不开不生成
 */
export function memProbeFor(flag: string | undefined, supabaseUrl: string | undefined, read: () => MemSample, log?: (code: string) => void,
  newId: () => string = newWorkerId): MemProbe | undefined {
  if (flag !== '1') return undefined;
  if (envKind(supabaseUrl) !== 'local') {
    log?.('mem_probe_ignored');
    return undefined;
  }
  return { read, w: newId() };
}

const MB = 1024 * 1024;

/** 一片的 gzip：原文按块进 CompressionStream（每攒满 1 MB 写一次），压缩后的块收进数组；整片是一个 gzip 成员 */
class GzipPart {
  raw = 0;
  private pending: Uint8Array[] = [];
  private pendingLen = 0;
  private readonly writer: ReturnType<CompressionStream['writable']['getWriter']>;
  private readonly chunks: Promise<Uint8Array[]>;

  constructor() {
    const cs = new CompressionStream('gzip');
    this.writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    this.chunks = (async () => {
      const out: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return out;
        out.push(value);
      }
    })();
    this.chunks.catch(() => {});   // abort 时读端也报错，这里不算未处理
  }

  /** 记一段原文，返回它的字节数 */
  add(text: string): number {
    const b = ENC.encode(text);
    this.pending.push(b);
    this.pendingLen += b.byteLength;
    this.raw += b.byteLength;
    return b.byteLength;
  }

  async flushIfBig(): Promise<void> {
    if (this.pendingLen >= FLUSH_BYTES) await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.pendingLen) return;
    const one = concat(this.pending, this.pendingLen);
    this.pending = [];
    this.pendingLen = 0;
    await this.writer.write(one);
  }

  /** 收尾：交出压好的各块和字节合计；不再拼成一整块（0.47 第 21 条：压缩结果只留一份） */
  async close(): Promise<{ chunks: Uint8Array[]; bytes: number }> {
    await this.flush();
    await this.writer.close();
    const chunks = await this.chunks;
    return { chunks, bytes: chunks.reduce((n, p) => n + p.byteLength, 0) };
  }

  abort(): void {
    this.writer.abort().catch(() => {});
  }
}

/** 把压好的块按顺序发出去（ReadableStream.from 在 Workers 类型里没有，手写同样的效果；数组本身不改） */
export function chunksStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      const x = chunks.at(i);
      i += 1;
      if (x) c.enqueue(x); else c.close();
    },
    // 客户端中途断开：不再往下发（代码审查）
    cancel() { i = chunks.length; },
  });
}

function concat(parts: readonly Uint8Array[], len: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

const rowKey = (t: ExportTable, r: Record<string, unknown>): unknown => (t.keyCol === 'user_id' ? r.user_id : r.id);   // 不用方括号取列（check_backend F7）

interface PartOut { chunks: Uint8Array[]; gzBytes: number; raw: number; next: ExportCursor | 'done'; mem?: { peak: number; start: number; w: string } | undefined }

/** 探针的峰值记录（没开探针时全是空操作） */
class MemPeak {
  peak = 0;
  start = 0;
  private readonly probe: MemProbe | undefined;
  constructor(probe: MemProbe | undefined) {
    this.probe = probe;
    if (probe) { const m = probe.read(); this.start = m.heap; this.peak = m.total; }
  }
  sample(): void { if (this.probe) this.peak = Math.max(this.peak, this.probe.read().total); }
  result(): { peak: number; start: number; w: string } | undefined {
    this.sample();
    return this.probe ? { peak: this.peak, start: this.start, w: this.probe.w } : undefined;
  }
}

/**
 * 写一片：第一片先写文件头；从游标处按主键翻页读，每写一行查一次本片原文预算，到了就在这一行后面收尾（单片原文 ≤ 预算 + 一行）。
 * 读到别人的行、主键不前进、超过表的行数上限、认不出的隐私记写法抛 ExportError
 */
export async function buildPart(deps: Deps, userId: string, mode: VaultMode, cur: ExportCursor | null, startedAtMs: number, lim: ExportLimits): Promise<PartOut> {
  const tables = deps.exportTables;
  const sink = new GzipPart();
  const mem = new MemPeak(deps.memProbe);
  /** 收尾前、返回前各采一次探针 */
  const finish = async (next: ExportCursor | 'done'): Promise<PartOut> => {
    mem.sample();
    const { chunks, bytes } = await sink.close();
    return { chunks, gzBytes: bytes, raw: sink.raw, next, mem: mem.result() };
  };
  try {
    const b0 = cur?.b ?? 0;
    let { t, after, n, w, r } = cur ?? { t: 0, after: null, n: 0, w: false, r: undefined };
    if (cur === null) {
      const head = { format: 'lemomemo-export', version: 1, exported_at: new Date(startedAtMs).toISOString(), user_id: userId, vault: mode };
      sink.add(`${JSON.stringify(head).slice(0, -1)},"tables":{`);
      const first = tables[0];
      if (first) sink.add(`${JSON.stringify(first.name)}:[`);
    }
    for (;;) {
      const tbl = tables.at(t);
      if (!tbl) {   // 没有表了（只在清单为空时走到）
        sink.add('}}');
        return await finish('done');
      }
      const size = pageSize(r, lim);
      const page = await deps.store.readPage(tbl.name, tbl.keyCol, userId, after, size);
      let pageRaw = 0;
      let seen = 0;
      for (const row of page) {
        if (row.user_id !== userId) throw new ExportError('foreign_row');   // service role 绕过 RLS：读到别人的行就整片失败
        const key = rowKey(tbl, row);
        if (!keyOk(tbl, key, userId) || (after !== null && !(key > after))) throw new ExportError('bad_page_key');   // 主键不前进不翻，免得死循环
        n += 1;
        if (n > tbl.maxRows) throw new ExportError('too_many_rows');
        const out = exportRows(tbl, [row], mode)[0];
        // 平均行宽按读到的行算（没写进包的隐私记行也要解析，一样花 CPU）
        pageRaw += out ? sink.add((w ? ',' : '') + JSON.stringify(out)) : ENC.encode(JSON.stringify(row)).byteLength;   // 行宽一律按 UTF-8 字节
        if (out) w = true;
        after = typeof key === 'string' ? key.toLowerCase() : key;
        seen += 1;
        if (sink.raw >= lim.partRawBytes) {
          const rr = Math.min(CURSOR_MAX_R, Math.round(pageRaw / seen));
          const o = await finish({ t, after, n, w, b: b0, r: rr });
          if (o.next !== 'done') o.next.b = b0 + o.gzBytes;
          return o;
        }
        await sink.flushIfBig();   // 每攒满 1 MB 就写进压缩流，不等整页写完（0.47 第 21 条）
      }
      mem.sample();   // 每写完一页采一次
      const pageLen = page.length;
      page.length = 0;   // 这一页处理完就放掉对行对象的引用
      if (pageLen) r = Math.min(CURSOR_MAX_R, Math.round(pageRaw / pageLen));
      if (pageLen < size) {   // 这张表读完：收尾，换下一张（r 清空，下一张第一页按 firstPage 取）
        sink.add(']');
        t += 1;
        const nx = tables.at(t);
        if (!nx) {
          sink.add('}}');
          return await finish('done');
        }
        sink.add(`,${JSON.stringify(nx.name)}:[`);
        after = null; n = 0; w = false; r = undefined;
        if (sink.raw >= lim.partRawBytes) {   // 换表那几个字节正好到了预算：在新表开头收尾（游标仍守“开头已写”的约定）
          const o = await finish({ t, after, n, w, b: b0 });
          if (o.next !== 'done') o.next.b = b0 + o.gzBytes;
          return o;
        }
      }
    }
  } catch (e) {
    sink.abort();
    throw e;
  }
}

export async function partExport(req: Request, body: Record<string, unknown>, user: ActiveUser, deps: Deps): Promise<Response> {
  const { store } = deps;
  const lim = exportLimits(deps);
  // ① 先扣每人每天分片总数：在解析游标和读任何数据之前，之后的坏游标、410、413 都算在里面（M2）
  if (!(await store.takeRate(keys.exportPart(user.userId, deps.now()), lim.partDailyLimit, DAY_S))) return err(429, 'rate_limited');
  // ② export_id、游标
  const exportId = typeof body.export_id === 'string' && UUID.test(body.export_id) ? body.export_id.toLowerCase() : null;
  if (exportId === null || !Object.hasOwn(body, 'cursor')) return err(400, 'bad_request');
  const cur = decodeCursor(body.cursor, deps.exportTables, user.userId, lim.cursorMaxBytes);
  if (cur === undefined) return err(400, 'bad_request');
  // ③ 模式（cipher 时令牌必须有效）
  const mode = await vaultMode(req, user, deps);
  if (mode instanceof Response) return mode;
  // ④ 任务：本次请求 JWT 的会话（M3）；别的会话、别的用户、模式不一致、过期都是 410
  const take = await store.exportJobTake(user.userId, exportId, mode, user.sessionId, lim.maxParts, lim.jobTtlS);
  if (take.verdict === 'expired') return err(410, 'export_expired');
  if (take.verdict === 'too_many') return err(413, 'export_too_large');
  const startedAt = take.startedAt === null ? Number.NaN : Date.parse(take.startedAt);
  if (!Number.isFinite(startedAt)) throw new Error('bad_job_take');
  // ⑤ 取片的前提是发起已记录在案（0.47 第 22 条 T2）：start 里建任务那句超时、次数已退回，但语句晚到提交了，任务行在、logs 没有记录——
  //   这种任务不能取片。每片都查（游标是客户端带的，只查第一片可以被跳过）；回应和别的 410 一字不差，不泄露任务存在
  if (!(await store.exportStarted(user.userId, exportId))) return err(410, 'export_expired');
  // ⑥ 读、写、压缩
  let out: PartOut;
  try {
    out = await buildPart(deps, user.userId, mode, cur, startedAt, lim);
  } catch (e) {
    if (!(e instanceof ExportError)) throw e;   // 数据库出错：core.ts 记 db_error、回 try_later
    deps.log?.(`export_${e.message}`);          // 数据导致的：只记我们自己的码，对外不细分
    return err(503, 'try_later');
  }
  const next = out.next === 'done' ? 'done' : encodeCursor(out.next);
  if (next.length > lim.cursorMaxBytes) {
    deps.log?.('export_cursor_too_long');
    return err(503, 'try_later');
  }
  // ⑦ 最后一片：记 export_done（片数取自任务行；字节 = 之前各片 + 这一片）；写不进只记错误码，数据照常回。
  //   同一个最后游标重复请求（回应丢了、客户端重试）只记第一次（代码审查 E1）；查不了就照写（宁可多一条，不让“最近的导出”误标未完成）
  if (out.next === 'done') {
    const logged = await store.exportDoneLogged(user.userId, exportId).catch(() => { deps.log?.('export_done_check_failed'); return false; });
    if (!logged) {
      const bytes = (cur?.b ?? 0) + out.gzBytes;
      await store.insertLog(user.userId, {
        t: deps.now(), device: null, kind: 'run', act: 'export_done', src: 'account', code: exportId,
        fields: [`parts=${take.parts ?? 0}`, `bytes=${bytes}`],
      }).catch(() => deps.log?.('export_done_log_failed'));
    }
  }
  // 探针（只在本机开）：只打峰值整数 MB、片序号和随机 worker 标识 w，不带 user_id、export_id、表名、行数（安全审查 K1）
  if (out.mem) {
    deps.log?.(`export_mem_peak mb=${Math.ceil(out.mem.peak / MB)} part=${take.parts ?? 0} w=${out.mem.w}`);
    deps.log?.(`export_mem_start mb=${Math.round(out.mem.start / MB)} part=${take.parts ?? 0} w=${out.mem.w}`);   // 这一片开始时的 heapUsed（按 w 分段验收）
  }
  // 压好的块原样交出，不拼成一整块（0.47 第 21 条）；Content-Length 用同一个数组求和，求和以后不再改数组（安全审查 K2）
  const { chunks, gzBytes } = out;
  return new Response(chunksStream(chunks), {
    status: 200,
    headers: {
      'content-type': 'application/gzip', 'content-length': String(gzBytes), 'x-content-type-options': 'nosniff',
      [EXPORT_NEXT_HEADER]: next, ...NO_STORE,
    },
  });
}
