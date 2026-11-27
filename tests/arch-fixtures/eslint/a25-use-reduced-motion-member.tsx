// arch-fixture: path=src/motion/Bad.tsx expect=no-restricted-syntax message=useReducedMotionPref rule=A25
// UI-4 M-1：整包引入再点出来用（M.useReducedMotion）同样拦
import * as M from 'motion/react';

export function useBad(): boolean | null {
  return M.useReducedMotion();
}
