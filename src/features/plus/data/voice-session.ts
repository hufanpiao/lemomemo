// 按住“＋”录音的控制器（B3 任务单 FA-3；FA-3 整块评审第 1、3、6、7、8 条）：录音、上传、留着的录音、网络慢计数、每次的代号都在这里。
// 纯 TS（仿 voice-speech.ts 的闭包工厂），界面那一层（hooks/useVoice.ts）只订阅 view() 画面板和提示条
// • 选路（按下的那一下定，满 350 ms 照用；之后额度刷新了也不改路，那时已不在手势里）：
//   离线 → 提示“没网，语音用不了，请用键盘”；麦克风没允许过 → 说明卡，被拒 → “麦克风没有打开”卡；
//   开着 AI、今天有次数、网络不慢 → 录音（platform/recorder.ts）→ 松手上传 ai-voice（voice-flow.ts）；
//   额度用完、没开 AI / 没同意、10 分钟内网络原因失败 2 次 → 手机自带识别（voice-speech.ts），拿到文字走打字同一套 planTyped
// • 每次录音一个代号（attempt），从开录到存完都有效：丢掉、取消、卸载让它作废；每个 await 之后先看“还是不是当前这次”，
//   不是就不发请求、不写库（运行日志 voice attempt N stale at=哪一步）
// • 松手（或点“记下”）面板就收起，进“上传中”：停录那一步也能在提示条上取消（录音器停不下来时最多等 REC_STOP_WAIT_MS）
// • AI 没回应：录音留在内存（最多 2 分钟）可以“重试”（同一段），或“再说一次”（改用手机自带识别）
// • 运行日志：状态转换、选路、代号作废、提示、说明卡各一行，不记转写和说的内容
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { AI_AUDIO_BITS_PER_SECOND, AI_AUDIO_MAX_BYTES } from '../../../../shared/schema/ai.ts';
import { clock } from '../../../platform/clock.ts';
import { isTauri } from '../../../platform/env.ts';
import { lastMicResult } from '../../../platform/perm-mic.ts';
import { requestMic, startRecorder, type ActiveRecorder } from '../../../platform/recorder.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { speechSupported, type SpeechEnd } from '../../../platform/speech.ts';
import type { CallVoice } from './ai-voice-api.ts';
import { captureStep, isFinal, type CaptureEvent, type CaptureStatus } from './capture-state.ts';
import { hold } from './hold-input.ts';
import { markPlusHeld } from './plus-hint.ts';
import { quotaOutToday, rememberQuotaLeft } from './quota.ts';
import { BLOB_KEEP_MS, NET_OK, REC_MAX_MS, isNetFail, keptExpired, netFailed, speechByNet, type HoldZone, type KeptAudio, type NetFallback } from './record-logic.ts';
import { baseReqCtx, planTyped, type CallAi, type TypeCtx, type TypePlan } from './type-flow.ts';
import { sendVoice, toUpload, voiceFinal, type VoiceClip, type VoiceNote, type VoiceResult } from './voice-flow.ts';
import { createSpeechRoute, type SpeechHost } from './voice-speech.ts';

/** 手机自带识别为什么顶上来：quota 额度用完；net 网络慢；off 没开 AI / 没同意；again 用户点了“再说一次” */
export type SpeechWhy = 'quota' | 'net' | 'off' | 'again';

/** 界面要画的全部状态（一个对象，变了整个换掉） */
export interface VoiceView {
  status: CaptureStatus;
  path: 'rec' | 'speech' | null;
  /** 锁定了（或“再说一次”）：面板出“取消 / 记下” */
  locked: boolean;
  zone: HoldZone;
  why: SpeechWhy | null;
  card: 'ask' | 'denied' | null;
  note: VoiceNote | null;
  /** 刚交出去的录音几秒（提示条“N 秒录音”） */
  secs: number;
}

