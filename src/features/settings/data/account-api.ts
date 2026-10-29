// 设置页调 account 函数（架构第 6 节函数表 account、“account 的错误码”；0.29 续第 93、96、125、126、129、131 条；R-256 ②⑤）
// • export {action:'export', device_id}：device_id 是本机 meta 键 device 里的设备行 id（通知邮件写设备名用；没有就不带）。
//   回包是 gzip 的 JSON（content-type application/gzip、content-disposition attachment）。supabase-js 的 functions.invoke
//   按 content-type 把它当文本读，二进制会坏，所以这里直接经 platform/http 的 appFetch 调 <supabaseUrl>/functions/v1/account，
//   自己带 apikey 和这次会话的 access token。B1 不带 x-vault-token（隐私记 B5 才有）：包里一律没有隐私记，界面提示“没有导出（没解锁）”
// • delete {action:'delete', confirm}：成功 {ok, purge_after}
// • 错误只认 {error: <码>}（shared/schema/account.ts 的 ACCOUNT_ERROR_CODES，另加共用的 session_revoked、unauthorized）；
//   vault_locked、vault_relock（B5 才会出现）先当 unknown。断网 → offline；超时（export 120 秒、delete 20 秒，算到包体读完）→ try_later
// • 失败一律带上这次请求用的会话的 session_id（sid；同 settings-api，接手清单 K6-sugg4 ①）：会话没了、账号停用、冷静期离开本机时只删它
import { accountErrorCode } from '../../../../shared/schema/account.ts';
import { buildInfo } from '../../../platform/env.ts';
import { appFetch } from '../../../platform/http.ts';
import { readSessionId, sessionIdOfToken } from '../../../platform/session.ts';
import type { Db } from '../../../platform/supabase/client.ts';
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
  | 'unknown';

export type AccountFailure = { ok: false; error: AccountErr; sid: string | null };
export type AccountResult<T> = { ok: true; value: T } | AccountFailure;

export interface ExportFile {
  blob: Blob;
  name: string;
  /** 包里没有隐私记（没带 vault_token；B1 一律是） */
  vaultOmitted: boolean;
}

export interface DeletionDone {
  /** ISO 时刻；服务器没给时为 null */
  purgeAfter: string | null;
  /** 发请求用的会话（服务器已吊销它）；离开本机时只删它 */
  sid: string | null;
}

export interface AccountApi {
  exportAll(deviceId: string | null): Promise<AccountResult<ExportFile>>;
  requestDeletion(confirm: string): Promise<AccountResult<DeletionDone>>;
}

export const ACCOUNT_FN = 'account';
export const EXPORT_TIMEOUT_MS = 120_000;
export const DELETE_TIMEOUT_MS = 20_000;
export const EXPORT_MIME = 'application/gzip';

/** 服务器回的码 → 界面的错误 */
export function mapAccountCode(code: unknown, status: number): AccountErr {
  if (code === 'session_revoked' || code === 'unauthorized') return 'revoked';
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
      default:
        return 'unknown';   // vault_locked、vault_relock（B5）以及 restore 才有的码
    }
  }
  if (status === 503) return 'try_later';
  if (status === 401) return 'revoked';
  return 'unknown';
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
  now?: () => number;
  exportTimeoutMs?: number;
  deleteTimeoutMs?: number;
}

export function createAccountApi(getDb: () => Promise<Db>, o: AccountApiOptions = {}): AccountApi {
  const doFetch = o.fetch ?? appFetch;
  const url = o.url ?? `${buildInfo.supabaseUrl}/functions/v1/${ACCOUNT_FN}`;
  const anonKey = o.anonKey ?? buildInfo.anonKey;
  const now = o.now ?? Date.now;
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
  async function send<T>(body: Record<string, unknown>, timeoutMs: number, read: (res: Response) => Promise<T>): Promise<AccountResult<{ data: T; sid: string | null }>> {
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
    async exportAll(deviceId) {
      const r = await send({ action: 'export', ...(deviceId ? { device_id: deviceId } : {}) }, o.exportTimeoutMs ?? EXPORT_TIMEOUT_MS, async (res) => {
        const raw = await res.blob();
        const blob = raw.type === EXPORT_MIME ? raw : new Blob([raw], { type: EXPORT_MIME });
        return { blob, name: exportFileName(res.headers.get('content-disposition'), now()), vaultOmitted: true };
      });
      return r.ok ? { ok: true, value: r.value.data } : r;
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
      return r.ok ? { ok: true, value: { purgeAfter: r.value.data, sid: r.value.sid } } : r;
    },
  };
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
