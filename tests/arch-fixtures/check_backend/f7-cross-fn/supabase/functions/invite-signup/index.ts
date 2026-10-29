// 对照：引本函数目录、引 _shared 都可以
import { readSecret } from './secret.ts';
import { x } from '../_shared/util.ts';
export const a = [readSecret, x];
