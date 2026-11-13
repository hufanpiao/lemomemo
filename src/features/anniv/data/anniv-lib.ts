// 纪念日的推算和农历（shared/logic/anniv/next-date.ts、lunar.ts）按需加载的那一处（架构 2.6；check_arch 的 LUNAR：src 里一律不准静态引它们）
// • 纪念日页面、编辑、设置里的“纪念日提醒”一行挂上时先 loadAnnivLib()（hooks/useAnnivLib.ts），加载好了才画；
//   之后 data 和 ui 里同步用 annivLib() 取（没加载就调是程序错，直接抛）
// • 只认 import type 和 import()：农历表单独成块，不进首屏
import type * as LunarNs from '../../../../shared/logic/anniv/lunar.ts';
import type * as NextNs from '../../../../shared/logic/anniv/next-date.ts';

export type AnnivLib = typeof NextNs & typeof LunarNs;

let lib: AnnivLib | null = null;
let pending: Promise<AnnivLib> | null = null;

/** 加载一次；失败了下次再调会重试 */
export function loadAnnivLib(): Promise<AnnivLib> {
  pending ??= Promise.all([import('../../../../shared/logic/anniv/next-date.ts'), import('../../../../shared/logic/anniv/lunar.ts')]).then(
    ([next, lunar]) => (lib = { ...lunar, ...next }),
    (e: unknown) => {
      pending = null;
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
