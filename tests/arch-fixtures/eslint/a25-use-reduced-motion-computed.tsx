// arch-fixture: path=src/motion/Bad.tsx expect=no-restricted-syntax message=useReducedMotionPref rule=A25
// UI-4 M-1：用方括号字符串点出来（M['useReducedMotion']）同样拦
import * as M from 'motion/react';

export function useBad(): boolean | null {
  return M['useReducedMotion']();
}
