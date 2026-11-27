// 后台预加载两页之间等多久（几页连着下载、解析会让首屏画完后头一两秒点不动）：
// 1. 先等浏览器空闲（whenIdle）。iOS Safari 默认没有 requestIdleCallback（WebKit bug 285049），iPhone 上走 300 ms 定时器；
// 2. 再看手指：同 motion 的 canSwap，而且最后一次抬起已过 PRELOAD_QUIET_MS（刚抬起时往往紧跟着切页、打勾动效）；
//    不满足隔 SWAP_RETRY_MS 再看；
// 3. 从空闲那一刻起最多再等 PRELOAD_MAX_WAIT_MS：一直按着也照样往下走，预加载不会一直卡住
import { canSwap, SWAP_RETRY_MS, sincePointerUp, watchPointers } from '../motion/components.ts';
import { whenIdle } from '../platform/session.ts';

/** 最后一次抬起不到这么久也等（ms） */
export const PRELOAD_QUIET_MS = 600;
/** 空闲以后手指一直不满足，最多再等这么久就照样往下走（ms） */
export const PRELOAD_MAX_WAIT_MS = 3000;

/** 预加载每页之前调：满足上面的条件（或等满上限）时 resolve。idle 可换（测试用） */
export function preloadGap(idle: (fn: () => void) => void = whenIdle): Promise<void> {
  return new Promise((ok) => {
    watchPointers();
    idle(() => {
      const t0 = performance.now();
      const look = (): void => {
        if ((canSwap(null) && sincePointerUp() >= PRELOAD_QUIET_MS) || performance.now() - t0 >= PRELOAD_MAX_WAIT_MS) ok();
        else setTimeout(look, SWAP_RETRY_MS);
      };
      look();
    });
  });
}
