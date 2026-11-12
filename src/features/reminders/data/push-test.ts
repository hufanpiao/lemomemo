// 设置 › 提醒“发一条测试通知”（B2 任务单 FA-4、BE-6；架构第 6 节 push-test 行、5.3 D1-5）
// • 调 Edge Function push-test（POST，走用户 JWT、经 /sb 同源，不加 CORS）；服务器只给调用者本人的设备发，每人每小时 5 次
// • 返回只有枚举：{results: [{device_id, result}]}，result 是 ok、gone、failed、bad_endpoint 之一
// • 界面只要一个结果：sent（至少一台 ok）、no_device（一台能收推送的设备都没有）、resubscribe（都是 gone / bad_endpoint：订阅失效，要重新打开通知）、
//   rate_limited（429）、offline（断网、超时）、failed（其他）
import { errName, isAbortErr } from '../../../platform/env.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';

export type PushTestResult = 'sent' | 'no_device' | 'resubscribe' | 'rate_limited' | 'offline' | 'failed';

export interface InvokeOutcome {
  readonly data: unknown;
  readonly status: number | null;
  readonly networkError: boolean;
}

/** 服务器的回包 → 界面结果 */
export function pushTestResultOf(o: InvokeOutcome): PushTestResult {
  if (o.networkError) return 'offline';
  if (o.status === 429) return 'rate_limited';
  if (o.status !== null && o.status !== 200) return 'failed';
  const d = o.data;
  if (typeof d !== 'object' || d === null) return 'failed';
  const results = (d as Record<string, unknown>)['results'];
  if (!Array.isArray(results)) return 'failed';
  if (results.length === 0) return 'no_device';
  const rs = results.map((x) => (typeof x === 'object' && x !== null ? (x as Record<string, unknown>)['result'] : null));
  if (rs.some((r) => r === 'ok')) return 'sent';
  if (rs.every((r) => r === 'gone' || r === 'bad_endpoint')) return 'resubscribe';
  return 'failed';
}

const statusOfError = (e: unknown): number | null => {
  const ctx = typeof e === 'object' && e !== null ? (e as { context?: unknown }).context : undefined;
  const st = typeof ctx === 'object' && ctx !== null ? (ctx as { status?: unknown }).status : undefined;
  return typeof st === 'number' ? st : null;
};

const isNetworkError = (e: unknown): boolean => {
  return errName(e) === 'FunctionsFetchError' || isAbortErr(e);
};

/** 真正调一次（supabase-js 的 functions.invoke，带 X-App-Version 和用户 JWT） */
export async function invokePushTest(): Promise<InvokeOutcome> {
  try {
    const db = await getSupabase();
    const { data, error } = await db.functions.invoke<unknown>('push-test', { method: 'POST', body: {} });
    if (!error) return { data, status: 200, networkError: false };
    return { data: null, status: statusOfError(error), networkError: isNetworkError(error) };
  } catch {
    return { data: null, status: null, networkError: true };
  }
}

export async function sendTestPush(invoke: () => Promise<InvokeOutcome> = invokePushTest): Promise<PushTestResult> {
  return pushTestResultOf(await invoke());
}
