// arch-fixture: path=src/motion/Good.tsx expect=none
// 对照：用自己的 useReducedMotionPref，Motion 的 useReducedMotionConfig（读 MotionConfig）不拦
import { useReducedMotionConfig } from 'motion/react';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

export function useGood(): boolean {
  const pref = useReducedMotionPref();
  const config = useReducedMotionConfig();
  return pref || config === true;
}