export const VIEW0: VoiceView = { status: 'idle', path: null, locked: false, zone: null, why: null, card: null, note: null, secs: 0 };

/** 留着录音的两种：到 2 分钟自动关；别的 8 秒 */
const KEEPS: readonly VoiceNote[] = ['ai_failed', 'net_down'];
export const NOTE_MS = 8000;

/** 存这一句的结果：ok 记下了；ask 有过去的月日要问（确认行）；fail 没写进去 */
export type StoreOut = 'ok' | 'ask' | 'fail';

/** 控制器要的外部能力（useVoice 每次渲染给最新的一份） */
export interface VoiceDeps {
  callVoice: CallVoice;
  callAi: CallAi;
  online(): boolean;
  /** 调用这一刻的上下文、能不能用 AI（useCaptureCtx） */
  ctx(): TypeCtx;
  aiOn(): boolean;
  /** 存这一句（useSavedBatch.storeNew，source = voice） */
  store(plan: TypePlan, raw: string): Promise<StoreOut>;
  /** 这一批都存好了（额度提示一天一次） */
  settle(plan: TypePlan): void;
  /** 新的一次按住：上一批的提示条、确认行收起 */
  fresh(): void;
  /** “改用打字”：直接打开打字条 */
  openType(): void;
}

export interface VoiceSession {
  view(): VoiceView;
  subscribe(fn: () => void): () => void;
  // 手势（hooks/voice-sink.ts 转过来）
  down(): void;
  start(): boolean;
  zone(z: HoldZone): void;
  lock(): void;
  finish(): void;
  discard(by: string): void;
  idle(): void;
  // 界面
  cancelUpload(): void;
  retry(): void;
  sayAgain(): void;
  typeInstead(): void;
  closeNote(): void;
  allowMic(): void;
  closeCard(): void;
  /** 确认行、提示条那边走状态机（confirmed、cancel） */
  step(e: CaptureEvent): void;
  note(n: VoiceNote): void;
  /** 这一批都存好了：额度提示、出结果 */
  done(p: TypePlan): void;
  reset(): void;
  elapsed(): number;
  level(): number;
  /** 卸载：当前这次作废、手机识别关掉、计时器清掉 */
  dispose(): void;
}

/** 一次录音（或一次手机识别、一次重试）：代号、取消（录音器和上传共用）、录音器 */
interface Attempt {
  id: number;
  ac: AbortController;
  rec: ActiveRecorder | null;
}

