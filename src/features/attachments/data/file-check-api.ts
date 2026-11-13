// 调 file-check {action: check, id}（架构 5.13 第 2 点 ⑦）：带 JWT、apikey、X-App-Version（appFetch），20 秒超时。
// 回 FileCheckRes（ok / rejected / incomplete）或失败类：retry（网络、超时、5xx、限流）、gone（404：行不是本人的、已删）、
//   account（会话被吊销、账号停用）、upgrade（426）。纯 TS：不准 import React（A1）
import { FILE_CHECK_FN, fileCheckRes, type FileCheckRes } from '../../../../shared/schema/attachments.ts';
import { buildInfo } from '../../../platform/env.ts';
import { sessionToken } from '../../../platform/files.ts';
import { appFetch } from '../../../platform/http.ts';

export type CheckFail = { ok: false; kind: 'retry' | 'gone' | 'account' | 'upgrade'; code: string };
export type CheckResult = ({ ok: true } & FileCheckRes) | CheckFail;

export const CHECK_TIMEOUT_MS = 20_000;

export interface CheckDeps {
  accessToken(): Promise<string | null>;
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

export async function fileCheck(id: string, d: CheckDeps = defaultCheckDeps()): Promise<CheckResult> {
  const at = await d.accessToken();
  if (!at) return { ok: false, kind: 'account', code: 'no_session' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await d.fetch(`${d.base}/${FILE_CHECK_FN}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${at}`, apikey: d.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'check', id }),
      signal: ac.signal,
      cache: 'no-store',
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok) {
      const p = fileCheckRes.safeParse(body);
      return p.success ? { ok: true, ...p.data } : { ok: false, kind: 'retry', code: 'bad_response' };
    }
    const code = String((body as { error?: unknown } | null)?.error ?? res.status);
    if (res.status === 426) return { ok: false, kind: 'upgrade', code };
    if (res.status === 404) return { ok: false, kind: 'gone', code };
    if (res.status === 401 || res.status === 403 || ACCOUNT.has(code)) return { ok: false, kind: 'account', code };
    return { ok: false, kind: 'retry', code };
  } catch {
    return { ok: false, kind: 'retry', code: ac.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
