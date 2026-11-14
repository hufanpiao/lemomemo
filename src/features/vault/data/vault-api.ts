// 调 vault、vault-image、vault-file 三个函数（B5 FA-1；架构第 6 节 vault、vault-image、vault-file；0.32 R-214；vault-file 是 B4b-1 隐私记的文档附件）
// • 经 platform/http 的 appFetch 直接调 <supabaseUrl>/functions/v1/<fn>（/sb 转发）：自己带 apikey、这次会话的 access token、
//   x-vault-token（有才带）。appFetch 统一加 X-App-Version、收到 426 时通知全局（core/upgrade.ts 出横幅）
// • 请求体按 shared/schema/vault.ts 的 vaultRequest 写（类型管着）；成功响应按各自的 schema 校验，读不懂当 unknown
// • 错误只认 {error, left?, retry_after_s?}：隐私记码（vaultErrorCode）、入口共用码（session_revoked、unauthorized → session_revoked；
//   upgrade_required；bad_request / method_not_allowed → bad_request；misconfigured → unknown）；没有码按 HTTP 状态（401 → session_revoked、
//   5xx → try_later）。断网（NetworkUnreadableError）→ offline；20 秒（图片 60 秒）超时 → try_later
// • vault-image：get 回图片字节（不夹 JSON、不续期令牌）；upload 是原始 webp 字节，参数在查询串
// • vault-file（shared/schema/vault-file.ts）：只验令牌、不续期（同 vault-image）；upload 是 multipart（不自己写 Content-Type，交给浏览器带 boundary）；
//   get 回解密后的字节；错误码里隐私记共有的（vault_locked、not_found 等）照 vaultErrorCode 落，附件自己的（exists、rejected、quota_exceeded、corrupt）
//   放在 fileCode（rejected 带 reason）、code 记 unknown；ms_preview_end 在上锁、页面隐藏时用 keepalive 发、不等结果
// • 不碰 core/cache、outbox、log（A18）：明文不落本机库、不进日志
import type { z } from 'zod';
import { isEntryErrorCode } from '../../../../shared/schema/entry-codes.ts';
import { vaultErrorBody, vaultErrorCode, type VaultImageUploadQuery, type VaultRequest } from '../../../../shared/schema/vault.ts';
import { VAULT_FILE_FN, vaultFileErrorBody, type VaultFileRequest } from '../../../../shared/schema/vault-file.ts';
import type { RejectReason } from '../../../../shared/schema/attachments.ts';
import { VAULT_TOKEN_HEADER } from '../../../core/vault-token.ts';
import { buildInfo } from '../../../platform/env.ts';
import { appFetch } from '../../../platform/http.ts';
import type { Db } from '../../../platform/supabase/client.ts';
import type { VaultCode } from './vault-errors.ts';

/** fileCode、reason 只有 vault-file 的失败才有（附件自己的码，隐私记的码表里没有） */
export type VaultFail = { ok: false; code: VaultCode; left?: number; retryAfterS?: number; fileCode?: string; reason?: RejectReason };
export type VaultResult<T> = { ok: true; value: T } | VaultFail;

export const VAULT_FN = 'vault';
export const VAULT_IMAGE_FN = 'vault-image';
export const VAULT_TIMEOUT_MS = 20_000;
export const VAULT_IMAGE_TIMEOUT_MS = 60_000;
/** vault-file 传 10 MB、解密回 10 MB：同普通附件上传的 120 秒 */
export const VAULT_FILE_TIMEOUT_MS = 120_000;

export interface VaultApi {
  call<S extends z.ZodType>(req: VaultRequest, token: string | null, schema: S): Promise<VaultResult<z.infer<S>>>;
  imageGet(imageId: string, part: 'full' | 'thumb', token: string): Promise<VaultResult<Blob>>;
  imageUpload(q: Omit<VaultImageUploadQuery, 'action'>, body: Blob, token: string): Promise<VaultResult<true>>;
  /** vault-file 的 JSON 动作（get、sweep 以外）；成功按 schema 校验 */
  fileCall<S extends z.ZodType>(req: Exclude<VaultFileRequest, { action: 'get' | 'sweep' }>, token: string, schema: S): Promise<VaultResult<z.infer<S>>>;
  fileGet(id: string, part: 'full' | 'thumb', token: string): Promise<VaultResult<Blob>>;
  fileUpload(form: FormData, token: string): Promise<VaultResult<unknown>>;
  /** ms_preview_end：keepalive 发出去就不管（上锁、页面隐藏时页面可能马上没了） */
  fileEnd(token: string): void;
}

export interface VaultApiOptions {
  fetch?: typeof appFetch;
  base?: string;
  anonKey?: string;
  timeoutMs?: number;
  imageTimeoutMs?: number;
  fileTimeoutMs?: number;
}

/** vault-file 的失败响应 → 码：附件自己的码放 fileCode（导出给测试） */
export function fileFailOf(status: number, body: unknown): VaultFail {
  const p = vaultFileErrorBody.safeParse(body);
  if (p.success && !vaultErrorCode.safeParse(p.data.error).success && ['exists', 'rejected', 'quota_exceeded', 'corrupt'].includes(p.data.error)) {
    return { ok: false, code: 'unknown', fileCode: p.data.error, ...(p.data.reason ? { reason: p.data.reason } : {}) };
  }
  return failOf(status, body);
}

