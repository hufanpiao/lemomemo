// 语音提问的转写（R-495）：ai-voice 带 X-Want: transcript 时走这里，只把录音转成文字，不判断意图、不拆条目。服务商由 ai-voice 的门按用途 stt 选。
// 回 503 重试一次（同录音，retry.ts）；转出来的字截到一句提问的上限（CHAT_TEXT_MAX，tests/edge/ai-voice-ask.test.ts 钉住）。音频、文字都不进日志。
import { cutUnits } from './cites.ts';
import { TASK_PARAMS, VOICE_TIMEOUT_MS } from './params.ts';
import type { ParseFail } from './parse-core.ts';
import { sanitize } from './parse-core.ts';
import { TRANSCRIBE_SCHEMA, TRANSCRIBE_V1 } from './prompts/transcribe.v1.ts';
import type { AIProvider } from './provider.ts';
import { generateRetry503 } from './retry.ts';

export const TRANSCRIPT_MAX = 800;

export type TranscribeResult = { ok: true; text: string; retried: boolean } | ParseFail;

export async function transcribeAudio(audio: Uint8Array, mime: string, provider: AIProvider): Promise<TranscribeResult> {
  const { result: r, retried } = await generateRetry503(provider, {
    system: TRANSCRIBE_V1,
    parts: [{ inlineData: { mimeType: mime, data: audio } }],
    schema: { ...TRANSCRIBE_SCHEMA },
    params: TASK_PARAMS.voice,
    timeoutMs: VOICE_TIMEOUT_MS,
  });
  const rt = retried ? ({ retried: true } as const) : {};
  if (!r.ok) {
    return {
      ok: false, reason: r.reason, ...rt, ...(r.status !== undefined ? { status: r.status } : {}), ...(r.errName !== undefined ? { errName: r.errName } : {}),
      ...(r.quotaKind !== undefined ? { quotaKind: r.quotaKind } : {}), ...(r.retryMs !== undefined ? { retryMs: r.retryMs } : {}),
    };
  }
  const t = (r.json as { transcript?: unknown } | null)?.transcript;
  if (typeof t !== 'string') return { ok: false, reason: 'invalid', raw: r.json, invalid_reasons: ['schema'], ...rt };
  return { ok: true, text: cutUnits(sanitize(t.trim(), TRANSCRIPT_MAX).trim(), TRANSCRIPT_MAX), retried };
}
