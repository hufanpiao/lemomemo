// 按住“＋”录音的控制器（B3 任务单 FA-3；整块评审第 1、3、6、7、8 条，第二轮第 11 条和复查项）：状态、提示、每次的代号、选路、记下的这一批；两条路
// 录音上传 voice-rec.ts、手机自带识别 voice-speech.ts 都拿这里的内核（VoiceCore）。纯 TS 闭包工厂，hooks/useVoice.ts 只订阅 view() 和 batch.box
// • 选路（按下的那一下定，满 350 ms 照用；之后额度刷新了也不改路，那时已不在手势里）：
//   离线 → 提示“没网，语音用不了，请用键盘”；麦克风没允许过 → 说明卡，被拒 → “麦克风没有打开”卡；
//   开着 AI、今天有次数、网络不慢 → 录音 → 松手上传 ai-voice；额度用完、没开 AI / 没同意、10 分钟内网络原因失败 2 次 → 手机自带识别
// • 状态、锁定、手指所在区、说明卡、提示一起经 capture-state 的 viewStep 走，不合法的组合拦下
// • 每次录音一个代号（attempt），从开录到存完都有效：丢掉、取消让它作废；每个 await 之后先看“还是不是当前这次”，
//   不是就不发请求、不写库（运行日志 voice attempt N stale at=哪一步）
// • 一份控制器带着自己的这一批（data/saved-batch.ts）、网络慢计数、留着的录音（第二轮复查第 2、3 条）：正式的一份在 hooks/useVoice.ts 模块级，
//   不跟 RecordHost 卸载走（切页回来提示条、确认行还在）；测试各建一份经 RecordHost 的 session 传进去
// • 切到没有底栏的页（RecordHost 卸载）算取消（负责人 11-13 弹窗定，待定 24：原来第二轮第 11 条“当松手处理”作废）：
//   录着的停录、不上传；上传中、整理中（还没开始写库）的中止、不存；已经开始写库的照常存完、不撤
//   （回来能看到“已记下”）。确认行、提示条不动
// • 录着、上传、整理期间占住升级中心的 busy（不被自动重新载入打断），跟着状态走、不跟着组件走（第二轮复查第 1 条）
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
import { speechSupported } from '../../../platform/speech.ts';
import { callAiParse } from './ai-parse-api.ts';
import { callAiVoice, type CallVoice } from './ai-voice-api.ts';
import type { SaveOutcome, Writer } from './capture-save.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import { isFinal, viewStep, type CaptureView, type ViewEvent } from './capture-state.ts';
import { markPlusHeld } from './plus-hint.ts';
import { quotaOutToday } from './quota.ts';
import { BLOB_KEEP_MS, speechByNet, type HoldZone } from './record-logic.ts';
import { createBatchBox, createSavedBatch } from './saved-batch.ts';
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';
import { planText, recordLocal, type CallAi, type TypeCtx, type TypePlan } from './type-flow.ts';
import type { VoiceNote } from './voice-flow.ts';
import { createRecRoute } from './voice-rec.ts';
import { createSpeechPath } from './voice-speech.ts';
import { onlineNow } from '../../../platform/online.ts';

/** 手机自带识别为什么顶上来：quota 额度用完；net 网络慢；off 没开 AI / 没同意；again 用户点了“再说一次” */
export type SpeechWhy = 'quota' | 'net' | 'off' | 'again';

/** 界面要画的全部状态（一个对象，变了整个换掉） */
export interface VoiceView extends CaptureView<VoiceNote> {
  path: 'rec' | 'speech' | null;
  why: SpeechWhy | null;
  /** 刚交出去的录音几秒（提示条“N 秒录音”） */
  secs: number;
}

export const VIEW0: VoiceView = { status: 'idle', capturing: false, path: null, locked: false, zone: null, why: null, card: null, note: null, secs: 0 };

/** 留着录音的两种：到 2 分钟自动关；别的 8 秒 */
const KEEPS: readonly VoiceNote[] = ['ai_failed', 'net_down'];
export const NOTE_MS = 8000;

/** 建控制器时定下的（不给用正式的；测试传桩） */
export interface VoiceIo {
  callVoice?: CallVoice | undefined;
  callAi?: CallAi | undefined;
  online?: (() => boolean) | undefined;
  writer?: Writer | undefined;
  /** 判成查找、总结、取消、改期、完成（B4b-3）：不保存，交给结果层（hooks/useVoice 给，打开 smart-search 的结果层）；raw 是转写 */
  /** from：这一次从哪来（'voice' 按住说话，'quick' exe 快速记录框，见 record） */
  onAsk?: ((ask: AssistAsk, raw: string, aiUsed: 0 | 1, from: string) => void) | undefined;
}

/** 界面每次渲染给最新的一份（useCaptureCtx 给的：这一刻的上下文、能不能用 AI、界面语言，手机自带识别按它听）；卸载后留着最后一份 */
export interface VoiceBind {
  ctx(): TypeCtx;
  aiOn(): boolean;
  lang: Locale;
}

