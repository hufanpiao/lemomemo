// F9-reverse-check 样例：违规（反向兜底）——验了 x-cron-secret，但迁移里的 concat() 地址认不出
import { ok } from './lib.ts';
export const h = (r: Request) => ok(r.headers.get('x-cron-secret'));
