// 录音这一路的边说边出字、先存、AI 后台整理（R-456，部分取代 R-62“录音时不边说边出字、松手等 Gemini 回来才存”）。voice-rec.ts 调
// • 识别：按下那一下先开手机自带识别（prime，要在手势里），开录音器时接手（take），和手机自带识别那一路同一套生命周期（voice-speech 的 createSpeechRoute）；
//   认出的字（已定稿 + 没定稿）放进 view 的 live 给面板画。这一次作废（取消、太短、切页）时跟着关（attempt 的 abort）
// • 松手以后 voice-rec 等录音器和识别都交了结局，识别出了字交给 quick：
//   先按本机规则存（planText 不开 AI 的那一支，判成有把握的查找照样交结果层），面板、提示条当场回到“已记下”；
//   存成了在后台整理（tidy）：同一段录音交 ai-voice（录音器没录成就把字交 ai-parse），AI 的结果和先存的不一样就经 saved-batch 的 replace 换掉
//   （先存新、再撤旧，和合并同一套）；一样、用户已经动过、AI 失败都只记日志，不再让人重说
// • 后台整理期间不占升级中心的 busy（已经存下了，被重新载入打断只丢一次整理），只在换的那一下（先存新、再撤旧，几十毫秒）占住，免得换到一半记重了；
//   也不随切页取消（这一次已经存完、代号已经收了）
// • 运行日志（只记字数、字节数、毫秒、原因，不记内容）：voice live take=接手没有；voice live saved out= n= ms=（从松手算）；
//   voice live ai skip why=（没存成，不整理）；voice live ai via=voice|parse out=same|replaced|not_saved|skip_*|failed_* ms=
// 纯 TS：不准 import React（A1）
import { getBoot } from '../../../core/boot.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { SpeechEnd } from '../../../platform/speech.ts';
import type { BatchMark, ReplaceOut } from './saved-batch.ts';
import { baseReqCtx, planText, type TypeCtx, type TypePlan } from './type-flow.ts';
import { sendVoice, toUpload, voiceFinal, type VoiceClip, type VoiceResult } from './voice-flow.ts';
import type { Attempt, VoiceCore } from './voice-session.ts';
import { createSpeechRoute } from './voice-speech.ts';

/** 后台整理的结果（日志 out=）：saved-batch 的 replace 给的，或者没交给 replace 的原因 */
type TidyOut = ReplaceOut | `skip_${string}` | `failed_${string}`;
type TidyPlan = { plan: TypePlan; raw: string } | TidyOut;

/** ai-voice 的结果 → 拿来换的：AI 拆的才换；转写走本机规则的、判成别的意图的、失败的不换，给原因 */
function voicePlan(res: VoiceResult, ctx: TypeCtx, online: boolean): TidyPlan {
  const f = voiceFinal(res, ctx, online);
  if (f.do === 'save' && f.plan.origin === 'ai') return { plan: f.plan, raw: f.raw };
  if (f.do === 'ask') return 'skip_ask';
  return res.kind === 'failed' ? `failed_${res.reason}` : `failed_${res.kind}`;
}

/** ai-parse（planText 开 AI）的结果 → 拿来换的；本机有把握没调 AI（和打字一样）、额度用完、离线、没开 AI 的给原因 */
function parsePlan(plan: TypePlan, text: string): TidyPlan {
  if (plan.ask) return 'skip_ask';
  if (plan.origin === 'ai') return { plan, raw: text };
  if (plan.aiReason !== null) return `failed_${plan.aiReason}`;
  return plan.status === 'saved' ? 'skip_local' : `skip_${plan.status}`;
}

