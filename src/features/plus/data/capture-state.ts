// “＋”记录的状态机（B3 任务单 FA-1；架构 5.9“正在整理和各种失败”、5.11 第 4 点）
// preparing → recording（或兜底的 listening）→ encoding → uploading → organizing
//   → saved / saved_rule / quota_out / offline_saved / no_speech / ai_failed / cancelled
// • 打字没有录音那几步：idle → organizing → 结果（或先 confirming 等用户选过去的日子）
// • ai_failed 时录音留在内存里（最多 2 分钟，record-logic 的 keptExpired），可以“重试”回到 uploading
// • 不合法的转移原样返回旧状态（界面连点、晚到的回调不会把状态弄乱），单测逐条测
// • ui 只按状态渲染提示条；状态里不放录音 Blob（Blob 放 hooks 的 ref 里）
// 纯 TS：不准 import React（A1）

export type CaptureStatus =
  | 'idle'
  /** 说明卡、申请麦克风、MediaRecorder 起来之前 */
  | 'preparing'
  | 'recording'
  /** Web Speech 兜底在听（额度用完、关了 AI、没同意） */
  | 'listening'
  /** 要压 MP3 时在 Worker 里编码；能直传就跳过 */
  | 'encoding'
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
  | 'ai_failed'
  | 'cancelled';

export type FinalStatus = 'saved' | 'saved_rule' | 'quota_out' | 'offline_saved' | 'no_speech' | 'ai_failed' | 'cancelled';

export type CaptureEvent =
  | { type: 'prepare' }
  /** 开录：rec = 录音上传 ai-voice；speech = 手机自带识别 */
  | { type: 'start'; path: 'rec' | 'speech' }
  /** 松手、点“记下”、60 秒到了 */
  | { type: 'stop'; needEncode: boolean }
  | { type: 'encoded' }
  /** 打字回车、兜底拿到文字 */
  | { type: 'organize' }
  | { type: 'need_confirm' }
  | { type: 'confirmed' }
  | { type: 'done'; status: Exclude<FinalStatus, 'cancelled' | 'no_speech'> }
  | { type: 'no_speech' }
  | { type: 'retry' }
  | { type: 'cancel' }
  | { type: 'reset' };

const FINALS: readonly CaptureStatus[] = ['saved', 'saved_rule', 'quota_out', 'offline_saved', 'no_speech', 'ai_failed', 'cancelled'];

export const isFinal = (s: CaptureStatus): s is FinalStatus => FINALS.includes(s);

/** 正在进行（底栏“＋”忙、切页要先问）的几种 */
export const isBusy = (s: CaptureStatus): boolean => s !== 'idle' && !isFinal(s);

/** 这个状态下内存里的录音还要不要留着（失败可以重试） */
export const keepsAudio = (s: CaptureStatus): boolean => s === 'ai_failed' || s === 'encoding' || s === 'uploading';

/** 状态机的一步（纯函数；不合法的转移原样返回） */
export function captureStep(s: CaptureStatus, e: CaptureEvent): CaptureStatus {
  if (e.type === 'reset') return 'idle';
  // 确认行没选就关掉：回到 idle，原话由界面填回输入条（不悄悄按某一种保存，也不算“取消了一条记录”）
  if (e.type === 'cancel') return s === 'confirming' ? 'idle' : isFinal(s) || s === 'idle' ? s : 'cancelled';
  switch (s) {
    case 'idle':
      if (e.type === 'prepare') return 'preparing';
      if (e.type === 'organize') return 'organizing';
      return s;
    case 'preparing':
      if (e.type === 'start') return e.path === 'rec' ? 'recording' : 'listening';
      return s;
    case 'recording':
      if (e.type === 'stop') return e.needEncode ? 'encoding' : 'uploading';
      return s;
    case 'listening':
      if (e.type === 'organize') return 'organizing';
      if (e.type === 'no_speech') return 'no_speech';
      return s;
    case 'encoding':
      if (e.type === 'encoded') return 'uploading';
      if (e.type === 'done' && e.status === 'ai_failed') return 'ai_failed';
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
    case 'cancelled':
      return s;
    default: {
      const never: never = s;
      return never;
    }
  }
}
