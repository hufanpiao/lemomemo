// 按主键一页页读一个人的表时共用的几样（B7a 复审“重复和简化”）：backup-daily（每日备份，写成按表的文件）和
// account 的 export part（账号导出，写成一个流）原来各写一份 keyOk、pageSize、一次压缩，规则一样、字数一样，只差几个名字。
// 这里只放两边一模一样的“这一行的主键对不对、往前走了没有”“这一页取几行”“压成一个 gzip 成员”；
// 读哪几张表、读到的行怎么写（按表一个文件还是一整个流、隐私记怎么脱敏）、预算到了怎么收尾，两边不一样，留在各自的 core 里。
// 不 import npm 包、不碰 Deno 全局，Vitest 直接测（tests/functions/table-pager.test.ts）。

/** 主键的类型：uuid、整数、文本（每人一次读完的小表）、self（每人一行，主键就是 user_id） */
export type PageKeyType = 'uuid' | 'int' | 'text' | 'self';

const UUID_CI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 主键值按这张表主键的类型收窄（账号导出安全审查 S1）：uuid 只收 uuid（大小写都认），整数只收安全整数，
 * 文本只收 textKey（两边的文本主键字符集不同，由调用方给），self 只能是本人。
 */
export function keyOk(keyType: PageKeyType, v: unknown, userId: string, textKey: RegExp): v is string | number {
  switch (keyType) {
    case 'uuid': return typeof v === 'string' && UUID_CI.test(v);
    case 'int': return typeof v === 'number' && Number.isSafeInteger(v);
    case 'text': return typeof v === 'string' && textKey.test(v);
    case 'self': return v === userId;
  }
}

/**
 * 读到的一行的主键：类型对、而且比上一行（after）大，才回它（uuid 统一成小写，游标和下一页都用它）；
 * 不对回 undefined，调用方抛自己的 bad_page_key——主键不前进不翻，免得死循环。after 为 null（这张表第一行，或每人一次读完的表）不比。
 */
export function nextKey(keyType: PageKeyType, key: unknown, after: string | number | null, userId: string, textKey: RegExp): string | number | undefined {
  if (!keyOk(keyType, key, userId, textKey)) return undefined;
  const k = typeof key === 'string' && keyType === 'uuid' ? key.toLowerCase() : key;
  if (after !== null && !(k > after)) return undefined;
  return k;
}

/** 一页取几行的几个数（backup-daily 的 BACKUP_LIMITS、account 的 exportLimits 都带这五项） */
export interface PageLimits { firstPage: number; page: number; minPage: number; wideRowBytes: number; pageRawBytes: number }

/** 这一页取几行（账号导出 Q5）：没有平均行宽 → firstPage；平均每行超过 wideRowBytes → max(minPage, pageRawBytes ÷ 平均行宽)；否则 page */
export function pageSize(avg: number | undefined, lim: PageLimits): number {
  if (avg === undefined) return lim.firstPage;
  if (avg <= lim.wideRowBytes) return lim.page;
  return Math.min(lim.page, Math.max(lim.minPage, Math.floor(lim.pageRawBytes / avg)));
}

const ENC = new TextEncoder();
const FLUSH_BYTES = 1024 * 1024;

/** 几段字节拼成一块 */
export function concatBytes(parts: readonly Uint8Array[], len = parts.reduce((n, p) => n + p.byteLength, 0)): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/**
 * 一个 gzip 成员：原文按块进 CompressionStream（攒满 1 MB 写一次），压缩后的块收进数组。
 * 账号导出边读边压（0.47 第 21 条：不攒整片原文）；每日备份一张表一个文件，也用它压（gzipAll）。仓库里压 gzip 只有这一处。
 */
export class GzipSink {
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

  /** 记一段原文（字符串按 UTF-8），返回它的字节数 */
  add(text: string): number {
    return this.addBytes(ENC.encode(text));
  }

  addBytes(b: Uint8Array): number {
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
    const one = concatBytes(this.pending, this.pendingLen);
    this.pending = [];
    this.pendingLen = 0;
    await this.writer.write(one);
  }

  /** 收尾：交出压好的各块和字节合计（不拼成一整块，压缩结果只留一份） */
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

/** 几段原文一次压成一个 gzip 成员（每日备份的数据文件、_manifest、_running） */
export async function gzipAll(parts: readonly Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  const g = new GzipSink();
  for (const p of parts) g.addBytes(p);
  const { chunks, bytes } = await g.close();
  return concatBytes(chunks, bytes);
}
