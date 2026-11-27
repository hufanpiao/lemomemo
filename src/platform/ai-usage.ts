// 今天 AI 用了几次：设置页和结果层页脚共用这一份
// • 读 rpc my_ai_usage()；恢复时刻前端自己算（shared/logic/ai-quota.ts 的 quotaResetClock）
// • 低版本也能读（不过版本门）；读不到返回 ok:false，界面写“读不出来”，不当 0 次
// • 读到“已用完”时给了 remember 就记进本机额度（打字条就不再白发一次）；放 platform 是因为 smart-search 也要读，功能之间不互相引
// • 只在懒加载块里用，不进首屏。纯 TS：不准 import React
import { getSupabase } from './supabase/client.ts';
import { onlineNow } from './online.ts';

export interface AiUsage {
  used: number;
  limit: number;
  /** 管理员：每天不设上限（ai_unlimited）。界面写“今天 N 次 · 不限” */
  unlimited: boolean;
}

export type UsageErr = 'offline' | 'failed';
export type UsageResult = { ok: true; value: AiUsage } | { ok: false; err: UsageErr };

export const USAGE_TIMEOUT_MS = 8000;

const nat = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** 函数返回 → 用量；结构不对返回 null */
export function usageOf(v: unknown): AiUsage | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  // ai_unlimited 是后加的键：没有（旧服务器）按不是管理员
  return nat(r['ai_used']) && nat(r['ai_limit']) ? { used: r['ai_used'], limit: r['ai_limit'], unlimited: r['ai_unlimited'] === true } : null;
}

export interface UsageDeps {
  rpc(signal: AbortSignal): Promise<{ data: unknown; error: unknown }>;
  online?(): boolean;
  /** 读到“已用完”时记本机剩余次数（不给就不记） */
  remember?(left: number, now: number): Promise<void>;
  now?(): number;
}

export const usageRpc: UsageDeps['rpc'] = async (signal) => {
  const db = await getSupabase();
  return db.rpc('my_ai_usage').abortSignal(signal);
};

const defaultDeps: UsageDeps = { rpc: usageRpc };

const offlineNow = (d: UsageDeps): boolean => !(d.online ?? onlineNow)();

export async function readAiUsage(d: UsageDeps = defaultDeps, timeoutMs = USAGE_TIMEOUT_MS): Promise<UsageResult> {
  if (offlineNow(d)) return { ok: false, err: 'offline' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await d.rpc(ac.signal);
    if (r.error) return { ok: false, err: ac.signal.aborted ? 'offline' : 'failed' };
    const u = usageOf(r.data);
    if (!u) return { ok: false, err: 'failed' };
    // 只在用完时记（没用完时记的数会比服务器旧）；记不进就算了，由服务器回 quota_out 把关。管理员不算用完
    if (!u.unlimited && u.used >= u.limit && d.remember) {
      try {
        await d.remember(0, d.now ? d.now() : Date.now());
      } catch {
        /* 不影响用量显示 */
      }
    }
    return { ok: true, value: u };
  } catch (e) {
    return { ok: false, err: ac.signal.aborted || e instanceof TypeError ? 'offline' : 'failed' };
  } finally {
    clearTimeout(timer);
  }
}
