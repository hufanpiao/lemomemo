// arch-fixture: path=src/motion/Bad.tsx expect=no-restricted-syntax message=CSP rule=A29
// 违规（架构 2.0、UI-4 L-4）：AnimatePresence 的 mode="popLayout" 会插内联 <style>，被 CSP 拦（src/motion 里也不行）
import { AnimatePresence } from 'motion/react';
import type { ReactNode } from 'react';
export const Bad = ({ children }: { children: ReactNode }) => <AnimatePresence mode="popLayout">{children}</AnimatePresence>;
