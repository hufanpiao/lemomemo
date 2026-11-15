// 纪念日的推算、农历和黄历（shared/logic/anniv/next-date.ts、lunar.ts、lunar-huangli.ts）按需加载的唯一一处（11-15 R-431 独立评审第 1 条：日历 useLunar 原来自带的一套也并进来）（架构 2.6；ESLint lemo/import-bounds 的 LUNAR：src 里一律不准静态引它们）。
// 11-14 整块评审第 19 条：原来纪念日页（features/anniv/data/anniv-lib.ts）、提醒列表（reminders/hooks/remind-list.ts）、
//   月历菱形（calendar/hooks/useAnnivDates.ts）各写一份 import() 和缓存，合成这一份放 core（各功能的 data 层也能用），
//   React 一侧的状态钩子是 kit/hooks/useAnnivLib.ts。
// • 三块各自加载（lazyLib）：推算和农历（ANNIV_LIB：纪念日页、提醒、月历菱形、今天页农历）；只有农历（LUNAR_LIB：日历月格、周格的农历和节气）；
//   黄历（HUANGLI_LIB，R-431：只有日历页的黄历卡用，宜忌表 gzip 约 12 KB，不让纪念日页、今天页跟着下）。lunar.ts 三块共用，Vite 拆成共用的一块，不重复下载
// • 页面挂上时 useLazyLib(lib, want) 先加载，加载好了才画；之后同步用 lib.get() 取（没加载就调是程序错，直接抛）
// • next-date.ts 本来就静态引 lunar.ts，两块一起加载不多花
// • 失败：记一行运行日志 `<名字> lib-load failed`（整块评审第 6 条，原来 () => null 吞掉），状态 'failed'；online 事件、want 由假变真、重新进页时再试（kit/hooks/useAnnivLib.ts）
// • 只认 import type 和 import()：农历表单独成块，不进首屏
import type * as HuangliNs from '../../shared/logic/anniv/lunar-huangli.ts';
import type * as LunarNs from '../../shared/logic/anniv/lunar.ts';
import type * as NextNs from '../../shared/logic/anniv/next-date.ts';
import { rlog } from '../platform/run-log-api.ts';

export type AnnivLib = typeof NextNs & typeof LunarNs;
export type LunarLib = typeof LunarNs;
export type HuangliLib = typeof HuangliNs;

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

/** 日历月格、周格的农历和节气（R-431 独立评审第 1 条：原 calendar/hooks/useLunar.ts 自带的缓存并到这里）；中文界面才加载 */
export const LUNAR_LIB: LazyLib<LunarLib> = lazyLib('lunar', () => import('../../shared/logic/anniv/lunar.ts'));

/** 黄历卡（R-431）：日历页、中文界面才加载 */
export const HUANGLI_LIB: LazyLib<HuangliLib> = lazyLib('huangli', () => import('../../shared/logic/anniv/lunar-huangli.ts'));

/** 加载推算和农历一次；失败了下次再调会重试 */
export const loadAnnivLib = ANNIV_LIB.load;

/** 推算和农历加载好了没有 */
export const annivLibReady = ANNIV_LIB.ready;

/** 已加载的推算和农历；还没加载好就调是程序错 */
export const annivLib = ANNIV_LIB.get;
