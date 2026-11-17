// 录音这一路的边说边出字、先存、AI 后台整理（R-456，部分取代 R-62“录音时不边说边出字、松手等 Gemini 回来才存”）。voice-rec.ts 调
// • 识别：按下那一下先开手机自带识别（prime，要在手势里），开录音器时接手（take），和手机自带识别那一路同一套生命周期（voice-speech 的 createSpeechRoute）；
//   认出的字（已定稿 + 没定稿）放进 view 的 live 给面板画，识别交出结局、回到没按时清空。这一次作废（取消、太短、切页）时跟着关（attempt 的 abort，只挂一次）
// • 松手前识别自己结束了（iOS、安卓说话停顿后常这样）而手指还按着：自动重开一次，新认出的字接在后面；
//   重开失败、或者重开后又提前结束：这一次算“断过”（broken），有录音就不先存，整段上传等 AI（不丢后半句）
// • 松手时识别还没开始收音：直接关掉、当没开（不白等 3 秒）
// • 松手以后 voice-rec 等录音器和识别都交了结局，识别出了字交给 quick：
//   先按本机规则存（planText 不开 AI 的那一支），面板、提示条当场回到“已记下”；存成了在后台整理（tidy）：同一段录音交 ai-voice
//   （录音器没录成就把字交 ai-parse），AI 的结果和先存的不一样就经 saved-batch 的 replace 换掉（先存新、再撤旧，和合并同一套）；
//   一样、用户已经动过、AI 失败、松手后 LIVE_LATE_MS 还没回来，都只记日志，不再让人重说。
//   有录音时本机规则判成查找、总结（plan.ask）或一条都拆不出来：不先存，照原来整段上传给 ai-voice（录音不扔）；
//   没录音时一条都拆不出来：当场交 ai-parse 整理再存（同手机自带识别那一路），不出“录音没开起来”
// • 后台整理期间不占升级中心的 busy（已经存下了，被重新载入打断只丢一次整理），只在换的那一下（先存新、再撤旧，几十毫秒）占住，免得换到一半记重了；
//   也不随切页取消（这一次已经存完、代号已经收了）
// • 运行日志（只记字数、字节数、毫秒、原因，不记内容）：voice live take=接手没有；voice live restart n= ok=；voice live not_started；
//   voice live saved out= n= ai=0|1 ms=（从松手算）；voice live ai skip why=（没存成，不整理）；
//   voice live ai via=voice|parse out=same|replaced|not_saved|skip_touched|skip_late|skip_*|failed_* ms=
// 纯 TS：不准 import React（A1）
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { getBoot } from '../../../core/boot.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { SpeechEnd } from '../../../platform/speech.ts';
import type { BatchMark, ReplaceOut } from './saved-batch.ts';
import { baseReqCtx, planText, type TypeCtx, type TypePlan } from './type-flow.ts';
import { sendVoice, toUpload, voiceFinal, type VoiceClip, type VoiceResult } from './voice-flow.ts';
import type { Attempt, VoiceCore } from './voice-session.ts';
import { createSpeechRoute } from './voice-speech.ts';

/** 松手以后 AI 过了这么久才回来就不换了（先存的已经看了很久，再换反倒让人糊涂） */
export const LIVE_LATE_MS = 20_000;

/** 后台整理的结果（日志 out=）：saved-batch 的 replace 给的，或者没交给 replace 的原因 */
type TidyOut = ReplaceOut | `skip_${string}` | `failed_${string}`;
type TidyPlan = { plan: TypePlan; raw: string } | TidyOut;

/** 识别的结局：broken = 中途断过（重开失败、或者重开后又提前结束），后半句可能没听到 */
export interface Heard {
  end: SpeechEnd;
  broken: boolean;
}

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

/** 两段认出的字接起来（韩文按词隔空格） */
const join = (lang: Locale, a: string, b: string): string => (a === '' ? b : b === '' ? a : `${a}${lang === 'ko-KR' ? ' ' : ''}${b}`);

/** 这一次的识别：接手它的那一次、前几段认出的字、重开过几次、断过没有、松手了没有、结局（还没结束 null）、等结局的 */
interface Live {
  a: Attempt;
  said: string;
  restarts: number;
  broken: boolean;
  stopping: boolean;
  got: Heard | null;
  wake: ((h: Heard | null) => void) | null;
}

