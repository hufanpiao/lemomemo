// 按住“＋”录音的界面状态
// • 流程全在 data/voice-session.ts 的控制器里（录音、上传、记下的这一批、留着的录音、每次的代号、升级中心 busy），
//   这里只订阅它的 view() 和这一批的 box 来画，每次渲染把最新的上下文交给它（bind）
// • 正式的控制器只有一份（模块级）：RecordHost 跟着页面卸载（进设置页等没有“＋”的页）时，
//   录着、上传中、还没开始写库的整理一律算取消，已经在写库的照常存完（细则见 voice-session.ts 文件头）；
//   回到有“＋”的页重挂，提示条、确认行照常在。测试各建一份从 session 传进来
// • 手势：hooks/voice-sink.ts 把 data/hold-input.ts 的判定结果接到控制器上（挂上才接手，没挂上之前按住“＋”只当点一下）
// • 记下的走 data/saved-batch（source = voice，一个 batch_id），提示条和打字条同一套（SavedNotice）；过去的月日出确认行
// • 录音期间压住提醒横幅：只看 capturing，卸载时控制器已经按取消停录、不再在录，跟着组件放开没有空档
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { quotaResetClock, quotaResetsToday } from '../../../../shared/logic/ai-quota.ts';
import { navigate } from '../../../app/router.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useHoldReminders } from '../../../kit/hooks/useHoldReminders.ts';
import { clock } from '../../../platform/clock.ts';
import type { VoiceSession } from '../data/voice-session.ts';
import { pendText } from './pending-text.ts';
import { mainVoice } from './voice-main.ts';
import { useCaptureCtx } from './useCaptureCtx.ts';
import { useSavedBatch } from './useSavedBatch.ts';
import { useVoiceSink } from './voice-sink.ts';

/** 录音面板的计时、50 秒起倒数、提示条种类（界面层不直接引 data） */
export { fmtClock, recCountdown } from '../data/record-logic.ts';
export type { VoiceNote } from '../data/voice-flow.ts';

/** 额度恢复的时刻（提示条“语音暂时用不了 · 今天 / 明天 17:00 恢复”）：按 current_tz 的墙上时间 */
export function quotaWhen(): { today: boolean; time: string } {
  const now = clock.now();
  const tz = currentTz();
  return { today: quotaResetsToday(now, tz), time: quotaResetClock(now, tz) };
}

export interface VoiceOpts {
  /** 测试用：自己建的一份控制器（createVoiceSession，可以带桩）；不给用正式的那一份 */
  session?: VoiceSession | undefined;
  /** “改用打字”：打开打字条（App 的 open，经 plus-slot、TypeBarPreload 传进来） */
  onType?: (() => void) | undefined;
}

const main = mainVoice;

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
  s.bind({ ...cap, pend: pendText(cap.lang) });
  useEffect(() => s.attach(), [s]);
  // exe 的快速记录框交来的一句不在这里接：挂在 App 外壳上（voice-main.ts 的 listenQuickAdd，app/plus-slot.tsx 调），不跟着 RecordHost 挂卸
  useVoiceSink(s, cancelZone, lockZone);
  useHoldReminders(v.capturing, 'recording');

  // 面板、提示条、确认行、说明卡的动作都在控制器和这一批上；这里只补面板的“取消”、“改用打字”打开打字条、“去打开”打开设置。
  // 只交界面要用的那几样：不把整个控制器摊进来，免得界面能调 dispose、bind，也免得控制器的 zone() 和 view 的 zone 重名靠先后覆盖
  const { elapsed, level, finish, retry, sayAgain, allowMic, closeCard, closeNote, cancelUpload, dismissConfirm } = s;
  const { choose, undo, undoOne, merge, closeNotice, touch } = s.batch;
  return {
    ...v, asking, notice, cancelZone, lockZone,
    elapsed, level, finish, retry, sayAgain, allowMic, closeCard, closeNote, cancelUpload, dismissConfirm,
    choose, undo, undoOne, merge, closeNotice, touch,
    discard: (): void => s.discard('panel'),
    typeInstead(): void {
      s.typeInstead();
      o.onType?.();
    },
    /** AI 没开挡住时的“去打开”：收起提示，打开设置 › 语音与 AI（同识图的“去打开”） */
    openAi(): void {
      s.openAi();
      void navigate('settings', 'ai');
    },
  };
}
