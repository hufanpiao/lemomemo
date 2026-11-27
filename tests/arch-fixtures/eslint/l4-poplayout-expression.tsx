// arch-fixture: path=src/motion/Bad.tsx expect=no-restricted-syntax message=CSP count=2 rule=A29
// 违规（架构 2.0、UI-4 L-4）：写成 {'popLayout'} 或模板字符串也要拦
import { AnimatePresence } from 'motion/react';
import type { ReactNode } from 'react';
export const A = ({ children }: { children: ReactNode }) => <AnimatePresence mode={'popLayout'}>{children}</AnimatePresence>;
export const B = ({ children }: { children: ReactNode }) => <AnimatePresence mode={`popLayout`}>{children}</AnimatePresence>;
