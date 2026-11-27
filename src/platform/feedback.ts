// 操作的音效和震动：业务代码只调 fx-api.ts 的 fx(种类)；本模块首屏画完后由 main.tsx 下载、startFx 接上（不占首屏预算）
// • done 双音 + 震；lift 只震；drop 下行音 + 震；pull 只震（过门槛那一下）；delete 下行音 + 震。切底栏不响不震（不调这里）
// • 声音：整个 app 只一个 AudioContext 反复用，放完 AUDIO_RESTORE_MS 后 suspend，开始收音时才 close；总音量 0.5，5kHz 低通
// • 静音键打开也出声：有 navigator.audioSession 就在播之前设成 'playback'，播完改回（不常驻，免得影响之后的录音）
// • 正在录音、语音输入中：不出声、不碰 audioSession、不建 AudioContext，免得和麦克风抢音频
// • 震动：有 navigator.vibrate 用它；否则支持 <input switch> 时为 switch：iOS 只在手指真点到系统开关时给触感（脚本代点不震），
//   所以这里只返回“该震”，由手指下的真开关出触感（fx-api.ts 的 takeBuzz；kit 的 TapSwitch、CheckCircle）。
//   lift、drop、pull 没有 click，iOS 上震不了
// • 开关：settings 的 ui.fx，值为 false 才关，每次调时现读
// • 运行日志：fx <种类> hap=switch|vibrate|none snd=1|0|mic|off，同一种类 LOG_GAP_MS 内只记一行，不记内容
import { fxMicBusy, markBuzz, setFxImpl, type FxKind } from './fx-api.ts';
import { audioCtxCtor } from './live-audio.ts';
import { liveSetting, type LookRow } from './look.ts';
import { rlog } from './run-log-api.ts';

export type { FxKind };
export type HapticPath = 'switch' | 'vibrate' | 'none';

/** settings 的键；值为 false 才算关 */
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

/** settings 行（look.ts 的 LookRow：platform 不能引 core） */
type FxRow = LookRow;

/** 开着吗：不是 false 都算开（用 look.ts 的 liveSetting，和皮肤同一份判断） */
export const fxOnOf = (rows: readonly FxRow[]): boolean => liveSetting(rows, FX_KEY) !== false;

let rowsOf: (() => readonly FxRow[]) | null = null;
/** 这一次调用时的“录着吗”（fx-api 交进来，playbackSession 改回类型时也看它） */
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
 * • switch：这里什么都不做，触感由手指点到的真开关出（不用脚本代点：iOS 上代点一律不震）
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
/** 建过几次 AudioContext（诊断用） */
let made = 0;

/**
 * 播完让 AudioContext 歇着（suspend），不关、不重建：iOS 一页里新建的 AudioContext 多了就不出声。
 * 一直 running 的放音上下文会占着音频会话、让麦克风录成静音，所以收音时由 releaseFxAudio 彻底 close，收完空闲时再建回来
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

/** 开始收音时调：彻底关掉放音上下文，让出音频会话（fx-api.ts 的 releaseFxAudio） */
export function releaseAudio(): void {
  clearTimeout(closeTimer);
  const c = ctx;
  if (!c) return;
  ctx = null;
  master = null;
  const t0 = performance.now();
  // 关完的时刻也记：看识别是不是在上下文没关完时就开始收音
  void c.close().then(
    () => rlog(`fx audio closed ms=${Math.round(performance.now() - t0)}`),
    () => undefined,
  );
  rlog('fx audio close');
}

/** 诊断开关 Fx warm（设置诊断区）：默认 ON；OFF 时这次打开 App 不预建放音上下文，只在真要出声时建 */
const WARM_OFF_KEY = 'lemo-fx-warm-off';
export function fxWarmOn(store: Storage = sessionStorage): boolean {
  try {
    return store.getItem(WARM_OFF_KEY) !== '1';
  } catch {
    return true;
  }
}
export function setFxWarmOn(on: boolean, store: Storage = sessionStorage): void {
  try {
    if (on) store.removeItem(WARM_OFF_KEY);
    else store.setItem(WARM_OFF_KEY, '1');
  } catch {
    /* 存不了：照旧预建 */
  }
}

/**
 * 建 AudioContext 和总音量、低通（不 resume）；建过了直接返回。
 * 在手势里第一次建会让 WebKit 同步起音频通道、卡主线程约 0.35 秒，所以首屏画完后先建好（warmAudio），手势里只 resume 和出声
 */
function makeAudio(why: 'warm' | 'play'): AudioContext | null {
  if (ctx) return ctx;
  const AC = audioCtxCtor();
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

/** 首屏画完后先建好上下文（不出声、不 resume）；开关关着、正在录音、已经建过都不建 */
export function warmAudio(): void {
  if (ctx || fxMicBusy() || !fxOnOf(rowsOf?.() ?? []) || !fxWarmOn()) return;
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

/** ms：这次 fx 在手势里同步占了多久（≥ SLOW_FX_MS 才记） */
function logFx(kind: FxKind, hap: HapticPath | '-', snd: string, ms = 0): void {
  const now = Date.now();
  if (now - (lastLog.get(kind) ?? -Infinity) < LOG_GAP_MS) return;
  lastLog.set(kind, now);
  rlog(`fx ${kind} hap=${hap} snd=${snd}${ms >= SLOW_FX_MS ? ` ms=${Math.round(ms)}` : ''}`);
}
/** fx 同步耗时超过多少 ms 记进日志 */
const SLOW_FX_MS = 30;

/**
 * 这个操作的音效和震动（在手势里同步调）；开关关着时什么都不做。
 * 返回 true = 走系统开关那条路、该震（见 fx-api.ts 的 takeBuzz）
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

/** 设置诊断区“试震动”：不看开关，直接震一下，返回走的哪条路。iOS 上由按钮里的 TapSwitch 出触感，这里 markBuzz 放它切 */
export function tryHaptic(): HapticPath {
  const hap = haptic();
  if (hap === 'switch') markBuzz();
  rlog(`fx try hap=${hap}`);
  return hap;
}

/** 首屏画完后 main.tsx 调：接上 settings 集合，把实现交给 fx-api，稍后先建好声音 */
export function startFx(c: { getSnapshot(): readonly FxRow[] }): void {
  rowsOf = () => c.getSnapshot();
  setFxImpl(fx, releaseAudio, warmSoon);
  warmSoon();
}
/**
 * 等 WARM_AFTER_MS 再建声音：startFx 后、收音结束上下文被关掉以后。
 * 不用 requestIdleCallback：iOS Safari 没有；等一会儿避开紧跟着的几下点按
 */
function warmSoon(): void {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(warmAudio, WARM_AFTER_MS);
}
/** startFx、收音结束以后多久先建声音（ms） */
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