export function createVoiceSession(deps: () => VoiceDeps | null): VoiceSession {
  const d = (): VoiceDeps => {
    const x = deps();
    if (x === null) throw new Error('voice deps not ready');
    return x;
  };
  let v = VIEW0;
  const subs = new Set<() => void>();
  const set = (patch: Partial<VoiceView>): void => {
    v = { ...v, ...patch };
    for (const fn of [...subs]) fn();
  };

  let net: NetFallback = NET_OK;
  let quotaOut = false;
  let kept: KeptAudio | null = null;
  /** 按下那一下选的路（null = 录音）：满 350 ms 照用 */
  let picked: SpeechWhy | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const exe = isTauri();

  // ---------- 代号 ----------
  let seq = 0;
  let cur: Attempt | null = null;
  const begin = (): Attempt => {
    drop('restart');
    cur = { id: ++seq, ac: new AbortController(), rec: null };
    return cur;
  };
  /** 当前这次作废：录音器按取消收拾（停录、关麦克风），上传也一并取消 */
  const drop = (by: string): void => {
    if (!cur) return;
    rlog(`voice attempt ${cur.id} drop by=${by}`);
    cur.ac.abort();
    cur = null;
  };
  /** 走完了（不作废，只是不再是“当前这次”） */
  const end = (a: Attempt): void => {
    if (cur === a) cur = null;
  };
  const alive = (a: Attempt, at: string): boolean => {
    if (cur === a) return true;
    rlog(`voice attempt ${a.id} stale at=${at}`);
    return false;
  };

  // ---------- 状态、提示 ----------
  const go = (e: CaptureEvent): void => {
    const from = v.status;
    const to = captureStep(from, e);
    if (to === from) return;
    rlog(`voice ${from}->${to} path=${v.path ?? '-'}`);
    set({ status: to });
  };
  const toIdle = (): void => go({ type: 'reset' });
  const clearNote = (): void => {
    clearTimeout(noteTimer);
    if (v.note !== null) set({ note: null });
  };
  const closeNote = (): void => {
    clearNote();
    kept = null;
    toIdle();
  };
  const show = (n: VoiceNote): void => {
    rlog(`voice note ${n}`);
    clearTimeout(noteTimer);
    set({ note: n });
    // 失败提示留着录音最多 2 分钟，别的 8 秒，到了自动关
    noteTimer = setTimeout(closeNote, KEEPS.includes(n) ? BLOB_KEEP_MS : NOTE_MS);
  };
  const refreshQuota = (): void => {
    void quotaOutToday(clock.now()).then((q) => {
      quotaOut = q;
    });
  };
  refreshQuota();

  /** 这次按住走手机自带识别吗（为什么）；null = 录音 */
  const speechWhy = (): SpeechWhy | null => {
    if (speechByNet(net, clock.now())) return 'net';
    if (!d().aiOn()) return 'off';
    if (quotaOut) return 'quota';
    return null;
  };
  const lang = (): Locale => (d().ctx().locale === 'ko' ? 'ko-KR' : 'zh-CN');

  // ---------- 记下来 ----------
  const done = (p: TypePlan): void => {
    d().settle(p);
    go({ type: 'done', status: p.status });
  };
  const savePlan = async (a: Attempt, p: TypePlan, raw: string): Promise<void> => {
    if (v.status !== 'organizing') go({ type: 'organize' });
    if (p.items.length === 0) {
      end(a);
      go({ type: 'no_speech' });
      show('nothing');
      return;
    }
    if (!alive(a, 'store')) return;
    const out = await d().store(p, raw);
    if (!alive(a, 'stored')) return;
    end(a);
    if (out === 'ask') go({ type: 'need_confirm' });
    else if (out === 'ok') done(p);
    else {
      go({ type: 'done', status: 'ai_failed' });
      show('not_saved');
    }
  };

  // ---------- 录音路 ----------
  const handle = async (a: Attempt, res: VoiceResult): Promise<void> => {
    const now = clock.now();
    // 只有“AI 没回应”留着录音（可以重试）；网络原因的失败记一笔（10 分钟两次改用手机识别）
    if (res.kind !== 'failed') kept = null;
    else if (res.fail !== null && isNetFail(res.fail)) {
      net = netFailed(net, now);
      if (speechByNet(net, now)) rlog('voice net_slow speech_on');
    }
    if (res.kind === 'record') void rememberQuotaLeft(res.quotaLeft, now);
    if (res.kind === 'quota_out') {
      quotaOut = true;
      void rememberQuotaLeft(0, now);
    }
    const f = voiceFinal(res, d().ctx(), d().online());
    if (f.do === 'save') return savePlan(a, f.plan, f.raw);
    end(a);
    if (f.do === 'idle') return toIdle();
    go(f.status === 'no_speech' ? { type: 'no_speech' } : { type: 'done', status: f.status });
    show(f.note);
  };

  const upload = async (a: Attempt, clip: VoiceClip): Promise<void> => {
    const up = await toUpload(clip);
    if (!alive(a, 'to_upload')) return;
    kept = { blob: up.blob, mime: up.mime, keptAt: clock.now() };
    const res = await sendVoice(up, baseReqCtx(d().ctx()), d().callVoice, { online: d().online, signal: a.ac.signal });
    if (!alive(a, 'send')) return;
    await handle(a, res);
  };

  const beginRec = async (): Promise<void> => {
    const a = begin();
    set({ path: 'rec', why: null, locked: false, zone: null });
    go({ type: 'prepare' });
    const r = await startRecorder({
      maxMs: REC_MAX_MS,
      maxBytes: AI_AUDIO_MAX_BYTES,
      bitsPerSecond: AI_AUDIO_BITS_PER_SECOND,
      signal: a.ac.signal,
      onAutoStop: () => {
        if (cur === a) finish();
      },
    });
    if (!alive(a, 'rec_start')) {
      // 开起来之前就丢掉、松手了：录音器自己按取消收拾（signal）
      if (r.ok) void r.rec.stop();
      return;
    }
    if (!r.ok) {
      end(a);
      hold.reset();
      toIdle();
      if (r.fail === 'denied') set({ card: 'denied' });
      else show('rec_failed');
      return;
    }
    a.rec = r.rec;
    go({ type: 'start', path: 'rec' });
  };

  // ---------- 手机自带识别路（生命周期在 voice-speech.ts） ----------
  const heard = async (a: Attempt, res: SpeechEnd): Promise<void> => {
    hold.reset();
    set({ locked: false });
    if (!res.ok) {
      end(a);
      toIdle();
      if (res.fail === 'denied') set({ card: 'denied' });
      else show(res.fail === 'network' ? 'speech_net' : res.fail === 'timeout' ? 'rec_failed' : 'speech_off');
      return;
    }
    if (v.status === 'preparing') go({ type: 'start', path: 'speech' });
    if (res.text === '') {
      end(a);
      go({ type: 'no_speech' });
      show('no_speech');
      return;
    }
    if (v.status !== 'organizing') go({ type: 'organize' });
    const c = d().ctx();
    const on = d().aiOn();
    const qOut = on ? await quotaOutToday(c.now) : false;
    if (!alive(a, 'speech_quota')) return;
    const p = await planTyped(res.text, c, { online: d().online(), isOnline: d().online, aiOn: on, quotaOut: qOut }, d().callAi);
    if (!alive(a, 'speech_plan')) return;
    if (p.quotaLeft !== null) void rememberQuotaLeft(p.quotaLeft, c.now);
    await savePlan(a, p, res.text);
  };
  const host: SpeechHost = {
    started() {
      if (v.status === 'preparing') go({ type: 'start', path: 'speech' });
    },
    ended(res) {
      if (cur) void heard(cur, res);
    },
    cap: () => finish(),
  };
  const speech = createSpeechRoute(() => host);

  /** 走手机自带识别：按下时先开的那次接手，没有就当场开（调用方在手势里） */
  const beginSpeech = (w: SpeechWhy, lockedNow: boolean): void => {
    const a = begin();
    set({ path: 'speech', why: w, locked: lockedNow, zone: null });
    rlog(`voice speech why=${w}`);
    go({ type: 'prepare' });
    if (speech.take(lang())) return;
    end(a);
    hold.reset();
    toIdle();
    show('speech_off');
  };

  // ---------- 结束、丢掉 ----------
  function finish(): void {
    const st = v.status;
    if (st === 'preparing') {
      // 录音器还没开起来就松手了：太短，当丢掉
      discard('too_early');
      return;
    }
    hold.reset();
    if (v.path === 'speech' && st === 'listening') {
      // 面板收起，进“正在整理”；停不下来时 platform/speech.ts 最多等 SPEECH_STOP_WAIT_MS
      set({ locked: false });
      go({ type: 'organize' });
      speech.stop();
      return;
    }
    const a = cur;
    const rec = a?.rec;
    if (v.path !== 'rec' || st !== 'recording' || !a || !rec) return;
    // 面板收起，提示条“正在听你说的… · 取消”：停录这一步也能取消
    set({ locked: false, secs: Math.max(1, Math.round(rec.elapsed() / 1000)) });
    go({ type: 'stop' });
    void rec.stop().then((r) => {
      if (!alive(a, 'rec_stop')) return;
      if (!r.ok) {
        end(a);
        toIdle();
        show(r.fail === 'empty' ? 'no_speech' : 'rec_failed');
        return;
      }
      void upload(a, r.clip);
    });
  }

  function discard(by: string): void {
    hold.reset();
    drop(by);
    speech.cancel();
    set({ locked: false, zone: null });
    toIdle();
  }

  return {
    view: () => v,
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    down() {
      picked = speechWhy();
      refreshQuota();
      const st = v.status;
      // 手机自带识别要在手势里 start()：这条路就在按下的这一下里开，没按满 350 ms 再关掉
      if (picked !== null && !exe && lastMicResult() === 'granted' && d().online() && speechSupported() && (st === 'idle' || isFinal(st))) speech.prime(lang());
    },
    start() {
      const st = v.status;
      if (exe || (!isFinal(st) && st !== 'idle') || v.card !== null) {
        speech.drop();
        return false;
      }
      void markPlusHeld(clock.now());
      d().fresh();
      kept = null;
      clearNote();
      toIdle();
      const mic = lastMicResult();
      const online = d().online();
      rlog(`voice hold start online=${online ? 1 : 0} mic=${mic} route=${picked ?? 'rec'}`);
      if (!online) {
        speech.drop();
        show('offline');
        return true;
      }
      if (mic !== 'granted') {
        speech.drop();
        rlog(`voice card ${mic === 'denied' ? 'denied' : 'ask'}`);
        set({ card: mic === 'denied' ? 'denied' : 'ask' });
        return true;
      }
      if (picked !== null) {
        beginSpeech(picked, false);
        return true;
      }
      speech.drop();
      void beginRec();
      return true;
    },
    zone(z) {
      rlog(`voice zone ${z ?? '-'}`);
      set({ zone: z });
    },
    lock() {
      rlog('voice lock');
      set({ locked: true, zone: null });
    },
    finish,
    discard,
    idle() {
      speech.drop();
    },
    cancelUpload() {
      rlog('voice upload cancel');
      drop('cancel_upload');
      speech.cancel();
      kept = null;
      toIdle();
    },
    retry() {
      // 连点第二下：已经在上传了
      if (v.status !== 'ai_failed') return;
      const k = kept;
      clearNote();
      if (!k || keptExpired(k, clock.now())) {
        kept = null;
        toIdle();
        return;
      }
      if (!d().online()) {
        show('net_down');
        return;
      }
      rlog(`voice retry bytes=${k.blob.size}`);
      const a = begin();
      go({ type: 'retry' });
      void upload(a, k);
    },
    sayAgain() {
      clearNote();
      kept = null;
      toIdle();
      if (!d().online()) {
        show('offline');
        return;
      }
      // 点“再说一次”的这一下就是手势：手机自带识别当场开，面板直接是锁定的样子（取消 / 记下）
      speech.drop();
      beginSpeech('again', true);
    },
    typeInstead() {
      rlog('voice type_instead');
      set({ card: null });
      closeNote();
      d().openType();
    },
    closeNote,
    allowMic() {
      // 在点按里申请（requestMic 第一步就是同步调 getUserMedia）
      void requestMic().then((r) => {
        rlog(`voice card result=${r}`);
        if (r === 'granted') set({ card: null });
        else if (r === 'denied') set({ card: 'denied' });
        else {
          set({ card: null });
          show('rec_failed');
        }
      });
    },
    closeCard() {
      set({ card: null });
    },
    step: go,
    note: show,
    done,
    reset: toIdle,
    elapsed() {
      if (v.path === 'rec') return cur?.rec?.elapsed() ?? 0;
      return speech.elapsed();
    },
    level() {
      return v.path === 'rec' ? (cur?.rec?.level() ?? -1) : -1;
    },
    dispose() {
      drop('unmount');
      speech.cancel();
      clearTimeout(noteTimer);
      hold.reset();
    },
  };
}
