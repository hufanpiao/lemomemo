// arch-fixture: path=src/motion/Good.tsx expect=none
// 对照组（UI-4 L-4）：AnimatePresence 的 mode="wait"、默认 sync 都可以
import { AnimatePresence } from 'motion/react';
import type { ReactNode } from 'react';
export const A = ({ children }: { children: ReactNode }) => <AnimatePresence mode="wait">{children}</AnimatePresence>;
export const B = ({ children }: { children: ReactNode }) => <AnimatePresence>{children}</AnimatePresence>;
