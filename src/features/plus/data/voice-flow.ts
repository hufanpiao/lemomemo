// 一段录音交给 ai-voice 到出结果（B3 任务单 FA-3；架构 5.11 第 1、4 点，5.1 录音路）
// • 格式：B3 只做直传（Q1 还没正式结论，11-11 iPhone 诊断 12 次直传全部成功）。上传前只经 toUpload 这一个口子：
//   以后要压 MP3（Worker + lamejs）只改它，别处不用动；现在原样交出
// • 总超时按体积算（record-logic 的 uploadTimeoutMs：17 秒起、每 100 KB 加 1 秒、最多 22 秒）；只在网络错误、连接都没建立时自动重试 1 次，
//   重试前浏览器已经明确说离线就不重试（和打字的 askAi 一样）
// • 返回按 ai-outcome 的 outcomeOf 归类（intent 穷举，Q2），录音多两种：
//   空转写、没有条目 → no_speech（服务器 R7 ②，照常算 1 次）；
//   不认识的 intent、返回读不懂但带着转写 → rule：用转写走本机规则（退路，原话不丢）
// • 结果在界面上怎么收尾（voiceFinal）：记下的拼成和打字同一种 TypePlan，别的给出提示条种类
// • 运行日志只记结果种类、原因、次数、毫秒、字节数，不记转写
// 纯 TS：不准 import React（A1）
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { cutAiText, isObj, outcomeOf } from './ai-outcome.ts';
import type { CallVoice } from './ai-voice-api.ts';
import { uploadTimeoutMs } from './record-logic.ts';
import { withTimeoutRetry, type SendFail } from './send-error.ts';
import { navOnline, planLocal, type AiReqCtx, type TypeCtx, type TypePlan } from './type-flow.ts';

/** 要上传的一段录音：mime 不带参数（audio/mp4），直接当 Content-Type */
export interface VoiceClip {
  blob: Blob;
  mime: string;
}

/** 上传前的最后一步（Q1 的接缝）：现在直传，原样交出。以后要压 MP3 只改这里（异步，在 Worker 里编） */
export async function toUpload(clip: VoiceClip): Promise<VoiceClip> {
  return clip;
}

export type VoiceResult =
  /** 识别成功 */
  | { kind: 'record'; items: AiItem[]; transcript: string; quotaLeft: number }
  /** 没听到说话 */
  | { kind: 'no_speech' }
  /** 有转写、但 AI 结果用不了（不认识的 intent、读不懂）：用转写走本机规则 */
  | { kind: 'rule'; transcript: string; reason: string }
  /** 今天的次数用完了（录音没交给 Gemini） */
  | { kind: 'quota_out' }
  /** 还没同意 AI 告知 */
  | { kind: 'consent_required' }
  /** 服务器说这次不整理（功能没开、隐私记没开 AI 等） */
  | { kind: 'fallback'; reason: string }
  /** AI 这次没回应、超时、断网：录音留着可以重试；fail 是送出那一步的失败种类（服务器回的 ai_failed 为 null） */
  | { kind: 'failed'; reason: string; fail: SendFail | null }
  /** 用户点了取消 */
  | { kind: 'cancelled' };

/** ai-voice 返回的 JSON（已 parse）→ 结果 */
export function voiceResult(raw: unknown): VoiceResult {
  const transcript = isObj(raw) && typeof raw['transcript'] === 'string' ? raw['transcript'].trim() : null;
  const out = outcomeOf(raw);
  switch (out.kind) {
    case 'record':
      return { kind: 'record', items: out.items, transcript: cutAiText(out.transcript ?? ''), quotaLeft: out.quotaLeft };
    case 'quota_out':
      return { kind: 'quota_out' };
    case 'consent_required':
      return { kind: 'consent_required' };
    case 'fallback':
      return out.reason === 'quota' ? { kind: 'quota_out' } : { kind: 'fallback', reason: out.reason };
    case 'ai_failed':
      if (out.reason === 'empty_items' && transcript === '') return { kind: 'no_speech' };
      if (transcript) return { kind: 'rule', transcript: cutAiText(transcript), reason: out.reason };
      return { kind: 'failed', reason: out.reason, fail: null };
    default: {
      const never: never = out;
      return never;
    }
  }
}

