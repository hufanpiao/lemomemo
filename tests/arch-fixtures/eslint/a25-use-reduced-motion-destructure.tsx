// arch-fixture: path=src/motion/Bad.tsx expect=no-restricted-syntax message=useReducedMotionPref rule=A25
// UI-4 M-1：整包引入后解构出来（const { useReducedMotion } = M）同样拦
import * as M from 'motion/react';

const { useReducedMotion } = M;

export function useBad(): boolean | null {
  return useReducedMotion();
}
