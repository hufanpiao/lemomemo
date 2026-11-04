// 手机时间准不准（K8-clock）：platform/clock 的 isClockWrong()，偏差变了时重读
import { useSyncExternalStore } from 'react';
import { clock, type Clock } from '../../../platform/clock.ts';

export function useClockWrong(c: Clock = clock): { wrong: boolean; minutes: number } {
  const off = useSyncExternalStore(c.subscribe, c.offset, c.offset);
  return { wrong: c.isClockWrong(), minutes: Math.round(Math.abs(off) / 60_000) };
}
