// 同步网络一侧的错误码映射和超时（从 sync-transport.ts 拆出来，那份文件回到 300 行以内；sync-transport 原样转出这些名字，引用方不用改）
// • toFailure：supabase-js 的 { error, status } → SendFailure（只认码，服务器原文不带出来）；toSessionCheck：刷新令牌的错误 → SessionCheck
// • timeoutSignal、withTimeout：每个请求 20 秒超时（同步是串行的，挂住的请求不能把后面的都卡住）
import type { SendFailure, SessionCheck } from '../../../shared/schema/sync.ts';

export const REQUEST_TIMEOUT_MS = 20_000;
/** 令牌还剩这么多就先刷新再发（TC-B1-82 ①） */
export const REFRESH_MARGIN_MS = 60_000;

/** 刷新令牌回这些码（code 或 message 里包含）：会话已不在，要查 session_fate 再定（R-382 4.1a；TC-B1-88 ④⑤） */
const CHECK_AUTH_CODES = ['session_not_found', 'refresh_token_not_found'];
/** 403 且 code 或 message 里含这个也要查（TC-B1-88 ⑥） */
const REVOKED_403 = 'session_revoked';
const FETCH_FAILED = /failed to fetch|load failed|networkerror|network request failed|network error|fetcherror|aborterror|timeout/i;
const TOKEN = /^[a-z][a-z0-9_]*$/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** supabase-js 的 { error, status } → SendFailure（单独导出测） */
export function toFailure(error: unknown, status: number | undefined): SendFailure {
  const e = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const msg = str(e['message']).trim();
  const pgCode = str(e['code']);
  const out: SendFailure = {};
  // 带 SQLSTATE 的（如 55P03“lock timeout”）、有 HTTP 状态的都是服务器回的，不是断网（K8 审查必改 7）
  if (status === undefined || status === 0) {
    out.network = true;
    return out;
  }
  out.status = status;
  const code = pgCode === 'upgrade_required' ? pgCode : TOKEN.test(msg) ? msg : pgCode;
  if (code) out.code = code;
  // detail 只放 sqlstate（apply_patch 的 patch_bad_args 把 “sqlstate sqlerrm” 放在 details 里）；服务器原文一律不带出来（0.38 第 62 条）
  const state = /^([0-9A-Z]{5})(\s|$)/.exec(str(e['details']));
  if (state?.[1]) out.detail = state[1];
  if (status === 426 || code === 'upgrade_required') {
    const min = e['min'];
    out.min = typeof min === 'string' && /^\d+\.\d+\.\d+$/.test(min) ? min : null;
  }
  return out;
}

/**
 * auth-js 刷新令牌的错误 → SessionCheck（单独导出测；TC-B1-88，R-382 架构 4.1a 第 1 点 ② 改）：
 * ① 断网 ② 5xx ③ 429（以及 408）→ network（临时故障，不退出）；
 * ④ session_not_found ⑤ refresh_token_not_found（code 或 message 包含）⑥ 403 且含 session_revoked → check（查 session_fate 再定）；
 * ⑦⑧ 别的 4xx（含 refresh_token_already_used、session_expired）→ expired：按登录过期处理（只关库、不清）。
 * 不再有“两次 failed 就算被移除”（auth_refresh_failed，send.ts refreshFlow 已去掉）
 */
export function toSessionCheck(error: unknown): SessionCheck {
  if (!error) return 'ok';
  const e = typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const code = str(e['code']);
  const msg = str(e['message']);
  const name = str(e['name']);
  const status = typeof e['status'] === 'number' ? e['status'] : -1;
  const has = (needle: string): boolean => code.includes(needle) || msg.includes(needle);
  if (CHECK_AUTH_CODES.some(has)) return 'check';
  if (status === 403 && has(REVOKED_403)) return 'check';
  if (status === 0 || name === 'AuthRetryableFetchError' || (status < 0 && FETCH_FAILED.test(msg))) return 'network';
  if (status >= 500 || status === 429 || status === 408) return 'network';
  if (status >= 400) return 'expired';
  return status < 0 ? 'network' : 'expired';   // 没有状态又不认识：按临时故障，不退出
}

/**
 * 请求的超时信号：有 AbortSignal.timeout 用它；没有（旧 Safari）用 AbortController + setTimeout（K8 审查必改 1）。
 * 请求结束时调 clear()，兜底的定时器随之清掉（K8 复审建议 2）
 */
export function timeoutSignal(ms: number = REQUEST_TIMEOUT_MS): { signal: AbortSignal | undefined; clear(): void } {
  const none = (): void => undefined;
  if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as { timeout?: unknown }).timeout === 'function') {
    return { signal: AbortSignal.timeout(ms), clear: none };
  }
  if (typeof AbortController === 'undefined') return { signal: undefined, clear: none };
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

/** 整段最多等 ms，超时或抛错都给 fallback（串行链上不能有永不返回的等待，K8 审查必改 1） */
export function withTimeout<T>(p: PromiseLike<T> | (() => PromiseLike<T>), fallback: T, ms: number = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    let q: PromiseLike<T>;
    try {
      q = typeof p === 'function' ? p() : p;
    } catch {
      clearTimeout(t);
      resolve(fallback);
      return;
    }
    q.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}
