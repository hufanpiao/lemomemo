// 纪念日的推算和农历加载好了没有（data/anniv-lib.ts）：没好时先加载，好了重画。加载失败回 'failed'（页面写“加载失败”，不白屏）
import { useEffect, useState } from 'react';
import { annivLibReady, loadAnnivLib } from '../data/anniv-lib.ts';

export function useAnnivLib(): 'ready' | 'loading' | 'failed' {
  const [s, setS] = useState<'ready' | 'loading' | 'failed'>(() => (annivLibReady() ? 'ready' : 'loading'));
  useEffect(() => {
    if (s === 'ready') return undefined;
    let alive = true;
    loadAnnivLib().then(
      () => alive && setS('ready'),
      () => alive && setS('failed'),
    );
    return () => {
      alive = false;
    };
  }, [s]);
  return s;
}
