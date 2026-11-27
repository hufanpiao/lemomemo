// 违规 F7：引 node:module、用 createRequire
import { createRequire } from 'node:module';
export const r = createRequire;
