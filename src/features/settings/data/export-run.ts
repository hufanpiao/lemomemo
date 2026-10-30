// 账号导出的分片取回（架构 0.47 第 5、8、15 条，0.47 续 ① 客户端、③ 第 3 点、④ 第 3 点）
// • 一个导出任务（ExportJob）只放内存：export_id、下一个游标、已取回的各片、开始时的会话。不写本机库、不写 localStorage
// • 按游标一片一片取，各片的 gzip 成员按顺序首尾相接（RFC 1952 允许多成员），最后 new Blob(parts) 存成一个 .json.gz
// • 每片失败时：try_later（含 546、5xx、超时）和 offline 自动再试 EXPORT_PART_RETRIES 次（间隔 2 秒、5 秒，0.47 第 8 条、TC-B1-126 ②），
//   还不行就停下、交给界面给“继续 / 取消”。响应读不懂、没有游标头（bad_response）和隐私记令牌过期（vault_locked，B5 重新解锁后继续）
//   不自动再试、直接停下，也可以继续；带明确码的失败（会话没了、过期、超上限、当天分片用完、bad_request、426 等）
//   不再试、不给继续，原样交回（TC-B1-126 ④）。
//   同一个游标重试得到同样的字节（服务器保证），重试和“继续”都不会拼出重复或缺块
// • 每片收完先核对（安全复核 K3）：有 Content-Length 头时收到的字节数必须等于它；开头两个字节是 gzip 魔数 1f 8b、至少 18 字节
//   （gzip 头 10 字节 + 尾 8 字节）。不对就当这一片失败（截断等），不拼进文件，用同一个游标重试，计入同样的 2 次和间隔；
//   重试用完仍不对就停下（bad_response），可以“继续”
// • “继续”只在开始后 EXPORT_RESUME_MS（1 小时，EXPORT_JOB_TTL_S）内、同一个会话里有效；本机先按开始时刻判断，
//   过了就不再请求、直接按 export_expired（服务器同样会回 410）
import type { AccountFailure, AccountApi, AccountResult, ExportFile, ExportPart } from './account-api.ts';
import { EXPORT_MIME, exportFileName } from './account-api.ts';

export const EXPORT_PART_RETRIES = 2;
export const EXPORT_RETRY_DELAYS_MS = [2000, 5000] as const;
export const EXPORT_RESUME_MS = 3600_000;

export interface ExportJob {
  exportId: string;
  exportedAt: string | null;
  /** 发起时的会话（任务绑定它） */
  sid: string | null;
  /** 本机收到 start 回应的时刻（毫秒），判断“1 小时内可以继续” */
  startedAt: number;
  /** 下一片的游标；第一片为 null */
  cursor: string | null;
  parts: Blob[];
  /** 已取回的字节数（gzip） */
  bytes: number;
  /** 第一片的 content-disposition（拼文件名） */
  disposition: string | null;
}

export type RunOutcome =
  | { kind: 'done'; file: ExportFile }
  /** 中途停下（自动重试也没过）：job 是停下时的进度，可以“继续” */
  | { kind: 'paused'; job: ExportJob; failure: AccountFailure }
  /** 不能继续的失败（过期、超上限、当天用完、会话没了等） */
  | { kind: 'failed'; failure: AccountFailure };

export interface RunOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 每取回一片调一次（已取回的字节数） */
  onProgress?: (bytes: number) => void;
  /** 返回 true 时停在下一片之前（页面卸载、用户离开） */
  stopped?: () => boolean;
}

const RETRYABLE = new Set(['try_later', 'offline']);
/** 停下以后还能“继续”的失败：临时故障、读不懂这一片（重试同一游标不吃亏）、隐私记令牌过期（重新解锁后继续） */
const RESUMABLE = new Set(['try_later', 'offline', 'bad_response', 'vault_locked']);

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** gzip 成员最短 18 字节：10 字节头 + 8 字节尾（CRC32、原长） */
export const GZIP_MIN_BYTES = 18;

