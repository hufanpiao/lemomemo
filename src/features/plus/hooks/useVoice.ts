// 按住“＋”录音的整条流程（B3 任务单 FA-3；架构 5.1 按住流程、5.9、5.11、14.5；定稿线框“按住‘＋’说话”“记下之后”）
// • 手势：模块级的 hold（data/hold-input.ts）经 app/plus-slot.tsx 转给 GlassBar；判定结果交给这里挂着的 sink（setHoldSink，RecordHost 挂上才有）
// • 选路（按住 350 ms 时）：离线 → 直接提示“没网，语音用不了，请用键盘”；麦克风没允许过 → 先出说明卡，被拒 → “麦克风没有打开”卡；
//   开着 AI、今天有次数、网络不慢 → 录音（platform/recorder.ts 的 startRecorder，start 事件到了才算开了）→ 松手上传 ai-voice（data/voice-flow.ts）；
//   额度用完、没开 AI / 没同意、10 分钟内网络原因失败 2 次 → 手机自带识别（platform/speech.ts），拿到文字走打字同一套（type-flow 的 planTyped）
// • 手机自带识别要在手势里 start()：这条路在按下的那一下（down）里就开，没按满 350 ms 就关掉
// • 结果：记下的走 useSavedBatch（source = voice，一个 batch_id），提示条和打字条同一套（SavedNotice）；过去的月日出确认行（R-166）；
//   AI 没回应 → 录音留在内存（最多 2 分钟）可以“重试”，或“再说一次”（改用手机自带识别）
// • 录音期间占住升级中心 busy（BUSY-wire：令牌 30 分钟作废只解除横幅压制、不算释放，在 core/upgrade.ts）、压住提醒横幅（REMIND-wiring）
// • 运行日志：每次状态转换、选路、提示、说明卡各记一行（状态名、耗时、字节数、类型、原因），不记转写和说的内容
// • 和打字条共用：上下文（useCaptureCtx）、存这一批 / 确认行 / 提示条 / 撤销（useSavedBatch）；手机识别那一路的生命周期在 data/voice-speech.ts，
//   返回结果怎么收尾在 data/voice-flow.ts 的 voiceFinal
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { AI_AUDIO_BITS_PER_SECOND, AI_AUDIO_MAX_BYTES } from '../../../../shared/schema/ai.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useHoldBusy } from '../../../kit/hooks/useHoldBusy.ts';
import { useHoldReminders } from '../../../kit/hooks/useHoldReminders.ts';
import { clock } from '../../../platform/clock.ts';
import { isTauri } from '../../../platform/env.ts';
import { lastMicResult } from '../../../platform/perm-mic.ts';
import { requestMic, startRecorder, type ActiveRecorder, type RecClip } from '../../../platform/recorder.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { speechSupported, type SpeechEnd } from '../../../platform/speech.ts';
import { callAiParse } from '../data/ai-parse-api.ts';
import { callAiVoice, type CallVoice } from '../data/ai-voice-api.ts';
import { captureStep, isFinal, type CaptureEvent, type CaptureStatus } from '../data/capture-state.ts';
import type { Writer } from '../data/capture-save.ts';
import { hold, setHoldSink, type HoldSink } from '../data/hold-input.ts';
import { markPlusHeld } from '../data/plus-hint.ts';
import { quotaOutToday, rememberQuotaLeft } from '../data/quota.ts';
import { BLOB_KEEP_MS, NET_OK, REC_MAX_MS, isNetFail, keptExpired, netFailed, speechByNet, type HoldZone, type KeptAudio, type NetFallback } from '../data/record-logic.ts';
import { aiReqCtx, navOnline, planTyped, type CallAi, type TypePlan } from '../data/type-flow.ts';
import { sendVoice, toUpload, voiceFinal, type VoiceNote, type VoiceResult } from '../data/voice-flow.ts';
import { createSpeechRoute, type SpeechHost } from '../data/voice-speech.ts';
import { useCaptureCtx } from './useCaptureCtx.ts';
import { useSavedBatch, type BatchNotice, type SaveEnv } from './useSavedBatch.ts';

/** 录音面板的计时、50 秒起倒数、提示条种类（界面层不直接引 data，A1） */
export { fmtClock, recCountdown } from '../data/record-logic.ts';
export type { VoiceNote } from '../data/voice-flow.ts';

/** 手机自带识别为什么顶上来：quota 额度用完；net 网络慢；off 没开 AI / 没同意；again 用户点了“再说一次” */
export type SpeechWhy = 'quota' | 'net' | 'off' | 'again';

