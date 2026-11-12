// 按住“＋”录音的控制器（B3 任务单 FA-3；整块评审第 1、3、6、7、8 条，第二轮第 11 条和复查项）：状态、提示、每次的代号、选路；两条路
// 录音上传 voice-rec.ts、手机自带识别 voice-speech.ts 都拿这里的内核（VoiceCore）。纯 TS 闭包工厂，hooks/useVoice.ts 只订阅 view()
// • 选路（按下的那一下定，满 350 ms 照用；之后额度刷新了也不改路，那时已不在手势里）：
//   离线 → 提示“没网，语音用不了，请用键盘”；麦克风没允许过 → 说明卡，被拒 → “麦克风没有打开”卡；
//   开着 AI、今天有次数、网络不慢 → 录音 → 松手上传 ai-voice；额度用完、没开 AI / 没同意、10 分钟内网络原因失败 2 次 → 手机自带识别
// • 状态、锁定、手指所在区、说明卡、提示一起经 capture-state 的 viewStep 走，不合法的组合拦下
// • 每次录音一个代号（attempt），从开录到存完都有效：丢掉、取消让它作废；每个 await 之后先看“还是不是当前这次”，
//   不是就不发请求、不写库（运行日志 voice attempt N stale at=哪一步）
// • 只有一份（hooks/useVoice.ts 模块级），不跟 RecordHost 卸载走：切页时正在上传、整理的照常传完、存下；录着的当松手处理（第 11 条）
// • 手势（hold-input）这里不碰：录完由 hooks/voice-sink.ts 订阅着收尾。运行日志：状态转换、选路、代号作废、提示、说明卡、卸载，不记说的内容
import { createStore } from 'zustand/vanilla';
import { clock } from '../../../platform/clock.ts';
import { isTauri } from '../../../platform/env.ts';
import { lastMicResult } from '../../../platform/perm-mic.ts';
import { requestMic, type ActiveRecorder } from '../../../platform/recorder.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { speechSupported } from '../../../platform/speech.ts';
import type { CallVoice } from './ai-voice-api.ts';
import type { SaveOutcome } from './capture-save.ts';
import { isFinal, viewStep, type CaptureView, type ViewEvent } from './capture-state.ts';
import { markPlusHeld } from './plus-hint.ts';
import { quotaOutToday } from './quota.ts';
import { BLOB_KEEP_MS, speechByNet, type HoldZone } from './record-logic.ts';
import type { CallAi, TypeCtx, TypePlan } from './type-flow.ts';
import type { VoiceNote } from './voice-flow.ts';
import { createRecRoute, netNow } from './voice-rec.ts';
import { createSpeechPath } from './voice-speech.ts';

export { resetVoiceNetForTest } from './voice-rec.ts';

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

/** 控制器要的外部能力（useVoice 每次渲染给最新的一份；卸载后留着最后一份，切页时没走完的照常存） */
export interface VoiceDeps {
  callVoice: CallVoice;
  callAi: CallAi;
  online(): boolean;
  /** 调用这一刻的上下文、能不能用 AI（useCaptureCtx） */
  ctx(): TypeCtx;
  aiOn(): boolean;
  /** 存这一句（useSavedBatch.save，source = voice）；ask = 有过去的月日要问 */
  store(plan: TypePlan, raw: string): Promise<SaveOutcome | 'ask'>;
  /** 存完的去向（useSavedBatch.land，和打字条同一份：ask 出确认行，ok 收尾，别的回到 saveFailed） */
  land(out: SaveOutcome | 'ask', plan: TypePlan): void;
  /** 新的一次按住：上一批的提示条、确认行收起 */
  fresh(): void;
  /** “改用打字”：直接打开打字条 */
  openType(): void;
}

/** 一次录音（或一次手机识别、一次重试）：代号、取消（录音器和上传共用）、录音器 */
export interface Attempt {
  id: number;
  ac: AbortController;
  rec: ActiveRecorder | null;
}

/** 两条路共用的内核（createCore 给）；控制器本身（createVoiceSession 给） */
export type VoiceCore = ReturnType<typeof createCore>;
export type VoiceSession = ReturnType<typeof createVoiceSession>;

