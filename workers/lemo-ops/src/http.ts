// lemo-ops 对外的三种调用：usage-report、保活查询、Resend 发信。
// 一律直连 https://<ref>.supabase.co，不经 /sb（架构 0.31 第 13 条）；不打印请求头、请求体、响应体（A23），只记错误码。

import type { UnreachableReason } from './rules.ts';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** 调 usage-report 的超时：usage-report 自己 5 秒查不完就回 503，这里多留 5 秒给冷启动和网络 */
export const USAGE_REPORT_TIMEOUT_MS = 10_000;
export const MAIL_TIMEOUT_MS = 10_000;
export const KEEPALIVE_TIMEOUT_MS = 10_000;

export interface OpsConfig {
  supabaseUrl: string;
  anonKey: string;
  opsSecret: string;
  resendKey: string;
  alertTo: string;
  alertFrom: string;
}

export class Timeout extends Error {}

/** fetch 并读完响应体，整体限时；超时中止请求（version.ts 也用） */
export async function fetchText(fetchFn: FetchFn, url: string, init: RequestInit, ms: number): Promise<{ status: number; text: string }> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Timeout());
    }, ms);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchFn(url, { ...init, signal: ctl.signal });
        return { status: res.status, text: await res.text() };
      })(),
      limit,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type CallResult = { ok: true; body: unknown } | { ok: false; reason: UnreachableReason };

/**
 * 401 是谁回的（B2 架构审 D2 ①）：
 * - 网关：返回体里有 UNAUTHORIZED_*（例如 {"code":"UNAUTHORIZED_NO_AUTH_HEADER",…}）——函数根本没收到请求，多半是 usage-report 的
 *   verify_jwt 没关、或 key 不对；
 * - 函数自己：{"error":"unauthorized"}——x-ops-secret 对不上；
 * - 两样都不像：照旧 http_401。
 * 只看返回体里的这两个标记，不把返回体写进邮件或日志（A23）。
 */
export function classify401(text: string, body: unknown): UnreachableReason {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const b = body as { code?: unknown; error?: unknown; message?: unknown };
    for (const v of [b.code, b.error, b.message]) if (typeof v === 'string' && /^UNAUTHORIZED_[A-Z0-9_]*$/.test(v)) return 'gateway_401';
    if (b.error === 'unauthorized') return 'fn_401';
  }
  if (/\bUNAUTHORIZED_[A-Z0-9_]+\b/.test(text)) return 'gateway_401';
  return 'http_401';
}

/**
 * 调 usage-report。非 200、超时、网络错误、返回体不是 JSON 一律算“调不通”（0.29 续第 116 条②）；
 * 503 且 error 是 db_unreachable 的单独标出（邮件写“服务器连不上数据库”）；401 按 classify401 分成网关拒绝和函数拒绝。
 * B2 架构审 D2 做法 ②：usage-report 关了网关的 JWT 校验（verify_jwt = false），只靠 x-ops-secret（函数里常量时间比对），
 * 所以**不再带 anon Bearer**（Authorization 头一律不发），不依赖 anon key 的格式。apikey 头照旧带上（网关不认它也不影响），
 * 待函数和 config.toml 落地后核对：线上不带 apikey 是否同样能到函数，能的话这一行也删掉。
 */
export async function callUsageReport(fetchFn: FetchFn, cfg: OpsConfig, part: 'heartbeat' | 'usage', ms = USAGE_REPORT_TIMEOUT_MS): Promise<CallResult> {
  let r: { status: number; text: string };
  try {
    r = await fetchText(
      fetchFn,
      `${cfg.supabaseUrl}/functions/v1/usage-report`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ops-secret': cfg.opsSecret,
          apikey: cfg.anonKey,
        },
        body: JSON.stringify({ part }),
      },
      ms,
    );
  } catch (e) {
    return { ok: false, reason: e instanceof Timeout ? 'timeout' : 'network' };
  }
  let body: unknown;
  try {
    body = JSON.parse(r.text);
  } catch {
    body = undefined;
  }
  if (r.status === 503 && typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'db_unreachable') {
    return { ok: false, reason: 'db_unreachable' };
  }
  if (r.status === 500 && typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'bad_data') {
    return { ok: false, reason: 'bad_data' };
  }
  if (r.status === 401) return { ok: false, reason: classify401(r.text, body) };
  if (r.status !== 200) return { ok: false, reason: `http_${r.status}` };
  if (body === undefined) return { ok: false, reason: 'bad_body' };
  return { ok: true, body };
}

/** 保活（架构第 6 节 keepalive 一行）：GET app_config 的 min_client_version，真查一次数据库。成功返回 null，失败返回原因 */
export async function keepalive(fetchFn: FetchFn, cfg: OpsConfig, ms = KEEPALIVE_TIMEOUT_MS): Promise<string | null> {
  try {
    const r = await fetchText(
      fetchFn,
      `${cfg.supabaseUrl}/rest/v1/app_config?select=min_client_version`,
      { method: 'GET', headers: { apikey: cfg.anonKey, authorization: `Bearer ${cfg.anonKey}` } },
      ms,
    );
    if (r.status !== 200) return `http_${r.status}`;
    JSON.parse(r.text);
    return null;
  } catch (e) {
    if (e instanceof Timeout) return 'timeout';
    if (e instanceof SyntaxError) return 'bad_body';
    return 'network';
  }
}

/** 发信结果：status 是 Resend 回的 HTTP 码；超时、网络出错没有回应时是 null（R-261 记进 mail-fail:v1 的 last_status，只有这个数字，不读响应体） */
export interface SendOutcome {
  ok: boolean;
  status: number | null;
}

/** 用 Resend 发一封纯文本邮件（RESEND_API_KEY_OPS 只有发信权限）。2xx 算成功 */
export async function sendMail(fetchFn: FetchFn, cfg: OpsConfig, subject: string, text: string, ms = MAIL_TIMEOUT_MS): Promise<SendOutcome> {
  try {
    const r = await fetchText(
      fetchFn,
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.resendKey}` },
        body: JSON.stringify({ from: cfg.alertFrom, to: [cfg.alertTo], subject, text }),
      },
      ms,
    );
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  } catch {
    return { ok: false, status: null };
  }
}
