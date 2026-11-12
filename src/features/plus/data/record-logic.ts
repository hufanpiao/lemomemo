// 录音面板和按住“＋”的纯逻辑（B3 任务单 FA-1、FA-3、Q3；架构 5.1 按住流程、5.11 第 3、4 点）
// • 计时：50 秒起倒数，显示“0:07 / 1:00”；60 秒自动结束只由 platform/recorder.ts 定时停（录音自己结束了界面听 onAutoStop）
// • 上传总超时：底数 UPLOAD_MIN_MS 17 秒（服务器等 Gemini 的 VOICE_TIMEOUT_MS 15 秒 + 2 秒，客户端不能先放弃），每 100 KB（不足按 100 KB 算）加 1 秒，
//   有字节就至少加 1 秒，所以真录音最短 18 秒；上限 22 秒；ai-parse 6 秒
// • 自动重试：只在网络错误、连接都没建立时自动重试，最多 1 次
// • 录音 Blob：只放内存，最多 600 KB（shared/schema/ai.ts 的 AI_AUDIO_MAX_BYTES，由 recorder 判）；识别失败时保留到提示条关闭，最多 2 分钟
// • 按住判定（Q3）：按下 350 ms 还没松开、没挪开算“按住”；之前松开算“点一下”；按下后先挪远了两样都不算。
//   进了录音以后：拖进取消区松开 = 取消，拖进锁定区 = 锁定（松开也继续录）。取消区、锁定区的位置由界面量好，经 zoneAt 传进来
// • 状态全是普通对象，界面放 ref 里，按住和移动期间不触发渲染（Q3：GlassBar 不重新渲染）
// 纯 TS：不准 import React（A1）
import { VOICE_TIMEOUT_MS } from '../../../../shared/schema/ai.ts';
import type { SendFail } from './send-error.ts';

export const REC_MAX_MS = 60_000;
// 录音码率在 shared/schema/ai.ts 的 AI_AUDIO_BITS_PER_SECOND（探测页也要用，app 层引不到这里）
export const REC_COUNTDOWN_FROM_MS = 50_000;
export const AI_PARSE_TIMEOUT_MS = 6_000;
/** 上传总超时的下限：服务器等 Gemini 的 VOICE_TIMEOUT_MS 再加 2 秒网络往返（客户端不能先放弃） */
export const UPLOAD_MIN_MS = VOICE_TIMEOUT_MS + 2_000;
export const UPLOAD_PER_100KB_MS = 1_000;
export const UPLOAD_MAX_MS = 22_000;
export const BLOB_KEEP_MS = 120_000;
export const AUTO_RETRY_MAX = 1;
export const HOLD_MS = 350;
/** 按下后、判定前挪动超过这个（px）就既不算点也不算按住（是在滑动） */
export const HOLD_SLOP_PX = 10;

/** 上传的总超时（毫秒） */
export function uploadTimeoutMs(bytes: number): number {
  const steps = Math.ceil(Math.max(0, bytes) / (100 * 1024));
  return Math.min(UPLOAD_MAX_MS, UPLOAD_MIN_MS + steps * UPLOAD_PER_100KB_MS);
}

/** 倒数还剩几秒；50 秒以前为 null（不显示倒数） */
export function recCountdown(elapsedMs: number): number | null {
  if (elapsedMs < REC_COUNTDOWN_FROM_MS) return null;
  return Math.max(0, Math.ceil((REC_MAX_MS - elapsedMs) / 1000));
}

/** “0:07” 这样的写法（计时、上限共用） */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 这次失败要不要自动再发一次（tried：已经自动重试过几次） */
export const canAutoRetry = (fail: SendFail, tried: number): boolean => fail === 'network' && tried < AUTO_RETRY_MAX;

/** 失败后保留着、等“重试”用的录音 */
export interface KeptAudio {
  blob: Blob;
  mime: string;
  keptAt: number;
}

/** 留着的录音是不是过期了（2 分钟） */
export const keptExpired = (k: KeptAudio, now: number): boolean => now - k.keptAt >= BLOB_KEEP_MS;

// ---------- 按住“＋” ----------

export type HoldZone = 'cancel' | 'lock' | null;

export type HoldPhase =
  /** 没按 */
  | 'idle'
  /** 按下了，还没到 350 ms */
  | 'pressing'
  /** 按住在录 */
  | 'holding'
  /** 锁定了：松开手也在录，等“取消 / 记下” */
  | 'locked';

export interface HoldState {
  phase: HoldPhase;
  downAt: number;
  x: number;
  y: number;
  /** 手指现在在哪个区（holding 时才有意义） */
  zone: HoldZone;
}

export type HoldEvent =
  | { type: 'down'; t: number; x: number; y: number }
  | { type: 'move'; t: number; x: number; y: number; zone: HoldZone }
  | { type: 'tick'; t: number }
  | { type: 'up'; t: number; zone: HoldZone }
  | { type: 'cancel' };

/** 每一步给界面的动作（界面据此开录、停录、打开打字条） */
export type HoldAction = 'none' | 'tap' | 'start' | 'finish' | 'discard' | 'lock';

export const HOLD_IDLE: HoldState = { phase: 'idle', downAt: 0, x: 0, y: 0, zone: null };

const moved = (s: HoldState, x: number, y: number): boolean => Math.hypot(x - s.x, y - s.y) > HOLD_SLOP_PX;

/** 按住判定的一步（纯函数） */
export function holdStep(s: HoldState, e: HoldEvent): { state: HoldState; action: HoldAction } {
  if (e.type === 'cancel') {
    const action: HoldAction = s.phase === 'holding' || s.phase === 'locked' ? 'discard' : 'none';
    return { state: HOLD_IDLE, action };
  }
  switch (s.phase) {
    case 'idle':
      if (e.type === 'down') return { state: { phase: 'pressing', downAt: e.t, x: e.x, y: e.y, zone: null }, action: 'none' };
      return { state: s, action: 'none' };
    case 'pressing':
      if (e.type === 'up') return { state: HOLD_IDLE, action: e.t - s.downAt < HOLD_MS ? 'tap' : 'none' };
      if (e.type === 'move' && moved(s, e.x, e.y)) return { state: HOLD_IDLE, action: 'none' };
      if ((e.type === 'tick' || e.type === 'move') && e.t - s.downAt >= HOLD_MS) {
        return { state: { ...s, phase: 'holding', zone: null }, action: 'start' };
      }
      return { state: s, action: 'none' };
    case 'holding':
      if (e.type === 'move') {
        if (e.zone === 'lock') return { state: { ...s, phase: 'locked', zone: null }, action: 'lock' };
        return { state: { ...s, zone: e.zone }, action: 'none' };
      }
      if (e.type === 'up') return { state: HOLD_IDLE, action: e.zone === 'cancel' ? 'discard' : 'finish' };
      return { state: s, action: 'none' };
    case 'locked':
      // 锁定以后手指的动作都不管，等界面上的“取消 / 记下”（走 cancel 或界面自己 finish）
      return { state: s, action: 'none' };
    default: {
      const never: never = s.phase;
      return never;
    }
  }
}
