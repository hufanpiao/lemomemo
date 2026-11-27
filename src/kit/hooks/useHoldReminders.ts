// 录音时压住提醒横幅：active 为 true 时压住，变 false 或组件卸载时放开。
// 不放进 kit/state/remind-queue.ts：队列在首屏，这个钩子只有“＋”录音那一套用，单放才跟着录音那一块按需下载、不进首屏
import { useEffect } from 'react';
import { holdReminders, type RemindHoldReason } from '../state/remind-queue.ts';

export function useHoldReminders(active: boolean, reason: RemindHoldReason = 'recording'): void {
  useEffect(() => {
    if (!active) return;
    return holdReminders(reason);
  }, [active, reason]);
}
