// arch-fixture: path=src/app/router-levels.ts expect=none
// 对照组（R-372 复审 M1）：router.ts 拆出来的两块准引它的内部件
import { commit, hrefOf, noteEntry, stateFor } from './router.ts';
export const fns = [commit, hrefOf, noteEntry, stateFor];
