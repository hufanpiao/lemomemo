// 日志批量写 public.logs：经 getSupabase（带 X-App-Version、426 通知），不自己 fetch
// • 只能 insert 授权的列；user_id 由默认值 auth.uid() 填，客户端不传
// • 结果分几种（类型在 shared/core/log-row.ts）——临时故障一律留着重试，只有确定传不上去的才丢：
//   - drop：quota（400 / 403）、42501（RLS 拒绝）；整批丢，不重试
//   - bad：明确的数据错误（sqlstate 22xxx、23xxx）、PGRST 开头的 4xx（401 除外）、413；重试也不会好，队列二分重传，只丢出错的那一条
//   - retry：断网、超时、5xx、401、408、426、429 以及其余 4xx；连续超过 5 次就丢（core/log/queue.ts）
// • 一批里只要有一条超了每天上限，row_quota 抛 quota，整批回滚
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LogRow, LogUploadResult } from '../../../shared/core/log-row.ts';
import { getSupabase } from './client.ts';
import { REQUEST_TIMEOUT_MS, timeoutSignal, toFailure } from './sync-transport.ts';
import { withTimeout } from '../exit-basics.ts';

export type { LogRow, LogUploadResult };

/** 一次失败归哪一类（单独导出测） */
export function classifyLogFailure(error: unknown, status: number | undefined): LogUploadResult {
  const f = toFailure(error, status);
  if (f.network || f.status === undefined) return 'retry';
  if (f.status >= 500) return 'retry';
  // toFailure 的 code 优先取 message 里的自定义码（quota），sqlstate 另从原始 code 字段取
  const e = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const state = typeof e['code'] === 'string' ? e['code'] : '';
  if (f.code === 'quota' && (f.status === 400 || f.status === 403)) return 'drop';
  if (state === '42501') return 'drop';
  if (/^2[23][0-9A-Z]{3}$/.test(state)) return 'bad';
  if ([401, 408, 426, 429].includes(f.status)) return 'retry';
  if (f.status === 413 || (state.startsWith('PGRST') && f.status >= 400 && f.status < 500)) return 'bad';
  return 'retry';
}

export function createLogUploader(opts: { client?: () => Promise<SupabaseClient>; timeoutMs?: number } = {}): (rows: readonly LogRow[]) => Promise<LogUploadResult> {
  const client = opts.client ?? (() => getSupabase() as unknown as Promise<SupabaseClient>);
  const ms = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return (rows) =>
    withTimeout<LogUploadResult>(async () => {
      if (rows.length === 0) return 'ok';
      const db = await client();
      const ts = timeoutSignal(ms);
      try {
        const b = db.from('logs').insert(rows.map((r) => ({ ...r })));
        const r = await (ts.signal ? b.abortSignal(ts.signal) : b);
        return r.error ? classifyLogFailure(r.error, r.status) : 'ok';
      } finally {
        ts.clear();
      }
    }, ms, () => 'retry');
}