export interface SendVoiceOpts {
  /** 现在在不在线（重试前看一眼）；不给用 navigator.onLine */
  online?: () => boolean;
  /** 用户点“取消” */
  signal?: AbortSignal;
  now?: () => number;
}

/** 送一次 ai-voice（超时按体积；网络错误自动重试 1 次）→ 结果 */
export async function sendVoice(clip: VoiceClip, ctx: AiReqCtx, call: CallVoice, o: SendVoiceOpts = {}): Promise<VoiceResult> {
  const online = o.online ?? navOnline;
  const now = o.now ?? (() => performance.now());
  const t0 = now();
  const timeoutMs = uploadTimeoutMs(clip.blob.size);
  const done = (r: VoiceResult, tries: number): VoiceResult => {
    const why = 'reason' in r ? ` reason=${r.reason}` : '';
    const fail = r.kind === 'failed' && r.fail ? ` fail=${r.fail}` : '';
    rlog(`voice result kind=${r.kind}${why}${fail} tries=${tries} ms=${Math.round(now() - t0)} bytes=${clip.blob.size} timeout_ms=${timeoutMs}`);
    return r;
  };
  const r = await withTimeoutRetry((signal) => call({ ...ctx, audio: clip.blob, mime: clip.mime }, signal), timeoutMs, online, o.signal);
  if (r.ok) return done(voiceResult(r.value), r.tries);
  return done(r.fail === 'cancelled' ? { kind: 'cancelled' } : { kind: 'failed', reason: r.fail, fail: r.fail }, r.tries);
}

/** 提示条上的几种情况（记下了的走 SavedNotice，不在这里） */
export type VoiceNote =
  | 'offline'
  | 'net_down'
  | 'no_speech'
  | 'nothing'
  | 'ai_failed'
  | 'quota'
  | 'redo'
  | 'speech_off'
  | 'speech_net'
  | 'rec_failed'
  /** 停录、停识别等不到结局（兜底超时）：这段没收到 */
  | 'not_heard'
  | 'not_saved';

/** 一次返回在界面上怎么收尾：save 记下（和打字同一种 TypePlan，raw 是转写）；note 出提示条（status 是状态机的终态）；idle 回到没按 */
export type VoiceFinal =
  | { do: 'save'; plan: TypePlan; raw: string }
  | { do: 'note'; status: 'no_speech' | 'quota_out' | 'ai_failed'; note: VoiceNote }
  | { do: 'idle' };

/** 结果 → 收尾。识别成功的提示（几点、哪天）也用本机规则从转写里看；不认识的 intent 整句走本机规则（原话不丢）；
 *  AI 没回应时在线出“重试 / 再说一次”，不在线出“没网”（录音都留着） */
export function voiceFinal(res: VoiceResult, ctx: TypeCtx, online: boolean): VoiceFinal {
  switch (res.kind) {
    case 'record': {
      const hints = { ...planLocal(res.transcript, ctx).result.hints, bad_day: null };
      return { do: 'save', raw: res.transcript, plan: { status: 'saved', origin: 'ai', items: res.items, hints, quotaLeft: res.quotaLeft, aiReason: null } };
    }
    case 'rule': {
      const l = planLocal(res.transcript, ctx).result;
      return { do: 'save', raw: res.transcript, plan: { status: 'saved_rule', origin: 'rule', items: l.items, hints: l.hints, quotaLeft: null, aiReason: res.reason } };
    }
    case 'no_speech':
      return { do: 'note', status: 'no_speech', note: 'no_speech' };
    case 'quota_out':
      return { do: 'note', status: 'quota_out', note: 'quota' };
    case 'consent_required':
    case 'fallback':
      return { do: 'note', status: 'ai_failed', note: 'redo' };
    case 'failed':
      return { do: 'note', status: 'ai_failed', note: online ? 'ai_failed' : 'net_down' };
    case 'cancelled':
      return { do: 'idle' };
    default: {
      const never: never = res;
      return never;
    }
  }
}
