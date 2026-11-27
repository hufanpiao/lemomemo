// 调 file-check：带 JWT、apikey、X-App-Version，20 秒超时，经 platform/fn-call.ts 的 fnRequest
// （不要在这里自己写一套取令牌、超时、发送：401 不换令牌的话，令牌刚好过期就落成 account、走“被移除”）。两种客户端调用共用 call()：
// • fileCheck：{action: check, id}，回 FileCheckRes
// • retryAiCall：{action: retry_ai, kind: image, id}（识图“重新识别”），回改完以后的 ai_status
// 失败的分类两种一样：（ok / rejected / incomplete）或失败类：retry（网络、超时、5xx、408、限流）、gone（404：行不是本人的、已删）、
//   account（换过令牌还是 401、403、会话被吊销、账号停用）、upgrade（426）。状态码口径同全仓（shared/core/http-kind.ts）。纯 TS：不准 import React
import type { z } from 'zod';
import { httpKind } from '../../../../shared/core/http-kind.ts';
import { FILE_CHECK_FN, fileCheckRes, retryAiRes, type FileCheckRes, type RetryAiRes } from '../../../../shared/schema/attachments.ts';
import { buildInfo } from '../../../platform/env.ts';
import { sessionToken } from '../../../platform/files.ts';
import { fnRequest } from '../../../platform/fn-call.ts';
import { appFetch } from '../../../platform/http.ts';

export type CheckFail = { ok: false; kind: 'retry' | 'gone' | 'account' | 'upgrade'; code: string };
export type CheckResult = ({ ok: true } & FileCheckRes) | CheckFail;
export type RetryAiResult = ({ ok: true } & RetryAiRes) | CheckFail;

export const CHECK_TIMEOUT_MS = 20_000;

export interface CheckDeps {
  accessToken(): Promise<string | null>;
  /** 401 时换一次令牌；不给用 platform/fn-send.ts 默认的（supabase-js 的 refreshSession） */
  refresh?(): Promise<string | null>;
  fetch: typeof appFetch;
  base: string;
  anonKey: string;
}

export const defaultCheckDeps = (): CheckDeps => ({
  accessToken: sessionToken,
  fetch: appFetch,
  base: `${buildInfo.supabaseUrl}/functions/v1`,
  anonKey: buildInfo.anonKey,
});

const ACCOUNT = new Set(['session_revoked', 'account_disabled', 'account_pending_deletion', 'unauthorized']);

export const fileCheck = (id: string, d: CheckDeps = defaultCheckDeps()): Promise<CheckResult> => call({ action: 'check', id }, fileCheckRes, d);
export const retryAiCall = (id: string, d: CheckDeps = defaultCheckDeps()): Promise<RetryAiResult> =>
  call({ action: 'retry_ai', kind: 'image', id }, retryAiRes, d);

async function call<T extends object>(req: object, schema: z.ZodType<T>, d: CheckDeps): Promise<({ ok: true } & T) | CheckFail> {
  // 令牌先在这里取：取不到才是 account / no_session；取令牌本身出错照旧往上抛，不落成 account
  const at = await d.accessToken();
  if (!at) return { ok: false, kind: 'account', code: 'no_session' };
  const r = await fnRequest(FILE_CHECK_FN, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }, {
    timeoutMs: CHECK_TIMEOUT_MS, fetch: d.fetch, url: `${d.base}/${FILE_CHECK_FN}`, anonKey: d.anonKey, token: () => Promise.resolve(at),
    ...(d.refresh ? { refresh: d.refresh } : {}),
  });
  if (r.ok) {
    const p = schema.safeParse(r.value);
    return p.success ? { ok: true, ...p.data } : { ok: false, kind: 'retry', code: 'bad_response' };
  }
  if (r.code === 'no_session') return { ok: false, kind: 'account', code: 'no_session' };
  if (r.code !== 'http') return { ok: false, kind: 'retry', code: r.code };
  const code = String((r.body as { error?: unknown } | null)?.error ?? r.status);
  const k = httpKind(r.status);
  if (k === 'upgrade') return { ok: false, kind: 'upgrade', code };
  if (k === 'not_found') return { ok: false, kind: 'gone', code };
  // 403 照旧当账号类（本人不可用；不在这次放宽）
  if (k === 'auth' || r.status === 403 || ACCOUNT.has(code)) return { ok: false, kind: 'account', code };
  return { ok: false, kind: 'retry', code };
}
