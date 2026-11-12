// 按住“＋”录音的界面状态（B3 任务单 FA-3；架构 5.1 按住流程、5.9、5.11、14.5；定稿线框“按住‘＋’说话”“记下之后”）
// • 流程全在 data/voice-session.ts 的控制器里（录音、上传、记下的这一批、留着的录音、网络慢计数、每次的代号、升级中心 busy），
//   这里只订阅它的 view() 和这一批的 box 来画，每次渲染把最新的上下文交给它（bind）
// • 正式的控制器只有一份（模块级，FA-3 第二轮第 11 条）：RecordHost 跟着页面卸载（进设置页等没有“＋”的页）时，
//   正在上传、整理的照常传完、存下，回到有“＋”的页重挂，提示条、确认行照常在；录着的当松手处理。测试各建一份从 session 传进来
// • 手势：hooks/voice-sink.ts 把 data/hold-input.ts 的判定结果接到控制器上（挂上才接手，没挂上之前按住“＋”只当点一下）
// • 记下的走 data/saved-batch（source = voice，一个 batch_id），提示条和打字条同一套（SavedNotice）；过去的月日出确认行（R-166）
// • 录音期间压住提醒横幅（REMIND-wiring）：只看 capturing，卸载时控制器已经当松手处理、不再在录，跟着组件放开没有空档
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useHoldReminders } from '../../../kit/hooks/useHoldReminders.ts';
import { createVoiceSession, type VoiceSession } from '../data/voice-session.ts';
import { useCaptureCtx } from './useCaptureCtx.ts';
import { useSavedBatch } from './useSavedBatch.ts';
import { useVoiceSink } from './voice-sink.ts';

/** 录音面板的计时、50 秒起倒数、提示条种类（界面层不直接引 data，A1） */
export { fmtClock, recCountdown } from '../data/record-logic.ts';
export type { VoiceNote } from '../data/voice-flow.ts';

export interface VoiceOpts {
  /** 测试用：自己建的一份控制器（createVoiceSession，可以带桩）；不给用正式的那一份 */
  session?: VoiceSession | undefined;
  /** “改用打字”：打开打字条（App 的 open，经 plus-slot、TypeBarPreload 传进来） */
  onType?: (() => void) | undefined;
}

const main = createVoiceSession();

export type VoiceState = ReturnType<typeof useVoice>;

export function useVoice(o: VoiceOpts = {}) {
  const s = o.session ?? main;
  const v = useSyncExternalStore(s.subscribe, s.view, s.view);
  const { asking, notice } = useSavedBatch(s.batch.box, v.status === 'confirming');
  const cap = useCaptureCtx(null);
  // 面板量好的取消区、锁定区
  const cancelZone = useRef<HTMLDivElement | null>(null);
  const lockZone = useRef<HTMLDivElement | null>(null);
  // 控制器在异步回调里取最新的这一份；卸载后留着（切页时没走完的照常存）
  s.bind(cap);
  useEffect(() => s.attach(), [s]);
  useVoiceSink(s, cancelZone, lockZone);
  useHoldReminders(v.capturing, 'recording');

  // 面板、提示条、确认行、说明卡的动作都在控制器和这一批上；这里只补面板的“取消”和“改用打字”打开打字条
  const { choose, undo, undoOne, merge, closeNotice } = s.batch;
  return {
    ...s, ...v, asking, notice, cancelZone, lockZone, choose, undo, undoOne, merge, closeNotice,
    discard: (): void => s.discard('panel'),
    typeInstead(): void {
      s.typeInstead();
      o.onType?.();
    },
  };
}
