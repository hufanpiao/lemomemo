// arch-fixture: path=src/kit/components/Bad.ts expect=no-restricted-imports
// 违规（0.31 第 6 条）：动效令牌也要经 motion/index.ts 出口，不能直接引 motion/tokens.ts
import * as tokens from '../../motion/tokens.ts';
export const t = tokens;
