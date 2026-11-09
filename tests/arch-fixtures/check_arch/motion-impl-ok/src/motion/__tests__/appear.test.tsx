// MOTION-IMPL 对照：src/motion/__tests__/ 里的引入不管
import { m } from 'motion/react';
import { AppearImpl } from '../appear-impl.tsx';
export const t = [m, AppearImpl, import('../motion-impl.tsx')];