/** 留着录音的两种：到 2 分钟自动关；别的 8 秒 */
const KEEPS: readonly VoiceNote[] = ['ai_failed', 'net_down'];
export const NOTE_MS = 8000;

// ---------- 模块级：跨挂载的网络慢计数（手势那一份在 data/hold-input.ts 的 hold） ----------
let net: NetFallback = NET_OK;

/** 只给测试用 */
export function resetVoiceForTest(): void {
  setHoldSink(null);
  net = NET_OK;
  hold.reset();
}

export interface VoiceOpts {
  callVoice?: CallVoice | undefined;
  callAi?: CallAi | undefined;
  writer?: Writer | undefined;
  online?: (() => boolean) | undefined;
}

export interface VoiceState {
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
  asking: AiItem | null;
  notice: BatchNotice | null;
  /** 面板量好的取消区、锁定区 */
  cancelZone: RefObject<HTMLDivElement | null>;
  lockZone: RefObject<HTMLDivElement | null>;
  elapsed(): number;
  level(): number;
  finish(): void;
  discard(): void;
  cancelUpload(): void;
  retry(): void;
  sayAgain(): void;
  typeInstead(): void;
  closeNote(): void;
  allowMic(): void;
  closeCard(): void;
  choose(c: 'past' | 'next'): Promise<void>;
  dismissConfirm(): void;
  undo(): Promise<void>;
  undoOne(id: string): Promise<void>;
  merge(): Promise<void>;
  closeNotice(): void;
}

