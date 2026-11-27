// 语音提问的转写：把录音 POST 给 ai-voice，带 x-want: transcript，只要文字；服务器按用途 stt 选服务商、走同一个额度门。
// 录音只在内存里，发完就丢。运行日志由 hooks/useChatVoice.ts 记（只记字节、字数、结果码）。
// 纯 TS：不准 import React
import { VOICE_TIMEOUT_MS } from '../../../../shared/schema/ai.ts';
import { VOICE_WANT_TRANSCRIPT, voiceAskOk } from '../../../../shared/schema/chat.ts';
import { fnRequest } from '../../../platform/fn-call.ts';
import type { FnPostOptions } from '../../../platform/fn-send.ts';

/** 上传加转写最多等多久（服务器等服务商 VOICE_TIMEOUT_MS，再留上传和往返） */
export const VOICE_ASK_TIMEOUT_MS = VOICE_TIMEOUT_MS + 7_000;

export type VoiceAsk = { ok: true; text: string } | { ok: false; reason: 'consent' | 'quota' | 'failed' };

export interface VoiceAskReq {
  blob: Blob;
  mime: string;
  now: number;
  tz: string;
  locale: string;
}

/** 服务器的回包 → 结果 */
export function voiceAskOf(body: unknown): VoiceAsk {
  const p = voiceAskOk.safeParse(body);
  if (p.success) return { ok: true, text: p.data.transcript.trim() };
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (b['consent_required'] === true) return { ok: false, reason: 'consent' };
  if (b['quota_out'] === true || b['reason'] === 'quota') return { ok: false, reason: 'quota' };
  return { ok: false, reason: 'failed' };
}

/** 取令牌、超时（算到包体读完）、发送经 platform/fn-call.ts 的 fnRequest */
export async function askTranscript(req: VoiceAskReq, signal: AbortSignal, o: FnPostOptions = {}): Promise<VoiceAsk> {
  const r = await fnRequest('ai-voice', {
    headers: {
      'content-type': req.mime, 'x-now': String(Math.round(req.now)), 'x-tz': req.tz, 'x-locale': req.locale, 'x-scope': 'main', 'x-want': VOICE_WANT_TRANSCRIPT,
    },
    body: req.blob,
  }, { ...o, signal, timeoutMs: VOICE_ASK_TIMEOUT_MS });
  return r.ok ? voiceAskOf(r.value) : { ok: false, reason: 'failed' };
}
