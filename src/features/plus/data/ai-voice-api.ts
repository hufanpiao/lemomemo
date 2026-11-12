// 把一段录音 POST 给 ai-voice，返回已 parse 的 JSON，原样交给 ai-outcome.ts 的 outcomeOf
// • 包体就是录音的原始字节，参数全在请求头；发送、401 换令牌、各返回码见 fn-post.ts 的 postFn
// • 只发这一次：总超时（record-logic 的 uploadTimeoutMs）、自动重试由调用方管；录音能不能交出（不空、有类型、不超字节上限）由录音器判过，这里不重判
// • 运行日志只补全局 net 行没有的：字节数、类型、项目个数；不记项目名
// 纯 TS：不准 import React（A1）
import { b64uEncode } from '../../../../shared/core/b64url.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { postFn, type FnPostOptions } from './fn-post.ts';
import type { AiReqCtx } from './type-flow.ts';

export const AI_VOICE_FN = 'ai-voice';
/** 进日志的类型只收这种写法，别的记成 ? */
const MIME_RE = /^[a-z0-9/.+-]{1,40}$/;

/** 上下文由 type-flow 的 aiReqCtx 拼（和打字同一份）；mime 是录音的类型、不带参数（audio/mp4），直接当 Content-Type */
export type AiVoiceReq = AiReqCtx & { audio: Blob; mime: string };

/** 送 ai-voice 的口子：失败抛 SendError（或 fetch 原样抛的 TypeError、取消原因），和打字的 CallAi 同一个形状 */
export type CallVoice = (req: AiVoiceReq, signal: AbortSignal) => Promise<unknown>;

/** X-Projects：项目名（aiReqCtx 已规整）→ JSON → UTF-8 → base64url；一个都没有返回 null（不带这个头）。太长由服务器按项截断，这里不截 */
export function encodeProjects(projects: readonly string[]): string | null {
  return projects.length === 0 ? null : b64uEncode(new TextEncoder().encode(JSON.stringify(projects)));
}

export function voiceHeaders(req: AiVoiceReq): Record<string, string> {
  const projects = encodeProjects(req.projects);
  return {
    'content-type': req.mime,
    'x-now': String(Math.round(req.now)),
    'x-tz': req.tz,
    'x-locale': req.locale,
    'x-scope': req.scope,
    ...(projects !== null ? { 'x-projects': projects } : {}),
    ...(req.default_day !== undefined ? { 'x-default-day': req.default_day } : {}),
  };
}

export function createCallVoice(o: FnPostOptions = {}): CallVoice {
  return (req: AiVoiceReq, signal: AbortSignal): Promise<unknown> => {
    rlog(`voice upload start bytes=${req.audio.size} mime=${MIME_RE.test(req.mime) ? req.mime : '?'} projects=${req.projects.length}`);
    return postFn(AI_VOICE_FN, { headers: voiceHeaders(req), body: req.audio }, signal, o);
  };
}

/** 录音默认用的那一个 */
export const callAiVoice: CallVoice = createCallVoice();
