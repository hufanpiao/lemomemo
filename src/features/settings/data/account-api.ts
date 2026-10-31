// 设置页调 account 函数（架构第 6 节函数表 account、“account 的错误码”；0.29 续第 93、96、125、126、129、131 条；R-256 ②⑤；
// 0.47 第 4～16 条、0.47 续 ①③ 起导出分片）
// • 导出分两步（0.47 续 ①）：
//   - startExport {action:'export', step:'start', device_id?} → {ok, export_id, exported_at}（扣当天次数、记 logs、发通知，不读数据）。
//     device_id 是本机 meta 键 device 里的设备行 id（通知邮件写设备名用；没有就不带）
//   - takePart {action:'export', step:'part', export_id, cursor}（第一片 cursor 为 null）→ 这一片的 gzip 成员（application/gzip，不带
//     Content-Encoding），下一个游标在响应头 x-lemo-export-next（写完为 done，≤ 512 字节）。各片怎么拼、重试、继续见 export-run.ts
//   回包是二进制：supabase-js 的 functions.invoke 按 content-type 把它当文本读会坏，所以直接经 platform/http 的 appFetch 调
//   <supabaseUrl>/functions/v1/account，自己带 apikey 和这次会话的 access token。B1 不带 x-vault-token（隐私记 B5 才有）
// • delete {action:'delete', confirm}：成功 {ok, purge_after}；回 try_later 时先查 status 再定（0.47 第 22 条 T4，data/deletion-check.ts）
// • 错误只认 {error: <码>}（shared/schema/account.ts 的 ACCOUNT_ERROR_CODES，另加共用的 session_revoked、unauthorized，
//   export_expired、export_too_large 也在这张共享表里）；vault_locked、vault_relock（B5 才会出现）合成 vault_locked，提示先用通用的一句。
//   断网 → offline；超时（start 20 秒、每片 60 秒、delete 20 秒，算到包体读完）→ try_later；
//   546（WORKER_LIMIT）、500、502、504 和读不出码的 5xx 也当 try_later（0.47 第 8 条、续 ③ 第 3 点）
// • 失败一律带上这次请求用的会话的 session_id（sid；同 settings-api，接手清单 K6-sugg4 ①）：会话没了、账号停用、冷静期离开本机时只删它
import { accountErrorCode } from '../../../../shared/schema/account.ts';
import { isEntryErrorCode, type EntryErrorCode } from '../../../../shared/schema/entry-codes.ts';
import { buildInfo } from '../../../platform/env.ts';
import { appFetch } from '../../../platform/http.ts';
import { readSessionId, sessionIdOfToken } from '../../../platform/session.ts';
import type { Db } from '../../../platform/supabase/client.ts';
import { checkDeletion, type DeletionCheck } from './deletion-check.ts';
import { mapSettingsError } from './settings-api.ts';

export type AccountErr =
  | 'revoked'
  | 'signed_out'
  /** 管理员停用：清本机、回登录页提示“已停用” */
  | 'account_disabled'
  /** 注销冷静期：清本机、回登录页提示冷静期（auth.exit.pendingDeletion） */
  | 'pending_deletion'
  | 'offline'
  | 'try_later'
  /** 导出和注销合计每天 3 次 */
  | 'rate_limited'
  | 'confirm_required'
  | 'admin_cannot_delete'
  /** 分片：任务不存在、开始满 1 小时、不是这个会话（410，0.47 第 8、13、15 条） */
  | 'export_expired'
  /** 分片：任务分片数超上限（413，0.47 第 8、14 条） */
  | 'export_too_large'
  /** 2xx 但读不懂：start 没有 export_id、part 没有游标头或超长（接口对不上；分片停下、可以继续） */
  | 'bad_response'
  /** vault_locked、vault_relock（B5 才会出现；分片停下，重新解锁后继续） */
  | 'vault_locked'
  | 'unknown';

export type AccountFailure = { ok: false; error: AccountErr; sid: string | null };
export type AccountResult<T> = { ok: true; value: T } | AccountFailure;

export interface ExportFile {
  blob: Blob;
  name: string;
  /** 包里没有隐私记（没带 vault_token；B1 一律是） */
  vaultOmitted: boolean;
}

