// 纪念日推算按需加载的状态（core/anniv-lib.ts 的 React 一侧；整块评审第 19 条：纪念日页、提醒列表、月历菱形三处共用这一个钩子）
import { useEffect, useState } from 'react';
import { annivLibReady, loadAnnivLib } from '../../core/anniv-lib.ts';

export type AnnivLibState = 'ready' | 'loading' | 'failed' | 'off';

/** want 为真时加载（没好先加载，好了重画）；want 为假回 'off'、不加载。加载失败回 'failed'（页面写“加载失败”，提醒、菱形不画） */
export function useAnnivLib(want = true): AnnivLibState {
  const [s, setS] = useState<'ready' | 'loading' | 'failed'>(() => (annivLibReady() ? 'ready' : 'loading'));
  useEffect(() => {
    if (!want || s === 'ready') return undefined;
    let alive = true;
    loadAnnivLib().then(
      () => alive && setS('ready'),
      () => alive && setS('failed'),
    );
    return () => {
      alive = false;
    };
  }, [s, want]);
  return want ? s : 'off';
}
