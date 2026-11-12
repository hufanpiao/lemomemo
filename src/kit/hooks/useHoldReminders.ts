// 录音时压住提醒横幅（REMIND-wiring；架构 5.9“提醒的排队规则”）：active 为 true 时压住，变 false 或组件卸载时放开。
// 从 kit/state/remind-queue.ts 挪出来单放（B3 FA-3）：队列在首屏，这个钩子只有“＋”录音那一套用，单放才跟着录音那一块按需下载、不进首屏
import { useEffect } from 'react';
import { holdReminders, type RemindHoldReason } from '../state/remind-queue.ts';

export function useHoldReminders(active: boolean, reason: RemindHoldReason = 'recording'): void {
  useEffect(() => {
    if (!active) return;
    return holdReminders(reason);
  }, [active, reason]);
}