/**
 * 这一片收全了、像一个 gzip 成员（K3）：长度对得上 Content-Length（有的话）、开头 1f 8b、至少 18 字节。
 * Content-Length 是压缩后的字节数，能和收到的 blob 比，前提是服务端不带 Content-Encoding
 * （见 supabase/functions/account/export-part.ts 返回头；架构 S2）。响应带了 Content-Encoding 时浏览器会自动解压，
 * 收到的是解压后的字节、和 Content-Length 对不上，这时跳过长度比对，只核魔数和最短长度
 */
export async function partLooksWhole(p: Pick<ExportPart, 'blob' | 'contentLength' | 'contentEncoding'>): Promise<boolean> {
  if (p.contentLength !== null && p.contentEncoding === null && p.blob.size !== p.contentLength) return false;
  if (p.blob.size < GZIP_MIN_BYTES) return false;
  try {
    const head = new Uint8Array(await p.blob.slice(0, 2).arrayBuffer());
    return head[0] === 0x1f && head[1] === 0x8b;
  } catch {
    return false;
  }
}

export function newJob(started: { exportId: string; exportedAt: string | null; sid: string | null }, at: number): ExportJob {
  return { ...started, startedAt: at, cursor: null, parts: [], bytes: 0, disposition: null };
}

/** 开始后满 1 小时（含正好 1 小时）就不能再继续 */
export function jobExpired(job: ExportJob, at: number): boolean {
  return at - job.startedAt >= EXPORT_RESUME_MS;
}

/** 从 job 的游标接着取，直到写完、停下或失败。job 不改原对象，进度在返回值里 */
export async function runParts(api: Pick<AccountApi, 'takePart'>, start: ExportJob, o: RunOptions = {}): Promise<RunOutcome> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  let job: ExportJob = { ...start, parts: [...start.parts] };
  for (;;) {
    if (jobExpired(job, now())) return { kind: 'failed', failure: { ok: false, error: 'export_expired', sid: job.sid } };
    const cur = job;
    /** 取一片并核对；retry：值得用同一个游标再试（临时故障、这一片没收全） */
    const take = async (): Promise<{ r: AccountResult<ExportPart>; retry: boolean }> => {
      const got = await api.takePart(cur.exportId, cur.cursor, cur.sid);
      if (!got.ok) return { r: got, retry: RETRYABLE.has(got.error) };
      if (!(await partLooksWhole(got.value))) return { r: { ok: false, error: 'bad_response', sid: cur.sid }, retry: true };
      return { r: got, retry: false };
    };
    let tries = 0;
    let { r, retry } = await take();
    while (!r.ok && retry && tries < EXPORT_PART_RETRIES && !o.stopped?.()) {
      await sleep(EXPORT_RETRY_DELAYS_MS[tries] ?? 5000);
      tries += 1;
      if (jobExpired(job, now())) return { kind: 'failed', failure: { ok: false, error: 'export_expired', sid: job.sid } };
      ({ r, retry } = await take());
    }
    if (!r.ok) return RESUMABLE.has(r.error) ? { kind: 'paused', job, failure: r } : { kind: 'failed', failure: r };
    const p = r.value;
    job = {
      ...job,
      cursor: p.next,
      parts: [...job.parts, p.blob],
      bytes: job.bytes + p.blob.size,
      disposition: job.parts.length === 0 ? p.disposition : job.disposition,
    };
    o.onProgress?.(job.bytes);
    if (p.next === null) {
      const at = job.exportedAt ? Date.parse(job.exportedAt) : NaN;
      const name = exportFileName(job.disposition, Number.isFinite(at) ? at : now());
      return { kind: 'done', file: { blob: new Blob(job.parts, { type: EXPORT_MIME }), name, vaultOmitted: true } };
    }
    if (o.stopped?.()) return { kind: 'paused', job, failure: { ok: false, error: 'offline', sid: job.sid } };
  }
}

/** “已取回 N MB”：按 1024² 算，保留一位小数 */
export function fmtMb(bytes: number): string {
  return (Math.max(0, bytes) / 1048576).toFixed(1);
}
