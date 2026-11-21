// 操作的音效和震动（R-471；负责人 11-17 在方案页试听后定稿“甲/震/甲/震/甲，切底栏不要音效跟震动，静音也播放音效”）：业务代码只调 fx-api.ts 的 fx(种类)，
// 本模块首屏画完后由 app/main.tsx 下载、startFx 接上（首屏净增额度），实现都在这里
// • 定稿（方案页 D:\claude code\柠檬记APP-本机资料\设计方案\2026-11-17_切页与音效\方案.html 的合成参数）：
//   done 勾完成待办：甲（上行双音 784→1175Hz，共约 130ms）+ 震；lift 拖起一行：只震；drop 拖动放下：甲（正弦 300→180Hz，80ms）+ 震；
//   pull 下拉露出搜索框：只震（过门槛那一下）；delete 删除：甲（正弦 620→310Hz，120ms）+ 震。切底栏不响不震（不调这里）
// • 声音：整个 app 只建一个 AudioContext，一直复用；最后一个音放完 AUDIO_RESTORE_MS 后 suspend（不出声、不占音频），开始录音时才 close（见 scheduleIdle、releaseFxAudio）；总音量 0.5，过 5kHz 低通去掉刺耳的高频。每个音起音 4ms、指数衰减
// • 静音键打开也出声：有 navigator.audioSession（iOS 17+）就在要播之前设成 'playback'，播完 AUDIO_RESTORE_MS 后改回原来的类型（不常驻，免得影响之后的录音）
// • 正在录音、语音输入进行中（fx-api.ts 的 setFxMicBusy 注入的判断，plus 的 voice-main.ts 接 mainVoice 的 capturing）：一律不出声、不碰 audioSession、不建 AudioContext，免得和麦克风抢音频
// • 震动：有 navigator.vibrate（Android 等）用它震 HAPTIC_MS；没有但支持 <input type="checkbox" switch>（iOS 18 起）为 switch：
//   iOS 只在手指真点到系统开关时给触感（负责人 11-18 iOS 26.6 真机：脚本代点一律不震），所以这里不动手，只返回“该震”，
//   由手指下的真开关放这一下 click 切过去出触感（fx-api.ts 的 takeBuzz；kit 的 TapSwitch、CheckCircle）。
//   长按拿起（lift）、拖动放下（drop）、下拉过门槛（pull）不是一次点按、没有 click，iOS 上震不了；都没有为 none
// • 开关：settings 的 ui.fx（设置“声音和触感”，默认开；值为 false 才关），startFx 拿 main.tsx 传进来的 settings 集合，每次调时现读；关着时不响不震
// • 运行日志：fx <种类> hap=switch|vibrate|none snd=1|0|mic|off（off：开关关着；mic：录音中不出声），同一种类 LOG_GAP_MS 内只记一行，不记内容
import { fxMicBusy, markBuzz, setFxImpl, type FxKind } from './fx-api.ts';
import { rlog } from './run-log-api.ts';

export type { FxKind };
export type HapticPath = 'switch' | 'vibrate' | 'none';

/** settings 的键（数据字典第 9 节）；值为 false 才算关 */
export const FX_KEY = 'ui.fx';
/** navigator.vibrate 震多久（ms） */
export const HAPTIC_MS = 12;
/** 设成 playback 以后多久改回原来的类型（ms）：最长的音 120ms 加余量 */
export const AUDIO_RESTORE_MS = 400;
/** 同一种类的运行日志隔多久才再记（ms） */
export const LOG_GAP_MS = 1500;

interface Tone {
  f1: number;
  f2?: number;
  /** 从现在起第几秒开始 */
  at?: number;
  /** 秒 */
  len: number;
  vol: number;
}

/** 各种类的音（null = 只震不响） */
export const FX_SOUND: Readonly<Record<FxKind, readonly Tone[] | null>> = {
  done: [
    { f1: 784, len: 0.07, vol: 0.2 },
    { f1: 1175, at: 0.05, len: 0.08, vol: 0.16 },
  ],
  lift: null,
  drop: [{ f1: 300, f2: 180, len: 0.08, vol: 0.3 }],
  pull: null,
  delete: [{ f1: 620, f2: 310, len: 0.12, vol: 0.22 }],
};

/** settings 行（同 look.ts 的 LookRow：platform 不能引 core） */
interface FxRow {
  readonly key?: unknown;
  readonly value?: unknown;
  readonly deleted_at?: unknown;
  readonly undone?: unknown;
}

/** 开着吗：没设过、不是 false 都算开 */
export const fxOnOf = (rows: readonly FxRow[]): boolean => rows.find((r) => r.key === FX_KEY && r.deleted_at == null && r.undone !== true)?.value !== false;

