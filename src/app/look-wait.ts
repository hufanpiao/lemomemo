// 渲染前等皮肤套上（皮肤整块评审第 2 条）：main.tsx 懒加载 platform/look.ts 按本机缓存套皮肤，渲染前最多等 LOOK_WAIT_MS；
// 到点还没好（网慢、分包卡住）就先按入口页写的默认皮肤渲染，look.ts 晚到时照样套上。下载失败同样不挡渲染
import { withTimeout } from '../platform/exit-basics.ts';

export const LOOK_WAIT_MS = 600;

export const waitLook = (look: Promise<unknown>): Promise<unknown> => withTimeout(() => look, LOOK_WAIT_MS, () => undefined);
