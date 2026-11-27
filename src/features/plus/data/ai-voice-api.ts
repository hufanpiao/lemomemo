// 把一段录音 POST 给 ai-voice，返回已 parse 的 JSON，原样交给 ai-outcome.ts 的 outcomeOf
// • 包体就是录音的原始字节，参数全在请求头；发送、401 换令牌、各返回码见 fn-post.ts 的 postFn
// • 只发这一次：总超时（record-logic 的 uploadTimeoutMs）、自动重试由调用方管；录音能不能交出（不空、有类型、不超字节上限）由录音器判过，这里不重判
// • 运行日志只补全局 net 行没有的：字节数、类型、项目个数；不记项目名
// 纯 TS：不准 import React
import { b64uEncode } from '../../../../shared/core/b64url.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { postFn, type FnPostOptions } from './fn-post.ts';
import type { AiReqCtx } from './type-flow.ts';

export const AI_VOICE_FN = 'ai-voice';

/** 上下文由 type-flow 的 aiReqCtx 拼（和打字同一份）；mime 是录音的类型、不带参数（audio/mp4），直接当 Content-Type */
export type AiVoiceReq = AiReqCtx & { audio: Blob; mime: string };

/** 送 ai-voice 的口子：失败抛 SendError（或 fetch 原样抛的 TypeError、取消原因），和打字的 CallAi 同一个形状 */
export type CallVoice = (req: AiVoiceReq, signal: AbortSignal) => Promise<unknown>;

/** X-Projects：项目名（aiReqCtx 已规整）→ JSON → UTF-8 → base64url；一个都没有返回 null（不带这个头）。太长由服务器按项截断，这里不截 */
export function encodeProjects(projects: readonly string[]): string | null {
  return projects.length === 0 ? null : b64uEncode(new TextEncoder().encode(JSON.stringify(projects)));
}

/** 编出来超过这么长就从尾部（最旧的）减条数再编：服务器超过 8 KB 当没给，留余量给代理对请求头总长的限制 */
export const EXAMPLES_HEADER_MAX = 6000;

/** X-Examples（R-497）：以前分进自建项目的几条（aiReqCtx 已规整，最多 20 条，最近的在前）→ JSON → UTF-8 → base64url；
 *  超过 EXAMPLES_HEADER_MAX 从尾部减；没有返回 null（不带这个头）。服务器解码在 ai-voice/core.ts 的 decodeExamples */
export function encodeExamples(examples: readonly { title: string; project: string }[] | undefined): string | null {
  for (let n = examples?.length ?? 0; n > 0; n--) {
    const h = b64uEncode(new TextEncoder().encode(JSON.stringify(examples!.slice(0, n))));
    if (h.length <= EXAMPLES_HEADER_MAX) return h;
  }
  return null;
}

export function voiceHeaders(req: AiVoiceReq): Record<string, string> {
  const projects = encodeProjects(req.projects);
  const examples = encodeExamples(req.examples);
  return {
    'content-type': req.mime,
    'x-now': String(Math.round(req.now)),
    'x-tz': req.tz,
    'x-locale': req.locale,
    'x-scope': req.scope,
    'x-span': String(req.span),
    ...(projects !== null ? { 'x-projects': projects } : {}),
    ...(examples !== null ? { 'x-examples': examples } : {}),
    ...(req.default_day !== undefined ? { 'x-default-day': req.default_day } : {}),
  };
}

export function createCallVoice(o: FnPostOptions = {}): CallVoice {
  return (req: AiVoiceReq, signal: AbortSignal): Promise<unknown> => {
    // mime 由录音器判过（在 shared 的 AUDIO_TYPES 里、不带参数），直接进日志
    rlog(`voice upload start bytes=${req.audio.size} mime=${req.mime} projects=${req.projects.length} examples=${req.examples?.length ?? 0}`);
    return postFn(AI_VOICE_FN, { headers: voiceHeaders(req), body: req.audio }, signal, o);
  };
}

/** 录音默认用的那一个 */
export const callAiVoice: CallVoice = createCallVoice();