let rowsOf: (() => readonly FxRow[]) | null = null;
/** 这一次调用时的“录着吗”（fx 进来时由 fx-api 交给它，playbackSession 改回类型时也看它） */
let micBusy: () => boolean = () => false;

// —— 震动 ——

export function hapticPath(): HapticPath {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') return 'vibrate';
  if (typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype) return 'switch';
  return 'none';
}

/**
 * 震一下（在用户手势里同步调）；返回走的哪条路。
 * • vibrate：这里直接震
 * • switch（iOS 18 起）：这里什么都不做——触感由手指点到的那个真开关出（fx-api.ts 的 takeBuzz，kit 的 TapSwitch、CheckCircle）。
 *   负责人 11-18 iOS 26.6 真机：代点开关（head / body / input 三种写法、点 label 点 input）全都不震，只有手指点 Finger switch 震，代点写法已删
 */
export function haptic(): HapticPath {
  const path = hapticPath();
  try {
    if (path === 'vibrate') navigator.vibrate(HAPTIC_MS);
  } catch {
    // 不让震：不要紧
  }
  return path;
}

// —— 声音 ——
interface AudioSessionLike {
  type: string;
}
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let restoreTimer: ReturnType<typeof setTimeout> | undefined;
let restoreTo: string | null = null;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
/** 建过几次 AudioContext（诊断用：负责人 11-18“子任务拖动放下最多只有 3 次提示音”，看是不是第 N 次起建不出来或起不来） */
let made = 0;

/**
 * 播完让 AudioContext 歇着（suspend），不关、不重建（负责人 11-18“子任务拖动放下最多只有 3 次提示音”）：
 * 原来每次播完就 close、下次再 new，真机日志 277.95～295 每次放下都是 snd=1 + 0.5s 后 fx audio close，只有前 3 次响——
 * iOS 一页里新建的 AudioContext 多了就不出声。改成一个实例反复 resume / suspend。
 * 原来要关掉的理由（11-18“语音输入第一次以后输入不上去”：一直 running 的放音上下文占着音频会话，麦克风录进来全是静音）
 * 由 releaseFxAudio 管：开始收音时彻底 close，下一次出声再建（一次录音最多多建一个）
 */
function scheduleIdle(afterSec: number): void {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    const c = ctx;
    if (!c || c.state !== 'running') return;
    void c.suspend().then(
      () => rlog(`fx audio idle n=${made}`),
      () => undefined,
    );
  }, afterSec * 1000 + AUDIO_RESTORE_MS);
}

/** 开始收音（录音、手机自带识别）时调：彻底关掉放音上下文，让出音频会话（fx-api.ts 的 releaseFxAudio，plus 的 voice-main.ts 接） */
export function releaseAudio(): void {
  clearTimeout(closeTimer);
  const c = ctx;
  if (!c) return;
  ctx = null;
  master = null;
  void c.close().catch(() => undefined);
  rlog('fx audio close');
}

/**
 * 建 AudioContext 和总音量、低通（不 resume）；建过了直接返回。
 * 负责人 11-21“冷启动后第一次勾待办完成很卡”：467 日志 4.43 按下 → 4.48 fx audio new → 4.82 fx done，这一下按压拖成 402ms（别的点按 60～100ms）——
 * 第一次在手势里建上下文、接到 destination，WebKit 同步起音频通道，卡主线程约 0.35 秒。所以首屏画完后趁空闲先建好（见 warmAudio），手势里只 resume 和出声
 */
function makeAudio(why: 'warm' | 'play'): AudioContext | null {
  if (ctx) return ctx;
  const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const AC = g.AudioContext ?? g.webkitAudioContext;
  if (!AC) return null;
  const t0 = performance.now();
  try {
    ctx = new AC();
  } catch (e) {
    rlog(`fx audio new fail n=${made + 1} err=${e instanceof Error ? e.name : 'unknown'}`);
    return null;
  }
  made++;
  master = ctx.createGain();
  master.gain.value = 0.5;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5000;
  master.connect(lp);
  lp.connect(ctx.destination);
  rlog(`fx audio new n=${made} state=${ctx.state} by=${why} ms=${Math.round(performance.now() - t0)}`);
  return ctx;
}

/** 首屏画完后空闲时先建好上下文（不出声、不 resume，和放完音 suspend 以后一样）；开关关着、正在录音、已经建过都不建 */
export function warmAudio(): void {
  if (ctx || fxMicBusy() || !fxOnOf(rowsOf?.() ?? [])) return;
  makeAudio('warm');
}

function audio(): AudioContext | null {
  if (!makeAudio('play') || !ctx) return null;
  if (ctx.state !== 'running') {
    const c = ctx;
    void c.resume().then(
      () => rlog(`fx audio resume n=${made} state=${c.state}`),
      (e: unknown) => rlog(`fx audio resume fail n=${made} err=${e instanceof Error ? e.name : 'unknown'}`),
    );
  }
  return ctx;
}