/** start 的回应 */
export interface ExportStarted {
  exportId: string;
  /** 服务器的开始时刻（ISO；文件头和“最近的导出”都用它）；没给时为 null */
  exportedAt: string | null;
  /** 发起这次导出的会话：任务绑定它（0.47 第 15 条），换了会话就不能“继续” */
  sid: string | null;
}

/** 一片 */
export interface ExportPart {
  blob: Blob;
  /** 下一个游标；null = 写完了（响应头 x-lemo-export-next 为 done） */
  next: string | null;
  /** content-disposition（只有拼文件名用；跨域读不到时为 null） */
  disposition: string | null;
  /** 响应头 Content-Length（没有、读不出合法的非负整数时为 null）；export-run.ts 拿它核对这一片收全了没有（安全复核 K3） */
  contentLength: number | null;
  /** 响应头 Content-Encoding（没有为 null）。正常不带（服务端按架构 S2 不带）；带了时浏览器会自动解压，收到的字节和 Content-Length 对不上 */
  contentEncoding: string | null;
}

export interface DeletionDone {
  /** ISO 时刻；服务器没给时为 null */
  purgeAfter: string | null;
  /** 发请求用的会话（服务器已吊销它）；离开本机时只删它 */
  sid: string | null;
  /** try_later 后查状态只查到会话已失效、确认不了办没办成（T4 / 安全审查 H1）：离开时提示 deletion_unsure，不说冷静期 */
  unsure?: true;
}

export interface AccountApi {
  startExport(deviceId: string | null): Promise<AccountResult<ExportStarted>>;
  /** sid：start 时的会话；本机会话已经换了就不发请求，直接回 export_expired（服务器也会回 410，省一次每天分片数） */
  takePart(exportId: string, cursor: string | null, sid: string | null): Promise<AccountResult<ExportPart>>;
  requestDeletion(confirm: string): Promise<AccountResult<DeletionDone>>;
}

export const ACCOUNT_FN = 'account';
/** start 不读数据，和 delete 一样 20 秒 */
export const EXPORT_START_TIMEOUT_MS = 20_000;
/** 每片 60 秒（0.47 续 ① 客户端：原来整次 120 秒） */
export const EXPORT_PART_TIMEOUT_MS = 60_000;
export const DELETE_TIMEOUT_MS = 20_000;
export const EXPORT_MIME = 'application/gzip';
export const EXPORT_NEXT_HEADER = 'x-lemo-export-next';
/** 游标上限（EXPORT_CURSOR_MAX_BYTES）：超了服务器回 bad_request，这里先拦 */
export const EXPORT_CURSOR_MAX = 512;

/** 没有码时按 HTTP 状态：546（WORKER_LIMIT）、500、502、503、504 和别的 5xx 都当稍后再试（0.47 续 ③ 第 3 点） */
function byStatus(status: number): AccountErr {
  if (status === 401) return 'revoked';
  if (status >= 500 && status <= 599) return 'try_later';
  return 'unknown';
}

/**
 * 入口共用码（shared/schema/entry-codes.ts）在设置页怎么落：
 * - 会话已吊销、没登录 → revoked（走“被移除”）
 * - 配置错误（500 {error:'misconfigured'}）→ unknown：显示“出错”，不按 500 当稍后再试（和邀请注册、登录页 restore 同口径，10-31 代码审查建议）
 * - null：不在这里认，照旧按 HTTP 状态走（byStatus）
 */
export const ACCOUNT_ENTRY: Readonly<Record<EntryErrorCode, AccountErr | null>> = {
  bad_request: null,
  method_not_allowed: null,
  unauthorized: 'revoked',
  session_revoked: 'revoked',
  upgrade_required: null,
  misconfigured: 'unknown',
};

/** 服务器回的码 → 界面的错误 */
export function mapAccountCode(code: unknown, status: number): AccountErr {
  const entry = isEntryErrorCode(code) ? ACCOUNT_ENTRY[code] : null;
  if (entry) return entry;
  const c = accountErrorCode.safeParse(code);
  if (c.success) {
    switch (c.data) {
      case 'account_disabled':
        return 'account_disabled';
      case 'account_pending_deletion':
        return 'pending_deletion';
      case 'rate_limited':
        return 'rate_limited';
      case 'try_later':
        return 'try_later';
      case 'confirm_required':
        return 'confirm_required';
      case 'admin_cannot_delete':
        return 'admin_cannot_delete';
      case 'vault_locked':
      case 'vault_relock':
        return 'vault_locked';
      case 'export_expired':
      case 'export_too_large':
        return c.data;
      default:
        return 'unknown';   // restore 才有的码
    }
  }
  return byStatus(status);
}

