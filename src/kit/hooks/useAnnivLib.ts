// 按需加载块的状态（core/anniv-lib.ts 的 React 一侧）：纪念日页、提醒列表、月历小爱心、日历的农历（LUNAR_LIB）、今日运势卡（FORTUNE_LIB）共用
// • 加载只跟 [lib, want, 重试次数] 走：依赖里带状态 s 的话，失败一变状态 effect 就再跑一遍，失败一次加载两次
// • 重试：失败后等 online 事件（断网恢复），或 want 由假变真（比如换回中文界面）；重试时先回 'loading'
import { useEffect, useState } from 'react';
import { ANNIV_LIB, type LazyLib } from '../../core/anniv-lib.ts';

export type AnnivLibState = 'ready' | 'loading' | 'failed' | 'off';

/** want 为真时加载 lib（没好先加载，好了重画）；want 为假回 'off'、不加载。加载失败回 'failed'（页面写“加载失败”，提醒、小爱心、农历、黄历卡不画） */
export function useLazyLib(lib: LazyLib<unknown>, want = true): AnnivLibState {
  const [s, setS] = useState<'ready' | 'loading' | 'failed'>('loading');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!want || lib.ready()) return undefined;
    let alive = true;
    setS('loading');
    lib.load().then(
      () => alive && setS('ready'),
      () => alive && setS('failed'),
    );
    return () => {
      alive = false;
    };
  }, [lib, want, retry]);
  useEffect(() => {
    if (!want || s !== 'failed') return undefined;
    const again = (): void => setRetry((n) => n + 1);
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, [want, s]);
  if (!want) return 'off';
  // 好没好以 lib.ready() 为准（别的页面先加载好了，这里第一次画就是 'ready'）；s 只区分加载中和失败
  if (lib.ready()) return 'ready';
  return s === 'failed' ? 'failed' : 'loading';
}

/** 纪念日推算和农历（core/anniv-lib.ts 的 ANNIV_LIB） */
export const useAnnivLib = (want = true): AnnivLibState => useLazyLib(ANNIV_LIB, want);