/** forget：留着的录音不要了（录音路的） */
function createCore(deps: () => VoiceDeps | null, finish: () => void, forget: () => void) {
  const d = (): VoiceDeps => {
    const x = deps();
    if (x === null) throw new Error('voice deps not ready');
    return x;
  };
  const st = createStore<VoiceView>(() => VIEW0);
  const v = st.getState;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let cur: Attempt | null = null;

  const go = (e: ViewEvent<VoiceNote>): void => {
    const next = viewStep(v(), e);
    if (next.status !== v().status) rlog(`voice ${v().status}->${next.status} path=${v().path ?? '-'}`);
    st.setState(next, true);
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
  /** 当前这次作废：录音器按取消收拾（停录、关麦克风），上传也一并取消 */
  const drop = (by: string): void => {
    if (!cur) return;
    rlog(`voice attempt ${cur.id} drop by=${by}`);
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

  return {
    d,
    view: v,
    subscribe: (fn: () => void) => st.subscribe(fn),
    /** 只改不归状态机管的几样；状态、锁定、区、说明卡、提示走 go */
    set: (patch: Partial<Pick<VoiceView, 'path' | 'why' | 'secs'>>) => st.setState(patch),
    go,
    toIdle,
    show(n: VoiceNote) {
      rlog(`voice note ${n}`);
      clearTimeout(noteTimer);
      go({ type: 'note', note: n });
      // 失败提示留着录音最多 2 分钟，别的 8 秒，到了自动关
      noteTimer = setTimeout(closeNote, KEEPS.includes(n) ? BLOB_KEEP_MS : NOTE_MS);
    },
    clearNote,
    closeNote,
    begin() {
      drop('restart');
      cur = { id: ++seq, ac: new AbortController(), rec: null };
      return cur;
    },
    drop,
    end,
    alive,
    current: () => cur,
    async savePlan(a: Attempt, p: TypePlan, raw: string) {
      if (v().status !== 'organizing') go({ type: 'organize' });
      if (!alive(a, 'store')) return;
      const out = await d().store(p, raw);
      if (!alive(a, 'stored')) return;
      end(a);
      d().land(out, p);
    },
    finish,
    /** 今天的次数用完了（按下时选路用；录音路拿到 quota_out 时置上，挂上、按下时从本机重读） */
    quotaOut: false,
    stop() {
      drop('dispose');
      clearTimeout(noteTimer);
    },
  };
}

export function createVoiceSession(deps: () => VoiceDeps | null) {
  const c = createCore(deps, () => finish(), () => rec.forget());
  const { d, go, show, toIdle } = c;
  const rec = createRecRoute(c);
  const speech = createSpeechPath(c);
  /** 按下那一下选的路（null = 录音）：满 350 ms 照用 */
  let picked: SpeechWhy | null = null;
  const exe = isTauri();
  const refreshQuota = (): void => {
    void quotaOutToday(clock.now()).then((q) => {
      c.quotaOut = q;
    });
  };
  /** 这次按住走手机自带识别吗（为什么）；null = 录音 */
  const speechWhy = (): SpeechWhy | null => {
    if (speechByNet(netNow(), clock.now())) return 'net';
    if (!d().aiOn()) return 'off';
    if (c.quotaOut) return 'quota';
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
  function discard(by: string): void {
    c.drop(by);
    speech.cancel();
    toIdle();
  }
  const card = (k: 'ask' | 'denied' | null): void => go({ type: 'card', card: k });

  return {
    view: c.view,
    subscribe: c.subscribe,
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
      d().fresh();
      rec.forget();
      c.clearNote();
      toIdle();
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
      c.drop('cancel_upload');
      speech.cancel();
      rec.forget();
      toIdle();
    },
    retry: () => rec.retry(),
    sayAgain() {
      c.clearNote();
      rec.forget();
      toIdle();
      if (!d().online()) return show('offline');
      // 点“再说一次”的这一下就是手势：手机自带识别当场开，面板直接是锁定的样子（取消 / 记下）
      speech.drop();
      speech.begin('again', true);
    },
    typeInstead() {
      rlog('voice type_instead');
      card(null);
      c.closeNote();
      d().openType();
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
    step: go,
    note: show,
    /** 这一批都存好了：出结果 */
    done: (p: TypePlan) => go({ type: 'done', status: p.status }),
    /** 新的一句没存上（nothing：一条都没拆出来） */
    saveFailed(out: Exclude<SaveOutcome, 'ok'>) {
      go(out === 'nothing' ? { type: 'no_speech' } : { type: 'done', status: 'ai_failed' });
      show(out === 'nothing' ? 'nothing' : 'not_saved');
    },
    elapsed: () => (c.view().path === 'rec' ? rec.elapsed() : speech.elapsed()),
    level: () => (c.view().path === 'rec' ? rec.level() : -1),
    /** RecordHost 挂上：重读一次额度；返回卸载时调的（录着的当松手处理，上传、整理的不动） */
    attach() {
      refreshQuota();
      return () => {
        rlog(`voice host detach status=${c.view().status}`);
        if (c.view().capturing) finish();
        speech.drop();
      };
    },
    /** 当前这次作废、手机识别关掉、计时器清掉（测试换一份前调） */
    dispose() {
      c.stop();
      speech.cancel();
    },
  };
}