const UTC_DATE = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const QUOTE = String.fromCharCode(34);
const NAME_OK = /^lemomemo-export-\d{4}-\d{2}-\d{2}\.json\.gz$/;

/** 文件名取 content-disposition 的 filename；读不到（跨域没暴露这个头）或不像样时按 UTC 日期自己拼 */
export function exportFileName(disposition: string | null, now: number): string {
  // 去掉引号用 split / join（正则里写引号会让 check_arch 的 A20 把后面几行当成字符串）
  const m = disposition ? /filename=([^;]+)/i.exec(disposition) : null;
  const name = (m?.[1] ?? '').trim().split(QUOTE).join('');
  return NAME_OK.test(name) ? name : `lemomemo-export-${UTC_DATE(now)}.json.gz`;
}

export interface AccountApiOptions {
  fetch?: typeof appFetch;
  url?: string;
  anonKey?: string;
  readSid?: () => string | null;
  exportStartTimeoutMs?: number;
  exportPartTimeoutMs?: number;
  deleteTimeoutMs?: number;
  /** 测试用：换掉注销回 try_later 后的状态核对（默认 deletion-check.ts 的 checkDeletion） */
  checkDeletion?: (sid: string | null) => Promise<DeletionCheck>;
}

export function createAccountApi(getDb: () => Promise<Db>, o: AccountApiOptions = {}): AccountApi {
  const doFetch = o.fetch ?? appFetch;
  const url = o.url ?? `${buildInfo.supabaseUrl}/functions/v1/${ACCOUNT_FN}`;
  const anonKey = o.anonKey ?? buildInfo.anonKey;
  const readSid = o.readSid ?? (() => readSessionId());
  const safeSid = (): string | null => {
    try {
      return readSid();
    } catch {
      return null;
    }
  };

  /**
   * 取这次的会话、发请求；2xx 时用 read 读包体，不是 2xx 时读 {error} 组出失败。
   * 超时从发请求一直算到包体读完（审查建议：拿到响应头以后断流又不断开，blob() 会一直挂着）：到点就 abort 并按 try_later 返回，
   * 不靠 fetch 实现会不会在 abort 时中断读包体（和到点的 Promise 赛跑）
   */
  async function send<T>(
    body: Record<string, unknown>,
    timeoutMs: number,
    read: (res: Response) => Promise<T>,
    /** 给了就核对：这次的会话不是它（换过登录）不发请求，回 export_expired */
    expectSid?: string | null,
  ): Promise<AccountResult<{ data: T; sid: string | null }>> {
    let sid: string | null = null;
    let token: string;
    try {
      const db = await getDb();
      sid = safeSid();
      const { data, error } = await db.auth.getSession();
      if (error) return { ok: false, error: fromSettings(mapSettingsError(error)), sid };
      const s = data.session;
      if (!s) return { ok: false, error: 'signed_out', sid: null };
      token = s.access_token;
      sid = sessionIdOfToken(token);
      if (expectSid != null && sid !== expectSid) return { ok: false, error: 'export_expired', sid };
    } catch (e) {
      return { ok: false, error: fromSettings(mapSettingsError(e)), sid };
    }
    const ac = new AbortController();
    let timedOut = false;
    let expire: (e: unknown) => void = () => undefined;
    const expired = new Promise<never>((_r, rej) => {
      expire = rej;
    });
    expired.catch(() => undefined);
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
      expire(new Error('timeout'));
    }, timeoutMs);
    let gotRes = false;
    try {
      const res = await Promise.race([
        doFetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, apikey: anonKey, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
          cache: 'no-store',
        }),
        expired,
      ]);
      gotRes = true;
      if (res.ok) return { ok: true, value: { data: await Promise.race([read(res), expired]), sid } };
      let code: unknown = null;
      try {
        code = ((await Promise.race([res.json(), expired])) as { error?: unknown } | null)?.error ?? null;
      } catch {
        if (timedOut) return { ok: false, error: 'try_later', sid };
        code = null;
      }
      return { ok: false, error: mapAccountCode(code, res.status), sid };
    } catch (e) {
      if (timedOut) return { ok: false, error: 'try_later', sid };
      // 拿到 2xx 以后读包体断了：按断网
      return { ok: false, error: gotRes ? 'offline' : fromSettings(mapSettingsError(e)), sid };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async startExport(deviceId) {
      const body = { action: 'export', step: 'start', ...(deviceId ? { device_id: deviceId } : {}) };
      const r = await send(body, o.exportStartTimeoutMs ?? EXPORT_START_TIMEOUT_MS, async (res) => {
        try {
          return (await res.json()) as { export_id?: unknown; exported_at?: unknown } | null;
        } catch {
          return null;
        }
      });
      if (!r.ok) return r;
      const j = r.value.data;
      // 2xx 却没有 export_id：次数已经扣了，但拿不到任务，只能按出错处理（对不上接口，回报后端）
      if (typeof j?.export_id !== 'string' || !j.export_id) return { ok: false, error: 'bad_response', sid: r.value.sid };
      return { ok: true, value: { exportId: j.export_id, exportedAt: typeof j.exported_at === 'string' ? j.exported_at : null, sid: r.value.sid } };
    },

    async takePart(exportId, cursor, sid) {
      const r = await send(
        { action: 'export', step: 'part', export_id: exportId, cursor },
        o.exportPartTimeoutMs ?? EXPORT_PART_TIMEOUT_MS,
        async (res) => {
          const raw = await res.blob();
          return {
            raw,
            next: res.headers.get(EXPORT_NEXT_HEADER),
            disposition: res.headers.get('content-disposition'),
            contentLength: lengthOf(res.headers.get('content-length')),
            contentEncoding: res.headers.get('content-encoding'),
          };
        },
        sid,
      );
      if (!r.ok) return r;
      const { raw, next, disposition, contentLength, contentEncoding } = r.value.data;
      // 读不到游标头（跨域没暴露、接口对不上）或超长：这一片不能用，按出错处理，界面给“继续”
      if (!next || next.length > EXPORT_CURSOR_MAX) return { ok: false, error: 'bad_response', sid: r.value.sid };
      return { ok: true, value: { blob: raw, next: next === 'done' ? null : next, disposition, contentLength, contentEncoding } };
    },

    async requestDeletion(confirm) {
      const r = await send({ action: 'delete', confirm }, o.deleteTimeoutMs ?? DELETE_TIMEOUT_MS, async (res) => {
        try {
          const j = (await res.json()) as { purge_after?: unknown } | null;
          return typeof j?.purge_after === 'string' ? j.purge_after : null;
        } catch {
          return null;   // 2xx 已经说明申请成功
        }
      });
      if (r.ok) return { ok: true, value: { purgeAfter: r.value.data, sid: r.value.sid } };
      if (r.error !== 'try_later') return r;
      // 超时或服务器忙：可能其实已经办成，先查真实状态（T4）；冷静期按成功、会话已失效按“确认不了”离开、停用交给停用流程，其余照旧稍后再试
      const c = await (o.checkDeletion ?? ((sid) => checkDeletion(getDb, sid)))(r.sid);
      if (c.kind === 'done') return { ok: true, value: { purgeAfter: c.purgeAfter, sid: r.sid } };
      if (c.kind === 'unsure') return { ok: true, value: { purgeAfter: null, sid: r.sid, unsure: true } };
      if (c.kind === 'disabled') return { ok: false, error: 'account_disabled', sid: r.sid };
      return r;
    },
  };
}

/** Content-Length 头 → 字节数；没有或不是纯十进制非负整数时为 null */
function lengthOf(v: string | null): number | null {
  if (v === null || !/^[0-9]{1,15}$/.test(v.trim())) return null;
  return Number(v.trim());
}

/** settings-api 的错误（取会话、fetch 本身失败时）→ 这里的错误 */
function fromSettings(e: ReturnType<typeof mapSettingsError>): AccountErr {
  switch (e) {
    case 'revoked':
    case 'signed_out':
    case 'account_disabled':
    case 'offline':
    case 'try_later':
      return e;
    default:
      return 'unknown';
  }
}
