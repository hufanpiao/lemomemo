// 按需加载块的状态（core/anniv-lib.ts 的 React 一侧；整块评审第 19 条：纪念日页、提醒列表、月历菱形三处共用这一个钩子；R-431 日历黄历卡也用）
import { useEffect, useState } from 'react';
import { ANNIV_LIB, type LazyLib } from '../../core/anniv-lib.ts';

export type AnnivLibState = 'ready' | 'loading' | 'failed' | 'off';

/** want 为真时加载 lib（没好先加载，好了重画）；want 为假回 'off'、不加载。加载失败回 'failed'（页面写“加载失败”，提醒、菱形、黄历卡不画） */
export function useLazyLib(lib: LazyLib<unknown>, want = true): AnnivLibState {
  const [s, setS] = useState<'ready' | 'loading' | 'failed'>(() => (lib.ready() ? 'ready' : 'loading'));
  useEffect(() => {
    if (!want || s === 'ready') return undefined;
    let alive = true;
    lib.load().then(
      () => alive && setS('ready'),
      () => alive && setS('failed'),
    );
    return () => {
      alive = false;
    };
  }, [lib, s, want]);
  return want ? s : 'off';
}

/** 纪念日推算和农历（core/anniv-lib.ts 的 ANNIV_LIB） */
export const useAnnivLib = (want = true): AnnivLibState => useLazyLib(ANNIV_LIB, want);
