// 按住“＋”录音的界面状态（B3 任务单 FA-3；架构 5.1 按住流程、5.9、5.11、14.5；定稿线框“按住‘＋’说话”“记下之后”）
// • 流程全在 data/voice-session.ts 的控制器里（录音、上传、留着的录音、网络慢计数、每次的代号），这里只订阅它的 view() 渲染
// • 手势：hooks/voice-sink.ts 把 data/hold-input.ts 的判定结果接到控制器上（挂上才接手，没挂上之前按住“＋”只当点一下）
// • 记下的走 useSavedBatch（source = voice，一个 batch_id），提示条和打字条同一套（SavedNotice）；过去的月日出确认行（R-166）
// • 录音期间占住升级中心 busy（BUSY-wire）、压住提醒横幅（REMIND-wiring）
// • 和打字条共用：上下文（useCaptureCtx）、存这一批 / 确认行 / 提示条 / 撤销（useSavedBatch）
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useHoldBusy } from '../../../kit/hooks/useHoldBusy.ts';
import { useHoldReminders } from '../../../kit/hooks/useHoldReminders.ts';
import { clock } from '../../../platform/clock.ts';
import { callAiParse } from '../data/ai-parse-api.ts';
import { callAiVoice, type CallVoice } from '../data/ai-voice-api.ts';
import type { Writer } from '../data/capture-save.ts';
import { navOnline, type CallAi } from '../data/type-flow.ts';
import { createVoiceSession, type VoiceDeps, type VoiceView } from '../data/voice-session.ts';
import { useCaptureCtx } from './useCaptureCtx.ts';
import { useSavedBatch, type BatchNotice, type SaveEnv } from './useSavedBatch.ts';
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

export interface VoiceState extends VoiceView {
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

const env = (): SaveEnv => ({ now: clock.now(), tz: currentTz(), day: null });

export function useVoice(o: VoiceOpts = {}): VoiceState {
  const deps = useRef<VoiceDeps | null>(null);
  const [s] = useState(() => createVoiceSession(() => deps.current));
  const v = useSyncExternalStore(s.subscribe, s.view, s.view);
  const cap = useCaptureCtx(null);
  const saved = useSavedBatch(o.writer, v.status === 'confirming', 'voice');
  const { batch, setBatch, setAsk } = saved;
  const cancelZone = useRef<HTMLDivElement | null>(null);
  const lockZone = useRef<HTMLDivElement | null>(null);
  // 控制器在异步回调里取最新的这一份
  deps.current = {
    callVoice: o.callVoice ?? callAiVoice,
    callAi: o.callAi ?? callAiParse,
    online: o.online ?? navOnline,
    ctx: cap.ctx,
    aiOn: cap.aiOn,
    store: async (plan, raw) => {
      const out = await saved.storeNew({ batchId: null, entries: [], plan, raw, remind: false, source: 'voice' }, env());
      return out === 'ok' || out === 'ask' ? out : 'fail';
    },
    settle: saved.settle,
    fresh: () => {
      setBatch(null);
      setAsk([]);
    },
    openType: () => o.onType?.(),
  };
  useEffect(() => () => s.dispose(), [s]);
  useVoiceSink(s, cancelZone, lockZone);

  const capturing = v.status === 'preparing' || v.status === 'recording' || v.status === 'listening';
  useHoldBusy('recording', capturing || v.status === 'uploading' || v.status === 'organizing');
  useHoldReminders(capturing, 'recording');

  return {
    ...v,
    asking: saved.asking,
    notice: saved.notice,
    cancelZone,
    lockZone,
    elapsed: s.elapsed,
    level: s.level,
    finish: s.finish,
    discard: () => s.discard('panel'),
    cancelUpload: s.cancelUpload,
    retry: s.retry,
    sayAgain: s.sayAgain,
    typeInstead: s.typeInstead,
    closeNote: s.closeNote,
    allowMic: s.allowMic,
    closeCard: s.closeCard,
    async choose(c) {
      const plan = batch?.plan;
      const out = await saved.choose(c, env());
      if (out === 'skip' || out === 'more') return;
      if (out !== 'done') return s.note('not_saved');
      s.step({ type: 'confirmed' });
      if (plan) s.done(plan);
    },
    dismissConfirm() {
      setAsk([]);
      s.step({ type: 'cancel' });
      // 同一句里已经存了的几条照常在提示条上（能撤）；没存的这条丢掉（录音路没有输入条可以填回）
      if (batch && batch.entries.length > 0) s.done(batch.plan);
    },
    async undo() {
      if (await saved.undoAll()) s.reset();
    },
    undoOne: saved.undoOne,
    async merge() {
      await saved.merge(env());
    },
    closeNotice() {
      setBatch(null);
      s.reset();
    },
  };
}
