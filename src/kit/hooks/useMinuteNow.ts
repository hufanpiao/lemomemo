// 每分钟一跳的“现在”只在这里做（架构 10.1）：对齐整分钟（clock.now()，已按服务器校正）；时钟偏差变了也马上重算一次
// 测试里 spyOn clock.now 就能固定
import { useEffect, useState } from 'react';
import { clock } from '../../platform/clock.ts';

const MIN = 60_000;

export function useMinuteNow(): number {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      const n = clock.now();
      setNow(n);
      t = setTimeout(tick, MIN - (n % MIN) + 50);
    };
    t = setTimeout(tick, MIN - (clock.now() % MIN) + 50);
    const off = clock.subscribe(() => setNow(clock.now()));
    return () => {
      clearTimeout(t);
      off();
    };
  }, []);
  return now;
}
