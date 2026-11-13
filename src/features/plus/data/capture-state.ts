// “＋”记录的状态机（B3 任务单 FA-1；架构 5.9“正在整理和各种失败”、5.11 第 4 点）
// preparing → recording（或兜底的 listening）→ uploading → organizing
//   → saved / saved_rule / quota_out / offline_saved / no_speech / ai_failed
// • 录音中丢掉、取消直接 reset 回 idle（没有“已取消”这个结果；11-13 删掉走不到的 cancelled，FA-3 复查第 5 条）
// • 打字没有录音那几步：idle → organizing → 结果（或先 confirming 等用户选过去的日子）；上一句的结局还没收（提示条开着）时提交新的一句，
//   打字条先发 cleared 收掉结局再 organize（结局本身不接受 organize，录音那边晚到的回调照旧原样返回）
// • ai_failed 时录音留在内存里（最多 2 分钟，record-logic 的 keptExpired），可以“重试”回到 uploading
// • 不合法的转移原样返回旧状态（界面连点、晚到的回调不会把状态弄乱），单测逐条测
// • ui 只按状态渲染提示条；状态里不放录音 Blob（Blob 放 hooks 的 ref 里）
// • 录音那一边的锁定、区、说明卡、提示也走这里（viewStep；FA-3 第二轮复查项），拦下不合法的组合：锁定、区只在录着时有；
//   说明卡只在 idle 出（出了收起提示）；提示只在 idle、结局、确认行时出
// 纯 TS：不准 import React（A1）
import type { HoldZone } from './record-logic.ts';

export type CaptureStatus =
  | 'idle'
  /** 说明卡、申请麦克风、MediaRecorder 起来之前 */
  | 'preparing'
  | 'recording'
  /** Web Speech 兜底在听（额度用完、关了 AI、没同意） */
  | 'listening'
  | 'uploading'
  /** 提示条“正在整理…”（松手起一直显示到出结果） */
  | 'organizing'
  /** 打字：有过去的月日，等用户在确认行选“补记今年 / 明年” */
  | 'confirming'
  | 'saved'
  | 'saved_rule'
  | 'quota_out'
  | 'offline_saved'
  | 'no_speech'
  | 'ai_failed';

export type FinalStatus = 'saved' | 'saved_rule' | 'quota_out' | 'offline_saved' | 'no_speech' | 'ai_failed';

export type CaptureEvent =
  | { type: 'prepare' }
  /** 开录：rec = 录音上传 ai-voice；speech = 手机自带识别 */
  | { type: 'start'; path: 'rec' | 'speech' }
  /** 松手、点“记下”、60 秒到了 */
  | { type: 'stop' }
  /** 打字回车、兜底拿到文字 */
  | { type: 'organize' }
  | { type: 'need_confirm' }
  | { type: 'confirmed' }
  | { type: 'done'; status: Exclude<FinalStatus, 'no_speech'> }
  | { type: 'no_speech' }
  | { type: 'retry' }
  /** 确认行没选就关掉 */
  | { type: 'cancel' }
  /** 提示条关掉、撤光了：只有停在结局时回 idle；正在整理、等确认时原样（打字条等 AI 时旧提示条 8 秒到了，不能把这次提交打回去，复查 N1） */
  | { type: 'cleared' }
  | { type: 'reset' };

const FINALS: readonly CaptureStatus[] = ['saved', 'saved_rule', 'quota_out', 'offline_saved', 'no_speech', 'ai_failed'];

export const isFinal = (s: CaptureStatus): s is FinalStatus => FINALS.includes(s);

/** 状态机的一步（纯函数；不合法的转移原样返回） */
export function captureStep(s: CaptureStatus, e: CaptureEvent): CaptureStatus {
  if (e.type === 'reset') return 'idle';
  if (e.type === 'cleared') return isFinal(s) ? 'idle' : s;
  // 确认行没选就关掉：回到 idle，原话由界面填回输入条（不悄悄按某一种保存，也不算“取消了一条记录”）
  if (e.type === 'cancel') return s === 'confirming' ? 'idle' : s;
  switch (s) {
    case 'idle':
      if (e.type === 'prepare') return 'preparing';
      if (e.type === 'organize') return 'organizing';
      return s;
    case 'preparing':
      if (e.type === 'start') return e.path === 'rec' ? 'recording' : 'listening';
      return s;
    case 'recording':
      if (e.type === 'stop') return 'uploading';
      return s;
    case 'listening':
      if (e.type === 'organize') return 'organizing';
      if (e.type === 'no_speech') return 'no_speech';
      return s;
    case 'uploading':
      if (e.type === 'organize') return 'organizing';
      if (e.type === 'done') return e.status;
      if (e.type === 'no_speech') return 'no_speech';
      return s;
    case 'organizing':
      if (e.type === 'need_confirm') return 'confirming';
      if (e.type === 'done') return e.status;
      if (e.type === 'no_speech') return 'no_speech';
      return s;
    case 'confirming':
      if (e.type === 'confirmed') return 'organizing';
      return s;
    case 'ai_failed':
      if (e.type === 'retry') return 'uploading';
      return s;
    case 'saved':
    case 'saved_rule':
    case 'quota_out':
    case 'offline_saved':
    case 'no_speech':
      return s;
    default: {
      const never: never = s;
      return never;
    }
  }
}

const CAPTURING: readonly CaptureStatus[] = ['preparing', 'recording', 'listening'];
const noteOk = (s: CaptureStatus): boolean => s === 'idle' || s === 'confirming' || isFinal(s);

/** 和 status 一起管的几样（录音那一边的画面）；N 是提示的种类 */
export interface CaptureView<N> {
  status: CaptureStatus;
  /** 录着（面板开着）：preparing / recording / listening */
  capturing: boolean;
  /** 锁定了（或“再说一次”）：面板出“取消 / 记下” */
  locked: boolean;
  zone: HoldZone;
  card: 'ask' | 'denied' | null;
  note: N | null;
}

export type ViewEvent<N> =
  | CaptureEvent
  | { type: 'lock' }
  | { type: 'zone'; zone: HoldZone }
  | { type: 'card'; card: 'ask' | 'denied' | null }
  | { type: 'note'; note: N | null };

/** 带着锁定、区、说明卡、提示走一步（纯函数；不合法的原样返回） */
export function viewStep<N, V extends CaptureView<N>>(v: V, e: ViewEvent<N>): V {
  switch (e.type) {
    case 'lock':
      return v.capturing ? { ...v, locked: true, zone: null } : v;
    case 'zone':
      return v.capturing ? { ...v, zone: e.zone } : v;
    case 'card':
      return e.card === null ? { ...v, card: null } : v.status === 'idle' ? { ...v, card: e.card, note: null } : v;
    case 'note':
      return e.note === null || noteOk(v.status) ? { ...v, note: e.note } : v;
    default: {
      const status = captureStep(v.status, e);
      if (status === v.status) return v;
      const capturing = CAPTURING.includes(status);
      return {
        ...v, status, capturing, locked: capturing && v.locked, zone: capturing ? v.zone : null,
        card: status === 'idle' ? v.card : null, note: noteOk(status) ? v.note : null,
      };
    }
  }
}