/** account：每次 ai-voice 回来都要记的（网络慢计数、剩余次数，voice-rec 那一份） */
export function createLiveRoute(c: VoiceCore, account: (res: VoiceResult) => void) {
  /** 这一次的识别：接手它的那一次、结局（还没结束 null）、等结局的 */
  let live: { a: Attempt; got: SpeechEnd | null; wake: ((r: SpeechEnd | null) => void) | null } | null = null;
  const route = createSpeechRoute({
    started: () => undefined,
    text(t) {
      if (live && c.current() === live.a) c.set({ live: t });
    },
    ended(res) {
      if (!live) return;
      live.got = res;
      live.wake?.(res);
      live.wake = null;
    },
    cap: () => c.finish(),
  });
  /** 识别关掉、不要结局（这一次作废）：等着的当没开 */
  const cancel = (): void => {
    route.cancel();
    live?.wake?.(null);
    live = null;
  };

  /** 后台整理：同一段录音交 ai-voice（录音器没录成就把字交 ai-parse），和先存的不一样就换 */
  const tidy = async (m: BatchMark, text: string, clip: VoiceClip | null, ctx: TypeCtx): Promise<void> => {
    const t0 = performance.now();
    const d = c.d();
    let got: TidyPlan;
    if (clip) {
      const res = await sendVoice(await toUpload(clip), baseReqCtx(ctx), d.callVoice, { online: d.online });
      account(res);
      got = voicePlan(res, ctx, d.online());
    } else got = parsePlan((await planText(text, ctx, { online: d.online, aiOn: d.aiOn(), call: d.callAi })).plan, text);
    let out: TidyOut;
    if (typeof got === 'string') out = got;
    else {
      const free = getBoot()?.upgrade.holdBusy('recording');
      try {
        out = await c.batch.replace(m, got.plan, got.raw);
      } finally {
        free?.();
      }
    }
    rlog(`voice live ai via=${clip ? 'voice' : 'parse'} out=${out} ms=${Math.round(performance.now() - t0)}`);
  };

  return {
    /** 按下那一下先开（要在手势里） */
    prime: () => route.prime(c.d().lang),
    /** 只关先开、还没接手的那次 */
    drop: () => route.drop(),
    cancel,
    /** 开录音器时接手按下时先开的那次；这一次作废时一起关 */
    take(a: Attempt): void {
      const on = route.take(c.d().lang);
      live = on ? { a, got: null, wake: null } : null;
      a.ac.signal.addEventListener('abort', () => {
        if (live?.a === a) cancel();
      });
      rlog(`voice live take=${on ? 1 : 0}`);
    },
    /** 这一次接手了识别 */
    on: (a: Attempt): boolean => live?.a === a,
    /** 这一次的识别已经开始收音、还没结束（录音器开不起来时靠它接着听） */
    listening: (a: Attempt): boolean => live?.a === a && route.listening(),
    /** 松手：停止收音（结局经 heard 拿） */
    stop(a: Attempt): void {
      if (live?.a === a) route.stop();
    },
    /** 等这一次识别的结局（stop() 以后 platform/speech.ts 最多等 3 秒）；没开的是 null。拿到以后这一次不再算接手着 */
    async heard(a: Attempt): Promise<SpeechEnd | null> {
      const l = live;
      if (l?.a !== a) return null;
      const got = l.got ?? (await new Promise<SpeechEnd | null>((ok) => (l.wake = ok)));
      if (live === l) live = null;
      return got;
    },
    elapsed: () => route.elapsed(),
    /** 识别出了字：先按本机规则存，存成了后台整理。返回 false = 本机一条都拆不出来，调用方照原来上传等 AI */
    async quick(a: Attempt, text: string, clip: VoiceClip | null, t0: number): Promise<boolean> {
      const d = c.d();
      // 录音不带选中的日子（FA-3）：先存和 AI 整理都按这一份，两边才比得上
      const ctx: TypeCtx = { ...d.ctx(), day: null };
      const { plan } = await planText(text, ctx, { online: d.online, aiOn: false, call: d.callAi });
      if (!c.alive(a, 'live_plan')) return true;
      if (plan.items.length === 0 && !plan.ask) return false;
      const out = await c.savePlan(a, plan, text);
      rlog(`voice live saved out=${out} n=${plan.items.length} ms=${Math.round(performance.now() - t0)}`);
      const m = out === 'ok' ? c.batch.mark() : null;
      if (m) void tidy(m, text, clip, ctx);
      else rlog(`voice live ai skip why=${out}`);
      return true;
    },
  };
}