/** 静音键打开也出声：播之前设成 playback，过一会儿改回原来的 */
function playbackSession(): void {
  const s = (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession) ?? null;
  if (!s) return;
  try {
    if (restoreTo === null) restoreTo = s.type;
    if (s.type !== 'playback') s.type = 'playback';
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      try {
        // 这期间开始录音了：录音那边的会话类型不归这里管，不改回去
        if (restoreTo !== null && !micBusy() && s.type === 'playback') s.type = restoreTo;
      } catch {
        // 同下
      }
      restoreTo = null;
    }, AUDIO_RESTORE_MS);
  } catch {
    // 设不上：照样播，只是静音键打开时不响
  }
}

function play(tones: readonly Tone[]): boolean {
  playbackSession();
  const c = audio();
  if (!c || !master) return false;
  scheduleIdle(Math.max(...tones.map((t) => (t.at ?? 0) + t.len)) + 0.05);
  for (const t of tones) {
    const at = c.currentTime + 0.005 + (t.at ?? 0);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(t.f1, at);
    if (t.f2 !== undefined && t.f2 !== t.f1) o.frequency.exponentialRampToValueAtTime(t.f2, at + t.len * 0.8);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(t.vol, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + t.len);
    o.connect(g);
    g.connect(master);
    o.start(at);
    o.stop(at + t.len + 0.02);
  }
  return true;
}

// —— 对外 ——
const lastLog = new Map<FxKind, number>();

/** ms：这次 fx 在手势里同步占了多久（≥ SLOW_FX_MS 才记，看第一次勾完成还卡不卡） */
function logFx(kind: FxKind, hap: HapticPath | '-', snd: string, ms = 0): void {
  const now = Date.now();
  if (now - (lastLog.get(kind) ?? -Infinity) < LOG_GAP_MS) return;
  lastLog.set(kind, now);
  rlog(`fx ${kind} hap=${hap} snd=${snd}${ms >= SLOW_FX_MS ? ` ms=${Math.round(ms)}` : ''}`);
}
/** fx 同步耗时超过多少 ms 记进日志 */
const SLOW_FX_MS = 30;

/**
 * 这个操作的音效和震动（在手势里同步调；业务代码经 fx-api.ts 调）；开关关着时什么都不做。
 * 返回 true = 走系统开关那条路、该震：fx-api 记下，手指下的真开关收到这一下的 click 时才放它切（见 fx-api.ts 的 takeBuzz）
 */
export function fx(kind: FxKind, busy: () => boolean = micBusy): boolean {
  micBusy = busy;
  if (!fxOnOf(rowsOf?.() ?? [])) {
    logFx(kind, '-', 'off');
    return false;
  }
  const t0 = performance.now();
  const hap = haptic();
  const tones = FX_SOUND[kind];
  let snd = '0';
  if (tones) {
    if (micBusy()) snd = 'mic';
    else {
      try {
        snd = play(tones) ? '1' : '0';
      } catch {
        snd = '0';
      }
    }
  }
  logFx(kind, hap, snd, performance.now() - t0);
  return hap === 'switch';
}

/**
 * 设置诊断区“试震动”：不看开关，直接震一下，返回走的哪条路（真机上看主屏幕版到底震不震）。
 * iOS 上由按钮里的 TapSwitch 出触感（和左滑“删除”同一套），这里 markBuzz 放它切
 */
export function tryHaptic(): HapticPath {
  const hap = haptic();
  if (hap === 'switch') markBuzz();
  rlog(`fx try hap=${hap}`);
  return hap;
}

/** 首屏画完后 main.tsx 调：接上 settings 集合（同 watchLook 的 collection('settings')），把实现交给 fx-api，空闲时先建好声音（warmAudio） */
export function startFx(c: { getSnapshot(): readonly FxRow[] }): void {
  rowsOf = () => c.getSnapshot();
  setFxImpl(fx, releaseAudio);
  clearTimeout(warmTimer);
  // 不用 requestIdleCallback：iOS Safari 没有；画完以后再等一会儿，避开冷启动头几下点按
  warmTimer = setTimeout(warmAudio, WARM_AFTER_MS);
}
/** startFx 以后多久先建声音（ms） */
export const WARM_AFTER_MS = 300;
let warmTimer: ReturnType<typeof setTimeout> | undefined;

/** 测试用：清掉懒建的东西 */
export function resetFxForTest(): void {
  setFxImpl(null);
  clearTimeout(warmTimer);
  ctx = null;
  master = null;
  clearTimeout(closeTimer);
  rowsOf = null;
  micBusy = () => false;
  clearTimeout(restoreTimer);
  restoreTo = null;
  lastLog.clear();
}
