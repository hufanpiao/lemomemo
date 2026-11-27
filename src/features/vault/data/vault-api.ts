// 调 vault、vault-image、vault-file 三个函数（vault-file 是隐私记的文档附件）
// • 经 platform/http 的 appFetch 直接调 <supabaseUrl>/functions/v1/<fn>（/sb 转发）：自己带 apikey、这次会话的 access token、
//   x-vault-token（有才带）。appFetch 统一加 X-App-Version、收到 426 时通知全局（core/upgrade.ts 出横幅）
// • 请求体按 shared/schema/vault.ts 的 vaultRequest 写（类型管着）；成功响应按各自的 schema 校验，读不懂当 unknown
// • 错误只认 {error, left?, retry_after_s?}：隐私记码（vaultErrorCode）、入口共用码（session_revoked、unauthorized → session_revoked；
//   upgrade_required；bad_request / method_not_allowed → bad_request；misconfigured → unknown）；没有码按 HTTP 状态（shared/core/http-kind.ts：
//   401 → session_revoked、426 → upgrade_required、429 → rate_limited、408 和 5xx → try_later）。断网（NetworkUnreadableError）→ offline；
//   20 秒（图片 60 秒）超时 → try_later，超时算到包体读完（platform/fn-call.ts 的 fnRequest）
// • vault-image：get 回图片字节（不夹 JSON、不续期令牌）；upload 是原始 webp 字节，参数在查询串
// • vault-file（shared/schema/vault-file.ts）：只验令牌、不续期（同 vault-image）；upload 是 multipart（不自己写 Content-Type，交给浏览器带 boundary）；
//   get 回解密后的字节；错误码里隐私记共有的（vault_locked、not_found 等）照 vaultErrorCode 落，附件自己的（exists、rejected、quota_exceeded、corrupt）
//   放在 fileCode（rejected 带 reason）、code 记 unknown；ms_preview_end 在上锁、页面隐藏时用 keepalive 发：
//   access token 同步读本机会话（platform/session.ts 的 readSessionAccessToken），当场发出，不先 await getSession（页面马上没了就来不及）；
//   读不到才退回 getSession。服务器这一支只验 JWT，隐私记令牌有才带；回成没成，没成由会话记下、解锁后补发
// • 不碰 core/cache、outbox、log：明文不落本机库、不进日志
import type { z } from 'zod';
import { isEntryErrorCode } from '../../../../shared/schema/entry-codes.ts';
import { vaultErrorBody, vaultErrorCode, type VaultImageUploadQuery, type VaultRequest } from '../../../../shared/schema/vault.ts';
import { VAULT_FILE_FN, vaultFileErrorBody, vaultFileErrorCode, type VaultFileRequest } from '../../../../shared/schema/vault-file.ts';
import type { RejectReason } from '../../../../shared/schema/attachments.ts';
import { httpKind } from '../../../../shared/core/http-kind.ts';
import { VAULT_TOKEN_HEADER } from '../../../core/vault-token.ts';
import { buildInfo } from '../../../platform/env.ts';
import { fnRequest, readJson } from '../../../platform/fn-call.ts';
import { appFetch } from '../../../platform/http.ts';
import { readSessionAccessToken } from '../../../platform/session.ts';
import type { Db } from '../../../platform/supabase/client.ts';
import { unhandled, type VaultCode } from './vault-errors.ts';

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
  /** ms_preview_end：同步发出 keepalive（上锁、页面隐藏时页面可能马上没了）；token 是隐私记令牌，没有传 null（服务器只验 JWT）；回成没成 */
  fileEnd(token: string | null): Promise<boolean>;
}

export interface VaultApiOptions {
  fetch?: typeof appFetch;
  base?: string;
  anonKey?: string;
  timeoutMs?: number;
  imageTimeoutMs?: number;
  fileTimeoutMs?: number;
  /** 同步读 access token（测试注入）；默认读本机会话 */
  readAccessToken?: () => string | null;
}

/** vault-file 的失败响应 → 码：附件自己的码放 fileCode（导出给测试） */
export function fileFailOf(status: number, body: unknown): VaultFail {
  const p = vaultFileErrorBody.safeParse(body);
  // 附件自己的码 = vault-file 的码表（shared/schema/vault-file.ts）里、既不在隐私记码表、也不是入口共用码（bad_request 等照 failOf 落）的：
  //   exists、rejected、quota_exceeded、corrupt
  if (p.success && vaultFileErrorCode.safeParse(p.data.error).success && !vaultErrorCode.safeParse(p.data.error).success && !isEntryErrorCode(p.data.error)) {
    return { ok: false, code: 'unknown', fileCode: p.data.error, ...(p.data.reason ? { reason: p.data.reason } : {}) };
  }
  return failOf(status, body);
}