/** account：每次 ai-voice 回来都要记的（网络慢计数、剩余次数，voice-rec 那一份） */
export function createLiveRoute(c: VoiceCore, account: (res: VoiceResult) => void) {
  let live: Live | null = null;
  const lang = (): Locale => c.d().lang;
  /** 交出结局：等着的拿到，面板上的字清掉 */
  const settle = (l: Live, end: SpeechEnd): void => {
    l.got = { end, broken: l.broken };
    l.wake?.(l.got);
    l.wake = null;
  };
  const route = createSpeechRoute({
    started: () => undefined,
    text(t) {
      if (live && c.current() === live.a) c.set({ live: join(lang(), live.said, t) });
    },
    ended(res) {
      const l = live;
      if (!l) return;
      // 松手前自己结束了、手指还按着：自动重开一次，新认出的接在后面；重开失败或者又提前结束算断过
      if (!l.stopping && res.ok && c.current() === l.a && c.view().capturing) {
        l.said = join(lang(), l.said, res.text);
        const again = l.restarts === 0;
        l.restarts += 1;
        const ok = again && route.take(lang());
        rlog(`voice live restart n=${l.restarts} ok=${ok ? 1 : 0}`);
        if (ok) return;
        l.broken = true;
        settle(l, { ok: true, text: l.said });
        return;
      }
      settle(l, res.ok ? { ok: true, text: join(lang(), l.said, res.text) } : res);
    },
    cap: () => c.finish(),
  });
  /** 识别关掉、不要结局（这一次作废）：等着的当没开 */
  const cancel = (): void => {
    route.cancel();
    live?.wake?.(null);
    live = null;
  };

  /** 后台整理：同一段录音交 ai-voice（录音器没录成就把字交 ai-parse），和先存的不一样就换；松手后 LIVE_LATE_MS 还没回来不换 */
  const tidy = async (m: BatchMark, text: string, clip: VoiceClip | null, ctx: TypeCtx, t0: number): Promise<void> => {
    const t1 = performance.now();
    const d = c.d();
    let got: TidyPlan;
    if (clip) {
      const res = await sendVoice(await toUpload(clip), baseReqCtx(ctx), d.callVoice, { online: d.online });
      account(res);
      got = voicePlan(res, ctx, d.online());
    } else got = parsePlan((await planText(text, ctx, { online: d.online, aiOn: d.aiOn(), call: d.callAi })).plan, text);
    let out: TidyOut;
    if (typeof got === 'string') out = got;
    else if (performance.now() - t0 > LIVE_LATE_MS) out = 'skip_late';
    else {
      const free = getBoot()?.upgrade.holdBusy('recording');
      try {
        out = await c.batch.replace(m, got.plan, got.raw);
      } finally {
        free?.();
      }
    }
    rlog(`voice live ai via=${clip ? 'voice' : 'parse'} out=${out} ms=${Math.round(performance.now() - t1)}`);
  };

  return {
    /** 按下那一下先开（要在手势里） */
    prime: () => route.prime(lang()),
    /** 只关先开、还没接手的那次 */
    drop: () => route.drop(),
    cancel,
    /** 开录音器时接手按下时先开的那次；接手了才挂“这一次作废时一起关” */
    take(a: Attempt): void {
      const on = route.take(lang());
      live = on ? { a, said: '', restarts: 0, broken: false, stopping: false, got: null, wake: null } : null;
      if (on) {
        a.ac.signal.addEventListener(
          'abort',
          () => {
            if (live?.a === a) cancel();
          },
          { once: true },
        );
      }
      rlog(`voice live take=${on ? 1 : 0}`);
    },
    /** 这一次接手了识别 */
    on: (a: Attempt): boolean => live?.a === a,
    /** 这一次的识别已经开始收音、还没结束（录音器开不起来时靠它接着听） */
    listening: (a: Attempt): boolean => live?.a === a && route.listening(),
    /** 松手：停止收音（结局经 heard 拿）。还没开始收音的直接关掉；重开的那次还没开始收音，交出前几段 */
    stop(a: Attempt): void {
      const l = live;
      if (l?.a !== a || l.got) return;
      l.stopping = true;
      if (route.listening()) return route.stop();
      route.cancel();
      if (l.said !== '') return settle(l, { ok: true, text: l.said });
      rlog('voice live not_started');
      l.wake?.(null);
      live = null;
    },
    /** 等这一次识别的结局（stop() 以后 platform/speech.ts 最多等 3 秒）；没开的是 null。拿到以后这一次不再算接手着，面板上的字清掉 */
    async heard(a: Attempt): Promise<Heard | null> {
      const l = live;
      if (l?.a !== a) return null;
      const got = l.got ?? (await new Promise<Heard | null>((ok) => (l.wake = ok)));
      if (live === l) live = null;
      c.set({ live: '' });
      return got;
    },
    elapsed: () => route.elapsed(),
    /** 识别出了字：先存，存成了后台整理。返回 false = 不先存，调用方照原来整段上传等 AI（有录音、本机判成查找总结或一条都拆不出来） */
    async quick(a: Attempt, text: string, clip: VoiceClip | null, t0: number): Promise<boolean> {
      const d = c.d();
      // 录音不带选中的日子（FA-3）：先存和 AI 整理都按这一份，两边才比得上
      const ctx: TypeCtx = { ...d.ctx(), day: null };
      const local = (await planText(text, ctx, { online: d.online, aiOn: false, call: d.callAi })).plan;
      if (!c.alive(a, 'live_plan')) return true;
      const empty = local.items.length === 0 && !local.ask;
      if (clip && (local.ask || empty)) return false;
      // 没录音可传、本机一条都拆不出来：当场交 ai-parse 整理再存（同手机自带识别那一路）
      const plan = empty ? (await planText(text, ctx, { online: d.online, aiOn: d.aiOn(), call: d.callAi, signal: a.ac.signal })).plan : local;
      if (!c.alive(a, 'live_plan_ai')) return true;
      const out = await c.savePlan(a, plan, text);
      rlog(`voice live saved out=${out} n=${plan.items.length} ai=${empty ? 1 : 0} ms=${Math.round(performance.now() - t0)}`);
      const m = out === 'ok' && !empty ? c.batch.mark() : null;
      if (m) void tidy(m, text, clip, ctx, t0);
      else rlog(`voice live ai skip why=${empty ? 'done' : out}`);
      return true;
    },
  };
}
