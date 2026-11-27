// 纪念日的推算、农历和今日运势（shared/logic/anniv/next-date.ts、lunar.ts、lunar-fortune.ts）按需加载的唯一一处
// （ESLint lemo/import-bounds 的 LUNAR：src 里一律不准静态引它们）。放 core 是为了各功能的 data 层也能用，
//   React 一侧的状态钩子是 kit/hooks/useAnnivLib.ts。
// • 三块各自加载（lazyLib）：推算和农历（ANNIV_LIB：纪念日页、提醒、月历小爱心、今天页农历）；只有农历（LUNAR_LIB：日历月格、周格的农历和节气）；
//   今日运势（FORTUNE_LIB：日历页运势卡的算法和文案，中韩界面都要）。lunar.ts 几块共用，Vite 拆成共用的一块，不重复下载
// • 页面挂上时 useLazyLib(lib, want) 先加载，加载好了才画；之后同步用 lib.get() 取（没加载就调是程序错，直接抛）
// • next-date.ts 本来就静态引 lunar.ts，两块一起加载不多花
// • 失败：记一行运行日志 `<名字> lib-load failed`，状态 'failed'；online 事件、want 由假变真、重新进页时再试（kit/hooks/useAnnivLib.ts）
// • 只认 import type 和 import()：农历表单独成块，不进首屏
import type * as FortuneNs from '../../shared/logic/anniv/lunar-fortune.ts';
import type * as LunarNs from '../../shared/logic/anniv/lunar.ts';
import type * as NextNs from '../../shared/logic/anniv/next-date.ts';
import { rlog } from '../platform/run-log-api.ts';

export type AnnivLib = typeof NextNs & typeof LunarNs;
export type LunarLib = typeof LunarNs;
export type FortuneLib = typeof FortuneNs;

/** 按需加载的一块：加载一次、缓存；失败了下次再调会重试（lazyLib 转出另给测试用：新建一个实例注入，模拟慢加载、加载失败） */
export interface LazyLib<T> {
  readonly load: () => Promise<T>;
  /** 加载好了没有 */
  readonly ready: () => boolean;
  /** 已加载的模块；还没加载好就调是程序错 */
  readonly get: () => T;
}

export function lazyLib<T>(name: string, importIt: () => Promise<T>): LazyLib<T> {
  let lib: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    load: () =>
      (pending ??= importIt().then(
        (m) => (lib = m),
        (e: unknown) => {
          pending = null;
          rlog(`${name} lib-load failed`);
          throw e;
        },
      )),
    ready: () => lib !== null,
    get: () => {
      if (lib === null) throw new Error(`${name}_lib_not_loaded`);
      return lib;
    },
  };
}

export const ANNIV_LIB: LazyLib<AnnivLib> = lazyLib('anniv', () =>
  Promise.all([import('../../shared/logic/anniv/next-date.ts'), import('../../shared/logic/anniv/lunar.ts')]).then(([next, lunar]) => ({ ...lunar, ...next })),
);

/** 日历月格、周格的农历和节气；中文界面才加载 */
export const LUNAR_LIB: LazyLib<LunarLib> = lazyLib('lunar', () => import('../../shared/logic/anniv/lunar.ts'));

/** 今日运势卡：日历页、填了生日才加载；中韩界面都要 */
export const FORTUNE_LIB: LazyLib<FortuneLib> = lazyLib('fortune', () => import('../../shared/logic/anniv/lunar-fortune.ts'));

/** 加载推算和农历一次；失败了下次再调会重试 */
export const loadAnnivLib = ANNIV_LIB.load;

/** 已加载的推算和农历；还没加载好就调是程序错 */
export const annivLib = ANNIV_LIB.get;
