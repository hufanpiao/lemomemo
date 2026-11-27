// 按住“＋”录音的控制器：状态、提示、每次的代号、挡不挡、记下的这一批；
// 录音这一路 voice-rec.ts 拿这里的内核（VoiceCore）。纯 TS 闭包工厂，hooks/useVoice.ts 只订阅 view() 和 batch.box
// • 只有一条路：各平台都是录音 + Gemini 实时转写（voice-gemini.ts）边说边出字，松手不等定稿，已出的字当场存、后台用录音交 ai-voice 补全；
//   一个字没出（令牌拿不到、连不上、没说话），先存“整理中”占位、整段上传 ai-voice（录音不丢）。“再说一次”也走这条，面板直接是锁定的样子。
//   诊断开关 Gemini live 关掉 = 只录音上传。两边的“先存、后台再换”只有一套（voice-pending.ts 的 saveNow + tidyLater）
// • 按下那一刻就挡住，不开麦克风、不录音：离线 → “没网，语音用不了，请用键盘”；AI 没开、没同意 → “语音暂时用不了 · 去打开”；
//   已知今天额度用完 → “语音暂时用不了 · 几点恢复”。麦克风没允许过 → 说明卡，被拒 → “麦克风没有打开”卡。
//   额度是按下后换令牌才知道用完的：令牌回“今天用完”时当场停录、提示，记下剩 0 次，下次按下直接挡（voice-rec.ts 的 stopNow）
// • 状态、锁定、手指所在区、说明卡、提示一起经 capture-state 的 viewStep 走，不合法的组合拦下
// • 每次录音一个代号（attempt），从开录到存完都有效：丢掉、取消让它作废；每个 await 之后先看“还是不是当前这次”，
//   不是就不发请求、不写库（运行日志 voice attempt N stale at=哪一步）
// • 一份控制器带着自己的这一批（data/saved-batch.ts）、网络慢计数、留着的录音：正式的一份在 hooks/useVoice.ts 模块级，
//   不跟 RecordHost 卸载走（切页回来提示条、确认行还在）；测试各建一份经 RecordHost 的 session 传进去
// • 切到没有底栏的页（RecordHost 卸载）：松手存好以后（出过字的先存、没出字的占位）后台照样整理完、换掉，不随切页取消；录着的停录、不上传；
//   松手后还没存好的那一下（停录、要回最后半块音，不到半秒）和占位存不上改走前台上传时，照旧中止、不存；已经开始写库的照常存完。确认行、提示条不动
// • 录着、上传、整理期间占住升级中心的 busy（不被自动重新载入打断），跟着状态走、不跟着组件走；
//   松手存好以后占位的后台整理、换掉的那一下由 voice-pending.ts 自己占
// • 今天用完按 quotaResetAt 同步过期，回到前台（visibilitychange）再从本机读一次
// • 手势（hold-input）这里不碰：录完由 hooks/voice-sink.ts 订阅着收尾。运行日志：状态转换、选路、代号作废、提示、说明卡、卸载，不记说的内容
import { createStore } from 'zustand/vanilla';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { getBoot } from '../../../core/boot.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { clock } from '../../../platform/clock.ts';
import { isTauri } from '../../../platform/env.ts';
import { lastMicResult } from '../../../platform/perm-mic.ts';
import { requestMic, type ActiveRecorder } from '../../../platform/recorder.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { geminiLiveOn, liveSupported } from '../../../platform/live-audio.ts';
import { callAiParse } from './ai-parse-api.ts';
import { callAiVoice, type CallVoice } from './ai-voice-api.ts';
import type { SaveOutcome, Writer } from './capture-save.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import { isFinal, viewStep, type CaptureView, type ViewEvent } from './capture-state.ts';
import { markPlusHeld } from './plus-hint.ts';
import { quotaOutToday, rememberQuotaLeft } from './quota.ts';
import { TOAST_MS } from '../../../../shared/logic/toast.ts';
import { BLOB_KEEP_MS, type HoldZone } from './record-logic.ts';
import { createBatchBox, createSavedBatch } from './saved-batch.ts';
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';
import { planText, recordLocal, type CallAi, type TypeCtx, type TypePlan } from './type-flow.ts';
import type { VoiceNote, VoiceResult } from './voice-flow.ts';
import { createGeminiTap, type LiveIo } from './voice-gemini.ts';
import type { DraftStore, PendText } from './voice-pending.ts';
import { createRecRoute } from './voice-rec.ts';
import { onlineNow } from '../../../platform/online.ts';
import { quotaResetAt } from '../../../../shared/logic/ai-quota.ts';

