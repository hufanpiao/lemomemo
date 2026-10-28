// arch-fixture: path=src/app/router.ts expect=no-restricted-imports
// 违规（0.31 第 3、6 条）：router.ts 只能引 motion/index.ts，不能引带 React 组件的 motion/components.ts
import { Appear } from '../motion/components.ts';
export const A = Appear;
