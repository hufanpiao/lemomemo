// 对照：只引类型（import type，编译后不存在、不会部署出去）
import type { Shape } from './shape.test.ts';
export const s: Shape | null = null;
