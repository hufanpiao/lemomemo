// 打字条调 ai-parse：原话和参数放 JSON 包体，经 fn-post.ts 的 postFn 发出，返回的 JSON 原样交给 type-flow.ts 的 askAi、outcomeOf
// • 超时 6 秒由 askAi 的 signal 取消，取令牌、换令牌也算在里面；断网由 askAi 自动重试 1 次，其余失败用本机规则记下、原话不丢
// • 只在打字条那一块（plus 的懒加载块）里，不进首屏
// 纯 TS：不准 import React（A1）
import { postFn, type FnPostOptions } from './fn-post.ts';
import type { AiParseReq, CallAi } from './type-flow.ts';

export const AI_PARSE_FN = 'ai-parse';

export function createCallAi(o: FnPostOptions = {}): CallAi {
  return (req: AiParseReq, signal: AbortSignal): Promise<unknown> =>
    postFn(AI_PARSE_FN, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }, signal, o);
}

/** 打字条默认用的那一个 */
export const callAiParse: CallAi = createCallAi();