export function useVoice(o: VoiceOpts = {}): VoiceState {
  const { callVoice = callAiVoice, callAi = callAiParse, writer, online = navOnline } = o;
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [path, setPath] = useState<'rec' | 'speech' | null>(null);
  const [locked, setLocked] = useState(false);
  const [zone, setZone] = useState<HoldZone>(null);
  const [why, setWhy] = useState<SpeechWhy | null>(null);
  const [card, setCard] = useState<'ask' | 'denied' | null>(null);
  const [note, setNote] = useState<VoiceNote | null>(null);
  const [secs, setSecs] = useState(0);
  const cap = useCaptureCtx(null);
  const saved = useSavedBatch(writer, status === 'confirming', 'voice');
  const { batch, setBatch, setAsk } = saved;

  const statusRef = useRef<CaptureStatus>('idle');
  const pathRef = useRef<'rec' | 'speech' | null>(null);
  const recRef = useRef<ActiveRecorder | null>(null);
  /** 录音器的取消（开录到交出录音一直有效）、上传的取消 */
  const recAc = useRef<AbortController | null>(null);
  const upAc = useRef<AbortController | null>(null);
  const kept = useRef<KeptAudio | null>(null);
  const fab = useRef<HTMLElement | null>(null);
  const quotaOut = useRef(false);
  const cancelZone = useRef<HTMLDivElement | null>(null);
  const lockZone = useRef<HTMLDivElement | null>(null);
  // 异步回调（上传、识别结束）里取最新的上下文和手机识别要报的那一份
  const live = useRef(cap);
  live.current = cap;
  const speechHost = useRef<SpeechHost | null>(null);
  const [speech] = useState(() => createSpeechRoute(() => speechHost.current));

  /** 状态机走一步：变了才记日志、才渲染（不合法的转移原样留着，见 capture-state.ts） */
  const go = useCallback((e: CaptureEvent): void => {
    const from = statusRef.current;
    const to = captureStep(from, e);
    if (to === from) return;
    statusRef.current = to;
    rlog(`voice ${from}->${to} path=${pathRef.current ?? '-'}`);
    setStatus(to);
  }, []);
  const toIdle = useCallback((): void => {
    if (statusRef.current !== 'idle') go({ type: isFinal(statusRef.current) ? 'reset' : 'cancel' });
    if (statusRef.current !== 'idle') go({ type: 'reset' });
  }, [go]);
  const setRoute = (p: 'rec' | 'speech' | null): void => {
    pathRef.current = p;
    setPath(p);
  };
  const show = useCallback((n: VoiceNote | null): void => {
    if (n !== null) rlog(`voice note ${n}`);
    setNote(n);
  }, []);
  const refreshQuota = useCallback((): void => {
    void quotaOutToday(clock.now()).then((v) => {
      quotaOut.current = v;
    });
  }, []);
  useEffect(refreshQuota, [refreshQuota]);

  /** 这次按住走手机自带识别吗（为什么）；null = 录音 */
  const speechWhy = (): SpeechWhy | null => {
    if (speechByNet(net, clock.now())) return 'net';
    if (!live.current.aiOn()) return 'off';
    if (quotaOut.current) return 'quota';
    return null;
  };

  const typeCtx = () => live.current.ctx();
  const lang = (): Locale => (live.current.locale === 'ko' ? 'ko-KR' : 'zh-CN');
  const env = (): SaveEnv => ({ now: clock.now(), tz: currentTz(), day: null });

  // ---------- 记下来 ----------
  const finishPlan = (p: TypePlan): void => {
    saved.settle(p);
    go({ type: 'done', status: p.status });
  };

  const savePlan = async (p: TypePlan, raw: string): Promise<void> => {
    if (statusRef.current !== 'organizing') go({ type: 'organize' });
    if (p.items.length === 0) {
      go({ type: 'no_speech' });
      show('nothing');
      return;
    }
    const out = await saved.storeNew({ batchId: null, entries: [], plan: p, raw, remind: false, source: 'voice' }, env());
    if (out === 'ask') go({ type: 'need_confirm' });
    else if (out === 'ok') finishPlan(p);
    else {
      go({ type: 'done', status: 'ai_failed' });
      show('not_saved');
    }
  };

  // ---------- 录音路 ----------
  const handle = async (res: VoiceResult): Promise<void> => {
    const now = clock.now();
    // 只有“AI 没回应”留着录音（可以重试）；网络原因的失败记一笔（10 分钟两次改用手机识别）
    if (res.kind !== 'failed') kept.current = null;
    else if (res.fail !== null && isNetFail(res.fail)) {
      net = netFailed(net, now);
      if (speechByNet(net, now)) rlog('voice net_slow speech_on');
    }
    if (res.kind === 'record') void rememberQuotaLeft(res.quotaLeft, now);
    if (res.kind === 'quota_out') {
      quotaOut.current = true;
      void rememberQuotaLeft(0, now);
    }
    const f = voiceFinal(res, typeCtx(), online());
    if (f.do === 'save') return savePlan(f.plan, f.raw);
    if (f.do === 'idle') return toIdle();
    go(f.status === 'no_speech' ? { type: 'no_speech' } : { type: 'done', status: f.status });
    show(f.note);
  };

  const upload = async (clip: Pick<RecClip, 'blob' | 'mime'>, ms: number, retry: boolean): Promise<void> => {
    go(retry ? { type: 'retry' } : { type: 'stop', needEncode: false });
    const up = await toUpload(clip);
    kept.current = { blob: up.blob, mime: up.mime, keptAt: clock.now() };
    setSecs(Math.max(1, Math.round(ms / 1000)));
    const ac = new AbortController();
    upAc.current = ac;
    const base = aiReqCtx(typeCtx());
    // day 传的是 null，不会是 bad_default_day；类型上兜一下
    const ctx = base === 'bad_default_day' ? { ...typeCtx(), projects: [], scope: 'main' as const } : base;
    const res = await sendVoice(up, ctx, callVoice, { online, signal: ac.signal });
    if (upAc.current !== ac) return;
    upAc.current = null;
    await handle(res);
  };

  const beginRec = async (): Promise<void> => {
    setRoute('rec');
    setWhy(null);
    setLocked(false);
    setZone(null);
    const ac = new AbortController();
    recAc.current = ac;
    go({ type: 'prepare' });
    const r = await startRecorder({
      maxMs: REC_MAX_MS,
      maxBytes: AI_AUDIO_MAX_BYTES,
      bitsPerSecond: AI_AUDIO_BITS_PER_SECOND,
      signal: ac.signal,
      onAutoStop: () => finish(),
    });
    if (recAc.current !== ac) {
      // 开起来之前就取消、松手了：录音器自己按取消收拾（signal），这里什么都不做
      if (r.ok) void r.rec.stop();
      return;
    }
    if (!r.ok) {
      recAc.current = null;
      hold.reset();
      toIdle();
      if (r.fail === 'denied') setCard('denied');
      else show('rec_failed');
      return;
    }
    recRef.current = r.rec;
    go({ type: 'start', path: 'rec' });
  };

  // ---------- 手机自带识别路（生命周期在 data/voice-speech.ts） ----------
  const heard = async (res: SpeechEnd): Promise<void> => {
    hold.reset();
    setLocked(false);
    if (!res.ok) {
      toIdle();
      if (res.fail === 'denied') setCard('denied');
      else show(res.fail === 'network' ? 'speech_net' : 'speech_off');
      return;
    }
    if (statusRef.current === 'preparing') go({ type: 'start', path: 'speech' });
    if (res.text === '') {
      go({ type: 'no_speech' });
      show('no_speech');
      return;
    }
    go({ type: 'organize' });
    const c = typeCtx();
    const on = live.current.aiOn();
    const qOut = on ? await quotaOutToday(c.now) : false;
    const p = await planTyped(res.text, c, { online: online(), isOnline: online, aiOn: on, quotaOut: qOut }, callAi);
    if (p.quotaLeft !== null) void rememberQuotaLeft(p.quotaLeft, c.now);
    await savePlan(p, res.text);
  };
  speechHost.current = {
    started() {
      if (statusRef.current === 'preparing') go({ type: 'start', path: 'speech' });
    },
    ended(res) {
      void heard(res);
    },
    cap: () => finish(),
  };

  /** 走手机自带识别：按下时先开的那次接手，没有就当场开（调用方在手势里） */
  const beginSpeech = (w: SpeechWhy, lockedNow: boolean): void => {
    setRoute('speech');
    setWhy(w);
    setLocked(lockedNow);
    setZone(null);
    rlog(`voice speech why=${w}`);
    go({ type: 'prepare' });
    if (speech.take(lang())) return;
    hold.reset();
    toIdle();
    show('speech_off');
  };

  // ---------- 结束、丢掉 ----------
  function finish(): void {
    const st = statusRef.current;
    if (st === 'preparing') {
      // 录音器还没开起来就松手了：太短，当取消
      rlog('voice finish too_early');
      discard();
      return;
    }
    if (pathRef.current === 'speech' && st === 'listening') {
      hold.reset();
      speech.stop();
      return;
    }
    if (pathRef.current !== 'rec' || st !== 'recording') return;
    const rec = recRef.current;
    recRef.current = null;
    recAc.current = null;
    hold.reset();
    setLocked(false);
    if (!rec) return;
    void rec.stop().then((end) => {
      if (!end.ok) {
        toIdle();
        show(end.fail === 'empty' ? 'no_speech' : 'rec_failed');
        return;
      }
      void upload(end.clip, end.clip.ms, false);
    });
  }

  function discard(): void {
    hold.reset();
    // 录音器按取消收拾（停录、关麦克风），上传也一并取消
    recAc.current?.abort();
    recAc.current = null;
    upAc.current?.abort();
    upAc.current = null;
    recRef.current = null;
    speech.cancel();
    setLocked(false);
    setZone(null);
    toIdle();
  }

  const clearNote = (): void => {
    setNote(null);
  };

  // ---------- 交给手势的 sink（每次渲染换成最新的闭包） ----------
  const exe = isTauri();
  const sink: HoldSink = {
    down(el) {
      fab.current = el;
      refreshQuota();
      const w = speechWhy();
      // 手机自带识别要在手势里 start()：这条路就在按下的这一下里开，没按满 350 ms 再关掉
      if (w !== null && !exe && lastMicResult() === 'granted' && online() && speechSupported() && statusRef.current === 'idle') speech.prime(lang());
    },
    start() {
      const st = statusRef.current;
      if (exe || (!isFinal(st) && st !== 'idle') || card !== null) {
        speech.drop();
        return false;
      }
      void markPlusHeld(clock.now());
      setBatch(null);
      setAsk([]);
      kept.current = null;
      clearNote();
      if (isFinal(st)) go({ type: 'reset' });
      const mic = lastMicResult();
      const w = speechWhy();
      rlog(`voice hold start online=${online() ? 1 : 0} mic=${mic} route=${w ?? 'rec'}`);
      if (!online()) {
        speech.drop();
        show('offline');
        return true;
      }
      if (mic !== 'granted') {
        speech.drop();
        rlog(`voice card ${mic === 'denied' ? 'denied' : 'ask'}`);
        setCard(mic === 'denied' ? 'denied' : 'ask');
        return true;
      }
      if (w !== null) {
        beginSpeech(w, false);
        return true;
      }
      speech.drop();
      void beginRec();
      return true;
    },
    zoneAt(x, y) {
      const inside = (el: HTMLElement | null): boolean => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      };
      if (inside(cancelZone.current)) return 'cancel';
      if (inside(lockZone.current)) return 'lock';
      return null;
    },
    zone(z) {
      rlog(`voice zone ${z ?? '-'}`);
      setZone(z);
    },
    lock() {
      rlog('voice lock');
      setLocked(true);
      setZone(null);
    },
    finish,
    discard() {
      rlog('voice discard');
      discard();
    },
    idle() {
      speech.drop();
    },
  };
  useEffect(() => {
    setHoldSink(sink);
  });
  useEffect(() => {
    // 录音那一套挂上了（之后按住才有人接手）：真机日志里按下时没有“voice hold start”，先看这一行出没出
    rlog('voice host ready');
    return () => {
      setHoldSink(null);
      hold.reset();
      speech.cancel();
      recAc.current?.abort();
      upAc.current?.abort();
    };
  }, [speech]);

  // 失败提示留着录音最多 2 分钟，别的 8 秒，到了自动关
  useEffect(() => {
    if (note === null) return undefined;
    const t = setTimeout(() => {
      kept.current = null;
      setNote(null);
      toIdle();
    }, KEEPS.includes(note) ? BLOB_KEEP_MS : NOTE_MS);
    return () => clearTimeout(t);
  }, [note, toIdle]);

  // ---------- BUSY-wire、REMIND-wiring ----------
  const capturing = status === 'preparing' || status === 'recording' || status === 'listening';
  useHoldBusy('recording', capturing || status === 'encoding' || status === 'uploading' || status === 'organizing');
  useHoldReminders(capturing, 'recording');

  // ---------- 界面动作 ----------
  const retry = (): void => {
    const k = kept.current;
    clearNote();
    if (!k || keptExpired(k, clock.now())) {
      kept.current = null;
      toIdle();
      return;
    }
    if (!online()) {
      show('net_down');
      return;
    }
    rlog(`voice retry bytes=${k.blob.size}`);
    void upload({ blob: k.blob, mime: k.mime }, secs * 1000, true);
  };

  const sayAgain = (): void => {
    clearNote();
    kept.current = null;
    toIdle();
    if (!online()) {
      show('offline');
      return;
    }
    // 点“再说一次”的这一下就是手势：手机自带识别当场开，面板直接是锁定的样子（取消 / 记下）
    speech.drop();
    beginSpeech('again', true);
  };

  const typeInstead = (): void => {
    rlog('voice type_instead');
    clearNote();
    setCard(null);
    kept.current = null;
    toIdle();
    fab.current?.click();
  };

  const cancelUpload = (): void => {
    rlog('voice upload cancel');
    upAc.current?.abort();
    upAc.current = null;
    kept.current = null;
    toIdle();
  };

  const allowMic = (): void => {
    // 在点按里申请（requestMic 第一步就是同步调 getUserMedia）
    void requestMic().then((r) => {
      rlog(`voice card result=${r}`);
      if (r === 'granted') setCard(null);
      else if (r === 'denied') setCard('denied');
      else {
        setCard(null);
        show('rec_failed');
      }
    });
  };

  const closeCard = (): void => setCard(null);

  const choose = async (c: 'past' | 'next'): Promise<void> => {
    const plan = batch?.plan;
    const out = await saved.choose(c, env());
    if (out === 'skip' || out === 'more') return;
    if (out !== 'done') {
      show('not_saved');
      return;
    }
    go({ type: 'confirmed' });
    if (plan) finishPlan(plan);
  };

  const dismissConfirm = (): void => {
    setAsk([]);
    go({ type: 'cancel' });
    // 同一句里已经存了的几条照常在提示条上（能撤）；没存的这条丢掉（录音路没有输入条可以填回）
    if (batch && batch.entries.length > 0) finishPlan(batch.plan);
  };

  const closeNotice = (): void => {
    setBatch(null);
    toIdle();
  };

  const undo = async (): Promise<void> => {
    await saved.undoAll();
    toIdle();
  };
  const merge = async (): Promise<void> => {
    const out = await saved.merge(env());
    if (out !== 'ok') show('not_saved');
  };

  const elapsed = (): number => {
    if (pathRef.current === 'rec') return recRef.current?.elapsed() ?? 0;
    return speech.elapsed();
  };
  const level = (): number => (pathRef.current === 'rec' ? (recRef.current?.level() ?? -1) : -1);

  return {
    status, path, locked, zone, why, card, note, secs,
    asking: saved.asking,
    notice: saved.notice, cancelZone, lockZone, elapsed, level,
    finish, discard, cancelUpload, retry, sayAgain, typeInstead, closeNote: () => {
      clearNote();
      kept.current = null;
      toIdle();
    },
    allowMic, closeCard, choose, dismissConfirm, undo, undoOne: saved.undoOne, merge, closeNotice,
  };
}
