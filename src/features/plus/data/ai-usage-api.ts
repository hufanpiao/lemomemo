// 设置 › 语音与 AI 的“今天 AI 用了 N 次 / 共 50 次”（B3 任务单 FA-4、S13；R-187、R-237）
// • 读 rpc my_ai_usage()（迁移 20261107100000）：{ai_used, ai_limit, pacific_date}；恢复时刻前端自己算（shared/logic/ai-quota.ts 的 quotaResetClock）
// • 低版本也能读（R-237：读不过版本门）；读不到（断网、超时、出错）返回 ok:false，界面只写“读不出来”，不当 0 次
// • 读到“已用完”时顺手记进本机额度（quota.ts 的 rememberQuotaLeft），打字条就不再白发一次
// • 8 秒超时；只在设置 › 语音与 AI 这一块（plus 懒加载块）里，不进首屏
// 纯 TS：不准 import React（A1）
import { getSupabase } from '../../../platform/supabase/client.ts';
import { rememberQuotaLeft } from './quota.ts';

export interface AiUsage {
  used: number;
  limit: number;
}

export type UsageErr = 'offline' | 'failed';
export type UsageResult = { ok: true; value: AiUsage } | { ok: false; err: UsageErr };

export const USAGE_TIMEOUT_MS = 8000;

const nat = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** 函数返回 → 用量；结构不对返回 null */
export function usageOf(v: unknown): AiUsage | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  return nat(r['ai_used']) && nat(r['ai_limit']) ? { used: r['ai_used'], limit: r['ai_limit'] } : null;
}

export interface UsageDeps {
  rpc(signal: AbortSignal): Promise<{ data: unknown; error: unknown }>;
  online?(): boolean;
  /** 读到以后记本机剩余次数（默认 quota.ts 的 rememberQuotaLeft） */
  remember?(left: number, now: number): Promise<void>;
  now?(): number;
}

const defaultDeps: UsageDeps = {
  async rpc(signal) {
    const db = await getSupabase();
    return db.rpc('my_ai_usage').abortSignal(signal);
  },
  remember: rememberQuotaLeft,
};

const offlineNow = (d: UsageDeps): boolean => (d.online ? !d.online() : typeof navigator !== 'undefined' && navigator.onLine === false);

export async function readAiUsage(d: UsageDeps = defaultDeps, timeoutMs = USAGE_TIMEOUT_MS): Promise<UsageResult> {
  if (offlineNow(d)) return { ok: false, err: 'offline' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await d.rpc(ac.signal);
    if (r.error) return { ok: false, err: ac.signal.aborted ? 'offline' : 'failed' };
    const u = usageOf(r.data);
    if (!u) return { ok: false, err: 'failed' };
    // 只在用完时记：没用完时记的数会比服务器旧，打字条照常发、由服务器回 quota_out 把关
    // 代码审 S4：记本机额度出错不影响显示用量（记不进就算了，打字条照常由服务器回 quota_out 把关）
    if (u.used >= u.limit && d.remember) {
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
