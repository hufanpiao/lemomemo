// 待办编辑页顶上那一行（ui/VoicePending.tsx）要的：这一条是不是录音那一路先存的占位、现在怎样、点“重试”（data/voice-pending.ts）
// • 走正式的那一份录音控制器（voice-main.ts）：后台整理、留着的录音都在它那里；直接打开编辑页时 RecordHost 可能还没挂过，这里也把上下文交给它（bind）
// • 这次运行里没碰过的（app 关掉又打开、点开之前没挂过“＋”）：读本机库里有没有留着的录音
// • 点“重试”：开始传了就退回上一页（列表上看提示条“正在整理…”和换掉以后的结果）
// • 编辑页开着就登记（控制器这一批的 edit，任何一条待办都登记）：开着的时候 AI 后台整理回来不替换
import { useEffect, useSyncExternalStore } from 'react';
import { backOr } from '../../../app/router-levels.ts';
import type { PendingState } from '../data/voice-pending.ts';
import { pendText } from './pending-text.ts';
import { useCaptureCtx } from './useCaptureCtx.ts';
import { mainVoice } from './voice-main.ts';

export function usePending(id: string): { state: PendingState | null; retry(): void } {
  const s = mainVoice;
  const box = s.pending.box;
  const cap = useCaptureCtx(null);
  s.bind({ ...cap, pend: pendText(cap.lang) });
  const state = useSyncExternalStore(box.subscribe, () => box.getState()[id] ?? null, () => null);
  useEffect(() => void s.pending.load(id), [s, id]);
  // 编辑页开着这一条：AI 后台整理回来不替换、占位不改名不撤，关掉编辑页撤掉登记
  useEffect(() => s.batch.edit(id), [s, id]);
  return {
    state,
    retry() {
      void s.retryPending(id).then((out) => {
        if (out === 'started') void backOr('todos');
      });
    },
  };
}