const ioOf = (io: VoiceIo) => ({ callVoice: io.callVoice ?? callAiVoice, callAi: io.callAi ?? callAiParse, online: io.online ?? onlineNow, onAsk: io.onAsk ?? null });
export type VoiceDeps = ReturnType<typeof ioOf> & VoiceBind;

/** 一次录音（或一次手机识别、一次重试）：代号、取消（录音器和上传共用）、录音器、开始写库了没有 */
export interface Attempt {
  id: number;
  ac: AbortController;
  rec: ActiveRecorder | null;
  /** 开始写库（savePlan 里 batch.save 那一步）时置上、不复位：切页不取消这一次，写完照常落地（第 7 条） */
  committed: boolean;
  /** 为什么作废的（drop 的 by）：没作废是 null。录音器晚到时看它（R-417：等 iOS 系统框时松手 too_early） */
  droppedBy: string | null;
  /** 从哪来：按住说话是 'voice'；record 交来的是它的 from（判成别的意图时交给 onAsk） */
  from: string;
}

/** 两条路共用的内核（createCore 给）；控制器本身（createVoiceSession 给） */
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
  /** 今天的次数用完了（按下时选路用；录音路拿到 quota_out 时置上，挂上、按下时从本机重读） */
  let quotaOut = false;

  const go = (e: ViewEvent<VoiceNote>): void => {
    const next = viewStep(v(), e);
    if (next.status !== v().status) rlog(`voice ${v().status}->${next.status} path=${v().path ?? '-'}`);
    st.setState(next, true);
    if (busyNow(next) === (free !== null)) return;
    if (free) {
      free();
      free = null;
    } else {
      const boot = getBoot();
      // 启动还没好就开录：占不住，记一笔（第二轮复查续第 4 条）
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
    // 失败提示留着录音最多 2 分钟，别的 8 秒，到了自动关
    noteTimer = setTimeout(closeNote, KEEPS.includes(n) ? BLOB_KEEP_MS : NOTE_MS);
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
  /** 判成别的意图（B4b-3）：这一次收掉、回到没按，交给结果层（不写库） */
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
    bind(b: VoiceBind) {
      deps = { ...base, ...b };
    },
    batch,
    view: v,
    subscribe: (fn: () => void) => st.subscribe(fn),
    /** 只改不归状态机管的几样；状态、锁定、区、说明卡、提示走 go */
    set: (patch: Partial<Pick<VoiceView, 'path' | 'why' | 'secs'>>) => st.setState(patch),
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
    /** 存这一次：开始写库以后一定落地（负责人定：已开始写库的照常存完），写完不再看这一次还是不是当前的 */
    askOut,
    /** 返回存的结果：'asked' 交给了结果层，'stale' 这一次已作废没存 */
    async savePlan(a: Attempt, p: TypePlan, raw: string): Promise<SaveOutcome | 'ask' | 'asked' | 'stale'> {
      // 手机自带识别走 planText：判成别的意图的在这里分流（录音那一路在 voice-rec 的 voiceFinal 里分）
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
    finish,
    quotaOut: () => quotaOut,
    markQuotaOut(out = true) {
      quotaOut = out;
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
  const speech = createSpeechPath(c);
  /** 按下那一下选的路（null = 录音）：满 350 ms 照用 */
  let picked: SpeechWhy | null = null;
  const exe = isTauri();
  const refreshQuota = (): void => {
    void quotaOutToday(clock.now()).then((q) => c.markQuotaOut(q));
  };
  /** 这次按住走手机自带识别吗（为什么）；null = 录音 */
  const speechWhy = (): SpeechWhy | null => {
    if (speechByNet(rec.net(), clock.now())) return 'net';
    if (!d().aiOn()) return 'off';
    if (c.quotaOut()) return 'quota';
    return null;
  };
  const idleOrFinal = (): boolean => c.view().status === 'idle' || isFinal(c.view().status);

  function finish(): void {
    const v = c.view();
    // 录音器还没开起来就松手了：太短，当丢掉
    if (v.status === 'preparing') discard('too_early');
    else if (v.path === 'speech') speech.stop();
    else rec.stop();
  }
  /** 取消、丢掉（面板上的取消、太短、提示条上点“取消”、切页）都走这一个：这一次作废、手机识别关掉、留着的录音不要了、回到没按。
   *  原来分 discard / abandon 两个，只差丢不丢留着的录音；面板取消、太短都在 start() 之后（那时已经丢过），合成一个行为不变（第 10 条） */
  function discard(by: string): void {
    c.drop(by);
    speech.cancel();
    rec.forget();
    toIdle();
  }
  /** 切页时要中止的：录着的、上传中的、整理中的，并且当前这一次还没开始写库（开始写库的照常存完） */
  const leaveCancels = (): boolean => {
    const v = c.view();
    return (v.capturing || v.status === 'uploading' || v.status === 'organizing') && c.current()?.committed !== true;
  };
  const card = (k: 'ask' | 'denied' | null): void => go({ type: 'card', card: k });

  return {
    view: c.view,
    subscribe: c.subscribe,
    bind: c.bind,
    batch,
    down() {
      picked = speechWhy();
      refreshQuota();
      // 手机自带识别要在手势里 start()：这条路就在按下的这一下里开，没按满 350 ms 再关掉
      if (picked !== null && !exe && lastMicResult() === 'granted' && d().online() && speechSupported() && idleOrFinal()) speech.prime();
    },
    start() {
      if (exe || !idleOrFinal() || c.view().card !== null) {
        speech.drop();
        return false;
      }
      void markPlusHeld(clock.now());
      batch.fresh();
      c.closeNote();
      const mic = lastMicResult();
      const online = d().online();
      rlog(`voice hold start online=${online ? 1 : 0} mic=${mic} route=${picked ?? 'rec'}`);
      if (picked === null || !online || mic !== 'granted') speech.drop();
      if (!online) show('offline');
      else if (mic !== 'granted') {
        rlog(`voice card ${mic === 'denied' ? 'denied' : 'ask'}`);
        card(mic === 'denied' ? 'denied' : 'ask');
      } else if (picked !== null) speech.begin(picked, false);
      else void rec.begin();
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
    idle: () => speech.drop(),
    cancelUpload() {
      rlog('voice upload cancel');
      discard('cancel_upload');
    },
    retry: () => rec.retry(),
    sayAgain() {
      c.closeNote();
      if (!d().online()) return show('offline');
      // 点“再说一次”的这一下就是手势：手机自带识别当场开，面板直接是锁定的样子（取消 / 记下）
      speech.drop();
      speech.begin('again', true);
    },
    /** “改用打字”：收起说明卡、提示（打开打字条由界面接着做） */
    typeInstead() {
      rlog('voice type_instead');
      card(null);
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
    /** 结果层的“改成记下”“都不是 · 按原话记下”、quick-add 交来判成记下的（B4b-3）：原话只按本机规则记下（不花 AI 次数），
     *  走这一批（提示条、撤销和录音同一套）。正在录、正在整理时不接（busy，调用方把原话留作草稿）；没存上是 failed。
     *  day：日历页选中的那天（结果层从日历页打开时），不给按控制器的上下文。进来就切到“整理中”：等 AI 时按住“＋”不会把这一句顶掉 */
    async record(raw: string, from: string, mode: 'local' | 'plan' = 'local', day: DateStr | null = null): Promise<'saved' | 'busy' | 'failed'> {
      if (!idleOrFinal() || raw.trim() === '') {
        rlog(`voice record_raw skip from=${from} busy=${idleOrFinal() ? 0 : 1}`);
        return 'busy';
      }
      batch.fresh();
      c.closeNote();
      rlog(`voice record_raw from=${from} mode=${mode} len=${[...raw].length}`);
      const a = c.begin();
      a.from = from;
      go({ type: 'organize' });
      const ctx = day === null ? d().ctx() : { ...d().ctx(), day };
      // plan：quick-add 交来的一句和打字条一样走 planText（本机规则、AI 判意图），判成别的意图的 savePlan 里交给结果层
      const p = mode === 'local' ? recordLocal(raw, ctx) : (await planText(raw, ctx, { online: d().online, aiOn: d().aiOn(), call: d().callAi, signal: a.ac.signal })).plan;
      if (!c.alive(a, 'record_plan')) return 'failed';
      const out = await c.savePlan(a, p, raw);
      return out === 'ok' || out === 'ask' || out === 'asked' ? 'saved' : 'failed';
    },
    /** 确认行没选就关掉：同一句里已经存了的几条照常在提示条上（能撤）；没存的这条丢掉（录音路没有输入条可以填回）。
     *  额度提示在存成那一刻已经定了，这里不再 land（第 12 条：原来 land 只为更新 quotaDue，还会发一个 idle 下不合法的 done） */
    dismissConfirm() {
      batch.dismiss();
    },
    elapsed: () => (c.view().path === 'rec' ? rec.elapsed() : speech.elapsed()),
    level: () => (c.view().path === 'rec' ? rec.level() : -1),
    /** RecordHost 挂上：重读一次额度；返回卸载（切页）时调的：录着、上传、还没写库的整理算取消（待定 24），已经在写库的照常存完 */
    attach() {
      refreshQuota();
      return () => {
        const cancel = leaveCancels();
        rlog(`voice host detach status=${c.view().status} cancel=${cancel ? 1 : 0}`);
        if (cancel) discard('page_leave');
        speech.drop();
      };
    },
    /** 当前这次作废、手机识别关掉、计时器清掉、busy 放开（测试用完一份调） */
    dispose() {
      c.stop();
      speech.cancel();
    },
  };
}
