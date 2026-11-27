// 按住“＋”走 Gemini 实时转写前，向服务器 ai-live-token 要一个短期令牌：
// • 发送经 fn-post 的 postFn（带 JWT，401 换一次令牌；没登录不发）；请求头 x-locale 是界面语言，服务器据此偏向识别语言
// • 回包核一遍形状：token（auth_tokens/…）、api（只认 live-proto.ts 的 LIVE_API，v1beta）、setup（锁进令牌的那份配置，连上以后原样发）；
//   发令牌不扣每天 50 次，回包不带 quota_left，剩余次数由后面整理的 ai-parse / ai-voice 回；
//   没同意（consent）、今天用完（quota_out）由调用方直接收尾、不上传录音；服务器让退回（fallback）、发不出去、形状不对回 ok: false 和原因，调用方退回录音上传 ai-voice
// • 本机 e2e 假后端组（非正式构建、没配后端地址，取不到会话、postFn 不发请求）：sessionStorage 的 lemo-e2e-live-token 当作服务器回包，
//   好让 tests/e2e 用假 WebSocket 跑完边说边出字；正式构建靠 MODE 常量整段摇掉，预览版配了后端地址读不到它
// • 运行日志只记结果和原因，不记令牌
// 纯 TS：不准 import React
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { buildInfo } from '../../../platform/env.ts';
import { LIVE_API } from '../../../platform/live-proto.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { isObj } from '../../../../shared/core/field.ts';
import { postFn } from './fn-post.ts';
import { sendFailOf } from './send-error.ts';

export const AI_LIVE_TOKEN_FN = 'ai-live-token';
const E2E_KEY = 'lemo-e2e-live-token';

export interface LiveTokenOk {
  token: string;
  api: string;
  setup: Record<string, unknown>;
}
export type LiveTokenRes = { ok: true; t: LiveTokenOk } | { ok: false; why: string };

export type CallPost = typeof postFn;

/** 服务器回包 → 令牌或原因 */
export function liveTokenOf(v: unknown): LiveTokenRes {
  if (!isObj(v)) return { ok: false, why: 'bad' };
  if (v.consent_required === true) return { ok: false, why: 'consent' };
  if (v.quota_out === true) return { ok: false, why: 'quota_out' };
  if (v.fallback === true) return { ok: false, why: typeof v.reason === 'string' && /^[a-z_]{1,20}$/.test(v.reason) ? `fb_${v.reason}` : 'fb' };
  const { token, api, setup } = v;
  if (typeof token !== 'string' || token === '' || token.length > 2048) return { ok: false, why: 'bad' };
  if (api !== LIVE_API) return { ok: false, why: 'bad' };
  if (!isObj(setup)) return { ok: false, why: 'bad' };
  return { ok: true, t: { token, api, setup } };
}

function e2eFake(): unknown {
  if (import.meta.env.MODE === 'production' || buildInfo.supabaseUrl !== '') return undefined;
  try {
    const s = sessionStorage.getItem(E2E_KEY);
    return s === null ? undefined : (JSON.parse(s) as unknown);
  } catch {
    return undefined;
  }
}

export async function fetchLiveToken(locale: Locale, signal: AbortSignal, post: CallPost = postFn): Promise<LiveTokenRes> {
  const fake = e2eFake();
  let res: LiveTokenRes;
  if (fake !== undefined) res = liveTokenOf(fake);
  else {
    try {
      res = liveTokenOf(await post(AI_LIVE_TOKEN_FN, { headers: { 'x-locale': locale }, body: '' }, signal));
    } catch (e) {
      res = { ok: false, why: signal.aborted ? 'timeout' : sendFailOf(e) };
    }
  }
  rlog(`voice gem token ${res.ok ? 'ok' : `fail why=${res.why}`}`);
  return res;
}
