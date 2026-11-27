// arch-fixture: path=src/motion/Bad.tsx expect=no-restricted-imports message=useReducedMotionPref count=2 rule=A25
// UI-4 M-1：Motion 的 useReducedMotion() 只认系统设置、不认 data-rm 开关；src/motion 里也不准，改名引入也拦
import { useReducedMotion } from 'motion/react';
import { useReducedMotion as useRM } from 'framer-motion';

export const a = useReducedMotion;
export const b = useRM;
