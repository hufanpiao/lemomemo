// 记下来的这一批怎么画（B3 FA-2、FA-3）：存、撤、合并都在 data/saved-batch.ts（纯 TS，FA-3 第二轮复查第 2 条），这里只订阅它的 box
// • confirming（调用方正在出确认行）：只出确认行，不出提示条
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { noticeOf, type BatchBox, type SavedBatch } from '../data/saved-batch.ts';

export type { BatchEntry, BatchNotice } from '../data/saved-batch.ts';

/** 提示条上的几个动作（ui/SavedNotice 直接调；打字条、录音两边交同一份 saved-batch 的） */
export type BatchActs = Pick<SavedBatch, 'undo' | 'undoOne' | 'merge' | 'closeNotice'>;

export function useSavedBatch(box: BatchBox, confirming: boolean) {
  const st = useStore(box);
  const notice = useMemo(() => (confirming ? null : noticeOf(st)), [st, confirming]);
  return { asking: confirming ? (st.ask[0] ?? null) : null, notice };
}