/** 按下那一刻挡住、不开麦克风的原因：off AI 没开 / 没同意；quota 已知今天额度用完 */
export type BlockWhy = 'off' | 'quota';

/** 界面要画的全部状态（一个对象，变了整个换掉） */
export interface VoiceView extends CaptureView<VoiceNote> {
  /** 刚交出去的录音几秒（提示条“N 秒录音”） */
  secs: number;
  /** 边说边出字：Gemini 实时转写到现在为止认出的全文；还没认出字、只录音上传时是空串 */
  live: string;
}

export const VIEW0: VoiceView = { status: 'idle', capturing: false, locked: false, zone: null, card: null, note: null, secs: 0, live: '' };

/** 留着录音的两种：到 2 分钟自动关；别的同所有提示条（shared/logic/toast.ts 的 TOAST_MS，5 秒） */
const KEEPS: readonly VoiceNote[] = ['ai_failed', 'net_down'];

/** 建控制器时定下的（不给用正式的；测试传桩） */
export interface VoiceIo {
  callVoice?: CallVoice | undefined;
  callAi?: CallAi | undefined;
  online?: (() => boolean) | undefined;
  writer?: Writer | undefined;
  /** 判成查找、总结、取消、改期、完成：不保存，交给结果层（hooks/useVoice 给，打开 smart-search 的结果层）；raw 是转写 */
  /** from：这一次从哪来（'voice' 按住说话，'quick' exe 快速记录框，见 record） */
  onAsk?: ((ask: AssistAsk, raw: string, aiUsed: 0 | 1, from: string) => void) | undefined;
  /** Gemini 实时转写的要令牌、开会话（voice-gemini.ts；测试传桩） */
  live?: LiveIo | undefined;
  /** 占位留着的录音和 AI 结果放哪（voice-pending.ts；测试传桩库，不给用本机库的 drafts 仓） */
  drafts?: DraftStore | null | undefined;
}

/** 界面每次渲染给最新的一份（useCaptureCtx 给的：这一刻的上下文、能不能用 AI、界面语言，实时转写按它听）；卸载后留着最后一份 */
export interface VoiceBind {
  ctx(): TypeCtx;
  aiOn(): boolean;
  lang: Locale;
  /** 整段上传时先存的占位的标题（按界面语言，hooks/pending-text.ts 查好；数据层不引词典） */
  pend: PendText;
}

const ioOf = (io: VoiceIo) => ({ callVoice: io.callVoice ?? callAiVoice, callAi: io.callAi ?? callAiParse, online: io.online ?? onlineNow, onAsk: io.onAsk ?? null });
export type VoiceDeps = ReturnType<typeof ioOf> & VoiceBind;

/** 一次录音（或一次重试）：代号、取消（录音器和上传共用）、录音器、开始写库了没有 */
export interface Attempt {
  id: number;
  ac: AbortController;
  rec: ActiveRecorder | null;
  /** 开始写库（savePlan 里 batch.save 那一步）时置上、不复位：切页不取消这一次，写完照常落地 */
  committed: boolean;
  /** 为什么作废的（drop 的 by）：没作废是 null。录音器晚到时看它（等 iOS 系统框时松手是 too_early） */
  droppedBy: string | null;
  /** 从哪来：按住说话是 'voice'；record 交来的是它的 from（判成别的意图时交给 onAsk） */
  from: string;
  /** 重试的是哪一条占位（voice-pending.ts，待办编辑页点“重试”）：出了结果撤掉它；不是重试占位的没有 */
  pend?: string;
}

/** 录音这一路和实时转写共用的内核（createCore 给）；控制器本身（createVoiceSession 给） */
export type VoiceCore = ReturnType<typeof createCore>;
export type VoiceSession = ReturnType<typeof createVoiceSession>;

