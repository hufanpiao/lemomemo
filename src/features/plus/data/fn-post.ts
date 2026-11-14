// “＋”这一块调服务器函数（ai-parse、ai-voice、token-admin）：sendFn 在 platform/fn-send.ts（查找也用同一份，401 换一次令牌再发）
// • postFn：2xx 是 JSON 就原样交回，不是 JSON 抛 SendError('bad_response')；没登录、非 2xx 抛 SendError('http')；断网的 TypeError 原样抛
// 纯 TS：不准 import React（A1）
import { sendFn, type FnPostOptions, type FnReq } from '../../../platform/fn-send.ts';
import { SendError } from './send-error.ts';

export { sendFn, type FnPostOptions, type FnReq };

/** 同 sendFn，只收 2xx 的 JSON，返回已 parse 的值 */
export async function postFn(fn: string, req: FnReq, signal: AbortSignal, o: FnPostOptions = {}): Promise<unknown> {
  const res = await sendFn(fn, req, signal, o);
  if (res === null || !res.ok) throw new SendError('http');
  try {
    return (await res.json()) as unknown;
  } catch (e) {
    // 读包体时被取消（超时）原样抛，调用方认成 timeout
    if (signal.aborted) throw e;
    throw new SendError('bad_response');
  }
}
