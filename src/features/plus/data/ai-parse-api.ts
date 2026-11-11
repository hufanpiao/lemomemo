// 打字条调 ai-parse（B3 任务单 FA-2、Q2；架构第 6 节 ai-parse 行、第 7 节；supabase/functions/ai-parse/core.ts 的返回）
// • 经 platform/http 的 appFetch 直接 POST <supabaseUrl>/functions/v1/ai-parse：带这次会话的 access token（JWT）、apikey，
//   appFetch 自动带 X-App-Version（函数入口查版本门）；收到 426 时 appFetch 通知 onUpgradeRequired（横幅由 core/upgrade.ts 出）
// • 返回码 → 打字流程（type-flow.ts 的 askAi、outcomeOf）怎么走：
//   - 200：JSON 原样交给 outcomeOf：{intent:'record'} 记下（items 为空 = empty_items，退回本机规则）；{fallback, reason}（feature_off、
//     vault_ai_off、quota、invalid、timeout、error）、{consent_required}、{quota_out} 各自的分支见 type-flow.ts 的 planTyped
//   - 401：先换一次 token（refreshSession）再发一次（B3 前端A代码审 C2：token 刚好在两次调用之间过期，不该出“AI 没回应”）；
//     换不到、换来的和原来一样、再发还是不行：照下一条走
//   - 400 bad_request（含 default_day 不合格）、401 / 403（会话没了、账号停用）、413、426、429 rate_limited（每分钟上限）、
//     500、503 try_later：抛 SendError('http')，不自动重试，用本机规则记下、原话不丢（状态 saved_rule）。
//     会话没了、账号停用由同步（outbox）那边照常处理，这里不主动退出；但 401 时换 token 遇到凭证已被吊销，
//     supabase-js 会清掉本机会话、让用户登出（C2 带来的副作用）。会话本来就已失效，接受（代码审 D1）
//   - 2xx 但不是 JSON：SendError('bad_response')
//   - 断网、读不出原因（appFetch 抛 TypeError）：原样抛出，askAi 认成 network、自动重试 1 次；超时（6 秒）由 askAi 的 signal 取消
//   - 没登录（拿不到会话）：SendError('http')，不发请求
// • 取会话、换 token 也算在 6 秒里：超时取消时不再等它们（supabase-js 可能在等锁），原样抛出取消原因
// • 只在打字条那一块（plus 的懒加载块）里，不进首屏；supabase-js 照旧由 getSupabase() 动态加载
// 纯 TS：不准 import React（A1）
import { buildInfo } from '../../../platform/env.ts';
import { appFetch } from '../../../platform/http.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { SendError, type AiParseReq, type CallAi } from './type-flow.ts';

export const AI_PARSE_FN = 'ai-parse';

export interface AiParseApiOptions {
  fetch?: typeof appFetch;
  url?: string;
  anonKey?: string;
  /** 取这次会话的 access token；没登录返回 null */
  token?: () => Promise<string | null>;
  /** 401 时换一次 token；换不到返回 null */
  refresh?: () => Promise<string | null>;
}

/** 本次会话的 JWT（没登录为 null）；claude-link-api.ts 生成连接码也用 */
export async function sessionToken(): Promise<string | null> {
  const db = await getSupabase();
  const { data, error } = await db.auth.getSession();
  if (error) return null;
  return data.session?.access_token ?? null;
}

async function refreshedToken(): Promise<string | null> {
  const db = await getSupabase();
  const { data, error } = await db.auth.refreshSession();
  if (error) return null;
  return data.session?.access_token ?? null;
}

/** 等 p，但 signal 取消时立刻按取消原因抛出（不再等 p）；p 自己出错当 null */
function tokenOr(p: () => Promise<string | null>, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise((resolve, reject) => {
    const stop = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', stop, { once: true });
    p().then(resolve, () => resolve(null)).finally(() => signal.removeEventListener('abort', stop));
  });
}

/**
 * 带本次会话的令牌 POST 一个函数，返回已 parse 的 JSON（打字的 ai-parse、录音的 ai-voice 共用，口径见文件头）。
 * headers 里放 content-type 和各自的参数头；authorization、apikey 由这里加
 */
export async function postFn(fn: string, req: { headers: Record<string, string>; body: BodyInit }, signal: AbortSignal, o: AiParseApiOptions = {}): Promise<unknown> {
  const doFetch = o.fetch ?? appFetch;
  const jwt = await tokenOr(o.token ?? sessionToken, signal);
  if (jwt === null) throw new SendError('http');
  const url = o.url ?? `${buildInfo.supabaseUrl}/functions/v1/${fn}`;
  const send = (t: string): Promise<Response> =>
    doFetch(url, {
      method: 'POST',
      headers: { ...req.headers, authorization: `Bearer ${t}`, apikey: o.anonKey ?? buildInfo.anonKey },
      body: req.body,
      signal,
      cache: 'no-store',
    });
  let res = await send(jwt);
  if (res.status === 401) {
    const fresh = await tokenOr(o.refresh ?? refreshedToken, signal);
    if (fresh !== null && fresh !== jwt) res = await send(fresh);
  }
  if (!res.ok) throw new SendError('http');
  try {
    return (await res.json()) as unknown;
  } catch (e) {
    // 读包体时被取消（超时）原样抛，askAi 认成 timeout
    if (signal.aborted) throw e;
    throw new SendError('bad_response');
  }
}

export function createCallAi(o: AiParseApiOptions = {}): CallAi {
  return (req: AiParseReq, signal: AbortSignal): Promise<unknown> =>
    postFn(AI_PARSE_FN, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }, signal, o);
}

/** 打字条默认用的那一个 */
export const callAiParse: CallAi = createCallAi();