/** 录着、上传、整理、等确认行选（选之前那一条还没存，重新载入会丢）：占住升级中心的 busy */
const busyNow = (v: VoiceView): boolean => v.capturing || v.status === 'uploading' || v.status === 'organizing' || v.status === 'confirming';

/** forget：留着的录音不要了（录音路的） */
function createCore(io: VoiceIo, finish: () => void, forget: () => void) {
  const base = ioOf(io);
  let deps: VoiceDeps | null = null;
  const d = (): VoiceDeps => {
    if (deps === null) throw new Error('voice deps not ready');
    return deps;
  };
  const st = createStore<VoiceView>(() => VIEW0);
  const v = st.getState;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let cur: Attempt | null = null;
  let free: (() => void) | null = null;
  /** 今天的次数是什么时候知道用完的（按下时选路用；录音路拿到 quota_out 时记下，挂上、按下、回到前台时从本机重读）；
   *  过了那一天的恢复时刻（quotaResetAt）当场算没用完，不等异步重读 */
  let quotaOutAt: number | null = null;

  const go = (e: ViewEvent<VoiceNote>): void => {
    const step = viewStep(v(), e);
    // 回到没按：边说边出字的字清掉，下次按住不会先闪上一次的字
    const next = step.status === 'idle' && step.live !== '' ? { ...step, live: '' } : step;
    if (next.status !== v().status) rlog(`voice ${v().status}->${next.status}`);
    st.setState(next, true);
    if (busyNow(next) === (free !== null)) return;
    if (free) {
      free();
      free = null;
    } else {
      const boot = getBoot();
      // 启动还没好就开录：占不住，记一笔
      if (!boot) rlog('voice busy skip no_boot');
      free = boot?.upgrade.holdBusy('recording') ?? (() => undefined);
    }
  };
  const toIdle = (): void => go({ type: 'reset' });
  const clearNote = (): void => {
    clearTimeout(noteTimer);
    go({ type: 'note', note: null });
  };
  const closeNote = (): void => {
    clearNote();
    forget();
    toIdle();
  };
  const show = (n: VoiceNote): void => {
    rlog(`voice note ${n}`);
    clearTimeout(noteTimer);
    go({ type: 'note', note: n });
    // 失败提示留着录音最多 2 分钟，别的 5 秒，到了自动关
    noteTimer = setTimeout(closeNote, KEEPS.includes(n) ? BLOB_KEEP_MS : TOAST_MS);
  };
  /** 当前这次作废：录音器按取消收拾（停录、关麦克风），上传也一并取消 */
  const drop = (by: string): void => {
    if (!cur) return;
    rlog(`voice attempt ${cur.id} drop by=${by}`);
    cur.droppedBy = by;
    cur.ac.abort();
    cur = null;
  };
  const end = (a: Attempt): void => {
    if (cur === a) cur = null;
  };
  const alive = (a: Attempt, at: string): boolean => {
    if (cur === a) return true;
    rlog(`voice attempt ${a.id} stale at=${at}`);
    return false;
  };
  /** 判成别的意图：这一次收掉、回到没按，交给结果层（不写库） */
  const askOut = (a: Attempt, ask: AssistAsk, raw: string, aiUsed: 0 | 1): void => {
    if (!alive(a, 'ask')) return;
    end(a);
    toIdle();
    rlog(`voice ask intent=${ask.intent} ai=${aiUsed} len=${[...raw].length}`);
    d().onAsk?.(ask, raw, aiUsed, a.from);
  };
  // 记下的这一批：存完出结果；新的一句没存上（nothing：一条都没拆出来）；确认行选了没存上
  const batch = createSavedBatch({
    box: createBatchBox(), writer: io.writer, tag: 'voice', source: 'voice', env: () => ({ now: clock.now(), tz: currentTz(), day: null }),
    flow: {
      go,
      done: (p) => go({ type: 'done', status: p.status }),
      fail(out) {
        go(out === 'nothing' ? { type: 'no_speech' } : { type: 'done', status: 'ai_failed' });
        show(out === 'nothing' ? 'nothing' : 'not_saved');
      },
      error: () => show('not_saved'),
    },
  });

  return {
    d,
    /** 测试传的写入口（不给是 undefined，用正式的 core/write.ts） */
    writer: io.writer,
    /** 测试传的 drafts 桩库（不给是 undefined，用本机库） */
    drafts: io.drafts,
    bind(b: VoiceBind) {
      deps = { ...base, ...b };
    },
    batch,
    view: v,
    subscribe: (fn: () => void) => st.subscribe(fn),
    /** 只改不归状态机管的几样；状态、锁定、区、说明卡、提示走 go */
    set: (patch: Partial<Pick<VoiceView, 'secs' | 'live'>>) => st.setState(patch),
    go,
    toIdle,
    show,
    clearNote,
    closeNote,
    begin() {
      drop('restart');
      cur = { id: ++seq, ac: new AbortController(), rec: null, committed: false, droppedBy: null, from: 'voice' };
      return cur;
    },
    drop,
    end,
    alive,
    current: () => cur,
    askOut,
    /** 存这一次：开始写库以后一定落地，写完不再看这一次还是不是当前的。
     *  返回存的结果：'asked' 交给了结果层，'stale' 这一次已作废没存 */
    async savePlan(a: Attempt, p: TypePlan, raw: string): Promise<SaveOutcome | 'ask' | 'asked' | 'stale'> {
      // 实时转写出的字走 planText：判成别的意图的在这里分流（上传录音的在 voice-rec 的 voiceFinal 里分）
      if (p.ask) {
        askOut(a, p.ask.ask, raw, p.ask.aiUsed);
        return 'asked';
      }
      if (v().status !== 'organizing') go({ type: 'organize' });
      if (!alive(a, 'store')) return 'stale';
      a.committed = true;
      const out = await batch.save(p, raw);
      end(a);
      batch.land(out, p);
      return out;
    },
    /** savePlan 的结果算不算这一句收下了（存上了、出了确认行、交给了结果层；只此一份） */
    savedOk: (out: SaveOutcome | 'ask' | 'asked' | 'stale'): boolean => out === 'ok' || out === 'ask' || out === 'asked',
    finish,
    /** 没按、或停在结局上（能开新的一次） */
    idle: (): boolean => v().status === 'idle' || isFinal(v().status),
    quotaOut: (): boolean => quotaOutAt !== null && clock.now() < quotaResetAt(quotaOutAt),
    markQuotaOut(out = true) {
      quotaOutAt = out ? clock.now() : null;
    },
    /** 每次 ai-voice（或令牌）回来都记的：剩余次数、用完了 */
    account(res: VoiceResult): void {
      const now = clock.now();
      if (res.kind === 'record' || res.kind === 'intent') void rememberQuotaLeft(res.quotaLeft, now);
      if (res.kind === 'quota_out') {
        quotaOutAt = now;
        void rememberQuotaLeft(0, now);
      }
    },
    stop() {
      drop('dispose');
      clearTimeout(noteTimer);
      free?.();
      free = null;
    },
  };
}

