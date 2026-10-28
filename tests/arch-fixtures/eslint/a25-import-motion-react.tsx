// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=no-restricted-imports
// 违规：motion/react 只能在 src/motion/ 里 import
import { motion } from 'motion/react';
export const M = motion.div;
