// 运行日志一键发送（负责人 11-11：“日志要一键发送，不要贴来贴去”；迁移 20261111200000_core_diag_logs.sql）
// 把 platform/run-log.ts 的整段日志写进 public.diag_logs（每人一行，新发的覆盖旧的）；只有非正式版的诊断面板调它
import type { Db } from '../../../platform/supabase/client.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { timeoutSignal } from '../../../platform/supabase/sync-transport.ts';
import { buildInfo } from '../../../platform/env.ts';

/** 和迁移里 body 的 check 一致；超了只发最后这一段（越新的越有用） */
export const DIAG_MAX_CHARS = 300_000;

export type DiagSendResult = 'ok' | 'signed_out' | 'fail';

export async function sendRunLog(log: string, db: () => Promise<Db> = getSupabase, now: () => Date = () => new Date()): Promise<DiagSendResult> {
  const body = log.length > DIAG_MAX_CHARS ? log.slice(-DIAG_MAX_CHARS) : log;
  const ts = timeoutSignal();
  try {
    const q = (await db())
      .from('diag_logs')
      .upsert({ body, app_version: `${buildInfo.version}@${buildInfo.commit}`.slice(0, 64), sent_at: now().toISOString() }, { onConflict: 'user_id' });
    const r = await (ts.signal ? q.abortSignal(ts.signal) : q);
    if (!r.error) return 'ok';
    return r.status === 401 || r.error.code === '42501' ? 'signed_out' : 'fail';
  } catch {
    return 'fail';
  } finally {
    ts.clear();
  }
}