/** 失败响应 → 码（导出给测试） */
export function failOf(status: number, body: unknown): VaultFail {
  const p = vaultErrorBody.safeParse(body);
  const raw: unknown = p.success ? p.data.error : (body as { code?: unknown } | null)?.code;
  const extra = p.success
    ? { ...(p.data.left !== undefined ? { left: p.data.left } : {}), ...(p.data.retry_after_s !== undefined ? { retryAfterS: p.data.retry_after_s } : {}) }
    : {};
  const c = vaultErrorCode.safeParse(raw);
  if (c.success) return { ok: false, code: c.data, ...extra };
  if (isEntryErrorCode(raw)) {
    switch (raw) {
      case 'session_revoked':
      case 'unauthorized':
        return { ok: false, code: 'session_revoked' };
      case 'upgrade_required':
        return { ok: false, code: 'upgrade_required' };
      case 'bad_request':
      case 'method_not_allowed':
        return { ok: false, code: 'bad_request' };
      case 'misconfigured':
        return { ok: false, code: 'unknown' };
    }
  }
  if (status === 426) return { ok: false, code: 'upgrade_required' };
  if (status === 401) return { ok: false, code: 'session_revoked' };
  if (status >= 500) return { ok: false, code: 'try_later' };
  return { ok: false, code: 'unknown' };
}

export function createVaultApi(getDb: () => Promise<Db>, o: VaultApiOptions = {}): VaultApi {
  const doFetch = o.fetch ?? appFetch;
  const base = o.base ?? `${buildInfo.supabaseUrl}/functions/v1`;
  const anonKey = o.anonKey ?? buildInfo.anonKey;

  async function accessToken(): Promise<string | VaultFail> {
    try {
      const db = await getDb();
      const { data, error } = await db.auth.getSession();
      if (error || !data.session) return { ok: false, code: 'signed_out' };
      return data.session.access_token;
    } catch {
      return { ok: false, code: 'offline' };
    }
  }

  async function send<T>(
    path: string,
    init: { body: BodyInit; type: string | null; token: string | null; keepalive?: boolean; fail?: typeof failOf },
    timeoutMs: number,
    read: (res: Response) => Promise<T>,
  ): Promise<VaultResult<T>> {
    const at = await accessToken();
    if (typeof at !== 'string') return at;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${at}`, apikey: anonKey };
      if (init.type !== null) headers['content-type'] = init.type;
      if (init.token) headers[VAULT_TOKEN_HEADER] = init.token;
      const res = await doFetch(`${base}/${path}`, { method: 'POST', headers, body: init.body, signal: ac.signal, cache: 'no-store', ...(init.keepalive ? { keepalive: true } : {}) });
      if (!res.ok) {
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        return (init.fail ?? failOf)(res.status, body);
      }
      return { ok: true, value: await read(res) };
    } catch (e) {
      if (ac.signal.aborted) return { ok: false, code: 'try_later' };
      return { ok: false, code: e instanceof TypeError ? 'offline' : 'unknown' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async call(req, token, schema) {
      const r = await send(VAULT_FN, { body: JSON.stringify(req), type: 'application/json', token }, o.timeoutMs ?? VAULT_TIMEOUT_MS, async (res) => {
        try {
          return (await res.json()) as unknown;
        } catch {
          return null;
        }
      });
      if (!r.ok) return r;
      const p = schema.safeParse(r.value);
      return p.success ? { ok: true, value: p.data } : { ok: false, code: 'unknown' };
    },

    imageGet(imageId, part, token) {
      return send(
        VAULT_IMAGE_FN,
        { body: JSON.stringify({ action: 'get', image_id: imageId, part }), type: 'application/json', token },
        o.imageTimeoutMs ?? VAULT_IMAGE_TIMEOUT_MS,
        (res) => res.blob(),
      );
    },

    imageUpload(q, body, token) {
      const qs = new URLSearchParams({ action: 'upload', note_id: q.note_id, image_id: q.image_id, part: q.part });
      return send(`${VAULT_IMAGE_FN}?${qs.toString()}`, { body, type: 'image/webp', token }, o.imageTimeoutMs ?? VAULT_IMAGE_TIMEOUT_MS, async () => true as const);
    },

    async fileCall(req, token, schema) {
      const r = await send(VAULT_FILE_FN, { body: JSON.stringify(req), type: 'application/json', token, fail: fileFailOf }, o.timeoutMs ?? VAULT_TIMEOUT_MS, async (res) => {
        try {
          return (await res.json()) as unknown;
        } catch {
          return null;
        }
      });
      if (!r.ok) return r;
      const p = schema.safeParse(r.value);
      return p.success ? { ok: true, value: p.data } : { ok: false, code: 'unknown' };
    },

    fileGet(id, part, token) {
      return send(
        VAULT_FILE_FN,
        { body: JSON.stringify({ action: 'get', id, part } satisfies VaultFileRequest), type: 'application/json', token, fail: fileFailOf },
        o.fileTimeoutMs ?? VAULT_FILE_TIMEOUT_MS,
        (res) => res.blob(),
      );
    },

    fileUpload(form, token) {
      return send(VAULT_FILE_FN, { body: form, type: null, token, fail: fileFailOf }, o.fileTimeoutMs ?? VAULT_FILE_TIMEOUT_MS, async (res) => {
        try {
          return (await res.json()) as unknown;
        } catch {
          return null;
        }
      });
    },

    fileEnd(token) {
      void send(VAULT_FILE_FN, { body: JSON.stringify({ action: 'ms_preview_end' } satisfies VaultFileRequest), type: 'application/json', token, keepalive: true }, o.timeoutMs ?? VAULT_TIMEOUT_MS, async () => true);
    },
  };
}
