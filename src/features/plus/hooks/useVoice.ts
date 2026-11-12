// 按住“＋”录音的界面状态（B3 任务单 FA-3；架构 5.1 按住流程、5.9、5.11、14.5；定稿线框“按住‘＋’说话”“记下之后”）
// • 流程全在 data/voice-session.ts 的控制器里（录音、上传、留着的录音、网络慢计数、每次的代号），这里只订阅它的 view() 渲染
// • 控制器和记下的这一批都只有一份（模块级，FA-3 第二轮第 11 条）：RecordHost 跟着页面卸载（进设置页等没有“＋”的页）时，
//   正在上传、整理的照常传完、存下（存用的是卸载前最后一份能力），回到有“＋”的页重挂，提示条、确认行照常在；录着的当松手处理
// • 手势：hooks/voice-sink.ts 把 data/hold-input.ts 的判定结果接到控制器上（挂上才接手，没挂上之前按住“＋”只当点一下）
// • 记下的走 useSavedBatch（source = voice，一个 batch_id），提示条和打字条同一套（SavedNotice）；过去的月日出确认行（R-166）
// • 录音期间占住升级中心 busy（BUSY-wire）、压住提醒横幅（REMIND-wiring）
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import { useHoldBusy } from '../../../kit/hooks/useHoldBusy.ts';
import { useHoldReminders } from '../../../kit/hooks/useHoldReminders.ts';
import { clock } from '../../../platform/clock.ts';
import { callAiParse } from '../data/ai-parse-api.ts';
import { callAiVoice, type CallVoice } from '../data/ai-voice-api.ts';
import type { Writer } from '../data/capture-save.ts';
import { navOnline, type CallAi } from '../data/type-flow.ts';
import { createVoiceSession, resetVoiceNetForTest, type VoiceDeps, type VoiceSession } from '../data/voice-session.ts';
import { useCaptureCtx } from './useCaptureCtx.ts';
import { createBatchBox, useSavedBatch, type SaveEnv } from './useSavedBatch.ts';
import { useVoiceSink } from './voice-sink.ts';

/** 录音面板的计时、50 秒起倒数、提示条种类（界面层不直接引 data，A1） */
export { fmtClock, recCountdown } from '../data/record-logic.ts';
export type { VoiceNote } from '../data/voice-flow.ts';

export interface VoiceOpts {
  callVoice?: CallVoice | undefined;
  callAi?: CallAi | undefined;
  writer?: Writer | undefined;
  online?: (() => boolean) | undefined;
  /** “改用打字”：打开打字条（App 的 open，经 plus-slot、TypeBarPreload 传进来） */
  onType?: (() => void) | undefined;
}

const env = (): SaveEnv => ({ now: clock.now(), tz: currentTz(), day: null });

// ---------- 模块级的那一份 ----------
let depsNow: VoiceDeps | null = null;
let session: VoiceSession | null = null;
let box = createBatchBox();
const voiceSession = (): VoiceSession => (session ??= createVoiceSession(() => depsNow));

/** 只给测试用：控制器、这一批、网络慢计数都换新的 */
export function resetVoiceForTest(): void {
  session?.dispose();
  session = null;
  depsNow = null;
  box = createBatchBox();
  resetVoiceNetForTest();
}

export type VoiceState = ReturnType<typeof useVoice>;

export function useVoice(o: VoiceOpts = {}) {
  const s = voiceSession();
  const v = useSyncExternalStore(s.subscribe, s.view, s.view);
  const cap = useCaptureCtx(null);
  const saved = useSavedBatch({
    writer: o.writer, confirming: v.status === 'confirming', tag: 'voice', source: 'voice', env, box,
    flow: { go: s.step, done: s.done, fail: s.saveFailed, error: () => s.note('not_saved') },
  });
  // 面板量好的取消区、锁定区
  const cancelZone = useRef<HTMLDivElement | null>(null);
  const lockZone = useRef<HTMLDivElement | null>(null);
  // 控制器在异步回调里取最新的这一份；卸载后留着（切页时没走完的照常存）
  depsNow = {
    callVoice: o.callVoice ?? callAiVoice,
    callAi: o.callAi ?? callAiParse,
    online: o.online ?? navOnline,
    ctx: cap.ctx,
    aiOn: cap.aiOn,
    store: saved.save,
    land: saved.land,
    fresh: saved.fresh,
    openType: () => o.onType?.(),
  };
  useEffect(() => s.attach(), [s]);
  useVoiceSink(s, cancelZone, lockZone);

  useHoldBusy('recording', v.capturing || v.status === 'uploading' || v.status === 'organizing');
  useHoldReminders(v.capturing, 'recording');

  return {
    ...v,
    asking: saved.asking,
    notice: saved.notice,
    cancelZone,
    lockZone,
    elapsed: s.elapsed,
    level: s.level,
    finish: s.finish,
    discard: (): void => s.discard('panel'),
    cancelUpload: s.cancelUpload,
    retry: s.retry,
    sayAgain: s.sayAgain,
    typeInstead: s.typeInstead,
    closeNote: s.closeNote,
    allowMic: s.allowMic,
    closeCard: s.closeCard,
    choose: saved.choose,
    dismissConfirm(): void {
      // 同一句里已经存了的几条照常在提示条上（能撤）；没存的这条丢掉（录音路没有输入条可以填回）
      const { batch } = saved.dismiss();
      if (batch && batch.entries.length > 0) saved.land('ok', batch.plan);
    },
    undo: saved.undo,
    undoOne: saved.undoOne,
    merge: saved.merge,
    closeNotice: saved.closeNotice,
  };
}
