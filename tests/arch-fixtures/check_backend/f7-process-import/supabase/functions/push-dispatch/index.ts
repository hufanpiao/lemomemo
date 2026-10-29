// 违规 F7（代码审查有条件通过 2）：node:process 只准默认导入；process?.env、方括号、解构、存进变量都报
import { env as penv } from 'node:process';
import * as proc from 'node:process';
export { env } from 'node:process';
export const a = process?.env;
export const b = process['env'];
const { env: e2 } = process;
const p = process; export const c = [penv, proc, e2, p];
export const d = await import('node:process');
