// 打字条调 ai-parse（B3 任务单 FA-2、Q2；架构第 6 节 ai-parse 行、第 7 节；supabase/functions/ai-parse/core.ts 的返回）
// • 经 platform/http 的 appFetch 直接 POST <supabaseUrl>/functions/v1/ai-parse：带这次会话的 access token（JWT）、apikey，
//   appFetch 自动带 X-App-Version（函数入口查版本门）；收到 426 时 appFetch 通知 onUpgradeRequired（横幅由 core/upgrade.ts 出）
// • 返回码 → 打字流程（type-flow.ts 的 askAi、outcomeOf）怎么走：
//   - 200：JSON 原样交给 outcomeOf：{intent:'record'} 记下（items 为空 = empty_items，退回本机规则）；{fallback, reason}（feature_off、
//     vault_ai_off、quota、invalid、timeout、error）、{consent_required}、{quota_out} 各自的分支见 type-flow.ts 的 planTyped
//   - 400 bad_request（含 default_day 不合格）、401 / 403（会话没了、账号停用）、413、426、429 rate_limited（每分钟上限）、
//     500、503 try_later：抛 SendError('http')，不自动重试，用本机规则记下、原话不丢（状态 saved_rule）。
//     会话没了、账号停用由同步（outbox）那边照常处理，这里不另外退出
//   - 2xx 但不是 JSON：SendError('bad_response')
//   - 断网、读不出原因（appFetch 抛 TypeError）：原样抛出，askAi 认成 network、自动重试 1 次；超时（6 秒）由 askAi 的 signal 取消
//   - 没登录（拿不到会话）：SendError('http')，不发请求
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
}

async function sessionToken(): Promise<string | null> {
  const db = await getSupabase();
  const { data, error } = await db.auth.getSession();
  if (error) return null;
  return data.session?.access_token ?? null;
}

export function createCallAi(o: AiParseApiOptions = {}): CallAi {
  const doFetch = o.fetch ?? appFetch;
  const token = o.token ?? sessionToken;
  return async (req: AiParseReq, signal: AbortSignal): Promise<unknown> => {
    let jwt: string | null;
    try {
      jwt = await token();
    } catch {
      jwt = null;
    }
    if (jwt === null) throw new SendError('http');
    const url = o.url ?? `${buildInfo.supabaseUrl}/functions/v1/${AI_PARSE_FN}`;
    const res = await doFetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, apikey: o.anonKey ?? buildInfo.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new SendError('http');
    try {
      return (await res.json()) as unknown;
    } catch (e) {
      // 读包体时被取消（超时）原样抛，askAi 认成 timeout
      if (signal.aborted) throw e;
      throw new SendError('bad_response');
    }
  };
}

/** 打字条默认用的那一个 */
export const callAiParse: CallAi = createCallAi();
