// 一段录音交给 ai-voice 到出结果
// • 格式：只做直传（iPhone 诊断直传全部成功）。上传前只经 toUpload 这一个口子：
//   以后要压 MP3（Worker + lamejs）只改它，别处不用动；现在原样交出
// • 总超时按体积算（record-logic 的 uploadTimeoutMs：17 秒起、每 100 KB 加 1 秒、最多 22 秒）；只在网络错误、连接都没建立时自动重试 1 次，
//   重试前浏览器已经明确说离线就不重试（和打字的 askAi 一样）
// • 返回按 ai-outcome 的 outcomeOf 归类（intent 穷举），录音多两种：
//   空转写、没有条目 → no_speech（服务器照常算 1 次）；
//   不认识的 intent、返回读不懂但带着转写 → rule：用转写走本机规则（退路，原话不丢）
// • 结果在界面上怎么收尾（voiceFinal）：记下的拼成和打字同一种 TypePlan，别的给出提示条种类
// • 结果映射成动作只此一份（finishVoice）：前台（voice-rec.ts）、
//   后台（voice-pending.ts）各自只交进来自己怎么存、怎么交结果层、没听到、失败怎么办（VoiceSink）。
//   有转写但一条都拆不出（rule、拆出 0 条）：整句存成今天的一条待办（todayTodo），不当失败
// • 运行日志只记结果种类、原因、次数、毫秒、字节数，不记转写
// 纯 TS：不准 import React
import { todayOf } from '../../../../shared/core/date.ts';
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { isObj } from '../../../../shared/core/field.ts';
import { cutAiText, outcomeOf } from './ai-outcome.ts';
import type { CallVoice } from './ai-voice-api.ts';
import { uploadTimeoutMs } from './record-logic.ts';
import { withTimeoutRetry, type SendFail } from './send-error.ts';
import { NO_HINTS, intentAsk, localHint, planLocal, recordAlt, type AiReqCtx, type TypeCtx, type TypePlan } from './type-flow.ts';
import { onlineNow } from '../../../platform/online.ts';

/** 要上传的一段录音：mime 不带参数（audio/mp4），直接当 Content-Type */
export interface VoiceClip {
  blob: Blob;
  mime: string;
}

/** 上传前的最后一步（格式的接缝）：现在直传，原样交出。以后要压 MP3 只改这里（异步，在 Worker 里编） */
export async function toUpload(clip: VoiceClip): Promise<VoiceClip> {
  return clip;
}

export type VoiceResult =
  /** 识别成功 */
  | { kind: 'record'; items: AiItem[]; transcript: string; quotaLeft: number; confidence: number }
  /** AI 判成查找、总结、取消、改期、完成 */
  | { kind: 'intent'; ask: AssistAsk; transcript: string; quotaLeft: number; confidence: number }
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
      return { kind: 'record', items: out.items, transcript: cutAiText(out.transcript ?? ''), quotaLeft: out.quotaLeft, confidence: out.confidence };
    case 'intent':
      return { kind: 'intent', ask: out.ask, transcript: cutAiText(out.transcript ?? ''), quotaLeft: out.quotaLeft, confidence: out.confidence };
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
  const online = o.online ?? onlineNow;
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
  /** 语音暂时用不了：今天额度用完（按下时已知就不开麦克风；令牌、ai-voice 回了用完也是这条），说明几点恢复 */
  | 'quota'
  | 'redo'
  /** 语音暂时用不了：AI 没开、没同意（按下那一刻就挡，不开麦克风），给“去打开” */
  | 'ai_off'
  | 'rec_failed'
  /** 停录等不到结局（兜底超时）：这段没收到 */
  | 'not_heard'
  | 'not_saved'
  /** 按下时弹了 iOS 系统麦克风框，点完“允许”手指已松开、这一下没录：请再按住一次 */
  | 'mic_ready';

/** 一次返回在界面上怎么收尾：save 记下（和打字同一种 TypePlan，raw 是转写）；note 出提示条（status 是状态机的终态）；idle 回到没按 */
export type VoiceFinal =
  | { do: 'save'; plan: TypePlan; raw: string }
  /** 判成查找等（有把握）：不保存，交给结果层（规则和打字同一套：本机有迹象且 AI ≥ 0.6，或本机就有把握） */
  | { do: 'ask'; ask: AssistAsk; raw: string; quotaLeft: number | null }
  | { do: 'note'; status: 'no_speech' | 'quota_out' | 'ai_failed'; note: VoiceNote }
  | { do: 'idle' };