export function createVoiceSession(io: VoiceIo = {}) {
  const c = createCore(io, () => finish(), () => rec.forget());
  const { d, go, show, toIdle, batch } = c;
  const rec = createRecRoute(c);
  /** 录音这一路挂上 Gemini 实时转写：诊断开关 Gemini live 关掉、浏览器没有 AudioWorklet / WebSocket 时只录音上传。
   *  出了字怎么存在 voice-rec.ts（voice-pending.ts 的 saveNow 先存、tidyLater 后台用录音补） */
  const gem = createGeminiTap(c, io.live);
  const gemOn = (): 'on' | 'off' | 'unsup' => (!liveSupported() ? 'unsup' : geminiLiveOn() ? 'on' : 'off');
  /** 按下那一下定的：挡不挡（null = 录音）；满 350 ms 照用 */
  let picked: BlockWhy | null = null;
  const exe = isTauri();
  const refreshQuota = (): void => {
    void quotaOutToday(clock.now()).then((q) => c.markQuotaOut(q));
  };
  /** 这次按住挡不挡：AI 没开、没同意；已知今天额度用完（挂上、按下时从本机重读，令牌回了用完时 voice-rec 记下） */
  const blockWhy = (): BlockWhy | null => (!d().aiOn() ? 'off' : c.quotaOut() ? 'quota' : null);
  const idleOrFinal = c.idle;
  const card = (k: 'ask' | 'denied' | null): void => go({ type: 'card', card: k });

  /** 开录（按住满 350 ms，或点“再说一次”，都还在手势里）：离线、挡住的当场提示、不碰麦克风；麦克风没允许过出说明卡；
   *  否则开录音器、挂 Gemini 实时转写。locked：“再说一次”，面板直接是锁定的样子（取消 / 记下）。返回这一下有没有开录 */
  function open(why: BlockWhy | null, from: string, locked: boolean): boolean {
    const mic = lastMicResult();
    const online = d().online();
    // gm：挂不挂 Gemini 实时转写（on / off 诊断开关关了 / unsup 浏览器没有 AudioWorklet、WebSocket）
    const gm = gemOn();
    rlog(`voice ${from} start online=${online ? 1 : 0} mic=${mic} route=${why ?? 'rec'} gm=${gm}`);
    if (!online) show('offline');
    else if (why !== null) show(why === 'off' ? 'ai_off' : 'quota');
    else if (mic !== 'granted') {
      rlog(`voice card ${mic === 'denied' ? 'denied' : 'ask'}`);
      card(mic === 'denied' ? 'denied' : 'ask');
    } else {
      void rec.begin(gm === 'on' ? gem : null, locked);
      return true;
    }
    return false;
  }

  function finish(): void {
    // 录音器还没开起来就松手了：太短，当丢掉
    if (c.view().status === 'preparing') discard('too_early');
    else rec.stop();
  }
  /** 取消、丢掉（面板上的取消、太短、提示条上点“取消”、切页）都走这一个：这一次作废、留着的录音不要了、回到没按 */
  function discard(by: string): void {
    c.drop(by);
    rec.forget();
    toIdle();
  }
  /** 切页时要中止的：录着的、上传中的、整理中的，并且当前这一次还没开始写库（开始写库的照常存完） */
  const leaveCancels = (): boolean => {
    const v = c.view();
    return (v.capturing || v.status === 'uploading' || v.status === 'organizing') && c.current()?.committed !== true;
  };

  return {
    view: c.view,
    subscribe: c.subscribe,
    bind: c.bind,
    batch,
    down() {
      picked = blockWhy();
      refreshQuota();
      // 按下不碰麦克风（只有长按才调麦克风）：按满 350 ms 由 start() 当场开。
      // start() 在 hold-input.ts 按下时排的 350 ms 计时器里调，WebKit 把手势带进 1 秒内的计时器
      // 要挂 Gemini 实时转写：先下采音模块（不建音频上下文、不要令牌，那些在 start() 的手势里）
      if (!exe && picked === null && gemOn() === 'on') gem.prefetch();
    },
    start() {
      if (exe || !idleOrFinal() || c.view().card !== null) return false;
      void markPlusHeld(clock.now());
      batch.fresh();
      c.closeNote();
      open(picked, 'hold', false);
      return true;
    },
    zone(z: HoldZone) {
      rlog(`voice zone ${z ?? '-'}`);
      go({ type: 'zone', zone: z });
    },
    lock() {
      rlog('voice lock');
      go({ type: 'lock' });
    },
    finish,
    discard,
    cancelUpload() {
      rlog('voice upload cancel');
      discard('cancel_upload');
    },
    retry: () => rec.retry(),
    /** 退回整段上传时先存的占位（voice-pending.ts）：编辑页那一行订阅它 */
    pending: rec.pending,
    /** 待办编辑页点“重试”：用留着的录音前台再传一次（同提示条的“重试”），成了撤掉占位 */
    retryPending: (id: string) => rec.retryPending(id),
    sayAgain() {
      c.closeNote();
      // 点“再说一次”的这一下就是手势：和按住同一条路（录音 + Gemini 出字，失败整段上传），挡住的照样当场提示；面板直接是锁定的样子（取消 / 记下）
      const why = blockWhy();
      if (why === null && gemOn() === 'on') gem.prefetch();
      open(why, 'again', true);
    },
    /** “改用打字”：收起说明卡、提示（打开打字条由界面接着做） */
    typeInstead() {
      rlog('voice type_instead');
      card(null);
      c.closeNote();
    },
    /** “去打开”（AI 没开挡住时）：收起提示（打开设置 › 语音与 AI 由界面接着做） */
    openAi() {
      rlog('voice open_ai');
      c.closeNote();
    },
    closeNote: c.closeNote,
    allowMic() {
      // 在点按里申请（requestMic 第一步就是同步调 getUserMedia）
      void requestMic().then((r) => {
        rlog(`voice card result=${r}`);
        card(r === 'denied' ? 'denied' : null);
        if (r !== 'granted' && r !== 'denied') show('rec_failed');
      });
    },
    closeCard: () => card(null),
    /** 结果层的“改成记下”“都不是 · 按原话记下”、quick-add 交来判成记下的：原话只按本机规则记下（不花 AI 次数），
     *  走这一批（提示条、撤销和录音同一套）。正在录、正在整理时不接（busy，调用方把原话留作草稿）；没存上是 failed。
     *  day：日历页选中的那天（结果层从日历页打开时），不给按控制器的上下文。进来就切到“整理中”：等 AI 时按住“＋”不会把这一句顶掉 */
    async record(raw: string, from: string, mode: 'local' | 'plan' = 'local', day: DateStr | null = null): Promise<'saved' | 'busy' | 'failed'> {
      if (!idleOrFinal() || raw.trim() === '') {
        rlog(`voice record_raw skip from=${from} busy=${idleOrFinal() ? 0 : 1}`);
        return 'busy';
      }
      // 先取上下文：RecordHost 从没挂上过（quick-add 在设置页交来的一句，listenQuickAdd）时在这里就抛，不会卡在“整理中”
      const base = d().ctx();
      batch.fresh();
      c.closeNote();
      rlog(`voice record_raw from=${from} mode=${mode} len=${[...raw].length}`);
      const a = c.begin();
      a.from = from;
      go({ type: 'organize' });
      const ctx = day === null ? base : { ...base, day };
      // plan：quick-add 交来的一句和打字条一样走 planText（本机规则、AI 判意图），判成别的意图的 savePlan 里交给结果层
      const p = mode === 'local' ? recordLocal(raw, ctx) : (await planText(raw, ctx, { online: d().online, aiOn: d().aiOn(), call: d().callAi, signal: a.ac.signal })).plan;
      if (!c.alive(a, 'record_plan')) return 'failed';
      return c.savedOk(await c.savePlan(a, p, raw)) ? 'saved' : 'failed';
    },
    /** 确认行没选就关掉：同一句里已经存了的几条照常在提示条上（能撤）；没存的这条丢掉（录音路没有输入条可以填回）。
     *  额度提示在存成那一刻已经定了，这里不再 land（land 会发一个 idle 下不合法的 done） */
    dismissConfirm() {
      batch.dismiss();
    },
    elapsed: () => rec.elapsed(),
    // 真实音量：实时转写的采音电平，接不上时录音器自己的音量计
    level: () => rec.level(),
    /** RecordHost 挂上：重读一次额度；返回卸载（切页）时调的：录着、上传、还没写库的整理算取消，已经在写库的照常存完 */
    attach() {
      refreshQuota();
      // 回到前台再重读一次：放在后台过了恢复时刻，回来按下不该还挡着
      const onShow = (): void => {
        if (document.visibilityState === 'visible') refreshQuota();
      };
      document.addEventListener('visibilitychange', onShow);
      // 上次 app 被关掉时还在等 AI 的占位改成“没整理成”（每次运行一次）
      void rec.pending.sweep();
      return () => {
        document.removeEventListener('visibilitychange', onShow);
        const cancel = leaveCancels();
        rlog(`voice host detach status=${c.view().status} cancel=${cancel ? 1 : 0}`);
        if (cancel) discard('page_leave');
      };
    },
    /** 当前这次作废、计时器清掉、busy 放开（测试用完一份调） */
    dispose() {
      c.stop();
    },
  };
}