/**
 * 失败响应 → 码（导出给测试）。错误体只认 {error}（另一种 {code, min} 只有版本门的 426 回，按状态码认）；
 * 没有码按状态码，口径同全仓（shared/core/http-kind.ts；429、408 不能落成 unknown，否则后台队列当失败不重试）
 */
export function failOf(status: number, body: unknown): VaultFail {
  const p = vaultErrorBody.safeParse(body);
  const raw: unknown = p.success ? p.data.error : undefined;
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
  switch (httpKind(status)) {
    case 'upgrade':
      return { ok: false, code: 'upgrade_required' };
    case 'auth':
      return { ok: false, code: 'session_revoked' };
    case 'rate_limited':
      return { ok: false, code: 'rate_limited' };
    case 'try_later':
      return { ok: false, code: 'try_later' };
    default:
      return { ok: false, code: 'unknown' };
  }
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

  /** 401 时换一次登录令牌；换不到返回 null（sendFn 就不再重发，按原来的 401 归类） */
  async function refreshToken(): Promise<string | null> {
    const db = await getDb();
    const { data, error } = await db.auth.refreshSession();
    return error ? null : (data.session?.access_token ?? null);
  }

  async function send<T>(
    path: string,
    init: { body: BodyInit; type: string | null; token: string | null; fail?: typeof failOf },
    timeoutMs: number,
    read: (res: Response) => Promise<T>,
  ): Promise<VaultResult<T>> {
    const at = await accessToken();
    if (typeof at !== 'string') return at;
    const headers: Record<string, string> = {};
    if (init.type !== null) headers['content-type'] = init.type;
    if (init.token) headers[VAULT_TOKEN_HEADER] = init.token;
    // 走 platform 的 fnRequest（取令牌、超时、发送、读包体全仓一份）：401 先换一次登录令牌再发（令牌刚好过期、本机时钟偏时
    // 不能当成“会话被吊销”，否则 session 上锁、后台队列 dropAll 丢掉还没发出的隐私记改动）
    const r = await fnRequest(path, { headers, body: init.body }, {
      timeoutMs, read, fetch: doFetch, url: `${base}/${path}`, anonKey, token: () => Promise.resolve(at), refresh: refreshToken,
    });
    if (r.ok) return { ok: true, value: r.value };
    switch (r.code) {
      case 'http':
        return (init.fail ?? failOf)(r.status, r.body);
      case 'no_session':
        return { ok: false, code: 'signed_out' };
      case 'timeout':
        return { ok: false, code: 'try_later' };
      case 'network':
        return { ok: false, code: 'offline' };
      default:
        return unhandled(r);
    }
  }

  /** vault、vault-file 的 JSON 动作：发 JSON、成功按 schema 校验（读不懂当 unknown）；call、fileCall 共用 */
  async function jsonCall<S extends z.ZodType>(fn: string, req: unknown, token: string | null, schema: S, fail?: typeof failOf): Promise<VaultResult<z.infer<S>>> {
    const r = await send(fn, { body: JSON.stringify(req), type: 'application/json', token, ...(fail ? { fail } : {}) }, o.timeoutMs ?? VAULT_TIMEOUT_MS, readJson);
    if (!r.ok) return r;
    const p = schema.safeParse(r.value);
    return p.success ? { ok: true, value: p.data } : { ok: false, code: 'unknown' };
  }

  return {
    call: (req, token, schema) => jsonCall(VAULT_FN, req, token, schema),

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

    fileCall: (req, token, schema) => jsonCall(VAULT_FILE_FN, req, token, schema, fileFailOf),

    fileGet(id, part, token) {
      return send(
        VAULT_FILE_FN,
        { body: JSON.stringify({ action: 'get', id, part } satisfies VaultFileRequest), type: 'application/json', token, fail: fileFailOf },
        o.fileTimeoutMs ?? VAULT_FILE_TIMEOUT_MS,
        (res) => res.blob(),
      );
    },

    fileUpload(form, token) {
      return send(VAULT_FILE_FN, { body: form, type: null, token, fail: fileFailOf }, o.fileTimeoutMs ?? VAULT_FILE_TIMEOUT_MS, readJson);
    },

    fileEnd(token) {
      const body = JSON.stringify({ action: 'ms_preview_end' } satisfies VaultFileRequest);
      const post = (at: string): Promise<boolean> => {
        const headers: Record<string, string> = { authorization: `Bearer ${at}`, apikey: anonKey, 'content-type': 'application/json' };
        if (token) headers[VAULT_TOKEN_HEADER] = token;
        return doFetch(`${base}/${VAULT_FILE_FN}`, { method: 'POST', headers, body, keepalive: true, cache: 'no-store' }).then((r) => r.ok, () => false);
      };
      const at = (o.readAccessToken ?? readSessionAccessToken)();
      return at ? post(at) : accessToken().then((a) => (typeof a === 'string' ? post(a) : false));
    },
  };
}
