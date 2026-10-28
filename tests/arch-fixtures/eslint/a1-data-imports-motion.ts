// arch-fixture: path=src/features/notes/data/bad.ts expect=boundaries/dependencies rule=A1
// 违规：data 不准用 motion
import { press } from '../../../motion/index.ts';
export const p = press;
