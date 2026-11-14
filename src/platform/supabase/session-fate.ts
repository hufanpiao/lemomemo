// 查服务器：这个会话是不是被吊销了（架构 4.1a 第 1、4 点；R-382，0.59 安全审 M1）。调 public.session_fate(p_pair)，会话已经没了，用 anon 身份调
// • p_pair = sha256(session_id ':' user_id) 的 64 位小写十六进制，在本机算（auth-loss-log.ts 的 pairHash），明文 uuid 不上网
// • 只回 'revoked' | 'unknown'；查不了（离线、超时、429、5xx、426、函数还没上线回 404、回了别的东西、哈希算不出）一律 null，调用方按 expired
// • 不带用户令牌（会话已作废）；用调用方传的 fetch（都传 http.ts 的 appFetch），不加载 supabase-js（登录页也用）。5 秒超时
// • 不 import http.ts：本文件随 core/auth-loss.ts 懒加载，引了首屏模块会让首屏多拆一块（见 auth-loss-log.ts 开头）
import { buildInfo } from '../env.ts';
import { pairHash } from '../auth-loss-log.ts';
import { onlineNow } from '../online.ts';

export type SessionFate = 'revoked' | 'unknown';
export const SESSION_FATE_TIMEOUT_MS = 5000;

export interface SessionFateDeps {
  /** http.ts 的 appFetch（必填，免得悄悄换成不带版本头的 fetch） */
  fetch: typeof fetch;
  url?: string;
  anonKey?: string;
  timeoutMs?: number;
  online?: () => boolean;
}

/** 查不了，但值得过一会儿再查（429 限流、5xx）：登录页按退避重查（安全审建议 1）；别的调用方当 null */
export type SessionFateResult = SessionFate | 'retry' | null;

export async function querySessionFate(sessionId: string, userId: string, d: SessionFateDeps): Promise<SessionFate | null> {
  const r = await querySessionFateResult(sessionId, userId, d);
  return r === 'retry' ? null : r;
}

/** 同 querySessionFate，另把 429、5xx 单独回 'retry'（离线、超时、404、426、回包不对仍是 null） */
export async function querySessionFateResult(sessionId: string, userId: string, d: SessionFateDeps): Promise<SessionFateResult> {
  const base = d.url ?? buildInfo.supabaseUrl;
  const key = d.anonKey ?? buildInfo.anonKey;
  if (!base || !key) return null;
  const online = d.online ?? onlineNow;
  if (!online()) return null;
  const pair = await pairHash(sessionId, userId);
  if (!pair) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), d.timeoutMs ?? SESSION_FATE_TIMEOUT_MS);
  try {
    const res = await d.fetch(`${base.replace(/\/$/, '')}/rest/v1/rpc/session_fate`, {
      method: 'POST',
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_pair: pair }),
      signal: ac.signal,
    });
    if (res.status === 429 || res.status >= 500) return 'retry';
    if (!res.ok) return null;
    const v: unknown = await res.json();
    return v === 'revoked' || v === 'unknown' ? v : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
