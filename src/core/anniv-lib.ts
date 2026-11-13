// 纪念日的推算和农历（shared/logic/anniv/next-date.ts、lunar.ts）按需加载的唯一一处（架构 2.6；check_arch 的 LUNAR：src 里一律不准静态引它们）。
// 11-14 整块评审第 19 条：原来纪念日页（features/anniv/data/anniv-lib.ts）、提醒列表（reminders/hooks/remind-list.ts）、
//   月历菱形（calendar/hooks/useAnnivDates.ts）各写一份 import() 和缓存，合成这一份放 core（各功能的 data 层也能用），
//   React 一侧的状态钩子是 kit/hooks/useAnnivLib.ts。
// • 页面挂上时 useAnnivLib(want) 先加载，加载好了才画；之后同步用 annivLib() 取（没加载就调是程序错，直接抛）
// • next-date.ts 本来就静态引 lunar.ts，两块一起加载不多花
// • 失败：记一行运行日志 `anniv lib-load failed`（整块评审第 6 条，原来 () => null 吞掉），状态 'failed'；下一次挂上（want 由假变真、重新进页）再试
// • 只认 import type 和 import()：农历表单独成块，不进首屏
import type * as LunarNs from '../../shared/logic/anniv/lunar.ts';
import type * as NextNs from '../../shared/logic/anniv/next-date.ts';
import { rlog } from '../platform/run-log-api.ts';

export type AnnivLib = typeof NextNs & typeof LunarNs;

let lib: AnnivLib | null = null;
let pending: Promise<AnnivLib> | null = null;

/** 加载一次；失败了下次再调会重试 */
export function loadAnnivLib(): Promise<AnnivLib> {
  pending ??= Promise.all([import('../../shared/logic/anniv/next-date.ts'), import('../../shared/logic/anniv/lunar.ts')]).then(
    ([next, lunar]) => (lib = { ...lunar, ...next }),
    (e: unknown) => {
      pending = null;
      rlog('anniv lib-load failed');
      throw e;
    },
  );
  return pending;
}

/** 加载好了没有 */
export const annivLibReady = (): boolean => lib !== null;

/** 已加载的推算；还没加载好就调是程序错 */
export function annivLib(): AnnivLib {
  if (lib === null) throw new Error('anniv_lib_not_loaded');
  return lib;
}