/** 结果 → 收尾。识别成功的提示（几点、哪天）也用本机规则从转写里看；不认识的 intent 整句走本机规则（原话不丢）；
 *  AI 没回应时在线出“重试 / 再说一次”，不在线出“没网”（录音都留着） */
export function voiceFinal(res: VoiceResult, ctx: TypeCtx, online: boolean): VoiceFinal {
  switch (res.kind) {
    case 'record':
    case 'intent': {
      const { hint, sure } = localHint(res.transcript, ctx);
      const won = intentAsk(hint, sure, res.kind === 'intent' ? res : null);
      if (won) return { do: 'ask', ask: won.ask, raw: res.transcript, quotaLeft: res.quotaLeft };
      const l = planLocal(res.transcript, ctx).result;
      if (res.kind === 'intent') {
        // 本机看不出迹象或 AI 没把握：先按记下存（原话不丢），提示条给“改成搜索”和 AI 找到的
        const plan: TypePlan = { status: 'saved', origin: 'rule', items: l.items, hints: l.hints, quotaLeft: res.quotaLeft, aiReason: `intent_${res.ask.intent}`, ask: null, alt: { ask: res.ask, found: true } };
        return { do: 'save', raw: res.transcript, plan };
      }
      const hints = { ...l.hints, bad_day: null };
      return { do: 'save', raw: res.transcript, plan: { status: 'saved', origin: 'ai', items: res.items, hints, quotaLeft: res.quotaLeft, aiReason: null, ask: null, alt: recordAlt(hint, res.confidence) } };
    }
    case 'rule': {
      // 和上面同一条规矩：本机就有把握的查找、总结直接交结果层（AI 返回读不懂不影响本机的判断）
      const { hint, sure } = localHint(res.transcript, ctx);
      const won = intentAsk(hint, sure, null);
      if (won) return { do: 'ask', ask: won.ask, raw: res.transcript, quotaLeft: null };
      const l = planLocal(res.transcript, ctx).result;
      const alt = hint ? { ask: hint, found: true } : null;
      return { do: 'save', raw: res.transcript, plan: { status: 'saved_rule', origin: 'rule', items: l.items, hints: l.hints, quotaLeft: null, aiReason: res.reason, ask: null, alt } };
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

/** 整句存成今天的一条待办（今天页、待办页都看得到），没有时刻、不提醒：没出字时的占位“语音记录 · 整理中”、
 *  出了字或有转写但本机规则一条都拆不出时（标题就是这句话）都用它 */
export function todayTodo(title: string, now: number): TypePlan {
  const item: AiItem = {
    kind: 'todo', title, date: null, time: null, duration_min: null, due: todayOf(now, currentTz()), important: false,
    project: null, body: null, short: null, date_basis: null, anniv: null, confirm: null,
  };
  return { status: 'saved', origin: 'rule', items: [item], hints: NO_HINTS, quotaLeft: null, aiReason: null, ask: null, alt: null };
}

/** 失败那几种收尾（note 出提示条、idle 用户取消了） */
export type VoiceMiss = Extract<VoiceFinal, { do: 'note' } | { do: 'idle' }>;

/** 一次结果交给谁收：save 存（plan 一定有条目）、ask 交结果层、none 没听到说话、miss 失败或取消；T 是各自交回的（日志 out=） */
export interface VoiceSink<T> {
  save(plan: TypePlan, raw: string): Promise<T>;
  ask(ask: AssistAsk, raw: string): Promise<T>;
  none(): Promise<T>;
  miss(f: VoiceMiss): Promise<T>;
}

/** 一次 ai-voice（或令牌）结果 → 动作（只此一份，见文件头）：有转写但拆不出条目的整句存（不当失败），一个字都没有的算没听到 */
export function finishVoice<T>(res: VoiceResult, ctx: TypeCtx, online: boolean, sink: VoiceSink<T>): Promise<T> {
  const f = voiceFinal(res, ctx, online);
  switch (f.do) {
    case 'save': {
      if (f.plan.items.length > 0) return sink.save(f.plan, f.raw);
      if (f.raw.trim() === '') return sink.none();
      const one = todayTodo(f.raw, clock.now());
      return sink.save({ ...f.plan, items: one.items, hints: NO_HINTS }, f.raw);
    }
    case 'ask':
      return sink.ask(f.ask, f.raw);
    case 'note':
      return f.status === 'no_speech' ? sink.none() : sink.miss(f);
    case 'idle':
      return sink.miss(f);
    default: {
      const never: never = f;
      return never;
    }
  }
}
